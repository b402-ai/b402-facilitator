import type { JSONSchemaType } from 'env-schema'

interface IEnvSchema {
	SERVER_PORT: string
	SERVER_HOST: string

	// Blockchain RPC endpoints
	BSC_RPC_URL: string
	BSC_TESTNET_RPC_URL: string

	// Network selection (mainnet or testnet)
	NETWORK: string

	// Relayer configuration
	RELAYER_PRIVATE_KEY: string
	B402_RELAYER_ADDRESS: string
}

declare module 'fastify' {
	interface FastifyInstance {
		config: IEnvSchema
	}
}

export const envSchema: JSONSchemaType<IEnvSchema> = {
	type: 'object',
	required: [
		'RELAYER_PRIVATE_KEY',
		'B402_RELAYER_ADDRESS'
	],
	properties: {
		SERVER_PORT: { type: 'string', default: '3402' },
		SERVER_HOST: { type: 'string', default: '0.0.0.0' },

		BSC_RPC_URL: { type: 'string', default: 'https://bsc-dataseed.binance.org' },
		BSC_TESTNET_RPC_URL: { type: 'string', default: 'https://data-seed-prebsc-1-s1.binance.org:8545' },

		NETWORK: { type: 'string', default: 'testnet' },

		RELAYER_PRIVATE_KEY: { type: 'string' },
		B402_RELAYER_ADDRESS: { type: 'string' }
	}
}
