/**
 * Wallet UTXO Injection Utility
 *
 * Allows direct injection of UTXOs from B402 API into Railgun SDK wallet database,
 * bypassing slow blockchain scanning for true API-first operation.
 */
import type { Chain } from '@railgun-community/engine/dist/models/engine-types'
import type { StoredReceiveCommitment } from '@railgun-community/engine/dist/models/formatted-types'
import { TXIDVersion } from '@railgun-community/engine/dist/models/poi-types'
import { getEngine } from '@railgun-community/wallet'
import msgpack from 'msgpack-lite'

import type { SpendableUTXO } from './unshield-api'

/**
 * Injects UTXOs from API into SDK wallet database
 *
 * This allows the wallet to "see" UTXOs without blockchain scanning.
 * Critical for API-first unshield operations.
 */
export async function injectUTXOsIntoWallet(
	walletId: string,
	chain: Chain,
	utxos: SpendableUTXO[]
): Promise<void> {
	if (utxos.length === 0) {
		console.log('[Injection] No UTXOs to inject')
		return
	}

	console.log(`[Injection] Injecting ${utxos.length} UTXOs into wallet database...`)

	const engine = getEngine()
	const db = engine.db

	// Import required utilities
	const { ByteUtils, ByteLength, fromUTF8String } =
		await import('@railgun-community/engine/dist/utils/bytes')
	const { getChainFullNetworkID } = await import('@railgun-community/engine/dist/chain/chain')

	const writeBatch: Array<{ type: string; key: string; value: Uint8Array }> = []

	for (const { txo } of utxos) {
		// Construct DB path matching SDK's format exactly
		// This MUST match getWalletReceiveCommitmentDBPrefix() from abstract-wallet.ts
		// Each element must be formatted to 32 bytes (UINT_256)
		const dbPath = [
			fromUTF8String('wallet'),
			ByteUtils.hexlify(walletId),
			getChainFullNetworkID(chain),
			ByteUtils.hexlify(ByteUtils.nToBytes(BigInt(txo.tree), ByteLength.UINT_256)),
			ByteUtils.hexlify(ByteUtils.nToBytes(BigInt(txo.position), ByteLength.UINT_256))
		].map((el) => ByteUtils.formatToByteLength(el, ByteLength.UINT_256))

		// Serialize the note (convert TransactNote to storable format)
		const serializedNote = txo.note.serialize()

		// Import POI types
		const { TXOPOIListStatus } = await import('@railgun-community/engine/dist/models/poi-types')
		const { POI } = await import('@railgun-community/engine/dist/poi/poi')

		// Get active POI list keys
		const activeListKeys = POI.getActiveListKeys()

		// Create POIs with Valid status for all active lists
		// This marks the shields as having valid proofs of innocence
		const poisPerList: Record<string, (typeof TXOPOIListStatus)[keyof typeof TXOPOIListStatus]> = {}
		for (const listKey of activeListKeys) {
			poisPerList[listKey] = TXOPOIListStatus.Valid
		}

		// Create StoredReceiveCommitment matching SDK's structure
		const storedCommitment: StoredReceiveCommitment = {
			txidVersion: TXIDVersion.V2_PoseidonMerkle,
			spendtxid: txo.spendtxid,
			txid: txo.txid || '',
			timestamp: txo.timestamp,
			nullifier: txo.nullifier,
			blockNumber: txo.blockNumber,
			decrypted: serializedNote,
			senderAddress: undefined,
			commitmentType: txo.commitmentType,
			poisPerList: poisPerList,
			blindedCommitment: txo.blindedCommitment,
			transactCreationRailgunTxid: txo.transactCreationRailgunTxid
		}

		const dbKey = dbPath.join(':')

		console.log(`[Injection] Adding UTXO at position ${txo.position} (tree ${txo.tree})`)
		console.log(`  Nullifier: ${txo.nullifier}`)
		console.log(`  Value: ${txo.note.value.toString()}`)
		console.log(`  DB Key: ${dbKey}`)

		// Add to batch write
		writeBatch.push({
			type: 'put',
			key: dbKey,
			value: msgpack.encode(storedCommitment)
		})
	}

	// Execute batch write
	console.log(`[Injection] Writing ${writeBatch.length} commitments to database...`)
	await db.batch(writeBatch)

	// CRITICAL: Invalidate wallet cache to force reload from database
	// The invalidateCommitmentsCache method is protected, so we use type casting
	const wallets = engine.wallets
	const wallet = wallets[walletId]

	if (!wallet) {
		throw new Error(`Wallet ${walletId} not found in engine`)
	}

	console.log('[Injection] Invalidating wallet cache...')
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	;(wallet as any).invalidateCommitmentsCache(chain)

	console.log('[Injection] ✅ Successfully injected UTXOs into wallet database')
}
