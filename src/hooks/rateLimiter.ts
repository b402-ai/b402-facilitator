import rateLimit from '@fastify/rate-limit'
import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify'

import type {
	SettleRequest,
	SettleWalletRequest,
	VerifyRequest,
	VerifyWalletRequest
} from '../schema/b402'

/**
 * Extract wallet address from request body for rate limiting
 *
 * @param request
 * @returns
 */
function getWalletAddress(request: FastifyRequest): string | null {
	try {
		const body = request.body as
			| VerifyRequest
			| SettleRequest
			| VerifyWalletRequest
			| SettleWalletRequest

		if ('paymentPayload' in body && body?.paymentPayload?.payload?.authorization?.from) {
			return body.paymentPayload.payload.authorization.from.toLowerCase()
		}

		if ('walletAddress' in body && body?.walletAddress) {
			return body.walletAddress.toLowerCase()
		}

		if ('userOp' in body && body?.userOp?.sender) {
			return body.userOp.sender.toLowerCase()
		}

		return null
	} catch {
		return null
	}
}

export function rateLimiterHook(
	server: FastifyInstance,
	_opts: FastifyPluginOptions,
	next: () => void
) {
	server.register(rateLimit, {
		max: 60, // 60 requests per minute per wallet/IP
		timeWindow: '1 minute',
		keyGenerator: (request: FastifyRequest) => {
			const walletAddress = getWalletAddress(request)
			return walletAddress ? `wallet:${walletAddress}` : `ip:${request.ip}`
		},
		allowList: (request: FastifyRequest) => {
			// Exclude health check from rate limiting
			if (request.url.includes('/health')) {
				return true
			}

			// Admin secret only bypasses IP-based rate limiting, not wallet-based
			const walletAddress = getWalletAddress(request)
			if (walletAddress) {
				// Rate limit by wallet
				return false
			}

			const adminSecret = request.headers['x-admin-secret']
			const adminSecretValue = Array.isArray(adminSecret) ? adminSecret[0] : adminSecret
			if (
				adminSecretValue &&
				server.config.ADMIN_API_SECRET &&
				adminSecretValue.toLowerCase() === server.config.ADMIN_API_SECRET.toLowerCase()
			) {
				// Bypass IP-based rate limiting for admin
				return true
			}

			return false
		}
	})

	next()
}
