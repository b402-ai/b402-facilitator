import { ethers } from 'ethers'

import { env } from '../schema/env'

// ABIs for Nexus contracts
const NEXUS_BOOTSTRAP_ABI = [
	'function initNexusNoRegistry((address module, bytes data)[] validators, (address module, bytes data)[] executors, (address module, bytes data) hook, (address module, bytes data)[] fallbacks, (uint256 hookType, address module, bytes data)[] preValidationHooks)'
]

/**
 * Creates the initData for Nexus account deployment with K1Validator
 *
 * @param ownerAddress
 * @returns
 */
export function createNexusInitData(ownerAddress: string): string {
	if (!ethers.isAddress(ownerAddress)) {
		throw new Error('Invalid owner address')
	}

	const k1ValidatorData = ethers.AbiCoder.defaultAbiCoder().encode(['address'], [ownerAddress])
	const validators = [
		{
			module: env.K1_VALIDATOR_ADDRESS,
			data: k1ValidatorData
		}
	]
	const executors: Array<{ module: string; data: string }> = []
	const hook = {
		module: ethers.ZeroAddress,
		data: '0x'
	}
	const fallbacks: Array<{ module: string; data: string }> = []
	const preValidationHooks: Array<{ hookType: number; module: string; data: string }> = []
	const bootstrapInterface = new ethers.Interface(NEXUS_BOOTSTRAP_ABI)

	const initData = bootstrapInterface.encodeFunctionData('initNexusNoRegistry', [
		validators,
		executors,
		hook,
		fallbacks,
		preValidationHooks
	])

	return initData
}

/**
 * Encodes the full calldata for Nexus account creation
 *
 * @param ownerAddress
 * @returns
 */
export function encodeNexusAccountCreation(ownerAddress: string): string {
	const initData = createNexusInitData(ownerAddress)

	// The factory expects: abi.encodeCall(Bootstrap.initNexusNoRegistry, (...))
	// Which is: Bootstrap address (target) + initData
	const bootstrapCall = ethers.concat([env.NEXUS_BOOTSTRAP_ADDRESS, initData.slice(2)]) // Remove '0x' from initData

	return bootstrapCall
}
