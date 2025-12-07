import { ethers } from 'ethers'

import { B402_RELAYER_ABI, SUPPORTED_TOKENS } from '../constants'
import type { UserOperation } from '../schema/b402'
import { env } from '../schema/env'
import { BaseErrors } from '../schema/errors'
import type { BatchCall } from '../types/wallet'
import { getProvider, getTokenAllowance, getWalletNonce, isWalletDeployed } from './wallet'

// ERC-7579 Nexus account ABI
const NEXUS_ACCOUNT_ABI = [
	'function execute(bytes32 mode, bytes calldata executionCalldata)',
	'function executeFromExecutor(bytes32 mode, bytes calldata executionCalldata) returns (bytes[] memory returnData)'
]

// ERC-7579 Mode encoding constants
// Mode: bytes32 = [1 byte callType][1 byte execType][4 bytes unused][4 bytes modeSelector][22 bytes modePayload]
const CALLTYPE_SINGLE = '0x00'
const CALLTYPE_BATCH = '0x01'
const EXECTYPE_DEFAULT = '0x00'
// const EXECTYPE_TRY = '0x01' // Not used currently

const ERC20_ABI = [
	'function approve(address spender, uint256 amount) returns (bool)',
	'function transfer(address to, uint256 amount) returns (bool)',
	'function allowance(address owner, address spender) view returns (uint256)'
]

function encodeApprove(spender: string, amount: bigint): string {
	const iface = new ethers.Interface(ERC20_ABI)
	return iface.encodeFunctionData('approve', [spender, amount])
}

function buildERC7579Mode(callType: string, execType: string = EXECTYPE_DEFAULT): string {
	const callTypeByte = callType.slice(2) // Remove '0x' -> '00' or '01'
	const execTypeByte = execType.slice(2) // Remove '0x' -> '00' or '01'

	// callType(1) + execType(1) + unused(4) + selector(4) + payload(22) = 32 bytes
	return '0x' + callTypeByte + execTypeByte + '00'.repeat(30)
}

function encodeBatchExecutionData(calls: BatchCall[]): string {
	// Each execution is a tuple: (address, uint256, bytes)
	const executions = calls.map((c) => ({
		target: c.to,
		value: BigInt(c.value),
		callData: c.data
	}))

	return ethers.AbiCoder.defaultAbiCoder().encode(
		['tuple(address target, uint256 value, bytes callData)[]'],
		[executions]
	)
}

export function encodeExecuteBatch(calls: BatchCall[]): string {
	const iface = new ethers.Interface(NEXUS_ACCOUNT_ABI)

	if (calls.length === 1) {
		// Single call mode
		const mode = buildERC7579Mode(CALLTYPE_SINGLE)
		// For single execution: abi.encodePacked(target, value, callData)
		const executionData = ethers.solidityPacked(
			['address', 'uint256', 'bytes'],
			[calls[0].to, BigInt(calls[0].value), calls[0].data]
		)
		return iface.encodeFunctionData('execute', [mode, executionData])
	} else {
		// Batch call mode
		const mode = buildERC7579Mode(CALLTYPE_BATCH)
		const executionData = encodeBatchExecutionData(calls)
		return iface.encodeFunctionData('execute', [mode, executionData])
	}
}

export function decodeExecuteBatch(callData: string): BatchCall[] {
	const iface = new ethers.Interface(NEXUS_ACCOUNT_ABI)
	const decoded = iface.decodeFunctionData('execute', callData)

	const mode = decoded[0] as string
	const executionData = decoded[1] as string

	const callType = mode.slice(0, 4) // '0x00' or '0x01'

	if (callType === '0x00') {
		// Single call
		// abi.encodePacked(target, value, callData) = 20 bytes + 32 bytes + variable
		const target = '0x' + executionData.slice(2, 42)
		const value = BigInt('0x' + executionData.slice(42, 106))
		const data = '0x' + executionData.slice(106)

		return [
			{
				to: ethers.getAddress(target),
				value: value.toString(),
				data
			}
		]
	} else {
		// Batch call
		const [executions] = ethers.AbiCoder.defaultAbiCoder().decode(
			['tuple(address target, uint256 value, bytes callData)[]'],
			executionData
		)

		return executions.map((exec: { target: string; value: bigint; callData: string }) => ({
			to: exec.target,
			value: exec.value.toString(),
			data: exec.callData
		}))
	}
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
