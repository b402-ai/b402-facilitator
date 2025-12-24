import type { AddressData } from '@railgun-community/engine/dist/key-derivation/bech32'
import { deriveNodes } from '@railgun-community/engine/dist/key-derivation/wallet-node'
import type { ViewingKeyPair } from '@railgun-community/engine/dist/key-derivation/wallet-node'
import type { Chain } from '@railgun-community/engine/dist/models/engine-types'
import { CommitmentType } from '@railgun-community/engine/dist/models/formatted-types'
import { TXIDVersion } from '@railgun-community/engine/dist/models/poi-types'
import type { TXO } from '@railgun-community/engine/dist/models/txo-types'
import { TransactNote } from '@railgun-community/engine/dist/note/transact-note'
import { getSharedSymmetricKey } from '@railgun-community/engine/dist/utils/keys-utils'

import {
	type MerkleProofResponse,
	type OutputCommitment,
	type ShieldCommitment,
	fetchCommitmentsByEOA,
	fetchMerkleProofsBatch,
	fetchNullifierDataBatched
} from './api'
import { deriveMnemonicFromEOA } from './railgun'
import { computeNullifier } from './transaction-builder'

interface TokenDataGetter {
	getTokenDataFromHash: (tokenHash: string) => Promise<{
		tokenAddress: string
		tokenType: number
		tokenSubID: string
	}>
}

export interface SpendableUTXO {
	txo: TXO
	merkleProof: MerkleProofResponse
}

export interface FetchUTXOsResult {
	spendableUTXOs: SpendableUTXO[]
	totalCommitments: number
	spendableCount: number
}

async function decryptShieldCommitment(
	commitment: ShieldCommitment,
	viewingKeyPair: ViewingKeyPair,
	addressData: AddressData,
	chain: Chain
): Promise<TransactNote | null> {
	try {
		// Shield commitments have plaintext value/token data in the event logs
		// Only the random value is encrypted for privacy
		// We just need to verify we can decrypt the random to confirm ownership

		const shieldKeyBuffer = Buffer.from(commitment.shieldKey.replace('0x', ''), 'hex')
		const sharedKey = await getSharedSymmetricKey(viewingKeyPair.privateKey, shieldKeyBuffer)
		if (!sharedKey) {
			return null
		}

		// Import ShieldNote for decryption
		const { ShieldNote } = await import('@railgun-community/engine/dist/note/shield-note')

		// Decrypt the random value to verify ownership
		const encryptedBundle: [string, string, string] = [
			commitment.encryptedBundle0,
			commitment.encryptedBundle1,
			commitment.encryptedBundle2
		]
		const random = ShieldNote.decryptRandom(encryptedBundle, sharedKey)

		// Verify NPK matches
		const computedNPK = ShieldNote.getNotePublicKey(addressData.masterPublicKey, random)
		const expectedNPK = BigInt(commitment.npk)
		if (computedNPK !== expectedNPK) {
			return null
		}

		// Construct TransactNote from plaintext shield data using deserialize
		const { encodeAddress } = await import('@railgun-community/engine/dist/key-derivation/bech32')
		const { getTokenDataHash } = await import('@railgun-community/engine/dist/note/note-util')
		const recipientAddress = encodeAddress(addressData)

		// Get token hash
		const tokenHash = getTokenDataHash({
			tokenAddress: commitment.tokenAddress,
			tokenType: Number.parseInt(commitment.tokenType.toString()),
			tokenSubID: commitment.tokenSubID
		})

		const noteSerialized = {
			recipientAddress,
			random,
			value: `0x${BigInt(commitment.amount).toString(16)}`,
			tokenHash: `0x${tokenHash.toString(16)}`,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			outputType: 0 as any,
			walletSource: undefined,
			senderAddress: undefined,
			senderRandom: undefined,
			memoText: undefined,
			shieldFee: undefined,
			blockNumber: undefined
		}

		const note = await TransactNote.deserialize(
			TXIDVersion.V2_PoseidonMerkle,
			chain,
			noteSerialized,
			viewingKeyPair.privateKey,
			{
				getTokenDataFromHash: async () => ({
					tokenAddress: commitment.tokenAddress,
					tokenType: Number.parseInt(commitment.tokenType.toString()),
					tokenSubID: commitment.tokenSubID
				})
			} as TokenDataGetter
		)

		return note
	} catch (error) {
		return null
	}
}

async function decryptTransactCommitment(
	output: OutputCommitment,
	viewingKeyPair: ViewingKeyPair,
	addressData: AddressData,
	chain: Chain
): Promise<{ note: TransactNote; tokenAddress: string } | null> {
	try {
		const ciphertext = {
			ciphertext: [
				output.ciphertext.ciphertext0,
				output.ciphertext.ciphertext1,
				output.ciphertext.ciphertext2,
				output.ciphertext.ciphertext3
			],
			ephemeralKeys: [
				output.ciphertext.blindedSenderViewingKey,
				output.ciphertext.blindedReceiverViewingKey
			],
			memo: []
		}

		const blindedReceiverViewingKey = Buffer.from(
			output.ciphertext.blindedReceiverViewingKey.replace('0x', ''),
			'hex'
		)
		const sharedKey = await getSharedSymmetricKey(
			viewingKeyPair.privateKey,
			blindedReceiverViewingKey
		)
		if (!sharedKey) {
			return null
		}

		const blindedSenderViewingKey = Buffer.from(
			output.ciphertext.blindedSenderViewingKey.replace('0x', ''),
			'hex'
		)

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const decrypted = await TransactNote.decrypt(
			TXIDVersion.V2_PoseidonMerkle,
			chain,
			addressData,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			ciphertext as any,
			sharedKey,
			output.ciphertext.memo || '',
			output.ciphertext.annotationData || '',
			viewingKeyPair.privateKey,
			blindedReceiverViewingKey,
			blindedSenderViewingKey,
			false,
			false,
			{
				getTokenDataFromHash: async () => ({ tokenAddress: '', tokenType: 0, tokenSubID: '0x00' })
			} as TokenDataGetter,
			undefined,
			undefined
		)

		return {
			note: decrypted,
			tokenAddress: decrypted.tokenData.tokenAddress
		}
	} catch {
		return null
	}
}

/**
 * Signature-based spendable UTXO discovery.
 *
 * Used by the facilitator API so the client never has to send an EOA private key.
 * The signature is expected to be for `B402_RESERVED_ZK_MESSAGE`.
 */
export async function fetchSpendableUTXOsFromSignature(
	apiUrl: string,
	signature: string,
	signerAddress: string,
	chain: Chain,
	tokenAddress?: string
): Promise<FetchUTXOsResult> {
	const shields = await fetchCommitmentsByEOA(apiUrl, signerAddress)
	if (shields.length === 0) {
		return { spendableUTXOs: [], totalCommitments: 0, spendableCount: 0 }
	}

	const { ethers, Mnemonic } = await import('ethers')
	const entropy = ethers.keccak256(signature).slice(0, 34)
	const mnemonic = Mnemonic.fromEntropy(entropy).phrase

	const walletNodes = deriveNodes(mnemonic, 0)
	const viewingKeyPair = await walletNodes.viewing.getViewingKeyPair()
	const spendingKeyPair = walletNodes.spending.getSpendingKeyPair()

	// Compute nullifying key from viewing node's private key (same as SDK wallet)
	const { poseidonHex } = await import('@railgun-community/engine/dist/utils/poseidon')
	const { ByteUtils } = await import('@railgun-community/engine/dist/utils/bytes')
	const { WalletNode } = await import('@railgun-community/engine/dist/key-derivation/wallet-node')

	const nullifyingKey = ByteUtils.hexToBigInt(
		poseidonHex([ByteUtils.fastBytesToHex(viewingKeyPair.privateKey)])
	)

	// Build master public key using SDK's method
	const masterPublicKey = WalletNode.getMasterPublicKey(spendingKeyPair.pubkey, nullifyingKey)

	const addressData: AddressData = {
		masterPublicKey,
		viewingPublicKey: viewingKeyPair.pubkey
	}

	const allCommitments: Array<{
		commitmentHash: string
		treeNumber: string
		position: string
		tokenAddress: string
		note: TransactNote
		source: 'shield' | 'transact'
	}> = []

	const processedNullifiers = new Set<string>()

	const queue: Array<{
		commitmentHash: string
		treeNumber: string
		position: string
		tokenAddress: string
		source: 'shield' | 'transact'
		shieldData?: ShieldCommitment
		transactData?: OutputCommitment
	}> = shields.map((s) => ({
		commitmentHash: s.commitmentHash,
		treeNumber: s.treeNumber,
		position: s.position,
		tokenAddress: s.tokenAddress,
		source: 'shield' as const,
		shieldData: s
	}))

	while (queue.length > 0) {
		const batch = queue.splice(0, Math.min(queue.length, 100))

		const batchWithNullifiers: Array<{
			commitment: (typeof batch)[0]
			nullifier: string
		}> = []

		for (const commitment of batch) {
			const position = Number.parseInt(commitment.position, 10)
			const nullifier = computeNullifier(nullifyingKey, position)

			if (processedNullifiers.has(nullifier.toLowerCase())) {
				continue
			}

			batchWithNullifiers.push({ commitment, nullifier })
			processedNullifiers.add(nullifier.toLowerCase())
		}

		if (batchWithNullifiers.length === 0) {
			continue
		}

		const nullifiers = batchWithNullifiers.map((b) => b.nullifier)
		const nullifierStatus = await fetchNullifierDataBatched(apiUrl, nullifiers)

		const unusedSet = new Set(nullifierStatus.unused.map((n) => n.toLowerCase()))
		const usedMap = new Map(nullifierStatus.used.map((u) => [u.nullifier.toLowerCase(), u]))

		for (const { commitment, nullifier } of batchWithNullifiers) {
			const nullifierLower = nullifier.toLowerCase()

			let decryptedNote: TransactNote | null = null

			if (commitment.source === 'shield' && commitment.shieldData) {
				decryptedNote = await decryptShieldCommitment(
					commitment.shieldData,
					viewingKeyPair,
					addressData,
					chain
				)
			} else if (commitment.source === 'transact' && commitment.transactData) {
				const result = await decryptTransactCommitment(
					commitment.transactData,
					viewingKeyPair,
					addressData,
					chain
				)
				if (result) {
					decryptedNote = result.note
					commitment.tokenAddress = result.tokenAddress
				}
			}

			if (!decryptedNote) {
				continue
			}

			if (unusedSet.has(nullifierLower)) {
				if (tokenAddress && commitment.tokenAddress.toLowerCase() !== tokenAddress.toLowerCase()) {
					continue
				}

				allCommitments.push({
					commitmentHash: commitment.commitmentHash,
					treeNumber: commitment.treeNumber,
					position: commitment.position,
					tokenAddress: commitment.tokenAddress,
					note: decryptedNote,
					source: commitment.source
				})
			} else if (usedMap.has(nullifierLower)) {
				const usedData = usedMap.get(nullifierLower)
				if (usedData && usedData.type === 'TRANSACT' && usedData.outputCommitments) {
					for (const output of usedData.outputCommitments) {
						queue.push({
							commitmentHash: output.commitmentHash,
							treeNumber: commitment.treeNumber,
							position: output.position,
							tokenAddress: '',
							source: 'transact',
							transactData: output
						})
					}
				}
			}
		}
	}

	if (allCommitments.length === 0) {
		return {
			spendableUTXOs: [],
			totalCommitments: shields.length,
			spendableCount: 0
		}
	}

	const merkleProofs = await fetchMerkleProofsBatch(
		apiUrl,
		allCommitments.map((c) => ({
			commitmentHash: c.commitmentHash,
			treeNumber: c.treeNumber,
			position: c.position
		}))
	)

	const spendableUTXOs: SpendableUTXO[] = await Promise.all(
		allCommitments.map(async (commitment, index) => {
			const txo: TXO = {
				tree: Number.parseInt(commitment.treeNumber, 10),
				position: Number.parseInt(commitment.position, 10),
				txid: '',
				timestamp: undefined,
				blockNumber: 0,
				spendtxid: false,
				nullifier: computeNullifier(nullifyingKey, Number.parseInt(commitment.position, 10)),
				note: commitment.note,
				poisPerList: undefined,
				blindedCommitment: commitment.commitmentHash,
				commitmentType: CommitmentType.ShieldCommitment,
				transactCreationRailgunTxid: undefined
			}

			return {
				txo,
				merkleProof: merkleProofs[index]
			}
		})
	)

	return {
		spendableUTXOs,
		totalCommitments: shields.length,
		spendableCount: allCommitments.length
	}
}

export async function fetchSpendableUTXOs(
	apiUrl: string,
	eoaPrivateKey: string,
	chain: Chain,
	tokenAddress?: string
): Promise<FetchUTXOsResult> {
	const { ethers } = await import('ethers')
	const eoaWallet = new ethers.Wallet(eoaPrivateKey)
	const eoaAddress = eoaWallet.address

	const shields = await fetchCommitmentsByEOA(apiUrl, eoaAddress)
	if (shields.length === 0) {
		return { spendableUTXOs: [], totalCommitments: 0, spendableCount: 0 }
	}

	const mnemonic = await deriveMnemonicFromEOA(eoaPrivateKey)
	const walletNodes = deriveNodes(mnemonic, 0)
	const viewingKeyPair = await walletNodes.viewing.getViewingKeyPair()
	const spendingKeyPair = walletNodes.spending.getSpendingKeyPair()

	// Compute nullifying key from viewing node's private key (same as SDK wallet)
	const { poseidonHex } = await import('@railgun-community/engine/dist/utils/poseidon')
	const { ByteUtils } = await import('@railgun-community/engine/dist/utils/bytes')
	const { WalletNode } = await import('@railgun-community/engine/dist/key-derivation/wallet-node')

	const nullifyingKey = ByteUtils.hexToBigInt(
		poseidonHex([ByteUtils.fastBytesToHex(viewingKeyPair.privateKey)])
	)

	// Build master public key using SDK's method
	const masterPublicKey = WalletNode.getMasterPublicKey(spendingKeyPair.pubkey, nullifyingKey)

	const addressData: AddressData = {
		masterPublicKey,
		viewingPublicKey: viewingKeyPair.pubkey
	}

	const allCommitments: Array<{
		commitmentHash: string
		treeNumber: string
		position: string
		tokenAddress: string
		note: TransactNote
		source: 'shield' | 'transact'
	}> = []

	const processedNullifiers = new Set<string>()

	const queue: Array<{
		commitmentHash: string
		treeNumber: string
		position: string
		tokenAddress: string
		source: 'shield' | 'transact'
		shieldData?: ShieldCommitment
		transactData?: OutputCommitment
	}> = shields.map((s) => ({
		commitmentHash: s.commitmentHash,
		treeNumber: s.treeNumber,
		position: s.position,
		tokenAddress: s.tokenAddress,
		source: 'shield' as const,
		shieldData: s
	}))

	while (queue.length > 0) {
		const batch = queue.splice(0, Math.min(queue.length, 100))

		const batchWithNullifiers: Array<{
			commitment: (typeof batch)[0]
			nullifier: string
		}> = []

		for (const commitment of batch) {
			const position = Number.parseInt(commitment.position, 10)
			const nullifier = computeNullifier(nullifyingKey, position)

			if (processedNullifiers.has(nullifier.toLowerCase())) {
				continue
			}

			batchWithNullifiers.push({ commitment, nullifier })
			processedNullifiers.add(nullifier.toLowerCase())
		}

		if (batchWithNullifiers.length === 0) {
			continue
		}

		const nullifiers = batchWithNullifiers.map((b) => b.nullifier)
		const nullifierStatus = await fetchNullifierDataBatched(apiUrl, nullifiers)

		const unusedSet = new Set(nullifierStatus.unused.map((n) => n.toLowerCase()))
		const usedMap = new Map(nullifierStatus.used.map((u) => [u.nullifier.toLowerCase(), u]))

		for (const { commitment, nullifier } of batchWithNullifiers) {
			const nullifierLower = nullifier.toLowerCase()

			let decryptedNote: TransactNote | null = null

			if (commitment.source === 'shield' && commitment.shieldData) {
				decryptedNote = await decryptShieldCommitment(
					commitment.shieldData,
					viewingKeyPair,
					addressData,
					chain
				)
			} else if (commitment.source === 'transact' && commitment.transactData) {
				const result = await decryptTransactCommitment(
					commitment.transactData,
					viewingKeyPair,
					addressData,
					chain
				)
				if (result) {
					decryptedNote = result.note
					commitment.tokenAddress = result.tokenAddress
				}
			}

			if (!decryptedNote) {
				continue
			}

			if (unusedSet.has(nullifierLower)) {
				if (tokenAddress && commitment.tokenAddress.toLowerCase() !== tokenAddress.toLowerCase()) {
					continue
				}

				allCommitments.push({
					commitmentHash: commitment.commitmentHash,
					treeNumber: commitment.treeNumber,
					position: commitment.position,
					tokenAddress: commitment.tokenAddress,
					note: decryptedNote,
					source: commitment.source
				})
			} else if (usedMap.has(nullifierLower)) {
				const usedData = usedMap.get(nullifierLower)
				if (usedData && usedData.type === 'TRANSACT' && usedData.outputCommitments) {
					for (const output of usedData.outputCommitments) {
						queue.push({
							commitmentHash: output.commitmentHash,
							treeNumber: commitment.treeNumber,
							position: output.position,
							tokenAddress: '',
							source: 'transact',
							transactData: output
						})
					}
				}
			}
		}
	}

	if (allCommitments.length > 0) {
		const merkleProofs = await fetchMerkleProofsBatch(
			apiUrl,
			allCommitments.map((c) => ({
				commitmentHash: c.commitmentHash,
				treeNumber: c.treeNumber,
				position: c.position
			}))
		)

		const spendableUTXOs: SpendableUTXO[] = allCommitments.map((commitment, index) => {
			const txo: TXO = {
				tree: Number.parseInt(commitment.treeNumber, 10),
				position: Number.parseInt(commitment.position, 10),
				txid: '',
				timestamp: undefined,
				blockNumber: 0,
				spendtxid: false,
				nullifier: computeNullifier(nullifyingKey, Number.parseInt(commitment.position, 10)),
				note: commitment.note,
				poisPerList: undefined,
				blindedCommitment: commitment.commitmentHash,
				commitmentType: CommitmentType.ShieldCommitment,
				transactCreationRailgunTxid: undefined
			}

			return {
				txo,
				merkleProof: merkleProofs[index]
			}
		})

		return {
			spendableUTXOs,
			totalCommitments: shields.length,
			spendableCount: allCommitments.length
		}
	}

	return {
		spendableUTXOs: [],
		totalCommitments: shields.length,
		spendableCount: 0
	}
}
