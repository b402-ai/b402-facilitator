import { ethers } from 'ethers'

import {
	DEFAULT_RPC_TIMEOUT_MS,
	type RpcClient,
	type RpcEndpoint,
	errorText,
	isFailoverable,
	rpcCall
} from './rpc'

/**
 * Relayer-EOA broadcast with bounded RPC steps, endpoint fail-over and nonce-safe replacement.
 *
 * The tx is populated and signed HERE (not by ethers' signer.sendTransaction, whose populate
 * step runs estimateGas + getFeeData + getBlockNumber on the provider with no deadline), so
 * every RPC round trip is individually timed, logged and bounded.
 *
 * Nonce safety:
 *  - the nonce comes from getTransactionCount(relayer, 'pending'), never below this process's
 *    own recent high-water mark (NonceFloor) so a lagging fallback node can't hand back a
 *    nonce we just used — that would REPLACE another request's in-flight handleOps;
 *  - once a signed tx MAY have reached a node (every endpoint timed out on send), the nonce is
 *    pinned: the retry is a replacement at the SAME nonce with fees bumped >= 12.5%, so at most
 *    one of them can mine. The UserOp is never re-sent at a new nonce while an earlier copy may
 *    still be pending;
 *  - "nonce too low" after a possibly-sent attempt first looks the earlier hashes up and returns
 *    the one that landed. Only if none is found does it move to a fresh nonce, re-simulating
 *    (estimateGas) first — the EntryPoint userOp nonce makes a second execution revert there.
 *  - re-sending the same signed bytes is idempotent ("already known" = success, same hash).
 */

export interface RelayerSigner {
	address: string
	signTransaction(tx: ethers.TransactionRequest): Promise<string>
}

/**
 * Per-process high-water mark of relayer nonces this instance broadcast. Trusted only for
 * `ttlMs` after the last broadcast so a tx dropped from every mempool can't wedge the relayer
 * behind a nonce gap; after that the node's 'pending' count is authoritative again.
 */
export class NonceFloor {
	private next = -1
	private at = 0
	constructor(
		private readonly ttlMs = 60_000,
		private readonly now: () => number = () => Date.now()
	) {}

	private fresh(): boolean {
		return this.next >= 0 && this.now() - this.at < this.ttlMs
	}

	apply(pending: number): number {
		return this.fresh() && this.next > pending ? this.next : pending
	}

	record(nonce: number): void {
		this.next = Math.max(this.fresh() ? this.next : -1, nonce + 1)
		this.at = this.now()
	}
}

export interface BroadcastRequest {
	to: string
	data: string
	/** Prefix for log lines, e.g. `userOpHash=0x… sender=0x…`. */
	label: string
}

export interface BroadcastOptions {
	endpoints: RpcEndpoint[]
	signer: RelayerSigner
	chainId: bigint
	nonceFloor?: NonceFloor
	timeoutMs?: number
	maxAttempts?: number
	/** Stop starting new attempts after this long (the in-flight one still completes, bounded). */
	deadlineMs?: number
	sleep?: (ms: number) => Promise<void>
	log?: (msg: string) => void
}

interface Fees {
	maxFeePerGas?: bigint
	maxPriorityFeePerGas?: bigint
	gasPrice?: bigint
}

export interface BroadcastResult {
	hash: string
	/** Every hash signed and handed to a node for this request (replacements share one nonce). */
	sentHashes: string[]
	nonce: number
	attempts: number
	/** Per-step timings, e.g. `nonce=120ms@primary`. */
	timings: string[]
}

export class BroadcastError extends Error {
	constructor(
		message: string,
		readonly possiblySent: string[],
		readonly cause?: unknown
	) {
		super(message)
	}
}

const ALREADY_KNOWN = /already known|known transaction|already imported|alreadyknown/i
const NONCE_TOO_LOW = /nonce too low|nonce has already been used|NONCE_EXPIRED/i
const UNDERPRICED =
	/underpriced|replacement fee too low|fee too low|REPLACEMENT_UNDERPRICED|max fee per gas less than block base fee/i

const bump = (v: bigint, pct: bigint): bigint => (v * pct + 99n) / 100n

/** Send signed bytes; "already known" means a node already has exactly this tx — success. */
async function sendRaw(client: RpcClient, raw: string, hash: string): Promise<string> {
	try {
		const h = await client.send('eth_sendRawTransaction', [raw])
		return typeof h === 'string' && h.startsWith('0x') ? h : hash
	} catch (err) {
		if (ALREADY_KNOWN.test(errorText(err))) return hash
		throw err
	}
}

function nextFees(fee: ethers.FeeData, attempt: number, prev: Fees | null): Fees {
	const pct = BigInt(100 + 40 * attempt) // keep the 40%/attempt re-price of the original retry loop
	if (fee.maxFeePerGas != null && fee.maxPriorityFeePerGas != null) {
		let maxFee = bump(fee.maxFeePerGas, pct)
		let prio = bump(fee.maxPriorityFeePerGas, pct)
		if (prev?.maxFeePerGas != null && prev.maxPriorityFeePerGas != null) {
			// A replacement must clear the prior tx by >= 10% on BOTH fields (geth rule); use 12.5%.
			const minMax = bump(prev.maxFeePerGas, 113n)
			const minPrio = bump(prev.maxPriorityFeePerGas, 113n)
			if (maxFee < minMax) maxFee = minMax
			if (prio < minPrio) prio = minPrio
		}
		if (prio > maxFee) prio = maxFee // EIP-1559 invariant
		return { maxFeePerGas: maxFee, maxPriorityFeePerGas: prio }
	}
	let gasPrice = bump(fee.gasPrice ?? 1_000_000n, pct)
	if (prev?.gasPrice != null) {
		const min = bump(prev.gasPrice, 113n)
		if (gasPrice < min) gasPrice = min
	}
	return { gasPrice }
}

export async function broadcastWithReplacement(
	req: BroadcastRequest,
	opts: BroadcastOptions
): Promise<BroadcastResult> {
	const {
		endpoints,
		signer,
		chainId,
		nonceFloor = new NonceFloor(),
		timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
		maxAttempts = 5,
		deadlineMs = 25_000,
		sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
		log = (m: string) => console.log(m)
	} = opts
	const started = Date.now()
	const timings: string[] = []
	const sent: { hash: string; nonce: number }[] = []

	const step = async <T>(name: string, fn: (client: RpcClient) => Promise<T>): Promise<T> => {
		const r = await rpcCall(endpoints, name, fn, { timeoutMs, log })
		timings.push(`${name}=${r.ms}ms@${r.endpoint}`)
		return r.value
	}

	// Look up every hash we signed for this request (the current one too: a timed-out primary
	// may have accepted it before the fallback answered "nonce too low"); return one a node
	// knows about, mined or pending.
	const findLanded = async (): Promise<{ hash: string; nonce: number } | null> => {
		for (const s of [...sent].reverse()) {
			try {
				const tx = await step('lookup', (c) => c.getTransaction(s.hash))
				if (tx) return s
			} catch {
				// unknown — keep looking
			}
		}
		return null
	}

	let pinnedNonce: number | null = null // set only while OUR tx may be pending at that nonce
	let pinnedFees: Fees | null = null
	let minNonce = -1
	let gasLimit: bigint | null = null
	let lastErr: unknown

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (attempt > 0) {
			if (Date.now() - started > deadlineMs) break
			await sleep(Math.min(250 * attempt, 1000))
		}

		let nonce: number
		let fees: Fees
		let raw: string
		let hash: string
		try {
			// nonce / gas / fees are independent — fetch them concurrently.
			const knownGas: bigint | null = gasLimit
			const [pending, gas, feeData]: [number, bigint, ethers.FeeData] = await Promise.all([
				pinnedNonce !== null
					? Promise.resolve(pinnedNonce)
					: step('nonce', (c) => c.getTransactionCount(signer.address, 'pending')),
				knownGas !== null
					? Promise.resolve(knownGas)
					: step('estimateGas', (c) =>
							c.estimateGas({ from: signer.address, to: req.to, data: req.data })
						),
				step('feeData', (c) => c.getFeeData())
			])
			nonce = pinnedNonce !== null ? pinnedNonce : nonceFloor.apply(Math.max(pending, minNonce))
			gasLimit = gas
			fees =
				attempt === 0 && pinnedFees === null
					? nextFees(feeData, 0, null)
					: nextFees(feeData, attempt, pinnedFees)
			const t0 = Date.now()
			raw = await signer.signTransaction({
				to: req.to,
				data: req.data,
				value: 0n,
				nonce,
				gasLimit,
				chainId,
				...(fees.gasPrice != null
					? { type: 0, gasPrice: fees.gasPrice }
					: {
							type: 2,
							maxFeePerGas: fees.maxFeePerGas,
							maxPriorityFeePerGas: fees.maxPriorityFeePerGas
						})
			})
			hash = ethers.keccak256(raw)
			timings.push(`sign=${Date.now() - t0}ms`)
		} catch (err) {
			lastErr = err
			if (isFailoverable(err)) {
				log(`[bundler] ${req.label} prepare failed (attempt ${attempt}): ${errorText(err)}`)
				continue
			}
			throw new BroadcastError(
				`prepare failed: ${errorText(err)}`,
				sent.map((s) => s.hash),
				err
			)
		}

		sent.push({ hash, nonce })
		log(
			`[bundler] submit ${req.label} relayerNonce=${nonce} attempt=${attempt}${pinnedNonce !== null ? ' (replacement)' : ''} tx=${hash}`
		)
		try {
			const h = await step('send', (c) => sendRaw(c, raw, hash))
			nonceFloor.record(nonce)
			return { hash: h, sentHashes: sent.map((s) => s.hash), nonce, attempts: attempt + 1, timings }
		} catch (err) {
			lastErr = err
			const text = errorText(err)
			if (isFailoverable(err)) {
				// Every endpoint timed out / failed in transport: the tx MAY be in a mempool.
				// Pin the nonce so the next attempt replaces it rather than sending a second copy.
				pinnedNonce = nonce
				pinnedFees = fees
				log(
					`[bundler] ${req.label} send fate unknown (attempt ${attempt}), will replace at nonce ${nonce}: ${text}`
				)
				continue
			}
			if (NONCE_TOO_LOW.test(text)) {
				const landed = await findLanded()
				if (landed) {
					nonceFloor.record(landed.nonce)
					log(`[bundler] ${req.label} earlier attempt landed: ${landed.hash}`)
					return {
						hash: landed.hash,
						sentHashes: sent.map((s) => s.hash),
						nonce: landed.nonce,
						attempts: attempt + 1,
						timings
					}
				}
				log(`[bundler] ${req.label} nonce ${nonce} taken (attempt ${attempt}), refetching`)
				if (pinnedNonce !== null) gasLimit = null // re-simulate: an earlier copy may have executed
				pinnedNonce = null
				pinnedFees = null
				minNonce = nonce + 1
				continue
			}
			if (UNDERPRICED.test(text)) {
				if (pinnedNonce !== null) {
					// Our own earlier tx holds this nonce: bump further on the same nonce.
					pinnedFees = fees
				} else {
					// Someone else's tx (another instance) holds it: move past, never replace it.
					minNonce = nonce + 1
				}
				log(`[bundler] ${req.label} underpriced at nonce ${nonce} (attempt ${attempt}): ${text}`)
				continue
			}
			throw new BroadcastError(
				`send failed: ${text}`,
				sent.map((s) => s.hash),
				err
			)
		}
	}
	throw new BroadcastError(
		`broadcast failed after ${sent.length} signed attempt(s) in ${Date.now() - started}ms: ${errorText(lastErr)}`,
		sent.map((s) => s.hash),
		lastErr
	)
}

/**
 * Poll every candidate hash (original + replacements) until one has a receipt. Each poll is a
 * bounded, fail-over call; returns null at `timeoutMs`.
 */
export async function waitForAnyReceipt(
	endpoints: RpcEndpoint[],
	hashes: string[],
	opts: {
		intervalMs?: number
		timeoutMs?: number
		rpcTimeoutMs?: number
		sleep?: (ms: number) => Promise<void>
		log?: (msg: string) => void
	} = {}
): Promise<ethers.TransactionReceipt | null> {
	const intervalMs = opts.intervalMs ?? 500
	const deadline = Date.now() + (opts.timeoutMs ?? 180_000)
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
	for (;;) {
		const receipts = await Promise.all(
			hashes.map((h) =>
				rpcCall(endpoints, 'receipt', (c) => c.getTransactionReceipt(h), {
					timeoutMs: opts.rpcTimeoutMs,
					log: opts.log
				})
					.then((r) => r.value)
					.catch(() => null)
			)
		)
		const hit = receipts.find((r) => r != null)
		if (hit) return hit
		if (Date.now() >= deadline) return null
		await sleep(intervalMs)
	}
}
