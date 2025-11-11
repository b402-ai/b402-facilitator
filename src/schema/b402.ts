// Authorization structure for EIP-712
export const AuthorizationSchema = {
	type: 'object',
	properties: {
		from: { type: 'string' },
		to: { type: 'string' },
		value: { type: 'string' },
		validAfter: { type: 'number' },
		validBefore: { type: 'number' },
		nonce: { type: 'string' }
	},
	required: ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce'],
	additionalProperties: false
} as const

// Payment Payload
export const PaymentPayloadSchema = {
	type: 'object',
	properties: {
		token: { type: 'string' },
		payload: {
			type: 'object',
			properties: {
				authorization: AuthorizationSchema,
				signature: { type: 'string' }
			},
			required: ['authorization', 'signature'],
			additionalProperties: false
		}
	},
	required: ['token', 'payload'],
	additionalProperties: false
} as const

// Payment Requirements
export const PaymentRequirementsSchema = {
	type: 'object',
	properties: {
		network: { type: 'string' },
		relayerContract: { type: 'string' }
	},
	required: ['network', 'relayerContract'],
	additionalProperties: false
} as const

// POST /verify - Request
export const VerifyRequestSchema = {
	type: 'object',
	properties: {
		paymentPayload: PaymentPayloadSchema,
		paymentRequirements: PaymentRequirementsSchema
	},
	required: ['paymentPayload', 'paymentRequirements'],
	additionalProperties: false
} as const

// POST /verify - Response (success)
export const VerifyResponseSchema = {
	type: 'object',
	properties: {
		isValid: { type: 'boolean' },
		payer: { type: 'string' },
		invalidReason: { type: 'string' }
	},
	required: ['isValid'],
	additionalProperties: false
} as const

// POST /settle - Request
export const SettleRequestSchema = {
	type: 'object',
	properties: {
		paymentPayload: PaymentPayloadSchema,
		paymentRequirements: PaymentRequirementsSchema
	},
	required: ['paymentPayload', 'paymentRequirements'],
	additionalProperties: false
} as const

// POST /settle - Response (success)
export const SettleResponseSchema = {
	type: 'object',
	properties: {
		success: { type: 'boolean' },
		transaction: { type: 'string' },
		network: { type: 'string' },
		payer: { type: 'string' },
		blockNumber: { type: 'number' },
		errorReason: { type: 'string' }
	},
	required: ['success', 'network'],
	additionalProperties: false
} as const

// GET /health - Response
export const HealthResponseSchema = {
	type: 'object',
	properties: {
		status: { type: 'string' },
		service: { type: 'string' },
		network: { type: 'string' },
		relayer: { type: 'string' }
	},
	required: ['status', 'service', 'network', 'relayer'],
	additionalProperties: false
} as const

// TypeScript interfaces
export interface Authorization {
	from: string
	to: string
	value: string
	validAfter: number
	validBefore: number
	nonce: string
}

export interface PaymentPayload {
	token: string
	payload: {
		authorization: Authorization
		signature: string
	}
}

export interface PaymentRequirements {
	network: string
	relayerContract: string
}

export interface VerifyRequest {
	paymentPayload: PaymentPayload
	paymentRequirements: PaymentRequirements
}

export interface VerifyResponse {
	isValid: boolean
	payer?: string
	invalidReason?: string
}

export interface SettleRequest {
	paymentPayload: PaymentPayload
	paymentRequirements: PaymentRequirements
}

export interface SettleResponse {
	success: boolean
	transaction?: string
	network: string
	payer?: string
	blockNumber?: number
	errorReason?: string
}

export interface HealthResponse {
	status: string
	service: string
	network: string
	relayer: string
}

// ============================================================================
// Smart Wallet Schemas
// ============================================================================

// POST /wallet/create - Request
export const CreateWalletRequestSchema = {
	type: 'object',
	properties: {
		ownerAddress: { type: 'string' }
	},
	required: ['ownerAddress'],
	additionalProperties: false
} as const

// POST /wallet/create - Response
export const CreateWalletResponseSchema = {
	type: 'object',
	properties: {
		walletAddress: { type: 'string' },
		txHash: { type: 'string' }
	},
	required: ['walletAddress', 'txHash'],
	additionalProperties: false
} as const

// Transaction schema for batch payments
export const TransactionSchema = {
	type: 'object',
	properties: {
		to: { type: 'string' },
		amount: { type: 'string' },
		token: { type: 'string' }
	},
	required: ['to', 'amount', 'token'],
	additionalProperties: false
} as const

// POST /wallet/verify - Request
export const VerifyWalletPaymentRequestSchema = {
	type: 'object',
	properties: {
		walletAddress: { type: 'string' },
		transactions: {
			type: 'array',
			items: TransactionSchema,
			minItems: 1
		}
	},
	required: ['walletAddress', 'transactions'],
	additionalProperties: false
} as const

// POST /wallet/verify - Response
export const VerifyWalletPaymentResponseSchema = {
	type: 'object',
	properties: {
		userOp: {
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
			required: [
				'sender',
				'nonce',
				'initCode',
				'callData',
				'callGasLimit',
				'verificationGasLimit',
				'preVerificationGas',
				'maxFeePerGas',
				'maxPriorityFeePerGas',
				'paymasterAndData',
				'signature'
			],
			additionalProperties: false
		},
		userOpHash: { type: 'string' },
		feeAmount: { type: 'string' },
		totalAmount: { type: 'string' }
	},
	required: ['userOp', 'userOpHash', 'feeAmount', 'totalAmount'],
	additionalProperties: false
} as const

// POST /wallet/settle - Request
export const SettleWalletPaymentRequestSchema = {
	type: 'object',
	properties: {
		userOp: {
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
			required: [
				'sender',
				'nonce',
				'initCode',
				'callData',
				'callGasLimit',
				'verificationGasLimit',
				'preVerificationGas',
				'maxFeePerGas',
				'maxPriorityFeePerGas',
				'paymasterAndData',
				'signature'
			],
			additionalProperties: false
		},
		signature: { type: 'string' }
	},
	required: ['userOp', 'signature'],
	additionalProperties: false
} as const

// Payment detail schema
export const PaymentDetailSchema = {
	type: 'object',
	properties: {
		recipient: { type: 'string' },
		amount: { type: 'string' },
		isProtocolFee: { type: 'boolean' }
	},
	required: ['recipient', 'amount', 'isProtocolFee'],
	additionalProperties: false
} as const

// POST /wallet/settle - Response
export const SettleWalletPaymentResponseSchema = {
	type: 'object',
	properties: {
		txHash: { type: 'string' },
		userOpHash: { type: 'string' },
		payments: {
			type: 'array',
			items: PaymentDetailSchema,
			minItems: 1
		}
	},
	required: ['txHash', 'userOpHash', 'payments'],
	additionalProperties: false
} as const

// TypeScript interfaces for wallet endpoints
export interface CreateWalletRequest {
	ownerAddress: string
}

export interface CreateWalletResponse {
	walletAddress: string
	txHash: string
}

export interface Transaction {
	to: string
	amount: string
	token: string
}

export interface VerifyWalletPaymentRequest {
	walletAddress: string
	transactions: Transaction[]
}

export interface UserOperation {
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

export interface VerifyWalletPaymentResponse {
	userOp: UserOperation
	userOpHash: string
	feeAmount: string
	totalAmount: string
}

export interface SettleWalletPaymentRequest {
	userOp: UserOperation
	signature: string
}

export interface PaymentDetail {
	recipient: string
	amount: string
	isProtocolFee: boolean
}

export interface SettleWalletPaymentResponse {
	txHash: string
	userOpHash: string
	payments: PaymentDetail[]
}
