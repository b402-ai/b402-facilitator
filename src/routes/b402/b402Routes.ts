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
	getWalletsByOwner,
	health,
	settle,
	settleDeploymentByEOA,
	settleDeploymentByWallet,
	settleWalletPayment,
	verify,
	verifyDeploymentByEOA,
	verifyDeploymentByWallet,
	verifyWalletPayment
} from './b402Controller'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const register = (server: FastifyInstance, _: any, next: any) => {
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

	// Smart Wallet Routes
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

	// Wallet Deployment Routes - EOA (EIP712) Payment
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

	// Wallet Deployment Routes - Smart Wallet Payment
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
		verifyDeploymentByWallet
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
		settleDeploymentByWallet
	)

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

	next()
}
