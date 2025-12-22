import type { Chain } from '@railgun-community/engine/dist/models/engine-types'
import type { Proof, PublicInputsRailgun } from '@railgun-community/engine/dist/models/prover-types'
import { ethers } from 'ethers'

export interface RailgunTransactionStruct {
	proof: {
		a: { x: string; y: string } // G1Point
		b: { x: [string, string]; y: [string, string] } // G2Point
		c: { x: string; y: string } // G1Point
	}
	merkleRoot: string
	nullifiers: string[]
	commitments: string[]
	boundParams: {
		treeNumber: number
		minGasPrice: string
		unshield: number // UnshieldType enum: 0=NONE, 1=NORMAL, 2=REDIRECT
		chainID: string
		adaptContract: string
		adaptParams: string
		commitmentCiphertext: any[] // Empty for unshield
	}
	unshieldPreimage: {
		npk: string
		token: {
			tokenType: number
			tokenAddress: string
			tokenSubID: number
		}
		value: string
	}
}

export function formatUnshieldTransaction(params: {
	proof: { proof: Proof; publicInputs: PublicInputsRailgun }
	treeNumber: number
	tokenAddress: string
	recipientAddress: string
	unshieldAmount: bigint
	chain: Chain
}): RailgunTransactionStruct {
	const {
		proof: proofResult,
		treeNumber,
		tokenAddress,
		recipientAddress,
		unshieldAmount,
		chain
	} = params

	console.log('[Transaction Formatter] Formatting unshield transaction...')

	// Format snarkProof for contract (must match Globals.sol struct)
	// SnarkProof { G1Point a, G2Point b, G1Point c }
	const snarkProof = {
		a: {
			x: proofResult.proof.pi_a[0],
			y: proofResult.proof.pi_a[1]
		},
		b: {
			x: [proofResult.proof.pi_b[0][0], proofResult.proof.pi_b[0][1]] as [string, string],
			y: [proofResult.proof.pi_b[1][0], proofResult.proof.pi_b[1][1]] as [string, string]
		},
		c: {
			x: proofResult.proof.pi_c[0],
			y: proofResult.proof.pi_c[1]
		}
	}

	// Format public inputs
	const merkleRoot = `0x${proofResult.publicInputs.merkleRoot.toString(16).padStart(64, '0')}`
	const nullifiers = proofResult.publicInputs.nullifiers.map(
		(n) => `0x${n.toString(16).padStart(64, '0')}`
	)
	const commitments = proofResult.publicInputs.commitmentsOut.map(
		(c) => `0x${c.toString(16).padStart(64, '0')}`
	)

	console.log('[Transaction Formatter] Merkle root:', merkleRoot)
	console.log('[Transaction Formatter] Nullifiers:', nullifiers)
	console.log('[Transaction Formatter] Commitments:', commitments)

	// Build unshieldPreimage (the output note that will be burned/unshielded)
	// For unshield, npk contains the recipient address (contract casts it to address)
	// See RailgunLogic.sol:330: address(uint160(uint256(_note.npk)))
	const recipientAddressBigInt = BigInt(recipientAddress)
	const npkHex = `0x${recipientAddressBigInt.toString(16).padStart(64, '0')}`

	const unshieldPreimage = {
		npk: npkHex, // Recipient address as bytes32
		token: {
			tokenType: 0, // ERC20
			tokenAddress: ethers.getAddress(tokenAddress),
			tokenSubID: 0 // uint256 zero (not used for ERC20)
		},
		value: unshieldAmount.toString()
	}

	// Build transaction struct
	const transactionStruct: RailgunTransactionStruct = {
		proof: snarkProof,
		merkleRoot,
		nullifiers,
		commitments,
		boundParams: {
			treeNumber,
			minGasPrice: '0', // No min gas price
			unshield: 1, // UnshieldType.NORMAL
			chainID: `0x${chain.id.toString(16)}`,
			adaptContract: ethers.ZeroAddress,
			adaptParams: ethers.ZeroHash,
			commitmentCiphertext: [] // Empty for unshield (no new commitments being created)
		},
		unshieldPreimage
	}

	console.log('[Transaction Formatter] ✅ Transaction formatted')
	console.log('[Transaction Formatter] Unshield:', {
		token: tokenAddress,
		to: recipientAddress,
		amount: unshieldAmount.toString()
	})

	return transactionStruct
}

/**
 * Encode transaction data for contract call
 */
export function encodeUnshieldTransaction(
	transactionStruct: RailgunTransactionStruct,
	railgunContractAddress: string
): { to: string; data: string } {
	// RailgunSmartWallet ABI for transact() function
	// Must match the exact structure in Globals.sol
	const railgunABI = [
		`function transact(
			tuple(
				tuple(
					tuple(uint256 x, uint256 y) a,
					tuple(uint256[2] x, uint256[2] y) b,
					tuple(uint256 x, uint256 y) c
				) proof,
				bytes32 merkleRoot,
				bytes32[] nullifiers,
				bytes32[] commitments,
				tuple(
					uint16 treeNumber,
					uint72 minGasPrice,
					uint8 unshield,
					uint64 chainID,
					address adaptContract,
					bytes32 adaptParams,
					tuple(
						bytes32[4] ciphertext,
						bytes32 blindedSenderViewingKey,
						bytes32 blindedReceiverViewingKey,
						bytes annotationData,
						bytes memo
					)[] commitmentCiphertext
				) boundParams,
				tuple(
					bytes32 npk,
					tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token,
					uint120 value
				) unshieldPreimage
			)[] _transactions
		)`
	]

	const iface = new ethers.Interface(railgunABI)

	// The contract expects an ARRAY of transactions
	const data = iface.encodeFunctionData('transact', [[transactionStruct]])

	console.log('[Transaction Formatter] Encoded transaction data')
	console.log('[Transaction Formatter] To:', railgunContractAddress)
	console.log('[Transaction Formatter] Data length:', data.length, 'bytes')

	return {
		to: railgunContractAddress,
		data
	}
}
