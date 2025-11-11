import { ethers } from 'ethers'

import { env } from '../schema/env'
import { BaseErrors } from '../schema/errors'
import type { UserOperationParams } from '../types/wallet'
import { validateFeeIncluded } from './userOp'

function packUserOp(userOp: UserOperationParams): string {
	const abiCoder = ethers.AbiCoder.defaultAbiCoder()

	return abiCoder.encode(
		[
			'address', // sender
			'uint256', // nonce
			'bytes32', // initCode hash
			'bytes32', // callData hash
			'bytes32', // accountGasLimits
			'uint256', // preVerificationGas
			'bytes32', // gasFees
			'bytes32' // paymasterAndData hash
		],
		[
			userOp.sender,
			userOp.nonce,
			ethers.keccak256(userOp.initCode),
			ethers.keccak256(userOp.callData),
			// accountGasLimits = (verificationGasLimit << 128) | callGasLimit
			ethers.solidityPacked(
				['uint128', 'uint128'],
				[BigInt(userOp.verificationGasLimit), BigInt(userOp.callGasLimit)]
			),
			userOp.preVerificationGas,
			// gasFees = (maxPriorityFeePerGas << 128) | maxFeePerGas
			ethers.solidityPacked(
				['uint128', 'uint128'],
				[BigInt(userOp.maxPriorityFeePerGas), BigInt(userOp.maxFeePerGas)]
			),
			ethers.keccak256(userOp.paymasterAndData)
		]
	)
}

export async function getUserOpHash(
	userOp: UserOperationParams,
	entryPoint: string,
	chainId: number
): Promise<string> {
	const packed = packUserOp(userOp)
	const userOpHash = ethers.keccak256(packed)

	const abiCoder = ethers.AbiCoder.defaultAbiCoder()
	const encoded = abiCoder.encode(
		['bytes32', 'address', 'uint256'],
		[userOpHash, entryPoint, chainId]
	)

	return ethers.keccak256(encoded)
}

function getPaymasterSigner(): ethers.Wallet {
	return new ethers.Wallet(env.PAYMASTER_SIGNER_KEY)
}

export function validateBeforeSigning(userOp: UserOperationParams): {
	valid: boolean
	reason?: string
} {
	// Check if fee is included
	const hasFee = validateFeeIncluded(userOp)
	if (!hasFee) {
		return {
			valid: false,
			reason: `Fee transfer not found. Required: ${env.WALLET_FEE_AMOUNT} USDT to ${env.WALLET_FEE_RECIPIENT}`
		}
	}
	return { valid: true }
}

export async function signUserOp(userOp: UserOperationParams, chainId: number): Promise<string> {
	const validation = validateBeforeSigning(userOp)
	if (!validation.valid) {
		throw new BaseErrors.ERR_PAYMASTER_VALIDATION_FAILED()
	}

	const signer = getPaymasterSigner()
	const userOpHash = await getUserOpHash(userOp, env.ENTRY_POINT_ADDRESS, chainId)
	const signature = await signer.signMessage(ethers.getBytes(userOpHash))

	const verificationGasLimit = ethers.toBeHex(150000, 16) // 150k gas for verification
	const postOpGasLimit = ethers.toBeHex(50000, 16) // 50k gas for post-op

	const paymasterAndData = ethers.concat([
		env.PAYMASTER_ADDRESS, // 20 bytes
		verificationGasLimit, // 16 bytes
		postOpGasLimit, // 16 bytes
		signature // 65 bytes
	])

	return ethers.hexlify(paymasterAndData)
}

export function getPaymasterSignerAddress(): string {
	const signer = getPaymasterSigner()
	return signer.address
}

export async function verifyPaymasterSignature(
	userOp: UserOperationParams,
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
