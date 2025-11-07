import { type JsonRpcProvider, ethers } from 'ethers'

export class ProviderService {
	private provider: JsonRpcProvider
	private chainId: number
	private network: string

	constructor(config: { NETWORK: string; BSC_RPC_URL: string; BSC_TESTNET_RPC_URL: string }) {
		const envNetwork = config.NETWORK || 'testnet'
		this.chainId = envNetwork === 'mainnet' ? 56 : 97
		this.network = envNetwork

		const rpcUrl = envNetwork === 'mainnet' ? config.BSC_RPC_URL : config.BSC_TESTNET_RPC_URL

		this.provider = new ethers.JsonRpcProvider(rpcUrl, {
			chainId: this.chainId,
			name: envNetwork === 'mainnet' ? 'bsc' : 'bsc-testnet'
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

export function initializeProviderService(config: {
	NETWORK: string
	BSC_RPC_URL: string
	BSC_TESTNET_RPC_URL: string
}): void {
	if (!providerServiceInstance) {
		providerServiceInstance = new ProviderService(config)
	}
}

export function getProviderService(): ProviderService {
	if (!providerServiceInstance) {
		throw new Error('ProviderService not initialized. Call initializeProviderService first.')
	}
	return providerServiceInstance
}
