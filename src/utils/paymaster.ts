import { ethers } from 'ethers'

import type { UserOperation } from '../schema/b402'
import { env } from '../schema/env'
import { BaseErrors } from '../schema/errors'
import { validateFeeIncluded } from './userOp'

function getVerifyingPaymasterHash(
	userOp: UserOperation,
	validUntil: number,
	validAfter: number,
	chainId: number
): string {
	const abiCoder = ethers.AbiCoder.defaultAbiCoder()
	const initCode =
		userOp.factory && userOp.factoryData
			? ethers.concat([userOp.factory, userOp.factoryData])
			: '0x'

	const accountGasLimits = ethers.solidityPacked(
		['uint128', 'uint128'],
		[BigInt(userOp.verificationGasLimit), BigInt(userOp.callGasLimit)]
	)

	const gasFees = ethers.solidityPacked(
		['uint128', 'uint128'],
		[BigInt(userOp.maxPriorityFeePerGas), BigInt(userOp.maxFeePerGas)]
	)

	const paymasterGasLimitsPacked = ethers.solidityPacked(
		['uint128', 'uint128'],
		[BigInt(userOp.paymasterVerificationGasLimit || 0), BigInt(userOp.paymasterPostOpGasLimit || 0)]
	)

	const paymasterValidationGasLimit = BigInt(paymasterGasLimitsPacked)

	return ethers.keccak256(
		abiCoder.encode(
			[
				'address', // sender
				'uint256', // nonce
				'bytes32', // keccak256(initCode)
				'bytes32', // keccak256(callData)
				'bytes32', // accountGasLimits
				'uint256', // paymasterValidationGasLimit (uint256 cast from bytes32)
				'uint256', // preVerificationGas
				'bytes32', // gasFees
				'uint256', // chainid
				'address', // paymaster address
				'uint256', // validUntil
				'uint256' // validAfter
			],
			[
				userOp.sender,
				userOp.nonce,
				ethers.keccak256(initCode),
				ethers.keccak256(userOp.callData),
				accountGasLimits,
				paymasterValidationGasLimit,
				userOp.preVerificationGas,
				gasFees,
				chainId,
				env.PAYMASTER_ADDRESS,
				validUntil,
				validAfter
			]
		)
	)
}

// Singleton instance
let paymasterSignerInstance: ethers.Wallet | null = null

function getPaymasterSigner(): ethers.Wallet {
	if (!paymasterSignerInstance) {
		paymasterSignerInstance = new ethers.Wallet(env.PAYMASTER_SIGNER_KEY)
	}
	return paymasterSignerInstance
}

export function validateBeforeSigning(userOp: UserOperation): {
	valid: boolean
	reason?: string
} {
	// Skip fee validation for deployment operations
	if (userOp.callData === '0x') {
		return { valid: true }
	}

	// Check if fee is included for payment operations
	const hasFee = validateFeeIncluded(userOp)
	if (!hasFee) {
		return {
			valid: false,
			reason: `Fee transfer not found. Required: ${env.WALLET_PAYMENT_FEE} USDT to ${env.WALLET_FEE_RECIPIENT}`
		}
	}
	return { valid: true }
}

export async function signUserOp(
	userOp: UserOperation,
	chainId: number
): Promise<{
	paymaster: string
	paymasterVerificationGasLimit: string
	paymasterPostOpGasLimit: string
	paymasterData: string
}> {
	const validation = validateBeforeSigning(userOp)
	if (!validation.valid) {
		throw new BaseErrors.ERR_PAYMASTER_VALIDATION_FAILED()
	}

	const validAfter = Math.floor(Date.now() / 1000) - 3600 // Valid from 1 hour ago
	const validUntil = Math.floor(Date.now() / 1000) + 48 * 60 * 60 // 48 hours from now

	const paymasterVerificationGasLimit = 300000
	const paymasterPostOpGasLimit = 150000

	// Temporarily set paymaster fields so they're included in the hash
	const userOpWithPaymaster = {
		...userOp,
		paymaster: env.PAYMASTER_ADDRESS,
		paymasterVerificationGasLimit: ethers.toBeHex(paymasterVerificationGasLimit),
		paymasterPostOpGasLimit: ethers.toBeHex(paymasterPostOpGasLimit)
	}

	const hash = getVerifyingPaymasterHash(userOpWithPaymaster, validUntil, validAfter, chainId)
	const signer = getPaymasterSigner()
	const signature = await signer.signMessage(ethers.getBytes(hash))
	const abiCoder = ethers.AbiCoder.defaultAbiCoder()
	const timeEncoding = abiCoder.encode(['uint48', 'uint48'], [validUntil, validAfter])
	const paymasterData = ethers.concat([timeEncoding, signature])

	return {
		paymaster: env.PAYMASTER_ADDRESS,
		paymasterVerificationGasLimit: ethers.toBeHex(paymasterVerificationGasLimit),
		paymasterPostOpGasLimit: ethers.toBeHex(paymasterPostOpGasLimit),
		paymasterData
	}
}

export function getPaymasterSignerAddress(): string {
	const signer = getPaymasterSigner()
	return signer.address
}

export async function getUserOpHash(
	userOp: UserOperation,
	entryPointAddress: string,
	chainId: number
): Promise<string> {
	const abiCoder = ethers.AbiCoder.defaultAbiCoder()

	const initCode =
		userOp.factory && userOp.factoryData
			? ethers.concat([userOp.factory, userOp.factoryData])
			: '0x'

	const accountGasLimits = ethers.solidityPacked(
		['uint128', 'uint128'],
		[BigInt(userOp.verificationGasLimit), BigInt(userOp.callGasLimit)]
	)

	const gasFees = ethers.solidityPacked(
		['uint128', 'uint128'],
		[BigInt(userOp.maxPriorityFeePerGas), BigInt(userOp.maxFeePerGas)]
	)

	let paymasterAndData = '0x'
	if (userOp.paymaster) {
		const paymasterVerificationGasLimit = userOp.paymasterVerificationGasLimit || '0x'
		const paymasterPostOpGasLimit = userOp.paymasterPostOpGasLimit || '0x'
		const paymasterData = userOp.paymasterData || '0x'

		// paymaster (20 bytes) + verificationGasLimit (16 bytes) + postOpGasLimit (16 bytes) + paymasterData
		const verificationGasLimitPacked = ethers.zeroPadValue(
			ethers.toBeHex(paymasterVerificationGasLimit),
			16
		)
		const postOpGasLimitPacked = ethers.zeroPadValue(ethers.toBeHex(paymasterPostOpGasLimit), 16)

		paymasterAndData = ethers.concat([
			userOp.paymaster,
			verificationGasLimitPacked,
			postOpGasLimitPacked,
			paymasterData
		])
	}

	const packedUserOp = abiCoder.encode(
		['address', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'bytes32'],
		[
			userOp.sender,
			userOp.nonce,
			ethers.keccak256(initCode),
			ethers.keccak256(userOp.callData),
			accountGasLimits,
			userOp.preVerificationGas,
			gasFees,
			ethers.keccak256(paymasterAndData)
		]
	)

	const userOpHash = ethers.keccak256(packedUserOp)

	// Return hash of (userOpHash, entryPoint, chainId)
	return ethers.keccak256(
		abiCoder.encode(['bytes32', 'address', 'uint256'], [userOpHash, entryPointAddress, chainId])
	)
}

export async function verifyPaymasterSignature(
	userOp: UserOperation,
	chainId: number,
	signature: string
): Promise<boolean> {
	try {
		const userOpHash = await getUserOpHash(userOp, env.ENTRY_POINT_ADDRESS, chainId)
		const recoveredAddress = ethers.verifyMessage(ethers.getBytes(userOpHash), signature)

		const expectedAddress = getPaymasterSignerAddress()
		return recoveredAddress.toLowerCase() === expectedAddress.toLowerCase()
	} catch (error) {
		console.error('Error verifying paymaster signature:', error)
		return false
	}
}
