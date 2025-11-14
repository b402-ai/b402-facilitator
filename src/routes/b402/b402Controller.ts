import { Contract, Wallet, ethers } from 'ethers'
import type { FastifyReply, FastifyRequest } from 'fastify'

import { B402_RELAYER_ABI, SUPPORTED_TOKENS } from '../../constants'
import type {
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
import { getTokenBalance } from '../../utils/wallet'

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
		const feeAmount = ethers.parseUnits(env.WALLET_FEE_AMOUNT, tokenConfig.decimals)
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
