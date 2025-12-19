/**
 * API-First Proof Inputs Builder
 *
 * Constructs ZK proof inputs directly from B402 API data,
 * bypassing SDK's merkletree and wallet database entirely.
 */
import type { ViewingKeyPair } from '@railgun-community/engine/dist/key-derivation/wallet-node'
import type { SpendingKeyPair } from '@railgun-community/engine/dist/key-derivation/wallet-node'
import type { Chain } from '@railgun-community/engine/dist/models/engine-types'
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

/**
 * Build ZK proof inputs from API data
 *
 * This is the core function that enables API-first unshield.
 * All data comes from B402 API - no blockchain scanning needed.
 */
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

	console.log('[DEBUG buildUnshieldProofInputs] Input values:')
	console.log('  utxo.position:', utxo.position)
	console.log('  utxo.note.random:', utxo.note.random)
	console.log('  utxo.note.value:', utxo.note.value)
	console.log('  utxo.note.notePublicKey:', utxo.note.notePublicKey)
	console.log('  tokenAddress:', tokenAddress)
	console.log('  unshieldAmount:', unshieldAmount)
	console.log('  spendingKeyPair.pubkey:', spendingKeyPair.pubkey)
	console.log('  merkleProof.root:', merkleProof.root)
	console.log('  merkleProof.proof length:', merkleProof.proof.length)

	// Convert API merkle proof to SDK format
	const { elements: pathElements, indices: leavesIndices } = convertMerkleProof(merkleProof)

	// Calculate INPUT commitment (the one in the merkle tree that we're spending)
	// This should match the blinded commitment at the UTXO position
	const inputCommitment = ByteUtils.hexToBigInt(
		poseidonHex([
			ByteUtils.nToHex(utxo.note.notePublicKey, ByteLength.UINT_256),
			tokenAddress,
			ByteUtils.nToHex(utxo.note.value, ByteLength.UINT_256)
		])
	)
	console.log('[DEBUG] Calculated input commitment:', `0x${inputCommitment.toString(16)}`)

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
