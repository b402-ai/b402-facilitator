/**
 * PancakeSwap V3 Swap Service
 *
 * Ported from @b402/swap-server for self-contained swap functionality
 *
 * V3 Benefits:
 * - Concentrated liquidity = better prices
 * - Multiple fee tiers (0.01%, 0.05%, 0.25%, 1%)
 * - Lower gas costs
 * - Better capital efficiency
 */
import { Contract, Wallet, ethers } from 'ethers'

import { env } from '../../schema/env'
import { getProviderService } from '../../utils/provider'

// PancakeSwap V3 Contracts (BSC Mainnet)
// Using Smart Router which has different ABI (no deadline param)
const PANCAKE_V3_ROUTER = '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4'
const PANCAKE_V3_QUOTER = '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997'

// Fee tiers (in hundredths of a bip, so 100 = 0.01%)
const FEE_TIERS = [100, 500, 2500, 10000] // 0.01%, 0.05%, 0.25%, 1%

// BNB/USD price feed (Chainlink on BSC)
const BNB_USD_PRICE_FEED = '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE'

// B402 Relayer ABI for nonce check
const B402_RELAYER_ABI = [
	'function transferWithAuthorization(address token, address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) returns (bool)',
	'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)'
]

const QUOTER_ABI = [
	'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)'
]

// Smart Router ABI - note: NO deadline parameter (different from V3 SwapRouter)
const ROUTER_ABI = [
	'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)'
]

const CHAINLINK_PRICE_FEED_ABI = [
	'function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)'
]

const ERC20_ABI = [
	'function balanceOf(address owner) view returns (uint256)',
	'function allowance(address owner, address spender) view returns (uint256)',
	'function approve(address spender, uint256 amount) returns (bool)',
	'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)'
]

export interface SwapQuote {
	tokenIn: string
	tokenOut: string
	amountIn: string
	amountOut: string
	minAmountOut: string
	fee: number
	feePercent: string
	priceImpact: string
	route: {
		path: string[]
		router: string
		gasEstimate: string
	}
}

export interface SwapRequest {
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
}

export interface SwapResult {
	success: boolean
	txHash?: string
	explorerUrl?: string
	error?: string
	stats?: {
		version: string
		feeTier: string
		gasUsed: string
		gasCostUSD: string
		executionTimeMs: number
		feeCollected: string
		profit: string
	}
}

export interface SwapHealthResponse {
	status: string
	version: string
	network: string
	facilitator: string
	serverWallet: string
	bnbBalance: string
	timestamp: number
}

class SwapService {
	private provider: ethers.JsonRpcProvider
	private serverWallet: Wallet
	private quoter: Contract
	private router: Contract
	private priceFeed: Contract
	private relayerContract: Contract

	constructor() {
		const providerService = getProviderService()
		this.provider = providerService.getProvider()

		this.serverWallet = new Wallet(env.RELAYER_PRIVATE_KEY, this.provider)

		this.quoter = new Contract(PANCAKE_V3_QUOTER, QUOTER_ABI, this.provider)
		this.router = new Contract(PANCAKE_V3_ROUTER, ROUTER_ABI, this.serverWallet)
		this.priceFeed = new Contract(BNB_USD_PRICE_FEED, CHAINLINK_PRICE_FEED_ABI, this.provider)
		this.relayerContract = new Contract(
			env.B402_RELAYER_ADDRESS,
			B402_RELAYER_ABI,
			this.serverWallet
		)
	}

	async getBnbPriceUSD(): Promise<number> {
		try {
			const roundData = await this.priceFeed.latestRoundData()
			const price = Number(roundData.answer) / 1e8
			return price
		} catch (error) {
			return 600
		}
	}

	getServiceFee(): string {
		return env.SWAP_SERVICE_FEE
	}

	getServerWalletAddress(): string {
		return this.serverWallet.address
	}

	async getHealth(): Promise<SwapHealthResponse> {
		const balance = await this.provider.getBalance(this.serverWallet.address)
		const providerService = getProviderService()

		return {
			status: 'ok',
			version: 'PancakeSwap V3',
			network: providerService.getNetwork(),
			facilitator: 'self',
			serverWallet: this.serverWallet.address,
			bnbBalance: ethers.formatEther(balance),
			timestamp: Date.now()
		}
	}

	async getQuote(tokenIn: string, tokenOut: string, amountIn: string): Promise<SwapQuote> {
		let bestQuote: { amountOut: bigint; fee: number; gasEstimate: bigint } | null = null
		let bestFee = 0

		for (const fee of FEE_TIERS) {
			try {
				const params = {
					tokenIn,
					tokenOut,
					amountIn,
					fee,
					sqrtPriceLimitX96: 0
				}

				const result = await this.quoter.quoteExactInputSingle.staticCall(params)
				const amountOut = result[0]

				if (!bestQuote || amountOut > bestQuote.amountOut) {
					bestQuote = {
						amountOut,
						fee,
						gasEstimate: result[3]
					}
					bestFee = fee
				}
			} catch (e) {
				// This fee tier might not have a pool
			}
		}

		if (!bestQuote) {
			throw new Error('No liquidity found for this pair')
		}

		const minAmountOut = (bestQuote.amountOut * BigInt(995)) / BigInt(1000)

		return {
			tokenIn,
			tokenOut,
			amountIn,
			amountOut: bestQuote.amountOut.toString(),
			minAmountOut: minAmountOut.toString(),
			fee: bestFee,
			feePercent: (bestFee / 10000).toString(),
			priceImpact: '0.5',
			route: {
				path: [tokenIn, tokenOut],
				router: `PancakeSwap V3 (${bestFee / 10000}% pool)`,
				gasEstimate: bestQuote.gasEstimate.toString()
			}
		}
	}

	async executeSwap(request: SwapRequest): Promise<SwapResult> {
		const { user, tokenIn, tokenOut, amountIn, minAmountOut, fee, paymentSignature } = request
		const startTime = Date.now()
		const serviceFee = this.getServiceFee()

		try {
			const { authorization, signature } = paymentSignature.payload
			const sig = ethers.Signature.from(signature)

			const nonceUsed = await this.relayerContract.authorizationState(
				authorization.from,
				authorization.nonce
			)
			if (nonceUsed) {
				return {
					success: false,
					error: 'Authorization nonce already used - possible replay attack'
				}
			}

			const tokenContract = new Contract(tokenIn, ERC20_ABI, this.serverWallet)
			const userBalance = await tokenContract.balanceOf(authorization.from)
			const userAllowance = await tokenContract.allowance(
				authorization.from,
				env.B402_RELAYER_ADDRESS
			)

			if (userBalance < BigInt(authorization.value)) {
				return {
					success: false,
					error: `Insufficient balance: User has ${ethers.formatUnits(userBalance, 18)} but needs ${ethers.formatUnits(authorization.value, 18)}`
				}
			}

			if (userAllowance < BigInt(authorization.value)) {
				return {
					success: false,
					error: `Insufficient allowance: User approved ${ethers.formatUnits(userAllowance, 18)} to relayer but needs ${ethers.formatUnits(authorization.value, 18)}`
				}
			}

			const pullTx = await this.relayerContract.transferWithAuthorization(
				tokenIn,
				authorization.from,
				authorization.to,
				authorization.value,
				authorization.validAfter,
				authorization.validBefore,
				authorization.nonce,
				sig.v,
				sig.r,
				sig.s,
				{ gasLimit: 150000 }
			)
			await pullTx.wait()

			const allowance = await tokenContract.allowance(this.serverWallet.address, PANCAKE_V3_ROUTER)
			if (allowance < BigInt(amountIn)) {
				const approveTx = await tokenContract.approve(PANCAKE_V3_ROUTER, ethers.MaxUint256, {
					gasLimit: 100000
				})
				await approveTx.wait()
			}

			const amountInBigInt = BigInt(amountIn)
			const minAmountOutBigInt = minAmountOut ? BigInt(minAmountOut) : 0n

			const swapParams = {
				tokenIn,
				tokenOut,
				fee,
				recipient: user,
				amountIn: amountInBigInt,
				amountOutMinimum: minAmountOutBigInt,
				sqrtPriceLimitX96: 0n
			}

			const swapTx = await this.router.exactInputSingle(swapParams, {
				gasLimit: 300000
			})
			const receipt = await swapTx.wait()

			const executionTime = Date.now() - startTime
			const gasPrice = (await this.provider.getFeeData()).gasPrice || 0n
			const gasCostWei = receipt.gasUsed * gasPrice
			const bnbPrice = await this.getBnbPriceUSD()
			const gasCostUSD = parseFloat(ethers.formatEther(gasCostWei)) * bnbPrice

			return {
				success: true,
				txHash: receipt.hash,
				explorerUrl: `https://bscscan.com/tx/${receipt.hash}`,
				stats: {
					version: 'PancakeSwap V3',
					feeTier: `${fee / 10000}%`,
					gasUsed: receipt.gasUsed.toString(),
					gasCostUSD: gasCostUSD.toFixed(4),
					executionTimeMs: executionTime,
					feeCollected: serviceFee,
					profit: (parseFloat(serviceFee) - gasCostUSD).toFixed(4)
				}
			}
		} catch (error) {
			console.error('Swap error:', error)
			return {
				success: false,
				error: error instanceof Error ? error.message : 'Swap execution failed'
			}
		}
	}

	async gaslessApprove(
		user: string,
		tokenIn: string,
		permitSignature: {
			v: number
			r: string
			s: string
			deadline: number
			value: string
		}
	): Promise<{
		success: boolean
		alreadyApproved?: boolean
		txHash?: string
		explorerUrl?: string
		permitNotSupported?: boolean
		error?: string
		stats?: {
			executionTimeMs: number
			gasUsed?: string
			gasCostUSD?: string
			userGasCost: string
		}
	}> {
		const startTime = Date.now()

		try {
			const tokenContract = new Contract(tokenIn, ERC20_ABI, this.serverWallet)
			const currentAllowance = await tokenContract.allowance(user, env.B402_RELAYER_ADDRESS)

			if (currentAllowance >= ethers.MaxUint256 / 2n) {
				const executionTime = Date.now() - startTime
				return {
					success: true,
					alreadyApproved: true,
					stats: {
						executionTimeMs: executionTime,
						userGasCost: '0.00'
					}
				}
			}

			const { v, r, s, deadline, value } = permitSignature

			try {
				const permitTx = await tokenContract.permit(
					user,
					env.B402_RELAYER_ADDRESS,
					value || ethers.MaxUint256.toString(),
					deadline,
					v,
					r,
					s,
					{ gasLimit: 100000 }
				)

				const receipt = await permitTx.wait()
				const executionTime = Date.now() - startTime
				const gasPrice = (await this.provider.getFeeData()).gasPrice || 0n
				const gasCostWei = receipt.gasUsed * gasPrice
				const bnbPrice = await this.getBnbPriceUSD()
				const gasCostUSD = parseFloat(ethers.formatEther(gasCostWei)) * bnbPrice

				return {
					success: true,
					txHash: receipt.hash,
					explorerUrl: `https://bscscan.com/tx/${receipt.hash}`,
					stats: {
						executionTimeMs: executionTime,
						gasUsed: receipt.gasUsed.toString(),
						gasCostUSD: gasCostUSD.toFixed(4),
						userGasCost: '0.00'
					}
				}
			} catch (permitError) {
				return {
					success: false,
					permitNotSupported: true,
					error: 'Token does not support EIP-2612 permit'
				}
			}
		} catch (error) {
			console.error('Gasless approval error:', error)
			return {
				success: false,
				error: error instanceof Error ? error.message : 'Gasless approval failed'
			}
		}
	}

	async getPaymentIntent(
		user: string,
		_tokenIn: string,
		_amountIn: string,
		gasEstimate?: string
	): Promise<{
		domain: {
			name: string
			version: string
			chainId: number
			verifyingContract: string
		}
		types: {
			TransferWithAuthorization: Array<{ name: string; type: string }>
		}
		value: {
			from: string
			to: string
			value: string
			validAfter: number
			validBefore: number
			nonce: string
		}
		feeBreakdown: {
			gasEstimate: string
			gasCostUSD: string
			margin: string
			totalFeeUSD: string
			feeAmount: string
			feeAmountFormatted: string
		}
	}> {
		const gasPrice = (await this.provider.getFeeData()).gasPrice || 3000000000n
		const estimatedGas = BigInt(gasEstimate || 200000)
		const gasCostWei = estimatedGas * gasPrice
		const bnbPrice = await this.getBnbPriceUSD()
		const gasCostUSD = parseFloat(ethers.formatEther(gasCostWei)) * bnbPrice
		const margin = 0.15
		const totalFeeUSD = gasCostUSD + margin

		const feeAmount = ethers.parseUnits(totalFeeUSD.toFixed(2), 18)

		const now = Math.floor(Date.now() / 1000)
		const nonce = ethers.hexlify(ethers.randomBytes(32))

		const domain = {
			name: 'B402',
			version: '1',
			chainId: env.NETWORK === 'mainnet' ? 56 : 97,
			verifyingContract: env.B402_RELAYER_ADDRESS
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

		const value = {
			from: user,
			to: this.serverWallet.address,
			value: feeAmount.toString(),
			validAfter: now - 60,
			validBefore: now + 3600,
			nonce
		}

		return {
			domain,
			types,
			value,
			feeBreakdown: {
				gasEstimate: estimatedGas.toString(),
				gasCostUSD: gasCostUSD.toFixed(4),
				margin: margin.toFixed(2),
				totalFeeUSD: totalFeeUSD.toFixed(2),
				feeAmount: feeAmount.toString(),
				feeAmountFormatted: ethers.formatUnits(feeAmount, 18)
			}
		}
	}

	async executeSwapFromTransfer(params: {
		user: string
		tokenIn: string
		tokenOut: string
		amountIn: string
		minAmountOut: string
		fee: number
	}): Promise<SwapResult> {
		const { user, tokenIn, tokenOut, amountIn, minAmountOut, fee } = params
		const startTime = Date.now()
		const serviceFee = this.getServiceFee()

		try {
			const tokenContract = new Contract(tokenIn, ERC20_ABI, this.serverWallet)
			const serverBalance = await tokenContract.balanceOf(this.serverWallet.address)

			if (serverBalance < BigInt(amountIn)) {
				return {
					success: false,
					error: `Server balance insufficient: has ${ethers.formatUnits(serverBalance, 18)} but needs ${ethers.formatUnits(amountIn, 18)}`
				}
			}

			const allowance = await tokenContract.allowance(this.serverWallet.address, PANCAKE_V3_ROUTER)
			if (allowance < BigInt(amountIn)) {
				const approveTx = await tokenContract.approve(PANCAKE_V3_ROUTER, ethers.MaxUint256, {
					gasLimit: 100000
				})
				await approveTx.wait()
			}

			const amountInBigInt = BigInt(amountIn)
			const minAmountOutBigInt = minAmountOut ? BigInt(minAmountOut) : 0n

			const swapParams = {
				tokenIn,
				tokenOut,
				fee,
				recipient: user,
				amountIn: amountInBigInt,
				amountOutMinimum: minAmountOutBigInt,
				sqrtPriceLimitX96: 0n
			}

			const swapTx = await this.router.exactInputSingle(swapParams, {
				gasLimit: 300000
			})
			const receipt = await swapTx.wait()

			const executionTime = Date.now() - startTime
			const gasPrice = (await this.provider.getFeeData()).gasPrice || 0n
			const gasCostWei = receipt.gasUsed * gasPrice
			const bnbPrice = await this.getBnbPriceUSD()
			const gasCostUSD = parseFloat(ethers.formatEther(gasCostWei)) * bnbPrice

			return {
				success: true,
				txHash: receipt.hash,
				explorerUrl: `https://bscscan.com/tx/${receipt.hash}`,
				stats: {
					version: 'PancakeSwap V3 (Single-Sig)',
					feeTier: `${fee / 10000}%`,
					gasUsed: receipt.gasUsed.toString(),
					gasCostUSD: gasCostUSD.toFixed(4),
					executionTimeMs: executionTime,
					feeCollected: serviceFee,
					profit: (parseFloat(serviceFee) - gasCostUSD).toFixed(4)
				}
			}
		} catch (error) {
			console.error('Swap error:', error)
			return {
				success: false,
				error: error instanceof Error ? error.message : 'Swap execution failed'
			}
		}
	}
}

// Singleton instance
let swapServiceInstance: SwapService | null = null

export function getSwapService(): SwapService {
	if (!swapServiceInstance) {
		swapServiceInstance = new SwapService()
	}
	return swapServiceInstance
}
