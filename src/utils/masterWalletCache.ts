import NodeCache from 'node-cache'

/**
 * Cache for master wallet addresses
 *
 */
const masterWalletCache = new NodeCache({ stdTTL: 7 * 24 * 60 * 60 }) // 7 days

/**
 * Get cached master wallet address for an owner
 *
 * @param ownerAddress
 * @returns
 */
export function getMasterWalletCache(ownerAddress: string): string | undefined {
	return masterWalletCache.get<string>(`owner:${ownerAddress.toLowerCase()}`)
}

/**
 * Set cached master wallet address for an owner
 *
 * @param ownerAddress
 * @param walletAddress
 */
export function setMasterWalletCache(ownerAddress: string, walletAddress: string): void {
	masterWalletCache.set(`owner:${ownerAddress.toLowerCase()}`, walletAddress)
}
