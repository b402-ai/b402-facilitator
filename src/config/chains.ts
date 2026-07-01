/**
 * Multi-chain configuration for the B402 Facilitator
 *
 * Supports:
 * - BSC (Chain ID 56) - Production
 * - Arbitrum (Chain ID 42161) - Production
 * - Base Sepolia (Chain ID 84532) - Testnet
 *
 * Chain selection is based on NETWORK environment variable:
 * - NETWORK=mainnet or NETWORK=bsc -> BSC (56)
 * - NETWORK=arbitrum or NETWORK=arb -> Arbitrum (42161)
 * - NETWORK=base-sepolia or NETWORK=basesepolia -> Base Sepolia (84532)
 */

export type SupportedChainId = 1 | 56 | 42161 | 84532

export interface ChainConfig {
	id: SupportedChainId
	name: string
	rpcUrl: string
	bundlerUrl: string
	// ERC-4337 contracts (same across chains via deterministic deployment)
	entryPoint: `0x${string}`
	nexusFactory: `0x${string}`
	nexusBootstrap: `0x${string}`
	k1Validator: `0x${string}`
	// Chain-specific contracts
	paymaster: `0x${string}`
	feeRecipient: `0x${string}`
	b402Relayer: `0x${string}`
	// RAILGUN contract
	railgunRelay: `0x${string}`
}

export interface TokenConfig {
	address: `0x${string}`
	decimals: number
	symbol: string
}

/**
 * Chain configurations for supported networks
 *
 * Note: ERC-4337 contracts (EntryPoint, Nexus factory, etc.) are deployed
 * at the same addresses across chains via CREATE2 deterministic deployment.
 */
export const CHAINS: Record<SupportedChainId, ChainConfig> = {
	1: {
		id: 1,
		name: 'Ethereum',
		rpcUrl:
			process.env.ETH_MAINNET_RPC_URL ||
			process.env.RPC_URL ||
			'https://ethereum-rpc.publicnode.com',
		bundlerUrl: process.env.ETH_MAINNET_BUNDLER_URL || process.env.BUNDLER_RPC_URL || '',
		// ERC-4337 contracts (same addresses via deterministic deployment — verified present on mainnet)
		entryPoint:
			(process.env.ENTRY_POINT_ADDRESS as `0x${string}`) ||
			'0x0000000071727De22E5E9d8BAf0edAc6f37da032',
		nexusFactory:
			(process.env.NEXUS_ACCOUNT_FACTORY_ADDRESS as `0x${string}`) ||
			'0x0000006648ED9B2B842552BE63Af870bC74af837',
		nexusBootstrap:
			(process.env.NEXUS_BOOTSTRAP_ADDRESS as `0x${string}`) ||
			'0x0000003eDf18913c01cBc482C978bBD3D6E8ffA3',
		k1Validator:
			(process.env.K1_VALIDATOR_ADDRESS as `0x${string}`) ||
			'0x0000000031ef4155C978d48a8A7d4EDba03b04fE',
		// Chain-specific — set after deploying the mainnet VerifyingPaymaster (b402-contracts DeployPaymaster).
		paymaster: process.env.ETH_MAINNET_PAYMASTER_ADDRESS as `0x${string}`,
		feeRecipient: (process.env.ETH_MAINNET_FEE_RECIPIENT ||
			process.env.WALLET_FEE_RECIPIENT) as `0x${string}`,
		b402Relayer: (process.env.ETH_MAINNET_B402_RELAYER_ADDRESS ||
			process.env.B402_RELAYER_ADDRESS) as `0x${string}`,
		// RAILGUN not used for the RE market — set if/when privacy funding is wired on mainnet.
		railgunRelay:
			(process.env.ETH_MAINNET_RAILGUN_RELAY as `0x${string}`) ||
			'0x0000000000000000000000000000000000000000'
	},
	56: {
		id: 56,
		name: 'BSC',
		rpcUrl: process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org',
		bundlerUrl: process.env.BSC_BUNDLER_URL || process.env.BUNDLER_RPC_URL || '',
		// ERC-4337 contracts
		entryPoint:
			(process.env.ENTRY_POINT_ADDRESS as `0x${string}`) ||
			'0x0000000071727De22E5E9d8BAf0edAc6f37da032',
		nexusFactory:
			(process.env.NEXUS_ACCOUNT_FACTORY_ADDRESS as `0x${string}`) ||
			'0x0000006648ED9B2B842552BE63Af870bC74af837',
		nexusBootstrap:
			(process.env.NEXUS_BOOTSTRAP_ADDRESS as `0x${string}`) ||
			'0x0000003eDf18913c01cBc482C978bBD3D6E8ffA3',
		k1Validator:
			(process.env.K1_VALIDATOR_ADDRESS as `0x${string}`) ||
			'0x0000000031ef4155C978d48a8A7d4EDba03b04fE',
		// Chain-specific
		paymaster: (process.env.BSC_PAYMASTER_ADDRESS ||
			process.env.PAYMASTER_ADDRESS) as `0x${string}`,
		feeRecipient: (process.env.BSC_FEE_RECIPIENT ||
			process.env.WALLET_FEE_RECIPIENT) as `0x${string}`,
		b402Relayer: process.env.B402_RELAYER_ADDRESS as `0x${string}`,
		// B402 Railgun fork (0% protocol fees) - deployed 2026-02-05
		railgunRelay: '0x9dB0eDC77C9047a06Fd6dE82c892630DAa5eF601'
	},
	42161: {
		id: 42161,
		name: 'Arbitrum',
		rpcUrl: process.env.ARB_RPC_URL || 'https://arb1.arbitrum.io/rpc',
		bundlerUrl: process.env.ARB_BUNDLER_URL || '',
		// ERC-4337 contracts (same addresses via deterministic deployment)
		entryPoint:
			(process.env.ENTRY_POINT_ADDRESS as `0x${string}`) ||
			'0x0000000071727De22E5E9d8BAf0edAc6f37da032',
		nexusFactory:
			(process.env.NEXUS_ACCOUNT_FACTORY_ADDRESS as `0x${string}`) ||
			'0x0000006648ED9B2B842552BE63Af870bC74af837',
		nexusBootstrap:
			(process.env.NEXUS_BOOTSTRAP_ADDRESS as `0x${string}`) ||
			'0x0000003eDf18913c01cBc482C978bBD3D6E8ffA3',
		k1Validator:
			(process.env.K1_VALIDATOR_ADDRESS as `0x${string}`) ||
			'0x0000000031ef4155C978d48a8A7d4EDba03b04fE',
		// Chain-specific (need to be configured)
		paymaster: process.env.ARB_PAYMASTER_ADDRESS as `0x${string}`,
		feeRecipient: process.env.ARB_FEE_RECIPIENT as `0x${string}`,
		b402Relayer: process.env.ARB_B402_RELAYER_ADDRESS as `0x${string}`,
		// B402 Railgun fork (0% fees) — TODO: Replace with B402 fork proxy address after deploy
		// Deploy via: npx hardhat deploy:arb_zero_fees --network arbitrum --weth9 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1
		railgunRelay:
			(process.env.ARB_RAILGUN_RELAY as `0x${string}`) ||
			'0xFA7093CDD9EE6932B4eb2c9e1cde7CE00B1FA4b9'
	},
	84532: {
		id: 84532,
		name: 'Base Sepolia',
		rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
		bundlerUrl: process.env.BASE_SEPOLIA_BUNDLER_URL || '',
		// ERC-4337 contracts (same addresses via deterministic deployment)
		entryPoint:
			(process.env.ENTRY_POINT_ADDRESS as `0x${string}`) ||
			'0x0000000071727De22E5E9d8BAf0edAc6f37da032',
		nexusFactory:
			(process.env.NEXUS_ACCOUNT_FACTORY_ADDRESS as `0x${string}`) ||
			'0x0000006648ED9B2B842552BE63Af870bC74af837',
		nexusBootstrap:
			(process.env.NEXUS_BOOTSTRAP_ADDRESS as `0x${string}`) ||
			'0x0000003eDf18913c01cBc482C978bBD3D6E8ffA3',
		k1Validator:
			(process.env.K1_VALIDATOR_ADDRESS as `0x${string}`) ||
			'0x0000000031ef4155C978d48a8A7d4EDba03b04fE',
		// Chain-specific (need to be configured)
		paymaster: process.env.BASE_SEPOLIA_PAYMASTER_ADDRESS as `0x${string}`,
		feeRecipient: process.env.BASE_SEPOLIA_FEE_RECIPIENT as `0x${string}`,
		b402Relayer:
			(process.env.BASE_SEPOLIA_B402_RELAYER_ADDRESS as `0x${string}`) ||
			'0x7042bb0A617f0fe8100aB20e551cAA01C3295ab7', // RelayAdapt
		// B402 Railgun fork deployment (0% fees)
		railgunRelay: '0x2D8c0b26C1d7b0E04F2fbBB1b5E4783c3d153902'
	}
}

/**
 * Token configurations per chain
 *
 * Note: USDT on Arbitrum has 6 decimals, unlike BSC where it has 18.
 */
export const TOKENS: Record<SupportedChainId, Record<string, TokenConfig>> = {
	1: {
		USDC: {
			address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
			decimals: 6,
			symbol: 'USDC'
		}
	},
	56: {
		USDT: {
			address: '0x55d398326f99059fF775485246999027B3197955',
			decimals: 18,
			symbol: 'USDT'
		},
		USDC: {
			address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
			decimals: 18,
			symbol: 'USDC'
		},
		USD1: {
			address: '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d',
			decimals: 18,
			symbol: 'USD1'
		}
	},
	42161: {
		USDT: {
			address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
			decimals: 6,
			symbol: 'USDT'
		},
		USDC: {
			address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
			decimals: 6,
			symbol: 'USDC'
		}
	},
	84532: {
		WETH: {
			address: '0x4200000000000000000000000000000000000006',
			decimals: 18,
			symbol: 'WETH'
		}
	}
}

/**
 * Get current chain ID from environment variable
 * Defaults to BSC (56) if not specified
 */
export function getCurrentChainId(): SupportedChainId {
	const network = process.env.NETWORK?.toLowerCase()
	if (network === 'ethereum' || network === 'eth' || network === 'mainnet-eth') {
		return 1
	}
	if (network === 'arbitrum' || network === 'arb') {
		return 42161
	}
	if (network === 'base-sepolia' || network === 'basesepolia') {
		return 84532
	}
	return 56 // Default to BSC
}

/**
 * Get chain configuration for current environment
 */
export function getCurrentChain(): ChainConfig {
	return CHAINS[getCurrentChainId()]
}

/**
 * Get chain configuration by chain ID
 */
export function getChain(chainId: SupportedChainId): ChainConfig {
	const chain = CHAINS[chainId]
	if (!chain) {
		throw new Error(`Unsupported chain ID: ${chainId}`)
	}
	return chain
}

/**
 * Get token configuration for a chain
 */
export function getToken(chainId: SupportedChainId, symbol: string): TokenConfig | undefined {
	return TOKENS[chainId]?.[symbol.toUpperCase()]
}

/**
 * Get all tokens for a chain
 */
export function getTokens(chainId: SupportedChainId): Record<string, TokenConfig> {
	return TOKENS[chainId] || {}
}

/**
 * Check if a chain ID is supported
 */
export function isSupportedChain(chainId: number): chainId is SupportedChainId {
	return chainId === 1 || chainId === 56 || chainId === 42161 || chainId === 84532
}

/**
 * Get token by address for a specific chain
 */
export function getTokenByAddress(
	chainId: SupportedChainId,
	address: string
): TokenConfig | undefined {
	const tokens = TOKENS[chainId]
	if (!tokens) return undefined

	const normalizedAddress = address.toLowerCase()
	return Object.values(tokens).find((token) => token.address.toLowerCase() === normalizedAddress)
}
