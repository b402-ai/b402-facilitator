import { Contract, Wallet, ethers } from 'ethers'
import type { FastifyReply, FastifyRequest } from 'fastify'

import { B402_RELAYER_ABI, SUPPORTED_TOKENS } from '../../constants'
import { WalletDeployment } from '../../models'
import type {
	DeployWalletsRequest,
	DeployWalletsResponse,
	HealthResponse,
	SettleRequest,
	SettleResponse,
	SettleWalletRequest,
	SettleWalletResponse,
	UserOperation,
	VerifyRequest,
	VerifyResponse,
	VerifyWalletRequest,
	VerifyWalletResponse
} from '../../schema/b402'
import { env } from '../../schema/env'
import { BaseErrors, handleAndReturnErrorResponse } from '../../schema/errors'
import { getUserOpHash, signUserOp } from '../../utils/paymaster'
import { getProviderService } from '../../utils/provider'
import {
	createPaymentUserOpOrThrow,
	decodeExecuteBatch,
	getUserOpReceipt,
	submitUserOpToBundler,
	validateFeeIncluded
} from '../../utils/userOp'
import { getTokenBalance, isWalletDeployed } from '../../utils/wallet'

/**
 * Function for route `/verify`
 * Verify payment signature and authorization for B402 payments
 *
 * @param request
 * @param reply
 * @returns
 */
export async function verify(request: FastifyRequest, reply: FastifyReply) {
	try {
		const body = request.body as VerifyRequest
		const { paymentPayload, paymentRequirements } = body

		if (!paymentPayload || !paymentRequirements) {
			throw new BaseErrors.ERR_MISSING_PAYMENT_PAYLOAD()
		}

		const { authorization, signature } = paymentPayload.payload

		// Get provider and chain ID
		const providerService = getProviderService()
		const provider = providerService.getProvider()
		const chainId = providerService.getChainId()

		// Create relayer contract instance
		const relayer = new Contract(
			request.server.config.B402_RELAYER_ADDRESS,
			B402_RELAYER_ABI,
			provider
		)

		// Verify signature locally (EIP-712)
		const domain = {
			name: 'B402',
			version: '1',
			chainId: chainId,
			verifyingContract: paymentRequirements.relayerContract
		}

		const types = {
			TransferWithAuthorization: [
				{ name: 'token', type: 'address' },
				{ name: 'from', type: 'address' },
				{ name: 'to', type: 'address' },
				{ name: 'value', type: 'uint256' },
				{ name: 'validAfter', type: 'uint256' },
				{ name: 'validBefore', type: 'uint256' },
				{ name: 'nonce', type: 'bytes32' }
			]
		}

		const message = {
			token: paymentPayload.token,
			...authorization
		}

		let recovered: string
		try {
			recovered = ethers.verifyTypedData(domain, types, message, signature)
		} catch (error) {
			throw new BaseErrors.ERR_SIGNATURE_VERIFICATION_FAILED()
		}

		if (recovered.toLowerCase() !== authorization.from.toLowerCase()) {
			const response: VerifyResponse = {
				isValid: false,
				invalidReason: 'Invalid signature'
			}
			return response
		}

		// Check nonce not used
		let isUsed: boolean
		try {
			isUsed = await relayer.authorizationState(authorization.from, authorization.nonce)
		} catch (error) {
			throw new BaseErrors.ERR_AUTHORIZATION_STATE_CHECK_FAILED()
		}

		if (isUsed) {
			const response: VerifyResponse = {
				isValid: false,
				invalidReason: 'Nonce already used'
			}
			return response
		}

		// Check timing
		const now = Math.floor(Date.now() / 1000)
		if (now < authorization.validAfter) {
			const response: VerifyResponse = {
				isValid: false,
				invalidReason: 'Authorization not yet valid'
			}
			return response
		}
		if (now >= authorization.validBefore) {
			const response: VerifyResponse = {
				isValid: false,
				invalidReason: 'Authorization expired'
			}
			return response
		}

		const response: VerifyResponse = {
			isValid: true,
			payer: authorization.from
		}
		return response
	} catch (error) {
		return handleAndReturnErrorResponse(reply, error)
	}
}

/**
 * Function for route `/settle`
 * Execute payment on-chain via B402 relayer contract
 *
 * @param request
 * @param reply
 * @returns
 */
export async function settle(request: FastifyRequest, reply: FastifyReply) {
	try {
		const body = request.body as SettleRequest
		const { paymentPayload, paymentRequirements } = body

		if (!paymentPayload || !paymentRequirements) {
			throw new BaseErrors.ERR_MISSING_PAYMENT_PAYLOAD()
		}

		const { authorization, signature } = paymentPayload.payload
		const network = paymentRequirements.network || 'bsc'

		// Get provider
		const providerService = getProviderService()
		const provider = providerService.getProvider()

		// Create wallet and relayer contract
		const relayerWallet = new Wallet(request.server.config.RELAYER_PRIVATE_KEY)
		const signer = relayerWallet.connect(provider)
		const relayer = new Contract(
			request.server.config.B402_RELAYER_ADDRESS,
			B402_RELAYER_ABI,
			signer
		)

		// Execute `transferWithAuthorization`
		let tx: ethers.ContractTransactionResponse
		try {
			tx = await relayer.transferWithAuthorization(
				paymentPayload.token,
				authorization.from,
				authorization.to,
				authorization.value,
				authorization.validAfter,
				authorization.validBefore,
				authorization.nonce,
				signature,
				{
					gasLimit: 200000
				}
			)
		} catch (error) {
			throw new BaseErrors.ERR_BLOCKCHAIN_TRANSACTION_FAILED()
		}

		// Wait for transaction confirmation
		let receipt: ethers.ContractTransactionReceipt | null
		try {
			receipt = await tx.wait()
		} catch (error) {
			throw new BaseErrors.ERR_TRANSACTION_CONFIRMATION_FAILED()
		}

		if (!receipt) {
			throw new BaseErrors.ERR_TRANSACTION_CONFIRMATION_FAILED()
		}

		const response: SettleResponse = {
			success: true,
			transaction: receipt.hash,
			network,
			payer: authorization.from,
			blockNumber: receipt.blockNumber
		}
		return response
	} catch (error) {
		return handleAndReturnErrorResponse(reply, error)
	}
}

/**
 * Function for route `/wallet/verify`
 * Build UserOp with fee injection and return for user signing
 *
 * @param request
 * @param reply
 * @returns
 */
export async function verifyWalletPayment(request: FastifyRequest, reply: FastifyReply) {
	try {
		const body = request.body as VerifyWalletRequest

		// Validate that all transactions use the same token
		if (!body.transactions || body.transactions.length === 0) {
			throw new BaseErrors.ERR_EMPTY_TRANSACTIONS()
		}
		const firstToken = body.transactions[0].token
		const allSameToken = body.transactions.every(
			(tx) => tx.token.toLowerCase() === firstToken.toLowerCase()
		)
		if (!allSameToken) {
			throw new BaseErrors.ERR_MULTIPLE_TOKENS_NOT_ALLOWED()
		}

		// Validate token is supported
		const tokenConfig = Object.values(SUPPORTED_TOKENS).find(
			(t) => t.address.toLowerCase() === firstToken.toLowerCase()
		)
		if (!tokenConfig) {
			throw new BaseErrors.ERR_UNSUPPORTED_TOKEN()
		}

		// Create payment UserOp with fee injection
		const recipients = body.transactions.map((tx) => tx.to)
		const amounts = body.transactions.map((tx) => tx.amount)
		const validAfter = Math.floor(Date.now() / 1000) - 3600 // Valid from 1 hour ago
		const validBefore = Math.floor(Date.now() / 1000) + 3600 // Valid for 1 hour
		const nonce = ethers.hexlify(ethers.randomBytes(32))

		let userOp: UserOperation
		try {
			userOp = await createPaymentUserOpOrThrow({
				walletAddress: body.walletAddress,
				recipients,
				amounts,
				token: firstToken,
				validAfter,
				validBefore,
				nonce
			})
		} catch (error) {
			throw new BaseErrors.ERR_USEROP_CREATION_FAILED()
		}

		const chainId = env.NETWORK === 'mainnet' ? 56 : 97
		const paymasterData = await signUserOp(userOp, chainId)
		userOp.paymaster = paymasterData.paymaster
		userOp.paymasterVerificationGasLimit = paymasterData.paymasterVerificationGasLimit
		userOp.paymasterPostOpGasLimit = paymasterData.paymasterPostOpGasLimit
		userOp.paymasterData = paymasterData.paymasterData

		const userOpHash = await getUserOpHash(userOp, env.ENTRY_POINT_ADDRESS, chainId)

		const paymentAmounts = amounts.map((amt) => ethers.parseUnits(amt, tokenConfig.decimals))
		const totalPaymentAmount = paymentAmounts.reduce((sum, amt) => sum + amt, 0n)
		const feeAmount = ethers.parseUnits(env.WALLET_PAYMENT_FEE, tokenConfig.decimals)
		const totalAmount = totalPaymentAmount + feeAmount

		// Validate wallet has sufficient balance
		const balanceStr = await getTokenBalance(body.walletAddress, firstToken)
		const balance = BigInt(balanceStr)
		if (balance < totalAmount) {
			throw new BaseErrors.ERR_INSUFFICIENT_BALANCE()
		}

		const response: VerifyWalletResponse = {
			isValid: true,
			payer: body.walletAddress,
			userOp,
			userOpHash,
			feeAmount: ethers.formatUnits(feeAmount, tokenConfig.decimals),
			totalAmount: ethers.formatUnits(totalAmount, tokenConfig.decimals)
		}

		return response
	} catch (error) {
		return handleAndReturnErrorResponse(reply, error)
	}
}

/**
 * Function for route `/wallet/settle`
 * Validate fee, sign as paymaster, and submit to bundler
 *
 * @param request
 * @param reply
 * @returns
 */
export async function settleWalletPayment(request: FastifyRequest, reply: FastifyReply) {
	try {
		const body = request.body as SettleWalletRequest

		// Validate fee is included
		const hasFee = validateFeeIncluded(body.userOp)
		if (!hasFee) {
			throw new BaseErrors.ERR_FEE_VALIDATION_FAILED()
		}

		// Submit to bundler
		body.userOp.signature = body.signature
		let userOpHash: string
		try {
			userOpHash = await submitUserOpToBundler(body.userOp)
		} catch (error) {
			throw new BaseErrors.ERR_BUNDLER_SUBMISSION_FAILED()
		}

		// Wait for receipt
		let txHash = ''
		try {
			for (let i = 0; i < 30; i++) {
				await new Promise((resolve) => setTimeout(resolve, 1500))
				try {
					const receipt = await getUserOpReceipt(userOpHash)
					if (receipt.success) {
						txHash = receipt.txHash
						break
					}
				} catch {
					// Continue polling
				}
			}
		} catch (error) {
			console.log('Error waiting for receipt:', error)
		}

		if (!txHash) {
			throw new BaseErrors.ERR_TRANSACTION_CONFIRMATION_FAILED()
		}

		// Extract payment details
		const calls = decodeExecuteBatch(body.userOp.callData)
		const batchTransferCall = calls.find(
			(call) => call.to.toLowerCase() === env.B402_RELAYER_ADDRESS.toLowerCase()
		)

		if (!batchTransferCall) {
			throw new BaseErrors.ERR_INVALID_USEROP()
		}

		const relayerIface = new ethers.Interface(B402_RELAYER_ABI)
		const decoded = relayerIface.decodeFunctionData(
			'batchTransferWithUserOp',
			batchTransferCall.data
		)

		const token = decoded[0] as string
		const recipients = decoded[1] as string[]
		const amounts = decoded[2] as bigint[]

		const tokenConfig = Object.values(SUPPORTED_TOKENS).find(
			(t) => t.address.toLowerCase() === token.toLowerCase()
		)

		if (!tokenConfig) {
			throw new BaseErrors.ERR_UNSUPPORTED_TOKEN()
		}

		// Build payment details
		const payments = recipients.map((recipient, i) => ({
			recipient,
			amount: ethers.formatUnits(amounts[i], tokenConfig.decimals),
			isProtocolFee: recipient.toLowerCase() === env.WALLET_FEE_RECIPIENT.toLowerCase()
		}))

		const providerService = getProviderService()
		const network = providerService.getNetwork()

		const response: SettleWalletResponse = {
			success: true,
			txHash,
			userOpHash,
			network,
			payments
		}

		return response
	} catch (error) {
		return handleAndReturnErrorResponse(reply, error)
	}
}

/**
 * Function for route `/health`
 * Health check endpoint returning service status and relayer info
 *
 * @param request
 * @param reply
 * @returns
 */
export async function health(request: FastifyRequest, reply: FastifyReply) {
	try {
		const relayerWallet = new Wallet(request.server.config.RELAYER_PRIVATE_KEY)
		const providerService = getProviderService()
		const network = providerService.getNetwork()

		const response: HealthResponse = {
			status: 'healthy',
			service: 'b402-facilitator',
			network,
			relayer: relayerWallet.address
		}
		return response
	} catch (error) {
		return handleAndReturnErrorResponse(reply, error)
	}
}

/**
 * Function for route `/wallet/deploy`
 * Deploy one or more smart wallets for any given EOA
 * Note: Gas and API fee are paid by caller, which can be different from target EOA
 *
 * @param request
 * @param reply
 * @returns
 */
export async function deployWallets(request: FastifyRequest, reply: FastifyReply) {
	try {
		const body = request.body as DeployWalletsRequest
		const { ownerAddress, count, paymentPayload, paymentRequirements } = body

		// Validate owner address
		if (!ethers.isAddress(ownerAddress)) {
			throw new BaseErrors.ERR_INVALID_ADDRESS()
		}

		// Validate count
		if (count < 1 || count > 10) {
			throw new BaseErrors.ERR_INVALID_WALLET_COUNT()
		}

		// Calculate deployment fee
		const deploymentFeePerWallet = Number.parseFloat(env.WALLET_DEPLOYMENT_FEE)
		const totalDeploymentFee = (count * deploymentFeePerWallet).toFixed(2)

		// Validate payment amount
		const paymentAmount = Number.parseFloat(paymentPayload.payload.authorization.value)
		if (paymentAmount !== Number.parseFloat(totalDeploymentFee)) {
			throw new BaseErrors.ERR_INCORRECT_DEPLOYMENT_FEE()
		}

		// Validate payment recipient
		if (
			paymentPayload.payload.authorization.to.toLowerCase() !==
			env.WALLET_FEE_RECIPIENT.toLowerCase()
		) {
			throw new BaseErrors.ERR_INVALID_FEE_RECIPIENT()
		}

		// Get provider
		const providerService = getProviderService()
		const provider = providerService.getProvider()
		const chainId = providerService.getChainId()

		// Verify B402 payment signature
		const { authorization, signature } = paymentPayload.payload
		const domain = {
			name: 'B402',
			version: '1',
			chainId: chainId,
			verifyingContract: paymentRequirements.relayerContract
		}

		const types = {
			TransferWithAuthorization: [
				{ name: 'token', type: 'address' },
				{ name: 'from', type: 'address' },
				{ name: 'to', type: 'address' },
				{ name: 'value', type: 'uint256' },
				{ name: 'validAfter', type: 'uint256' },
				{ name: 'validBefore', type: 'uint256' },
				{ name: 'nonce', type: 'bytes32' }
			]
		}

		const message = {
			token: paymentPayload.token,
			...authorization
		}

		let recovered: string
		try {
			recovered = ethers.verifyTypedData(domain, types, message, signature)
		} catch (error) {
			throw new BaseErrors.ERR_SIGNATURE_VERIFICATION_FAILED()
		}

		if (recovered.toLowerCase() !== authorization.from.toLowerCase()) {
			throw new BaseErrors.ERR_SIGNATURE_VERIFICATION_FAILED()
		}

		// Auto-generate random salts, skip existing wallets (handle collisions)
		const factoryInterface = new ethers.Interface([
			'function getAddress(address owner, uint256 salt) view returns (address)'
		])

		const salts: string[] = []
		const wallets: { address: string; salt: string; owner: string }[] = []
		const usedSalts = new Set<string>()

		for (let i = 0; i < count; i++) {
			let found = false
			let attempts = 0
			const maxAttempts = 100

			while (!found && attempts < maxAttempts) {
				// Generate random salt
				const randomSalt = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
				const saltStr = randomSalt.toString()

				// Skip if we already used this salt in this batch
				if (usedSalts.has(saltStr)) {
					attempts++
					continue
				}

				// Check if wallet at this salt already exists
				const callData = factoryInterface.encodeFunctionData('getAddress', [
					ownerAddress,
					BigInt(randomSalt)
				])
				const result = await provider.call({
					to: env.SIMPLE_ACCOUNT_FACTORY_ADDRESS,
					data: callData
				})
				const walletAddress = factoryInterface.decodeFunctionResult('getAddress', result)[0]
				const exists = await isWalletDeployed(walletAddress)

				if (!exists) {
					salts.push(saltStr)
					wallets.push({
						address: walletAddress,
						salt: saltStr,
						owner: ownerAddress
					})
					usedSalts.add(saltStr)
					found = true
				}

				attempts++
			}

			if (!found) {
				throw new BaseErrors.ERR_WALLET_DEPLOYMENT_FAILED()
			}
		}

		// Prevent paying for the same wallet multiple times
		const walletAddressesToCheck = wallets.map((w) => w.address.toLowerCase())
		const existingRecords = await WalletDeployment.find({
			walletAddress: { $in: walletAddressesToCheck }
		})

		if (existingRecords.length > 0) {
			throw new BaseErrors.ERR_WALLET_ALREADY_PAID()
		}

		// Create DB entries for wallets before payment
		const dbEntries = await WalletDeployment.insertMany(
			wallets.map((wallet) => ({
				ownerAddress: wallet.owner.toLowerCase(),
				walletAddress: wallet.address.toLowerCase(),
				salt: wallet.salt,
				payerAddress: authorization.from.toLowerCase(),
				paymentTxHash: '', // Will update after payment
				paymentCompleted: false,
				deploymentCompleted: false
			}))
		)

		// Execute b402 payment first
		const relayerWallet = new Wallet(request.server.config.RELAYER_PRIVATE_KEY)
		const signer = relayerWallet.connect(provider)
		const relayer = new Contract(
			request.server.config.B402_RELAYER_ADDRESS,
			B402_RELAYER_ABI,
			signer
		)

		let paymentTxHash = ''
		try {
			const paymentTx = await relayer.transferWithAuthorization(
				paymentPayload.token,
				authorization.from,
				authorization.to,
				authorization.value,
				authorization.validAfter,
				authorization.validBefore,
				authorization.nonce,
				signature,
				{
					gasLimit: 200000
				}
			)
			const paymentReceipt = await paymentTx.wait()
			paymentTxHash = paymentReceipt?.hash || paymentTx.hash
		} catch (error) {
			// Clear DB entries if payment fails
			const walletAddresses = dbEntries.map((entry) => entry.walletAddress)
			await WalletDeployment.deleteMany({ walletAddress: { $in: walletAddresses } })
			throw new BaseErrors.ERR_BLOCKCHAIN_TRANSACTION_FAILED()
		}

		// Update DB entries with payment completion
		const walletAddresses = dbEntries.map((entry) => entry.walletAddress)
		await WalletDeployment.updateMany(
			{ walletAddress: { $in: walletAddresses } },
			{
				$set: {
					paymentTxHash: paymentTxHash.toLowerCase(),
					paymentCompleted: true
				}
			}
		)

		// Deploy wallets and track results
		const createAccountABI = [
			'function createAccount(address owner, uint256 salt) returns (address)'
		]
		const factoryWithSigner = new Contract(
			env.SIMPLE_ACCOUNT_FACTORY_ADDRESS,
			createAccountABI,
			signer
		)

		const successfulWallets: Array<{
			address: string
			salt: string
			owner: string
			deploymentTxHash: string
		}> = []
		const failedWallets: Array<{ address: string; salt: string; owner: string }> = []

		for (let i = 0; i < wallets.length; i++) {
			const wallet = wallets[i]
			try {
				const deploymentTx = await factoryWithSigner.createAccount(
					ownerAddress,
					ethers.toBigInt(wallet.salt),
					{
						gasLimit: 100000
					}
				)
				const receipt = await deploymentTx.wait()
				const deploymentTxHash = receipt?.hash || deploymentTx.hash

				// Update DB for this specific wallet
				await WalletDeployment.updateOne(
					{ walletAddress: wallet.address.toLowerCase() },
					{
						$set: {
							deploymentTxHash: deploymentTxHash.toLowerCase(),
							deploymentCompleted: true
						}
					}
				)

				successfulWallets.push({
					address: wallet.address,
					salt: wallet.salt,
					owner: wallet.owner,
					deploymentTxHash
				})
			} catch (error) {
				failedWallets.push({
					address: wallet.address,
					salt: wallet.salt,
					owner: wallet.owner
				})
				// Continue to next wallet, don't throw and support total failures + partial successes
			}
		}

		const response: DeployWalletsResponse = {
			paymentSuccess: true,
			deploymentSuccess: failedWallets.length === 0,
			wallets: successfulWallets,
			failedWallets: failedWallets.length > 0 ? failedWallets : undefined,
			paymentTxHash,
			deploymentFee: totalDeploymentFee
		}

		return response
	} catch (error) {
		return handleAndReturnErrorResponse(reply, error)
	}
}

/**
 * Function for route `/wallet/:owner`
 * Get all wallet deployments for a given owner address
 *
 * @param request
 * @param reply
 * @returns
 */
export async function getWalletsByOwner(request: FastifyRequest, reply: FastifyReply) {
	try {
		const { owner } = request.params as { owner: string }

		// Validate owner address
		if (!ethers.isAddress(owner)) {
			throw new BaseErrors.ERR_INVALID_ADDRESS()
		}

		// Find all wallets for this owner
		const deployments = await WalletDeployment.find({
			ownerAddress: owner.toLowerCase()
		}).sort({ createdAt: -1 }) // Most recent first

		const wallets = deployments.map((d) => ({
			ownerAddress: d.ownerAddress,
			walletAddress: d.walletAddress,
			salt: d.salt,
			payerAddress: d.payerAddress,
			paymentTxHash: d.paymentTxHash,
			deploymentTxHash: d.deploymentTxHash,
			paymentCompleted: d.paymentCompleted,
			deploymentCompleted: d.deploymentCompleted,
			createdAt: d.createdAt.toISOString(),
			updatedAt: d.updatedAt.toISOString()
		}))

		return { wallets }
	} catch (error) {
		return handleAndReturnErrorResponse(reply, error)
	}
}

/**
 * Function for route `/wallet/claim`
 * Claim and retry deployment for wallets where payment was completed but deployment failed
 *
 * @param request
 * @param reply
 * @returns
 */
export async function claimWalletDeployment(request: FastifyRequest, reply: FastifyReply) {
	try {
		const body = request.body as { paymentTxHash?: string; payerAddress?: string }
		const { paymentTxHash, payerAddress } = body

		// Validate that at least one parameter is provided
		if (!paymentTxHash && !payerAddress) {
			throw new BaseErrors.ERR_MISSING_CLAIM_PARAMS()
		}

		// Validate txHash format if provided
		if (paymentTxHash && !/^0x[a-fA-F0-9]{64}$/.test(paymentTxHash)) {
			throw new BaseErrors.ERR_INVALID_TX_HASH()
		}

		// Validate payer address format if provided
		if (payerAddress && !ethers.isAddress(payerAddress)) {
			throw new BaseErrors.ERR_INVALID_ADDRESS()
		}

		// Build query based on provided parameters
		interface QueryFilter {
			paymentCompleted: boolean
			deploymentCompleted: boolean
			paymentTxHash?: string
			payerAddress?: string
		}

		const query: QueryFilter = {
			paymentCompleted: true,
			deploymentCompleted: false
		}

		if (paymentTxHash) {
			query.paymentTxHash = paymentTxHash.toLowerCase()
		}

		if (payerAddress) {
			query.payerAddress = payerAddress.toLowerCase()
		}

		// Find all wallet deployments matching the criteria
		const deployments = await WalletDeployment.find(query)

		if (deployments.length === 0) {
			throw new BaseErrors.ERR_NO_PENDING_DEPLOYMENTS()
		}

		// Get provider
		const providerService = getProviderService()
		const provider = providerService.getProvider()

		// Initialize signer
		const relayerWallet = new Wallet(request.server.config.RELAYER_PRIVATE_KEY)
		const signer = relayerWallet.connect(provider)

		// Deploy wallets
		const createAccountABI = [
			'function createAccount(address owner, uint256 salt) returns (address)'
		]
		const factory = new Contract(env.SIMPLE_ACCOUNT_FACTORY_ADDRESS, createAccountABI, signer)

		let deploymentTxHash = ''
		try {
			// Deploy all pending wallets
			for (const deployment of deployments) {
				const deploymentTx = await factory.createAccount(
					deployment.ownerAddress,
					ethers.toBigInt(deployment.salt),
					{
						gasLimit: 100000
					}
				)
				const receipt = await deploymentTx.wait()
				deploymentTxHash = receipt?.hash || deploymentTx.hash

				// Update this deployment record
				await deployment.updateOne({
					deploymentTxHash: deploymentTxHash.toLowerCase(),
					deploymentCompleted: true
				})
			}
		} catch (error) {
			throw new BaseErrors.ERR_WALLET_DEPLOYMENT_FAILED()
		}

		// Prepare response
		const wallets = deployments.map((d) => ({
			address: d.walletAddress,
			salt: d.salt,
			owner: d.ownerAddress
		}))

		const network = providerService.getNetwork()
		const response = {
			success: true,
			wallets,
			deploymentTxHash,
			network
		}

		return response
	} catch (error) {
		return handleAndReturnErrorResponse(reply, error)
	}
}
