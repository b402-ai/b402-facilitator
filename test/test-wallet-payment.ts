import 'dotenv/config'
import { Contract, Wallet, ethers } from 'ethers'

import type {
	PaymentDetail,
	SettleWalletResponse,
	UserOperation,
	VerifyWalletResponse
} from '../src/schema/b402'

// ------------ Config (edit this) ------------
const FACILITATOR_API_URL = 'http://localhost:3402/api/v1'
const TEST_WALLET = {
	eoa: '',
	privateKey: '',
	smartWallet: ''
}
const RECIPIENTS = ['', ''] // exactly 2
// ---------------------------------------------

const USDT = {
	address: '0x55d398326f99059fF775485246999027B3197955',
	decimals: 18,
	symbol: 'USDT'
}

const ERC20_ABI = [
	'function balanceOf(address account) view returns (uint256)',
	'function decimals() view returns (uint8)'
]

async function checkBalance(walletAddress: string, rpcUrl: string): Promise<string> {
	const provider = new ethers.JsonRpcProvider(rpcUrl)
	const token = new Contract(USDT.address, ERC20_ABI, provider)

	const balance = await token.balanceOf(walletAddress)
	const formattedBalance = ethers.formatUnits(balance, USDT.decimals)

	console.log(`Smart Wallet Balance: ${formattedBalance} ${USDT.symbol}`)
	return formattedBalance
}

async function verifyWalletPayment(
	walletAddress: string,
	transactions: Array<{ to: string; amount: string; token: string }>
): Promise<VerifyWalletResponse> {
	console.log('Calling /wallet/verify')

	const response = await fetch(`${FACILITATOR_API_URL}/wallet/verify`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			walletAddress,
			transactions
		})
	})

	if (!response.ok) {
		const error = await response.text()
		throw new Error(`Verify failed: ${response.status} - ${error}`)
	}

	const data: VerifyWalletResponse = await response.json()
	console.log(`Valid: ${data.isValid}`)
	console.log(`Fee: ${data.feeAmount} ${USDT.symbol}`)
	console.log(`Total: ${data.totalAmount} ${USDT.symbol}`)
	console.log(`UserOp: ${data.userOpHash}`)

	return data
}

function signUserOpHash(userOpHash: string, privateKey: string): string {
	console.log('Signing UserOp')
	const wallet = new Wallet(privateKey)
	const signature = wallet.signMessageSync(ethers.getBytes(userOpHash))
	console.log(`Signature: ${signature}`)
	return signature
}

async function settleWalletPayment(
	userOp: UserOperation,
	signature: string
): Promise<SettleWalletResponse> {
	console.log('Calling /wallet/settle')

	const response = await fetch(`${FACILITATOR_API_URL}/wallet/settle`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			userOp,
			signature
		})
	})

	if (!response.ok) {
		const error = await response.text()
		throw new Error(`Settle failed: ${response.status} - ${error}`)
	}

	const data: SettleWalletResponse = await response.json()
	console.log(`Tx: ${data.txHash}`)
	console.log(`Explorer: https://bscscan.com/tx/${data.txHash}`)

	data.payments.forEach((payment: PaymentDetail, index: number) => {
		console.log(
			`${index + 1}. ${payment.recipient}: ${payment.amount} ${USDT.symbol}${payment.isProtocolFee ? ' (fee)' : ''}`
		)
	})

	return data
}

async function testWalletPayment() {
	console.log(`Smart Wallet: ${TEST_WALLET.smartWallet}`)
	console.log(`Token: ${USDT.symbol} (${USDT.address})`)

	const rpcUrl = process.env.BSC_RPC_URL
	if (!rpcUrl) throw new Error('BSC_RPC_URL not set')

	const balance = await checkBalance(TEST_WALLET.smartWallet, rpcUrl)
	const balanceNum = Number.parseFloat(balance)
	const requiredAmount = 0.02 + 0.1

	if (balanceNum < requiredAmount) {
		console.log(`WARNING: Need at least ${requiredAmount} ${USDT.symbol}`)
	}

	const transactions = [
		{
			to: RECIPIENTS[0],
			amount: '0.01',
			token: USDT.address
		},
		{
			to: RECIPIENTS[1],
			amount: '0.01',
			token: USDT.address
		}
	]

	const verifyData = await verifyWalletPayment(TEST_WALLET.smartWallet, transactions)
	const signature = signUserOpHash(verifyData.userOpHash, TEST_WALLET.privateKey)
	const settleData = await settleWalletPayment(verifyData.userOp, signature)

	console.log(`\nhttps://bscscan.com/tx/${settleData.txHash}`)
}

testWalletPayment().catch(console.error)
