import type { FastifyInstance } from 'fastify'

import {
	ClaimWalletDeploymentRequestSchema,
	ClaimWalletDeploymentResponseSchema,
	DeployEOASettleRequestSchema,
	DeployEOAVerifyRequestSchema,
	DeployWalletSettleRequestSchema,
	DeployWalletVerifyRequestSchema,
	DeployWalletsResponseSchema,
	DeployWalletsVerifyResponseSchema,
	GetMasterWalletAddressResponseSchema,
	GetWalletsByOwnerResponseSchema,
	HealthResponseSchema,
	SettleRequestSchema,
	SettleResponseSchema,
	SettleWalletPaymentRequestSchema,
	SettleWalletPaymentResponseSchema,
	VerifyRequestSchema,
	VerifyResponseSchema,
	VerifyWalletPaymentRequestSchema,
	VerifyWalletPaymentResponseSchema
} from '../../schema/b402'
import {
	claimWalletDeployment,
	getMasterWalletAddress,
	getWalletsByOwner,
	health,
	settle,
	settleDeploymentByEOA,
	settleDeploymentBySmartWallet,
	settleWalletPayment,
	swap,
	swapExecuteSettle,
	swapExecuteVerify,
	swapGaslessApprove,
	swapHealth,
	swapPaymentIntent,
	swapQuote,
	verify,
	verifyDeploymentByEOA,
	verifyDeploymentBySmartWallet,
	verifyWalletPayment
} from './b402Controller'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const register = (server: FastifyInstance, _: any, next: any) => {
	// Vanilla payments
	server.post(
		'/verify',
		{
			schema: {
				body: VerifyRequestSchema,
				response: {
					200: VerifyResponseSchema
				}
			}
		},
		verify
	)

	server.post(
		'/settle',
		{
			schema: {
				body: SettleRequestSchema,
				response: {
					200: SettleResponseSchema
				}
			}
		},
		settle
	)

	// Smart wallet payments
	server.post(
		'/wallet/verify',
		{
			schema: {
				body: VerifyWalletPaymentRequestSchema,
				response: {
					200: VerifyWalletPaymentResponseSchema
				}
			}
		},
		verifyWalletPayment
	)

	server.post(
		'/wallet/settle',
		{
			schema: {
				body: SettleWalletPaymentRequestSchema,
				response: {
					200: SettleWalletPaymentResponseSchema
				}
			}
		},
		settleWalletPayment
	)

	// Smart wallet deployment via EIP712 payment
	server.post(
		'/deploy/verify',
		{
			schema: {
				body: DeployEOAVerifyRequestSchema,
				response: {
					200: DeployWalletsVerifyResponseSchema
				}
			}
		},
		verifyDeploymentByEOA
	)

	server.post(
		'/deploy/settle',
		{
			schema: {
				body: DeployEOASettleRequestSchema,
				response: {
					200: DeployWalletsResponseSchema
				}
			}
		},
		settleDeploymentByEOA
	)

	// Smart wallet deployment via userOp payment
	server.post(
		'/deploy/wallet/verify',
		{
			schema: {
				body: DeployWalletVerifyRequestSchema,
				response: {
					200: DeployWalletsVerifyResponseSchema
				}
			}
		},
		verifyDeploymentBySmartWallet
	)

	server.post(
		'/deploy/wallet/settle',
		{
			schema: {
				body: DeployWalletSettleRequestSchema,
				response: {
					200: DeployWalletsResponseSchema
				}
			}
		},
		settleDeploymentBySmartWallet
	)

	// Smart wallet management
	server.post(
		'/wallet/claim',
		{
			schema: {
				body: ClaimWalletDeploymentRequestSchema,
				response: {
					200: ClaimWalletDeploymentResponseSchema
				}
			}
		},
		claimWalletDeployment
	)

	server.get(
		'/wallet/:owner',
		{
			schema: {
				response: {
					200: GetWalletsByOwnerResponseSchema
				}
			}
		},
		getWalletsByOwner
	)

	server.get(
		'/wallet/:owner/master',
		{
			schema: {
				response: {
					200: GetMasterWalletAddressResponseSchema
				}
			}
		},
		getMasterWalletAddress
	)

	// Server
	server.get(
		'/health',
		{
			schema: {
				response: {
					200: HealthResponseSchema
				}
			}
		},
		health
	)

	// Get swap quote
	server.get('/swap/quote', swapQuote)

	// Get swap service health
	server.get('/swap/health', swapHealth)

	// Execute swap
	server.post('/swap', swap)

	// Get payment intent for signing
	server.post('/swap/payment-intent', swapPaymentIntent)

	// Gasless approval via EIP-2612 permit
	server.post('/swap/gasless-approve', swapGaslessApprove)

	// Build UserOp for single-sig swap
	server.post('/swap/execute/verify', swapExecuteVerify)

	// Execute single-sig swap (submit UserOp + swap)
	server.post('/swap/execute/settle', swapExecuteSettle)

	next()
}
