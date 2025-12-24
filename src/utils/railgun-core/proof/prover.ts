import type { Chain } from '@railgun-community/engine/dist/models/engine-types'
import type { TXIDVersion } from '@railgun-community/engine/dist/models/poi-types'
import type {
	PrivateInputsRailgun,
	Proof,
	PublicInputsRailgun,
	SnarkProof
} from '@railgun-community/engine/dist/models/prover-types'
import { ByteUtils } from '@railgun-community/engine/dist/utils/bytes'
import { SNARK_PRIME } from '@railgun-community/engine/dist/utils/constants'
import { keccak256 } from '@railgun-community/engine/dist/utils/hash'
import { signEDDSA } from '@railgun-community/engine/dist/utils/keys-utils'
import { poseidon } from '@railgun-community/engine/dist/utils/poseidon'
import { ethers } from 'ethers'
import * as path from 'node:path'
import * as snarkjs from 'snarkjs'

export interface GenerateProofParams {
	privateInputs: PrivateInputsRailgun
	publicInputs: PublicInputsRailgun
	chain: Chain
	txidVersion: TXIDVersion
	unshieldToAddress: string
	treeNumber: number
	tokenAddress: string
	unshieldAmount: bigint
	spendingPrivateKey: Uint8Array
	onProgress?: (progress: number) => void
}

export async function generateProofManually(
	params: GenerateProofParams
): Promise<{ proof: Proof; publicInputs: PublicInputsRailgun }> {
	const {
		privateInputs,
		publicInputs,
		chain,
		treeNumber,
		spendingPrivateKey,
	} = params

	// Build BoundParams struct (same structure as SDK)
	const boundParams = {
		treeNumber,
		minGasPrice: 0, // Not using gas price for now
		unshield: 1, // 1 = unshield enabled
		chainID: ByteUtils.hexlify(chain.id, true),
		adaptContract: ethers.ZeroAddress, // No adapt contract
		adaptParams: ethers.ZeroHash, // No adapt params
		commitmentCiphertext: [] // Empty for unshield (no new internal commitments)
	}

	// Calculate boundParamsHash using SDK's method
	const abiCoder = ethers.AbiCoder.defaultAbiCoder()
	const hashed = keccak256(
		abiCoder.encode(
			[
				'tuple(uint16 treeNumber, uint48 minGasPrice, uint8 unshield, uint64 chainID, address adaptContract, bytes32 adaptParams, tuple(bytes32[4] ciphertext, bytes32 blindedSenderViewingKey, bytes32 blindedReceiverViewingKey, bytes annotationData, bytes memo)[] commitmentCiphertext) boundParams'
			],
			[boundParams]
		)
	)
	const boundParamsHash = ByteUtils.hexToBigInt(hashed) % SNARK_PRIME
	publicInputs.boundParamsHash = boundParamsHash

	// Generate REAL signature (like SDK does)
	const msg = poseidon([
		publicInputs.merkleRoot,
		publicInputs.boundParamsHash,
		...publicInputs.nullifiers,
		...publicInputs.commitmentsOut
	])
	const signature = signEDDSA(spendingPrivateKey, msg)
	const signatureFormatted = [
		signature.R8[0].toString(),
		signature.R8[1].toString(),
		signature.S.toString()
	]

	// Format inputs for snarkjs (circuit expects specific format)
	// SDK formatRailgunInputs passes arrays directly and uses pathElements.flat(2)
	// Values are converted to strings by snarkjs automatically
	// Key: SDK passes arrays, not single values! For 1x1, arrays have 1 element each.

	// Convert bigint arrays to string arrays (snarkjs expects strings)
	const bigintArrayToStringArray = (arr: bigint[]): string[] => {
		return arr.map((v) => v.toString())
	}

	const circuitInputs = {
		merkleRoot: publicInputs.merkleRoot.toString(),
		boundParamsHash: boundParamsHash.toString(),
		nullifiers: bigintArrayToStringArray(publicInputs.nullifiers), // Array, not single value!
		commitmentsOut: bigintArrayToStringArray(publicInputs.commitmentsOut), // Array, not single value!
		token: privateInputs.tokenAddress.toString(),
		publicKey: bigintArrayToStringArray(privateInputs.publicKey), // [x, y] array
		signature: signatureFormatted, // [R8[0], R8[1], S] - already strings from signEDDSA
		randomIn: bigintArrayToStringArray(privateInputs.randomIn), // Array, not single value!
		valueIn: bigintArrayToStringArray(privateInputs.valueIn), // Array, not single value!
		pathElements: privateInputs.pathElements.flat(2).map((e) => e.toString()), // CRITICAL: flat(2) like SDK!
		leavesIndices: bigintArrayToStringArray(privateInputs.leavesIndices), // Array, not single value!
		nullifyingKey: privateInputs.nullifyingKey.toString(),
		npkOut: bigintArrayToStringArray(privateInputs.npkOut), // Array, not single value!
		valueOut: bigintArrayToStringArray(privateInputs.valueOut) // Array, not single value!
	}

	// Get circuit artifact paths
	const artifactsDir = '.railgun-artifacts'
	const circuitName = '01x01' // 1 input, 1 output
	const wasmPath = path.join(artifactsDir, `artifacts-v2.1/${circuitName}/wasm`)
	const zkeyPath = path.join(artifactsDir, `artifacts-v2.1/${circuitName}/zkey`)

	try {
		const { proof } = await snarkjs.groth16.fullProve(circuitInputs, wasmPath, zkeyPath)

		// Convert snarkjs proof format to SDK Proof format
		const sdkProof: Proof = {
			pi_a: [proof.pi_a[0], proof.pi_a[1]],
			pi_b: [
				[proof.pi_b[0][1], proof.pi_b[0][0]], // Note: snarkjs returns these in reverse order
				[proof.pi_b[1][1], proof.pi_b[1][0]]
			],
			pi_c: [proof.pi_c[0], proof.pi_c[1]]
		}

		return { proof: sdkProof, publicInputs }
	} catch (error) {
		console.error('[Manual Prover] ❌ Proof generation failed:', error)
		throw error
	}
}

/**
 * Format proof for Railgun contract
 */
export function formatProofForContract(result: {
	proof: Proof
	publicInputs: PublicInputsRailgun
}): {
	snarkProof: SnarkProof
	merkleRoot: bigint
	nullifiers: bigint[]
	commitments: bigint[]
} {
	return {
		snarkProof: result.proof,
		merkleRoot: result.publicInputs.merkleRoot,
		nullifiers: result.publicInputs.nullifiers,
		commitments: result.publicInputs.commitmentsOut
	}
}
