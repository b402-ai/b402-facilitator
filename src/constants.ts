export const B402_RELAYER_ABI = [
	'function transferWithAuthorization(address token, address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes memory signature) external',
	'function authorizationState(address authorizer, bytes32 nonce) external view returns (bool)',
	'function batchTransferWithUserOp(address token, address[] recipients, uint256[] amounts, uint256 validAfter, uint256 validBefore, bytes32 nonce) external'
]

export const SUPPORTED_TOKENS = {
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
} as const

export type SupportedTokenSymbol = keyof typeof SUPPORTED_TOKENS
