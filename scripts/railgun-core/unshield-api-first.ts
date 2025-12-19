/**
 * API-First Unshield Implementation
 *
 * Complete unshield flow using only B402 API data.
 * No blockchain scanning, no merkletree database, no wallet storage.
 */
import type { ViewingKeyPair } from '@railgun-community/engine/dist/key-derivation/wallet-node'
import { deriveNodes } from '@railgun-community/engine/dist/key-derivation/wallet-node'
import type { Chain } from '@railgun-community/engine/dist/models/engine-types'
import { TXIDVersion } from '@railgun-community/engine/dist/models/poi-types'
import { getEngine } from '@railgun-community/wallet'
import { ethers } from 'ethers'

import type { SpendableUTXO } from '../utils/unshield-api'
import { buildUnshieldProofInputs } from './proof/inputs-builder'

export interface ApiFirstUnshieldParams {
	// B402 API data
	utxo: SpendableUTXO // Has TXO + merkle proof from API

	// Wallet keys
	mnemonic: string
	encryptionKey: string

	// Unshield details
	unshieldAmount: bigint
	recipientAddress: string
	tokenAddress: string

	// Chain
	chain: Chain
}

/**
 * Execute complete API-first unshield
 *
 * This function demonstrates how to unshield using only API data.
 * The SDK's merkletree and wallet DB are completely bypassed.
 *
 * Steps:
 * 1. Derive Railgun keys from mnemonic
 * 2. Build ZK proof inputs from API merkle proof (no blockchain scan!)
 * 3. Generate ZK proof using SDK's prover
 * 4. Format transaction for Railgun contract
 * 5. Execute transaction
 */
export async function executeApiFirstUnshield(params: ApiFirstUnshieldParams): Promise<{
	txHash: string
	nullifier: string
	proof: any
}> {
	const { utxo, mnemonic, encryptionKey, unshieldAmount, recipientAddress, tokenAddress, chain } =
		params

	console.log('[API-First Unshield] Starting...')
	console.log(`  UTXO Position: ${utxo.txo.position}`)
	console.log(`  Tree: ${utxo.txo.tree}`)
	console.log(`  Amount: ${unshieldAmount.toString()}`)

	// Step 1: Derive Railgun keys
	console.log('[API-First Unshield] Deriving keys...')
	const nodes = await deriveNodes(mnemonic, encryptionKey)
	const nullifyingKey = nodes.viewing.getNullifyingKey()
	const viewingKeyPair = nodes.viewing.getViewingKeyPair()

	// Step 2: Build ZK proof inputs from API data
	console.log('[API-First Unshield] Building proof inputs from API merkle proof...')
	const { privateInputs, publicInputs } = buildUnshieldProofInputs({
		utxo: utxo.txo,
		merkleProof: utxo.merkleProof, // ← From B402 API!
		nullifyingKey,
		viewingKeyPair,
		unshieldAmount,
		unshieldToAddress: recipientAddress,
		tokenAddress
	})

	console.log('[API-First Unshield] Proof inputs built successfully')
	console.log(`  Merkle root: ${publicInputs.merkleRoot.toString(16)}`)
	console.log(`  Nullifier: ${publicInputs.nullifiers[0].toString(16)}`)

	// Step 3: Generate ZK proof
	console.log('[API-First Unshield] Generating ZK proof...')
	const engine = getEngine()

	// TODO: Call prover with our manually constructed inputs
	// This is where we need to hook into the SDK's prover
	// Current SDK design makes this difficult because it wants to fetch
	// merkle proofs itself. We need to either:
	// A) Populate the merkletree with our API data first, OR
	// B) Call a lower-level prover API directly
	//
	// For now, this demonstrates the approach.

	throw new Error('Not yet fully implemented - see comments above')

	// Steps 4-5 would use existing SDK functions:
	// - populateProvedUnshield() to format transaction
	// - provider.sendTransaction() to execute
}

/**
 * Key insight: The hard part is Step 3
 *
 * We have all the data needed for the ZK proof (privateInputs, publicInputs),
 * but the SDK's proof generation is tightly coupled to its merkletree.
 *
 * Solutions:
 * 1. Populate SDK's merkletree with API data before calling prover
 * 2. Extract and call snarkjs directly, bypassing SDK's prover wrapper
 * 3. Modify SDK's prover to accept pre-built inputs
 *
 * Option 1 is probably simplest for MVP.
 */
