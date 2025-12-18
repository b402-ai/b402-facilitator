import { deriveNodes } from '@railgun-community/engine/dist/key-derivation/wallet-node'
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
	stopRailgunEngine,
	walletForID
} from '@railgun-community/wallet'
import 'dotenv/config'
import { ethers } from 'ethers'
import { MemoryLevel } from 'memory-level'
import * as snarkjs from 'snarkjs'

import { computeMasterWalletAddress, deriveUnshieldEOA } from '../src/utils/wallet'
import { getPrivacyBalance } from './utils/balance'
import { createFileBasedArtifactStore, deriveMnemonicFromEOA } from './utils/railgun'
import { fetchSpendableUTXOs } from './utils/unshield-api'
import { injectUTXOsIntoWallet } from './utils/wallet-injection'

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
	amount: ethers.parseUnits('0.009975', 18),
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

	console.log('=== INITIALIZING RAILGUN ENGINE ===')
	console.log('Mode: API-FIRST (no blockchain scanning)')

	const db = new MemoryLevel()
	const walletSource = 'b402unshieldapi'
	// 32-byte encryption key (64 hex characters)
	const encryptionKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
	const artifactsDir = '.railgun-artifacts'
	const artifactStore = createFileBasedArtifactStore(artifactsDir)

	console.log('Using artifacts directory:', artifactsDir)

	try {
		await startRailgunEngine(
			walletSource,
			db,
			false,
			artifactStore,
			false,
			false, // Enable merkletree scans but start from current block (scans 0 blocks)
			['https://ppoi-agg.horsewithsixlegs.xyz'],
			[],
			false
		)
		console.log('✅ Railgun engine started successfully')
	} catch (error) {
		console.error('❌ Failed to start Railgun engine:', error)
		throw error
	}

	// Set callbacks after engine is initialized
	setOnBalanceUpdateCallback((balanceUpdate) => {
		console.log('Balance update:', JSON.stringify(balanceUpdate, null, 2))
	})
	setOnUTXOMerkletreeScanCallback((scanUpdate) => {
		console.log(
			`Scanning: ${scanUpdate.chain.type}:${scanUpdate.chain.id} - Progress: ${scanUpdate.progress.toFixed(2)}%`
		)
	})

	// Configure snarkjs as the prover
	try {
		const engine = getEngine()
		console.log('✅ Got engine instance')
		engine.prover.setSnarkJSGroth16(snarkjs.groth16)
		console.log('✅ Configured snarkjs as the ZK prover')
	} catch (error) {
		console.error('❌ Failed to configure prover:', error)
		throw error
	}

	const mnemonic = await deriveMnemonicFromEOA(config.eoaPrivateKey)
	console.log('Mnemonic:', mnemonic)
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

	// Use the block number where the shield was created to allow wallet to scan and discover commitments
	const shieldBlockNumber = 72081097
	const currentBlock = await provider.getBlockNumber()
	console.log('Current block:', currentBlock)
	console.log('Shield block:', shieldBlockNumber)
	console.log(
		`Creating wallet from block ${shieldBlockNumber} (will scan ${currentBlock - shieldBlockNumber} blocks)...`
	)

	const creationBlockNumbers = { [NetworkName.BNBChain]: shieldBlockNumber }
	const walletInfo = await createRailgunWallet(encryptionKey, mnemonic, creationBlockNumbers)

	console.log('Wallet ID:', walletInfo.id)
	console.log('RAILGUN Address (zk-address):', walletInfo.railgunAddress)

	// Debug: Extract actual masterPublicKey from created wallet
	const wallet = walletForID(walletInfo.id)
	const actualMasterPublicKey = wallet.masterPublicKey
	const actualNullifyingKey = wallet.nullifyingKey
	console.log('\nActual SDK Wallet Keys:')
	console.log('  masterPublicKey:', actualMasterPublicKey.toString(16))
	console.log('  nullifyingKey:', actualNullifyingKey.toString())

	// Debug: Check if the wallet's keys match - use WALLET's derivation method
	const debugNodes = deriveNodes(mnemonic, 0)
	const debugSpendingKeyPair = debugNodes.spending.getSpendingKeyPair()
	const debugViewingKeyPair = await debugNodes.viewing.getViewingKeyPair()

	// Import required functions
	const { poseidonHex } = await import('@railgun-community/engine/dist/utils/poseidon')
	const { ByteUtils } = await import('@railgun-community/engine/dist/utils/bytes')
	const { WalletNode } = await import('@railgun-community/engine/dist/key-derivation/wallet-node')

	// Compute nullifying key THE SAME WAY AS THE WALLET (from viewing private key)
	const debugNullifyingKey = ByteUtils.hexToBigInt(
		poseidonHex([ByteUtils.fastBytesToHex(debugViewingKeyPair.privateKey)])
	)

	// Compute master public key using wallet's method
	const debugMasterPublicKey = WalletNode.getMasterPublicKey(
		debugSpendingKeyPair.pubkey,
		debugNullifyingKey
	)

	console.log('\nExpected b402 zkWallet Keys (using wallet derivation):')
	console.log('  masterPublicKey:', debugMasterPublicKey.toString(16))
	console.log('  nullifyingKey:', debugNullifyingKey.toString())

	console.log(
		'\nKeys Match:',
		actualMasterPublicKey === debugMasterPublicKey && actualNullifyingKey === debugNullifyingKey
	)

	console.log('\n=== BALANCE BEFORE UNSHIELDING ===')
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

	// Inject UTXOs from API into SDK wallet database
	console.log('\n=== INJECTING UTXOs INTO SDK WALLET ===')
	await injectUTXOsIntoWallet(walletInfo.id, chain, spendableUTXOs)

	// Verify injection by checking SDK wallet's balance
	console.log('\n=== VERIFYING SDK WALLET BALANCE ===')
	try {
		const { balanceForERC20Token, fullWalletForID } = await import('@railgun-community/wallet')

		const fullWallet = fullWalletForID(walletInfo.id)

		// Get token details for formatting
		const tokenContract = new ethers.Contract(config.token.address, ERC20_ABI, provider)
		const symbol = await tokenContract.symbol()
		const decimals = await tokenContract.decimals()

		const sdkSpendableBalance = await balanceForERC20Token(
			TXIDVersion.V2_PoseidonMerkle,
			fullWallet,
			NetworkName.BNBChain,
			config.token.address,
			true // onlySpendable
		)

		const sdkTotalBalance = await balanceForERC20Token(
			TXIDVersion.V2_PoseidonMerkle,
			fullWallet,
			NetworkName.BNBChain,
			config.token.address,
			false // all UTXOs
		)

		console.log('[SDK Wallet Balance After Injection]')
		console.log('  Spendable:', ethers.formatUnits(sdkSpendableBalance, decimals), symbol)
		console.log('  Total:', ethers.formatUnits(sdkTotalBalance, decimals), symbol)

		if (sdkSpendableBalance === 0n) {
			console.warn('⚠️  WARNING: SDK wallet still shows 0 balance after injection!')
		} else {
			console.log('✅ SDK wallet successfully sees injected UTXOs')
		}
	} catch (error) {
		console.error('Failed to verify SDK wallet balance:', error)
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

	// Get token details
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

	console.log('\n=== BUILDING UNSHIELD TRANSACTIONS ===')
	console.log(`Will unshield ${selectedUTXOs.length} UTXO(s) individually to reach target amount`)

	// Prompt user to continue
	console.log('\n=== READY TO UNSHIELD ===')
	console.log('Review the information above.')
	console.log('Press ENTER to continue with proof generation and unshield, or Ctrl+C to cancel...')

	await new Promise<void>((resolve) => {
		process.stdin.once('data', () => {
			resolve()
		})
	})

	const sendWithPublicWallet = config.mode === 'eoa'
	let totalUnshielded = 0n
	const txHashes: string[] = []

	// Process each UTXO individually
	for (let i = 0; i < selectedUTXOs.length; i++) {
		const utxo = selectedUTXOs[i]
		const remainingAmount = config.amount - totalUnshielded

		// Determine how much to unshield from this UTXO
		// Use the full UTXO value (or remaining amount, whichever is smaller)
		const unshieldAmount =
			utxo.txo.note.value < remainingAmount ? utxo.txo.note.value : remainingAmount

		console.log(
			`\n=== UNSHIELDING UTXO ${i + 1}/${selectedUTXOs.length} (Position ${utxo.txo.position}) ===`
		)
		console.log(`Amount: ${ethers.formatUnits(unshieldAmount, decimals)} ${symbol}`)
		console.log(
			`Progress: ${ethers.formatUnits(totalUnshielded + unshieldAmount, decimals)}/${ethers.formatUnits(config.amount, decimals)} ${symbol}`
		)

		const erc20AmountRecipients: RailgunERC20AmountRecipient[] = [
			{
				tokenAddress: config.token.address,
				amount: unshieldAmount,
				recipientAddress: config.recipientAddress
			}
		]

		// Generate proof (this takes time!)
		console.log('\nGenerating zero-knowledge proof (this may take 10-30 seconds)...')
		const proofStartTime = Date.now()

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
		console.log('Populating unshield transaction...')

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
			console.log('Sending transaction through Waku broadcaster network...')

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
			console.log('Sending transaction directly from EOA...')

			const wallet = new ethers.Wallet(config.eoaPrivateKey, provider)
			const tx = await wallet.sendTransaction(populateResponse.transaction)
			txHash = tx.hash
			console.log('Transaction sent! Hash:', txHash)
		}

		// Wait for confirmation
		console.log('Waiting for confirmation...')
		const receipt = await provider.waitForTransaction(txHash)
		console.log('Confirmed in block:', receipt?.blockNumber)

		txHashes.push(txHash)
		totalUnshielded += unshieldAmount

		// Stop if we've unshielded enough
		if (totalUnshielded >= config.amount) {
			console.log(
				`\n✅ Target amount reached: ${ethers.formatUnits(totalUnshielded, decimals)} ${symbol}`
			)
			break
		}
	}

	console.log(`\n=== UNSHIELD COMPLETE ===`)
	console.log(`Total unshielded: ${ethers.formatUnits(totalUnshielded, decimals)} ${symbol}`)
	console.log(`Transaction hashes:`)
	txHashes.forEach((hash, i) => console.log(`  ${i + 1}. ${hash}`))

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
