/**
 * Balance computation helper for B402 privacy operations
 * Uses B402 Backend API + Railgun SDK crypto with recursive TRANSACT decryption
 */
import type { AddressData } from '@railgun-community/engine/dist/key-derivation/bech32'
import { deriveNodes } from '@railgun-community/engine/dist/key-derivation/wallet-node'
import type { ViewingKeyPair } from '@railgun-community/engine/dist/key-derivation/wallet-node'
import type { Chain } from '@railgun-community/engine/dist/models/engine-types'
import type { TokenData } from '@railgun-community/engine/dist/models/formatted-types'
import { TXIDVersion } from '@railgun-community/engine/dist/models/poi-types'
import { ShieldNote } from '@railgun-community/engine/dist/note/shield-note'
import { TransactNote } from '@railgun-community/engine/dist/note/transact-note'
import { getSharedSymmetricKey } from '@railgun-community/engine/dist/utils/keys-utils'
import { ethers } from 'ethers'

import type { OutputCommitment, ShieldCommitment } from './api'
import { fetchCommitmentsByEOA, fetchNullifierDataBatched } from './api'
import { deriveMnemonicFromEOA } from './railgun'

export interface TokenBalance {
	tokenAddress: string
	balance: bigint
	commitmentCount: number
	symbol?: string
	decimals?: number
}

export interface PrivacyBalanceResult {
	eoa: string
	railgunAddress: string
	totalCommitments: number
	spendableCommitments: number
	usedCommitments: number
	tokenBalances: TokenBalance[]
	summary: string
}

export interface GetBalanceConfig {
	eoaPrivateKey: string
	rpcUrl: string
	apiUrl: string
	tokenAddresses?: string[]
}

interface CommitmentInfo {
	commitmentHash: string
	position: string
	amount: string
	tokenAddress: string
	tokenType?: number
	tokenSubID?: string
	source: 'shield' | 'transact'
}

// Minimal TokenDataGetter implementation
class SimpleTokenDataGetter {
	async getTokenDataFromHash(_tokenHash: string, tokenAddress: string): Promise<TokenData> {
		// For our purposes, we can create a simple TokenData from the address
		return {
			tokenAddress: tokenAddress.toLowerCase(),
			tokenType: 0, // ERC20
			tokenSubID: '0x00'
		}
	}
}

/**
 * Verifies a shield commitment belongs to you by attempting to decrypt it
 * Returns true if the shield can be decrypted with your viewing key and NPK matches
 */
async function verifyShieldOwnership(
	shield: ShieldCommitment,
	viewingKeyPair: ViewingKeyPair,
	addressData: AddressData
): Promise<boolean> {
	try {
		// Compute shared key using shieldKey
		const shieldKeyBuffer = Buffer.from(shield.shieldKey.replace('0x', ''), 'hex')
		const sharedKey = await getSharedSymmetricKey(viewingKeyPair.privateKey, shieldKeyBuffer)

		if (!sharedKey) {
			return false
		}

		// Try to decrypt the random value
		const encryptedBundle: [string, string, string] = [
			shield.encryptedBundle0,
			shield.encryptedBundle1,
			shield.encryptedBundle2
		]

		const random = ShieldNote.decryptRandom(encryptedBundle, sharedKey)

		// Verify the NPK matches
		const computedNPK = ShieldNote.getNotePublicKey(addressData.masterPublicKey, random)
		const expectedNPK = BigInt(shield.npk)

		const matches = computedNPK === expectedNPK
		console.log(`  Computed NPK: 0x${computedNPK.toString(16)}`)
		console.log(`  Match: ${matches}`)

		return matches
	} catch (error) {
		// Decryption failed - not ours
		return false
	}
}

/**
 * Gets complete privacy balance with recursive TRANSACT output decryption
 */
export async function getPrivacyBalance(config: GetBalanceConfig): Promise<PrivacyBalanceResult> {
	const { eoaPrivateKey, rpcUrl, apiUrl, tokenAddresses } = config

	// Validate configuration
	if (!eoaPrivateKey || eoaPrivateKey === '') {
		throw new Error('EOA private key is required')
	}
	if (!apiUrl || apiUrl === '') {
		throw new Error('API URL is required')
	}

	const eoaWallet = new ethers.Wallet(eoaPrivateKey)
	const eoaAddress = eoaWallet.address

	console.log('Computing balance for EOA:', eoaAddress)

	// Step 1: Fetch initial shield commitments
	console.log('Fetching shield commitments from API...')
	const shields = await fetchCommitmentsByEOA(apiUrl, eoaAddress)
	console.log(`Found ${shields.length} shield commitments`)

	if (shields.length === 0) {
		return {
			eoa: eoaAddress,
			railgunAddress: '',
			totalCommitments: 0,
			spendableCommitments: 0,
			usedCommitments: 0,
			tokenBalances: [],
			summary: buildBalanceSummary([], 0, 0, 0)
		}
	}

	// Step 2: Derive wallet keys (match SDK wallet derivation)
	console.log('Deriving Railgun wallet keys...')
	const mnemonic = await deriveMnemonicFromEOA(eoaPrivateKey)
	console.log('Mnemonic (balance):', mnemonic)
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

	// Build AddressData using SDK's method
	const masterPublicKey = WalletNode.getMasterPublicKey(spendingKeyPair.pubkey, nullifyingKey)
	const addressData: AddressData = {
		masterPublicKey,
		viewingPublicKey: viewingKeyPair.pubkey
	}
	const railgunAddress = `0zk${masterPublicKey.toString(16).slice(0, 20)}...`
	console.log('masterPublicKey:', masterPublicKey.toString(16))
	console.log('railgunAddress:', railgunAddress)

	// Step 3: Verify shield ownership - filter out shields not belonging to this wallet
	console.log('\nVerifying shield ownership...')
	console.log('[DEBUG] Using masterPublicKey:', masterPublicKey.toString(16))
	const myShields: typeof shields = []
	for (const shield of shields) {
		const isOwner = await verifyShieldOwnership(shield, viewingKeyPair, addressData)

		// Debug: Show NPK verification details
		console.log(`[DEBUG] Shield ${shield.position}:`)
		console.log(`  Expected NPK: ${shield.npk}`)
		console.log(`  Verification result: ${isOwner}`)

		if (isOwner) {
			console.log(
				`✅ Shield at position ${shield.position} (npk: ${shield.npk.slice(0, 10)}...) belongs to b402 zkWallet`
			)
			myShields.push(shield)
		} else {
			console.log(
				`❌ Shield at position ${shield.position} (npk: ${shield.npk.slice(0, 10)}...) belongs to EOA but not to b402 zkWallet. This must've been created outside of the b402 app. Skipping.`
			)
		}
	}

	console.log(`\nVerified ${myShields.length} of ${shields.length} shields belong to you\n`)

	if (myShields.length === 0) {
		return {
			eoa: eoaAddress,
			railgunAddress,
			totalCommitments: 0,
			spendableCommitments: 0,
			usedCommitments: 0,
			tokenBalances: [],
			summary: buildBalanceSummary([], 0, 0, 0)
		}
	}

	// Step 4: Setup for recursive processing
	const commitmentQueue: CommitmentInfo[] = myShields.map((s) => ({
		commitmentHash: s.commitmentHash,
		position: s.position,
		amount: s.amount,
		tokenAddress: s.tokenAddress,
		tokenType: s.tokenType,
		tokenSubID: s.tokenSubID,
		source: 'shield' as const
	}))

	const processedNullifiers = new Set<string>()
	const allCommitments: Array<CommitmentInfo & { spent: boolean }> = []
	const tokenDataGetter = new SimpleTokenDataGetter()
	const chain: Chain = { type: 0, id: 56 } // BSC

	// Token filtering (applied at the end, not during processing)
	let targetTokens: Set<string> | null = null
	if (tokenAddresses && tokenAddresses.length > 0) {
		targetTokens = new Set(tokenAddresses.map((addr) => addr.toLowerCase()))
		console.log(`Filtering for tokens: ${Array.from(targetTokens).join(', ')}`)
	}

	console.log('Processing commitments recursively...')

	// Step 5: Recursive queue processing with batched API calls
	while (commitmentQueue.length > 0) {
		// Batch collect nullifiers from current queue
		const batchCommitments: Array<{ commitment: CommitmentInfo; nullifier: string }> = []

		for (const commitment of commitmentQueue) {
			const nullifier = `0x${TransactNote.getNullifier(
				nullifyingKey,
				Number.parseInt(commitment.position, 10)
			)
				.toString(16)
				.padStart(64, '0')}`

			console.log('nullifier: ', nullifier)

			// Skip if already processed
			if (processedNullifiers.has(nullifier.toLowerCase())) {
				continue
			}

			batchCommitments.push({ commitment, nullifier })
			processedNullifiers.add(nullifier.toLowerCase())
		}

		if (batchCommitments.length === 0) {
			break // All remaining commitments already processed
		}

		console.log(`  Checking ${batchCommitments.length} nullifiers...`)

		// Single batched API call
		const nullifiers = batchCommitments.map((b) => b.nullifier)
		const status = await fetchNullifierDataBatched(apiUrl, nullifiers)

		// Build lookup maps
		const unusedSet = new Set(status.unused.map((n) => n.toLowerCase()))
		const usedMap = new Map(status.used.map((u) => [u.nullifier.toLowerCase(), u]))

		// Process results
		for (const { commitment, nullifier } of batchCommitments) {
			const nullifierLower = nullifier.toLowerCase()

			if (unusedSet.has(nullifierLower)) {
				// Unspent commitment
				allCommitments.push({ ...commitment, spent: false })
			} else if (usedMap.has(nullifierLower)) {
				// Spent commitment
				const usedData = usedMap.get(nullifierLower)
				if (!usedData) continue

				allCommitments.push({ ...commitment, spent: true })

				// If TRANSACT, decrypt output commitments and add to queue
				// NOTE: We process ALL TRANSACTs regardless of token filter
				// Token filtering happens at the final balance calculation
				if (usedData.type === 'TRANSACT' && usedData.outputCommitments) {
					console.log(`  Decrypting ${usedData.outputCommitments.length} TRANSACT outputs...`)

					for (const output of usedData.outputCommitments) {
						try {
							const decrypted = await decryptOutputCommitment(
								output,
								viewingKeyPair,
								addressData,
								chain,
								tokenDataGetter
							)

							if (decrypted) {
								// Successfully decrypted - it's ours!
								commitmentQueue.push({
									commitmentHash: output.commitmentHash,
									position: output.position,
									amount: decrypted.amount.toString(),
									tokenAddress: decrypted.tokenAddress,
									source: 'transact'
								})
							}
						} catch (error) {
							// Decryption failed - not ours or error
							console.warn(`    Could not decrypt output ${output.commitmentHash.slice(0, 10)}...`)
						}
					}
				}
			} else {
				// Neither used nor unused - unexpected API response
				console.warn(`  Warning: Nullifier ${nullifier.slice(0, 10)}... not in API response`)
			}
		}

		// Clear processed commitments from queue
		commitmentQueue.splice(0, batchCommitments.length)

		console.log(`  Queue size: ${commitmentQueue.length}, Total found: ${allCommitments.length}`)
	}

	console.log(`Total commitments processed: ${allCommitments.length}`)
	console.log(`Spendable: ${allCommitments.filter((c) => !c.spent).length}`)

	// Step 6: Calculate balances per token (with token filtering if specified)
	const tokenBalanceMap = new Map<string, { balance: bigint; count: number }>()

	for (const commit of allCommitments) {
		if (!commit.spent) {
			const tokenAddress = commit.tokenAddress.toLowerCase()

			// Apply token filter here (after full recursion)
			if (targetTokens && !targetTokens.has(tokenAddress)) {
				continue
			}

			const amount = BigInt(commit.amount)

			const existing = tokenBalanceMap.get(tokenAddress) || { balance: 0n, count: 0 }
			tokenBalanceMap.set(tokenAddress, {
				balance: existing.balance + amount,
				count: existing.count + 1
			})
		}
	}

	// Step 7: Get token metadata
	const tokenBalances: TokenBalance[] = []

	for (const [tokenAddress, { balance, count }] of tokenBalanceMap.entries()) {
		let symbol: string | undefined
		let decimals: number | undefined

		if (rpcUrl && rpcUrl !== '') {
			try {
				const provider = new ethers.JsonRpcProvider(rpcUrl)
				const tokenContract = new ethers.Contract(
					tokenAddress,
					['function symbol() view returns (string)', 'function decimals() view returns (uint8)'],
					provider
				)
				symbol = await tokenContract.symbol()
				decimals = await tokenContract.decimals()

				console.log(`${symbol}: ${ethers.formatUnits(balance, decimals)} (${count} commitments)`)
			} catch (error) {
				decimals = 18
			}
		} else {
			decimals = 18
		}

		tokenBalances.push({
			tokenAddress,
			balance,
			commitmentCount: count,
			symbol,
			decimals
		})
	}

	// Step 8: Build summary
	const spendableCount = allCommitments.filter((c) => !c.spent).length
	const usedCount = allCommitments.length - spendableCount

	const summary = buildBalanceSummary(
		tokenBalances,
		allCommitments.length,
		spendableCount,
		usedCount
	)

	return {
		eoa: eoaAddress,
		railgunAddress,
		totalCommitments: allCommitments.length,
		spendableCommitments: spendableCount,
		usedCommitments: usedCount,
		tokenBalances,
		summary
	}
}

/**
 * Decrypts an output commitment from a TRANSACT
 */
async function decryptOutputCommitment(
	output: OutputCommitment,
	viewingKeyPair: ViewingKeyPair,
	addressData: AddressData,
	chain: Chain,
	tokenDataGetter: SimpleTokenDataGetter
): Promise<{ amount: bigint; tokenAddress: string } | null> {
	try {
		// Build ciphertext object from API data
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

		// Compute shared key using blindedReceiverViewingKey
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

		// Decrypt the note
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
			false, // isSentNote
			false, // isLegacyDecryption
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			tokenDataGetter as any,
			undefined, // blockNumber
			undefined // transactCommitmentBatchIndexV3
		)

		return {
			amount: decrypted.value,
			tokenAddress: decrypted.tokenData.tokenAddress
		}
	} catch (error) {
		// Decryption failed - not ours
		return null
	}
}

/**
 * Builds a formatted summary of balances
 */
function buildBalanceSummary(
	tokenBalances: TokenBalance[],
	totalCommitments: number,
	spendableCommitments: number,
	usedCommitments: number
): string {
	const lines: string[] = []

	lines.push('=== PRIVACY BALANCE SUMMARY ===')
	lines.push(`Total Commitments: ${totalCommitments}`)
	lines.push(`Spendable: ${spendableCommitments}`)
	lines.push(`Used: ${usedCommitments}`)
	lines.push('')

	if (tokenBalances.length === 0) {
		lines.push('No spendable balance')
	} else {
		lines.push('Token Balances:')

		for (const balance of tokenBalances) {
			const symbol = balance.symbol || `${balance.tokenAddress.slice(0, 10)}...`
			const decimals = balance.decimals || 18
			const formatted = ethers.formatUnits(balance.balance, decimals)

			lines.push(`  ${symbol}: ${formatted} (${balance.commitmentCount} commitments)`)
		}
	}

	lines.push('===============================')

	return lines.join('\n')
}
