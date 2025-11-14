export interface UserOperationParams {
	sender: string
	nonce: string
	// ERC-4337 v0.7 unpacked factory fields
	factory?: string
	factoryData?: string
	callData: string
	callGasLimit: string
	verificationGasLimit: string
	preVerificationGas: string
	maxFeePerGas: string
	maxPriorityFeePerGas: string
	// ERC-4337 v0.7 unpacked paymaster fields
	paymaster?: string
	paymasterVerificationGasLimit?: string
	paymasterPostOpGasLimit?: string
	paymasterData?: string
	signature: string
}

export interface PaymasterData {
	paymaster: string
	paymasterVerificationGasLimit: string
	paymasterPostOpGasLimit: string
	paymasterData: string
}

export interface BatchCall {
	to: string
	value: string
	data: string
}
