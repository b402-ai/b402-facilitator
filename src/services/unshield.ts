/**
 * Unshield Service
 *
 * Generates ZK proofs and unsigned transactions for unshielding Railgun tokens.
 * This runs in pure Node.js for fast WASM execution.
 */

import { deriveNodes } from '@railgun-community/engine/dist/key-derivation/wallet-node'
import { TXIDVersion } from '@railgun-community/engine/dist/models/poi-types'
import { ethers, Mnemonic } from 'ethers'

import { buildUnshieldProofInputs } from '../../scripts/railgun-core/proof/inputs-builder'
import { generateProofManually } from '../../scripts/railgun-core/proof/prover'
import {
	encodeUnshieldTransaction,
	formatUnshieldTransaction
} from '../../scripts/railgun-core/transaction/formatter'
import { fetchSpendableUTXOsFromSignature } from '../../scripts/utils/unshield-api'
import {
	calculateInclusiveFee,
	fetchUnshieldFee
} from '../../scripts/utils/railgun-fees'

export const B402_RESERVED_ZK_MESSAGE = 'b402 Reserved Railgun zk-Address'

const BSC_RPC_URL = process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org'
const RAILGUN_CONTRACT_ADDRESS = '0x590162bf4b50F6576a459B75309eE21D92178A10'
const BSC_CHAIN = { type: 0, id: 56 }
const FACILITATOR_API_URL = process.env.API_URL || 'http://localhost:3002'

export interface UnshieldRequest {
	signature: string
	amount: string
	tokenAddress: string
	recipientAddress: string
}

export interface UnshieldResponse {
	success: boolean
	/**
	 * Back-compat single transaction (first tx). Prefer `transactions`.
	 */
	transaction?: {
		to: string
		data: string
		value: string
		gasLimit: string
		gasPrice: string
	}
	/**
	 * Multi-tx response: send these sequentially until target receive amount is reached.
	 */
	transactions?: Array<{
		to: string
		data: string
		value: string
		gasLimit: string
		gasPrice: string
	}>
	nullifiers?: string[]
	/**
	 * Back-compat amounts for the first tx. Prefer totals below.
	 */
	unshieldAmount?: string
	receiveAmount?: string
	contractFee?: string
	/**
	 * Totals across all returned transactions.
	 */
	totalUnshieldAmount?: string
	totalReceiveAmount?: string
	totalContractFee?: string
	error?: string
}

function deriveMnemonicFromSignature(signature: string): string {
	const entropy = ethers.keccak256(signature).slice(0, 34)
	const mnemonic = Mnemonic.fromEntropy(entropy)
	return mnemonic.phrase
}

export async function generateUnshieldTransaction(
	request: UnshieldRequest
): Promise<UnshieldResponse> {
	const { signature, amount, tokenAddress, recipientAddress } = request

	try {
		// Verify signature and recover address
		const signerAddress = ethers.verifyMessage(B402_RESERVED_ZK_MESSAGE, signature)
		console.log('[Unshield Service] Signer address:', signerAddress)

		// Derive keys from signature
		const mnemonic = deriveMnemonicFromSignature(signature)
		const walletNodes = deriveNodes(mnemonic, 0)
		const nullifyingKey = await walletNodes.viewing.getNullifyingKey()
		const spendingKeyPair = walletNodes.spending.getSpendingKeyPair()
		console.log('[Unshield Service] Derived keys from signature')

		// Parse amount
		const amountWei = BigInt(amount)
		console.log('[Unshield Service] Amount:', ethers.formatUnits(amountWei, 18))

		// Fetch unshield fee
		const unshieldFee = await fetchUnshieldFee(BSC_RPC_URL, RAILGUN_CONTRACT_ADDRESS)
		console.log(`[Unshield Service] Unshield fee: ${(Number(unshieldFee) / 100).toFixed(2)}%`)

		// Fetch spendable UTXOs
		console.log('[Unshield Service] Fetching spendable UTXOs...')
		const { spendableUTXOs, totalCommitments, spendableCount } = await fetchSpendableUTXOsFromSignature(
			FACILITATOR_API_URL,
			signature,
			signerAddress,
			BSC_CHAIN,
			tokenAddress
		)

		console.log(`[Unshield Service] Total commitments: ${totalCommitments}`)
		console.log(`[Unshield Service] Spendable: ${spendableCount}`)
		console.log(`[Unshield Service] For token ${tokenAddress}: ${spendableUTXOs.length}`)

		if (spendableUTXOs.length === 0) {
			return {
				success: false,
				error: 'No spendable UTXOs found for this token'
			}
		}

		// Calculate total available after fees
		const totalAvailableRaw = spendableUTXOs.reduce((sum: bigint, utxo) => {
			return sum + utxo.txo.note.value
		}, 0n)
		const totalAvailableAfterFees = calculateInclusiveFee(totalAvailableRaw, unshieldFee).base

		console.log(`[Unshield Service] Total available (raw): ${ethers.formatUnits(totalAvailableRaw, 18)}`)
		console.log(`[Unshield Service] Total available (after fee): ${ethers.formatUnits(totalAvailableAfterFees, 18)}`)

		if (totalAvailableAfterFees < amountWei) {
			return {
				success: false,
				error: `Insufficient balance after fees: need ${ethers.formatUnits(amountWei, 18)}, have ${ethers.formatUnits(totalAvailableAfterFees, 18)}`
			}
		}

		// Select enough UTXOs to reach target receive amount (after fee).
		const selectedUTXOs: typeof spendableUTXOs = []
		let runningReceiveTotal = 0n
		for (const utxo of spendableUTXOs) {
			if (runningReceiveTotal >= amountWei) break
			const { base: receive } = calculateInclusiveFee(utxo.txo.note.value, unshieldFee)
			selectedUTXOs.push(utxo)
			runningReceiveTotal += receive
		}

		if (selectedUTXOs.length === 0) {
			return { success: false, error: 'No spendable UTXOs selected' }
		}

		console.log(
			`[Unshield Service] Will unshield ${selectedUTXOs.length} UTXO(s) to reach target receive amount`
		)

		// Get gas estimate once (BSC type0).
		const provider = new ethers.JsonRpcProvider(BSC_RPC_URL)
		const feeData = await provider.getFeeData()
		const gasPrice = feeData.gasPrice || BigInt(3000000000)
		const estimatedGas = BigInt(500000)

		const transactions: NonNullable<UnshieldResponse['transactions']> = []
		const nullifiers: string[] = []

		let totalUnshieldAmount = 0n
		let totalReceiveAmount = 0n
		let totalContractFee = 0n

		for (let i = 0; i < selectedUTXOs.length; i++) {
			const selectedUTXO = selectedUTXOs[i]

			// For the circuit: unshieldAmount is the FULL UTXO value being unshielded.
			// The smart contract applies the fee.
			const unshieldAmount = selectedUTXO.txo.note.value
			const { base: actualReceiveAmount, fee: contractFee } = calculateInclusiveFee(
				unshieldAmount,
				unshieldFee
			)

			console.log(
				`[Unshield Service] UTXO ${i + 1}/${selectedUTXOs.length} position=${selectedUTXO.txo.position} unshield=${ethers.formatUnits(unshieldAmount, 18)} receive=${ethers.formatUnits(actualReceiveAmount, 18)}`
			)

			// Build proof inputs
			console.log('[Unshield Service] Building proof inputs...')
			const { privateInputs, publicInputs } = buildUnshieldProofInputs({
				utxo: selectedUTXO.txo,
				merkleProof: selectedUTXO.merkleProof,
				nullifyingKey,
				spendingKeyPair,
				unshieldAmount,
				unshieldToAddress: recipientAddress,
				tokenAddress
			})

			// Generate proof
			console.log('[Unshield Service] Generating ZK proof...')
			const proofStartTime = Date.now()

			const proof = await generateProofManually({
				privateInputs,
				publicInputs,
				chain: BSC_CHAIN,
				txidVersion: TXIDVersion.V2_PoseidonMerkle,
				unshieldToAddress: recipientAddress,
				treeNumber: selectedUTXO.txo.tree,
				tokenAddress,
				unshieldAmount,
				spendingPrivateKey: spendingKeyPair.privateKey
			})

			const proofTime = ((Date.now() - proofStartTime) / 1000).toFixed(2)
			console.log(`[Unshield Service] Proof generated in ${proofTime}s`)

			// Format transaction
			const transactionStruct = formatUnshieldTransaction({
				proof,
				treeNumber: selectedUTXO.txo.tree,
				tokenAddress,
				recipientAddress,
				unshieldAmount,
				chain: BSC_CHAIN
			})

			const encodedTx = encodeUnshieldTransaction(transactionStruct, RAILGUN_CONTRACT_ADDRESS)

			transactions.push({
				to: encodedTx.to,
				data: encodedTx.data,
				value: '0',
				gasLimit: estimatedGas.toString(),
				gasPrice: gasPrice.toString()
			})

			nullifiers.push(publicInputs.nullifiers[0].toString())

			totalUnshieldAmount += unshieldAmount
			totalReceiveAmount += actualReceiveAmount
			totalContractFee += contractFee

			if (totalReceiveAmount >= amountWei) break
		}

		const firstUnshieldAmount = selectedUTXOs[0].txo.note.value
		const firstFee = calculateInclusiveFee(firstUnshieldAmount, unshieldFee)

		return {
			success: true,
			transactions,
			// back-compat fields (first tx)
			transaction: transactions[0],
			nullifiers,
			unshieldAmount: firstUnshieldAmount.toString(),
			receiveAmount: firstFee.base.toString(),
			contractFee: firstFee.fee.toString(),
			totalUnshieldAmount: totalUnshieldAmount.toString(),
			totalReceiveAmount: totalReceiveAmount.toString(),
			totalContractFee: totalContractFee.toString()
		}
	} catch (error) {
		console.error('[Unshield Service] Error:', error)
		return {
			success: false,
			error: error instanceof Error ? error.message : 'Unknown error'
		}
	}
}
