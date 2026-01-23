import { ethers } from 'ethers'

import { env } from '../schema/env'
import { BaseErrors } from '../schema/errors'
import { getMasterWalletCache, setMasterWalletCache } from './masterWalletCache'
import { encodeNexusAccountCreation } from './nexus'

const NEXUS_ACCOUNT_FACTORY_ABI = [
	'function computeAccountAddress(bytes calldata initData, bytes32 salt) view returns (address)',
	'function createAccount(bytes calldata initData, bytes32 salt) payable returns (address)'
]

const ERC20_ABI = [
	'function balanceOf(address account) view returns (uint256)',
	'function allowance(address owner, address spender) view returns (uint256)',
	'function decimals() view returns (uint8)',
	'function symbol() view returns (string)'
]

// Singleton instance
let providerInstance: ethers.JsonRpcProvider | null = null

export function getProvider(): ethers.JsonRpcProvider {
	if (!providerInstance) {
		const rpcUrl = env.NETWORK === 'mainnet' ? env.BSC_RPC_URL : env.BSC_TESTNET_RPC_URL
		providerInstance = new ethers.JsonRpcProvider(rpcUrl)
	}
	return providerInstance
}

export function getFactoryContract(): ethers.Contract {
	const provider = getProvider()
	return new ethers.Contract(env.NEXUS_ACCOUNT_FACTORY_ADDRESS, NEXUS_ACCOUNT_FACTORY_ABI, provider)
}

export async function computeWalletAddress(
	ownerAddress: string,
	salt: number | bigint = 0
): Promise<string> {
	if (!ethers.isAddress(ownerAddress)) {
		throw new BaseErrors.ERR_INVALID_ADDRESS()
	}

	const initData = encodeNexusAccountCreation(ownerAddress)
	const saltBytes32 = ethers.zeroPadValue(ethers.toBeHex(BigInt(salt)), 32)
	const factory = getFactoryContract()
	const walletAddress = await factory.getFunction('computeAccountAddress')(initData, saltBytes32)

	return walletAddress
}

/**
 * Compute the deterministic b402 master wallet salt for a given owner address
 * Formula: keccak256(`b402-${reversed-normalized-address}`)
 *
 * @param ownerAddress
 * @returns
 */
export function getMasterWalletSalt(ownerAddress: string): bigint {
	if (!ethers.isAddress(ownerAddress)) {
		throw new BaseErrors.ERR_INVALID_ADDRESS()
	}

	// Normalize address to lowercase and remove "0x" prefix
	const normalizedAddress = ownerAddress.toLowerCase().slice(2)

	// Reverse the hex string
	const reversedNormalizedAddress = normalizedAddress.split('').reverse().join('')

	// Create the salt string: "b402-{reversed-normalized-address}"
	const saltString = `b402-${reversedNormalizedAddress}`

	// Compute keccak256 hash and return as bigint
	return BigInt(ethers.keccak256(ethers.toUtf8Bytes(saltString)))
}

/**
 * Derive a deterministic unshield EOA from a shield EOA private key
 * Formula: keccak256(privateKey + "b402-unshield")
 *
 * @param eoaPrivateKey
 * @returns
 */
export function deriveUnshieldEOA(eoaPrivateKey: string): ethers.Wallet {
	// Hash the private key with a constant salt to derive a new private key
	const derivedPrivateKey = ethers.keccak256(
		ethers.concat([eoaPrivateKey, ethers.toUtf8Bytes('b402-unshield')])
	)

	return new ethers.Wallet(derivedPrivateKey)
}

/**
 * Compute the deterministic b402 master wallet address for a given owner
 * Uses a cache store
 *
 * @param ownerAddress
 * @returns
 */
export async function computeMasterWalletAddress(ownerAddress: string): Promise<string> {
	const cached = getMasterWalletCache(ownerAddress)
	if (cached) {
		return cached
	}

	const salt = getMasterWalletSalt(ownerAddress)
	const walletAddress = await computeWalletAddress(ownerAddress, salt)

	// Store in cache
	setMasterWalletCache(ownerAddress, walletAddress)

	return walletAddress
}

export async function isWalletDeployed(address: string): Promise<boolean> {
	if (!ethers.isAddress(address)) {
		throw new BaseErrors.ERR_INVALID_ADDRESS()
	}

	const provider = getProvider()
	const code = await provider.getCode(address)

	// If "0x", the address has no contract deployed
	return code !== '0x'
}

export async function getWalletNonce(address: string): Promise<number> {
	const deployed = await isWalletDeployed(address)

	if (!deployed) {
		return 0
	}

	const provider = getProvider()

	const entryPointABI = ['function getNonce(address sender, uint192 key) view returns (uint256)']
	const entryPoint = new ethers.Contract(env.ENTRY_POINT_ADDRESS, entryPointABI, provider)
	const nonce = await entryPoint.getNonce(address, 0) // 0 for default nonce

	return Number(nonce)
}

export async function getTokenBalance(
	walletAddress: string,
	tokenAddress: string
): Promise<string> {
	const provider = getProvider()
	const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider)
	const balance = await token.balanceOf(walletAddress)

	return balance.toString()
}

export async function getTokenAllowance(
	walletAddress: string,
	tokenAddress: string
): Promise<string> {
	const provider = getProvider()
	const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider)
	const allowance = await token.allowance(walletAddress, env.B402_RELAYER_ADDRESS)

	return allowance.toString()
}

export async function hasSufficientBalance(
	walletAddress: string,
	tokenAddress: string,
	requiredAmount: bigint | string
): Promise<boolean> {
	const balance = await getTokenBalance(walletAddress, tokenAddress)
	const balanceBigInt = BigInt(balance)
	const requiredBigInt =
		typeof requiredAmount === 'string' ? BigInt(requiredAmount) : requiredAmount

	return balanceBigInt >= requiredBigInt
}
