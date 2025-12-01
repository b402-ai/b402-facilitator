import 'dotenv/config'
import { Contract, Wallet, ethers } from 'ethers'

import { env } from '../src/schema/env'
import { createNexusInitData } from '../src/utils/nexus'

interface DeploymentConfig {
	ownerPrivateKey: string
	salt?: number
}

// ------------ Config (edit this) ------------
const DEPLOYMENT_CONFIG: DeploymentConfig = {
	ownerPrivateKey: '',
	salt: 1
}
// --------------------------------------------

const NEXUS_ACCOUNT_FACTORY_ABI = [
	'function createAccount(bytes calldata initData, bytes32 salt) payable returns (address)',
	'function computeAccountAddress(bytes calldata initData, bytes32 salt) view returns (address)'
]

async function deployWallet(config: DeploymentConfig) {
	const { ownerPrivateKey, salt = 0 } = config

	const rpcUrl = env.NETWORK === 'mainnet' ? env.BSC_RPC_URL : env.BSC_TESTNET_RPC_URL
	if (!rpcUrl) throw new Error('RPC URL not configured')

	const provider = new ethers.JsonRpcProvider(rpcUrl)
	const ownerWallet = new Wallet(ownerPrivateKey, provider)

	const factory = new Contract(
		env.NEXUS_ACCOUNT_FACTORY_ADDRESS,
		NEXUS_ACCOUNT_FACTORY_ABI,
		provider
	)

	// Create Nexus initData with K1Validator
	const initData = createNexusInitData(ownerWallet.address)
	// Convert salt to bytes32
	const saltBytes32 = ethers.zeroPadValue(ethers.toBeHex(BigInt(salt)), 32)

	const computeAddressFunc = factory.getFunction('computeAccountAddress')
	const walletAddress: string = await computeAddressFunc(initData, saltBytes32)
	console.log(`Wallet address: ${walletAddress}`)

	const code = await provider.getCode(walletAddress)
	if (code !== '0x') {
		console.log('Already deployed')
		return { walletAddress, alreadyDeployed: true }
	}

	const balance = await provider.getBalance(ownerWallet.address)
	if (balance === 0n) throw new Error('Owner EOA has no balance')

	const feeData = await provider.getFeeData()
	const networkGasPrice = feeData.gasPrice || ethers.parseUnits('0.05', 'gwei')

	const factoryWithSigner = factory.connect(ownerWallet)
	const tx: ethers.ContractTransactionResponse = await (
		factoryWithSigner as unknown as {
			createAccount: (
				initData: string,
				salt: string,
				options: object
			) => Promise<ethers.ContractTransactionResponse>
		}
	).createAccount(initData, saltBytes32, {
		gasLimit: 500000,
		gasPrice: networkGasPrice
	})

	console.log(`Tx: ${tx.hash}`)
	const receipt = await tx.wait()
	if (!receipt) throw new Error('No receipt')

	console.log(`Block: ${receipt.blockNumber}`)
	console.log(`Gas: ${receipt.gasUsed.toString()}`)
	console.log(
		`Cost: ${ethers.formatEther((receipt.gasUsed * (receipt.gasPrice || 0n)).toString())} BNB`
	)

	return {
		walletAddress,
		txHash: tx.hash,
		blockNumber: receipt.blockNumber,
		gasUsed: receipt.gasUsed.toString(),
		alreadyDeployed: false
	}
}

deployWallet(DEPLOYMENT_CONFIG)
	.then((result) => console.log(JSON.stringify(result, null, 2)))
	.catch(console.error)
