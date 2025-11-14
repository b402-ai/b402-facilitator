import type { JSONSchemaType } from 'env-schema'

import { BaseErrors } from './errors'

interface IEnvSchema {
	SERVER_PORT: string
	SERVER_HOST: string

	// Blockchain RPC endpoints
	BSC_RPC_URL: string
	BSC_TESTNET_RPC_URL: string

	// Network selection (mainnet or testnet)
	NETWORK: string

	// Relayer configuration (for EOA payments)
	RELAYER_PRIVATE_KEY: string
	B402_RELAYER_ADDRESS: string

	// ERC-4337 Smart Wallet Configuration
	SIMPLE_ACCOUNT_FACTORY_ADDRESS: string
	ENTRY_POINT_ADDRESS: string
	BUNDLER_RPC_URL: string
	PAYMASTER_ADDRESS: string
	PAYMASTER_SIGNER_KEY: string
	WALLET_FEE_AMOUNT: string
	WALLET_FEE_RECIPIENT: string

	// Admin API secret for bypassing rate limits
	ADMIN_API_SECRET?: string
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
		'SIMPLE_ACCOUNT_FACTORY_ADDRESS',
		'ENTRY_POINT_ADDRESS',
		'BUNDLER_RPC_URL',
		'PAYMASTER_ADDRESS',
		'PAYMASTER_SIGNER_KEY',
		'WALLET_FEE_RECIPIENT'
	],
	properties: {
		SERVER_PORT: { type: 'string', default: '3402' },
		SERVER_HOST: { type: 'string', default: '0.0.0.0' },

		BSC_RPC_URL: { type: 'string', default: 'https://bsc-dataseed.binance.org' },
		BSC_TESTNET_RPC_URL: {
			type: 'string',
			default: 'https://data-seed-prebsc-1-s1.binance.org:8545'
		},

		NETWORK: { type: 'string', default: 'testnet' },

		RELAYER_PRIVATE_KEY: { type: 'string' },
		B402_RELAYER_ADDRESS: { type: 'string' },

		SIMPLE_ACCOUNT_FACTORY_ADDRESS: { type: 'string' },
		ENTRY_POINT_ADDRESS: { type: 'string' },
		BUNDLER_RPC_URL: { type: 'string' },
		PAYMASTER_ADDRESS: { type: 'string' },
		PAYMASTER_SIGNER_KEY: { type: 'string' },
		WALLET_FEE_AMOUNT: { type: 'string', default: '0.1' },
		WALLET_FEE_RECIPIENT: { type: 'string' },

		ADMIN_API_SECRET: { type: 'string', nullable: true }
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
		'SIMPLE_ACCOUNT_FACTORY_ADDRESS',
		'ENTRY_POINT_ADDRESS',
		'BUNDLER_RPC_URL',
		'PAYMASTER_ADDRESS',
		'PAYMASTER_SIGNER_KEY',
		'WALLET_FEE_RECIPIENT'
	]

	const missing = required.filter((key) => !process.env[key])
	if (missing.length > 0) {
		throw new BaseErrors.ERR_MISSING_ENV_VARS()
	}

	return {
		SERVER_PORT: process.env.SERVER_PORT || '3402',
		SERVER_HOST: process.env.SERVER_HOST || '0.0.0.0',
		BSC_RPC_URL: process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org',
		BSC_TESTNET_RPC_URL:
			process.env.BSC_TESTNET_RPC_URL || 'https://data-seed-prebsc-1-s1.binance.org:8545',
		NETWORK: process.env.NETWORK || 'testnet',
		RELAYER_PRIVATE_KEY: process.env.RELAYER_PRIVATE_KEY as string,
		B402_RELAYER_ADDRESS: process.env.B402_RELAYER_ADDRESS as string,
		SIMPLE_ACCOUNT_FACTORY_ADDRESS: process.env.SIMPLE_ACCOUNT_FACTORY_ADDRESS as string,
		ENTRY_POINT_ADDRESS: process.env.ENTRY_POINT_ADDRESS as string,
		BUNDLER_RPC_URL: process.env.BUNDLER_RPC_URL as string,
		PAYMASTER_ADDRESS: process.env.PAYMASTER_ADDRESS as string,
		PAYMASTER_SIGNER_KEY: process.env.PAYMASTER_SIGNER_KEY as string,
		WALLET_FEE_AMOUNT: process.env.WALLET_FEE_AMOUNT || '0.1',
		WALLET_FEE_RECIPIENT: process.env.WALLET_FEE_RECIPIENT as string,
		ADMIN_API_SECRET: process.env.ADMIN_API_SECRET
	}
}

export const env = getEnv()
