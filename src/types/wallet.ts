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
