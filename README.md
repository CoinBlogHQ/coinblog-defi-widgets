# CoinBlogHQ Universal Exchange (Swap & Bridge)

Open-source DeFi Exchange and Cross-Chain Bridge aggregator widget from [Coin Blog](https://coinbloghq.com).

## 📄 Technical Whitepaper

- 🇬🇧 **[English Technical Whitepaper (WHITEPAPER.md)](WHITEPAPER.md)**
- 🇷🇺 **[Русский технический Whitepaper (WHITEPAPER_RU.md)](WHITEPAPER_RU.md)**

Detailed technical documentation covering routing algorithms, security mechanisms, HMAC signatures, and smart contract safety models.

## Architecture

The system is built with a **Zero-Dependency Vanilla JS** frontend and a secure **Edge Middleware** backend using Cloudflare Workers.

### Frontend
- `public/exchange.html`: Unified Swap & Cross-Chain Bridge interface supporting 15+ EVM networks.
- `public/js/exchange.js`: Core routing brain that dynamically selects same-chain DEX aggregators (0x Protocol, ParaSwap) or cross-chain bridge protocols (LI.FI, Across, Relay).
- Built-in GoPlus Anti-Scam security scanner and token safety checks.
- EIP-6963 multi-wallet auto-discovery and WalletConnect v2 integration.
- Exact allowance approvals (no infinite approval risks).

### Backend (Cloudflare Workers)
The backend acts as a secure shield between the client and aggregator APIs.
- `functions/api/swap-quote.js`: 0x Protocol v2 proxy with parameter validation.
- `functions/api/paraswap-quote.js`: ParaSwap / Velora DEX proxy with on-chain simulation.
- `functions/api/bridge-routes.js` & `bridge-step.js`: LI.FI aggregator proxy with HMAC cryptographic signing.
- `functions/api/_bridge-common.js`: Cryptographic route step signing (HMAC-SHA256).
- `functions/api/_security.js`: Origin verification, CORS policy, and IP rate limiting.

### Security Features
- **Zero-Revert Policy**: On-chain RPC simulation before user signature.
- **HMAC Signatures**: Route steps and recipient addresses are cryptographically sealed.
- **Anti-Honeypot Scanner**: Real-time bytecode analysis and tax detection.
- **Exact Approvals**: Grants allowance only for the exact transaction amount.

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
