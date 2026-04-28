import { ethers } from 'ethers'

import { env } from '../schema/env'

const NEXUS_BOOTSTRAP_ABI = ['function initNexusWithDefaultValidator(bytes calldata data)']

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

	const validatorInitData = ethers.solidityPacked(['address'], [ownerAddress])
	const bootstrapInterface = new ethers.Interface(NEXUS_BOOTSTRAP_ABI)

	return bootstrapInterface.encodeFunctionData('initNexusWithDefaultValidator', [validatorInitData])
}

/**
 * Encodes the full calldata for Nexus account creation
 *
 * @param ownerAddress
 * @returns
 */
export function encodeNexusAccountCreation(ownerAddress: string): string {
	const bootstrapCall = createNexusInitData(ownerAddress)

	return ethers.AbiCoder.defaultAbiCoder().encode(
		['address', 'bytes'],
		[env.NEXUS_BOOTSTRAP_ADDRESS, bootstrapCall]
	)
}
