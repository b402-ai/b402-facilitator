export interface ShieldCommitment {
	commitmentHash: string
	treeNumber: string
	position: string
	tokenAddress: string
	tokenType: number
	tokenSubID: string
	amount: string
	fee: string
	npk: string
	encryptedBundle0: string
	encryptedBundle1: string
	encryptedBundle2: string
	shieldKey: string
}

export interface OutputCommitment {
	commitmentHash: string
	position: string
	ciphertext: {
		ciphertext0: string
		ciphertext1: string
		ciphertext2: string
		ciphertext3: string
		blindedSenderViewingKey: string
		blindedReceiverViewingKey: string
		annotationData: string
		memo: string
	}
}

export interface UnshieldData {
	recipientAddress: string
	tokenAddress: string
	tokenType: number
	tokenSubID: string
	amount: string
	fee: string
}

export interface NullifierUsedData {
	nullifier: string
	transactionHash: string
	blockNumber: string
	blockTime: string
	type: 'TRANSACT' | 'UNSHIELD'
	outputCommitments?: OutputCommitment[]
	unshieldData?: UnshieldData
}

export interface NullifierScanResponse {
	used: NullifierUsedData[]
	unused: string[]
}

export async function fetchCommitmentsByEOA(
	apiUrl: string,
	eoa: string
): Promise<ShieldCommitment[]> {
	const url = `${apiUrl}/privacy/commitments?eoa=${eoa}`

	try {
		const response = await fetch(url)

		if (!response.ok) {
			throw new Error(`API error: ${response.status} ${response.statusText}`)
		}

		const data = await response.json()
		return data.shields || []
	} catch (error) {
		if (error instanceof Error) {
			throw new Error(`Failed to fetch commitments: ${error.message}`)
		}
		throw error
	}
}

export async function fetchNullifierData(
	apiUrl: string,
	nullifiers: string[]
): Promise<NullifierScanResponse> {
	if (nullifiers.length > 1000) {
		throw new Error('Maximum 1000 nullifiers per request')
	}

	const url = `${apiUrl}/privacy/nullifiers`

	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ nullifiers })
		})

		if (!response.ok) {
			throw new Error(`API error: ${response.status} ${response.statusText}`)
		}

		const data = await response.json()
		return data
	} catch (error) {
		if (error instanceof Error) {
			throw new Error(`Failed to fetch nullifier data: ${error.message}`)
		}
		throw error
	}
}

export async function fetchNullifierDataBatched(
	apiUrl: string,
	nullifiers: string[]
): Promise<NullifierScanResponse> {
	const batchSize = 1000
	const batches: string[][] = []

	for (let i = 0; i < nullifiers.length; i += batchSize) {
		batches.push(nullifiers.slice(i, i + batchSize))
	}

	const results = await Promise.all(batches.map((batch) => fetchNullifierData(apiUrl, batch)))

	const mergedResult: NullifierScanResponse = {
		used: [],
		unused: []
	}

	for (const result of results) {
		mergedResult.used.push(...result.used)
		mergedResult.unused.push(...result.unused)
	}

	return mergedResult
}

export interface MerkleProofResponse {
	proof: string[]
	root: string
	leafIndex: string
	pathIndices: number[]
	treeDepth: number
}

export async function fetchMerkleProof(
	apiUrl: string,
	commitmentHash: string,
	treeNumber: string,
	position: string
): Promise<MerkleProofResponse> {
	const url = `${apiUrl}/privacy/merkle-proof?commitmentHash=${commitmentHash}&treeNumber=${treeNumber}&position=${position}`

	try {
		const response = await fetch(url)
		if (!response.ok) {
			throw new Error(`API error: ${response.status} ${response.statusText}`)
		}
		return await response.json()
	} catch (error) {
		if (error instanceof Error) {
			throw new Error(`Failed to fetch merkle proof: ${error.message}`)
		}
		throw error
	}
}

export async function fetchMerkleProofsBatch(
	apiUrl: string,
	requests: Array<{ commitmentHash: string; treeNumber: string; position: string }>
): Promise<MerkleProofResponse[]> {
	return Promise.all(
		requests.map((req) =>
			fetchMerkleProof(apiUrl, req.commitmentHash, req.treeNumber, req.position)
		)
	)
}
