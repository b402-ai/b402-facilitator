/**
 * Merkletree Injection Utility
 *
 * Injects commitment data from B402 API into SDK's merkletree,
 * enabling proof generation without blockchain scanning.
 */
import type { Chain } from '@railgun-community/engine/dist/models/engine-types'
import { TXIDVersion } from '@railgun-community/engine/dist/models/poi-types'
import { getEngine } from '@railgun-community/wallet'

import type { SpendableUTXO } from '../utils/unshield-api'

/**
 * Inject commitments from B402 API into SDK's merkletree
 *
 * This populates the merkletree with only the specific commitments
 * we need to spend. No blockchain scanning required.
 *
 * After injection, SDK's `merkletree.getMerkleProof()` will work
 * for these specific positions, allowing proof generation to succeed.
 */
export async function injectCommitmentsIntoMerkletree(
	chain: Chain,
	txidVersion: TXIDVersion,
	utxos: SpendableUTXO[]
): Promise<void> {
	if (utxos.length === 0) {
		console.log('[Merkletree Injection] No commitments to inject')
		return
	}

	console.log(`[Merkletree Injection] Injecting ${utxos.length} commitment(s) into merkletree...`)

	const engine = getEngine()

	// Access the UTXO merkletree for this chain
	const merkletree = engine.utxoMerkletrees[chain.type]?.[chain.id]?.[txidVersion]

	if (!merkletree) {
		throw new Error(
			`Merkletree not found for chain ${chain.type}:${chain.id}, txidVersion ${txidVersion}`
		)
	}

	// Group commitments by tree number (in case we have UTXOs from different trees)
	const commitmentsByTree = new Map<number, Array<{ position: number; commitment: string }>>()

	for (const { txo } of utxos) {
		if (!commitmentsByTree.has(txo.tree)) {
			commitmentsByTree.set(txo.tree, [])
		}
		commitmentsByTree.get(txo.tree)!.push({
			position: txo.position,
			commitment: txo.blindedCommitment
		})
	}

	// Inject commitments into each tree
	for (const [treeNumber, commitments] of commitmentsByTree.entries()) {
		console.log(
			`[Merkletree Injection] Tree ${treeNumber}: Injecting ${commitments.length} commitment(s)`
		)

		// Sort by position to ensure proper insertion
		commitments.sort((a, b) => a.position - b.position)

		for (const { position, commitment } of commitments) {
			console.log(`[Merkletree Injection]   Position ${position}: ${commitment}`)

			// Insert the commitment leaf at the specific position
			// queueLeaves handles insertion at arbitrary positions
			await merkletree.queueLeaves(treeNumber, position, [commitment])
		}
	}

	console.log('[Merkletree Injection] ✅ Successfully injected all commitments')
	console.log(
		'[Merkletree Injection] SDK prover can now generate merkle proofs for these positions'
	)
}
