import type { JSONSchemaType } from 'env-schema'

import { BaseErrors } from './errors'

interface IEnvSchema {
	SERVER_PORT: string
	SERVER_HOST: string

	// Blockchain RPC endpoint
	RPC_URL: string
	// Optional second RPC endpoint for the settle path: a call that times out or fails in
	// transport on RPC_URL is retried here (RPC_CALL_TIMEOUT_MS bounds each call, default 3500)
	RPC_URL_FALLBACK?: string

	// Network selection (bsc or base)
	NETWORK: string

	// Relayer configuration (for EOA payments)
	RELAYER_PRIVATE_KEY: string
	B402_RELAYER_ADDRESS: string

	// ERC-4337 Smart Wallet Configuration
	ENTRY_POINT_ADDRESS: string
	BUNDLER_RPC_URL?: string
	PAYMASTER_ADDRESS: string
	PAYMASTER_SIGNER_KEY: string
	WALLET_PAYMENT_FEE: string
	WALLET_DEPLOYMENT_FEE: string
	WALLET_FEE_RECIPIENT: string

	// Swap service configuration
	SWAP_SERVICE_FEE: string

	// Nexus Smart Account Configuration (ERC-7579)
	NEXUS_ACCOUNT_FACTORY_ADDRESS: string
	NEXUS_BOOTSTRAP_ADDRESS: string
	K1_VALIDATOR_ADDRESS: string
	// Note: Smart Sessions can be added later via installModule when address is available

	// Admin API secret for bypassing rate limits
	ADMIN_API_SECRET?: string

	// MongoDB connection string
	DATABASE_URL?: string
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
		'B402_RELAYER_ADDRESS',
		'ENTRY_POINT_ADDRESS',
		// BUNDLER_RPC_URL no longer required — base/arb use in-process bundler.
		// Still read optionally for BSC flows via chains.ts.
		'PAYMASTER_ADDRESS',
		'PAYMASTER_SIGNER_KEY',
		'WALLET_PAYMENT_FEE',
		'WALLET_DEPLOYMENT_FEE',
		'WALLET_FEE_RECIPIENT',
		'NEXUS_ACCOUNT_FACTORY_ADDRESS',
		'NEXUS_BOOTSTRAP_ADDRESS',
		'K1_VALIDATOR_ADDRESS'
	],
	properties: {
		SERVER_PORT: { type: 'string', default: '3402' },
		SERVER_HOST: { type: 'string', default: '0.0.0.0' },

		RPC_URL: { type: 'string', default: 'https://bsc-dataseed.binance.org' },
		RPC_URL_FALLBACK: { type: 'string', nullable: true },

		NETWORK: {
			type: 'string',
			default: 'bsc',
			enum: ['bsc', 'base', 'arbitrum', 'arb', 'ethereum', 'eth', 'robinhood', 'rh']
		},

		RELAYER_PRIVATE_KEY: { type: 'string' },
		B402_RELAYER_ADDRESS: { type: 'string' },

		ENTRY_POINT_ADDRESS: { type: 'string' },
		BUNDLER_RPC_URL: { type: 'string', nullable: true },
		PAYMASTER_ADDRESS: { type: 'string' },
		PAYMASTER_SIGNER_KEY: { type: 'string' },
		WALLET_PAYMENT_FEE: { type: 'string' },
		WALLET_DEPLOYMENT_FEE: { type: 'string' },
		WALLET_FEE_RECIPIENT: { type: 'string' },

		SWAP_SERVICE_FEE: { type: 'string', default: '0.01' },

		NEXUS_ACCOUNT_FACTORY_ADDRESS: { type: 'string' },
		NEXUS_BOOTSTRAP_ADDRESS: { type: 'string' },
		K1_VALIDATOR_ADDRESS: { type: 'string' },

		ADMIN_API_SECRET: { type: 'string', nullable: true },

		DATABASE_URL: { type: 'string', nullable: true }
	}
}

/**
 * Direct access to validated environment variables
 * For use in modules that don't have access to Fastify instance
 */
function getEnv(): IEnvSchema {
	const required = [
		'RELAYER_PRIVATE_KEY',
		'B402_RELAYER_ADDRESS',
		'ENTRY_POINT_ADDRESS',
		// BUNDLER_RPC_URL no longer required — facilitator uses in-process bundler
		// (calls entryPoint.handleOps() directly via relayer wallet)
		'PAYMASTER_ADDRESS',
		'PAYMASTER_SIGNER_KEY',
		'WALLET_PAYMENT_FEE',
		'WALLET_DEPLOYMENT_FEE',
		'WALLET_FEE_RECIPIENT',
		'NEXUS_ACCOUNT_FACTORY_ADDRESS',
		'NEXUS_BOOTSTRAP_ADDRESS',
		'K1_VALIDATOR_ADDRESS'
	]

	const missing = required.filter((key) => !process.env[key])
	if (missing.length > 0) {
		throw new BaseErrors.ERR_MISSING_ENV_VARS()
	}

	return {
		SERVER_PORT: process.env.SERVER_PORT || '3402',
		SERVER_HOST: process.env.SERVER_HOST || '0.0.0.0',
		RPC_URL: process.env.RPC_URL || 'https://bsc-dataseed.binance.org',
		RPC_URL_FALLBACK: process.env.RPC_URL_FALLBACK,
		NETWORK: process.env.NETWORK || 'bsc',
		RELAYER_PRIVATE_KEY: process.env.RELAYER_PRIVATE_KEY as string,
		B402_RELAYER_ADDRESS: process.env.B402_RELAYER_ADDRESS as string,
		ENTRY_POINT_ADDRESS: process.env.ENTRY_POINT_ADDRESS as string,
		BUNDLER_RPC_URL: process.env.BUNDLER_RPC_URL,
		PAYMASTER_ADDRESS: process.env.PAYMASTER_ADDRESS as string,
		PAYMASTER_SIGNER_KEY: process.env.PAYMASTER_SIGNER_KEY as string,
		WALLET_PAYMENT_FEE: process.env.WALLET_PAYMENT_FEE as string,
		WALLET_DEPLOYMENT_FEE: process.env.WALLET_DEPLOYMENT_FEE as string,
		WALLET_FEE_RECIPIENT: process.env.WALLET_FEE_RECIPIENT as string,
		SWAP_SERVICE_FEE: process.env.SWAP_SERVICE_FEE || '0.01',
		NEXUS_ACCOUNT_FACTORY_ADDRESS: process.env.NEXUS_ACCOUNT_FACTORY_ADDRESS as string,
		NEXUS_BOOTSTRAP_ADDRESS: process.env.NEXUS_BOOTSTRAP_ADDRESS as string,
		K1_VALIDATOR_ADDRESS: process.env.K1_VALIDATOR_ADDRESS as string,
		ADMIN_API_SECRET: process.env.ADMIN_API_SECRET,
		DATABASE_URL: process.env.DATABASE_URL
	}
}

export const env = getEnv()
