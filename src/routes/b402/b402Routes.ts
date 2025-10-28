import type { FastifyInstance } from 'fastify'
import {
	VerifyRequestSchema,
	VerifyResponseSchema,
	SettleRequestSchema,
	SettleResponseSchema,
	HealthResponseSchema
} from '../../schema/b402'
import { verify, settle, health } from './b402Controller'

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

	next()
}
