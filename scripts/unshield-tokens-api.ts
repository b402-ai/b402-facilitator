import { deriveNodes } from '@railgun-community/engine/dist/key-derivation/wallet-node'
import type { Chain } from '@railgun-community/engine/dist/models/engine-types'
import {
	EVMGasType,
	type FallbackProviderJsonConfig,
	NetworkName,
	type RailgunERC20Amount,
	type RailgunERC20AmountRecipient,
	type SelectedBroadcaster,
	TXIDVersion
} from '@railgun-community/shared-models'
import {
	BroadcasterTransaction,
	WakuBroadcasterClient
} from '@railgun-community/waku-broadcaster-client-node'
import {
	calculateBroadcasterFeeERC20Amount,
	createRailgunWallet,
	getEngine,
	loadProvider,
	setOnBalanceUpdateCallback,
	startRailgunEngine,
	stopRailgunEngine,
	walletForID
} from '@railgun-community/wallet'
import 'dotenv/config'
import { ethers } from 'ethers'
import { MemoryLevel } from 'memory-level'
import * as snarkjs from 'snarkjs'

import { computeMasterWalletAddress, deriveUnshieldEOA } from '../src/utils/wallet'
import { buildUnshieldProofInputs } from './railgun-core/proof/inputs-builder'
import { generateProofManually } from './railgun-core/proof/prover'
import {
	encodeUnshieldTransaction,
	formatUnshieldTransaction
} from './railgun-core/transaction/formatter'
import { getPrivacyBalance } from './utils/balance'
import { createFileBasedArtifactStore, deriveMnemonicFromEOA } from './utils/railgun'
import {
	calculateInclusiveFee,
	calculateRequiredUnshieldAmount,
	fetchUnshieldFee,
	formatFeeInfo
} from './utils/railgun-fees'
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
			false, // skipMerkletreeScans: false - Required to create wallet, but we'll scan from latest block (0 blocks)
			['https://ppoi-agg.horsewithsixlegs.xyz'],
			[],
			false
		)
		console.log('✅ Railgun engine started successfully')
	} catch (error) {
		console.error('❌ Failed to start Railgun engine:', error)
		throw error
	}

	// Set balance update callback
	setOnBalanceUpdateCallback((balanceUpdate) => {
		console.log('Balance update:', JSON.stringify(balanceUpdate, null, 2))
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

	// Create wallet from current block to avoid scanning
	// We don't need scanning because we inject UTXOs and commitments from B402 API
	const currentBlock = await provider.getBlockNumber()
	console.log('Current block:', currentBlock)
	console.log('Creating wallet from current block (will scan 0 blocks - API-first approach)...')

	const creationBlockNumbers = { [NetworkName.BNBChain]: currentBlock }
	const walletInfo = await createRailgunWallet(encryptionKey, mnemonic, creationBlockNumbers)

	// No need to wait for wallet scan - we're starting from current block (0 blocks to scan)
	// and we're using API data instead of blockchain scanning
	console.log('✅ Wallet created (API-first mode - no blockchain scanning needed)')

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

	console.log('\n=== FETCHING RAILGUN CONTRACT FEE ===')
	const railgunContractAddress = '0x590162bf4b50F6576a459B75309eE21D92178A10' // BSC Railgun contract
	const unshieldFee = await fetchUnshieldFee(config.rpcUrl, railgunContractAddress)
	console.log(
		`Unshield fee: ${(Number(unshieldFee) / 100).toFixed(2)}% (${unshieldFee} basis points)`
	)

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

	// NOTE: We do NOT inject UTXOs or commitments into SDK's database/merkletree!
	// We bypass the SDK's transaction flow entirely and use API merkle proofs directly.
	console.log('✅ Using API-first approach - no SDK database/merkletree injection needed')

	// Calculate total available AFTER contract fees
	const totalAvailableRaw = spendableUTXOs.reduce((sum, utxo) => sum + utxo.txo.note.value, 0n)
	const totalAvailableAfterFees = calculateInclusiveFee(totalAvailableRaw, unshieldFee).base

	console.log(
		`Total available (raw): ${ethers.formatUnits(totalAvailableRaw, config.token.decimals || 18)}`
	)
	console.log(
		`Total available (after ${(Number(unshieldFee) / 100).toFixed(2)}% fee): ${ethers.formatUnits(totalAvailableAfterFees, config.token.decimals || 18)}`
	)

	if (totalAvailableAfterFees < config.amount) {
		throw new Error(
			`Insufficient balance after fees: need ${ethers.formatUnits(config.amount, config.token.decimals || 18)}, have ${ethers.formatUnits(totalAvailableAfterFees, config.token.decimals || 18)} (after ${(Number(unshieldFee) / 100).toFixed(2)}% contract fee)`
		)
	}

	// Calculate how much we need to unshield (including fees) to receive config.amount
	const requiredUnshieldAmount = calculateRequiredUnshieldAmount(config.amount, unshieldFee)
	console.log(
		`Target receive amount: ${ethers.formatUnits(config.amount, config.token.decimals || 18)}`
	)
	console.log(
		`Required unshield amount (incl. fee): ${ethers.formatUnits(requiredUnshieldAmount, config.token.decimals || 18)}`
	)

	// SIMPLIFICATION: Just use the first available UTXO
	// This avoids complexity with fee calculations and partial spends
	const selectedUTXOs = spendableUTXOs.slice(0, 1)

	if (selectedUTXOs.length === 0) {
		throw new Error('No spendable UTXOs available')
	}

	const { base: selectedTotalReceivable } = calculateInclusiveFee(
		selectedUTXOs[0].txo.note.value,
		unshieldFee
	)

	const selectedTotalValue = selectedUTXOs.reduce((sum, utxo) => sum + utxo.txo.note.value, 0n)
	console.log(
		`Selected ${selectedUTXOs.length} UTXOs with total value ${ethers.formatUnits(selectedTotalValue, config.token.decimals || 18)}`
	)
	console.log(
		`You will receive (after 0.25% fee): ${ethers.formatUnits(selectedTotalReceivable, config.token.decimals || 18)}`
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

		// Check if we've already reached the target BEFORE processing this UTXO
		if (totalUnshielded >= config.amount) {
			console.log(
				`\n✅ Target amount already reached (${ethers.formatUnits(totalUnshielded, decimals)}/${ethers.formatUnits(config.amount, decimals)} ${symbol}), skipping remaining ${selectedUTXOs.length - i} UTXO(s)`
			)
			break
		}
		const remainingAmountNeeded = config.amount - totalUnshielded

		// Calculate how much we need to unshield to get remainingAmountNeeded (after fees)
		const requiredUnshieldForRemaining = calculateRequiredUnshieldAmount(
			remainingAmountNeeded,
			unshieldFee
		)

		// Determine how much to actually unshield from this UTXO
		// IMPORTANT: For now, always unshield the FULL UTXO value (no change)
		// Partial unshield requires 1x2 circuit support which we haven't implemented yet
		const unshieldAmount = utxo.txo.note.value

		// Calculate actual amount user will receive (after contract fee deduction)
		const { base: actualReceiveAmount, fee: contractFee } = calculateInclusiveFee(
			unshieldAmount,
			unshieldFee
		)

		console.log(
			`\n=== UNSHIELDING UTXO ${i + 1}/${selectedUTXOs.length} (Position ${utxo.txo.position}) ===`
		)
		console.log(`UTXO value: ${ethers.formatUnits(utxo.txo.note.value, decimals)} ${symbol}`)
		console.log(
			`Unshield amount (incl. fee): ${ethers.formatUnits(unshieldAmount, decimals)} ${symbol}`
		)
		console.log(
			`Contract fee (${(Number(unshieldFee) / 100).toFixed(2)}%): ${ethers.formatUnits(contractFee, decimals)} ${symbol}`
		)
		console.log(`You will receive: ${ethers.formatUnits(actualReceiveAmount, decimals)} ${symbol}`)
		console.log(
			`Progress: ${ethers.formatUnits(totalUnshielded + actualReceiveAmount, decimals)}/${ethers.formatUnits(config.amount, decimals)} ${symbol}`
		)

		// === API-FIRST PROOF GENERATION ===
		// Step 1: Derive wallet keys (needed for proof inputs)
		console.log('\nDeriving Railgun keys...')
		const nodes = deriveNodes(mnemonic, 0) // wallet index 0
		const nullifyingKey = await nodes.viewing.getNullifyingKey()
		const spendingKeyPair = nodes.spending.getSpendingKeyPair()

		// Step 2: Build proof inputs using API merkle proof
		console.log('Building proof inputs from API merkle proof...')
		const { privateInputs, publicInputs } = buildUnshieldProofInputs({
			utxo: utxo.txo,
			merkleProof: utxo.merkleProof, // ← From B402 API!
			nullifyingKey,
			spendingKeyPair,
			unshieldAmount,
			unshieldToAddress: config.recipientAddress,
			tokenAddress: config.token.address
		})

		console.log('✅ Proof inputs built from API data')
		console.log(`  Merkle root: 0x${publicInputs.merkleRoot.toString(16)}`)
		console.log(`  Nullifier: 0x${publicInputs.nullifiers[0].toString(16)}`)

		// Step 3: Generate ZK proof using SDK's prover
		console.log('\nGenerating zero-knowledge proof (this may take 10-30 seconds)...')
		const proofStartTime = Date.now()

		const proof = await generateProofManually({
			privateInputs,
			publicInputs,
			chain,
			txidVersion: TXIDVersion.V2_PoseidonMerkle,
			unshieldToAddress: config.recipientAddress,
			treeNumber: utxo.txo.tree,
			tokenAddress: config.token.address,
			unshieldAmount,
			spendingPrivateKey: spendingKeyPair.privateKey,
			onProgress: (progress) => {
				if (progress % 0.25 === 0) {
					console.log(`  Progress: ${(progress * 100).toFixed(0)}%`)
				}
			}
		})

		const proofTime = ((Date.now() - proofStartTime) / 1000).toFixed(2)
		console.log(`✅ Proof generated in ${proofTime}s`)

		// Step 4: Format transaction for Railgun contract
		console.log('Formatting transaction for Railgun contract...')
		const transactionStruct = formatUnshieldTransaction({
			proof,
			treeNumber: utxo.txo.tree,
			tokenAddress: config.token.address,
			recipientAddress: config.recipientAddress,
			unshieldAmount,
			chain
		})

		// Get Railgun contract address for this chain
		// TODO: Make this configurable or fetch from chain config
		const railgunContractAddress = '0x590162bf4b50F6576a459B75309eE21D92178A10' // BSC Railgun contract (EIP-55 checksummed)

		const populateResponse = encodeUnshieldTransaction(transactionStruct, railgunContractAddress)
		console.log(
			`✅ Transaction formatted with nullifier: 0x${publicInputs.nullifiers[0].toString(16)}`
		)

		// Send transaction (method depends on mode)
		let txHash: string

		if (config.mode === 'broadcaster') {
			// TODO: Broadcaster mode not yet implemented for API-first flow
			// Would need to integrate with BroadcasterTransaction
			throw new Error('Broadcaster mode not yet implemented for API-first unshield')
		} else {
			// Send via EOA directly
			console.log('\nSending transaction directly from EOA...')

			const wallet = new ethers.Wallet(config.eoaPrivateKey, provider)
			const tx = await wallet.sendTransaction({
				to: populateResponse.to,
				data: populateResponse.data,
				gasLimit: estimatedGas,
				gasPrice: gasPrice
			})
			txHash = tx.hash
			console.log('✅ Transaction sent! Hash:', txHash)
		}

		// Wait for confirmation
		console.log('Waiting for confirmation...')
		const receipt = await provider.waitForTransaction(txHash)
		console.log('Confirmed in block:', receipt?.blockNumber)

		txHashes.push(txHash)
		totalUnshielded += actualReceiveAmount

		// Stop if we've received enough (after fees)
		if (totalUnshielded >= config.amount) {
			console.log(
				`\n✅ Target amount reached: ${ethers.formatUnits(totalUnshielded, decimals)} ${symbol} received`
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
