import type {
	PrivateInputsRailgun,
	PublicInputsRailgun
} from '@railgun-community/engine/dist/models/prover-types'
import type { TXO } from '@railgun-community/engine/dist/models/txo-types'
import type { TransactNote } from '@railgun-community/engine/dist/note/transact-note'
import { TransactNote as TransactNoteClass } from '@railgun-community/engine/dist/note/transact-note'

import type { MerkleProofResponse } from './api'

export function convertMerkleProofToSDKFormat(apiProof: MerkleProofResponse): {
	elements: bigint[]
	indices: bigint
} {
	const elements = apiProof.proof.map((p) => BigInt(p))

	let indicesBitfield = 0n
	for (let i = 0; i < apiProof.pathIndices.length; i++) {
		if (apiProof.pathIndices[i] === 1) {
			indicesBitfield |= 1n << BigInt(i)
		}
	}

	return { elements, indices: indicesBitfield }
}

export function buildPrivateInputs(
	tokenAddress: string,
	publicKey: [bigint, bigint],
	utxos: TXO[],
	merkleProofs: MerkleProofResponse[],
	nullifyingKey: bigint,
	outputNotes: TransactNote[]
): PrivateInputsRailgun {
	if (utxos.length !== merkleProofs.length) {
		throw new Error('Number of UTXOs must match number of merkle proofs')
	}

	const pathElementsArrays: bigint[][] = []
	const leavesIndices: bigint[] = []

	for (let i = 0; i < merkleProofs.length; i++) {
		const converted = convertMerkleProofToSDKFormat(merkleProofs[i])
		pathElementsArrays.push(converted.elements)
		leavesIndices.push(converted.indices)
	}

	return {
		tokenAddress: BigInt(tokenAddress),
		publicKey,
		randomIn: utxos.map((u) => BigInt(u.note.random)),
		valueIn: utxos.map((u) => u.note.value),
		pathElements: pathElementsArrays,
		leavesIndices,
		nullifyingKey,
		npkOut: outputNotes.map((n) => n.notePublicKey),
		valueOut: outputNotes.map((n) => n.value)
	}
}

export function buildPublicInputs(
	merkleRoot: string,
	boundParamsHash: string,
	nullifiers: string[],
	commitmentsOut: bigint[]
): PublicInputsRailgun {
	return {
		merkleRoot: BigInt(merkleRoot),
		boundParamsHash: BigInt(boundParamsHash),
		nullifiers: nullifiers.map((n) => BigInt(n)),
		commitmentsOut
	}
}

export function computeNullifier(nullifyingKey: bigint, position: number): string {
	const nullifier = TransactNoteClass.getNullifier(nullifyingKey, position)
	return `0x${nullifier.toString(16).padStart(64, '0')}`
}
