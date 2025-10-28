import fastifyCors from '@fastify/cors'
import fastifyEnv from '@fastify/env'
import 'dotenv/config'
import fastify from 'fastify'
import fastifyPlugin from 'fastify-plugin'
import { rateLimiterHook } from './hooks/rateLimiter'
import { register as registerB402 } from './routes/b402/b402Routes'
import { envSchema } from './schema/env'

const server = fastify({
	logger: true
})

// Register configuration
server.register(fastifyEnv, { schema: envSchema })

// Register CORS
server.register(fastifyCors, {
	origin: '*'
})

// Register rate limiter
server.register(fastifyPlugin(rateLimiterHook))

// Default route
server.get('/', async () => {
	return 'B402 Facilitator Service'
})

// API version
server.get('/api/version', async () => ({
	apiVersion: 1
}))

// Register B402 Routes
server.register(registerB402, { prefix: '/api/v1' })

// Initialize and run the server
async function start() {
	try {
		await server.listen({
			port: Number(process.env.SERVER_PORT || 3402),
			host: process.env.SERVER_HOST || '0.0.0.0'
		})

		server.log.info('B402 Facilitator Service')
		server.log.info(`Listening on http://localhost:${process.env.SERVER_PORT || 3402}`)
	} catch (err) {
		server.log.error(err)
		process.exit(1)
	}
}

start()
