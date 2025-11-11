import type { FastifyInstance } from 'fastify'

import {
	CreateWalletRequestSchema,
	CreateWalletResponseSchema,
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
	createWallet,
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

	// Smart Wallet Routes
	server.post(
		'/wallet/create',
		{
			schema: {
				body: CreateWalletRequestSchema,
				response: {
					200: CreateWalletResponseSchema
				}
			}
		},
		createWallet
	)

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

	next()
}
