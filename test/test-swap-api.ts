/**
 * Swap API Test Suite
 *
 * Tests for the PancakeSwap V3 swap endpoints in the B402 Facilitator
 *
 * Usage:
 *   npx tsx test/test-swap-api.ts
 *
 * Prerequisites:
 *   - Server running on localhost:3402 (npm run dev)
 *   - For full swap test: wallet with USD1 balance and approval to B402 relayer
 */
import { ethers } from 'ethers'

// ============================================
// Configuration
// ============================================

const API_BASE_URL = process.env.API_URL || 'http://localhost:3402/api/v1'

// Token addresses (BSC Mainnet)
const TOKENS = {
	USD1: '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d',
	USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
	USDT: '0x55d398326f99059fF775485246999027B3197955',
	WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
	BUSD: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56'
}

// B402 Relayer address for approvals
const B402_RELAYER = '0xe1af7daea624ba3b5073f24a6ea5531434d82d88'

// Test wallet (optional - for full swap test)
const TEST_PRIVATE_KEY = process.env.TEST_PRIVATE_KEY || ''

// ============================================
// Test Utilities
// ============================================

interface TestResult {
	name: string
	passed: boolean
	duration: number
	error?: string
	data?: unknown
}

const results: TestResult[] = []

async function runTest(name: string, testFn: () => Promise<unknown>): Promise<TestResult> {
	const startTime = Date.now()
	try {
		const data = await testFn()
		const result: TestResult = {
			name,
			passed: true,
			duration: Date.now() - startTime,
			data
		}
		results.push(result)
		console.log(`[PASS] ${name} (${result.duration}ms)`)
		return result
	} catch (error) {
		const result: TestResult = {
			name,
			passed: false,
			duration: Date.now() - startTime,
			error: error instanceof Error ? error.message : String(error)
		}
		results.push(result)
		console.log(`[FAIL] ${name}: ${result.error}`)
		return result
	}
}

// ============================================
// API Helper Functions
// ============================================

async function getSwapHealth() {
	const res = await fetch(`${API_BASE_URL}/swap/health`)
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
	return res.json()
}

async function getSwapQuote(tokenIn: string, tokenOut: string, amountIn: string) {
	const params = new URLSearchParams({ tokenIn, tokenOut, amountIn })
	const res = await fetch(`${API_BASE_URL}/swap/quote?${params}`)
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
	return res.json()
}

async function getPaymentIntent(user: string, tokenIn: string, amountIn: string) {
	const res = await fetch(`${API_BASE_URL}/swap/payment-intent`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ user, tokenIn, amountIn })
	})
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
	return res.json()
}

async function executeSwap(swapRequest: {
	user: string
	tokenIn: string
	tokenOut: string
	amountIn: string
	minAmountOut: string
	fee: number
	paymentSignature: {
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
}) {
	const res = await fetch(`${API_BASE_URL}/swap`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(swapRequest)
	})
	return res.json()
}

// ============================================
// Test Cases
// ============================================

async function testHealthEndpoint() {
	const health = await getSwapHealth()

	// Validate response structure
	if (health.status !== 'ok') throw new Error('Status should be "ok"')
	if (!health.serverWallet) throw new Error('Missing serverWallet')
	if (!health.bnbBalance) throw new Error('Missing bnbBalance')
	if (health.version !== 'PancakeSwap V3') throw new Error('Invalid version')

	return health
}

async function testQuoteUSD1toUSDC() {
	const amountIn = ethers.parseUnits('10', 18).toString() // 10 USD1
	const quote = await getSwapQuote(TOKENS.USD1, TOKENS.USDC, amountIn)

	// Validate response structure
	if (!quote.amountOut) throw new Error('Missing amountOut')
	if (!quote.minAmountOut) throw new Error('Missing minAmountOut')
	if (!quote.fee) throw new Error('Missing fee')
	if (!quote.route) throw new Error('Missing route')

	// Validate amounts make sense (output should be close to input for stablecoin pair)
	const amountOutNum = parseFloat(ethers.formatUnits(quote.amountOut, 18))
	if (amountOutNum < 9 || amountOutNum > 11) {
		throw new Error(`Unexpected amountOut: ${amountOutNum} (expected ~10)`)
	}

	return quote
}

async function testQuoteUSD1toWBNB() {
	const amountIn = ethers.parseUnits('100', 18).toString() // 100 USD1
	const quote = await getSwapQuote(TOKENS.USD1, TOKENS.WBNB, amountIn)

	// Validate response structure
	if (!quote.amountOut) throw new Error('Missing amountOut')
	if (!quote.fee) throw new Error('Missing fee')

	// WBNB output should be much smaller (BNB ~$600)
	const amountOutNum = parseFloat(ethers.formatUnits(quote.amountOut, 18))
	if (amountOutNum < 0.1 || amountOutNum > 0.5) {
		throw new Error(`Unexpected WBNB amountOut: ${amountOutNum}`)
	}

	return quote
}

async function testQuoteWBNBtoUSDT() {
	const amountIn = ethers.parseUnits('0.1', 18).toString() // 0.1 WBNB
	const quote = await getSwapQuote(TOKENS.WBNB, TOKENS.USDT, amountIn)

	if (!quote.amountOut) throw new Error('Missing amountOut')

	// 0.1 BNB should be ~$60-100 USDT depending on BNB price ($600-$1000)
	const amountOutNum = parseFloat(ethers.formatUnits(quote.amountOut, 18))
	if (amountOutNum < 40 || amountOutNum > 120) {
		throw new Error(`Unexpected USDT amountOut: ${amountOutNum}`)
	}

	return quote
}

async function testQuoteLargeAmount() {
	const amountIn = ethers.parseUnits('10000', 18).toString() // 10,000 USD1
	const quote = await getSwapQuote(TOKENS.USD1, TOKENS.USDC, amountIn)

	if (!quote.amountOut) throw new Error('Missing amountOut')

	// Large amounts should still work
	const amountOutNum = parseFloat(ethers.formatUnits(quote.amountOut, 18))
	if (amountOutNum < 9000 || amountOutNum > 10100) {
		throw new Error(`Unexpected large amountOut: ${amountOutNum}`)
	}

	return quote
}

async function testQuoteInvalidPair() {
	try {
		// Try to get quote for invalid token pair (same token)
		await getSwapQuote(TOKENS.USD1, TOKENS.USD1, '1000000000000000000')
		throw new Error('Should have thrown for invalid pair')
	} catch (error) {
		if (error instanceof Error && error.message.includes('Should have thrown')) {
			throw error
		}
		// Expected to fail
		return { expectedError: true }
	}
}

async function testQuoteMissingParams() {
	const res = await fetch(`${API_BASE_URL}/swap/quote?tokenIn=${TOKENS.USD1}`)
	if (res.ok) throw new Error('Should have returned error for missing params')
	const data = await res.json()
	if (!data.error) throw new Error('Missing error message')
	return data
}

async function testPaymentIntent() {
	const user = '0x651d777e737bea91f68528a972a64be8c555747d'
	const amountIn = ethers.parseUnits('10', 18).toString()

	const intent = await getPaymentIntent(user, TOKENS.USD1, amountIn)

	// Validate EIP-712 structure
	if (!intent.domain) throw new Error('Missing domain')
	if (!intent.types) throw new Error('Missing types')
	if (!intent.value) throw new Error('Missing value')
	if (!intent.feeBreakdown) throw new Error('Missing feeBreakdown')

	// Validate domain
	if (intent.domain.name !== 'B402') throw new Error('Invalid domain name')
	if (intent.domain.chainId !== 56) throw new Error('Invalid chainId')

	// Validate value structure
	if (intent.value.from !== user) throw new Error('Invalid from address')

	return intent
}

async function testFullSwapFlow() {
	if (!TEST_PRIVATE_KEY) {
		console.log('   [SKIP] Skipping full swap test (no TEST_PRIVATE_KEY)')
		return { skipped: true, reason: 'No TEST_PRIVATE_KEY provided' }
	}

	const provider = new ethers.JsonRpcProvider('https://bsc-dataseed1.binance.org/')
	const wallet = new ethers.Wallet(TEST_PRIVATE_KEY, provider)
	const userAddress = wallet.address

	console.log(`   Testing with wallet: ${userAddress}`)

	// Step 1: Get quote
	const amountIn = ethers.parseUnits('1', 18).toString() // 1 USD1
	const quote = await getSwapQuote(TOKENS.USD1, TOKENS.USDC, amountIn)
	console.log(`   Quote: ${ethers.formatUnits(quote.amountOut, 18)} USDC`)

	// Step 2: Get health to find server wallet
	const health = await getSwapHealth()
	const serverWallet = health.serverWallet

	// Step 3: Check user has enough balance
	const tokenContract = new ethers.Contract(
		TOKENS.USD1,
		['function balanceOf(address) view returns (uint256)'],
		provider
	)
	const balance = await tokenContract.balanceOf(userAddress)
	const serviceFee = ethers.parseUnits('0.35', 18)
	const totalNeeded = BigInt(amountIn) + serviceFee

	if (balance < totalNeeded) {
		return {
			skipped: true,
			reason: `Insufficient balance: ${ethers.formatUnits(balance, 18)} USD1 (need ${ethers.formatUnits(totalNeeded, 18)})`
		}
	}

	// Step 4: Check allowance to B402 relayer
	const allowanceContract = new ethers.Contract(
		TOKENS.USD1,
		['function allowance(address,address) view returns (uint256)'],
		provider
	)
	const allowance = await allowanceContract.allowance(userAddress, B402_RELAYER)

	if (allowance < totalNeeded) {
		return {
			skipped: true,
			reason: `Insufficient allowance: ${ethers.formatUnits(allowance, 18)} (need ${ethers.formatUnits(totalNeeded, 18)}). Approve B402 relayer first.`
		}
	}

	// Step 5: Build and sign payment authorization
	const now = Math.floor(Date.now() / 1000)
	const nonce = ethers.hexlify(ethers.randomBytes(32))

	const domain = {
		name: 'B402',
		version: '1',
		chainId: 56,
		verifyingContract: B402_RELAYER
	}

	const types = {
		TransferWithAuthorization: [
			{ name: 'from', type: 'address' },
			{ name: 'to', type: 'address' },
			{ name: 'value', type: 'uint256' },
			{ name: 'validAfter', type: 'uint256' },
			{ name: 'validBefore', type: 'uint256' },
			{ name: 'nonce', type: 'bytes32' }
		]
	}

	const authorization = {
		from: userAddress,
		to: serverWallet,
		value: totalNeeded.toString(),
		validAfter: now - 60,
		validBefore: now + 3600,
		nonce
	}

	const signature = await wallet.signTypedData(domain, types, authorization)

	// Step 6: Execute swap
	const swapResult = await executeSwap({
		user: userAddress,
		tokenIn: TOKENS.USD1,
		tokenOut: TOKENS.USDC,
		amountIn,
		minAmountOut: quote.minAmountOut,
		fee: quote.fee,
		paymentSignature: {
			token: TOKENS.USD1,
			payload: { authorization, signature }
		}
	})

	if (!swapResult.success) {
		throw new Error(`Swap failed: ${swapResult.error}`)
	}

	console.log(`   [OK] Swap successful! TX: ${swapResult.txHash}`)
	return swapResult
}

// ============================================
// Run Tests
// ============================================

async function main() {
	console.log('\nB402 Swap API Test Suite\n')
	console.log(`API URL: ${API_BASE_URL}\n`)
	console.log('─'.repeat(50))

	// Health & Basic Tests
	console.log('\n[Health & Configuration]\n')
	await runTest('GET /swap/health', testHealthEndpoint)

	// Quote Tests
	console.log('\n[Quote Endpoint Tests]\n')
	await runTest('GET /swap/quote (USD1 → USDC)', testQuoteUSD1toUSDC)
	await runTest('GET /swap/quote (USD1 → WBNB)', testQuoteUSD1toWBNB)
	await runTest('GET /swap/quote (WBNB → USDT)', testQuoteWBNBtoUSDT)
	await runTest('GET /swap/quote (large amount)', testQuoteLargeAmount)
	await runTest('GET /swap/quote (invalid pair)', testQuoteInvalidPair)
	await runTest('GET /swap/quote (missing params)', testQuoteMissingParams)

	// Payment Intent Tests
	console.log('\n[Payment Intent Tests]\n')
	await runTest('POST /swap/payment-intent', testPaymentIntent)

	// Full Swap Flow (requires funded wallet)
	console.log('\n[Full Swap Flow]\n')
	await runTest('POST /swap (full flow)', testFullSwapFlow)

	// Summary
	console.log('\n' + '─'.repeat(50))
	console.log('\n[Test Summary]\n')

	const passed = results.filter((r) => r.passed).length
	const failed = results.filter((r) => !r.passed).length

	console.log(`   Total:  ${results.length}`)
	console.log(`   Passed: ${passed}`)
	console.log(`   Failed: ${failed}`)
	console.log(`   Time:   ${results.reduce((sum, r) => sum + r.duration, 0)}ms`)

	if (failed > 0) {
		console.log('\nFailed Tests:')
		results
			.filter((r) => !r.passed)
			.forEach((r) => {
				console.log(`   - ${r.name}: ${r.error}`)
			})
		process.exit(1)
	}

	console.log('\nAll tests passed!\n')
}

main().catch(console.error)
