/**
 * Shared Railgun utilities for shield and unshield operations
 */
import { ArtifactStore } from '@railgun-community/wallet'
import { Mnemonic, ethers } from 'ethers'
import { MemoryLevel } from 'memory-level'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

// Constants
export const B402_RESERVED_ZK_MESSAGE = 'b402 Reserved Railgun zk-Address'

export const ERC20_ABI = [
	'function approve(address spender, uint256 amount) external returns (bool)',
	'function allowance(address owner, address spender) external view returns (uint256)',
	'function balanceOf(address account) external view returns (uint256)',
	'function decimals() external view returns (uint8)',
	'function symbol() external view returns (string)'
] as const

/**
 * Derives a deterministic BIP39 mnemonic from an EOA private key
 * Uses a reserved message signature to ensure deterministic generation
 */
export async function deriveMnemonicFromEOA(eoaPrivateKey: string): Promise<string> {
	const wallet = new ethers.Wallet(eoaPrivateKey)
	const message = B402_RESERVED_ZK_MESSAGE
	const signature = await wallet.signMessage(message)
	const entropy = ethers.keccak256(signature).slice(0, 34) // 32 bytes + '0x'
	const mnemonic = Mnemonic.fromEntropy(entropy)
	return mnemonic.phrase
}

/**
 * Generates a random 32-byte private key for shield operations
 */
export function getShieldPrivateKey(): string {
	return ethers.hexlify(ethers.randomBytes(32))
}

/**
 * Creates an in-memory artifact store for Railgun operations
 * Useful for shield operations that don't need persistent storage
 */
export function createInMemoryArtifactStore(): ArtifactStore {
	const storage = new Map<string, string | Buffer>()

	return new ArtifactStore(
		async (path: string) => {
			const item = storage.get(path)
			if (!item) {
				throw new Error(`Artifact not found: ${path}`)
			}
			return item
		},
		async (_dir: string, path: string, item: string | Uint8Array) => {
			// Convert Uint8Array to Buffer for storage
			const storageItem = typeof item === 'string' ? item : Buffer.from(item)
			storage.set(path, storageItem)
		},
		async (path: string) => {
			return storage.has(path)
		}
	)
}

/**
 * Creates a file-based artifact store for Railgun operations
 * Required for unshield operations that need ZK circuit artifacts
 */
export function createFileBasedArtifactStore(artifactsDir: string): ArtifactStore {
	return new ArtifactStore(
		async (filePath: string) => {
			const fullPath = path.join(artifactsDir, filePath)
			const data = await fs.readFile(fullPath)
			return data
		},
		async (dir: string, filePath: string, item: string | Uint8Array) => {
			const fullPath = path.join(artifactsDir, dir, filePath)
			await fs.mkdir(path.dirname(fullPath), { recursive: true })
			await fs.writeFile(fullPath, item)
		},
		async (filePath: string) => {
			const fullPath = path.join(artifactsDir, filePath)
			try {
				await fs.access(fullPath)
				return true
			} catch {
				return false
			}
		}
	)
}

/**
 * Creates a MemoryLevel database instance for Railgun engine
 */
export function createMemoryDatabase() {
	return new MemoryLevel()
}
