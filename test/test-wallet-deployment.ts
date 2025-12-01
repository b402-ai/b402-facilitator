import 'dotenv/config'
import { Contract, ethers } from 'ethers'

import { encodeNexusAccountCreation } from '../src/utils/nexus'

// ------------ Config (edit this) ------------
const API_URL = 'http://localhost:3402'
const PAYER_PRIVATE_KEY = '' // EOA payer private key (required for both, EOA and smart wallet payment flows)
const PAYER_SMART_WALLET_ADDRESS = '' // Leave empty for EOA flow, for smart wallet flow must be owned by wallet of `PAYER_PRIVATE_KEY`
const NUM_WALLETS = 3 // 1-10
const FUNDING_AMOUNT_PER_WALLET = '0.01' // in tokens, or '' for no funding
const FEE_TOKEN_ADDRESS = '0x55d398326f99059fF775485246999027B3197955' // USDT - token used to pay deployment fees
const FUNDING_TOKEN_ADDRESS = '0x55d398326f99059fF775485246999027B3197955' // USDT - token to fund wallets with
const OWNER_ADDRESS = '' // Leave empty to use payer address
// --------------------------------------------

const NETWORK = 'bsc'
const CHAIN_ID = 56

const EIP712_TYPES = {
	TransferWithAuthorization: [
		{ name: 'token', type: 'address' },
		{ name: 'from', type: 'address' },
		{ name: 'to', type: 'address' },
		{ name: 'value', type: 'uint256' },
		{ name: 'validAfter', type: 'uint256' },
		{ name: 'validBefore', type: 'uint256' },
		{ name: 'nonce', type: 'bytes32' }
	]
}

const ERC20_ABI = [
	'function approve(address spender, uint256 amount) returns (bool)',
	'function allowance(address owner, address spender) view returns (uint256)',
	'function balanceOf(address account) view returns (uint256)',
	'function decimals() view returns (uint8)',
	'function symbol() view returns (string)'
]

const FACTORY_ABI = [
	'function computeAccountAddress(bytes calldata initData, bytes32 salt) view returns (address)'
]

interface PaymentPayload {
	token: string
	payload: {
		authorization: {
			from: string
			to: string
			value: string
			validAfter: number
			validBefore: number
			nonce: string
		}
		signature: string
	}
}

async function checkIfSmartWallet(address: string, rpcUrl: string): Promise<boolean> {
	const provider = new ethers.JsonRpcProvider(rpcUrl)
	const code = await provider.getCode(address)
	return code !== '0x' && code !== '0x0'
}

async function computeWalletAddress(
	factoryAddress: string,
	ownerAddress: string,
	salt: string,
	rpcUrl: string
): Promise<string> {
	const provider = new ethers.JsonRpcProvider(rpcUrl)
	const factory = new Contract(factoryAddress, FACTORY_ABI, provider)

	const initData = encodeNexusAccountCreation(ownerAddress)
	const saltBytes32 = ethers.zeroPadValue(ethers.toBeHex(BigInt(salt)), 32)

	const walletAddress = await factory.getFunction('computeAccountAddress')(initData, saltBytes32)
	return walletAddress
}

async function checkAndApproveToken(
	wallet: ethers.Wallet,
	tokenAddress: string,
	spenderAddress: string,
	rpcUrl: string
): Promise<void> {
	const provider = new ethers.JsonRpcProvider(rpcUrl)
	const walletWithProvider = wallet.connect(provider)
	const token = new Contract(tokenAddress, ERC20_ABI, walletWithProvider)

	const [balance, allowance, decimals, symbol] = await Promise.all([
		token.balanceOf(wallet.address),
		token.allowance(wallet.address, spenderAddress),
		token.decimals(),
		token.symbol()
	])

	console.log(`Token Balance: ${ethers.formatUnits(balance, decimals)} ${symbol}`)

	if (balance === 0n) {
		console.log('WARNING: Wallet has no tokens!')
		return
	}

	console.log(`Current Allowance: ${ethers.formatUnits(allowance, decimals)} ${symbol}`)

	if (allowance === 0n) {
		console.log('Approving relayer contract...')
		const approveAmount = ethers.parseUnits('1000000', decimals)
		const tx = await token.approve(spenderAddress, approveAmount)
		console.log(`Approval Tx: ${tx.hash}`)
		await tx.wait()
		console.log('Approved!')
	} else {
		console.log('Already approved')
	}
}

async function signEIP712Payment(
	wallet: ethers.Wallet,
	tokenAddress: string,
	recipientAddress: string,
	amount: string,
	relayerAddress: string
): Promise<PaymentPayload> {
	const nonce = ethers.hexlify(ethers.randomBytes(32))
	const validAfter = Math.floor(Date.now() / 1000) - 60
	const validBefore = Math.floor(Date.now() / 1000) + 3600

	const authorization = {
		token: tokenAddress,
		from: wallet.address,
		to: recipientAddress,
		value: amount,
		validAfter,
		validBefore,
		nonce
	}

	const domain = {
		name: 'B402',
		version: '1',
		chainId: CHAIN_ID,
		verifyingContract: relayerAddress
	}

	const signature = await wallet.signTypedData(domain, EIP712_TYPES, authorization)

	return {
		token: tokenAddress,
		payload: {
			authorization,
			signature
		}
	}
}

async function callAPI(endpoint: string, payload: unknown): Promise<unknown> {
	const url = `${API_URL}/api/v1${endpoint}`
	console.log(`Calling: POST ${url}`)

	const response = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload)
	})

	const data = await response.json()

	if (!response.ok) {
		console.log('Error Response:', JSON.stringify(data, null, 2))
		throw new Error(`API call failed: ${response.status}`)
	}

	return data
}

async function testEOAPayment() {
	console.log('\nTesting Wallet Deployment with EOA Payment\n')

	if (!PAYER_PRIVATE_KEY) throw new Error('PAYER_PRIVATE_KEY not set in config')

	const rpcUrl = process.env.BSC_RPC_URL
	const relayerAddress = process.env.B402_RELAYER_ADDRESS
	const factoryAddress = process.env.NEXUS_ACCOUNT_FACTORY_ADDRESS
	const feeRecipient = process.env.WALLET_FEE_RECIPIENT

	if (!rpcUrl) throw new Error('BSC_RPC_URL not set')
	if (!relayerAddress) throw new Error('B402_RELAYER_ADDRESS not set')
	if (!factoryAddress) throw new Error('NEXUS_ACCOUNT_FACTORY_ADDRESS not set')
	if (!feeRecipient) throw new Error('WALLET_FEE_RECIPIENT not set')

	const wallet = new ethers.Wallet(PAYER_PRIVATE_KEY)
	const ownerAddress = OWNER_ADDRESS || wallet.address

	console.log(`Network: ${NETWORK}`)
	console.log(`Payer: ${wallet.address}`)
	console.log(`Owner: ${ownerAddress}`)
	console.log(`Wallets to deploy: ${NUM_WALLETS}`)
	console.log(`Funding per wallet: ${FUNDING_AMOUNT_PER_WALLET || 'None'}`)

	await checkAndApproveToken(wallet, FEE_TOKEN_ADDRESS, relayerAddress, rpcUrl)

	console.log(`Generating ${NUM_WALLETS} wallet addresses...`)
	const wallets: Array<{ address: string; salt: string; owner: string; fundingAmount?: string }> =
		[]

	for (let i = 0; i < NUM_WALLETS; i++) {
		const salt = ethers.hexlify(ethers.randomBytes(32))
		const address = await computeWalletAddress(factoryAddress, ownerAddress, salt, rpcUrl)

		const walletEntry: { address: string; salt: string; owner: string; fundingAmount?: string } = {
			address,
			salt,
			owner: ownerAddress
		}

		if (FUNDING_AMOUNT_PER_WALLET) {
			walletEntry.fundingAmount = FUNDING_AMOUNT_PER_WALLET
		}

		wallets.push(walletEntry)
		console.log(`${i + 1}. ${address}`)
	}

	const provider = new ethers.JsonRpcProvider(rpcUrl)
	const feeToken = new Contract(FEE_TOKEN_ADDRESS, ERC20_ABI, provider)
	const feeTokenDecimals = await feeToken.decimals()

	const deploymentFeePerWallet = 0.01
	const fundingFeePerWallet = 0.01
	const totalDeploymentFee = NUM_WALLETS * deploymentFeePerWallet
	const totalFundingFees = FUNDING_AMOUNT_PER_WALLET ? NUM_WALLETS * fundingFeePerWallet : 0
	const totalFees = totalDeploymentFee + totalFundingFees

	console.log(`Deployment fees: ${totalDeploymentFee} tokens`)
	console.log(`Funding fees: ${totalFundingFees} tokens`)
	console.log(`Total fees: ${totalFees} tokens`)

	console.log('Generating payment signatures...')
	const paymentPayload: PaymentPayload[] = []

	const feeAmountWei = ethers.parseUnits(totalFees.toString(), feeTokenDecimals).toString()
	const feePayment = await signEIP712Payment(
		wallet,
		FEE_TOKEN_ADDRESS,
		feeRecipient,
		feeAmountWei,
		relayerAddress
	)
	paymentPayload.push(feePayment)
	console.log(`Fee payment: ${totalFees} USDT to ${feeRecipient}`)

	if (FUNDING_AMOUNT_PER_WALLET) {
		const fundingToken = new Contract(FUNDING_TOKEN_ADDRESS, ERC20_ABI, provider)
		const fundingDecimals = await fundingToken.decimals()
		const fundingAmountWei = ethers
			.parseUnits(FUNDING_AMOUNT_PER_WALLET, fundingDecimals)
			.toString()

		for (const w of wallets) {
			const fundingPayment = await signEIP712Payment(
				wallet,
				FUNDING_TOKEN_ADDRESS,
				w.address,
				fundingAmountWei,
				relayerAddress
			)
			paymentPayload.push(fundingPayment)
			console.log(
				`Funding payment: ${FUNDING_AMOUNT_PER_WALLET} USDT to ${w.address.slice(0, 10)}...`
			)
		}
	}

	const verifyPayload = {
		paymentPayload,
		paymentRequirements: {
			network: NETWORK,
			relayerContract: relayerAddress,
			deployment: {
				ownerAddress,
				salts: wallets.map((w) => w.salt),
				fundingRequested: !!FUNDING_AMOUNT_PER_WALLET
			}
		},
		wallets
	}

	console.log('Step 1: Verify deployment...')
	const verifyResponse = await callAPI('/deploy/verify', {
		paymentPayload,
		paymentRequirements: verifyPayload.paymentRequirements
	})
	console.log('Verification response:', JSON.stringify(verifyResponse, null, 2))

	if (!(verifyResponse as { isValid: boolean }).isValid) {
		console.log('Verification failed!')
		return
	}

	console.log('Step 2: Settle deployment...')
	const settlePayload = verifyPayload

	const settleResponse = await callAPI('/deploy/settle', settlePayload)
	console.log('Settlement response:', JSON.stringify(settleResponse, null, 2))

	const response = settleResponse as {
		paymentSuccess: boolean
		deploymentSuccess: boolean
		fundingSuccess: boolean
		paymentTxHash: string
		wallets?: unknown[]
		failedWallets?: Array<{ address: string }>
	}

	console.log('Summary:')
	console.log(`Payment Success: ${response.paymentSuccess ? 'Yes' : 'No'}`)
	console.log(`Deployment Success: ${response.deploymentSuccess ? 'Yes' : 'No'}`)
	console.log(`Funding Success: ${response.fundingSuccess ? 'Yes' : 'No'}`)
	console.log(`Payment Tx: ${response.paymentTxHash}`)
	console.log(`Wallets Deployed: ${response.wallets?.length || 0}/${NUM_WALLETS}`)

	if (response.failedWallets && response.failedWallets.length > 0) {
		console.log('Failed Wallets:')
		for (const fw of response.failedWallets) {
			console.log(`- ${fw.address}`)
		}
	}

	console.log('Test completed!')
}

async function testSmartWalletPayment() {
	console.log('Testing Wallet Deployment (Smart Wallet Payment)')

	if (!PAYER_PRIVATE_KEY) throw new Error('PAYER_PRIVATE_KEY not set in config')
	if (!PAYER_SMART_WALLET_ADDRESS) throw new Error('PAYER_SMART_WALLET_ADDRESS not set in config')

	const rpcUrl = process.env.BSC_RPC_URL
	const relayerAddress = process.env.B402_RELAYER_ADDRESS
	const factoryAddress = process.env.NEXUS_ACCOUNT_FACTORY_ADDRESS
	const entryPointAddress = process.env.ENTRY_POINT_ADDRESS
	const feeRecipient = process.env.WALLET_FEE_RECIPIENT

	if (!rpcUrl) throw new Error('BSC_RPC_URL not set')
	if (!relayerAddress) throw new Error('B402_RELAYER_ADDRESS not set')
	if (!factoryAddress) throw new Error('NEXUS_ACCOUNT_FACTORY_ADDRESS not set')
	if (!entryPointAddress) throw new Error('ENTRY_POINT_ADDRESS not set')
	if (!feeRecipient) throw new Error('WALLET_FEE_RECIPIENT not set')

	const ownerWallet = new ethers.Wallet(PAYER_PRIVATE_KEY)
	const payerWalletAddress = PAYER_SMART_WALLET_ADDRESS
	const ownerAddress = OWNER_ADDRESS || ownerWallet.address

	console.log(`Network: ${NETWORK}`)
	console.log(`Payer Smart Wallet: ${payerWalletAddress}`)
	console.log(`Owner: ${ownerAddress}`)
	console.log(`Wallets to deploy: ${NUM_WALLETS}`)
	console.log(`Funding per wallet: ${FUNDING_AMOUNT_PER_WALLET || 'None'}`)

	// Check if payer wallet is deployed
	const isPayerDeployed = await checkIfSmartWallet(payerWalletAddress, rpcUrl)
	if (!isPayerDeployed) {
		console.log('ERROR: Payer smart wallet is not deployed!')
		console.log(
			'The payer smart wallet must be deployed before it can pay for other wallet deployments.'
		)
		console.log('Please deploy the payer wallet first or use an EOA as the payer.')
		throw new Error('Payer smart wallet not deployed')
	}

	// Generate wallet addresses
	console.log(`Generating ${NUM_WALLETS} wallet addresses...`)
	const wallets: Array<{ address: string; salt: string; owner: string; fundingAmount?: string }> =
		[]

	for (let i = 0; i < NUM_WALLETS; i++) {
		const salt = ethers.hexlify(ethers.randomBytes(32))
		const address = await computeWalletAddress(factoryAddress, ownerAddress, salt, rpcUrl)

		const walletEntry: { address: string; salt: string; owner: string; fundingAmount?: string } = {
			address,
			salt,
			owner: ownerAddress
		}

		if (FUNDING_AMOUNT_PER_WALLET) {
			walletEntry.fundingAmount = FUNDING_AMOUNT_PER_WALLET
		}

		wallets.push(walletEntry)
		console.log(`${i + 1}. ${address}`)
	}

	// Calculate fees
	const deploymentFeePerWallet = 0.01
	const fundingFeePerWallet = 0.01
	const totalDeploymentFee = NUM_WALLETS * deploymentFeePerWallet
	const totalFundingFees = FUNDING_AMOUNT_PER_WALLET ? NUM_WALLETS * fundingFeePerWallet : 0
	const totalFees = totalDeploymentFee + totalFundingFees

	console.log(`Deployment fees: ${totalDeploymentFee} tokens`)
	console.log(`Funding fees: ${totalFundingFees} tokens`)
	console.log(`Total fees: ${totalFees} tokens`)

	// Step 1: Verify (backend creates UserOp)
	const verifyPayload = {
		paymentRequirements: {
			network: NETWORK,
			deployment: {
				payerAddress: payerWalletAddress,
				ownerAddress,
				salts: wallets.map((w) => w.salt),
				fundingRequested: !!FUNDING_AMOUNT_PER_WALLET
			}
		}
	}

	console.log('Step 1: Verify deployment...')
	const verifyResponse = await callAPI('/deploy/wallet/verify', verifyPayload)
	console.log('Verification response:', JSON.stringify(verifyResponse, null, 2))

	if (!(verifyResponse as { isValid: boolean }).isValid) {
		console.log('Verification failed!')
		return
	}

	// Use the UserOp and userOpHash returned from verify
	const verifiedUserOp = (verifyResponse as { userOp: Record<string, unknown> }).userOp
	const userOpHash = (verifyResponse as { userOpHash: string }).userOpHash

	console.log('Step 2: Signing UserOp...')
	const signature = await ownerWallet.signMessage(ethers.getBytes(userOpHash))

	console.log('Step 3: Settling deployment...')
	const settlePayload = {
		userOp: verifiedUserOp,
		signature,
		paymentRequirements: verifyPayload.paymentRequirements,
		wallets
	}

	const settleResponse = await callAPI('/deploy/wallet/settle', settlePayload)
	console.log('Settlement response:', JSON.stringify(settleResponse, null, 2))

	const response = settleResponse as {
		paymentSuccess: boolean
		deploymentSuccess: boolean
		fundingSuccess: boolean
		paymentTxHash: string
		wallets?: unknown[]
		failedWallets?: Array<{ address: string }>
	}

	console.log('Summary:')
	console.log(`Payment Success: ${response.paymentSuccess ? 'Yes' : 'No'}`)
	console.log(`Deployment Success: ${response.deploymentSuccess ? 'Yes' : 'No'}`)
	console.log(`Funding Success: ${response.fundingSuccess ? 'Yes' : 'No'}`)
	console.log(`Payment Tx: ${response.paymentTxHash}`)
	console.log(`Wallets Deployed: ${response.wallets?.length || 0}/${NUM_WALLETS}`)

	if (response.failedWallets && response.failedWallets.length > 0) {
		console.log('Failed Wallets:')
		for (const fw of response.failedWallets) {
			console.log(`- ${fw.address}`)
		}
	}

	console.log('Test completed!')
}

async function testWalletDeployment() {
	if (!PAYER_PRIVATE_KEY) throw new Error('PAYER_PRIVATE_KEY not set in config')

	const rpcUrl = process.env.BSC_RPC_URL
	if (!rpcUrl) throw new Error('BSC_RPC_URL not set')

	// If smart wallet address is provided, use smart wallet flow
	if (PAYER_SMART_WALLET_ADDRESS) {
		const isDeployed = await checkIfSmartWallet(PAYER_SMART_WALLET_ADDRESS, rpcUrl)
		console.log(`Payer Smart Wallet: ${PAYER_SMART_WALLET_ADDRESS}`)
		console.log(`Wallet Deployed: ${isDeployed ? 'Yes' : 'No'}`)

		if (!isDeployed) {
			throw new Error('PAYER_SMART_WALLET_ADDRESS is not deployed')
		}

		await testSmartWalletPayment()
	} else {
		// Otherwise use EOA flow
		const wallet = new ethers.Wallet(PAYER_PRIVATE_KEY)
		console.log(`Payer EOA: ${wallet.address}`)
		await testEOAPayment()
	}
}

testWalletDeployment().catch((error) => {
	console.error('Test failed:', error.message)
	process.exit(1)
})
