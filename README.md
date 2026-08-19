# CoinBlogHQ Swap & Bridge

This repository contains the source code for the CoinBlogHQ Swap and Bridge aggregators.

## Architecture

The system is built with a **Zero-Dependency Vanilla JS** frontend and a secure **Edge Middleware** backend using Cloudflare Workers.

### Frontend
- `public/swap.html`: Token swap interface supporting 15+ EVM networks. Uses EIP-6963 for wallet discovery.
- `public/bridge.html`: Cross-chain bridge interface.
- No heavy frameworks (React, Vue) are used, ensuring maximum performance (100/100 PageSpeed) and security.

### Backend (Cloudflare Workers)
The backend acts as a secure shield between the client and aggregator APIs (0x, LI.FI, ParaSwap, OpenOcean).
- `functions/api/swap-quote.js`: Fetches and validates swap quotes.
- `functions/api/_bridge-common.js`: Contains shared bridge logic and cryptographic functions (HMAC).
- `functions/api/_evm-rpc.js`: Provides canonical RPC endpoints for balance and gas checks.
- `functions/api/_security.js`: Handles CORS, rate limiting, and input validation.

### Security Features
- **Zero-Revert Policy**: The backend simulates transactions before presenting them to the user.
- **HMAC Signatures**: Route steps are cryptographically signed to prevent manipulation.
- **Strict Validation**: All inputs and API responses are sanitized.
- **API Key Protection**: All third-party API keys are stored securely in environment variables on the edge.

## Setup

1. Copy `.env.example` to `.dev.vars` (for local development) and fill in your API keys.
2. Ensure you have Node.js and Wrangler installed.
3. Run the development server:

```bash
npm install -g wrangler
wrangler pages dev public
```

## Environment Variables

- `ZEROX_API_KEY`: API key for the 0x Protocol.
- `LIFI_API_KEY`: API key for the LI.FI bridge aggregator.
- `BRIDGE_SIGNING_SECRET`: A secure random string used for HMAC signing of bridge steps.
