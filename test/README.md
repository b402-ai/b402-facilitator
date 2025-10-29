# B402 Facilitator API Testing Guide

This guide will help you test the B402 Facilitator API with Postman using EIP-712 signatures.

## API Endpoints on `http://localhost:3402`

### 1. **Health Check** (easiest to test first)

- **URL**: `GET http://localhost:3402/api/v1/health`
- **No body required**
- Should return the service status and configuration

### 2. **Verify Payment**

- **URL**: `POST http://localhost:3402/api/v1/verify`
- Validates a payment authorization without submitting it

### 3. **Settle Payment**

- **URL**: `POST http://localhost:3402/api/v1/settle`
- Actually submits the payment to the blockchain (costs gas)

---

## Step 1: Configure Your Environment

Add these variables to your `.env` file:

```bash
# Your test wallet private key (needs BNB for approval transaction)
TEST_WALLET_PRIVATE_KEY=your_private_key_here

# USD1 token address on BSC Mainnet
USD1_TOKEN_ADDRESS=0x...

# B402 Relayer contract address
B402_RELAYER_ADDRESS=0x...

# BSC RPC URL
BSC_RPC_URL=https://...
```

## Step 2: Generate Signature and Approve Token

Run the test signature script:

```bash
npx tsx test/test-signature.ts
```

**This script will:**

1. Check your wallet's token balance
2. Check if the B402 relayer is approved to spend your tokens
3. If not approved, prompt you to approve (requires BNB for gas)
4. Generate an EIP-712 signature for the payment
5. Output a complete JSON payload for Postman

## Step 3: Import Postman Collection

1. Open Postman
2. Click **Import**
3. Select the file: `test/B402-Facilitator.postman_collection.json`
4. You'll get 5 pre-configured requests

## Step 4: Test the API

### A. Start with Health Check

1. Select **Health Check** request
2. Click **Send**
3. Should return service status

### B. Test Verify (doesn't cost gas)

1. Select **Verify Payment** request
2. Replace the body with the JSON from Step 2
3. Click **Send**
4. Should validate your signature

### C. Test Settle (costs gas - be careful!)

1. Select **Settle Payment** request
2. Replace the body with the JSON from Step 2
3. Click **Send**
4. This executes the actual transaction on-chain (relayer pays gas)

## Important Notes

- **Token approval required**: First time using settle, you must approve the relayer contract (handled by the test script)
- **Each signature can only be used once** (nonce prevents replay attacks)
- **Run `test-signature.ts` each time** you want to create a new test payment
- **Signature validity**: 1 hour from generation
- **Who pays gas**: The relayer wallet pays for the settle transaction, but your wallet needs BNB for the initial approval
