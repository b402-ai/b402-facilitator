import 'dotenv/config'
import { Contract, ethers } from 'ethers'

// ------------ Config (edit this) ------------
const API_URL = 'http://localhost:3402'
const PAYER_PRIVATE_KEY = 'c8009d84c2bfb226ce8badb1f8622d33e5a30e0a4f76ab64b1846c49e98f7782' // EOA private key
const PAYER_SMART_WALLET_ADDRESS = '0xA2e47C5C30e695EfF8ACe49E856920B1C5A7dfEe' // Leave empty for EOA flow, for smart wallet flow must be owned by wallet of `PAYER_PRIVATE_KEY`
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

const FACTORY_ABI = ['function getAddress(address owner, uint256 salt) view returns (address)']

const SIMPLE_ACCOUNT_ABI = [
	'function executeBatch(address[] calldata dest, uint256[] calldata value, bytes[] calldata func)',
	'function getNonce() view returns (uint256)'
]

const B402_RELAYER_ABI = [
	'function batchTransferWithUserOp(address token, address[] recipients, uint256[] amounts, uint256 validAfter, uint256 validBefore, bytes32 nonce) external'
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

async function getUserOpHash(
	userOp: Record<string, unknown>,
	entryPointAddress: string,
	chainId: number
): Promise<string> {
	const abiCoder = ethers.AbiCoder.defaultAbiCoder()

	const factory = userOp.factory as string | undefined
	const factoryData = userOp.factoryData as string | undefined
	const initCode = factory && factoryData ? ethers.concat([factory, factoryData]) : '0x'

	const accountGasLimits = ethers.solidityPacked(
		['uint128', 'uint128'],
		[BigInt(userOp.verificationGasLimit as string), BigInt(userOp.callGasLimit as string)]
	)

	const gasFees = ethers.solidityPacked(
		['uint128', 'uint128'],
		[BigInt(userOp.maxPriorityFeePerGas as string), BigInt(userOp.maxFeePerGas as string)]
	)

	let paymasterAndData = '0x'
	if (userOp.paymaster) {
		const paymasterVerificationGasLimit = (userOp.paymasterVerificationGasLimit as string) || '0x'
		const paymasterPostOpGasLimit = (userOp.paymasterPostOpGasLimit as string) || '0x'
		const paymasterData = (userOp.paymasterData as string) || '0x'

		const verificationGasLimitPacked = ethers.zeroPadValue(
			ethers.toBeHex(paymasterVerificationGasLimit),
			16
		)
		const postOpGasLimitPacked = ethers.zeroPadValue(ethers.toBeHex(paymasterPostOpGasLimit), 16)

		paymasterAndData = ethers.concat([
			userOp.paymaster as string,
			verificationGasLimitPacked,
			postOpGasLimitPacked,
			paymasterData
		])
	}

	const packedUserOp = abiCoder.encode(
		['address', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'bytes32'],
		[
			userOp.sender,
			userOp.nonce,
			ethers.keccak256(initCode),
			ethers.keccak256(userOp.callData as string),
			accountGasLimits,
			userOp.preVerificationGas,
			gasFees,
			ethers.keccak256(paymasterAndData)
		]
	)

	const userOpHash = ethers.keccak256(packedUserOp)

	return ethers.keccak256(
		abiCoder.encode(['bytes32', 'address', 'uint256'], [userOpHash, entryPointAddress, chainId])
	)
}

async function createDeploymentUserOp(params: {
	walletAddress: string
	feeRecipient: string
	totalFees: string
	feeToken: string
	feeTokenDecimals: number
	fundingWallets?: Array<{ address: string; fundingAmount: string }>
	fundingToken?: string
	fundingTokenDecimals?: number
	relayerAddress: string
	rpcUrl: string
}): Promise<Record<string, unknown>> {
	const {
		walletAddress,
		feeRecipient,
		totalFees,
		feeToken,
		feeTokenDecimals,
		fundingWallets,
		fundingToken,
		fundingTokenDecimals,
		relayerAddress,
		rpcUrl
	} = params

	const provider = new ethers.JsonRpcProvider(rpcUrl)

	// Build recipients and amounts arrays
	const recipients: string[] = [feeRecipient]
	const amounts: bigint[] = [ethers.parseUnits(totalFees, feeTokenDecimals)]

	// Add funding transfers if requested
	if (fundingWallets && fundingWallets.length > 0 && fundingToken && fundingTokenDecimals) {
		for (const w of fundingWallets) {
			recipients.push(w.address)
			amounts.push(ethers.parseUnits(w.fundingAmount, fundingTokenDecimals))
		}
	}

	// Generate nonce for relayer call
	const validAfter = Math.floor(Date.now() / 1000) - 3600
	const validBefore = Math.floor(Date.now() / 1000) + 3600
	const nonce = ethers.hexlify(ethers.randomBytes(32))

	// Encode batchTransferWithUserOp call
	const relayerIface = new ethers.Interface(B402_RELAYER_ABI)
	const batchTransferData = relayerIface.encodeFunctionData('batchTransferWithUserOp', [
		feeToken,
		recipients,
		amounts,
		validAfter,
		validBefore,
		nonce
	])

	// Encode executeBatch call
	const accountIface = new ethers.Interface(SIMPLE_ACCOUNT_ABI)
	const callData = accountIface.encodeFunctionData('executeBatch', [
		[relayerAddress],
		['0'],
		[batchTransferData]
	])

	// Get wallet nonce
	const walletContract = new Contract(walletAddress, SIMPLE_ACCOUNT_ABI, provider)
	const walletNonce = await walletContract.getNonce()

	// Get gas prices
	const feeData = await provider.getFeeData()
	const baseGasPrice = feeData.gasPrice || ethers.parseUnits('1', 'gwei')
	const maxFeePerGas = (baseGasPrice * 12n) / 10n
	const maxPriorityFeePerGas = ethers.parseUnits('1', 'gwei')

	// Create UserOp
	const userOp = {
		sender: walletAddress,
		nonce: ethers.toBeHex(walletNonce),
		factory: undefined,
		factoryData: undefined,
		callData,
		callGasLimit: ethers.toBeHex(1000000),
		verificationGasLimit: ethers.toBeHex(1000000),
		preVerificationGas: ethers.toBeHex(150000),
		maxFeePerGas: ethers.toBeHex(maxFeePerGas),
		maxPriorityFeePerGas: ethers.toBeHex(maxPriorityFeePerGas),
		paymaster: undefined,
		paymasterVerificationGasLimit: undefined,
		paymasterPostOpGasLimit: undefined,
		paymasterData: undefined,
		signature: '0x'
	}

	return userOp
}

async function computeWalletAddress(
	factoryAddress: string,
	ownerAddress: string,
	salt: string,
	rpcUrl: string
): Promise<string> {
	const provider = new ethers.JsonRpcProvider(rpcUrl)
	const factory = new Contract(factoryAddress, FACTORY_ABI, provider)

	const walletAddress = await factory.getFunction('getAddress')(ownerAddress, BigInt(salt))
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
	const factoryAddress = process.env.SIMPLE_ACCOUNT_FACTORY_ADDRESS
	const feeRecipient = process.env.WALLET_FEE_RECIPIENT

	if (!rpcUrl) throw new Error('BSC_RPC_URL not set')
	if (!relayerAddress) throw new Error('B402_RELAYER_ADDRESS not set')
	if (!factoryAddress) throw new Error('SIMPLE_ACCOUNT_FACTORY_ADDRESS not set')
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
	const factoryAddress = process.env.SIMPLE_ACCOUNT_FACTORY_ADDRESS
	const entryPointAddress = process.env.ENTRY_POINT_ADDRESS
	const feeRecipient = process.env.WALLET_FEE_RECIPIENT

	if (!rpcUrl) throw new Error('BSC_RPC_URL not set')
	if (!relayerAddress) throw new Error('B402_RELAYER_ADDRESS not set')
	if (!factoryAddress) throw new Error('SIMPLE_ACCOUNT_FACTORY_ADDRESS not set')
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

	// Create UserOp for payment
	const fundingWallets = FUNDING_AMOUNT_PER_WALLET
		? wallets.map((w) => ({ address: w.address, fundingAmount: FUNDING_AMOUNT_PER_WALLET }))
		: undefined

	const fundingToken = FUNDING_AMOUNT_PER_WALLET ? FUNDING_TOKEN_ADDRESS : undefined
	let fundingTokenDecimals: number | undefined
	if (fundingToken) {
		const token = new Contract(fundingToken, ERC20_ABI, provider)
		fundingTokenDecimals = await token.decimals()
	}

	const userOp = await createDeploymentUserOp({
		walletAddress: payerWalletAddress,
		feeRecipient,
		totalFees: totalFees.toString(),
		feeToken: FEE_TOKEN_ADDRESS,
		feeTokenDecimals,
		fundingWallets,
		fundingToken,
		fundingTokenDecimals,
		relayerAddress,
		rpcUrl
	})

	// Step 1: Verify
	const verifyPayload = {
		userOp,
		paymentRequirements: {
			network: NETWORK,
			relayerContract: relayerAddress,
			deployment: {
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

	// Use the UserOp returned from verify (now includes paymaster signature)
	const verifiedUserOp = (verifyResponse as { userOp: Record<string, unknown> }).userOp

	console.log('Step 2: Signing UserOp...')
	const userOpHash = await getUserOpHash(verifiedUserOp, entryPointAddress, CHAIN_ID)
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
