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
	| 'wallet_error'
	| 'userp_error'

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
	configuration_error: 500,
	wallet_error: 400,
	userp_error: 500
}

export interface ErrorResponse {
	error: {
		code: ErrorCodes
		message: string
		doc_url?: string
		details?: unknown
	}
}

const docErrorUrl = 'https://b402.ai'

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
	},

	// Smart wallet errors
	ERR_INVALID_ADDRESS: {
		code: 'validation_error' as const,
		message: 'Invalid address provided'
	},
	ERR_WALLET_ALREADY_DEPLOYED: {
		code: 'wallet_error' as const,
		message: 'Wallet already deployed'
	},
	ERR_WALLET_NOT_DEPLOYED: {
		code: 'wallet_error' as const,
		message: 'Wallet not deployed'
	},
	ERR_UNSUPPORTED_TOKEN: {
		code: 'token_error' as const,
		message: 'Token not supported'
	},
	ERR_INSUFFICIENT_ALLOWANCE: {
		code: 'token_error' as const,
		message: 'Insufficient token allowance'
	},
	ERR_FEE_VALIDATION_FAILED: {
		code: 'validation_error' as const,
		message: 'Fee validation failed'
	},
	ERR_USEROP_CREATION_FAILED: {
		code: 'userp_error' as const,
		message: 'Failed to create UserOperation'
	},
	ERR_INVALID_USEROP: {
		code: 'validation_error' as const,
		message: 'Invalid UserOperation structure'
	},
	ERR_BUNDLER_SUBMISSION_FAILED: {
		code: 'userp_error' as const,
		message: 'Failed to submit to bundler'
	},
	ERR_PAYMASTER_SIGNING_FAILED: {
		code: 'userp_error' as const,
		message: 'Failed to sign as paymaster'
	},

	// Array and transaction validation errors
	ERR_ARRAY_LENGTH_MISMATCH: {
		code: 'validation_error' as const,
		message: 'Recipients and amounts arrays must have same length'
	},
	ERR_EMPTY_TRANSACTIONS: {
		code: 'validation_error' as const,
		message: 'At least one transaction required'
	},
	ERR_MULTIPLE_TOKENS_NOT_ALLOWED: {
		code: 'validation_error' as const,
		message: 'All transactions must use the same token'
	},
	ERR_RECIPIENT_REQUIRED: {
		code: 'validation_error' as const,
		message: 'Must have at least one recipient'
	},
	ERR_TOO_MANY_TRANSACTIONS: {
		code: 'validation_error' as const,
		message: 'Too many transactions, maximum 20'
	},
	ERR_INVALID_RECIPIENT_ADDRESS: {
		code: 'validation_error' as const,
		message: 'Invalid recipient address'
	},
	ERR_ZERO_ADDRESS_RECIPIENT: {
		code: 'validation_error' as const,
		message: 'Recipient cannot be zero address'
	},
	ERR_INVALID_AMOUNT: {
		code: 'validation_error' as const,
		message: 'Invalid amount'
	},

	// Token balance errors
	ERR_INSUFFICIENT_BALANCE: {
		code: 'token_error' as const,
		message: 'Insufficient token balance'
	},

	// Bundler errors
	ERR_BUNDLER_REQUEST_FAILED: {
		code: 'userp_error' as const,
		message: 'Bundler request failed'
	},
	ERR_BUNDLER_ERROR: {
		code: 'userp_error' as const,
		message: 'Bundler returned an error'
	},
	ERR_NO_RECEIPT: {
		code: 'userp_error' as const,
		message: 'No receipt returned from bundler'
	},

	// Paymaster errors
	ERR_PAYMASTER_VALIDATION_FAILED: {
		code: 'userp_error' as const,
		message: 'Paymaster validation failed'
	},

	// Provider errors
	ERR_PROVIDER_NOT_INITIALIZED: {
		code: 'configuration_error' as const,
		message: 'Provider service not initialized'
	},

	// Environment errors
	ERR_MISSING_ENV_VARS: {
		code: 'configuration_error' as const,
		message: 'Missing required environment variables'
	},

	// Gas estimation errors
	ERR_GAS_ESTIMATION_FAILED: {
		code: 'userp_error' as const,
		message: 'Gas estimation failed'
	},
	ERR_GAS_ESTIMATION_PARSE_FAILED: {
		code: 'userp_error' as const,
		message: 'Failed to parse gas estimation response'
	},
	ERR_GAS_ESTIMATION_ERROR: {
		code: 'userp_error' as const,
		message: 'Gas estimation returned an error'
	},
	ERR_GAS_ESTIMATION_NO_RESULT: {
		code: 'userp_error' as const,
		message: 'Gas estimation returned no result'
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
