import { deriveNodes } from '@railgun-community/engine/dist/key-derivation/wallet-node'
import type { Chain } from '@railgun-community/engine/dist/models/engine-types'
import {
	type FallbackProviderJsonConfig,
	NetworkName,
	TXIDVersion
} from '@railgun-community/shared-models'
import {
	createRailgunWallet,
	getEngine,
	loadProvider,
	setOnBalanceUpdateCallback,
	startRailgunEngine,
	stopRailgunEngine
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
	fetchUnshieldFee
} from './utils/railgun-fees'
import { fetchSpendableUTXOs } from './utils/unshield-api'

interface UnshieldConfig {
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
	eoaPrivateKey: '',
	rpcUrl: process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org',
	apiUrl: process.env.API_URL || 'http://localhost:3002',
	token: {
		address: '0x55d398326f99059fF775485246999027B3197955',
		decimals: 18
	},
	amount: ethers.parseUnits('0.009975', 18),
	recipientAddress: '' // leave this empty
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

	console.log('=== B402 UNSHIELD ===')
	console.log('Shield EOA Address:', eoaWallet.address)
	console.log('Derived Unshield EOA:', unshieldEOA.address)
	console.log('Unshield Recipient (Smart Wallet):', config.recipientAddress)
	console.log('API URL:', config.apiUrl)

	const provider = new ethers.JsonRpcProvider(config.rpcUrl)

	console.log('=== INITIALIZING RAILGUN ENGINE ===')

	const db = new MemoryLevel()
	const walletSource = 'b402unshieldapi'
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
			false,
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
	const chain: Chain = { type: 0, id: 56 }

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

	const currentBlock = await provider.getBlockNumber()
	console.log('Current block:', currentBlock)
	console.log('Creating wallet from current block...')

	const creationBlockNumbers = { [NetworkName.BNBChain]: currentBlock }
	const walletInfo = await createRailgunWallet(encryptionKey, mnemonic, creationBlockNumbers)

	console.log('✅ Wallet created')
	console.log('Wallet ID:', walletInfo.id)
	console.log('RAILGUN Address (zk-address):', walletInfo.railgunAddress)

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

	const requiredUnshieldAmount = calculateRequiredUnshieldAmount(config.amount, unshieldFee)
	console.log(
		`Target receive amount: ${ethers.formatUnits(config.amount, config.token.decimals || 18)}`
	)
	console.log(
		`Required unshield amount (incl. fee): ${ethers.formatUnits(requiredUnshieldAmount, config.token.decimals || 18)}`
	)

	// const selectedUTXOs = spendableUTXOs.slice(-1)
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

	const tokenContract = new ethers.Contract(config.token.address, ERC20_ABI, provider)
	const symbol = await tokenContract.symbol()
	const decimals = await tokenContract.decimals()

	console.log('Token:', symbol)

	console.log('\n=== ESTIMATING GAS ===')
	const feeData = await provider.getFeeData()
	const gasPrice = feeData.gasPrice || ethers.parseUnits('3', 'gwei')
	const estimatedGas = 500000n

	console.log('Gas price:', ethers.formatUnits(gasPrice, 'gwei'), 'gwei')
	console.log('Estimated gas:', estimatedGas.toString())

	console.log('\n=== BUILDING UNSHIELD TRANSACTIONS ===')
	console.log(`Will unshield ${selectedUTXOs.length} UTXO(s) individually to reach target amount`)

	console.log('\n=== READY TO UNSHIELD ===')
	console.log('Press ENTER to continue with proof generation and unshield, or Ctrl+C to cancel...')

	await new Promise<void>((resolve) => {
		process.stdin.once('data', () => {
			resolve()
		})
	})

	let totalUnshielded = 0n
	const txHashes: string[] = []

	for (let i = 0; i < selectedUTXOs.length; i++) {
		const utxo = selectedUTXOs[i]

		if (totalUnshielded >= config.amount) {
			console.log(
				`\n✅ Target amount already reached (${ethers.formatUnits(totalUnshielded, decimals)}/${ethers.formatUnits(config.amount, decimals)} ${symbol}), skipping remaining ${selectedUTXOs.length - i} UTXO(s)`
			)
			break
		}

		// For the circuit: unshieldAmount is the FULL UTXO value being unshielded
		// The circuit doesn't calculate fees - that's done by the smart contract
		// Circuit proves: I own this UTXO and I'm unshielding this amount
		const unshieldAmount = utxo.txo.note.value
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

		console.log('\nDeriving Railgun keys...')
		const nodes = deriveNodes(mnemonic, 0)
		const nullifyingKey = await nodes.viewing.getNullifyingKey()
		const spendingKeyPair = nodes.spending.getSpendingKeyPair()

		console.log('Building proof inputs from API merkle proof...')
		const { privateInputs, publicInputs } = buildUnshieldProofInputs({
			utxo: utxo.txo,
			merkleProof: utxo.merkleProof,
			nullifyingKey,
			spendingKeyPair,
			unshieldAmount,
			unshieldToAddress: config.recipientAddress,
			tokenAddress: config.token.address
		})

		console.log('✅ Proof inputs built from API data')
		console.log(`  Merkle root: 0x${publicInputs.merkleRoot.toString(16)}`)
		console.log(`  Nullifier: 0x${publicInputs.nullifiers[0].toString(16)}`)

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

		console.log('Formatting transaction for Railgun contract...')
		const transactionStruct = formatUnshieldTransaction({
			proof,
			treeNumber: utxo.txo.tree,
			tokenAddress: config.token.address,
			recipientAddress: config.recipientAddress,
			unshieldAmount,
			chain
		})

		const railgunContractAddress = '0x590162bf4b50F6576a459B75309eE21D92178A10'

		const populateResponse = encodeUnshieldTransaction(transactionStruct, railgunContractAddress)
		console.log(
			`✅ Transaction formatted with nullifier: 0x${publicInputs.nullifiers[0].toString(16)}`
		)

		console.log('\nSending transaction...')

		const wallet = new ethers.Wallet(config.eoaPrivateKey, provider)
		const tx = await wallet.sendTransaction({
			to: populateResponse.to,
			data: populateResponse.data,
			gasLimit: estimatedGas,
			gasPrice: gasPrice
		})
		const txHash = tx.hash
		console.log('✅ Transaction sent! Hash:', txHash)

		console.log('Waiting for confirmation...')
		const receipt = await provider.waitForTransaction(txHash)
		console.log('Confirmed in block:', receipt?.blockNumber)

		txHashes.push(txHash)
		totalUnshielded += actualReceiveAmount

		if (totalUnshielded >= config.amount) {
			console.log(
				`\n✅ Target amount reached: ${ethers.formatUnits(totalUnshielded, decimals)} ${symbol} received`
			)
			break
		}
	}

	console.log('\n=== UNSHIELD COMPLETE ===')
	console.log('Total unshielded:', ethers.formatUnits(totalUnshielded, decimals), symbol)
	console.log('Transaction hashes:')
	txHashes.forEach((hash, i) => console.log(`  ${i + 1}. ${hash}`))

	await stopRailgunEngine()

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
	stopRailgunEngine().finally(() => process.exit(1))
})
