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
			required: true,
			trim: true,
			lowercase: true
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

// Prevent duplicate payments for the same wallet (each wallet can only be paid for once)
WalletDeploymentSchema.index({ walletAddress: 1 }, { unique: true })

// Prevent multiple records for the same wallet in a single payment transaction
WalletDeploymentSchema.index({ paymentTxHash: 1, walletAddress: 1 }, { unique: true })

export const WalletDeployment = mongoose.model<IWalletDeployment>(
	'WalletDeployment',
	WalletDeploymentSchema
)
