import {
	type FallbackProviderJsonConfig,
	NetworkName,
	type RailgunERC20AmountRecipient,
	TXIDVersion
} from '@railgun-community/shared-models'
import {
	ArtifactStore,
	createRailgunWallet,
	loadProvider,
	populateShield,
	startRailgunEngine,
	stopRailgunEngine
} from '@railgun-community/wallet'
import 'dotenv/config'
import { Contract, Mnemonic, Wallet, ethers } from 'ethers'
import { MemoryLevel } from 'memory-level'

interface ShieldConfig {
	eoaPrivateKey: string
	token: {
		address: string
		decimals?: number
	}
	amount: bigint
	railgunSmartWalletAddress: string
	rpcUrl: string
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
	gasLimit: 500000n
}
// ---------------------------
const B402_RESERVED_ZK_MESSAGE = 'b402 Reserved Railgun zk-Address'
const ERC20_ABI = [
	'function approve(address spender, uint256 amount) external returns (bool)',
	'function allowance(address owner, address spender) external view returns (uint256)',
	'function balanceOf(address account) external view returns (uint256)',
	'function decimals() external view returns (uint8)',
	'function symbol() external view returns (string)'
] as const

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

	const provider = new ethers.JsonRpcProvider(config.rpcUrl)
	const eoaWallet = new Wallet(config.eoaPrivateKey, provider)

	const db = new MemoryLevel()
	const artifactStore = createInMemoryArtifactStore()
	const walletSource = 'b402shield'

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

	console.log('Railgun Address (zk-address):', walletInfo.railgunAddress)
	console.log('Mnemonic: ', mnemonic)

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
			recipientAddress: walletInfo.railgunAddress
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

	return {
		txHash: tx.hash,
		blockNumber: receipt.blockNumber,
		gasUsed: receipt.gasUsed.toString(),
		railgunAddress: walletInfo.railgunAddress,
		mnemonic: mnemonic
	}
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

// ---  Helper functions ---

async function deriveMnemonicFromEOA(eoaPrivateKey: string): Promise<string> {
	const wallet = new ethers.Wallet(eoaPrivateKey)
	const message = B402_RESERVED_ZK_MESSAGE
	const signature = await wallet.signMessage(message)
	const entropy = ethers.keccak256(signature).slice(0, 34)
	const mnemonic = Mnemonic.fromEntropy(entropy)
	return mnemonic.phrase
}

function getShieldPrivateKey(): string {
	return ethers.hexlify(ethers.randomBytes(32))
}

function createInMemoryArtifactStore(): ArtifactStore {
	const storage = new Map<string, string | Buffer>()

	return new ArtifactStore(
		async (path: string) => {
			const item = storage.get(path)
			if (!item) {
				throw new Error(`Artifact not found: ${path}`)
			}
			return item
		},
		async (_dir: string, path: string, item: string | Uint8Array) => {
			// Convert Uint8Array to Buffer for storage
			const storageItem = typeof item === 'string' ? item : Buffer.from(item)
			storage.set(path, storageItem)
		},
		async (path: string) => {
			return storage.has(path)
		}
	)
}
