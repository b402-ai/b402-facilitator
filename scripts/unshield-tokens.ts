import {
	type BroadcasterConnectionStatus,
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
	balanceForERC20Token,
	calculateBroadcasterFeeERC20Amount,
	createRailgunWallet,
	fullWalletForID,
	generateUnshieldProof,
	getEngine,
	loadProvider,
	populateProvedUnshield,
	refreshBalances,
	startRailgunEngine,
	stopRailgunEngine
} from '@railgun-community/wallet'
import 'dotenv/config'
import { ethers } from 'ethers'
import { MemoryLevel } from 'memory-level'
import * as path from 'node:path'
import * as snarkjs from 'snarkjs'

import { getPrivacyBalance } from './utils/balance'
import { ERC20_ABI, createFileBasedArtifactStore, deriveMnemonicFromEOA } from './utils/railgun'

type UnshieldMode = 'broadcaster' | 'eoa'

interface UnshieldConfig {
	mode: UnshieldMode // 'broadcaster' for Waku network (private), 'eoa' for direct signing (faster)
	eoaPrivateKey: string // For 'eoa' mode: signs tx directly. For 'broadcaster' mode: only derives RAILGUN wallet
	token: {
		address: string
		decimals?: number
	}
	amount: bigint
	recipientAddress: string
	railgunSmartWalletAddress: string
	rpcUrl: string
	apiUrl: string // B402 Backend API URL for privacy operations
}

// --- Config (edit this) ---
const CONFIG: UnshieldConfig = {
	mode: 'broadcaster', // 'broadcaster' for Waku network privacy, 'eoa' for direct EOA signing
	eoaPrivateKey: '',
	token: {
		address: '0x55d398326f99059fF775485246999027B3197955', // USDT
		decimals: 18
	},
	amount: ethers.parseUnits('0.005', 18),
	recipientAddress: '0x0553b926d6a599caac56377042ca6b40dd0b7f4e', // Where tokens go
	railgunSmartWalletAddress: '0x590162bf4b50f6576a459b75309ee21d92178a10',
	rpcUrl: process.env.BSC_RPC_URL || '',
	apiUrl: 'http://localhost:3000' // B402 Backend API URL (edit this)
}
// ---------------------------

async function initializeBroadcaster(chain: { type: number; id: number }): Promise<void> {
	return new Promise((resolve, reject) => {
		let hasResolved = false
		let searchingCount = 0
		const timeout = setTimeout(() => {
			if (!hasResolved) {
				hasResolved = true
				reject(
					new Error(
						'Broadcaster initialization timeout after 60 seconds. No broadcasters found for BSC Chain 56. This may mean no broadcasters are currently online for this network.'
					)
				)
			}
		}, 60000) // 60 seconds

		const statusCallback = (
			_chain: { type: number; id: number },
			status: BroadcasterConnectionStatus
		) => {
			if (status === 'Searching') {
				searchingCount++
				if (searchingCount % 5 === 0) {
					console.log(`Broadcaster status: Searching (${searchingCount * 3}s elapsed)...`)
				}
			} else {
				console.log(`Broadcaster status: ${status}`)
			}

			if (status === 'Connected' && !hasResolved) {
				hasResolved = true
				clearTimeout(timeout)
				console.log('Waiting 5 seconds for broadcaster fee discovery...')
				// Give it a few seconds to discover broadcasters and their fees
				setTimeout(() => resolve(), 5000)
			} else if (status === 'AllUnavailable' && !hasResolved) {
				hasResolved = true
				clearTimeout(timeout)
				reject(
					new Error(
						`No broadcasters available for BSC Chain 56. This network may not have active broadcasters at the moment.`
					)
				)
			}
		}

		console.log('Starting Waku broadcaster client...')

		const debugLogger = {
			log: (msg: string) => console.log('[Waku Debug]', msg),
			error: (error: Error) => console.error('[Waku Error]', error.message)
		}

		WakuBroadcasterClient.start(
			chain,
			{
				trustedFeeSigner:
					'0zk1qyv0zc0j9sm6mr8fe3gx7ymwc6d2xymfftqvgvjdy3r8dmyfs947lrv7j6fe3z53llx97s6mxjstvn9wj3xhyv4cfecw08gqzywgnl0fmzx3mguhr2hyych4srf',
				peerDiscoveryTimeout: 30000, // 30 seconds for peer discovery
				feeExpirationTimeout: 45000, // 45 seconds for fee expiration
				useDNSDiscovery: true, // Enable DNS peer discovery
				// Add direct peers to help with initial connection
				additionalDirectPeers: [
					'/dns4/node-01.do-ams3.wakuv2.prod.statusim.net/tcp/8000/wss/p2p/16Uiu2HAmPLe7Mzm8TsYUubgCAW1aJoeFScxrLj8ppHFivPo97bUZ'
				]
			},
			statusCallback,
			debugLogger
		)
	})
}

async function unshieldTokens(config: UnshieldConfig) {
	if (!config.eoaPrivateKey || config.eoaPrivateKey === '') {
		throw new Error('EOA private key not configured (used only for deriving RAILGUN wallet)')
	}
	if (!config.rpcUrl || config.rpcUrl === '') {
		throw new Error('RPC URL not configured - please set BSC_RPC_URL in .env file')
	}
	if (!config.railgunSmartWalletAddress) {
		throw new Error('Railgun Smart Wallet address not configured')
	}
	if (!config.recipientAddress) {
		throw new Error('Recipient address not configured')
	}
	if (!config.apiUrl || config.apiUrl === '') {
		throw new Error('API URL not configured')
	}

	// Check balance BEFORE unshielding
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
		console.warn('Could not fetch balance before unshielding:', error)
		console.log('Continuing with unshield operation...\n')
	}

	const provider = new ethers.JsonRpcProvider(config.rpcUrl)
	const db = new MemoryLevel()
	const artifactsDir = path.join(process.cwd(), '.railgun-artifacts')
	const artifactStore = createFileBasedArtifactStore(artifactsDir)
	const walletSource = 'b402unshield'

	console.log('Using artifacts directory:', artifactsDir)

	await startRailgunEngine(
		walletSource,
		db,
		false, // shouldDebug
		artifactStore,
		false, // useNativeArtifacts (false for snarkjs)
		false, // skipMerkletreeScans
		['https://ppoi-agg.horsewithsixlegs.xyz'], // poiNodeURLs
		[], // customPOILists
		false // verboseScanLogging
	)

	// Configure snarkjs as the prover
	const engine = getEngine()
	engine.prover.setSnarkJSGroth16(snarkjs.groth16)
	console.log('Configured snarkjs as the ZK prover')

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
	const encryptionKey = ethers.keccak256(ethers.toUtf8Bytes('b402-encryption-key')).slice(2)
	const creationBlockNumbers = { [NetworkName.BNBChain]: 70253312 }

	const walletInfo = await createRailgunWallet(encryptionKey, mnemonic, creationBlockNumbers)

	console.log('RAILGUN Address (zk-address):', walletInfo.railgunAddress)
	console.log('Wallet ID:', walletInfo.id)

	// Wait for initial sync to complete
	console.log('\nWaiting for balance scan to complete (may take a minute)...')

	const chain = { type: 0, id: 56 } // NetworkType.EVM = 0, ChainID 56 for BSC

	// Initialize broadcaster client (only if in broadcaster mode)
	let selectedBroadcaster: SelectedBroadcaster | undefined

	if (config.mode === 'broadcaster') {
		console.log('\nMode: BROADCASTER (Waku network - private)')
		console.log('Initializing Waku Broadcaster Client...')
		console.log('Note: Requires Node.js 22+. Your version:', process.version)

		await initializeBroadcaster(chain)
		console.log('Broadcaster client connected successfully!')
	} else {
		console.log('\nMode: EOA (Direct signing - faster, no IP privacy)')
	}

	// Poll for balance for up to 60 seconds
	let balanceScanComplete = false
	const scanStartTime = Date.now()
	const scanTimeout = 60000 // 60 seconds

	while (!balanceScanComplete && Date.now() - scanStartTime < scanTimeout) {
		await new Promise((resolve) => setTimeout(resolve, 3000)) // Wait 3s between checks

		try {
			await refreshBalances(chain, [walletInfo.id])

			const wallet = fullWalletForID(walletInfo.id)
			const spendableBalance = await balanceForERC20Token(
				TXIDVersion.V2_PoseidonMerkle,
				wallet,
				NetworkName.BNBChain,
				config.token.address,
				true // onlySpendable
			)

			const totalBalance = await balanceForERC20Token(
				TXIDVersion.V2_PoseidonMerkle,
				wallet,
				NetworkName.BNBChain,
				config.token.address,
				false // ALL balance, including non-spendable
			)

			console.log('Spendable USDT balance:', ethers.formatUnits(spendableBalance, 18))
			console.log('Total USDT balance:', ethers.formatUnits(totalBalance, 18))

			balanceScanComplete = true
			console.log('Balance scan completed.')
		} catch (error) {
			const elapsed = Math.floor((Date.now() - scanStartTime) / 1000)
			console.log(`Still scanning... (${elapsed}s elapsed)`)
		}
	}

	if (!balanceScanComplete) {
		throw new Error('Error: Indexer sync timeout')
	}

	const tokenContract = new ethers.Contract(config.token.address, ERC20_ABI, provider)

	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const symbol = await (tokenContract as any).symbol()
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const decimals = await (tokenContract as any).decimals()

		console.log('Token: ', symbol)
		console.log('Amount to unshield: ', ethers.formatUnits(config.amount, decimals))
	} catch (error) {
		console.log('Could not fetch token info')
	}

	// Find broadcaster (only if in broadcaster mode)
	if (config.mode === 'broadcaster') {
		console.log('\nFinding best broadcaster for token...')
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
	}

	console.log('\nBuilding unshield transaction...')
	console.log('(SDK will download ZK artifacts automatically during proof generation)')

	const erc20AmountRecipients: RailgunERC20AmountRecipient[] = [
		{
			tokenAddress: config.token.address,
			amount: config.amount,
			recipientAddress: config.recipientAddress
		}
	]

	// Get gas estimate and calculate fees
	const feeData = await provider.getFeeData()
	const gasPrice = feeData.gasPrice || 3000000000n // 3 gwei default
	const estimatedGas = 1000000n // Estimated gas for unshield

	// Calculate broadcaster fee (only if in broadcaster mode)
	let broadcasterFeeRecipient: RailgunERC20AmountRecipient | undefined

	if (config.mode === 'broadcaster' && selectedBroadcaster) {
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
			ethers.formatUnits(broadcasterFeeERC20Amount.amount, config.token.decimals || 18),
			'tokens'
		)
	}

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

unshieldTokens(CONFIG).catch((error) => {
	console.error('Error: ', error.message)
	if (CONFIG.mode === 'broadcaster') {
		WakuBroadcasterClient.stop()
	}
	stopRailgunEngine().finally(() => process.exit(1))
})
