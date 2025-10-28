import type { FastifyReply } from 'fastify'

export type ErrorCodes =
	| 'bad_request'
	| 'not_found'
	| 'internal_server_error'
	| 'unauthorized'
	| 'forbidden'
	| 'rate_limit_exceeded'
	| 'unprocessable_entity'
	| 'validation_error'
	| 'payment_verification_error'
	| 'payment_settlement_error'
	| 'blockchain_error'
	| 'signature_error'
	| 'nonce_error'
	| 'token_error'
	| 'configuration_error'

const errorCodeToHttpStatus: Record<ErrorCodes, number> = {
	bad_request: 400,
	unauthorized: 401,
	forbidden: 403,
	not_found: 404,
	unprocessable_entity: 422,
	rate_limit_exceeded: 429,
	internal_server_error: 500,
	validation_error: 400,
	payment_verification_error: 400,
	payment_settlement_error: 500,
	blockchain_error: 500,
	signature_error: 401,
	nonce_error: 400,
	token_error: 400,
	configuration_error: 500
}

export interface ErrorResponse {
	error: {
		code: ErrorCodes
		message: string
		doc_url?: string
		details?: unknown
	}
}

const docErrorUrl = 'https://docs.b402.org/errors'

export class B402ApiError extends Error {
	public readonly code: ErrorCodes
	public readonly docUrl?: string
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	public readonly details?: any

	constructor({
		code,
		message,
		docUrl,
		details
	}: {
		code: ErrorCodes
		message: string
		docUrl?: string
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		details?: unknown
	}) {
		super(message)
		this.code = code
		this.docUrl = docUrl ?? `${docErrorUrl}#${code}`
		this.details = details
	}
}

export function fromValidationError(error: unknown): ErrorResponse {
	const err = error as { message?: string; validation?: unknown; details?: unknown }
	return {
		error: {
			code: 'validation_error',
			message: err.message || 'Validation failed',
			doc_url: `${docErrorUrl}#validation_error`,
			details: err.validation || err.details
		}
	}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function handleApiError(error: any): ErrorResponse & { status: number } {
	console.error('API error occurred', error)

	// Handle Fastify validation errors
	if (error.validation) {
		return {
			...fromValidationError(error),
			status: errorCodeToHttpStatus.validation_error
		}
	}

	// Handle Fastify JSON parsing errors
	if (error instanceof SyntaxError && 'statusCode' in error && error.statusCode) {
		return {
			error: {
				code: 'validation_error',
				message: 'Invalid JSON in request body',
				doc_url: `${docErrorUrl}#validation_error`
			},
			status: error.statusCode as number
		}
	}

	if (error instanceof B402ApiError) {
		return {
			error: {
				code: error.code,
				message: error.message,
				doc_url: error.docUrl,
				details: error.details
			},
			status: errorCodeToHttpStatus[error.code]
		}
	}

	return {
		error: {
			code: 'internal_server_error',
			message: 'An internal server error occurred. Please contact support if the problem persists.',
			doc_url: `${docErrorUrl}#internal_server_error`
		},
		status: 500
	}
}

export function handleAndReturnErrorResponse(reply: FastifyReply, err: unknown) {
	const { error, status } = handleApiError(err)
	return reply.status(status).send({ error })
}

export const errorSchemaFactory = (code: ErrorCodes, description: string) => {
	return {
		description,
		content: {
			'application/json': {
				schema: {
					type: 'object',
					properties: {
						error: {
							type: 'object',
							properties: {
								code: {
									type: 'string',
									enum: [code],
									description: 'A short code indicating the error code returned.',
									example: code
								},
								message: {
									type: 'string',
									description: 'A human readable explanation of what went wrong.',
									example: 'The request contains invalid data.'
								},
								doc_url: {
									type: 'string',
									description:
										'A link to our documentation with more details about this error code',
									example: `${docErrorUrl}#${code}`
								},
								details: {
									type: 'array',
									description: 'Additional error details',
									items: { type: 'object' }
								}
							},
							required: ['code', 'message']
						}
					},
					required: ['error']
				}
			}
		}
	}
}

const errorCodesConfig = {
	// Payment verification errors
	ERR_MISSING_PAYMENT_PAYLOAD: {
		code: 'validation_error' as const,
		message: 'Missing paymentPayload or paymentRequirements'
	},
	ERR_INVALID_SIGNATURE: {
		code: 'signature_error' as const,
		message: 'Invalid signature'
	},
	ERR_SIGNATURE_VERIFICATION_FAILED: {
		code: 'signature_error' as const,
		message: 'Signature verification failed'
	},
	ERR_NONCE_ALREADY_USED: {
		code: 'nonce_error' as const,
		message: 'Nonce already used'
	},
	ERR_AUTHORIZATION_NOT_VALID_YET: {
		code: 'payment_verification_error' as const,
		message: 'Authorization not yet valid'
	},
	ERR_AUTHORIZATION_EXPIRED: {
		code: 'payment_verification_error' as const,
		message: 'Authorization expired'
	},
	ERR_AUTHORIZATION_STATE_CHECK_FAILED: {
		code: 'blockchain_error' as const,
		message: 'Failed to check authorization state on-chain'
	},

	// Payment settlement errors
	ERR_SETTLEMENT_FAILED: {
		code: 'payment_settlement_error' as const,
		message: 'Failed to settle payment on-chain'
	},
	ERR_BLOCKCHAIN_TRANSACTION_FAILED: {
		code: 'blockchain_error' as const,
		message: 'Blockchain transaction failed'
	},
	ERR_TRANSACTION_CONFIRMATION_FAILED: {
		code: 'blockchain_error' as const,
		message: 'Transaction confirmation failed'
	},

	// Token errors
	ERR_TOKEN_INFO_FETCH_FAILED: {
		code: 'token_error' as const,
		message: 'Could not fetch token information'
	},

	// Configuration errors
	ERR_MISSING_RELAYER_CONFIG: {
		code: 'configuration_error' as const,
		message: 'Missing relayer configuration'
	},
	ERR_INVALID_NETWORK: {
		code: 'configuration_error' as const,
		message: 'Invalid network configuration'
	},

	// Generic errors
	ERR_INTERNAL_SERVER_ERROR: {
		code: 'internal_server_error' as const,
		message: 'An unexpected error occurred. Please try again.'
	}
} as const

/**
 * Create error classes from `errorCodesConfig`
 *
 * @param config
 * @returns
 */
function createErrorClasses<T extends Record<string, { code: ErrorCodes; message: string }>>(
	config: T
): {
	[K in keyof T]: new () => B402ApiError
} {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const errorClasses = {} as any

	for (const [errorKey, errorConfig] of Object.entries(config)) {
		errorClasses[errorKey] = class extends B402ApiError {
			constructor() {
				super({
					code: errorConfig.code,
					message: errorConfig.message
				})
			}
		}
	}

	return errorClasses
}

export const BaseErrors = createErrorClasses(errorCodesConfig)
