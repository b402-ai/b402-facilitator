import 'dotenv/config'
import { Contract, ethers } from 'ethers'
import * as readline from 'node:readline'

const EIP712_DOMAIN = {
	name: 'B402',
	version: '1',
	chainId: 56,
	verifyingContract: ''
}

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
	'function decimals() view returns (uint8)'
]

function askQuestion(query: string): Promise<string> {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout
	})

	return new Promise((resolve) =>
		rl.question(query, (answer) => {
			rl.close()
			resolve(answer)
		})
	)
}

async function checkAndApproveToken(
	wallet: ethers.Wallet,
	tokenAddress: string,
	relayerAddress: string,
	rpcUrl: string
) {
	const provider = new ethers.JsonRpcProvider(rpcUrl)
	const walletWithProvider = wallet.connect(provider)
	const token = new Contract(tokenAddress, ERC20_ABI, walletWithProvider)

	console.log('\n🔍 Checking token approval...')

	const [balance, allowance, decimals] = await Promise.all([
		token.balanceOf(wallet.address),
		token.allowance(wallet.address, relayerAddress),
		token.decimals()
	])

	console.log('   Token Balance:', ethers.formatUnits(balance, decimals))
	console.log('   Current Allowance:', ethers.formatUnits(allowance, decimals))

	if (balance === 0n) {
		console.log('\n⚠️  WARNING: Your wallet has no tokens!')
		return false
	}

	if (allowance === 0n) {
		console.log('\n⚠️  Token approval required for B402 relayer contract')
		const answer = await askQuestion('   Approve 1,000,000 tokens? (yes/no): ')

		if (answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y') {
			const approveAmount = ethers.parseUnits('1000000', decimals)
			console.log('\n🚀 Sending approval transaction...')

			try {
				const tx = await token.approve(relayerAddress, approveAmount)
				console.log('   Transaction hash:', tx.hash)
				console.log('   Waiting for confirmation...')

				await tx.wait()
				console.log('✅ Approval confirmed!')
				return true
			} catch (error: any) {
				console.log('❌ Approval failed:', error.message)
				return false
			}
		} else {
			console.log('⚠️  Skipping approval. The settle endpoint will fail.')
			return false
		}
	} else {
		console.log('✅ Token already approved')
		return true
	}
}

async function generateTestSignature() {
	const privateKey = process.env.TEST_WALLET_PRIVATE_KEY
	const rpcUrl = process.env.BSC_RPC_URL
	const liveApiUrl = process.env.LIVE_API_URL

	if (!privateKey) {
		console.error('❌ Please set TEST_WALLET_PRIVATE_KEY in your .env file')
		process.exit(1)
	}

	if (!rpcUrl) {
		console.error('❌ Please set BSC_RPC_URL in your .env file')
		process.exit(1)
	}

	if (!liveApiUrl) {
		console.error('❌ Please set LIVE_API_URL in your .env file')
		process.exit(1)
	}

	const wallet = new ethers.Wallet(privateKey)
	console.log('📝 Wallet Address:', wallet.address)

	const tokenAddress =
		process.env.USD1_TOKEN_ADDRESS || '0x0000000000000000000000000000000000000000'
	const relayerAddress =
		process.env.B402_RELAYER_ADDRESS || '0x0000000000000000000000000000000000000000'
	const recipientAddress = '0x0553B926D6a599CAAc56377042cA6B40dd0b7F4e'

	console.log('💰 Token Address:', tokenAddress)
	console.log('🔄 Relayer Address:', relayerAddress)
	console.log('📬 Recipient Address:', recipientAddress)

	await checkAndApproveToken(wallet, tokenAddress, relayerAddress, rpcUrl)

	const nonce = ethers.hexlify(ethers.randomBytes(32))
	const validAfter = 0
	const validBefore = Math.floor(Date.now() / 1000) + 3600
	const amount = '10000000000000000'

	const authorization = {
		token: tokenAddress,
		from: wallet.address,
		to: recipientAddress,
		value: amount,
		validAfter: validAfter,
		validBefore: validBefore,
		nonce: nonce
	}

	const domain = {
		...EIP712_DOMAIN,
		verifyingContract: relayerAddress
	}

	console.log('\n📋 Authorization:', JSON.stringify(authorization, null, 2))

	const signature = await wallet.signTypedData(domain, EIP712_TYPES, authorization)

	console.log('\n✅ Signature generated:', signature)

	const payload = {
		paymentPayload: {
			token: tokenAddress,
			payload: {
				authorization: authorization,
				signature: signature
			}
		},
		paymentRequirements: {
			network: 'mainnet',
			relayerContract: relayerAddress
		}
	}

	console.log('\n📦 Complete Payload for Postman:')
	console.log(JSON.stringify(payload, null, 2))

	console.log('\n🎯 Copy the JSON above and use it in Postman for:')
	console.log(`   - POST ${liveApiUrl}/api/v1/verify`)
	console.log(`   - POST ${liveApiUrl}/api/v1/settle`)
}

generateTestSignature().catch(console.error)
