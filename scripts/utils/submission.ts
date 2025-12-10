import type { Chain } from '@railgun-community/engine/dist/models/engine-types'
import type { TXIDVersion } from '@railgun-community/engine/dist/models/poi-types'
import type { PreTransactionPOIsPerTxidLeafPerList } from '@railgun-community/engine/dist/models/poi-types'
import { BroadcasterTransaction } from '@railgun-community/waku-broadcaster-client-node'
import type { ContractTransaction, Provider } from 'ethers'

export interface BroadcasterSubmissionConfig {
	txidVersion: TXIDVersion
	transaction: ContractTransaction
	broadcasterRailgunAddress: string
	broadcasterFeesID: string
	chain: Chain
	nullifiers: string[]
	overallBatchMinGasPrice: bigint
	useRelayAdapt: boolean
	preTransactionPOIsPerTxidLeafPerList: PreTransactionPOIsPerTxidLeafPerList
}

export interface EOASubmissionConfig {
	transaction: ContractTransaction
	eoaPrivateKey: string
	provider: Provider
}

export async function submitViaBroadcaster(config: BroadcasterSubmissionConfig): Promise<string> {
	if (!config.transaction.to || !config.transaction.data) {
		throw new Error('Invalid transaction: missing to or data')
	}

	if (!config.nullifiers || config.nullifiers.length === 0) {
		throw new Error('No nullifiers provided for broadcaster transaction')
	}

	const broadcasterTransaction = await BroadcasterTransaction.create(
		config.txidVersion,
		config.transaction.to,
		config.transaction.data,
		config.broadcasterRailgunAddress,
		config.broadcasterFeesID,
		config.chain,
		config.nullifiers,
		config.overallBatchMinGasPrice,
		config.useRelayAdapt,
		config.preTransactionPOIsPerTxidLeafPerList
	)

	return await broadcasterTransaction.send()
}

export async function submitViaEOA(config: EOASubmissionConfig): Promise<string> {
	const { ethers } = await import('ethers')
	const wallet = new ethers.Wallet(config.eoaPrivateKey, config.provider)
	const tx = await wallet.sendTransaction(config.transaction)
	return tx.hash
}

export async function waitForConfirmation(
	txHash: string,
	provider: Provider
): Promise<number | null> {
	const receipt = await provider.waitForTransaction(txHash)
	return receipt && receipt.blockNumber ? receipt.blockNumber : null
}
