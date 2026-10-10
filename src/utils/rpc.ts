import type { ethers } from 'ethers'

/**
 * Bounded, fail-over RPC calls for the settle path.
 *
 * Why not ethers' defaults: a JsonRpcProvider request waits up to 300s (FetchRequest
 * timeout) and silently retries HTTP 429 up to 12 times with exponential backoff
 * (250ms * rand(2^attempt)) — a throttled or stalled endpoint turns one call into
 * many seconds with nothing in the logs. Every call here is raced against a short
 * timeout and, when it times out or the endpoint fails at the transport level, the
 * same call is made on the next endpoint (RPC_URL_FALLBACK when configured,
 * otherwise one fresh retry on RPC_URL).
 *
 * Why not ethers.FallbackProvider: it reads `getTransactionCount('pending')` from
 * whichever backend answers and has no per-call deadline when every backend stalls.
 * An explicit, ordered race keeps the relayer nonce source deterministic and lets
 * us log which endpoint served each step and how long it took.
 */

/** The provider surface the settle path uses (a JsonRpcProvider satisfies it; tests pass fakes). */
export interface RpcClient {
	getTransactionCount(address: string, blockTag?: string): Promise<number>
	estimateGas(tx: ethers.TransactionRequest): Promise<bigint>
	getFeeData(): Promise<ethers.FeeData>
	send(method: string, params: unknown[]): Promise<unknown>
	call(tx: ethers.TransactionRequest): Promise<string>
	getTransaction(hash: string): Promise<ethers.TransactionResponse | null>
	getTransactionReceipt(hash: string): Promise<ethers.TransactionReceipt | null>
}

export interface RpcEndpoint {
	name: string
	client: RpcClient
}

export const DEFAULT_RPC_TIMEOUT_MS = (() => {
	const v = Number(process.env.RPC_CALL_TIMEOUT_MS)
	return Number.isFinite(v) && v > 0 ? v : 3500
})()

export class RpcTimeoutError extends Error {
	readonly code = 'RPC_TIMEOUT'
	constructor(label: string, ms: number) {
		super(`${label} timed out after ${ms}ms`)
	}
}

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new RpcTimeoutError(label, ms)), ms)
	})
	return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

/** All the text an ethers/JSON-RPC error carries, for pattern matching. */
export function errorText(err: unknown): string {
	const e = err as {
		code?: unknown
		shortMessage?: unknown
		message?: unknown
		info?: { error?: { message?: unknown } }
		error?: { message?: unknown }
	}
	return [e?.code, e?.shortMessage, e?.message, e?.info?.error?.message, e?.error?.message]
		.filter((x) => x != null)
		.map(String)
		.join(' | ')
}

// The node answered and the answer is about the transaction itself: another
// endpoint would say the same thing, so these are never failed over.
const DETERMINISTIC_CODES = new Set([
	'CALL_EXCEPTION',
	'INSUFFICIENT_FUNDS',
	'NONCE_EXPIRED',
	'REPLACEMENT_UNDERPRICED',
	'TRANSACTION_REPLACED',
	'INVALID_ARGUMENT',
	'ACTION_REJECTED'
])
const DETERMINISTIC_TEXT =
	/execution reverted|revert|nonce too low|nonce has already been used|underpriced|fee too low|max fee per gas less than block base fee|insufficient funds|intrinsic gas too low|exceeds block gas limit/i

export function isFailoverable(err: unknown): boolean {
	const code = (err as { code?: unknown })?.code
	if (typeof code === 'string' && DETERMINISTIC_CODES.has(code)) return false
	return !DETERMINISTIC_TEXT.test(errorText(err))
}

export interface RpcResult<T> {
	value: T
	endpoint: string
	ms: number
}

/**
 * Run `fn` against the endpoints in order, each bounded by `timeoutMs`. Moves to the
 * next endpoint only on timeout/transport failure; deterministic node answers
 * (revert, nonce too low, underpriced…) are thrown immediately. With a single
 * endpoint, it gets one fresh retry.
 */
export async function rpcCall<T>(
	endpoints: RpcEndpoint[],
	label: string,
	fn: (client: RpcClient) => Promise<T>,
	opts: { timeoutMs?: number; log?: (msg: string) => void } = {}
): Promise<RpcResult<T>> {
	if (endpoints.length === 0) throw new Error(`${label}: no RPC endpoint configured`)
	const timeoutMs = opts.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS
	const log = opts.log ?? ((m: string) => console.log(m))
	const order =
		endpoints.length > 1
			? endpoints
			: [endpoints[0], { ...endpoints[0], name: `${endpoints[0].name}-retry` }]
	const started = Date.now()
	let lastErr: unknown
	for (let i = 0; i < order.length; i++) {
		const ep = order[i]
		const t0 = Date.now()
		try {
			const value = await withTimeout(fn(ep.client), timeoutMs, `${label}@${ep.name}`)
			return { value, endpoint: ep.name, ms: Date.now() - started }
		} catch (err) {
			lastErr = err
			if (!isFailoverable(err)) throw err
			const next = order[i + 1]
			log(
				`[rpc] ${label} failed on ${ep.name} after ${Date.now() - t0}ms: ${errorText(err).slice(0, 200)}${next ? ` — trying ${next.name}` : ''}`
			)
		}
	}
	throw lastErr
}
