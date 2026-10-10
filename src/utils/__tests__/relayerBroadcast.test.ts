import { ethers } from 'ethers'
import { describe, expect, it } from 'vitest'

import {
	BroadcastError,
	NonceFloor,
	broadcastWithReplacement,
	waitForAnyReceipt
} from '../relayerBroadcast'
import { type RpcClient, type RpcEndpoint, RpcTimeoutError, rpcCall } from '../rpc'

const hang = <T>(): Promise<T> => new Promise<T>(() => undefined)
const gwei = (n: string) => ethers.parseUnits(n, 'gwei')
const ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032'
const signer = new ethers.Wallet(ethers.Wallet.createRandom().privateKey)
const req = { to: ENTRY_POINT, data: '0x1234', label: 'test' }
const quiet = () => undefined
const noSleep = async () => undefined

type Fake = RpcClient & { raws: string[]; nonceTags: (string | undefined)[] }

function fake(over: Partial<RpcClient> = {}): Fake {
	const raws: string[] = []
	const nonceTags: (string | undefined)[] = []
	const base: RpcClient = {
		getTransactionCount: async (_a, tag) => {
			nonceTags.push(tag)
			return 7
		},
		estimateGas: async () => 200_000n,
		getFeeData: async () => new ethers.FeeData(gwei('1'), gwei('2'), gwei('0.1')),
		send: async (_m, params) => {
			const raw = (params as string[])[0]
			raws.push(raw)
			return ethers.keccak256(raw)
		},
		call: async () => '0x',
		getTransaction: async () => null,
		getTransactionReceipt: async () => null
	}
	const client = { ...base, ...over, raws, nonceTags } as Fake
	// wrap send so overrides still record what was sent
	if (over.send) {
		const inner = over.send
		client.send = async (m, p) => {
			raws.push((p as string[])[0])
			return inner(m, p)
		}
	}
	return client
}

const eps = (...clients: RpcClient[]): RpcEndpoint[] =>
	clients.map((client, i) => ({ name: i === 0 ? 'primary' : 'fallback', client }))

const opts = (endpoints: RpcEndpoint[], extra = {}) => ({
	endpoints,
	signer,
	chainId: 4663n,
	timeoutMs: 40,
	sleep: noSleep,
	log: quiet,
	nonceFloor: new NonceFloor(),
	...extra
})

const nodeError = (message: string, code = 'UNKNOWN_ERROR') =>
	Object.assign(new Error(message), { code, error: { message } })

describe('rpcCall — bounded, fail-over', () => {
	it('times out a hung primary and serves the call from the fallback', async () => {
		const t0 = Date.now()
		const r = await rpcCall(
			eps(fake({ getTransactionCount: hang }), fake()),
			'nonce',
			(c) => c.getTransactionCount('0x0', 'pending'),
			{ timeoutMs: 40, log: quiet }
		)
		expect(r.value).toBe(7)
		expect(r.endpoint).toBe('fallback')
		expect(Date.now() - t0).toBeLessThan(1000)
	})

	it('never fails over a deterministic node answer (revert)', async () => {
		const fb = fake()
		let fbCalled = false
		fb.estimateGas = async () => {
			fbCalled = true
			return 1n
		}
		await expect(
			rpcCall(
				eps(
					fake({
						estimateGas: async () =>
							Promise.reject(nodeError('execution reverted', 'CALL_EXCEPTION'))
					}),
					fb
				),
				'estimateGas',
				(c) => c.estimateGas({}),
				{ timeoutMs: 40, log: quiet }
			)
		).rejects.toThrow(/execution reverted/)
		expect(fbCalled).toBe(false)
	})

	it('with a single endpoint, retries it once, then surfaces the timeout', async () => {
		let n = 0
		const one = fake({
			getFeeData: async () => {
				n++
				return n === 1 ? hang() : new ethers.FeeData(1n, null, null)
			}
		})
		const r = await rpcCall(eps(one), 'feeData', (c) => c.getFeeData(), {
			timeoutMs: 40,
			log: quiet
		})
		expect(r.endpoint).toBe('primary-retry')

		await expect(
			rpcCall(eps(fake({ getFeeData: hang })), 'feeData', (c) => c.getFeeData(), {
				timeoutMs: 20,
				log: quiet
			})
		).rejects.toBeInstanceOf(RpcTimeoutError)
	})
})

describe('broadcastWithReplacement', () => {
	it('happy path: pending nonce, one signed tx, per-step timings', async () => {
		const p = fake()
		const r = await broadcastWithReplacement(req, opts(eps(p)))
		expect(p.nonceTags).toEqual(['pending'])
		expect(p.raws).toHaveLength(1)
		const tx = ethers.Transaction.from(p.raws[0])
		expect(tx.nonce).toBe(7)
		expect(tx.to).toBe(ENTRY_POINT)
		expect(tx.gasLimit).toBe(200_000n)
		expect(tx.maxFeePerGas).toBe(gwei('2'))
		expect(r.hash).toBe(tx.hash)
		expect(r.sentHashes).toEqual([tx.hash])
		expect(r.timings.map((t) => t.split('=')[0])).toEqual(
			expect.arrayContaining(['nonce', 'estimateGas', 'feeData', 'sign', 'send'])
		)
	})

	it('a hung primary send fails over with the SAME signed bytes (no second tx)', async () => {
		const primary = fake({ send: hang })
		const fallback = fake()
		const r = await broadcastWithReplacement(req, opts(eps(primary, fallback)))
		expect(primary.raws).toHaveLength(1)
		expect(fallback.raws).toEqual(primary.raws)
		expect(r.sentHashes).toHaveLength(1)
		expect(r.timings.find((t) => t.startsWith('send='))).toMatch(/@fallback$/)
	})

	it('"already known" is success with the local hash', async () => {
		const p = fake({ send: async () => Promise.reject(nodeError('already known')) })
		const r = await broadcastWithReplacement(req, opts(eps(p)))
		expect(r.hash).toBe(ethers.Transaction.from(p.raws[0]).hash)
	})

	it('unknown send fate → replacement at the SAME nonce with fees bumped >= 12.5%, nonce not refetched', async () => {
		let sends = 0
		const p = fake({
			send: async (_m, params) => {
				sends++
				if (sends <= 2) return hang() // attempt 0: primary + retry both time out
				return ethers.keccak256((params as string[])[0])
			}
		})
		const r = await broadcastWithReplacement(req, opts(eps(p)))
		const [first, , second] = p.raws.map((raw) => ethers.Transaction.from(raw))
		expect(p.nonceTags).toEqual(['pending']) // nonce fetched once, then pinned
		expect(second.nonce).toBe(first.nonce)
		expect(second.maxFeePerGas! * 1000n).toBeGreaterThanOrEqual(first.maxFeePerGas! * 1125n)
		expect(second.maxPriorityFeePerGas! * 1000n).toBeGreaterThanOrEqual(
			first.maxPriorityFeePerGas! * 1125n
		)
		expect(r.hash).toBe(second.hash)
		expect(r.sentHashes).toEqual([first.hash, second.hash])
	})

	it('"nonce too low" after an unknown-fate send returns the copy that landed — no new nonce', async () => {
		let sends = 0
		let firstHash = ''
		const p = fake({
			send: async (_m, params) => {
				sends++
				const raw = (params as string[])[0]
				if (sends === 1) firstHash = ethers.keccak256(raw)
				if (sends <= 2) return hang()
				return Promise.reject(nodeError('nonce too low', 'NONCE_EXPIRED'))
			},
			getTransaction: async (h) =>
				h === firstHash ? ({ hash: h } as ethers.TransactionResponse) : null
		})
		const r = await broadcastWithReplacement(req, opts(eps(p)))
		expect(r.hash).toBe(firstHash)
		expect(r.nonce).toBe(7)
		expect(p.nonceTags).toEqual(['pending'])
		expect(new Set(p.raws.map((raw) => ethers.Transaction.from(raw).nonce))).toEqual(new Set([7]))
	})

	it("underpriced at a nonce we never sent (another instance's tx) moves past it, never replaces it", async () => {
		let sends = 0
		const p = fake({
			send: async (_m, params) => {
				sends++
				if (sends === 1) return Promise.reject(nodeError('replacement transaction underpriced'))
				return ethers.keccak256((params as string[])[0])
			}
		})
		const r = await broadcastWithReplacement(req, opts(eps(p)))
		const nonces = p.raws.map((raw) => ethers.Transaction.from(raw).nonce)
		expect(nonces).toEqual([7, 8])
		expect(r.nonce).toBe(8)
	})

	it('a lagging pending count never reuses a nonce this process just broadcast', async () => {
		const floor = new NonceFloor()
		const p = fake() // always says pending = 7
		const a = await broadcastWithReplacement(req, opts(eps(p), { nonceFloor: floor }))
		const b = await broadcastWithReplacement(req, opts(eps(p), { nonceFloor: floor }))
		expect([a.nonce, b.nonce]).toEqual([7, 8])
	})

	it('NonceFloor expires so a dropped tx cannot wedge the relayer', () => {
		let now = 0
		const floor = new NonceFloor(60_000, () => now)
		floor.record(10)
		expect(floor.apply(9)).toBe(11)
		expect(floor.apply(12)).toBe(12)
		now = 61_000
		expect(floor.apply(9)).toBe(9)
	})

	it('a simulation revert fails fast without broadcasting', async () => {
		const p = fake({
			estimateGas: async () =>
				Promise.reject(nodeError('execution reverted: AA25', 'CALL_EXCEPTION'))
		})
		await expect(broadcastWithReplacement(req, opts(eps(p)))).rejects.toBeInstanceOf(BroadcastError)
		expect(p.raws).toHaveLength(0)
	})

	it('all endpoints stalled → bounded failure that lists possibly-sent hashes', async () => {
		const t0 = Date.now()
		const p = fake({ send: hang })
		const err = await broadcastWithReplacement(req, opts(eps(p), { maxAttempts: 3 })).catch(
			(e) => e
		)
		expect(err).toBeInstanceOf(BroadcastError)
		expect((err as BroadcastError).possiblySent).toHaveLength(3)
		// all three share one nonce: replacements, never a second copy at a new nonce
		expect(new Set(p.raws.map((raw) => ethers.Transaction.from(raw).nonce)).size).toBe(1)
		expect(Date.now() - t0).toBeLessThan(2000)
	})
})

describe('waitForAnyReceipt', () => {
	it('returns the receipt of whichever copy (original or replacement) mined', async () => {
		const receipt = { hash: '0xbb', status: 1 } as unknown as ethers.TransactionReceipt
		let polls = 0
		const p = fake({
			getTransactionReceipt: async (h) => {
				polls++
				return h === '0xbb' && polls > 2 ? receipt : null
			}
		})
		const r = await waitForAnyReceipt(eps(p), ['0xaa', '0xbb'], {
			intervalMs: 1,
			timeoutMs: 1000,
			rpcTimeoutMs: 40,
			log: quiet
		})
		expect(r).toBe(receipt)
	})

	it('a hung receipt endpoint does not stall past the deadline', async () => {
		const r = await waitForAnyReceipt(eps(fake({ getTransactionReceipt: hang })), ['0xaa'], {
			intervalMs: 1,
			timeoutMs: 50,
			rpcTimeoutMs: 20,
			log: quiet
		})
		expect(r).toBeNull()
	})
})
