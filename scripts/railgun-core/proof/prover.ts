/**
 * Manual ZK Proof Generation
 *
 * Bypasses SDK entirely and calls snarkjs directly
 * with manually constructed inputs from API merkle proofs.
 */
import type { Chain } from '@railgun-community/engine/dist/models/engine-types'
import { TXIDVersion } from '@railgun-community/engine/dist/models/poi-types'
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
import { poseidon, poseidonHex } from '@railgun-community/engine/dist/utils/poseidon'
import { getEngine } from '@railgun-community/wallet'
import { ethers } from 'ethers'
import * as path from 'path'
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

/**
 * Generate ZK proof using SDK's prover with manually constructed inputs
 *
 * This bypasses the SDK's transaction generation flow which requires
 * blockchain scanning. We provide all inputs directly from API data.
 */
export async function generateProofManually(
	params: GenerateProofParams
): Promise<{ proof: Proof; publicInputs: PublicInputsRailgun }> {
	const {
		privateInputs,
		publicInputs,
		chain,
		txidVersion,
		unshieldToAddress,
		treeNumber,
		tokenAddress,
		unshieldAmount,
		spendingPrivateKey,
		onProgress
	} = params

	console.log('[Manual Prover] Generating proof...')
	console.log(
		`[Manual Prover] Circuit: ${publicInputs.nullifiers.length}x${publicInputs.commitmentsOut.length}`
	)

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

	console.log('[Manual Prover] Bound params:', boundParams)
	console.log('[Manual Prover] Bound params hash:', `0x${boundParamsHash.toString(16)}`)

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

	console.log('[Manual Prover] Signed message:', `0x${msg.toString(16)}`)
	console.log('[Manual Prover] Signature:', signatureFormatted)

	// Format inputs for snarkjs (circuit expects specific format)
	// SDK uses flat(2) on pathElements and passes npkOut/other arrays as-is
	const circuitInputs = {
		merkleRoot: publicInputs.merkleRoot.toString(),
		boundParamsHash: boundParamsHash.toString(),
		nullifiers: publicInputs.nullifiers[0].toString(), // Single value for 1x1
		commitmentsOut: publicInputs.commitmentsOut[0].toString(), // Single value for 1x1
		token: privateInputs.tokenAddress.toString(),
		publicKey: privateInputs.publicKey.map((p) => p.toString()),
		signature: signatureFormatted, // Real EDDSA signature
		randomIn: privateInputs.randomIn[0].toString(), // Single value for 1x1
		valueIn: privateInputs.valueIn[0].toString(), // Single value for 1x1
		pathElements: privateInputs.pathElements[0].map((e) => e.toString()), // Single input's path
		leavesIndices: privateInputs.leavesIndices[0].toString(), // Single input's indices
		nullifyingKey: privateInputs.nullifyingKey.toString(),
		npkOut: privateInputs.npkOut[0].toString(), // Single npk value for 1x1 (unshield = 0)
		valueOut: privateInputs.valueOut[0].toString() // Single value for 1x1
	}

	console.log('[Manual Prover] Formatted circuit inputs (with signature)')
	console.log('[DEBUG] npkOut value:', privateInputs.npkOut)
	console.log('[DEBUG] All circuit inputs:')
	console.log(JSON.stringify(circuitInputs, null, 2))

	// Get circuit artifact paths
	const artifactsDir = '.railgun-artifacts'
	const circuitName = '01x01' // 1 input, 1 output
	const wasmPath = path.join(artifactsDir, `artifacts-v2.1/${circuitName}/wasm`)
	const zkeyPath = path.join(artifactsDir, `artifacts-v2.1/${circuitName}/zkey`)

	console.log('[Manual Prover] Circuit artifacts:')
	console.log(`  WASM: ${wasmPath}`)
	console.log(`  ZKEY: ${zkeyPath}`)

	try {
		console.log('[Manual Prover] Calling snarkjs.groth16.fullProve()...')
		const { proof, publicSignals } = await snarkjs.groth16.fullProve(
			circuitInputs,
			wasmPath,
			zkeyPath
		)

		console.log('[Manual Prover] ✅ Proof generated successfully')
		console.log('[Manual Prover] Public signals:', publicSignals)

		// Convert snarkjs proof format to SDK Proof format
		const sdkProof: Proof = {
			pi_a: [proof.pi_a[0], proof.pi_a[1]],
			pi_b: [
				[proof.pi_b[0][1], proof.pi_b[0][0]], // Note: snarkjs returns these in reverse order
				[proof.pi_b[1][1], proof.pi_b[1][0]]
			],
			pi_c: [proof.pi_c[0], proof.pi_c[1]]
		}

		console.log('[Manual Prover] Nullifier:', `0x${publicInputs.nullifiers[0].toString(16)}`)

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
