import type { FastifyInstance } from 'fastify'

import {
	ClaimWalletDeploymentRequestSchema,
	ClaimWalletDeploymentResponseSchema,
	DeployWalletsResponseSchema,
	DeployWalletsSettleRequestSchema,
	DeployWalletsVerifyRequestSchema,
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
	settleWalletDeployment,
	settleWalletPayment,
	verify,
	verifyWalletDeployment,
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
		'/wallet/deploy/verify',
		{
			schema: {
				body: DeployWalletsVerifyRequestSchema,
				response: {
					200: DeployWalletsVerifyResponseSchema
				}
			}
		},
		verifyWalletDeployment
	)

	server.post(
		'/wallet/deploy/settle',
		{
			schema: {
				body: DeployWalletsSettleRequestSchema,
				response: {
					200: DeployWalletsResponseSchema
				}
			}
		},
		settleWalletDeployment
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
