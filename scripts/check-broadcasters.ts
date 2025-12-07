import { WakuBroadcasterClient } from '@railgun-community/waku-broadcaster-client-node'

// Check broadcaster availability for different networks
async function checkBroadcasters() {
	const networks = [
		{ name: 'Ethereum', chain: { type: 0, id: 1 } },
		{ name: 'BSC', chain: { type: 0, id: 56 } },
		{ name: 'Polygon', chain: { type: 0, id: 137 } },
		{ name: 'Arbitrum', chain: { type: 0, id: 42161 } }
	]

	const token = '0x55d398326f99059fF775485246999027B3197955' // USDT on BSC (change per network)

	for (const network of networks) {
		console.log(`\n=== Checking ${network.name} (Chain ${network.chain.id}) ===`)

		try {
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error('Timeout')), 30000)

				WakuBroadcasterClient.start(
					network.chain,
					{
						trustedFeeSigner:
							'0zk1qyv0zc0j9sm6mr8fe3gx7ymwc6d2xymfftqvgvjdy3r8dmyfs947lrv7j6fe3z53llx97s6mxjstvn9wj3xhyv4cfecw08gqzywgnl0fmzx3mguhr2hyych4srf',
						peerDiscoveryTimeout: 20000,
						useDNSDiscovery: true
					},
					(_, status) => {
						console.log(`  Status: ${status}`)
						if (status === 'Connected') {
							clearTimeout(timeout)
							setTimeout(() => resolve(), 3000)
						}
					}
				)
			})

			const broadcaster = await WakuBroadcasterClient.findBestBroadcaster(
				network.chain,
				token,
				true
			)

			if (broadcaster) {
				console.log(`  ✓ Broadcasters available!`)
				console.log(`    Address: ${broadcaster.railgunAddress}`)
				console.log(`    Fee: ${broadcaster.tokenFee.feePerUnitGas}`)
			} else {
				console.log(`  ✗ No broadcasters found`)
			}

			WakuBroadcasterClient.stop()
			await new Promise((r) => setTimeout(r, 2000)) // Wait before next network
		} catch (error) {
			console.log(`  ✗ Failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
			WakuBroadcasterClient.stop()
		}
	}
}

checkBroadcasters().catch(console.error)
