import { ethers } from 'ethers'

import { env } from '../schema/env'
import { BaseErrors } from '../schema/errors'

const SIMPLE_ACCOUNT_FACTORY_ABI = [
	'function getAddress(address owner, uint256 salt) view returns (address)',
	'function createAccount(address owner, uint256 salt) returns (address)',
	'function accountImplementation() view returns (address)'
]

const SIMPLE_ACCOUNT_ABI = [
	'function getNonce() view returns (uint256)',
	'function owner() view returns (address)',
	'function entryPoint() view returns (address)'
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
	return new ethers.Contract(
		env.SIMPLE_ACCOUNT_FACTORY_ADDRESS,
		SIMPLE_ACCOUNT_FACTORY_ABI,
		provider
	)
}

export async function computeWalletAddress(
	ownerAddress: string,
	salt: number | bigint = 0
): Promise<string> {
	if (!ethers.isAddress(ownerAddress)) {
		throw new BaseErrors.ERR_INVALID_ADDRESS()
	}

	const factory = getFactoryContract()
	const walletAddress = await factory.getFunction('getAddress')(ownerAddress, salt)

	return walletAddress
}

/**
 * Compute the deterministic b402 master wallet salt for a given owner address
 * Formula: keccak256("b402-${reversed-normalized-address}")
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
	const reversedAddress = normalizedAddress.split('').reverse().join('')

	// Create the salt string: "b402-{reversedAddress}"
	const saltString = `b402-${reversedAddress}`

	// Compute keccak256 hash and return as bigint
	const saltHash = ethers.keccak256(ethers.toUtf8Bytes(saltString))

	return BigInt(saltHash)
}

/**
 * Compute the deterministic b402 master wallet address for a given owner
 *
 * @param ownerAddress
 * @returns
 */
export async function computeMasterWalletAddress(ownerAddress: string): Promise<string> {
	const salt = getMasterWalletSalt(ownerAddress)
	return computeWalletAddress(ownerAddress, salt)
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
	const wallet = new ethers.Contract(address, SIMPLE_ACCOUNT_ABI, provider)
	const nonce = await wallet.getNonce()

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
