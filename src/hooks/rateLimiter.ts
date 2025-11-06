import rateLimit from '@fastify/rate-limit'
import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify'

import type { SettleRequest, VerifyRequest } from '../schema/b402'

/**
 * Extract wallet address from request body for rate limiting
 *
 * @param request
 * @returns
 */
function getWalletAddress(request: FastifyRequest): string | null {
	try {
		const body = request.body as VerifyRequest | SettleRequest
		if (body?.paymentPayload?.payload?.authorization?.from) {
			return body.paymentPayload.payload.authorization.from.toLowerCase()
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
		max: 100, // 100 requests per 15 minutes per wallet/IP
		timeWindow: '15 minutes',
		keyGenerator: (request: FastifyRequest) => {
			const walletAddress = getWalletAddress(request)
			return walletAddress ? `wallet:${walletAddress}` : `ip:${request.ip}`
		},
		allowList: (request: FastifyRequest) => {
			// Check for admin secret to bypass rate limiting
			const adminSecret = request.headers['x-admin-secret']
			const adminSecretValue = Array.isArray(adminSecret) ? adminSecret[0] : adminSecret
			if (
				adminSecretValue &&
				server.config.ADMIN_API_SECRET &&
				adminSecretValue.toLowerCase() === server.config.ADMIN_API_SECRET.toLowerCase()
			) {
				return true
			}

			// Exclude health check from rate limiting
			if (request.url.includes('/health')) {
				return true
			}
			return false
		}
	})

	next()
}
