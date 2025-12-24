/**
 * Railgun Contract Fee Utilities
 *
 * Handles fee calculations matching Railgun smart contract logic.
 * Fees are deducted at the contract level when unshielding.
 */
import { ethers } from 'ethers'

const BASIS_POINTS = 10000n

/**
 * Railgun contract ABI for fee-related functions
 */
const RAILGUN_LOGIC_ABI = [
	'function unshieldFee() view returns (uint120)',
	'function shieldFee() view returns (uint120)',
	'function treasury() view returns (address)'
]

/**
 * Fetch current unshield fee from Railgun contract
 *
 * @param rpcUrl - RPC URL for the chain
 * @param railgunContractAddress - Railgun contract address
 * @returns Fee in basis points (e.g., 25 = 0.25%)
 */
export async function fetchUnshieldFee(
	rpcUrl: string,
	railgunContractAddress: string
): Promise<bigint> {
	const provider = new ethers.JsonRpcProvider(rpcUrl)
	const contract = new ethers.Contract(railgunContractAddress, RAILGUN_LOGIC_ABI, provider)

	const unshieldFee = await contract.unshieldFee()
	return BigInt(unshieldFee.toString())
}

/**
 * Calculate base and fee amounts using Railgun's inclusive fee logic
 *
 * Matches RailgunLogic.sol::getFee() with _isInclusive = true
 *
 * Formula:
 * - base = amount - (amount * feeBP) / BASIS_POINTS
 * - fee = amount - base
 *
 * @param amount - Total unshield amount (including fee)
 * @param feeBP - Fee in basis points (e.g., 25 = 0.25%)
 * @returns { base: amount to recipient, fee: amount to treasury }
 */
export function calculateInclusiveFee(
	amount: bigint,
	feeBP: bigint
): {
	base: bigint
	fee: bigint
} {
	// base = amount - (amount * feeBP) / BASIS_POINTS
	const base = amount - (amount * feeBP) / BASIS_POINTS
	const fee = amount - base

	return { base, fee }
}

/**
 * Calculate required unshield amount to receive a desired amount after fees
 *
 * Reverse calculation of calculateInclusiveFee()
 *
 * To receive `desiredAmount` after fee deduction:
 * - desiredAmount = unshieldAmount - (unshieldAmount * feeBP) / BASIS_POINTS
 * - desiredAmount = unshieldAmount * (1 - feeBP/BASIS_POINTS)
 * - desiredAmount = unshieldAmount * (BASIS_POINTS - feeBP) / BASIS_POINTS
 * - unshieldAmount = desiredAmount * BASIS_POINTS / (BASIS_POINTS - feeBP)
 *
 * @param desiredReceiveAmount - Amount user wants to receive (after fees)
 * @param feeBP - Fee in basis points (e.g., 25 = 0.25%)
 * @returns Required unshield amount (including fees)
 */
export function calculateRequiredUnshieldAmount(
	desiredReceiveAmount: bigint,
	feeBP: bigint
): bigint {
	// unshieldAmount = desiredAmount * BASIS_POINTS / (BASIS_POINTS - feeBP)
	const requiredAmount = (desiredReceiveAmount * BASIS_POINTS) / (BASIS_POINTS - feeBP)

	// Round up to ensure we get at least desiredReceiveAmount after fees
	// Add 1 if there's a remainder
	const remainder = (desiredReceiveAmount * BASIS_POINTS) % (BASIS_POINTS - feeBP)
	return remainder > 0n ? requiredAmount + 1n : requiredAmount
}

/**
 * Get max spendable amount from a UTXO after contract fees
 *
 * @param utxoValue - UTXO value
 * @param feeBP - Fee in basis points
 * @returns Amount user will receive if they unshield this full UTXO
 */
export function getMaxSpendableAmount(utxoValue: bigint, feeBP: bigint): bigint {
	return calculateInclusiveFee(utxoValue, feeBP).base
}

/**
 * Format fee information for display
 */
export function formatFeeInfo(
	unshieldAmount: bigint,
	feeBP: bigint,
	decimals: number
): {
	unshieldAmount: string
	receiveAmount: string
	feeAmount: string
	feePercentage: string
} {
	const { base, fee } = calculateInclusiveFee(unshieldAmount, feeBP)

	return {
		unshieldAmount: ethers.formatUnits(unshieldAmount, decimals),
		receiveAmount: ethers.formatUnits(base, decimals),
		feeAmount: ethers.formatUnits(fee, decimals),
		feePercentage: (Number(feeBP) / 100).toFixed(2)
	}
}
