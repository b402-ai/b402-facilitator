import type { SpendingKeyPair } from '@railgun-community/engine/dist/key-derivation/wallet-node'
import type {} from '@railgun-community/engine/dist/models/engine-types'
import type {
	PrivateInputsRailgun,
	PublicInputsRailgun
} from '@railgun-community/engine/dist/models/prover-types'
import type { TXO } from '@railgun-community/engine/dist/models/txo-types'
import { TransactNote } from '@railgun-community/engine/dist/note/transact-note'
import { ByteLength, ByteUtils } from '@railgun-community/engine/dist/utils/bytes'
import { poseidonHex } from '@railgun-community/engine/dist/utils/poseidon'

import type { MerkleProofResponse } from '../../utils/api'

export interface UnshieldInputs {
	utxo: TXO
	merkleProof: MerkleProofResponse
	nullifyingKey: bigint
	spendingKeyPair: SpendingKeyPair
	unshieldAmount: bigint
	unshieldToAddress: string
	tokenAddress: string
}

/**
 * Convert API merkle proof format to SDK format
 */
function convertMerkleProof(apiProof: MerkleProofResponse): {
	elements: bigint[]
	indices: bigint
} {
	const elements = apiProof.proof.map((p) => BigInt(p))

	// Convert path indices array to bitfield
	let indicesBitfield = 0n
	for (let i = 0; i < apiProof.pathIndices.length; i++) {
		if (apiProof.pathIndices[i] === 1) {
			indicesBitfield |= 1n << BigInt(i)
		}
	}

	return { elements, indices: indicesBitfield }
}

export function buildUnshieldProofInputs(inputs: UnshieldInputs): {
	privateInputs: PrivateInputsRailgun
	publicInputs: PublicInputsRailgun
} {
	const {
		utxo,
		merkleProof,
		nullifyingKey,
		spendingKeyPair,
		unshieldAmount,
		unshieldToAddress,
		tokenAddress
	} = inputs

	// Convert API merkle proof to SDK format
	const { elements: pathElements, indices: leavesIndices } = convertMerkleProof(merkleProof)
	const inputCommitment = ByteUtils.hexToBigInt(
		poseidonHex([
			ByteUtils.nToHex(utxo.note.notePublicKey, ByteLength.UINT_256),
			tokenAddress,
			ByteUtils.nToHex(utxo.note.value, ByteLength.UINT_256)
		])
	)
	console.log(
		'[DEBUG] Calculated input commitment:',
		`0x${inputCommitment.toString(16).padStart(64, '0')}`
	)
	console.log('[DEBUG] Expected commitment (from API):', utxo.blindedCommitment)
	console.log(
		'[DEBUG] Commitments match:',
		utxo.blindedCommitment.toLowerCase() ===
			`0x${inputCommitment.toString(16).padStart(64, '0')}`.toLowerCase()
	)

	// Manually verify the merkle proof using API pathIndices directly
	console.log('[DEBUG] Manually verifying merkle proof...')
	console.log('[DEBUG] API pathIndices:', merkleProof.pathIndices)
	let computedHash = inputCommitment
	for (let i = 0; i < pathElements.length; i++) {
		const isRight = merkleProof.pathIndices[i] === 1
		const siblingHash = pathElements[i]
		const prevHash = computedHash

		if (isRight) {
			// Current node is right child, so sibling (left child) goes first
			computedHash = ByteUtils.hexToBigInt(
				poseidonHex([
					ByteUtils.nToHex(siblingHash, ByteLength.UINT_256),
					ByteUtils.nToHex(computedHash, ByteLength.UINT_256)
				])
			)
			console.log(
				`[DEBUG]   Level ${i}: RIGHT - poseidon(0x${siblingHash.toString(16).slice(0, 8)}..., 0x${prevHash.toString(16).slice(0, 8)}...) = 0x${computedHash.toString(16).slice(0, 8)}...`
			)
		} else {
			// Current node is left child, so sibling (right child) goes second
			computedHash = ByteUtils.hexToBigInt(
				poseidonHex([
					ByteUtils.nToHex(computedHash, ByteLength.UINT_256),
					ByteUtils.nToHex(siblingHash, ByteLength.UINT_256)
				])
			)
			console.log(
				`[DEBUG]   Level ${i}: LEFT - poseidon(0x${prevHash.toString(16).slice(0, 8)}..., 0x${siblingHash.toString(16).slice(0, 8)}...) = 0x${computedHash.toString(16).slice(0, 8)}...`
			)
		}
	}

	// Calculate nullifier
	const nullifier = TransactNote.getNullifier(nullifyingKey, utxo.position)
	console.log('[DEBUG] Calculated nullifier:', `0x${nullifier.toString(16)}`)

	// Build unshield note (output)
	// For unshield, npk = recipient address (contract will cast it to address)
	const unshieldNotePublicKey = BigInt(unshieldToAddress)
	const unshieldNoteValue = unshieldAmount

	// Private inputs (witness)
	const privateInputs: PrivateInputsRailgun = {
		tokenAddress: ByteUtils.hexToBigInt(tokenAddress),
		publicKey: spendingKeyPair.pubkey, // Spending public key [x, y]
		randomIn: [ByteUtils.hexToBigInt(utxo.note.random)],
		valueIn: [utxo.note.value],
		pathElements: [pathElements],
		leavesIndices: [leavesIndices],
		nullifyingKey,
		npkOut: [unshieldNotePublicKey], // 1D array for 1x1 circuit
		valueOut: [unshieldNoteValue]
	}

	// Calculate output commitment (unshield commitment)
	// For unshield, commitment = poseidon(npk, token, value)
	const unshieldCommitment = ByteUtils.hexToBigInt(
		poseidonHex([
			ByteUtils.nToHex(unshieldNotePublicKey, ByteLength.UINT_256),
			tokenAddress,
			ByteUtils.nToHex(unshieldNoteValue, ByteLength.UINT_256)
		])
	)

	// Public inputs (circuit outputs)
	const publicInputs: PublicInputsRailgun = {
		merkleRoot: BigInt(merkleProof.root),
		boundParamsHash: BigInt(0), // Will be set later by SDK
		nullifiers: [nullifier],
		commitmentsOut: [unshieldCommitment]
	}

	return { privateInputs, publicInputs }
}
