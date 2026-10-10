import { type JsonRpcProvider, ethers } from 'ethers'

import { CHAIN_CONFIG } from '../constants'
import { BaseErrors } from '../schema/errors'
import type { RpcEndpoint } from './rpc'

// Backstop for any single JSON-RPC HTTP request (ethers' default is 300s, during which it also
// retries HTTP 429 with exponential backoff). Settle-path calls are additionally raced against a
// much shorter per-call deadline in ./rpc.ts; this only stops a hung socket living for minutes.
const RPC_REQUEST_BACKSTOP_MS = 30_000

function makeProvider(url: string, network: ethers.Network): JsonRpcProvider {
	const req = new ethers.FetchRequest(url)
	req.timeout = RPC_REQUEST_BACKSTOP_MS
	const provider = new ethers.JsonRpcProvider(req, network, {
		staticNetwork: network,
		pollingInterval: 500
	})
	provider.pollingInterval = 500
	return provider
}

export class ProviderService {
	private provider: JsonRpcProvider
	private fallbackProvider: JsonRpcProvider | null
	private chainId: number
	private network: string

	constructor(config: { RPC_URL: string; RPC_URL_FALLBACK?: string }) {
		this.chainId = CHAIN_CONFIG.chainId
		this.network = CHAIN_CONFIG.name

		// staticNetwork avoids a per-request eth_chainId round-trip; pollingInterval 500ms
		// (vs ethers' 4000ms default) makes tx.wait() detect Base's ~2s blocks promptly —
		// the dominant settle-latency fix, since the settle path chains several tx.wait().
		const network = ethers.Network.from({ chainId: this.chainId, name: this.network })
		this.provider = makeProvider(config.RPC_URL, network)
		// Optional second endpoint for the settle path's bounded fail-over (see ./rpc.ts).
		this.fallbackProvider =
			config.RPC_URL_FALLBACK && config.RPC_URL_FALLBACK !== config.RPC_URL
				? makeProvider(config.RPC_URL_FALLBACK, network)
				: null
	}

	/** Ordered endpoints for bounded, fail-over calls: RPC_URL first, then RPC_URL_FALLBACK. */
	getEndpoints(): RpcEndpoint[] {
		const eps: RpcEndpoint[] = [{ name: 'primary', client: this.provider }]
		if (this.fallbackProvider) eps.push({ name: 'fallback', client: this.fallbackProvider })
		return eps
	}

	getProvider(): JsonRpcProvider {
		return this.provider
	}

	getChainId(): number {
		return this.chainId
	}

	getNetwork(): string {
		return this.network
	}
}

// Singleton instance
let providerServiceInstance: ProviderService | null = null

export function initializeProviderService(config: {
	RPC_URL: string
	RPC_URL_FALLBACK?: string
}): void {
	if (!providerServiceInstance) {
		providerServiceInstance = new ProviderService(config)
	}
}

export function getProviderService(): ProviderService {
	if (!providerServiceInstance) {
		throw new BaseErrors.ERR_PROVIDER_NOT_INITIALIZED()
	}
	return providerServiceInstance
}
