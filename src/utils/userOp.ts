import { ethers } from 'ethers'

import { B402_RELAYER_ABI, SUPPORTED_TOKENS } from '../constants'
import { env } from '../schema/env'
import { BaseErrors } from '../schema/errors'
import type { BatchCall, UserOperationParams } from '../types/wallet'
import {
	getFactoryContract,
	getProvider,
	getTokenAllowance,
	getWalletNonce,
	isWalletDeployed
} from './wallet'

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

async function getInitCode(ownerAddress: string, salt = 0): Promise<string> {
	const factory = getFactoryContract()
	const factoryAddress = await factory.getAddress()

	const iface = new ethers.Interface([
		'function createAccount(address owner, uint256 salt) returns (address)'
	])

	const createAccountData = iface.encodeFunctionData('createAccount', [ownerAddress, salt])
	return factoryAddress + createAccountData.slice(2) // Remove '0x' from calldata
}

export async function createDeploymentUserOp(
	ownerAddress: string,
	salt = 0
): Promise<UserOperationParams> {
	const provider = getProvider()

	const factory = getFactoryContract()
	const walletAddress = await factory.getFunction('getAddress')(ownerAddress, salt)
	const initCode = await getInitCode(ownerAddress, salt)
	const callData = '0x'

	const feeData = await provider.getFeeData()
	const maxFeePerGas = feeData.maxFeePerGas || ethers.parseUnits('5', 'gwei')
	const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || ethers.parseUnits('1', 'gwei')

	const userOp: UserOperationParams = {
		sender: walletAddress,
		nonce: '0', // First nonce
		initCode,
		callData,
		callGasLimit: '100000',
		verificationGasLimit: '500000',
		preVerificationGas: '50000',
		maxFeePerGas: maxFeePerGas.toString(),
		maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
		paymasterAndData: '0x', // Will be filled by paymaster service
		signature: '0x' // Will be filled by user
	}

	return userOp
}

export async function createPaymentUserOpOrThrow(params: {
	walletAddress: string
	recipients: string[]
	amounts: string[] // in token units, e.g., "100" for 100 USDT
	token: string
	validAfter: number
	validBefore: number
	nonce: string
}): Promise<UserOperationParams> {
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

	// Verify wallet is deployed
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
	const feeAmount = ethers.parseUnits(env.WALLET_FEE_AMOUNT, tokenConfig.decimals)

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
	const maxFeePerGas = feeData.maxFeePerGas || ethers.parseUnits('5', 'gwei')
	const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || ethers.parseUnits('1', 'gwei')

	const userOp: UserOperationParams = {
		sender: walletAddress,
		nonce: nonce.toString(),
		initCode: '0x', // Wallet should be deployed already
		callData,
		callGasLimit: '300000', // Higher for batch execution
		verificationGasLimit: '500000',
		preVerificationGas: '50000',
		maxFeePerGas: maxFeePerGas.toString(),
		maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
		paymasterAndData: '0x', // Will be filled by paymaster service
		signature: '0x' // Will be filled by user
	}

	return userOp
}

export function validateFeeIncluded(userOp: UserOperationParams): boolean {
	try {
		const calls = decodeExecuteBatch(userOp.callData)
		const hasBatchTransferWithFee = calls.some((call) => {
			// Must be calling the relayer contract
			if (call.to.toLowerCase() !== env.B402_RELAYER_ADDRESS.toLowerCase()) {
				return false
			}

			try {
				const iface = new ethers.Interface(B402_RELAYER_ABI)
				const decoded = iface.decodeFunctionData('batchTransferWithUserOp', call.data)

				// batchTransferWithUserOp(token, recipients[], amounts[], validAfter, validBefore, nonce)
				// [0] = token, [1] = recipients array, [2] = amounts array
				const recipients = decoded[1] as string[]
				const amounts = decoded[2] as bigint[]

				// Check if fee recipient is in the recipients array
				const feeRecipientIndex = recipients.findIndex(
					(r) => r.toLowerCase() === env.WALLET_FEE_RECIPIENT.toLowerCase()
				)

				if (feeRecipientIndex === -1) return false

				// Check if fee amount is sufficient
				const feeAmount = amounts[feeRecipientIndex]
				const minFee = ethers.parseUnits('0.05', 18)
				return feeAmount >= minFee
			} catch {
				return false
			}
		})

		return hasBatchTransferWithFee
	} catch (error) {
		console.error('Error validating fee:', error)
		return false
	}
}

export async function submitUserOpToBundler(userOp: UserOperationParams): Promise<string> {
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

	if (!response.ok) {
		throw new BaseErrors.ERR_BUNDLER_REQUEST_FAILED()
	}

	const result = (await response.json()) as {
		error?: { message: string }
		result?: string
	}

	if (result.error) {
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
