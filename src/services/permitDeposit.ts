/**
 * Permit Deposit Relay — submits Bridge2 permit deposits on Arbitrum.
 *
 * Same pattern as SwapService: server wallet calls contract directly.
 * Users sign permit offline → send to this service → we submit.
 * Users pay $0 gas.
 */
import { Contract, JsonRpcProvider, Wallet, ethers } from 'ethers'

const BRIDGE2_ADDRESS = '0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7'
const ARB_RPC = process.env.ARB_RPC_URL || 'https://arb1.arbitrum.io/rpc'

const BRIDGE2_ABI = [
	'function batchedDepositWithPermit(tuple(address user, uint64 usd, uint64 deadline, tuple(uint256 r, uint256 s, uint8 v) signature)[] deposits)'
]

export class PermitDepositRelay {
	private provider: JsonRpcProvider
	private relayer: Wallet

	constructor(relayerKey: string) {
		this.provider = new JsonRpcProvider(ARB_RPC)
		this.relayer = new Wallet(relayerKey, this.provider)
	}

	async health() {
		const balance = await this.provider.getBalance(this.relayer.address)
		return {
			relayer: this.relayer.address,
			arbEth: ethers.formatEther(balance),
			ready: balance > ethers.parseEther('0.0001')
		}
	}

	async submit(params: {
		user: string
		usd: string
		deadline: number
		v: number
		r: string
		s: string
	}) {
		const bridge2 = new Contract(BRIDGE2_ADDRESS, BRIDGE2_ABI, this.relayer)
		const tx = await bridge2.batchedDepositWithPermit([
			{
				user: params.user,
				usd: BigInt(params.usd),
				deadline: params.deadline,
				signature: { r: params.r, s: params.s, v: params.v }
			}
		])
		const receipt = await tx.wait()
		return { txHash: receipt.hash }
	}
}
