import 'dotenv/config'
import { ethers } from 'ethers'

const ENTRY_POINT_ABI = [
	'function depositTo(address account) payable',
	'function balanceOf(address account) view returns (uint256)'
]

async function depositToPaymaster() {
	const BSC_RPC = process.env.BSC_RPC_URL
	if (!BSC_RPC) throw new Error('BSC_RPC_URL not set')

	const PAYMASTER_ADDRESS = process.env.PAYMASTER_ADDRESS
	if (!PAYMASTER_ADDRESS) throw new Error('PAYMASTER_ADDRESS not set')

	const PAYMASTER_SIGNER_KEY = process.env.PAYMASTER_SIGNER_KEY
	if (!PAYMASTER_SIGNER_KEY) throw new Error('PAYMASTER_SIGNER_KEY not set')

	const ENTRY_POINT =
		process.env.ENTRY_POINT_ADDRESS || '0x0000000071727De22E5E9d8BAf0edAc6f37da032'

	const provider = new ethers.JsonRpcProvider(BSC_RPC)
	const signer = new ethers.Wallet(PAYMASTER_SIGNER_KEY, provider)
	const entryPoint = new ethers.Contract(ENTRY_POINT, ENTRY_POINT_ABI, signer)

	const paymasterBalance = await entryPoint.balanceOf(PAYMASTER_ADDRESS)
	console.log(`Paymaster deposit: ${ethers.formatEther(paymasterBalance)} BNB`)

	const signerBalance = await provider.getBalance(signer.address)
	if (signerBalance === 0n) throw new Error(`Signer has no BNB: ${signer.address}`)

	const depositAmount = ethers.parseEther('0.001')
	const tx = await entryPoint.depositTo(PAYMASTER_ADDRESS, {
		value: depositAmount,
		gasLimit: 100000
	})

	console.log(`Tx: ${tx.hash}`)
	const receipt = await tx.wait()
	console.log(`Block: ${receipt?.blockNumber}`)

	const newBalance = await entryPoint.balanceOf(PAYMASTER_ADDRESS)
	console.log(`New deposit: ${ethers.formatEther(newBalance)} BNB`)
}

depositToPaymaster().catch(console.error)
