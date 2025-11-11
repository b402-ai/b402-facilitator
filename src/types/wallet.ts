export interface UserOperationParams {
	sender: string
	nonce: string
	initCode: string
	callData: string
	callGasLimit: string
	verificationGasLimit: string
	preVerificationGas: string
	maxFeePerGas: string
	maxPriorityFeePerGas: string
	paymasterAndData: string
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
