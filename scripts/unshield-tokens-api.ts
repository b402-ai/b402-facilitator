import type { Chain } from '@railgun-community/engine/dist/models/engine-types'
import {
	EVMGasType,
	type FallbackProviderJsonConfig,
	NetworkName,
	type RailgunERC20Amount,
	type RailgunERC20AmountRecipient,
	type SelectedBroadcaster,
	TXIDVersion,
	type TransactionGasDetailsType0
} from '@railgun-community/shared-models'
import {
	BroadcasterTransaction,
	WakuBroadcasterClient
} from '@railgun-community/waku-broadcaster-client-node'
import {
	calculateBroadcasterFeeERC20Amount,
	createRailgunWallet,
	generateUnshieldProof,
	getEngine,
	loadProvider,
	populateProvedUnshield,
	setOnBalanceUpdateCallback,
	setOnUTXOMerkletreeScanCallback,
	startRailgunEngine,
	stopRailgunEngine
} from '@railgun-community/wallet'
import 'dotenv/config'
import { ethers } from 'ethers'
import { MemoryLevel } from 'memory-level'
import * as snarkjs from 'snarkjs'

import { computeMasterWalletAddress, deriveUnshieldEOA } from '../src/utils/wallet'
import { getPrivacyBalance } from './utils/balance'
import { createFileBasedArtifactStore, deriveMnemonicFromEOA } from './utils/railgun'
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
	mode: 'eoa',
	eoaPrivateKey: '',
	rpcUrl: process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org',
	apiUrl: process.env.API_URL || 'http://localhost:3002',
	token: {
		address: '0x55d398326f99059fF775485246999027B3197955',
		decimals: 18
	},
	amount: ethers.parseUnits('0.01', 18),
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

	// Derive deterministic unshield EOA and compute smart wallet address
	const unshieldEOA = deriveUnshieldEOA(config.eoaPrivateKey)
	const smartWalletAddress = await computeMasterWalletAddress(unshieldEOA.address)
	config.recipientAddress = smartWalletAddress

	console.log('=== B402 API-FIRST UNSHIELD ===')
	console.log('Shield EOA Address:', eoaWallet.address)
	console.log('Derived Unshield EOA:', unshieldEOA.address)
	console.log('Unshield Recipient (Smart Wallet):', config.recipientAddress)
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
	const artifactsDir = '.railgun-artifacts'
	const artifactStore = createFileBasedArtifactStore(artifactsDir)

	console.log('Using artifacts directory:', artifactsDir)

	setOnBalanceUpdateCallback(() => {})
	setOnUTXOMerkletreeScanCallback(() => {})

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

	console.log('Railgun engine started (merkle tree scanning skipped)')

	// Configure snarkjs as the prover
	const engine = getEngine()
	engine.prover.setSnarkJSGroth16(snarkjs.groth16)
	console.log('Configured snarkjs as the ZK prover')

	const mnemonic = await deriveMnemonicFromEOA(config.eoaPrivateKey)
	const chain: Chain = { type: 0, id: 56 }

	// Configure network provider
	const networkConfig: FallbackProviderJsonConfig = {
		chainId: 56,
		providers: [
			{
				provider: config.rpcUrl,
				priority: 1,
				weight: 1,
				stallTimeout: 2500
			}
		]
	}

	await loadProvider(networkConfig, NetworkName.BNBChain, 60000)

	const creationBlockNumbers = { [NetworkName.BNBChain]: 0 } // 0 = no historical scanning
	const walletInfo = await createRailgunWallet(encryptionKey, mnemonic, creationBlockNumbers)

	console.log('Wallet ID:', walletInfo.id)
	console.log('RAILGUN Address (zk-address):', walletInfo.railgunAddress)

	let selectedBroadcaster: SelectedBroadcaster | undefined

	if (config.mode === 'broadcaster') {
		console.log('\n=== BROADCASTER MODE ===')
		console.log('Initializing Waku Broadcaster Client...')
		console.log('Note: Requires Node.js 22+. Your version:', process.version)

		await WakuBroadcasterClient.start(
			chain,
			{
				trustedFeeSigner:
					'0zk1qyv0zc0j9sm6mr8fe3gx7ymwc6d2xymfftqvgvjdy3r8dmyfs947lrv7j6fe3z53llx97s6mxjstvn9wj3xhyv4cfecw08gqzywgnl0fmzx3mguhr2hyych4srf',
				peerDiscoveryTimeout: 30000
			},
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

	// Calculate broadcaster fee (only if in broadcaster mode)
	let broadcasterFeeRecipient: RailgunERC20AmountRecipient | undefined

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

		const broadcasterFeeERC20Amount: RailgunERC20Amount = calculateBroadcasterFeeERC20Amount(
			{
				tokenAddress: config.token.address,
				feePerUnitGas: BigInt(selectedBroadcaster.tokenFee.feePerUnitGas)
			},
			{
				evmGasType: EVMGasType.Type0,
				gasEstimate: estimatedGas,
				gasPrice: gasPrice
			}
		)

		broadcasterFeeRecipient = {
			...broadcasterFeeERC20Amount,
			recipientAddress: selectedBroadcaster.railgunAddress
		}

		console.log(
			'Broadcaster fee:',
			ethers.formatUnits(broadcasterFeeERC20Amount.amount, decimals),
			symbol
		)
	}

	console.log('\n=== BUILDING UNSHIELD TRANSACTION ===')

	const erc20AmountRecipients: RailgunERC20AmountRecipient[] = [
		{
			tokenAddress: config.token.address,
			amount: config.amount,
			recipientAddress: config.recipientAddress
		}
	]

	// Prompt user to continue
	console.log('\n=== READY TO UNSHIELD ===')
	console.log('Review the information above.')
	console.log('Press ENTER to continue with proof generation and unshield, or Ctrl+C to cancel...')

	await new Promise<void>((resolve) => {
		process.stdin.once('data', () => {
			resolve()
		})
	})

	// Generate proof (this takes time!)
	console.log('\nGenerating zero-knowledge proof (this may take 10-30 seconds)...')
	const proofStartTime = Date.now()

	const sendWithPublicWallet = config.mode === 'eoa'

	await generateUnshieldProof(
		TXIDVersion.V2_PoseidonMerkle,
		NetworkName.BNBChain,
		walletInfo.id,
		encryptionKey,
		erc20AmountRecipients,
		[],
		broadcasterFeeRecipient, // Broadcaster fee (undefined in eoa mode)
		sendWithPublicWallet, // true for eoa mode, false for broadcaster mode
		gasPrice, // overallBatchMinGasPrice
		() => console.log('Proof generation in progress...')
	)

	const proofTime = ((Date.now() - proofStartTime) / 1000).toFixed(2)
	console.log(`Proof generated in ${proofTime}s`)

	// Populate transaction with proof
	console.log('\nPopulating unshield transaction...')

	// Create proper gas details with BigInt values (Type0 for BSC)
	const gasDetails: TransactionGasDetailsType0 = {
		evmGasType: EVMGasType.Type0,
		gasEstimate: estimatedGas,
		gasPrice: gasPrice
	}

	const populateResponse = await populateProvedUnshield(
		TXIDVersion.V2_PoseidonMerkle,
		NetworkName.BNBChain,
		walletInfo.id,
		erc20AmountRecipients,
		[],
		broadcasterFeeRecipient, // Broadcaster fee (undefined in eoa mode)
		sendWithPublicWallet, // true for eoa mode, false for broadcaster mode
		gasPrice, // overallBatchMinGasPrice
		gasDetails
	)

	console.log(`Transaction populated with ${populateResponse.nullifiers?.length || 0} nullifiers`)

	// Send transaction (method depends on mode)
	let txHash: string

	if (config.mode === 'broadcaster') {
		// Send via broadcaster
		console.log('\nSending transaction through Waku broadcaster network...')

		if (!selectedBroadcaster) {
			throw new Error('No broadcaster selected')
		}

		if (!populateResponse.nullifiers || populateResponse.nullifiers.length === 0) {
			throw new Error('No nullifiers returned from populateProvedUnshield')
		}

		const broadcasterTransaction = await BroadcasterTransaction.create(
			TXIDVersion.V2_PoseidonMerkle, // txidVersionForInputs
			populateResponse.transaction.to!,
			populateResponse.transaction.data!,
			selectedBroadcaster.railgunAddress,
			selectedBroadcaster.tokenFee.feesID,
			chain,
			populateResponse.nullifiers,
			gasPrice, // overallBatchMinGasPrice
			false, // useRelayAdapt
			populateResponse.preTransactionPOIsPerTxidLeafPerList // POI proofs
		)

		txHash = await broadcasterTransaction.send()
		console.log('Transaction broadcasted! Hash:', txHash)
	} else {
		// Send via EOA directly
		console.log('\nSending transaction directly from EOA...')

		const wallet = new ethers.Wallet(config.eoaPrivateKey, provider)
		const tx = await wallet.sendTransaction(populateResponse.transaction)
		txHash = tx.hash
		console.log('Transaction sent! Hash:', txHash)
	}

	// Wait for confirmation
	console.log('Waiting for confirmation...')
	const receipt = await provider.waitForTransaction(txHash)
	console.log('Confirmed in block:', receipt?.blockNumber)

	// Cleanup
	if (config.mode === 'broadcaster') {
		WakuBroadcasterClient.stop()
	}
	await stopRailgunEngine()

	// Check balance AFTER unshielding
	console.log('\n=== BALANCE AFTER UNSHIELDING ===')
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
		console.warn('Could not fetch balance after unshielding:', error)
	}
}

unshieldTokensAPI(CONFIG).catch((error) => {
	console.error('Error:', error.message)
	if (CONFIG.mode === 'broadcaster') {
		WakuBroadcasterClient.stop()
	}
	stopRailgunEngine().finally(() => process.exit(1))
})
