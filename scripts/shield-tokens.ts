import { encodeAddress } from '@railgun-community/engine/dist/key-derivation/bech32'
import { deriveNodes } from '@railgun-community/engine/dist/key-derivation/wallet-node'
import {
	type FallbackProviderJsonConfig,
	NetworkName,
	type RailgunERC20AmountRecipient,
	TXIDVersion
} from '@railgun-community/shared-models'
import {
	loadProvider,
	populateShield,
	startRailgunEngine,
	stopRailgunEngine
} from '@railgun-community/wallet'
import 'dotenv/config'
import { Contract, Wallet, ethers } from 'ethers'
import { MemoryLevel } from 'memory-level'

import { getPrivacyBalance } from './utils/balance'
import {
	ERC20_ABI,
	createInMemoryArtifactStore,
	deriveMnemonicFromEOA,
	getShieldPrivateKey
} from './utils/railgun'

interface ShieldConfig {
	eoaPrivateKey: string
	token: {
		address: string
		decimals?: number
	}
	amount: bigint
	railgunSmartWalletAddress: string
	rpcUrl: string
	apiUrl: string // b402-backend API URL
	gasLimit?: bigint
	gasPrice?: bigint
}

// --- Config (edit this) ----
const CONFIG: ShieldConfig = {
	eoaPrivateKey: '',
	token: {
		address: '0x55d398326f99059fF775485246999027B3197955', // USDT
		decimals: 18
	},
	amount: ethers.parseUnits('0.01', 18),
	railgunSmartWalletAddress: '0x590162bf4b50f6576a459b75309ee21d92178a10',
	rpcUrl: process.env.BSC_RPC_URL || '',
	apiUrl: 'http://localhost:3002',
	gasLimit: 500000n
}
// ---------------------------

async function shieldTokens(config: ShieldConfig) {
	if (!config.eoaPrivateKey || config.eoaPrivateKey === '') {
		throw new Error('EOA private key not configured')
	}
	if (!config.rpcUrl || config.rpcUrl === '') {
		throw new Error('RPC URL not configured - please set BSC_RPC_URL in .env file')
	}
	if (!config.railgunSmartWalletAddress) {
		throw new Error('Railgun Smart Wallet address not configured')
	}
	if (!config.apiUrl || config.apiUrl === '') {
		throw new Error('API URL not configured')
	}

	const provider = new ethers.JsonRpcProvider(config.rpcUrl)
	const eoaWallet = new Wallet(config.eoaPrivateKey, provider)

	// Check balance BEFORE shielding
	console.log('\n=== BALANCE BEFORE SHIELDING ===')
	try {
		const balanceBefore = await getPrivacyBalance({
			eoaPrivateKey: config.eoaPrivateKey,
			rpcUrl: config.rpcUrl,
			apiUrl: config.apiUrl,
			tokenAddresses: [config.token.address]
		})
		console.log(balanceBefore.summary)
	} catch (error) {
		console.warn('Could not fetch balance before shielding:', error)
		console.log('Continuing with shield operation...\n')
	}

	const db = new MemoryLevel()
	const artifactStore = createInMemoryArtifactStore()
	const walletSource = 'b402shield'

	await startRailgunEngine(
		walletSource,
		db,
		false,
		artifactStore,
		false,
		true, // skipMerkletreeScans
		['https://ppoi-agg.horsewithsixlegs.xyz'],
		[],
		false
	)

	const networkConfig: FallbackProviderJsonConfig = {
		chainId: 56,
		providers: [
			{
				provider: config.rpcUrl,
				priority: 1,
				weight: 1,
				stallTimeout: 2500
			},
			{
				provider: 'https://bsc-dataseed.binance.org',
				priority: 2,
				weight: 1,
				stallTimeout: 2500
			}
		]
	}

	await loadProvider(networkConfig, NetworkName.BNBChain, 60000)

	const mnemonic = await deriveMnemonicFromEOA(config.eoaPrivateKey)

	// Manually derive Railgun address (no wallet creation needed for shielding)
	const nodes = deriveNodes(mnemonic, 0)
	const spendingKeyPair = nodes.spending.getSpendingKeyPair()
	const nullifyingKey = await nodes.spending.getNullifyingKey()
	const viewingKeyPair = await nodes.viewing.getViewingKeyPair()

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const masterPublicKey = (nodes.spending.constructor as any).getMasterPublicKey(
		spendingKeyPair.pubkey,
		nullifyingKey
	)

	const addressData = {
		masterPublicKey,
		viewingPublicKey: viewingKeyPair.pubkey
	}

	const railgunAddress = encodeAddress(addressData)

	console.log('Railgun Address (zk-address): ', railgunAddress)
	console.log('Mnemonic: ', mnemonic)
	console.log('masterPublicKey:', masterPublicKey.toString(16))
	console.log('nullifyingKey:', nullifyingKey.toString())

	const tokenContract = new Contract(config.token.address, ERC20_ABI, provider)

	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const symbol = await (tokenContract as any).symbol()
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const decimals = await (tokenContract as any).decimals()
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const balance = await (tokenContract as any).balanceOf(eoaWallet.address)

		console.log('Token: ', symbol)
		console.log('Balance: ', ethers.formatUnits(balance, decimals))
		console.log('Amount to shield: ', ethers.formatUnits(config.amount, decimals))

		if (balance < config.amount) {
			throw new Error('Insufficient token balance')
		}
	} catch (error) {
		if (error instanceof Error && error.message === 'Insufficient token balance') {
			throw error
		}
	}

	const tokenWithSigner = tokenContract.connect(eoaWallet)
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const allowance = await (tokenWithSigner as any).allowance(
		eoaWallet.address,
		config.railgunSmartWalletAddress
	)

	if (allowance < config.amount) {
		console.log('Approving token spend...')
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const approveTx = await (tokenWithSigner as any).approve(
			config.railgunSmartWalletAddress,
			ethers.MaxUint256
		)
		console.log('Approval tx: ', approveTx.hash)
		await approveTx.wait()
	}

	console.log('Building shield transaction with Railgun SDK...')

	const erc20AmountRecipients: RailgunERC20AmountRecipient[] = [
		{
			tokenAddress: config.token.address,
			amount: config.amount,
			recipientAddress: railgunAddress
		}
	]

	const { transaction } = await populateShield(
		TXIDVersion.V2_PoseidonMerkle,
		NetworkName.BNBChain,
		getShieldPrivateKey(),
		erc20AmountRecipients,
		[]
	)

	console.log('Executing shield transaction...')

	const tx = await eoaWallet.sendTransaction(transaction)
	console.log('Tx hash: ', tx.hash)

	const receipt = await tx.wait()
	if (!receipt) {
		throw new Error('Transaction receipt not available')
	}

	console.log('Block: ', receipt.blockNumber)
	console.log('Gas used: ', receipt.gasUsed.toString())

	// Parse the shield event (last log)
	const shieldEvent = receipt.logs[receipt.logs.length - 1]
	console.log('Shield event address:', shieldEvent.address)
	console.log('Shield event topics:', shieldEvent.topics)

	await stopRailgunEngine()

	const result = {
		txHash: tx.hash,
		blockNumber: receipt.blockNumber,
		gasUsed: receipt.gasUsed.toString(),
		railgunAddress: railgunAddress,
		mnemonic: mnemonic
	}

	// Check balance after shielding
	console.log('\n=== BALANCE AFTER SHIELDING ===')
	console.log('Waiting 10 seconds for indexer to sync...')
	await new Promise((resolve) => setTimeout(resolve, 10000))

	try {
		const balanceAfter = await getPrivacyBalance({
			eoaPrivateKey: config.eoaPrivateKey,
			rpcUrl: config.rpcUrl,
			apiUrl: config.apiUrl,
			tokenAddresses: [config.token.address]
		})
		console.log(balanceAfter.summary)
	} catch (error) {
		console.warn('Could not fetch balance after shielding:', error)
	}

	return result
}

shieldTokens(CONFIG)
	.then((result) => {
		console.log('Success')
		console.log('Tx Hash: ', result.txHash)
		console.log('Railgun Address: ', result.railgunAddress)
		process.exit(0)
	})
	.catch((error) => {
		console.error('Error: ', error.message)
		stopRailgunEngine().finally(() => process.exit(1))
	})
