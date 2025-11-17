import type { FastifyInstance } from 'fastify'

import {
	ClaimWalletDeploymentRequestSchema,
	ClaimWalletDeploymentResponseSchema,
	DeployWalletsRequestSchema,
	DeployWalletsResponseSchema,
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
	deployWallets,
	getWalletsByOwner,
	health,
	settle,
	settleWalletPayment,
	verify,
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

	server.post(
		'/wallet/deploy',
		{
			schema: {
				body: DeployWalletsRequestSchema,
				response: {
					200: DeployWalletsResponseSchema
				}
			}
		},
		deployWallets
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
