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
	}
} as const

const CHAIN_CONFIGS = {
	bsc: { chainId: 56, name: 'bsc' },
	base: { chainId: 8453, name: 'base' }
} as const

type NetworkName = keyof typeof tokensByNetwork

const network = (process.env.NETWORK || 'bsc') as NetworkName

export const SUPPORTED_TOKENS = tokensByNetwork[network]
export const CHAIN_CONFIG = CHAIN_CONFIGS[network]

export type SupportedTokenSymbol = keyof (typeof tokensByNetwork)[NetworkName]
