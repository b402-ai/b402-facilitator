export const B402_RELAYER_ABI = [
	'function transferWithAuthorization(address token, address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes memory signature) external',
	'function authorizationState(address authorizer, bytes32 nonce) external view returns (bool)',
	'function batchTransferWithUserOp(address token, address[] recipients, uint256[] amounts, uint256 validAfter, uint256 validBefore, bytes32 nonce) external'
]

const tokensByNetwork = {
	bsc: {
		USDT: {
			symbol: 'USDT',
			address: '0x55d398326f99059fF775485246999027B3197955',
			decimals: 18
		},
		USDC: {
			symbol: 'USDC',
			address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
			decimals: 18
		},
		USD1: {
			symbol: 'USD1',
			address: '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d',
			decimals: 18
		}
	},
	base: {
		USDC: {
			symbol: 'USDC',
			address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
			decimals: 6
		},
		USDT: {
			symbol: 'USDT',
			address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
			decimals: 6
		}
	},
	arb: {
		USDC: {
			symbol: 'USDC',
			address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
			decimals: 6
		},
		USDT: {
			symbol: 'USDT',
			address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
			decimals: 6
		}
	},
	eth: {
		USDC: {
			symbol: 'USDC',
			address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
			decimals: 6
		},
		USDT: {
			symbol: 'USDT',
			address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
			decimals: 6
		}
	},
	robinhood: {
		// Robinhood Chain (4663) · USDG is the quote/collateral token for the RWA option pools (EIP-3009 capable).
		USDG: {
			symbol: 'USDG',
			address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
			decimals: 6
		}
	}
} as const

const CHAIN_CONFIGS = {
	bsc: { chainId: 56, name: 'bsc' },
	base: { chainId: 8453, name: 'base' },
	arb: { chainId: 42161, name: 'arb' },
	eth: { chainId: 1, name: 'eth' },
	robinhood: { chainId: 4663, name: 'robinhood' }
} as const

type NetworkName = keyof typeof tokensByNetwork

// Normalize NETWORK env to the canonical lowercase key used in tokensByNetwork.
// Accepts:  'bsc' | 'base' | 'arbitrum' | 'arb' (case-insensitive)
function normalizeNetwork(raw: string): NetworkName {
	const lower = raw.toLowerCase()
	if (lower === 'ethereum' || lower === 'eth' || lower === 'mainnet-eth') return 'eth'
	if (lower === 'arbitrum' || lower === 'arb') return 'arb'
	if (lower === 'base' || lower === 'base-mainnet') return 'base'
	if (lower === 'bsc' || lower === 'bnb' || lower === 'bsc-mainnet') return 'bsc'
	if (lower === 'robinhood' || lower === 'rh' || lower === 'robinhood-chain') return 'robinhood'
	const supported = Object.keys(tokensByNetwork).join(', ')
	throw new Error(`Invalid NETWORK "${raw}". Supported: ${supported}, arbitrum`)
}

const network = normalizeNetwork(process.env.NETWORK || 'bsc')

export const SUPPORTED_TOKENS = tokensByNetwork[network]
export const CHAIN_CONFIG = CHAIN_CONFIGS[network]

export type SupportedTokenSymbol = keyof typeof SUPPORTED_TOKENS
