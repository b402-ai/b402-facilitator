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
	VerifyWalletPaymentResponseSchema,
	WalletIncognitoSettleRequestSchema,
	WalletIncognitoSettleResponseSchema,
	WalletIncognitoVerifyRequestSchema,
	WalletIncognitoVerifyResponseSchema
} from '../../schema/b402'
import {
	SwapGaslessApproveRequestSchema,
	SwapGaslessApproveResponseSchema,
	SwapHealthResponseSchema,
	SwapPaymentIntentRequestSchema,
	SwapPaymentIntentResponseSchema,
	SwapQuoteQuerySchema,
	SwapQuoteResponseSchema,
	SwapRequestSchema,
	SwapResponseSchema,
	SwapWalletSettleRequestSchema,
	SwapWalletSettleResponseSchema,
	SwapWalletVerifyRequestSchema,
	SwapWalletVerifyResponseSchema
} from '../../schema/swap'
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
	swapGaslessApprove,
	swapHealth,
	swapPaymentIntent,
	swapQuote,
	swapWalletSettle,
	swapWalletVerify,
	verify,
	verifyDeploymentByEOA,
	verifyDeploymentBySmartWallet,
	verifyWalletPayment,
	walletIncognitoSettle,
	walletIncognitoVerify
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

	// Wallet Incognito Operations (gasless shield/unshield via UserOp)

	server.post(
		'/wallet/incognito/verify',
		{
			schema: {
				body: WalletIncognitoVerifyRequestSchema,
				response: {
					200: WalletIncognitoVerifyResponseSchema
				}
			}
		},
		walletIncognitoVerify
	)

	server.post(
		'/wallet/incognito/settle',
		{
			schema: {
				body: WalletIncognitoSettleRequestSchema,
				response: {
					200: WalletIncognitoSettleResponseSchema
				}
			}
		},
		walletIncognitoSettle
	)

	// Swap routes
	server.get(
		'/swap/quote',
		{
			schema: {
				querystring: SwapQuoteQuerySchema,
				response: { 200: SwapQuoteResponseSchema }
			}
		},
		swapQuote
	)

	server.get(
		'/swap/health',
		{
			schema: {
				response: { 200: SwapHealthResponseSchema }
			}
		},
		swapHealth
	)

	server.post(
		'/swap',
		{
			schema: {
				body: SwapRequestSchema,
				response: { 200: SwapResponseSchema }
			}
		},
		swap
	)

	server.post(
		'/swap/payment-intent',
		{
			schema: {
				body: SwapPaymentIntentRequestSchema,
				response: { 200: SwapPaymentIntentResponseSchema }
			}
		},
		swapPaymentIntent
	)

	server.post(
		'/swap/gasless-approve',
		{
			schema: {
				body: SwapGaslessApproveRequestSchema,
				response: { 200: SwapGaslessApproveResponseSchema }
			}
		},
		swapGaslessApprove
	)

	server.post(
		'/swap/wallet/verify',
		{
			schema: {
				body: SwapWalletVerifyRequestSchema,
				response: { 200: SwapWalletVerifyResponseSchema }
			}
		},
		swapWalletVerify
	)

	server.post(
		'/swap/wallet/settle',
		{
			schema: {
				body: SwapWalletSettleRequestSchema,
				response: { 200: SwapWalletSettleResponseSchema }
			}
		},
		swapWalletSettle
	)

	next()
}
