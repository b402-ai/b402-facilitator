// Swap Quote Query Parameters
export const SwapQuoteQuerySchema = {
	type: 'object',
	properties: {
		tokenIn: { type: 'string' },
		tokenOut: { type: 'string' },
		amountIn: { type: 'string' }
	},
	required: ['tokenIn', 'tokenOut', 'amountIn']
} as const

// Swap Quote Response
export const SwapQuoteResponseSchema = {
	type: 'object',
	properties: {
		amountIn: { type: 'string' },
		amountOut: { type: 'string' },
		minAmountOut: { type: 'string' },
		priceImpact: { type: 'string' },
		fee: { type: 'number' },
		route: {
			type: 'object',
			properties: {
				path: { type: 'array', items: { type: 'string' } },
				poolFees: { type: 'array', items: { type: 'number' } }
			}
		}
	},
	required: ['amountIn', 'amountOut', 'minAmountOut', 'fee']
} as const

// Swap Health Response
export const SwapHealthResponseSchema = {
	type: 'object',
	properties: {
		status: { type: 'string' },
		serverWallet: { type: 'string' },
		bnbBalance: { type: 'string' },
		chainId: { type: 'number' },
		router: { type: 'string' },
		version: { type: 'string' }
	},
	required: ['status', 'serverWallet', 'bnbBalance']
} as const

// Payment Authorization (reuse pattern from b402.ts)
const PaymentAuthorizationSchema = {
	type: 'object',
	properties: {
		from: { type: 'string' },
		to: { type: 'string' },
		value: { type: 'string' },
		validAfter: { type: 'number' },
		validBefore: { type: 'number' },
		nonce: { type: 'string' }
	},
	required: ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce']
} as const

// Payment Signature for Swap
const PaymentSignatureSchema = {
	type: 'object',
	properties: {
		token: { type: 'string' },
		payload: {
			type: 'object',
			properties: {
				authorization: PaymentAuthorizationSchema,
				signature: { type: 'string' }
			},
			required: ['authorization', 'signature']
		}
	},
	required: ['token', 'payload']
} as const

// POST /swap - Request
export const SwapRequestSchema = {
	type: 'object',
	properties: {
		user: { type: 'string' },
		tokenIn: { type: 'string' },
		tokenOut: { type: 'string' },
		amountIn: { type: 'string' },
		minAmountOut: { type: 'string' },
		fee: { type: 'number' },
		paymentSignature: PaymentSignatureSchema
	},
	required: ['user', 'tokenIn', 'tokenOut', 'amountIn', 'paymentSignature']
} as const

// POST /swap - Response
export const SwapResponseSchema = {
	type: 'object',
	properties: {
		success: { type: 'boolean' },
		txHash: { type: 'string' },
		explorerUrl: { type: 'string' },
		amountIn: { type: 'string' },
		amountOut: { type: 'string' },
		error: { type: 'string' }
	},
	required: ['success']
} as const

// POST /swap/payment-intent - Request
export const SwapPaymentIntentRequestSchema = {
	type: 'object',
	properties: {
		user: { type: 'string' },
		tokenIn: { type: 'string' },
		amountIn: { type: 'string' }
	},
	required: ['user', 'tokenIn', 'amountIn']
} as const

// POST /swap/payment-intent - Response
export const SwapPaymentIntentResponseSchema = {
	type: 'object',
	properties: {
		domain: { type: 'object', additionalProperties: true },
		types: { type: 'object', additionalProperties: true },
		value: { type: 'object', additionalProperties: true },
		feeBreakdown: { type: 'object', additionalProperties: true }
	},
	required: ['domain', 'types', 'value']
} as const

// POST /swap/gasless-approve - Request
export const SwapGaslessApproveRequestSchema = {
	type: 'object',
	properties: {
		tokenAddress: { type: 'string' },
		owner: { type: 'string' },
		spender: { type: 'string' },
		value: { type: 'string' },
		deadline: { type: 'number' },
		v: { type: 'number' },
		r: { type: 'string' },
		s: { type: 'string' }
	},
	required: ['tokenAddress', 'owner', 'spender', 'value', 'deadline', 'v', 'r', 's']
} as const

// POST /swap/gasless-approve - Response
export const SwapGaslessApproveResponseSchema = {
	type: 'object',
	properties: {
		success: { type: 'boolean' },
		txHash: { type: 'string' },
		error: { type: 'string' }
	},
	required: ['success']
} as const

// UserOperation Schema (for execute endpoints)
const UserOperationSchema = {
	type: 'object',
	properties: {
		sender: { type: 'string' },
		nonce: { type: 'string' },
		initCode: { type: 'string' },
		callData: { type: 'string' },
		callGasLimit: { type: 'string' },
		verificationGasLimit: { type: 'string' },
		preVerificationGas: { type: 'string' },
		maxFeePerGas: { type: 'string' },
		maxPriorityFeePerGas: { type: 'string' },
		paymasterAndData: { type: 'string' },
		signature: { type: 'string' }
	},
	required: ['sender', 'nonce', 'callData']
} as const

// POST /swap/wallet/verify - Request
export const SwapWalletVerifyRequestSchema = {
	type: 'object',
	properties: {
		walletAddress: { type: 'string' },
		tokenIn: { type: 'string' },
		tokenOut: { type: 'string' },
		amountIn: { type: 'string' }
	},
	required: ['walletAddress', 'tokenIn', 'tokenOut', 'amountIn']
} as const

// POST /swap/wallet/verify - Response
export const SwapWalletVerifyResponseSchema = {
	type: 'object',
	properties: {
		isValid: { type: 'boolean' },
		userOp: { type: 'object', additionalProperties: true },
		userOpHash: { type: 'string' },
		quote: { type: 'object', additionalProperties: true },
		serverWallet: { type: 'string' },
		error: { type: 'string' }
	},
	required: ['isValid']
} as const

// Swap params for wallet/settle
const SwapParamsSchema = {
	type: 'object',
	properties: {
		user: { type: 'string' },
		tokenIn: { type: 'string' },
		tokenOut: { type: 'string' },
		amountIn: { type: 'string' },
		minAmountOut: { type: 'string' },
		fee: { type: 'number' }
	},
	required: ['user', 'tokenIn', 'tokenOut', 'amountIn', 'minAmountOut']
} as const

// POST /swap/wallet/settle - Request
export const SwapWalletSettleRequestSchema = {
	type: 'object',
	properties: {
		userOp: UserOperationSchema,
		signature: { type: 'string' },
		swapParams: SwapParamsSchema
	},
	required: ['userOp', 'signature', 'swapParams']
} as const

// POST /swap/wallet/settle - Response
export const SwapWalletSettleResponseSchema = {
	type: 'object',
	properties: {
		success: { type: 'boolean' },
		transferTxHash: { type: 'string' },
		swapTxHash: { type: 'string' },
		explorerUrl: { type: 'string' },
		error: { type: 'string' },
		stats: { type: 'object', additionalProperties: true }
	},
	required: ['success']
} as const

// Type exports for controller usage
export type SwapQuoteQuery = {
	tokenIn: string
	tokenOut: string
	amountIn: string
}

export type SwapPaymentIntentRequest = {
	user: string
	tokenIn: string
	amountIn: string
}

export type SwapGaslessApproveRequest = {
	tokenAddress: string
	owner: string
	spender: string
	value: string
	deadline: number
	v: number
	r: string
	s: string
}

export type SwapWalletVerifyRequest = {
	walletAddress: string
	tokenIn: string
	tokenOut: string
	amountIn: string
}

export type SwapWalletSettleRequest = {
	userOp: {
		sender: string
		nonce: string
		initCode: string
		callData: string
		callGasLimit: string
		verificationGasLimit: string
		preVerificationGas: string
		maxFeePerGas: string
		maxPriorityFeePerGas: string
		paymasterAndData: string
		signature: string
	}
	signature: string
	swapParams: {
		user: string
		tokenIn: string
		tokenOut: string
		amountIn: string
		minAmountOut: string
		fee?: number
	}
}
