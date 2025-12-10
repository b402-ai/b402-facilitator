import type { Chain } from '@railgun-community/engine/dist/models/engine-types'
import { NetworkName, TXIDVersion } from '@railgun-community/shared-models'
import type { SelectedBroadcaster } from '@railgun-community/waku-broadcaster-client-node'
import {
	WakuBroadcasterClient,
	createRailgunWallet,
	loadProvider,
	setOnBalanceUpdateCallback,
	setOnUTXOMerkletreeScanCallback,
	startRailgunEngine,
	stopRailgunEngine
} from '@railgun-community/wallet'
import { ethers } from 'ethers'
import { MemoryLevel } from 'memory-level'

import { getPrivacyBalance } from './utils/balance'
import { deriveMnemonicFromEOA } from './utils/railgun'
import { fetchSpendableUTXOs } from './utils/unshield-api'

interface UnshieldConfig {
	mode: 'eoa' | 'broadcaster'
	eoaPrivateKey: string
	rpcUrl: string
	apiUrl: string
	token: {
		address: string
		decimals?: number
	}
	amount: bigint
	recipientAddress: string
}

const CONFIG: UnshieldConfig = {
	mode: 'broadcaster',
	eoaPrivateKey: process.env.EOA_PRIVATE_KEY || '',
	rpcUrl: process.env.BNB_RPC_URL || 'https://bsc-dataseed1.binance.org',
	apiUrl: process.env.API_URL || 'http://localhost:3000',
	token: {
		address: '0x55d398326f99059fF775485246999027B3197955',
		decimals: 18
	},
	amount: ethers.parseUnits('1', 18),
	recipientAddress: ''
}

const ERC20_ABI = [
	'function symbol() view returns (string)',
	'function decimals() view returns (uint8)',
	'function balanceOf(address) view returns (uint256)'
]

async function unshieldTokensAPI(config: UnshieldConfig) {
	if (!config.eoaPrivateKey) {
		throw new Error('EOA_PRIVATE_KEY environment variable is required')
	}

	const eoaWallet = new ethers.Wallet(config.eoaPrivateKey)
	config.recipientAddress = eoaWallet.address

	console.log('=== B402 API-FIRST UNSHIELD ===')
	console.log('EOA Address:', config.recipientAddress)
	console.log('Mode:', config.mode.toUpperCase())
	console.log('API URL:', config.apiUrl)
	console.log('\nNOTE: This uses B402 API for all data operations - no blockchain scanning\n')

	const provider = new ethers.JsonRpcProvider(config.rpcUrl)

	console.log('=== BALANCE BEFORE UNSHIELDING ===')
	try {
		const balanceBefore = await getPrivacyBalance({
			eoaPrivateKey: config.eoaPrivateKey,
			rpcUrl: config.rpcUrl,
			apiUrl: config.apiUrl,
			tokenAddresses: [config.token.address]
		})
		console.log(balanceBefore.summary)
	} catch (error) {
		console.warn('Could not fetch balance:', error)
	}

	console.log('\n=== INITIALIZING RAILGUN ENGINE ===')
	console.log('Mode: API-FIRST (no blockchain scanning)')

	const db = new MemoryLevel()
	const walletSource = 'b402unshield-api'
	const encryptionKey = 'b402-encryption-key-0x01'

	const artifactStore = {
		rootDir: '.railgun-artifacts',
		downloadTimeoutInMs: 300000
	}

	setOnBalanceUpdateCallback(() => {})
	setOnUTXOMerkletreeScanCallback(() => {})

	await startRailgunEngine(
		walletSource,
		db,
		false,
		artifactStore,
		false,
		true,
		['https://ppoi-agg.horsewithsixlegs.xyz'],
		[],
		false
	)

	console.log('Railgun engine started (merkle tree scanning skipped)')

	const mnemonic = await deriveMnemonicFromEOA(config.eoaPrivateKey)
	const chain: Chain = { type: 0, id: 56 }

	await loadProvider(provider, NetworkName.BNBChain)

	const walletInfo = await createRailgunWallet(
		encryptionKey,
		mnemonic,
		0,
		undefined,
		TXIDVersion.V2_PoseidonMerkle
	)

	console.log('Wallet ID:', walletInfo.id)

	let selectedBroadcaster: SelectedBroadcaster | undefined

	if (config.mode === 'broadcaster') {
		console.log('\n=== BROADCASTER MODE ===')
		console.log('Initializing Waku Broadcaster Client...')
		console.log('Note: Requires Node.js 22+. Your version:', process.version)

		await WakuBroadcasterClient.start(
			chain,
			{ peerDiscoveryTimeout: 30000 },
			(status) => console.log('Broadcaster status:', status),
			undefined
		)

		console.log('Broadcaster client connected')
	} else {
		console.log('\n=== EOA MODE ===')
		console.log('Direct signing (faster, no IP privacy)')
	}

	console.log('\n=== FETCHING SPENDABLE UTXOs FROM API ===')

	const { spendableUTXOs, totalCommitments, spendableCount } = await fetchSpendableUTXOs(
		config.apiUrl,
		config.eoaPrivateKey,
		chain,
		config.token.address
	)

	console.log(`Total commitments: ${totalCommitments}`)
	console.log(`Spendable: ${spendableCount}`)
	console.log(`For token ${config.token.address}: ${spendableUTXOs.length}`)

	if (spendableUTXOs.length === 0) {
		throw new Error('No spendable UTXOs found for this token')
	}

	const totalAvailable = spendableUTXOs.reduce((sum, utxo) => sum + utxo.txo.note.value, 0n)
	console.log(`Total available: ${ethers.formatUnits(totalAvailable, config.token.decimals || 18)}`)

	if (totalAvailable < config.amount) {
		throw new Error(
			`Insufficient balance: need ${ethers.formatUnits(config.amount, config.token.decimals || 18)}, have ${ethers.formatUnits(totalAvailable, config.token.decimals || 18)}`
		)
	}

	const selectedUTXOs: typeof spendableUTXOs = []
	let selectedTotal = 0n

	for (const utxo of spendableUTXOs) {
		selectedUTXOs.push(utxo)
		selectedTotal += utxo.txo.note.value
		if (selectedTotal >= config.amount) {
			break
		}
	}

	console.log(
		`Selected ${selectedUTXOs.length} UTXOs with total value ${ethers.formatUnits(selectedTotal, config.token.decimals || 18)}`
	)

	const tokenContract = new ethers.Contract(config.token.address, ERC20_ABI, provider)
	const symbol = await tokenContract.symbol()
	const decimals = await tokenContract.decimals()

	console.log('Token:', symbol)
	console.log('Amount to unshield:', ethers.formatUnits(config.amount, decimals))

	console.log('\n=== ESTIMATING GAS ===')
	const feeData = await provider.getFeeData()
	const gasPrice = feeData.gasPrice || ethers.parseUnits('3', 'gwei')
	const estimatedGas = 500000n

	console.log('Gas price:', ethers.formatUnits(gasPrice, 'gwei'), 'gwei')
	console.log('Estimated gas:', estimatedGas.toString())

	let broadcasterFeeAmount = 0n

	if (config.mode === 'broadcaster') {
		console.log('\n=== FINDING BROADCASTER ===')
		selectedBroadcaster = await WakuBroadcasterClient.findBestBroadcaster(
			chain,
			config.token.address,
			true
		)

		if (!selectedBroadcaster) {
			throw new Error('No broadcaster available for this token')
		}

		console.log('Selected Broadcaster:')
		console.log('  Address:', selectedBroadcaster.railgunAddress)
		console.log('  Fee per unit gas:', selectedBroadcaster.tokenFee.feePerUnitGas)
		console.log('  Reliability:', selectedBroadcaster.tokenFee.reliability)

		broadcasterFeeAmount = BigInt(selectedBroadcaster.tokenFee.feePerUnitGas) * estimatedGas
		console.log('Broadcaster fee:', ethers.formatUnits(broadcasterFeeAmount, decimals), symbol)
	}

	const totalOut = config.amount + broadcasterFeeAmount
	const changeAmount = selectedTotal - totalOut

	console.log('\n=== TRANSACTION BREAKDOWN ===')
	console.log('Spending:', ethers.formatUnits(selectedTotal, decimals))
	console.log('To recipient:', ethers.formatUnits(config.amount, decimals))
	if (broadcasterFeeAmount > 0n) {
		console.log('Broadcaster fee:', ethers.formatUnits(broadcasterFeeAmount, decimals))
	}
	if (changeAmount > 0n) {
		console.log('Change (back to private):', ethers.formatUnits(changeAmount, decimals))
	}

	console.log('\n=== IMPLEMENTATION STATUS ===')
	console.log('Completed:')
	console.log('  - API data fetching')
	console.log('  - UTXO decryption')
	console.log('  - Merkle proof fetching')
	console.log('  - UTXO selection')
	console.log('\nRemaining:')
	console.log('  - Transaction construction')
	console.log('  - Proof generation')
	console.log('  - Transaction submission')

	if (config.mode === 'broadcaster') {
		WakuBroadcasterClient.stop()
	}
	await stopRailgunEngine()

	console.log('\n=== PARTIAL IMPLEMENTATION COMPLETE ===')
	console.log('This demonstrates the API-first approach for fetching and processing UTXOs')
	console.log('Full proof generation and submission will be implemented next')
}

unshieldTokensAPI(CONFIG).catch((error) => {
	console.error('Error:', error.message)
	if (CONFIG.mode === 'broadcaster') {
		WakuBroadcasterClient.stop()
	}
	stopRailgunEngine().finally(() => process.exit(1))
})
