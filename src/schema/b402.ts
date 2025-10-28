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
