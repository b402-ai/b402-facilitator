import { encodeAddress } from '@railgun-community/engine/dist/key-derivation/bech32'
import { deriveNodes } from '@railgun-community/engine/dist/key-derivation/wallet-node'
import type { Chain } from '@railgun-community/engine/dist/models/engine-types'
import {
	type FallbackProviderJsonConfig,
	NetworkName,
	type RailgunERC20AmountRecipient,
	TXIDVersion
} from '@railgun-community/shared-models'
import {
	createRailgunWallet,
	getEngine,
	loadProvider,
	populateShield,
	setOnBalanceUpdateCallback,
	startRailgunEngine,
	stopRailgunEngine
} from '@railgun-community/wallet'
import 'dotenv/config'
import { Contract, ethers } from 'ethers'
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
import {
	createFileBasedArtifactStore,
	deriveMnemonicFromEOA,
	getShieldPrivateKey
} from './utils/railgun'
import { calculateInclusiveFee, fetchUnshieldFee } from './utils/railgun-fees'
import { fetchSpendableUTXOs } from './utils/unshield-api'

interface CleanEntryConfig {
	eoaPrivateKey: string
	rpcUrl: string
	apiUrl: string
	token: {
		address: string
		decimals?: number
	}
	shieldAmount: bigint
	railgunSmartWalletAddress: string
	recipientAddress: string
}

// --- Config (edit this) ----
const CONFIG: CleanEntryConfig = {
	eoaPrivateKey: '',
	rpcUrl: process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org',
	apiUrl: process.env.API_URL || 'http://localhost:3002',
	token: {
		address: '0x55d398326f99059fF775485246999027B3197955',
		decimals: 18
	},
	shieldAmount: ethers.parseUnits('0.012', 18),
	railgunSmartWalletAddress: '0x590162bf4b50F6576a459B75309eE21D92178A10',
	recipientAddress: '' // leave empty, will be determinstically generated as incognito smart wallet address derived from `eoaPrivateKey`
}
// ---------------------------

const ERC20_ABI = [
	'function symbol() view returns (string)',
	'function decimals() view returns (uint8)',
	'function balanceOf(address) view returns (uint256)',
	'function approve(address spender, uint256 amount) external returns (bool)',
	'function allowance(address owner, address spender) external view returns (uint256)'
]

interface ShieldCommitment {
	transactionHash: string
	commitmentHash: string
	treeNumber: string
	position: string
	tokenAddress: string
	tokenType: number
	tokenSubID: string
	amount: string
	fee: string
	npk: string
	encryptedBundle0: string
	encryptedBundle1: string
	encryptedBundle2: string
	shieldKey: string
}

async function waitForShieldCommitment(
	apiUrl: string,
	eoaAddress: string,
	txHash: string,
	timeoutMs = 180000
): Promise<ShieldCommitment> {
	const pollInterval = 10000
	const maxAttempts = Math.floor(timeoutMs / pollInterval)

	console.log(`\nWaiting for shield commitment to be indexed (max ${timeoutMs / 1000}s)...`)

	for (let i = 0; i < maxAttempts; i++) {
		try {
			const response = await fetch(`${apiUrl}/privacy/commitments?eoa=${eoaAddress}`)
			if (!response.ok) {
				console.warn(`API request failed: ${response.status} ${response.statusText}`)
			} else {
				const data = await response.json()
				const shields = data.shields || []

				const foundShield = shields.find(
					(s: { transactionHash: string }) =>
						s.transactionHash.toLowerCase() === txHash.toLowerCase()
				)

				if (foundShield) {
					console.log(`✅ Shield commitment indexed! (attempt ${i + 1}/${maxAttempts})`)
					console.log(`   Commitment hash: ${foundShield.commitmentHash}`)
					console.log(`   Tree: ${foundShield.treeNumber}, Position: ${foundShield.position}`)
					return foundShield
				}
			}
		} catch (error) {
			console.warn(`Error polling API (attempt ${i + 1}):`, error)
		}

		if (i < maxAttempts - 1) {
			console.log(
				`Attempt ${i + 1}/${maxAttempts} - not found yet, waiting ${pollInterval / 1000}s...`
			)
			await new Promise((resolve) => setTimeout(resolve, pollInterval))
		}
	}

	throw new Error(`Timeout: Shield commitment not indexed after ${timeoutMs / 1000}s`)
}

async function cleanEntry(config: CleanEntryConfig) {
	if (!config.eoaPrivateKey) {
		throw new Error('EOA_PRIVATE_KEY environment variable is required')
	}

	const provider = new ethers.JsonRpcProvider(config.rpcUrl)
	const eoaWallet = new ethers.Wallet(config.eoaPrivateKey, provider)

	const unshieldEOA = deriveUnshieldEOA(config.eoaPrivateKey)
	const smartWalletAddress = await computeMasterWalletAddress(unshieldEOA.address)
	config.recipientAddress = smartWalletAddress

	console.log('=== B402 CLEAN ENTRY (SHIELD + UNSHIELD) ===')
	console.log('Shield EOA Address:', eoaWallet.address)
	console.log('Derived Unshield EOA:', unshieldEOA.address)
	console.log('Unshield Recipient (Smart Wallet):', config.recipientAddress)
	console.log('API URL:', config.apiUrl)

	console.log('\n=== INITIALIZING RAILGUN ENGINE ===')

	const db = new MemoryLevel()
	const walletSource = 'b402cleanentry'
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

	setOnBalanceUpdateCallback((balanceUpdate) => {
		console.log('Balance update:', JSON.stringify(balanceUpdate, null, 2))
	})

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

	const nodes = deriveNodes(mnemonic, 0)
	const spendingKeyPair = nodes.spending.getSpendingKeyPair()
	const viewingKeyPair = await nodes.viewing.getViewingKeyPair()

	const { poseidonHex } = await import('@railgun-community/engine/dist/utils/poseidon')
	const { ByteUtils } = await import('@railgun-community/engine/dist/utils/bytes')
	const { WalletNode } = await import('@railgun-community/engine/dist/key-derivation/wallet-node')

	const nullifyingKey = ByteUtils.hexToBigInt(
		poseidonHex([ByteUtils.fastBytesToHex(viewingKeyPair.privateKey)])
	)

	const masterPublicKey = WalletNode.getMasterPublicKey(spendingKeyPair.pubkey, nullifyingKey)

	const addressData = {
		masterPublicKey,
		viewingPublicKey: viewingKeyPair.pubkey
	}

	const railgunAddress = encodeAddress(addressData)

	console.log('\n=== BALANCE BEFORE OPERATIONS ===')
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

	console.log('\n=== PHASE 1: SHIELD TOKENS ===')

	const tokenContract = new Contract(config.token.address, ERC20_ABI, provider)
	const symbol = await tokenContract.symbol()
	const decimals = await tokenContract.decimals()

	console.log('Token:', symbol)
	console.log('Amount to shield:', ethers.formatUnits(config.shieldAmount, decimals))

	const balance = await tokenContract.balanceOf(eoaWallet.address)
	console.log('EOA token balance:', ethers.formatUnits(balance, decimals))

	if (balance < config.shieldAmount) {
		throw new Error('Insufficient token balance for shielding')
	}

	const tokenWithSigner = tokenContract.connect(eoaWallet)
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const allowance = await (tokenWithSigner as any).allowance(
		eoaWallet.address,
		config.railgunSmartWalletAddress
	)

	if (allowance < config.shieldAmount) {
		console.log('Approving token spend...')
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const approveTx = await (tokenWithSigner as any).approve(
			config.railgunSmartWalletAddress,
			ethers.MaxUint256
		)
		console.log('Approval tx:', approveTx.hash)
		await approveTx.wait()
		console.log('✅ Approval confirmed')
	}

	console.log('\nBuilding shield transaction...')

	const erc20AmountRecipients: RailgunERC20AmountRecipient[] = [
		{
			tokenAddress: config.token.address,
			amount: config.shieldAmount,
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

	console.log('Sending shield transaction...')
	const shieldTx = await eoaWallet.sendTransaction(transaction)
	console.log('✅ Shield tx sent! Hash:', shieldTx.hash)

	const shieldReceipt = await shieldTx.wait()
	if (!shieldReceipt) {
		throw new Error('Shield transaction receipt not available')
	}

	console.log('✅ Shield confirmed in block:', shieldReceipt.blockNumber)
	console.log('Gas used:', shieldReceipt.gasUsed.toString())

	const shieldCommitment = await waitForShieldCommitment(
		config.apiUrl,
		eoaWallet.address,
		shieldTx.hash
	)

	console.log('\nWaiting 15 seconds for merkle tree to sync...')
	await new Promise((resolve) => setTimeout(resolve, 15000))

	console.log('\n=== PHASE 2: UNSHIELD TOKENS ===')
	console.log('Targeting shield commitment:', shieldCommitment.commitmentHash)

	console.log('\nFetching Railgun contract fee...')
	const unshieldFee = await fetchUnshieldFee(config.rpcUrl, config.railgunSmartWalletAddress)
	console.log(
		`Unshield fee: ${(Number(unshieldFee) / 100).toFixed(2)}% (${unshieldFee} basis points)`
	)

	console.log('\nFetching spendable UTXOs from API...')

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

	const targetUTXO = spendableUTXOs.find(
		(utxo) =>
			utxo.txo.blindedCommitment.toLowerCase() === shieldCommitment.commitmentHash.toLowerCase()
	)

	if (!targetUTXO) {
		console.warn('⚠️  Warning: Could not find the specific shield commitment in spendable UTXOs')
		console.warn('   This may mean it was already spent or not yet processed')
		console.warn('   Available commitments:')
		for (const utxo of spendableUTXOs) {
			console.warn(
				`     - ${utxo.txo.blindedCommitment} (tree ${utxo.txo.tree}, pos ${utxo.txo.position})`
			)
		}

		throw new Error('Shield commitment not found in spendable UTXOs')
	}

	console.log('✅ Found target shield commitment in spendable UTXOs')
	console.log(`   Tree: ${targetUTXO.txo.tree}, Position: ${targetUTXO.txo.position}`)
	console.log(`   Value: ${ethers.formatUnits(targetUTXO.txo.note.value, decimals)} ${symbol}`)

	console.log('\nMerkle proof details:')
	console.log(`   Root: ${targetUTXO.merkleProof.root}`)
	console.log(`   Leaf index: ${targetUTXO.merkleProof.leafIndex}`)
	console.log(`   Tree depth: ${targetUTXO.merkleProof.treeDepth}`)
	console.log(`   Proof elements: ${targetUTXO.merkleProof.proof.length}`)
	console.log(`   Path indices: [${targetUTXO.merkleProof.pathIndices.join(', ')}]`)

	// For the circuit: unshieldAmount is the FULL UTXO value being unshielded
	// The circuit doesn't calculate fees - that's done by the smart contract
	const unshieldAmount = targetUTXO.txo.note.value
	const { base: actualReceiveAmount } = calculateInclusiveFee(unshieldAmount, unshieldFee)

	console.log(
		`\nWill unshield the full shield amount: ${ethers.formatUnits(unshieldAmount, config.token.decimals || 18)} ${symbol}`
	)
	console.log(
		`You will receive (after ${(Number(unshieldFee) / 100).toFixed(2)}% fee): ${ethers.formatUnits(actualReceiveAmount, config.token.decimals || 18)} ${symbol}`
	)

	console.log('\n=== ESTIMATING GAS ===')
	const feeData = await provider.getFeeData()
	const gasPrice = feeData.gasPrice || ethers.parseUnits('3', 'gwei')
	const estimatedGas = 500000n

	console.log('Gas price:', ethers.formatUnits(gasPrice, 'gwei'), 'gwei')
	console.log('Estimated gas:', estimatedGas.toString())

	console.log('\n=== READY TO UNSHIELD ===')
	console.log('Press ENTER to continue with proof generation and unshield, or Ctrl+C to cancel...')

	await new Promise<void>((resolve) => {
		process.stdin.once('data', () => {
			resolve()
		})
	})

	const utxo = targetUTXO
	const { fee: contractFee } = calculateInclusiveFee(unshieldAmount, unshieldFee)

	console.log(`\n=== UNSHIELDING SHIELD COMMITMENT (Position ${utxo.txo.position}) ===`)
	console.log(`UTXO value: ${ethers.formatUnits(utxo.txo.note.value, decimals)} ${symbol}`)
	console.log(
		`Unshield amount (incl. fee): ${ethers.formatUnits(unshieldAmount, decimals)} ${symbol}`
	)
	console.log(
		`Contract fee (${(Number(unshieldFee) / 100).toFixed(2)}%): ${ethers.formatUnits(contractFee, decimals)} ${symbol}`
	)
	console.log(`You will receive: ${ethers.formatUnits(actualReceiveAmount, decimals)} ${symbol}`)

	console.log('\nBuilding proof inputs from API merkle proof...')
	const unshieldNullifyingKey = await nodes.viewing.getNullifyingKey()

	const { privateInputs, publicInputs } = buildUnshieldProofInputs({
		utxo: utxo.txo,
		merkleProof: utxo.merkleProof,
		nullifyingKey: unshieldNullifyingKey,
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

	const populateResponse = encodeUnshieldTransaction(
		transactionStruct,
		config.railgunSmartWalletAddress
	)
	console.log(
		`✅ Transaction formatted with nullifier: 0x${publicInputs.nullifiers[0].toString(16)}`
	)

	console.log('\nQueuing unshield transaction with backend...')

	const nullifiers = [publicInputs.nullifiers[0].toString(16).padStart(64, '0')].map(
		(n) => `0x${n}`
	)

	const queueRequest = {
		txidVersion: TXIDVersion.V2_PoseidonMerkle,
		transactionTo: config.railgunSmartWalletAddress,
		transactionData: populateResponse.data,
		broadcasterAddress: railgunAddress,
		feesID: 'b402-clean-entry',
		chain: { type: chain.type, id: chain.id },
		nullifiers: nullifiers,
		minGasPrice: gasPrice.toString(),
		useRelayAdapt: false,
		poiProofs: {}
	}

	const response = await fetch(`${config.apiUrl}/privacy/queue-unshield`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(queueRequest)
	})

	if (!response.ok) {
		const errorText = await response.text()
		throw new Error(`Queue failed: ${response.status} ${errorText}`)
	}

	const queueResult = await response.json()

	if (queueResult.exists) {
		console.log('✅ Unshield already queued')
		console.log(`   Unshield ID: ${queueResult.unshieldId}`)
		console.log(`   Time elapsed: ${queueResult.timeElapsedMinutes} minutes since initial queue`)
		console.log(`   Time remaining: ${queueResult.timeRemainingMinutes} minutes until broadcast`)
		if (queueResult.broadcasterTxHash) {
			console.log(`   Broadcaster TX: ${queueResult.broadcasterTxHash}`)
		}
	} else {
		console.log('✅ Unshield queued successfully!')
		console.log(`   Unshield ID: ${queueResult.unshieldId}`)
		console.log('   Transaction will be broadcast in 1-3 hours with random delay')
		console.log('   Check backend logs or database for broadcast status')
	}

	console.log('\n=== CLEAN ENTRY COMPLETE ===')
	console.log('Shield transaction:', shieldTx.hash)
	console.log('  Confirmed in block:', shieldReceipt.blockNumber)
	console.log('  Amount shielded:', ethers.formatUnits(config.shieldAmount, decimals), symbol)
	console.log('\nUnshield queued for delayed broadcast (1-3 hours)')
	console.log(
		'  Expected to receive:',
		ethers.formatUnits(actualReceiveAmount, decimals),
		symbol,
		`(after ${(Number(unshieldFee) / 100).toFixed(2)}% fee)`
	)
	console.log('  Recipient:', config.recipientAddress)

	await stopRailgunEngine()
}

cleanEntry(CONFIG).catch((error) => {
	console.error('Error:', error.message)
	stopRailgunEngine().finally(() => process.exit(1))
})
