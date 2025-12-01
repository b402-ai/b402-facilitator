import { Contract, Wallet, ethers } from 'ethers'
import type { FastifyReply, FastifyRequest } from 'fastify'

import { B402_RELAYER_ABI, SUPPORTED_TOKENS } from '../../constants'
import { WalletDeployment } from '../../models'
import type {
	DeployEOASettleRequest,
	DeployEOAVerifyRequest,
	DeployWalletSettleRequest,
	DeployWalletVerifyRequest,
	DeployWalletsResponse,
	DeployWalletsVerifyResponse,
	GetMasterWalletAddressResponse,
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
import type { BatchCall } from '../../types/wallet'
import { getUserOpHash, signUserOp } from '../../utils/paymaster'
import { getProviderService } from '../../utils/provider'
import {
	createPaymentUserOpOrThrow,
	decodeExecuteBatch,
	encodeExecuteBatch,
	getUserOpReceipt,
	submitUserOpToBundler,
	validateFeeIncluded
} from '../../utils/userOp'
import {
	computeMasterWalletAddress,
	getMasterWalletSalt,
	getTokenAllowance,
	getTokenBalance,
	getWalletNonce,
	isWalletDeployed
} from '../../utils/wallet'

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
 * Function for route `/deploy/verify`
 * Verify payment for wallet deployment via EOA
 * Note: Uses EIP712
 *
 * @param request
 * @param reply
 * @returns
 */
export async function verifyDeploymentByEOA(request: FastifyRequest, reply: FastifyReply) {
	try {
		const body = request.body as DeployEOAVerifyRequest
		const { paymentPayload, paymentRequirements } = body

		// Validate deployment config exists
		if (!paymentRequirements.deployment) {
			throw new BaseErrors.ERR_MISSING_DEPLOYMENT_PARAMS()
		}

		const { ownerAddress, salts, fundingRequested } = paymentRequirements.deployment

		// Validate owner address
		if (!ethers.isAddress(ownerAddress)) {
			throw new BaseErrors.ERR_INVALID_ADDRESS()
		}

		// Validate salts array
		if (!salts || salts.length < 1 || salts.length > 10) {
			throw new BaseErrors.ERR_INVALID_WALLET_COUNT()
		}

		const count = salts.length // Total wallets that will be deployed

		// Validate payment array structure
		const expectedPaymentCount = fundingRequested ? count + 1 : 1 // 1 fee payment to us for wallet deployment + (optionally) `count` funding payments for wallets
		if (paymentPayload.length !== expectedPaymentCount) {
			throw new BaseErrors.ERR_ARRAY_LENGTH_MISMATCH()
		}

		// Extract funding amounts from payment payloads if funding is requested
		const fundingAmounts: string[] = []
		if (fundingRequested) {
			for (let i = 1; i < paymentPayload.length; i++) {
				fundingAmounts.push(paymentPayload[i].payload.authorization.value)
			}
		}

		// Calculate fees
		const deploymentFeePerWallet = Number.parseFloat(env.WALLET_DEPLOYMENT_FEE)
		const totalDeploymentFee = (count * deploymentFeePerWallet).toFixed(2)
		const fundingFeePerWallet = Number.parseFloat(env.WALLET_PAYMENT_FEE)
		const totalFundingFees = fundingRequested ? (count * fundingFeePerWallet).toFixed(2) : '0'
		const totalFees = (
			Number.parseFloat(totalDeploymentFee) + Number.parseFloat(totalFundingFees)
		).toFixed(2)

		// Get provider and chain ID for signature verification
		const providerService = getProviderService()
		const provider = providerService.getProvider()
		const chainId = providerService.getChainId()

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

		// Verify the first payment (deployment fees + funding fees to us)
		const feePayment = paymentPayload[0]
		const { authorization: feeAuth, signature: feeSignature } = feePayment.payload

		if (feeAuth.to.toLowerCase() !== env.WALLET_FEE_RECIPIENT.toLowerCase()) {
			throw new BaseErrors.ERR_INVALID_FEE_RECIPIENT()
		}

		// Get token config for decimal conversion
		const tokenConfig = Object.values(SUPPORTED_TOKENS).find(
			(t) => t.address.toLowerCase() === feePayment.token.toLowerCase()
		)
		if (!tokenConfig) {
			throw new BaseErrors.ERR_UNSUPPORTED_TOKEN()
		}

		const feePaymentAmount = ethers.formatUnits(feeAuth.value, tokenConfig.decimals)
		if (Number.parseFloat(feePaymentAmount) !== Number.parseFloat(totalFees)) {
			throw new BaseErrors.ERR_INCORRECT_DEPLOYMENT_FEE()
		}

		const feeMessage = {
			token: feePayment.token,
			...feeAuth
		}
		let feeRecovered: string
		try {
			feeRecovered = ethers.verifyTypedData(domain, types, feeMessage, feeSignature)
		} catch (error) {
			throw new BaseErrors.ERR_SIGNATURE_VERIFICATION_FAILED()
		}
		if (feeRecovered.toLowerCase() !== feeAuth.from.toLowerCase()) {
			throw new BaseErrors.ERR_SIGNATURE_VERIFICATION_FAILED()
		}

		const payer = feeAuth.from

		// Compute wallet addresses from client-provided salts
		const factoryInterface = new ethers.Interface([
			'function getAddress(address owner, uint256 salt) view returns (address)'
		])

		const wallets: Array<{ address: string; salt: string; owner: string; fundingAmount?: string }> =
			[]

		for (let i = 0; i < count; i++) {
			const saltStr = salts[i]
			const callData = factoryInterface.encodeFunctionData('getAddress', [
				ownerAddress,
				BigInt(saltStr)
			])
			const result = await provider.call({
				to: env.SIMPLE_ACCOUNT_FACTORY_ADDRESS,
				data: callData
			})
			const walletAddress = factoryInterface.decodeFunctionResult('getAddress', result)[0]

			// Validate wallet is not already deployed
			const exists = await isWalletDeployed(walletAddress)
			if (exists) {
				throw new BaseErrors.ERR_WALLET_ALREADY_DEPLOYED()
			}

			const wallet = {
				address: walletAddress,
				salt: saltStr,
				owner: ownerAddress,
				fundingAmount: fundingAmounts?.[i]
			}
			wallets.push(wallet)
		}

		// Verify funding payment signatures if funding is requested
		if (fundingRequested && fundingAmounts.length > 0) {
			for (let i = 0; i < fundingAmounts.length; i++) {
				const fundingPayment = paymentPayload[i + 1] // +1 because first payment is fees to us
				const wallet = wallets[i]
				const { authorization: fundingAuth, signature: fundingSignature } = fundingPayment.payload

				// Verify funding recipient matches wallet address
				if (fundingAuth.to.toLowerCase() !== wallet.address.toLowerCase()) {
					throw new BaseErrors.ERR_INVALID_RECIPIENT_ADDRESS()
				}

				// Verify funding amount
				const fundingPaymentAmount = Number.parseFloat(fundingAuth.value)
				const expectedFundingAmount = Number.parseFloat(fundingAmounts[i])
				if (fundingPaymentAmount !== expectedFundingAmount) {
					throw new BaseErrors.ERR_INVALID_AMOUNT()
				}

				// Verify funding payment signature
				const fundingMessage = {
					token: fundingPayment.token,
					...fundingAuth
				}
				let fundingRecovered: string
				try {
					fundingRecovered = ethers.verifyTypedData(domain, types, fundingMessage, fundingSignature)
				} catch (error) {
					throw new BaseErrors.ERR_SIGNATURE_VERIFICATION_FAILED()
				}
				if (fundingRecovered.toLowerCase() !== fundingAuth.from.toLowerCase()) {
					throw new BaseErrors.ERR_SIGNATURE_VERIFICATION_FAILED()
				}
			}
		}

		const response: DeployWalletsVerifyResponse = {
			isValid: true,
			payer,
			wallets,
			deploymentFee: totalDeploymentFee,
			fundingFees: totalFundingFees,
			totalFees
		}

		return response
	} catch (error) {
		return handleAndReturnErrorResponse(reply, error)
	}
}

/**
 * Function for route `/deploy/settle`
 * Execute payment and deploy wallets via EOA
 * Note: Uses EIP712
 *
 * @param request
 * @param reply
 * @returns
 */
export async function settleDeploymentByEOA(request: FastifyRequest, reply: FastifyReply) {
	try {
		const body = request.body as DeployEOASettleRequest
		const { paymentPayload, paymentRequirements, wallets } = body

		// Validate deployment config exists
		if (!paymentRequirements.deployment) {
			throw new BaseErrors.ERR_MISSING_DEPLOYMENT_PARAMS()
		}

		// Validate wallets array
		if (!wallets || wallets.length < 1 || wallets.length > 10) {
			throw new BaseErrors.ERR_INVALID_WALLET_COUNT()
		}

		// Validate all wallet addresses and owners
		for (const wallet of wallets) {
			if (!ethers.isAddress(wallet.address)) {
				throw new BaseErrors.ERR_INVALID_ADDRESS()
			}
			if (!ethers.isAddress(wallet.owner)) {
				throw new BaseErrors.ERR_INVALID_ADDRESS()
			}
		}

		// Extract funding amounts from payment payloads if funding is requested
		const fundingAmounts: string[] = []
		const hasFunding = paymentPayload.length > 1
		if (hasFunding) {
			for (let i = 1; i < paymentPayload.length; i++) {
				fundingAmounts.push(paymentPayload[i].payload.authorization.value)
			}
		}

		// Calculate and validate fees
		const count = wallets.length
		const deploymentFeePerWallet = Number.parseFloat(env.WALLET_DEPLOYMENT_FEE)
		const totalDeploymentFee = (count * deploymentFeePerWallet).toFixed(2)
		const fundingFeePerWallet = Number.parseFloat(env.WALLET_PAYMENT_FEE)
		const totalFundingFees = hasFunding
			? (fundingAmounts.length * fundingFeePerWallet).toFixed(2)
			: '0'
		const totalFees = (
			Number.parseFloat(totalDeploymentFee) + Number.parseFloat(totalFundingFees)
		).toFixed(2)

		// Get first payment (fees to us) authorization and signature
		const feePayment = paymentPayload[0]
		const { authorization, signature } = feePayment.payload

		// Validate fee payment recipient
		if (authorization.to.toLowerCase() !== env.WALLET_FEE_RECIPIENT.toLowerCase()) {
			throw new BaseErrors.ERR_INVALID_FEE_RECIPIENT()
		}

		// Get token config for decimal conversion
		const tokenConfig = Object.values(SUPPORTED_TOKENS).find(
			(t) => t.address.toLowerCase() === feePayment.token.toLowerCase()
		)
		if (!tokenConfig) {
			throw new BaseErrors.ERR_UNSUPPORTED_TOKEN()
		}

		// Validate fee payment amount matches calculated fees
		const feePaymentAmount = ethers.formatUnits(authorization.value, tokenConfig.decimals)
		if (Number.parseFloat(feePaymentAmount) !== Number.parseFloat(totalFees)) {
			throw new BaseErrors.ERR_INCORRECT_DEPLOYMENT_FEE()
		}

		// Get provider and relayer contract for nonce checks
		const providerService = getProviderService()
		const provider = providerService.getProvider()
		const relayer = new Contract(
			request.server.config.B402_RELAYER_ADDRESS,
			B402_RELAYER_ABI,
			provider
		)

		// Validate all nonces are not already used
		// Check fee payment nonce
		const feeNonceUsed = await relayer.authorizationState(authorization.from, authorization.nonce)
		if (feeNonceUsed) {
			throw new BaseErrors.ERR_NONCE_ALREADY_USED()
		}

		// Check funding payment nonces if funding is requested
		if (hasFunding) {
			for (let i = 1; i < paymentPayload.length; i++) {
				const fundingAuth = paymentPayload[i].payload.authorization
				const fundingNonceUsed = await relayer.authorizationState(
					fundingAuth.from,
					fundingAuth.nonce
				)
				if (fundingNonceUsed) {
					throw new BaseErrors.ERR_NONCE_ALREADY_USED()
				}
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

		// Create DB entries before executing payment and throw if DB fails
		// Note: We do this to prevent payment going through with a failed DB
		let dbRecordsCreated = false
		try {
			await WalletDeployment.insertMany(
				wallets.map((wallet) => {
					// Find the funding payment for this wallet
					const fundingPayment = hasFunding
						? paymentPayload.find(
								(p) => p.payload.authorization.to.toLowerCase() === wallet.address.toLowerCase()
							)
						: undefined

					return {
						ownerAddress: wallet.owner.toLowerCase(),
						walletAddress: wallet.address.toLowerCase(),
						salt: wallet.salt,
						payerAddress: authorization.from.toLowerCase(),
						paymentTxHash: '', // Will be set after payment confirmation
						paymentCompleted: false, // Will be set to true after payment confirmation
						deploymentCompleted: false,
						fundingAmount: wallet.fundingAmount,
						fundingRequested: !!wallet.fundingAmount,
						fundingCompleted: false,
						feePaymentNonce: authorization.nonce, // Seeder matching
						// Store funding payment data for retry in case funding fails
						...(fundingPayment && {
							fundingPaymentData: {
								token: fundingPayment.token,
								authorization: fundingPayment.payload.authorization,
								signature: fundingPayment.payload.signature
							}
						})
					}
				})
			)
			dbRecordsCreated = true
		} catch (error) {
			throw new BaseErrors.ERR_INTERNAL_SERVER_ERROR()
		}

		// Execute fee payment to us first (deployment fee + funding fees)
		const relayerWallet = new Wallet(request.server.config.RELAYER_PRIVATE_KEY)
		const signer = relayerWallet.connect(provider)
		const relayerWithSigner = new Contract(
			request.server.config.B402_RELAYER_ADDRESS,
			B402_RELAYER_ABI,
			signer
		)

		let paymentTxHash = ''
		try {
			const paymentTx = await relayerWithSigner.transferWithAuthorization(
				feePayment.token,
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
			// Rollback DB since payment transaction failed
			if (dbRecordsCreated) {
				await WalletDeployment.deleteMany({
					walletAddress: { $in: walletAddressesToCheck }
				})
			}
			throw new BaseErrors.ERR_BLOCKCHAIN_TRANSACTION_FAILED()
		}

		// Update DB entries with payment details after successful payment
		try {
			await WalletDeployment.updateMany(
				{ walletAddress: { $in: walletAddressesToCheck } },
				{
					$set: {
						paymentTxHash: paymentTxHash.toLowerCase(),
						paymentCompleted: true
					}
				}
			)
		} catch {
			// Seeder will update retroactively if DB fails here
		}

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
			fundingAmount?: string
			fundingTxHash?: string
			fundingCompleted?: boolean
		}> = []
		const failedWallets: Array<{ address: string; salt: string; owner: string }> = []

		for (let i = 0; i < wallets.length; i++) {
			const wallet = wallets[i]
			try {
				const deploymentTx = await factoryWithSigner.createAccount(
					wallet.owner,
					ethers.toBigInt(wallet.salt),
					{
						gasLimit: 500000
					}
				)
				const receipt = await deploymentTx.wait()
				const deploymentTxHash = receipt?.hash || deploymentTx.hash

				successfulWallets.push({
					address: wallet.address,
					salt: wallet.salt,
					owner: wallet.owner,
					deploymentTxHash
				})
			} catch (error) {
				// Check if wallet was frontrun (deployed by someone else)
				const exists = await isWalletDeployed(wallet.address)
				if (exists) {
					successfulWallets.push({
						address: wallet.address,
						salt: wallet.salt,
						owner: wallet.owner,
						deploymentTxHash: '' // Empty since we didn't deploy it
					})
				} else {
					// Deployment truly failed
					failedWallets.push({
						address: wallet.address,
						salt: wallet.salt,
						owner: wallet.owner
					})
				}
				// Continue to next wallet, don't throw and support total failures + partial successes
				// Note: Failed wallet deployments can be retried via the `/claim` route
			}
		}

		// Batch update deployment status for all successful wallets
		if (successfulWallets.length > 0) {
			const bulkOps = successfulWallets.map((wallet) => ({
				updateOne: {
					filter: { walletAddress: wallet.address.toLowerCase() },
					update: {
						$set: {
							deploymentTxHash: wallet.deploymentTxHash.toLowerCase(),
							deploymentCompleted: true
						}
					}
				}
			}))
			try {
				await WalletDeployment.bulkWrite(bulkOps)
			} catch {
				// Seeder will update retroactively if DB fails here
			}
		}

		// Execute funding payments for successfully deployed wallets
		const failedFundings: Array<{
			address: string
			salt: string
			owner: string
			fundingAmount: string
		}> = []

		const successfulFundings: Array<{
			address: string
			fundingTxHash: string
			fundingAmount: string
		}> = []

		if (hasFunding) {
			for (const wallet of successfulWallets) {
				// Find the funding payment for this specific wallet by matching recipient address
				const fundingPayment = paymentPayload.find(
					(p) => p.payload.authorization.to.toLowerCase() === wallet.address.toLowerCase()
				)

				if (fundingPayment) {
					try {
						const { authorization: fundingAuth, signature: fundingSignature } =
							fundingPayment.payload

						const fundingTx = await relayerWithSigner.transferWithAuthorization(
							fundingPayment.token,
							fundingAuth.from,
							fundingAuth.to,
							fundingAuth.value,
							fundingAuth.validAfter,
							fundingAuth.validBefore,
							fundingAuth.nonce,
							fundingSignature,
							{
								gasLimit: 200000
							}
						)
						const fundingReceipt = await fundingTx.wait()
						const fundingTxHash = fundingReceipt?.hash || fundingTx.hash

						successfulFundings.push({
							address: wallet.address,
							fundingTxHash,
							fundingAmount: fundingAuth.value
						})

						wallet.fundingAmount = fundingAuth.value
						wallet.fundingTxHash = fundingTxHash
						wallet.fundingCompleted = true
					} catch (error) {
						// Note: Failed fundings can be retried via the `/claim` route
						failedFundings.push({
							address: wallet.address,
							salt: wallet.salt,
							owner: wallet.owner,
							fundingAmount: fundingPayment.payload.authorization.value
						})
						wallet.fundingCompleted = false
					}
				}
			}

			// Update funding status for all successful fundings
			if (successfulFundings.length > 0) {
				const fundingBulkOps = successfulFundings.map((funding) => ({
					updateOne: {
						filter: { walletAddress: funding.address.toLowerCase() },
						update: {
							$set: {
								fundingTxHash: funding.fundingTxHash.toLowerCase(),
								fundingCompleted: true
							}
						}
					}
				}))
				try {
					await WalletDeployment.bulkWrite(fundingBulkOps)
				} catch {
					// Seeder will update retroactively if DB fails here
				}
			}
		}

		// Determine overall success flags
		const paymentSuccess = true // Payment completed successfully
		const deploymentSuccess = successfulWallets.length === wallets.length
		const fundingSuccess = failedFundings.length === 0

		const response: DeployWalletsResponse = {
			paymentSuccess,
			deploymentSuccess,
			fundingSuccess,
			wallets: successfulWallets,
			failedWallets,
			failedFundings,
			paymentTxHash,
			deploymentFee: totalDeploymentFee
		}

		return response
	} catch (error) {
		return handleAndReturnErrorResponse(reply, error)
	}
}

/**
 * Function for route `/deploy/wallet/verify`
 * Verify smart wallet payment for wallet deployment
 *
 * @param request
 * @param reply
 * @returns
 */
export async function verifyDeploymentBySmartWallet(request: FastifyRequest, reply: FastifyReply) {
	try {
		const body = request.body as DeployWalletVerifyRequest
		const { paymentRequirements } = body

		// Validate deployment config exists
		if (!paymentRequirements.deployment) {
			throw new BaseErrors.ERR_MISSING_DEPLOYMENT_PARAMS()
		}

		const { payerAddress, ownerAddress, salts, fundingRequested } = paymentRequirements.deployment
		const payerWalletAddress = payerAddress.toLowerCase()

		// Validate owner address
		if (!ethers.isAddress(ownerAddress)) {
			throw new BaseErrors.ERR_INVALID_ADDRESS()
		}

		// Validate payer wallet address from UserOp
		if (!ethers.isAddress(payerWalletAddress)) {
			throw new BaseErrors.ERR_INVALID_ADDRESS()
		}

		// Validate salts array
		if (!salts || salts.length < 1 || salts.length > 10) {
			throw new BaseErrors.ERR_INVALID_WALLET_COUNT()
		}

		const count = salts.length

		// Calculate fees
		const deploymentFeePerWallet = Number.parseFloat(env.WALLET_DEPLOYMENT_FEE)
		const totalDeploymentFee = (count * deploymentFeePerWallet).toFixed(2)
		const fundingFeePerWallet = Number.parseFloat(env.WALLET_PAYMENT_FEE)
		const totalFundingFees = fundingRequested ? (count * fundingFeePerWallet).toFixed(2) : '0'
		const totalFees = (
			Number.parseFloat(totalDeploymentFee) + Number.parseFloat(totalFundingFees)
		).toFixed(2)

		// Get provider
		const providerService = getProviderService()
		const provider = providerService.getProvider()

		// Compute wallet addresses from client-provided salts
		const factoryInterface = new ethers.Interface([
			'function getAddress(address owner, uint256 salt) view returns (address)'
		])

		const wallets: Array<{ address: string; salt: string; owner: string; fundingAmount?: string }> =
			[]

		// Determine which token to use - default to first supported token (USDT)
		const token = Object.values(SUPPORTED_TOKENS)[0].address
		const tokenConfig = Object.values(SUPPORTED_TOKENS)[0]

		const fundingAmounts: string[] = []
		for (let i = 0; i < count; i++) {
			const saltStr = salts[i]

			// Compute wallet address from salt
			const callData = factoryInterface.encodeFunctionData('getAddress', [
				ownerAddress,
				BigInt(saltStr)
			])
			const result = await provider.call({
				to: env.SIMPLE_ACCOUNT_FACTORY_ADDRESS,
				data: callData
			})
			const computedWalletAddress = factoryInterface.decodeFunctionResult('getAddress', result)[0]

			// Validate wallet is not already deployed
			const exists = await isWalletDeployed(computedWalletAddress)
			if (exists) {
				throw new BaseErrors.ERR_WALLET_ALREADY_PAID()
			}

			const wallet: { address: string; salt: string; owner: string; fundingAmount?: string } = {
				address: computedWalletAddress,
				salt: saltStr,
				owner: ownerAddress
			}

			if (fundingRequested) {
				const fundingAmount = env.WALLET_PAYMENT_FEE
				wallet.fundingAmount = fundingAmount
				fundingAmounts.push(fundingAmount)
			}

			wallets.push(wallet)
		}

		// Build UserOp for deployment payment
		// Calculate recipients and amounts
		const recipients: string[] = [env.WALLET_FEE_RECIPIENT]
		const paymentAmounts: bigint[] = [ethers.parseUnits(totalFees, tokenConfig.decimals)]

		// Add funding recipients if requested
		if (fundingRequested && fundingAmounts.length > 0) {
			for (let i = 0; i < wallets.length; i++) {
				recipients.push(wallets[i].address)
				paymentAmounts.push(ethers.parseUnits(fundingAmounts[i], tokenConfig.decimals))
			}
		}

		const totalPaymentAmount = paymentAmounts.reduce((sum, amt) => sum + amt, 0n)

		// Check if we need to approve relayer
		const currentAllowance = await getTokenAllowance(payerWalletAddress, token)
		const needsApproval = BigInt(currentAllowance) < totalPaymentAmount

		// Build batch calls
		const calls: BatchCall[] = []

		if (needsApproval) {
			const approveData = new ethers.Interface([
				'function approve(address spender, uint256 amount) returns (bool)'
			]).encodeFunctionData('approve', [env.B402_RELAYER_ADDRESS, totalPaymentAmount])
			calls.push({
				to: token,
				value: '0',
				data: approveData
			})
		}

		const relayerIface = new ethers.Interface(B402_RELAYER_ABI)
		const validAfter = Math.floor(Date.now() / 1000) - 3600
		const validBefore = Math.floor(Date.now() / 1000) + 3600
		const nonce = ethers.hexlify(ethers.randomBytes(32))

		const batchTransferData = relayerIface.encodeFunctionData('batchTransferWithUserOp', [
			token,
			recipients,
			paymentAmounts,
			validAfter,
			validBefore,
			nonce
		])
		calls.push({
			to: env.B402_RELAYER_ADDRESS,
			value: '0',
			data: batchTransferData
		})

		const callData = encodeExecuteBatch(calls)
		const walletNonce = await getWalletNonce(payerWalletAddress)

		const feeData = await provider.getFeeData()
		const baseGasPrice = feeData.gasPrice || ethers.parseUnits('1', 'gwei')
		const maxFeePerGas = (baseGasPrice * 12n) / 10n
		const maxPriorityFeePerGas = ethers.parseUnits('1', 'gwei')

		const userOp: UserOperation = {
			sender: payerWalletAddress,
			nonce: ethers.toBeHex(walletNonce),
			factory: undefined,
			factoryData: undefined,
			callData,
			callGasLimit: ethers.toBeHex(1000000),
			verificationGasLimit: ethers.toBeHex(1000000),
			preVerificationGas: ethers.toBeHex(150000),
			maxFeePerGas: ethers.toBeHex(maxFeePerGas),
			maxPriorityFeePerGas: ethers.toBeHex(maxPriorityFeePerGas),
			paymaster: undefined,
			paymasterVerificationGasLimit: undefined,
			paymasterPostOpGasLimit: undefined,
			paymasterData: undefined,
			signature: '0x'
		}

		// Validate payer wallet has sufficient balance
		const balanceStr = await getTokenBalance(payerWalletAddress, token)
		const balance = BigInt(balanceStr)
		if (balance < totalPaymentAmount) {
			throw new BaseErrors.ERR_INSUFFICIENT_BALANCE()
		}

		// Sign UserOp with paymaster to enable gasless transaction
		const chainId = env.NETWORK === 'mainnet' ? 56 : 97
		const paymasterData = await signUserOp(userOp, chainId)
		userOp.paymaster = paymasterData.paymaster
		userOp.paymasterVerificationGasLimit = paymasterData.paymasterVerificationGasLimit
		userOp.paymasterPostOpGasLimit = paymasterData.paymasterPostOpGasLimit
		userOp.paymasterData = paymasterData.paymasterData

		const userOpHash = await getUserOpHash(userOp, env.ENTRY_POINT_ADDRESS, chainId)

		// Return validation response with paymaster-signed UserOp
		return {
			isValid: true,
			payer: payerWalletAddress,
			wallets,
			deploymentFee: totalDeploymentFee,
			fundingFees: totalFundingFees,
			totalFees,
			userOp,
			userOpHash
		}
	} catch (error) {
		return handleAndReturnErrorResponse(reply, error)
	}
}

/**
 * Function for route `/deploy/wallet/settle`
 * Execute smart wallet payment and deploy wallets
 *
 * @param request
 * @param reply
 * @returns
 */
export async function settleDeploymentBySmartWallet(request: FastifyRequest, reply: FastifyReply) {
	try {
		const body = request.body as DeployWalletSettleRequest
		const { userOp, signature, paymentRequirements, wallets } = body

		// Extract payer wallet address from UserOp sender
		const payerWalletAddress = userOp.sender

		// Validate deployment config exists
		if (!paymentRequirements.deployment) {
			throw new BaseErrors.ERR_MISSING_DEPLOYMENT_PARAMS()
		}

		const { fundingRequested } = paymentRequirements.deployment

		// Validate wallets array
		if (!wallets || wallets.length === 0) {
			throw new BaseErrors.ERR_INVALID_WALLET_COUNT()
		}

		if (wallets.length > 10) {
			throw new BaseErrors.ERR_INVALID_WALLET_COUNT()
		}

		// Validate all wallet addresses and owners
		for (const wallet of wallets) {
			if (!ethers.isAddress(wallet.address)) {
				throw new BaseErrors.ERR_INVALID_ADDRESS()
			}
			if (!ethers.isAddress(wallet.owner)) {
				throw new BaseErrors.ERR_INVALID_ADDRESS()
			}
		}

		// Calculate and validate fees
		const count = wallets.length
		const deploymentFeePerWallet = Number.parseFloat(env.WALLET_DEPLOYMENT_FEE)
		const totalDeploymentFee = (count * deploymentFeePerWallet).toFixed(2)
		const fundingFeePerWallet = Number.parseFloat(env.WALLET_PAYMENT_FEE)
		const totalFundingFees = fundingRequested ? (count * fundingFeePerWallet).toFixed(2) : '0'
		const totalFees = (
			Number.parseFloat(totalDeploymentFee) + Number.parseFloat(totalFundingFees)
		).toFixed(2)

		// Validate UserOp contains correct payments before submission
		if (!userOp.callData || userOp.callData === '0x') {
			throw new BaseErrors.ERR_INVALID_USEROP()
		}

		// Decode and validate UserOp callData
		const calls = decodeExecuteBatch(userOp.callData)
		const relayerCall = calls.find(
			(call) => call.to.toLowerCase() === env.B402_RELAYER_ADDRESS.toLowerCase()
		)

		if (!relayerCall) {
			throw new BaseErrors.ERR_INVALID_USEROP()
		}

		// Decode the `batchTransferWithUserOp`
		const relayerIface = new ethers.Interface(B402_RELAYER_ABI)
		const decoded = relayerIface.decodeFunctionData('batchTransferWithUserOp', relayerCall.data)

		const token = decoded[0] as string
		const recipients = decoded[1] as string[]
		const amounts = decoded[2] as bigint[]

		// Validate token is supported
		const tokenConfig = Object.values(SUPPORTED_TOKENS).find(
			(t) => t.address.toLowerCase() === token.toLowerCase()
		)
		if (!tokenConfig) {
			throw new BaseErrors.ERR_UNSUPPORTED_TOKEN()
		}

		// Validate fee payment exists and is correct
		const feeRecipientIndex = recipients.findIndex(
			(r) => r.toLowerCase() === env.WALLET_FEE_RECIPIENT.toLowerCase()
		)
		if (feeRecipientIndex === -1) {
			throw new BaseErrors.ERR_INVALID_FEE_RECIPIENT()
		}

		const feeAmount = ethers.formatUnits(amounts[feeRecipientIndex], tokenConfig.decimals)
		if (Number.parseFloat(feeAmount) !== Number.parseFloat(totalFees)) {
			throw new BaseErrors.ERR_INCORRECT_DEPLOYMENT_FEE()
		}

		// If funding is requested, validate funding payments
		if (fundingRequested) {
			for (const wallet of wallets) {
				const fundingIndex = recipients.findIndex(
					(r) => r.toLowerCase() === wallet.address.toLowerCase()
				)
				if (fundingIndex === -1) {
					throw new BaseErrors.ERR_INVALID_RECIPIENT_ADDRESS()
				}
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

		// Create DB entries before submitting UserOp and throw if DB fails
		// Note: We do this to prevent payment going through with a failed DB
		let dbRecordsCreated = false
		try {
			await WalletDeployment.insertMany(
				wallets.map((wallet) => ({
					ownerAddress: wallet.owner.toLowerCase(),
					walletAddress: wallet.address.toLowerCase(),
					salt: wallet.salt,
					payerAddress: payerWalletAddress.toLowerCase(),
					paymentTxHash: '', // Will be set after confirmation
					paymentCompleted: false, // Will be set to true after confirmation
					deploymentCompleted: false,
					fundingAmount: wallet.fundingAmount,
					fundingRequested: !!wallet.fundingAmount,
					fundingCompleted: false,
					userOpNonce: userOp.nonce // Seeder matching
				}))
			)
			dbRecordsCreated = true
		} catch (error) {
			throw new BaseErrors.ERR_INTERNAL_SERVER_ERROR()
		}

		// Submit UserOp to bundler
		userOp.signature = signature
		let userOpHash: string
		try {
			userOpHash = await submitUserOpToBundler(userOp)
		} catch (error) {
			// Rollback DB since UserOp submission failed
			if (dbRecordsCreated) {
				await WalletDeployment.deleteMany({
					walletAddress: { $in: walletAddressesToCheck }
				})
			}
			throw new BaseErrors.ERR_BUNDLER_SUBMISSION_FAILED()
		}

		// Wait for receipt
		let paymentTxHash = ''
		let paymentSuccess = false
		try {
			for (let i = 0; i < 30; i++) {
				await new Promise((resolve) => setTimeout(resolve, 2000))
				try {
					const receipt = await getUserOpReceipt(userOpHash)
					if (receipt.success) {
						paymentTxHash = receipt.txHash
						paymentSuccess = true
						break
					}
				} catch {
					// Continue polling
				}
			}
		} catch {
			throw new BaseErrors.ERR_TRANSACTION_CONFIRMATION_FAILED()
		}

		if (!paymentSuccess || !paymentTxHash) {
			// Rollback DB since payment failed
			await WalletDeployment.deleteMany({
				walletAddress: { $in: walletAddressesToCheck }
			})
			throw new BaseErrors.ERR_TRANSACTION_CONFIRMATION_FAILED()
		}

		// Update DB entries with payment details
		// Note: Since UserOp executed successfully, all payments (fees + funding) completed atomically
		try {
			await WalletDeployment.updateMany(
				{ walletAddress: { $in: walletAddressesToCheck } },
				{
					$set: {
						paymentTxHash: paymentTxHash.toLowerCase(),
						paymentCompleted: true
					}
				}
			)
		} catch {
			// Seeder will update retroactively if DB fails here
		}

		// Get provider and signer
		const providerService = getProviderService()
		const provider = providerService.getProvider()
		const relayerWallet = new Wallet(request.server.config.RELAYER_PRIVATE_KEY)
		const signer = relayerWallet.connect(provider)

		// Deploy wallets and track results
		const createAccountABI = [
			'function createAccount(address owner, uint256 salt) returns (address)'
		]
		const factoryWithSigner = new Contract(
			env.SIMPLE_ACCOUNT_FACTORY_ADDRESS,
			createAccountABI,
			signer
		)

		const deployedWallets: Array<{
			address: string
			salt: string
			owner: string
			deploymentTxHash: string
			fundingAmount?: string
			fundingCompleted?: boolean
		}> = []
		const failedWallets: Array<{ address: string; salt: string; owner: string }> = []

		for (let i = 0; i < wallets.length; i++) {
			const wallet = wallets[i]
			try {
				const deploymentTx = await factoryWithSigner.createAccount(
					wallet.owner,
					ethers.toBigInt(wallet.salt),
					{
						gasLimit: 500000
					}
				)
				const receipt = await deploymentTx.wait()
				const deploymentTxHash = receipt?.hash || deploymentTx.hash

				deployedWallets.push({
					address: wallet.address,
					salt: wallet.salt,
					owner: wallet.owner,
					deploymentTxHash,
					fundingAmount: wallet.fundingAmount,
					fundingCompleted: !!wallet.fundingAmount // Funding already happened atomically via UserOp
				})
			} catch (error) {
				// Check if wallet was frontrun (deployed by someone else)
				const exists = await isWalletDeployed(wallet.address)
				if (exists) {
					deployedWallets.push({
						address: wallet.address,
						salt: wallet.salt,
						owner: wallet.owner,
						deploymentTxHash: '', // Empty since we didn't deploy it
						fundingAmount: wallet.fundingAmount,
						fundingCompleted: !!wallet.fundingAmount // Funding already happened atomically via UserOp
					})
				} else {
					// Deployment truly failed
					failedWallets.push({
						address: wallet.address,
						salt: wallet.salt,
						owner: wallet.owner
					})
				}
				// Support partial successes, don't throw
				// Note: Failed wallet deployments can be retried via the `/claim` route
				// Note: If funding succeeded, the tokens will be accessible once the wallet is successfully deployed
			}
		}

		// Batch update deployment status for all successful wallets
		if (deployedWallets.length > 0) {
			const bulkOps = deployedWallets.map((wallet) => ({
				updateOne: {
					filter: { walletAddress: wallet.address.toLowerCase() },
					update: {
						$set: {
							deploymentTxHash: wallet.deploymentTxHash.toLowerCase(),
							deploymentCompleted: true,
							fundingCompleted: !!wallet.fundingAmount // Funding already happened atomically via UserOp
						}
					}
				}
			}))
			try {
				await WalletDeployment.bulkWrite(bulkOps)
			} catch {
				// Seeder will update retroactively if DB fails here
			}
		}

		// Determine overall success flags
		const deploymentSuccess = deployedWallets.length === wallets.length
		const fundingSuccess = true // If UserOp succeeded, all funding transfers succeeded atomically

		const response: DeployWalletsResponse = {
			paymentSuccess,
			deploymentSuccess,
			fundingSuccess,
			wallets: deployedWallets,
			failedWallets,
			failedFundings: [], // No failures
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
 * Get all wallet deployments for a given owner address (always includes master wallet details even if not deployed)
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

		// Compute master wallet salt and address for this owner
		const masterSalt = getMasterWalletSalt(owner).toString()
		const masterWalletAddress = await computeMasterWalletAddress(owner)

		// Find all wallets for this owner
		const deployments = await WalletDeployment.find({
			ownerAddress: owner.toLowerCase()
		}).sort({ createdAt: -1 })

		const master: Array<{
			ownerAddress: string
			walletAddress: string
			salt: string
			payerAddress: string
			paymentTxHash: string
			deploymentTxHash?: string
			paymentCompleted: boolean
			deploymentCompleted: boolean
			fundingRequested: boolean
			fundingCompleted: boolean
			fundingAmount?: string
			fundingTxHash?: string
			createdAt: string
			updatedAt: string
		}> = []

		const sub: typeof master = []

		let masterFound = false

		// Split wallets based on whether they use the master salt
		for (const d of deployments) {
			const wallet = {
				ownerAddress: d.ownerAddress,
				walletAddress: d.walletAddress,
				salt: d.salt,
				payerAddress: d.payerAddress,
				paymentTxHash: d.paymentTxHash,
				deploymentTxHash: d.deploymentTxHash,
				paymentCompleted: d.paymentCompleted,
				deploymentCompleted: d.deploymentCompleted,
				fundingRequested: d.fundingRequested,
				fundingCompleted: d.fundingCompleted,
				fundingAmount: d.fundingAmount,
				fundingTxHash: d.fundingTxHash,
				createdAt: d.createdAt.toISOString(),
				updatedAt: d.updatedAt.toISOString()
			}

			if (d.salt === masterSalt) {
				master.push(wallet)
				masterFound = true
			} else {
				sub.push(wallet)
			}
		}

		// If master wallet not in DB, add it with deterministic fields only
		if (!masterFound) {
			master.push({
				ownerAddress: owner.toLowerCase(),
				walletAddress: masterWalletAddress.toLowerCase(),
				salt: masterSalt,
				payerAddress: '',
				paymentTxHash: '',
				deploymentTxHash: undefined,
				paymentCompleted: false,
				deploymentCompleted: false,
				fundingRequested: false,
				fundingCompleted: false,
				fundingAmount: undefined,
				fundingTxHash: undefined,
				createdAt: '', // client can check if empty implies master wallet not deployed
				updatedAt: ''
			})
		}

		return { master, sub }
	} catch (error) {
		return handleAndReturnErrorResponse(reply, error)
	}
}

/**
 * Function for route `/wallet/:owner/master`
 * Get the deterministic master wallet address for a given owner EOA
 *
 * @param request
 * @param reply
 * @returns
 */
export async function getMasterWalletAddress(
	request: FastifyRequest,
	reply: FastifyReply
): Promise<GetMasterWalletAddressResponse> {
	try {
		const { owner } = request.params as { owner: string }

		// Validate owner address
		if (!ethers.isAddress(owner)) {
			throw new BaseErrors.ERR_INVALID_ADDRESS()
		}

		// Compute master wallet salt
		const salt = getMasterWalletSalt(owner)

		// Compute master wallet address
		const masterWalletAddress = await computeMasterWalletAddress(owner)

		const response: GetMasterWalletAddressResponse = {
			ownerAddress: owner.toLowerCase(),
			masterWalletAddress: masterWalletAddress.toLowerCase(),
			salt: salt.toString()
		}

		return response
	} catch (error) {
		return handleAndReturnErrorResponse(reply, error)
	}
}

/**
 * Function for route `/wallet/claim`
 * Claim and retry deployment/funding for wallets where payment was completed but deployment or funding failed
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

		// Find all wallet deployments matching the criteria
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

		// Deploy all pending wallets
		const createAccountABI = [
			'function createAccount(address owner, uint256 salt) returns (address)'
		]
		const factory = new Contract(env.SIMPLE_ACCOUNT_FACTORY_ADDRESS, createAccountABI, signer)

		const successfulDeployments: Array<{
			address: string
			salt: string
			owner: string
			deploymentTxHash: string
			needsFundingUpdate?: boolean
		}> = []
		const failedDeployments: Array<{
			address: string
			salt: string
			owner: string
			error: string
		}> = []

		for (const deployment of deployments) {
			// Check if wallet already exists (could've been deployed by someone else)
			const alreadyExists = await isWalletDeployed(deployment.walletAddress)
			if (alreadyExists) {
				successfulDeployments.push({
					address: deployment.walletAddress,
					salt: deployment.salt,
					owner: deployment.ownerAddress,
					deploymentTxHash: '', // Empty since we didn't deploy it
					needsFundingUpdate: deployment.fundingRequested && !deployment.fundingPaymentData
				})
				continue
			}

			try {
				const deploymentTx = await factory.createAccount(
					deployment.ownerAddress,
					ethers.toBigInt(deployment.salt),
					{
						gasLimit: 500000
					}
				)
				const receipt = await deploymentTx.wait()
				const deploymentTxHash = receipt?.hash || deploymentTx.hash

				successfulDeployments.push({
					address: deployment.walletAddress,
					salt: deployment.salt,
					owner: deployment.ownerAddress,
					deploymentTxHash,
					needsFundingUpdate: deployment.fundingRequested && !deployment.fundingPaymentData
				})
			} catch (error) {
				// Check if wallet was frontrun (deployed by someone else)
				const exists = await isWalletDeployed(deployment.walletAddress)
				if (exists) {
					successfulDeployments.push({
						address: deployment.walletAddress,
						salt: deployment.salt,
						owner: deployment.ownerAddress,
						deploymentTxHash: '', // Empty since we didn't deploy it
						needsFundingUpdate: deployment.fundingRequested && !deployment.fundingPaymentData
					})
				} else {
					// Deployment truly failed
					failedDeployments.push({
						address: deployment.walletAddress,
						salt: deployment.salt,
						owner: deployment.ownerAddress,
						error: error instanceof Error ? error.message : 'Unknown error'
					})
				}
				// Continue to next wallet (support partial success)
			}
		}

		// Update all successful deployments
		if (successfulDeployments.length > 0) {
			const bulkOps = successfulDeployments.map((deployment) => ({
				updateOne: {
					filter: { walletAddress: deployment.address.toLowerCase() },
					update: {
						$set: {
							deploymentTxHash: deployment.deploymentTxHash.toLowerCase() || '',
							deploymentCompleted: true,
							...(deployment.needsFundingUpdate && { fundingCompleted: true })
						}
					}
				}
			}))
			try {
				await WalletDeployment.bulkWrite(bulkOps)
			} catch {
				// Seeder will update retroactively if DB fails here
			}
		}

		// After successful deployments, handle pending fundings (deployments via EOA only)
		// Query for wallets that are deployed but have pending fundings
		const fundingQuery: QueryFilter & { fundingRequested: boolean; fundingCompleted: boolean } = {
			paymentCompleted: true,
			deploymentCompleted: true,
			fundingRequested: true,
			fundingCompleted: false,
			...(paymentTxHash ? { paymentTxHash: paymentTxHash.toLowerCase() } : {}),
			...(payerAddress ? { payerAddress: payerAddress.toLowerCase() } : {})
		}

		const pendingFundings = await WalletDeployment.find(fundingQuery)

		const successfulFundings: Array<{
			address: string
			fundingTxHash: string
			fundingAmount: string
		}> = []
		const failedFundings: Array<{ address: string; reason: string; fundingAmount?: string }> = []

		const relayerContract = new Contract(
			request.server.config.B402_RELAYER_ADDRESS,
			B402_RELAYER_ABI,
			signer
		)

		// Retry funding transfer using stored payment data (deployments via EOA only)
		// Note: Deployments via smart contract would have been funded already since it was atomic
		for (const funding of pendingFundings) {
			try {
				if (!funding.fundingPaymentData) {
					successfulFundings.push({
						address: funding.walletAddress,
						fundingTxHash: '', // Happened in UserOp
						fundingAmount: funding.fundingAmount || '0'
					})
					continue
				}

				const { token, authorization, signature } = funding.fundingPaymentData

				const fundingTx = await relayerContract.transferWithAuthorization(
					token,
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

				const fundingReceipt = await fundingTx.wait()
				const fundingTxHash = fundingReceipt?.hash || fundingTx.hash

				successfulFundings.push({
					address: funding.walletAddress,
					fundingTxHash,
					fundingAmount: authorization.value
				})
			} catch (error) {
				failedFundings.push({
					address: funding.walletAddress,
					fundingAmount: funding.fundingAmount,
					reason: error instanceof Error ? error.message : 'Funding execution failed'
				})
			}
		}

		// Batch update all successful fundings
		if (successfulFundings.length > 0) {
			const fundingBulkOps = successfulFundings.map((funding) => ({
				updateOne: {
					filter: { walletAddress: funding.address.toLowerCase() },
					update: {
						$set: {
							fundingTxHash: funding.fundingTxHash.toLowerCase() || '',
							fundingCompleted: true
						}
					}
				}
			}))
			try {
				await WalletDeployment.bulkWrite(fundingBulkOps)
			} catch {
				// Seeder will update retroactively if DB fails here
			}
		}

		const network = providerService.getNetwork()
		const response = {
			success: successfulDeployments.length > 0,
			deployments: {
				successful: successfulDeployments,
				failed: failedDeployments
			},
			funding: {
				successful: successfulFundings,
				failed: failedFundings
			},
			network
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
