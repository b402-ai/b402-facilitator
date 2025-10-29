import { Contract, Wallet, ethers } from 'ethers'
import type { FastifyReply, FastifyRequest } from 'fastify'

import { B402_ABI } from '../../constants'
import type {
	HealthResponse,
	SettleRequest,
	SettleResponse,
	VerifyRequest,
	VerifyResponse
} from '../../schema/b402'
import { BaseErrors, handleAndReturnErrorResponse } from '../../schema/errors'

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
		const { provider, chainId } = getProviderAndChainId(request.server.config)

		// Create relayer contract instance
		const relayer = new Contract(request.server.config.B402_RELAYER_ADDRESS, B402_ABI, provider)

		// Verify signature locally (EIP-712)
		const domain = {
			name: 'B402',
			version: '1',
			chainId: chainId,
			verifyingContract: paymentRequirements.relayerContract
		}

		const types = {
			TransferWithAuthorization: [
				{ name: 'from', type: 'address' },
				{ name: 'to', type: 'address' },
				{ name: 'value', type: 'uint256' },
				{ name: 'validAfter', type: 'uint256' },
				{ name: 'validBefore', type: 'uint256' },
				{ name: 'nonce', type: 'bytes32' }
			]
		}

		let recovered: string
		try {
			recovered = ethers.verifyTypedData(domain, types, authorization, signature)
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

		// Get provider and chain ID
		const { provider } = getProviderAndChainId(request.server.config)

		// Create wallet and relayer contract
		const relayerWallet = new Wallet(request.server.config.RELAYER_PRIVATE_KEY)
		const signer = relayerWallet.connect(provider)
		const relayer = new Contract(request.server.config.B402_RELAYER_ADDRESS, B402_ABI, signer)

		// Split signature
		let sig: ethers.Signature
		try {
			sig = ethers.Signature.from(signature)
		} catch (error) {
			throw new BaseErrors.ERR_INVALID_SIGNATURE()
		}

		// Execute transferWithAuthorization
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
				sig.v,
				sig.r,
				sig.s,
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
		const { network } = getProviderAndChainId(request.server.config)

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

// --- Helper functions ---

/**
 * Get provider and chain ID based on environment configuration
 *
 * @param config
 * @returns
 */
function getProviderAndChainId(config: {
	NETWORK: string
	BSC_RPC_URL: string
	BSC_TESTNET_RPC_URL: string
}) {
	const envNetwork = config.NETWORK || 'testnet'
	const chainId = envNetwork === 'mainnet' ? 56 : 97

	const rpcUrl = envNetwork === 'mainnet' ? config.BSC_RPC_URL : config.BSC_TESTNET_RPC_URL

	const provider = new ethers.JsonRpcProvider(rpcUrl)

	return { provider, chainId, network: envNetwork }
}
