import 'dotenv/config'
import { ethers } from 'ethers'

// ------------ Config (edit this) ------------
const BUNDLER_PRIVATE_KEY = ''
// --------------------------------------------

const ENTRY_POINT_ABI = [
	'function addStake(uint32 unstakeDelaySec) payable',
	'function getDepositInfo(address account) view returns (tuple(uint256 deposit, bool staked, uint112 stake, uint32 unstakeDelaySec, uint48 withdrawTime))'
]

async function stakeBundler() {
	const BSC_RPC = process.env.BSC_RPC_URL
	if (!BSC_RPC) throw new Error('BSC_RPC_URL not set')

	if (BUNDLER_PRIVATE_KEY === '') {
		throw new Error('Replace BUNDLER_PRIVATE_KEY with actual private key')
	}

	const ENTRY_POINT =
		process.env.ENTRY_POINT_ADDRESS || '0x0000000071727De22E5E9d8BAf0edAc6f37da032'

	const provider = new ethers.JsonRpcProvider(BSC_RPC)
	const bundlerWallet = new ethers.Wallet(BUNDLER_PRIVATE_KEY, provider)
	const entryPoint = new ethers.Contract(ENTRY_POINT, ENTRY_POINT_ABI, bundlerWallet)

	const depositInfo = await entryPoint.getDepositInfo(bundlerWallet.address)
	console.log(`Current stake: ${ethers.formatEther(depositInfo.stake)} BNB`)

	const bundlerBalance = await provider.getBalance(bundlerWallet.address)
	if (bundlerBalance === 0n) throw new Error(`Bundler has no BNB: ${bundlerWallet.address}`)

	const stakeAmount = ethers.parseEther('0.001')
	const unstakeDelay = 86400

	const tx = await entryPoint.addStake(unstakeDelay, {
		value: stakeAmount,
		gasLimit: 100000
	})

	console.log(`Tx: ${tx.hash}`)
	const receipt = await tx.wait()
	console.log(`Block: ${receipt?.blockNumber}`)

	const newDepositInfo = await entryPoint.getDepositInfo(bundlerWallet.address)
	console.log(`New stake: ${ethers.formatEther(newDepositInfo.stake)} BNB`)
}

stakeBundler().catch(console.error)
