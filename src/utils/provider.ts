import { type JsonRpcProvider, ethers } from 'ethers'

import { CHAIN_CONFIG } from '../constants'
import { BaseErrors } from '../schema/errors'

export class ProviderService {
	private provider: JsonRpcProvider
	private chainId: number
	private network: string

	constructor(config: { RPC_URL: string }) {
		this.chainId = CHAIN_CONFIG.chainId
		this.network = CHAIN_CONFIG.name

		this.provider = new ethers.JsonRpcProvider(config.RPC_URL, {
			chainId: this.chainId,
			name: this.network
		})
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

export function initializeProviderService(config: { RPC_URL: string }): void {
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
