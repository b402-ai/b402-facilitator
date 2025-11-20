import { ethers } from 'ethers'

import { B402_RELAYER_ABI, SUPPORTED_TOKENS } from '../constants'
import type { UserOperation } from '../schema/b402'
import { env } from '../schema/env'
import { BaseErrors } from '../schema/errors'
import type { BatchCall } from '../types/wallet'
import { getProvider, getTokenAllowance, getWalletNonce, isWalletDeployed } from './wallet'

const SIMPLE_ACCOUNT_ABI = [
	'function execute(address dest, uint256 value, bytes calldata func)',
	'function executeBatch(address[] calldata dest, uint256[] calldata value, bytes[] calldata func)',
	'function getNonce() view returns (uint256)'
]

const ERC20_ABI = [
	'function approve(address spender, uint256 amount) returns (bool)',
	'function transfer(address to, uint256 amount) returns (bool)',
	'function allowance(address owner, address spender) view returns (uint256)'
]

function encodeApprove(spender: string, amount: bigint): string {
	const iface = new ethers.Interface(ERC20_ABI)
	return iface.encodeFunctionData('approve', [spender, amount])
}

function encodeExecuteBatch(calls: BatchCall[]): string {
	const iface = new ethers.Interface(SIMPLE_ACCOUNT_ABI)
	const dests = calls.map((c) => c.to)
	const values = calls.map((c) => c.value)
	const funcs = calls.map((c) => c.data)

	return iface.encodeFunctionData('executeBatch', [dests, values, funcs])
}

export function decodeExecuteBatch(callData: string): BatchCall[] {
	const iface = new ethers.Interface(SIMPLE_ACCOUNT_ABI)
	const decoded = iface.decodeFunctionData('executeBatch', callData)

	const dests = decoded[0] as string[]
	const values = decoded[1] as bigint[]
	const funcs = decoded[2] as string[]

	return dests.map((to, i) => ({
		to,
		value: values[i].toString(),
		data: funcs[i]
	}))
}

export async function createPaymentUserOpOrThrow(params: {
	walletAddress: string
	recipients: string[]
	amounts: string[] // in token units, e.g., "100" for 100 USDT
	token: string
	validAfter: number
	validBefore: number
	nonce: string
}): Promise<UserOperation> {
	const {
		walletAddress,
		recipients,
		amounts,
		token,
		validAfter,
		validBefore,
		nonce: relayerNonce
	} = params

	// Validate wallet address
	if (!ethers.isAddress(walletAddress)) {
		throw new BaseErrors.ERR_INVALID_ADDRESS()
	}

	// Validate wallet is deployed
	const deployed = await isWalletDeployed(walletAddress)
	if (!deployed) {
		throw new BaseErrors.ERR_WALLET_NOT_DEPLOYED()
	}

	// Validate arrays
	if (recipients.length !== amounts.length) {
		throw new BaseErrors.ERR_ARRAY_LENGTH_MISMATCH()
	}
	if (recipients.length === 0) {
		throw new BaseErrors.ERR_RECIPIENT_REQUIRED()
	}
	if (recipients.length > 20) {
		throw new BaseErrors.ERR_TOO_MANY_TRANSACTIONS()
	}

	// Validate token address
	if (!ethers.isAddress(token)) {
		throw new BaseErrors.ERR_INVALID_ADDRESS()
	}

	// Verify token is supported
	const tokenConfig = Object.values(SUPPORTED_TOKENS).find(
		(t) => t.address.toLowerCase() === token.toLowerCase()
	)
	if (!tokenConfig) {
		throw new BaseErrors.ERR_UNSUPPORTED_TOKEN()
	}

	// Validate recipient addresses and amounts
	for (let i = 0; i < recipients.length; i++) {
		if (!ethers.isAddress(recipients[i])) {
			throw new BaseErrors.ERR_INVALID_RECIPIENT_ADDRESS()
		}
		if (recipients[i] === ethers.ZeroAddress) {
			throw new BaseErrors.ERR_ZERO_ADDRESS_RECIPIENT()
		}
		try {
			const amountBigInt = ethers.parseUnits(amounts[i], tokenConfig.decimals)
			if (amountBigInt <= 0n) {
				throw new BaseErrors.ERR_INVALID_AMOUNT()
			}
		} catch (error) {
			throw new BaseErrors.ERR_INVALID_AMOUNT()
		}
	}

	const provider = getProvider()

	// Parse all payment amounts and calculate total
	const paymentAmounts = amounts.map((amt) => ethers.parseUnits(amt, tokenConfig.decimals))
	const totalPaymentAmount = paymentAmounts.reduce((sum, amt) => sum + amt, 0n)

	// Add b402 fee
	const feeAmount = ethers.parseUnits(env.WALLET_PAYMENT_FEE, tokenConfig.decimals)

	// Calculate total amount needed for this transaction (all payments + fee)
	const totalAmountNeeded = totalPaymentAmount + feeAmount

	// Check if we need to approve B402Relayer for this transaction
	const currentAllowance = await getTokenAllowance(walletAddress, token)
	const needsApproval = BigInt(currentAllowance) < totalAmountNeeded

	// Build batch calls
	const calls: BatchCall[] = []

	if (needsApproval) {
		const approveData = encodeApprove(env.B402_RELAYER_ADDRESS, totalAmountNeeded)
		calls.push({
			to: token,
			value: '0',
			data: approveData
		})
	}

	const relayerIface = new ethers.Interface(B402_RELAYER_ABI)
	const allRecipients = [...recipients, env.WALLET_FEE_RECIPIENT]
	const allAmounts = [...paymentAmounts, feeAmount]

	const batchTransferData = relayerIface.encodeFunctionData('batchTransferWithUserOp', [
		token,
		allRecipients,
		allAmounts,
		validAfter,
		validBefore,
		relayerNonce
	])
	calls.push({
		to: env.B402_RELAYER_ADDRESS,
		value: '0',
		data: batchTransferData
	})

	const callData = encodeExecuteBatch(calls)
	const nonce = await getWalletNonce(walletAddress)

	const feeData = await provider.getFeeData()
	const baseGasPrice = feeData.gasPrice || ethers.parseUnits('0.1', 'gwei')
	const maxFeePerGas = (baseGasPrice * 12n) / 10n
	const maxPriorityFeePerGas = ethers.parseUnits('0.4', 'gwei')

	const userOp: UserOperation = {
		sender: walletAddress,
		nonce: ethers.toBeHex(nonce),
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
		signature: '0x' // Will be filled by user
	}

	return userOp
}

export function validateFeeIncluded(userOp: UserOperation): boolean {
	try {
		const calls = decodeExecuteBatch(userOp.callData)
		const hasBatchTransferWithFee = calls.some((call) => {
			if (call.to.toLowerCase() !== env.B402_RELAYER_ADDRESS.toLowerCase()) {
				return false
			}

			try {
				const iface = new ethers.Interface(B402_RELAYER_ABI)
				const decoded = iface.decodeFunctionData('batchTransferWithUserOp', call.data)

				// [0] = token, [1] = recipients array, [2] = amounts array
				const token = decoded[0] as string
				const recipients = decoded[1] as string[]
				const amounts = decoded[2] as bigint[]

				const feeRecipientIndex = recipients.findIndex(
					(r) => r.toLowerCase() === env.WALLET_FEE_RECIPIENT.toLowerCase()
				)
				if (feeRecipientIndex === -1) return false

				// Get token decimals
				const tokenConfig = Object.values(SUPPORTED_TOKENS).find(
					(t) => t.address.toLowerCase() === token.toLowerCase()
				)
				if (!tokenConfig) return false

				const feeAmount = amounts[feeRecipientIndex]
				const expectedFee = ethers.parseUnits(env.WALLET_PAYMENT_FEE, tokenConfig.decimals)
				return feeAmount === expectedFee
			} catch {
				return false
			}
		})

		return hasBatchTransferWithFee
	} catch (error) {
		console.log('Error validating fee:', error)
		return false
	}
}

// TODO: Consider using gas estimation after building a valid UserOp to refine the final estimate
export async function estimateUserOpGas(userOp: UserOperation): Promise<{
	callGasLimit: string
	verificationGasLimit: string
	preVerificationGas: string
}> {
	const response = await fetch(env.BUNDLER_RPC_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'eth_estimateUserOperationGas',
			params: [userOp, env.ENTRY_POINT_ADDRESS]
		})
	})

	const responseText = await response.text()

	if (!response.ok) {
		console.log('Gas estimation failed with status:', response.status)
		console.log('Response text:', responseText)
		throw new BaseErrors.ERR_GAS_ESTIMATION_FAILED()
	}

	let result: {
		error?: { message: string; data?: unknown }
		result?: {
			callGasLimit: string
			verificationGasLimit: string
			preVerificationGas: string
		}
	}

	try {
		result = JSON.parse(responseText)
	} catch (error) {
		console.log('Failed to parse gas estimation response as JSON')
		console.log('Response text:', responseText.substring(0, 500))
		throw new BaseErrors.ERR_GAS_ESTIMATION_PARSE_FAILED()
	}

	if (result.error) {
		console.log('Gas estimation returned error:', JSON.stringify(result.error, null, 2))
		throw new BaseErrors.ERR_GAS_ESTIMATION_ERROR()
	}

	if (!result.result) {
		throw new BaseErrors.ERR_GAS_ESTIMATION_NO_RESULT()
	}

	return result.result
}

export async function submitUserOpToBundler(userOp: UserOperation): Promise<string> {
	const response = await fetch(env.BUNDLER_RPC_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'eth_sendUserOperation',
			params: [userOp, env.ENTRY_POINT_ADDRESS]
		})
	})

	const responseText = await response.text()

	if (!response.ok) {
		console.log('Bundler request failed with status:', response.status)
		console.log('Response text:', responseText)
		throw new BaseErrors.ERR_BUNDLER_REQUEST_FAILED()
	}

	let result: {
		error?: { message: string; data?: unknown }
		result?: string
	}

	try {
		result = JSON.parse(responseText)
	} catch (error) {
		console.log('Failed to parse bundler response as JSON')
		console.log('Response text:', responseText.substring(0, 500))
		throw new BaseErrors.ERR_BUNDLER_REQUEST_FAILED()
	}

	if (result.error) {
		console.log('Bundler returned error:', JSON.stringify(result.error, null, 2))
		console.log('UserOp that failed:', JSON.stringify(userOp, null, 2))
		throw new BaseErrors.ERR_BUNDLER_ERROR()
	}

	return result.result as string
}

export async function getUserOpReceipt(userOpHash: string): Promise<{
	success: boolean
	txHash: string
	blockNumber: number
}> {
	const response = await fetch(env.BUNDLER_RPC_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'eth_getUserOperationReceipt',
			params: [userOpHash]
		})
	})

	if (!response.ok) {
		throw new BaseErrors.ERR_BUNDLER_REQUEST_FAILED()
	}

	const result = (await response.json()) as {
		error?: { message: string }
		result?: {
			success: boolean
			receipt: {
				transactionHash: string
				blockNumber: number
			}
		}
	}

	if (result.error) {
		throw new BaseErrors.ERR_BUNDLER_ERROR()
	}

	const receipt = result.result
	if (!receipt) {
		throw new BaseErrors.ERR_NO_RECEIPT()
	}

	return {
		success: receipt.success,
		txHash: receipt.receipt.transactionHash,
		blockNumber: receipt.receipt.blockNumber
	}
}
