import { ethers } from 'ethers'

import { B402_RELAYER_ABI, SUPPORTED_TOKENS } from '../constants'
import type { UserOperation } from '../schema/b402'
import { env } from '../schema/env'
import { BaseErrors } from '../schema/errors'
import type { BatchCall } from '../types/wallet'
import { getProviderService } from './provider'
import { getTokenAllowance, getWalletNonce, isWalletDeployed } from './wallet'

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

	const provider = getProviderService().getProvider()

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

// ─── In-process bundler ─────────────────────────────────────────────────
// We skip the external bundler service. The facilitator has already built
// + signed the UserOp and the paymaster is already deposited into EntryPoint.
// All we need is `entryPoint.handleOps([userOp], beneficiary)` — one tx,
// relayer pays gas up-front, paymaster refunds from its EntryPoint deposit.

// EntryPoint v0.7 (0x0000000071727De22E5E9d8BAf0edAc6f37da032) ABI subset
// PackedUserOperation is what handleOps takes in v0.7 (packed form)
const ENTRYPOINT_ABI = [
	'function handleOps((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] calldata ops, address payable beneficiary) external',
	'function getUserOpHash((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) calldata userOp) external view returns (bytes32)',
	'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)'
]

/**
 * Pack a UserOperation from the JSON-RPC format into the EntryPoint v0.7
 * packed form. The RPC form has separate fields for call/verification gas
 * and max-fee/priority-fee; handleOps expects them concatenated into bytes32.
 */
function packUserOp(userOp: UserOperation) {
	const toBN = (v: string | number | bigint) => BigInt(v)
	const pack2x16 = (hi: bigint, lo: bigint): string => {
		// each uint128, high 16 bytes | low 16 bytes → bytes32
		const hiHex = hi.toString(16).padStart(32, '0')
		const loHex = lo.toString(16).padStart(32, '0')
		return '0x' + hiHex + loHex
	}
	const accountGasLimits = pack2x16(toBN(userOp.verificationGasLimit), toBN(userOp.callGasLimit))
	const gasFees = pack2x16(toBN(userOp.maxPriorityFeePerGas), toBN(userOp.maxFeePerGas))

	// v0.7: initCode = factory (20 bytes) + factoryData (must include function selector).
	// walletIncognitoVerify already encodes factoryData as a full createAccount(...) call.
	const initCode = userOp.factory
		? ethers.concat([userOp.factory, userOp.factoryData || '0x'])
		: '0x'

	// v0.7: paymasterAndData = paymaster(20) + vgl(16) + postOpGas(16) + data
	let paymasterAndData: string = '0x'
	if (userOp.paymaster && userOp.paymaster !== '0x') {
		const vgl = toBN(userOp.paymasterVerificationGasLimit || '0')
		const postOp = toBN(userOp.paymasterPostOpGasLimit || '0')
		paymasterAndData = ethers.concat([
			userOp.paymaster,
			ethers.zeroPadValue(ethers.toBeHex(vgl), 16),
			ethers.zeroPadValue(ethers.toBeHex(postOp), 16),
			userOp.paymasterData || '0x'
		])
	}

	return {
		sender: userOp.sender,
		nonce: toBN(userOp.nonce),
		initCode,
		callData: userOp.callData,
		accountGasLimits,
		preVerificationGas: toBN(userOp.preVerificationGas),
		gasFees,
		paymasterAndData,
		signature: userOp.signature
	}
}

// TODO: Consider using gas estimation after building a valid UserOp to refine the final estimate
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function estimateUserOpGas(_userOp: UserOperation): Promise<{
	callGasLimit: string
	verificationGasLimit: string
	preVerificationGas: string
}> {
	// We build a deterministic UserOp internally — simulation via EntryPoint.simulateHandleOp
	// is expensive and unreliable. Return conservative fixed defaults; EntryPoint will refund
	// unused gas to the paymaster deposit.
	return {
		callGasLimit: '0x100000', // 1,048,576
		verificationGasLimit: '0x100000',
		preVerificationGas: '0x15F90' // 90,000
	}
}

// UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)
const USER_OPERATION_EVENT_TOPIC =
	'0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f'

/**
 * Receipt cache populated by submitUserOpToBundler from tx.wait()'s logs.
 * Avoids redundant log queries in getUserOpReceipt for the common case.
 * Entries are pruned after 5 min to prevent unbounded growth.
 */
interface CachedReceipt {
	success: boolean
	txHash: string
	blockNumber: number
	cachedAt: number
}
const receiptCache = new Map<string, CachedReceipt>()
const RECEIPT_TTL_MS = 5 * 60 * 1000
// FAST SETTLE: return the moment handleOps is BROADCAST (tx.hash final) instead of waiting for it to MINE.
// On Ethereum mainnet mining is ~12–50s — intolerable UX. verify() already simulated the UserOp, so a
// post-broadcast revert is rare; the receipt is still confirmed in the background. Off => old blocking behavior.
const SETTLE_RETURN_ON_BROADCAST = process.env.SETTLE_RETURN_ON_BROADCAST === 'true'

function pruneReceiptCache(): void {
	const now = Date.now()
	for (const [k, v] of receiptCache) {
		if (now - v.cachedAt > RECEIPT_TTL_MS) receiptCache.delete(k)
	}
}

/**
 * Parse the EntryPoint UserOperationEvent matching `userOpHash` out of a tx
 * receipt's logs. Returns null if not found (e.g. UserOp reverted inside
 * handleOps — EntryPoint still emits, but caller may want to handle success=false).
 */
function parseUserOpEventFromReceipt(
	receipt: ethers.TransactionReceipt,
	userOpHash: string
): CachedReceipt | null {
	const target = userOpHash.toLowerCase()
	for (const log of receipt.logs) {
		if (log.topics.length < 4) continue
		if (log.topics[0].toLowerCase() !== USER_OPERATION_EVENT_TOPIC) continue
		if (log.topics[1].toLowerCase() !== target) continue
		// data = abi.encode(uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)
		// success is the 2nd 32-byte word
		const data = log.data.slice(2)
		const successWord = data.slice(64, 128)
		const success = BigInt('0x' + successWord) === 1n
		return {
			success,
			txHash: log.transactionHash,
			blockNumber: log.blockNumber,
			cachedAt: Date.now()
		}
	}
	return null
}

// Serialize ONLY the nonce-allocation + broadcast of handleOps from this instance
// so two concurrent requests can never grab the same relayer nonce. The receipt is
// awaited OUTSIDE this lock, so many handleOps txs are in-flight at once — throughput
// is not serialized (each op just gets a distinct, monotonic nonce). Cross-instance
// races on a shared relayer EOA are additionally absorbed by the pending-nonce
// refetch + fee-bump retry below.
let _relayerChain: Promise<unknown> = Promise.resolve()
function withRelayerLock<T>(fn: () => Promise<T>): Promise<T> {
	const next = _relayerChain.then(fn, fn)
	_relayerChain = next.then(
		() => undefined,
		() => undefined
	)
	return next as Promise<T>
}

const _isTransientNonceError = (msg: string): boolean =>
	/nonce too low|replacement (transaction )?underpriced|replacement fee too low|already known|fee too low|known transaction/i.test(
		msg
	)

export async function submitUserOpToBundler(userOp: UserOperation): Promise<string> {
	const providerService = getProviderService()
	const provider = providerService.getProvider()
	const relayer = new ethers.Wallet(env.RELAYER_PRIVATE_KEY, provider)
	const entryPoint = new ethers.Contract(env.ENTRY_POINT_ADDRESS, ENTRYPOINT_ABI, relayer)

	const packed = packUserOp(userOp)

	// Compute userOpHash off-chain via EntryPoint view call (cheap, no gas)
	let userOpHash: string
	try {
		userOpHash = (await entryPoint.getUserOpHash(packed)) as string
	} catch (err) {
		console.log('getUserOpHash failed:', (err as Error).message)
		throw new BaseErrors.ERR_BUNDLER_ERROR()
	}

	// Broadcast handleOps with an EXPLICIT, freshly-fetched pending nonce and (on
	// retry) bumped EIP-1559 fees. Serialized per instance; retried on nonce/fee
	// collisions. Returns once the tx is broadcast — NOT after it mines.
	const MAX_ATTEMPTS = 5
	let tx: ethers.TransactionResponse
	try {
		tx = await withRelayerLock(async () => {
			for (let attempt = 0; ; attempt++) {
				// Fresh pending nonce every attempt — correct even when the relayer EOA
				// is shared across instances (in-memory nonce tracking would be wrong).
				const nonce = await provider.getTransactionCount(relayer.address, 'pending')
				let overrides: ethers.Overrides = { nonce }
				if (attempt > 0) {
					// Re-price so a replacement clears the prior fee (bump 40%/attempt).
					const fee = await provider.getFeeData()
					const b = BigInt(100 + 40 * attempt)
					let maxFee = ((fee.maxFeePerGas ?? fee.gasPrice ?? 1_000_000n) * b) / 100n
					let prio = ((fee.maxPriorityFeePerGas ?? fee.gasPrice ?? 1_000_000n) * b) / 100n
					if (prio > maxFee) prio = maxFee // EIP-1559 invariant
					overrides = { nonce, maxFeePerGas: maxFee, maxPriorityFeePerGas: prio }
				}
				try {
					console.log(
						`[bundler] submit userOpHash=${userOpHash} sender=${userOp.sender} relayerNonce=${nonce} attempt=${attempt}`
					)
					return await entryPoint.handleOps([packed], relayer.address, overrides)
				} catch (err) {
					const msg = (err as Error).message || ''
					if (attempt < MAX_ATTEMPTS - 1 && _isTransientNonceError(msg)) {
						console.log(`[bundler] transient submit error (attempt ${attempt}), retrying: ${msg}`)
						await new Promise((r) => setTimeout(r, 250 * (attempt + 1)))
						continue
					}
					throw err
				}
			}
		})
	} catch (err) {
		console.log('handleOps submit failed:', (err as Error).message)
		console.log('UserOp that failed:', JSON.stringify(userOp, null, 2))
		throw new BaseErrors.ERR_BUNDLER_ERROR()
	}

	// tx is BROADCAST here; tx.hash is final. Confirming (tx.wait) is the slow part on mainnet.
	console.log(`[bundler] handleOps tx submitted: ${tx.hash}`)
	// Wait for the receipt, parse the UserOpEvent, cache the REAL success/blockNumber.
	const confirm = async (): Promise<void> => {
		const receipt = await tx.wait()
		console.log(
			`[bundler] receipt: status=${receipt?.status}, logs=${receipt?.logs?.length ?? 0}, blockNumber=${receipt?.blockNumber}`
		)
		if (receipt) {
			const parsed = parseUserOpEventFromReceipt(receipt, userOpHash)
			console.log(
				`[bundler] parsed UserOpEvent for our hash: ${parsed ? `success=${parsed.success} txHash=${parsed.txHash}` : 'NOT FOUND IN RECEIPT'}`
			)
			if (parsed) {
				pruneReceiptCache()
				receiptCache.set(userOpHash.toLowerCase(), parsed)
			}
		}
	}

	if (SETTLE_RETURN_ON_BROADCAST) {
		// Cache the txHash optimistically so getUserOpReceipt returns it NOW; confirm in the background.
		pruneReceiptCache()
		receiptCache.set(userOpHash.toLowerCase(), { success: true, txHash: tx.hash, blockNumber: 0, cachedAt: Date.now() })
		void confirm().catch((err) => console.log('[bundler] background confirm failed:', (err as Error).message))
		return userOpHash
	}

	try {
		await confirm()
	} catch (err) {
		console.log('handleOps wait failed:', (err as Error).message)
		throw new BaseErrors.ERR_BUNDLER_ERROR()
	}

	return userOpHash
}

/**
 * Return the receipt for a UserOp. Reads the cache populated by
 * submitUserOpToBundler (instant, no RPC). Falls back to a short log query
 * only if the cache was missed (e.g. process restarted between submit + receipt).
 */
/**
 * Decode the UserOperationRevertReason event for a given userOp inside a tx
 * and return a human-readable reason. Falls back to the raw hex if it can't
 * decode the inner revert.
 */
export async function fetchUserOpRevertReason(txHash: string, userOpHash: string): Promise<string> {
	const REVERT_TOPIC = '0x1c4fada7374c0a9ee8841fc38afe82932dc0f8e69012e927f061a8bae611a201'
	const provider = getProviderService().getProvider()
	const receipt = await provider.getTransactionReceipt(txHash)
	if (!receipt) return 'UserOp reverted (no receipt available)'
	const target = userOpHash.toLowerCase()
	for (const log of receipt.logs) {
		if (log.topics[0]?.toLowerCase() !== REVERT_TOPIC) continue
		if (log.topics[1]?.toLowerCase() !== target) continue
		// data: nonce(32) + offset(32) + len(32) + revertReason(padded)
		const data = log.data.slice(2)
		const offset = parseInt(data.slice(64, 128), 16)
		const lenAt = offset * 2
		const len = parseInt(data.slice(lenAt, lenAt + 64), 16)
		const inner = '0x' + data.slice(lenAt + 64, lenAt + 64 + len * 2)
		// Try Error(string)
		if (inner.startsWith('0x08c379a0')) {
			try {
				const [msg] = ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + inner.slice(10))
				return `UserOp reverted: ${msg as string}`
			} catch {
				// fall through to next decoder
			}
		}
		// Try CallFailed(uint256,bytes)
		if (inner.startsWith('0x5c0dee5d')) {
			try {
				const [idx, innerBytes] = ethers.AbiCoder.defaultAbiCoder().decode(
					['uint256', 'bytes'],
					'0x' + inner.slice(10)
				)
				const detail = (innerBytes as string) === '0x' ? '(empty revert)' : (innerBytes as string)
				return `CallFailed at index ${idx.toString()}: ${detail}`
			} catch {
				// fall through to next decoder
			}
		}
		return `UserOp reverted with raw data: ${inner}`
	}
	return 'UserOp reverted (no UserOperationRevertReason log found)'
}

/**
 * Poll for a successful UserOp receipt, checking FIRST then sleeping briefly. The old loops
 * slept 1.5-2s BEFORE the first check (a guaranteed latency floor even when the op landed in
 * ~1s) and polled coarsely. This checks immediately and polls every `intervalMs` until
 * `timeoutMs`, returning the receipt on success or `null` on timeout (call sites keep their
 * own throw/continue semantics). Combined with the 500ms provider pollingInterval this is the
 * core settle-latency fix.
 */
export async function waitForUserOpReceipt(
	userOpHash: string,
	opts: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<{ success: boolean; txHash: string; blockNumber: number } | null> {
	const intervalMs = opts.intervalMs ?? 600
	const timeoutMs = opts.timeoutMs ?? 60_000
	const deadline = Date.now() + timeoutMs
	for (;;) {
		try {
			const receipt = await getUserOpReceipt(userOpHash)
			if (receipt.success) return receipt
		} catch {
			// receipt not available yet — keep polling
		}
		if (Date.now() >= deadline) return null
		await new Promise((r) => setTimeout(r, intervalMs))
	}
}

export async function getUserOpReceipt(userOpHash: string): Promise<{
	success: boolean
	txHash: string
	blockNumber: number
}> {
	const cached = receiptCache.get(userOpHash.toLowerCase())
	if (cached) {
		return { success: cached.success, txHash: cached.txHash, blockNumber: cached.blockNumber }
	}

	// Fallback: process restarted between submit and receipt — scan a small
	// window (not 500 blocks; on L2s handleOps was awaited so the event is
	// within the most recent few blocks).
	const providerService = getProviderService()
	const provider = providerService.getProvider()
	const entryPoint = new ethers.Contract(env.ENTRY_POINT_ADDRESS, ENTRYPOINT_ABI, provider)
	const filter = entryPoint.filters.UserOperationEvent(userOpHash)
	const latest = await provider.getBlockNumber()
	const fromBlock = Math.max(0, latest - 20)
	const events = await entryPoint.queryFilter(filter, fromBlock, latest)

	if (events.length === 0) {
		throw new BaseErrors.ERR_NO_RECEIPT()
	}
	const log = events[events.length - 1] as ethers.EventLog
	return {
		success: Boolean(log.args?.success),
		txHash: log.transactionHash,
		blockNumber: log.blockNumber
	}
}
