import mongoose from 'mongoose'

export interface IWalletDeployment {
	ownerAddress: string
	walletAddress: string
	salt: string
	payerAddress: string
	paymentTxHash: string
	deploymentTxHash?: string
	paymentCompleted: boolean
	deploymentCompleted: boolean
	fundingAmount?: string
	fundingRequested: boolean
	fundingCompleted: boolean
	fundingTxHash?: string
	feePaymentNonce?: string // For EOA: nonce from fee payment authorization
	userOpNonce?: string // For Smart Wallet: nonce from UserOp
	fundingPaymentData?: {
		token: string
		authorization: {
			from: string
			to: string
			value: string
			validAfter: number
			validBefore: number
			nonce: string
		}
		signature: string
	}
	createdAt: Date
	updatedAt: Date
}

const WalletDeploymentSchema = new mongoose.Schema<IWalletDeployment>(
	{
		ownerAddress: {
			type: String,
			required: true,
			trim: true,
			lowercase: true
		},
		walletAddress: {
			type: String,
			required: true,
			trim: true,
			lowercase: true
		},
		salt: {
			type: String,
			required: true,
			trim: true
		},
		payerAddress: {
			type: String,
			required: true,
			trim: true,
			lowercase: true
		},
		paymentTxHash: {
			type: String,
			required: false,
			trim: true,
			lowercase: true,
			default: ''
		},
		deploymentTxHash: {
			type: String,
			trim: true,
			lowercase: true
		},
		paymentCompleted: {
			type: Boolean,
			required: true,
			default: false
		},
		deploymentCompleted: {
			type: Boolean,
			required: true,
			default: false
		},
		fundingAmount: {
			type: String,
			trim: true
		},
		fundingRequested: {
			type: Boolean,
			required: true,
			default: false
		},
		fundingCompleted: {
			type: Boolean,
			required: true,
			default: false
		},
		fundingTxHash: {
			type: String,
			trim: true,
			lowercase: true
		},
		feePaymentNonce: {
			type: String,
			trim: true,
			required: false
		},
		userOpNonce: {
			type: String,
			trim: true,
			required: false
		},
		fundingPaymentData: {
			type: mongoose.Schema.Types.Mixed,
			required: false
		}
	},
	{
		timestamps: true
	}
)

// Indexes for speed
WalletDeploymentSchema.index({ ownerAddress: 1 })
WalletDeploymentSchema.index({ payerAddress: 1 })
WalletDeploymentSchema.index({ paymentCompleted: 1, deploymentCompleted: 1 })
WalletDeploymentSchema.index({ deploymentCompleted: 1, fundingRequested: 1, fundingCompleted: 1 })

// Prevent duplicate payments for the same wallet (each wallet can only be paid for once)
WalletDeploymentSchema.index({ walletAddress: 1 }, { unique: true })

// Prevent multiple records for the same wallet in a single payment transaction
WalletDeploymentSchema.index({ paymentTxHash: 1, walletAddress: 1 }, { unique: true })

export const WalletDeployment = mongoose.model<IWalletDeployment>(
	'WalletDeployment',
	WalletDeploymentSchema
)
