import { describe, expect, it } from 'vitest'

import { CHAINS, TOKENS, getChain, getCurrentChainId, getToken, isSupportedChain } from './chains'

// Regression guard for adding Ethereum mainnet (chainId 1). The #1 requirement: adding mainnet must NOT
// change the existing chains — the live Base/Arb/BSC facilitators read these, so any drift is a prod risk.
describe('chains config — mainnet added, existing chains UNCHANGED', () => {
	const ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032'
	const NEXUS_FACTORY = '0x0000006648ED9B2B842552BE63Af870bC74af837'

	it('EXISTING chains are untouched (ids + entrypoint intact)', () => {
		expect(CHAINS[56].id).toBe(56)
		expect(CHAINS[42161].id).toBe(42161)
		expect(CHAINS[84532].id).toBe(84532)
		// EntryPoint is the canonical CREATE2 addr on every chain — must not have drifted.
		for (const id of [56, 42161, 84532] as const) {
			expect(CHAINS[id].entryPoint).toBe(ENTRY_POINT)
			expect(CHAINS[id].nexusFactory).toBe(NEXUS_FACTORY)
		}
	})

	it('Ethereum mainnet (1) is added with the canonical 4337 addresses', () => {
		expect(CHAINS[1]).toBeDefined()
		expect(CHAINS[1].id).toBe(1)
		expect(CHAINS[1].name).toBe('Ethereum')
		expect(CHAINS[1].entryPoint).toBe(ENTRY_POINT)
		expect(CHAINS[1].nexusFactory).toBe(NEXUS_FACTORY)
		expect(getChain(1).id).toBe(1)
	})

	it('mainnet USDC token is registered (6 decimals) — existing token maps intact', () => {
		expect(getToken(1, 'USDC')?.address).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')
		expect(getToken(1, 'USDC')?.decimals).toBe(6)
		// existing untouched
		expect(getToken(42161, 'USDC')?.address).toBe('0xaf88d065e77c8cC2239327C5EDb3A432268e5831')
		expect(TOKENS[56].USDT.decimals).toBe(18)
	})

	it('NETWORK routing: ethereum→1, existing mappings unchanged', () => {
		const at = (n: string) => {
			process.env.NETWORK = n
			return getCurrentChainId()
		}
		expect(at('ethereum')).toBe(1)
		expect(at('eth')).toBe(1)
		expect(at('arbitrum')).toBe(42161)
		expect(at('arb')).toBe(42161)
		expect(at('base-sepolia')).toBe(84532)
		expect(at('bsc')).toBe(56)
		expect(at('anything-else')).toBe(56) // default preserved
		delete process.env.NETWORK
	})

	it('isSupportedChain: 1 now supported, junk rejected', () => {
		expect(isSupportedChain(1)).toBe(true)
		expect(isSupportedChain(56)).toBe(true)
		expect(isSupportedChain(42161)).toBe(true)
		expect(isSupportedChain(999)).toBe(false)
	})
})
