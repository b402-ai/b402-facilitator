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
		relayerContract: { type: 'string' },
		deployment: {
			type: 'object',
			properties: {
				ownerAddress: { type: 'string' },
				salts: {
					type: 'array',
					items: { type: 'string' },
					minItems: 1,
					maxItems: 10
				},
				fundingRequested: { type: 'boolean' }
			},
			required: ['ownerAddress', 'salts'],
			additionalProperties: false
		}
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

// POST /deploy/verify - Request (EOA payment)
export const DeployEOAVerifyRequestSchema = {
	type: 'object',
	properties: {
		paymentPayload: {
			type: 'array',
			items: PaymentPayloadSchema,
			minItems: 1,
			maxItems: 11 // 1 fee payment + up to 10 funding payments
		},
		paymentRequirements: PaymentRequirementsSchema
	},
	required: ['paymentPayload', 'paymentRequirements'],
	additionalProperties: false
} as const

// POST /deploy/wallet/verify - Request (Smart wallet payment)
export const DeployWalletVerifyRequestSchema = {
	type: 'object',
	properties: {
		userOp: { type: 'object' }, // UserOperation - not fully validated here
		paymentRequirements: PaymentRequirementsSchema
	},
	required: ['userOp', 'paymentRequirements'],
	additionalProperties: false
} as const

// POST /wallet/deploy/verify - Response
export const DeployWalletsVerifyResponseSchema = {
	type: 'object',
	properties: {
		isValid: { type: 'boolean' },
		payer: { type: 'string' },
		wallets: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					address: { type: 'string' },
					salt: { type: 'string' },
					owner: { type: 'string' },
					fundingAmount: { type: 'string' }
				},
				required: ['address', 'salt', 'owner'],
				additionalProperties: false
			}
		},
		deploymentFee: { type: 'string' },
		fundingFees: { type: 'string' },
		totalFees: { type: 'string' },
		userOp: { type: 'object', additionalProperties: true },
		invalidReason: { type: 'string' }
	},
	required: ['isValid', 'wallets', 'deploymentFee'],
	additionalProperties: true
} as const

// POST /deploy/settle - Request (EOA payment)
export const DeployEOASettleRequestSchema = {
	type: 'object',
	properties: {
		paymentPayload: {
			type: 'array',
			items: PaymentPayloadSchema,
			minItems: 1,
			maxItems: 11
		},
		paymentRequirements: PaymentRequirementsSchema,
		wallets: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					address: { type: 'string' },
					salt: { type: 'string' },
					owner: { type: 'string' },
					fundingAmount: { type: 'string' }
				},
				required: ['address', 'salt', 'owner'],
				additionalProperties: false
			},
			minItems: 1,
			maxItems: 10
		}
	},
	required: ['paymentPayload', 'paymentRequirements', 'wallets'],
	additionalProperties: false
} as const

// POST /deploy/wallet/settle - Request (Smart wallet payment)
export const DeployWalletSettleRequestSchema = {
	type: 'object',
	properties: {
		userOp: { type: 'object' },
		signature: { type: 'string' },
		paymentRequirements: PaymentRequirementsSchema,
		wallets: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					address: { type: 'string' },
					salt: { type: 'string' },
					owner: { type: 'string' },
					fundingAmount: { type: 'string' }
				},
				required: ['address', 'salt', 'owner'],
				additionalProperties: false
			},
			minItems: 1,
			maxItems: 10
		}
	},
	required: ['userOp', 'signature', 'paymentRequirements', 'wallets'],
	additionalProperties: false
} as const

// POST /wallet/deploy/settle - Response
export const DeployWalletsResponseSchema = {
	type: 'object',
	properties: {
		paymentSuccess: { type: 'boolean' },
		deploymentSuccess: { type: 'boolean' },
		fundingSuccess: { type: 'boolean' },
		wallets: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					address: { type: 'string' },
					salt: { type: 'string' },
					owner: { type: 'string' },
					deploymentTxHash: { type: 'string' },
					fundingAmount: { type: 'string' },
					fundingTxHash: { type: 'string' },
					fundingCompleted: { type: 'boolean' }
				},
				required: ['address', 'salt', 'owner'],
				additionalProperties: false
			}
		},
		failedWallets: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					address: { type: 'string' },
					salt: { type: 'string' },
					owner: { type: 'string' },
					deploymentTxHash: { type: 'string' }
				},
				required: ['address', 'salt', 'owner'],
				additionalProperties: false
			}
		},
		failedFundings: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					address: { type: 'string' },
					salt: { type: 'string' },
					owner: { type: 'string' },
					fundingAmount: { type: 'string' }
				},
				required: ['address', 'salt', 'owner'],
				additionalProperties: false
			}
		},
		paymentTxHash: { type: 'string' },
		deploymentFee: { type: 'string' }
	},
	required: [
		'paymentSuccess',
		'deploymentSuccess',
		'fundingSuccess',
		'wallets',
		'paymentTxHash',
		'deploymentFee'
	],
	additionalProperties: false
} as const

// POST /wallet/claim - Request
export const ClaimWalletDeploymentRequestSchema = {
	type: 'object',
	properties: {
		paymentTxHash: { type: 'string' },
		payerAddress: { type: 'string' }
	},
	additionalProperties: false
} as const

// POST /wallet/claim - Response
export const ClaimWalletDeploymentResponseSchema = {
	type: 'object',
	properties: {
		success: { type: 'boolean' },
		wallets: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					address: { type: 'string' },
					salt: { type: 'string' },
					owner: { type: 'string' }
				},
				required: ['address', 'salt', 'owner'],
				additionalProperties: false
			}
		},
		deploymentTxHash: { type: 'string' },
		network: { type: 'string' },
		errorReason: { type: 'string' }
	},
	required: ['success', 'wallets', 'deploymentTxHash', 'network'],
	additionalProperties: false
} as const

// GET /wallet/:owner - Response
export const GetWalletsByOwnerResponseSchema = {
	type: 'object',
	properties: {
		wallets: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					ownerAddress: { type: 'string' },
					walletAddress: { type: 'string' },
					salt: { type: 'string' },
					payerAddress: { type: 'string' },
					paymentTxHash: { type: 'string' },
					deploymentTxHash: { type: 'string' },
					paymentCompleted: { type: 'boolean' },
					deploymentCompleted: { type: 'boolean' },
					createdAt: { type: 'string' },
					updatedAt: { type: 'string' }
				},
				required: [
					'ownerAddress',
					'walletAddress',
					'salt',
					'payerAddress',
					'paymentTxHash',
					'paymentCompleted',
					'deploymentCompleted',
					'createdAt',
					'updatedAt'
				],
				additionalProperties: false
			}
		}
	},
	required: ['wallets'],
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
		},
		paymentRequirements: {
			type: 'object',
			properties: {
				network: { type: 'string' }
			},
			additionalProperties: false
		}
	},
	required: ['walletAddress', 'transactions'],
	additionalProperties: false
} as const

// POST /wallet/verify - Response
export const VerifyWalletPaymentResponseSchema = {
	type: 'object',
	properties: {
		isValid: { type: 'boolean' },
		payer: { type: 'string' },
		userOp: {
			type: 'object',
			properties: {
				sender: { type: 'string' },
				nonce: { type: 'string' },
				// ERC-4337 v0.7 unpacked fields (optional)
				factory: { type: 'string' },
				factoryData: { type: 'string' },
				callData: { type: 'string' },
				callGasLimit: { type: 'string' },
				verificationGasLimit: { type: 'string' },
				preVerificationGas: { type: 'string' },
				maxFeePerGas: { type: 'string' },
				maxPriorityFeePerGas: { type: 'string' },
				// ERC-4337 v0.7 unpacked paymaster fields (optional)
				paymaster: { type: 'string' },
				paymasterVerificationGasLimit: { type: 'string' },
				paymasterPostOpGasLimit: { type: 'string' },
				paymasterData: { type: 'string' },
				signature: { type: 'string' }
			},
			required: [
				'sender',
				'nonce',
				'callData',
				'callGasLimit',
				'verificationGasLimit',
				'preVerificationGas',
				'maxFeePerGas',
				'maxPriorityFeePerGas',
				'signature'
			],
			additionalProperties: false
		},
		userOpHash: { type: 'string' },
		feeAmount: { type: 'string' },
		totalAmount: { type: 'string' },
		invalidReason: { type: 'string' }
	},
	required: ['isValid', 'userOp', 'userOpHash', 'feeAmount', 'totalAmount'],
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
				// ERC-4337 v0.7 unpacked fields (optional)
				factory: { type: 'string' },
				factoryData: { type: 'string' },
				callData: { type: 'string' },
				callGasLimit: { type: 'string' },
				verificationGasLimit: { type: 'string' },
				preVerificationGas: { type: 'string' },
				maxFeePerGas: { type: 'string' },
				maxPriorityFeePerGas: { type: 'string' },
				// ERC-4337 v0.7 unpacked paymaster fields (optional)
				paymaster: { type: 'string' },
				paymasterVerificationGasLimit: { type: 'string' },
				paymasterPostOpGasLimit: { type: 'string' },
				paymasterData: { type: 'string' },
				signature: { type: 'string' }
			},
			required: [
				'sender',
				'nonce',
				'callData',
				'callGasLimit',
				'verificationGasLimit',
				'preVerificationGas',
				'maxFeePerGas',
				'maxPriorityFeePerGas',
				'signature'
			],
			additionalProperties: false
		},
		signature: { type: 'string' },
		paymentRequirements: {
			type: 'object',
			properties: {
				network: { type: 'string' }
			},
			additionalProperties: false
		}
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
		success: { type: 'boolean' },
		txHash: { type: 'string' },
		userOpHash: { type: 'string' },
		network: { type: 'string' },
		payments: {
			type: 'array',
			items: PaymentDetailSchema,
			minItems: 1
		},
		errorReason: { type: 'string' }
	},
	required: ['success', 'txHash', 'userOpHash', 'network', 'payments'],
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

export interface VerifyWalletRequest {
	walletAddress: string
	transactions: Transaction[]
	paymentRequirements?: {
		network?: string
	}
}

export interface UserOperation {
	sender: string
	nonce: string
	// ERC-4337 v0.7 unpacked factory fields
	factory?: string
	factoryData?: string
	callData: string
	callGasLimit: string
	verificationGasLimit: string
	preVerificationGas: string
	maxFeePerGas: string
	maxPriorityFeePerGas: string
	// ERC-4337 v0.7 unpacked paymaster fields
	paymaster?: string
	paymasterVerificationGasLimit?: string
	paymasterPostOpGasLimit?: string
	paymasterData?: string
	signature: string
}

export interface VerifyWalletResponse {
	isValid: boolean
	payer?: string
	userOp: UserOperation
	userOpHash: string
	feeAmount: string
	totalAmount: string
	invalidReason?: string
}

export interface SettleWalletRequest {
	userOp: UserOperation
	signature: string
	paymentRequirements?: {
		network?: string
	}
}

export interface PaymentDetail {
	recipient: string
	amount: string
	isProtocolFee: boolean
}

export interface SettleWalletResponse {
	success: boolean
	txHash: string
	userOpHash: string
	network: string
	payments: PaymentDetail[]
	errorReason?: string
}

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
	// Only used in /wallet/deploy routes
	deployment?: {
		ownerAddress: string
		salts: string[]
		fundingRequested?: boolean
	}
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

// Wallet deployment interfaces
export interface DeployedWallet {
	address: string
	salt: string
	owner: string
	deploymentTxHash?: string
}

// EOA deployment interfaces
export interface DeployEOAVerifyRequest {
	paymentPayload: PaymentPayload[]
	paymentRequirements: PaymentRequirements
}

export interface DeployEOASettleRequest {
	paymentPayload: PaymentPayload[]
	paymentRequirements: PaymentRequirements
	wallets: Array<Omit<DeployedWallet, 'deploymentTxHash'> & { fundingAmount?: string }>
}

// Smart wallet deployment interfaces
export interface DeployWalletVerifyRequest {
	userOp: UserOperation
	paymentRequirements: PaymentRequirements
}

export interface DeployWalletSettleRequest {
	userOp: UserOperation
	signature: string
	paymentRequirements: PaymentRequirements
	wallets: Array<Omit<DeployedWallet, 'deploymentTxHash'> & { fundingAmount?: string }>
}

// Common response interface (used by both EOA and smart wallet)
export interface DeployWalletsVerifyResponse {
	isValid: boolean
	payer?: string
	wallets: Array<Omit<DeployedWallet, 'deploymentTxHash'> & { fundingAmount?: string }>
	deploymentFee: string
	fundingFees?: string
	totalFees?: string
	invalidReason?: string
}

export interface DeployWalletsResponse {
	paymentSuccess: boolean
	deploymentSuccess: boolean
	fundingSuccess: boolean
	wallets: Array<
		DeployedWallet & {
			fundingAmount?: string
			fundingTxHash?: string
			fundingCompleted?: boolean
		}
	>
	failedWallets?: DeployedWallet[]
	failedFundings?: Array<{
		address: string
		salt: string
		owner: string
		fundingAmount: string
	}>
	paymentTxHash: string
	deploymentFee: string
}

export interface ClaimWalletDeploymentRequest {
	paymentTxHash?: string
	payerAddress?: string
}

export interface ClaimWalletDeploymentResponse {
	success: boolean
	wallets: DeployedWallet[]
	deploymentTxHash: string
	network: string
	errorReason?: string
}

export interface WalletDeploymentRecord {
	ownerAddress: string
	walletAddress: string
	salt: string
	payerAddress: string
	paymentTxHash: string
	deploymentTxHash?: string
	paymentCompleted: boolean
	deploymentCompleted: boolean
	createdAt: string
	updatedAt: string
}

export interface GetWalletsByOwnerResponse {
	wallets: WalletDeploymentRecord[]
}
