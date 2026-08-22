import { isAddr } from './_security.js';

const RPCS = {
  1: ['https://eth.llamarpc.com', 'https://cloudflare-eth.com', 'https://ethereum-rpc.publicnode.com'],
  10: ['https://mainnet.optimism.io', 'https://optimism.llamarpc.com', 'https://optimism-rpc.publicnode.com'],
  56: ['https://bsc-dataseed.binance.org', 'https://bsc-dataseed1.defibit.io'],
  100: ['https://rpc.gnosischain.com', 'https://gnosis-rpc.publicnode.com'],
  130: ['https://mainnet.unichain.org', 'https://unichain-rpc.publicnode.com'],
  137: ['https://polygon.llamarpc.com', 'https://polygon-rpc.com', 'https://polygon-bor-rpc.publicnode.com'],
  143: ['https://rpc.monad.xyz'],
  146: ['https://rpc.soniclabs.com', 'https://sonic.drpc.org'],
  324: ['https://mainnet.era.zksync.io', 'https://zksync.drpc.org'],
  999: ['https://rpc.hyperliquid.xyz/evm'],
  1329: ['https://evm-rpc.sei-apis.com'],
  1776: ['https://sentry.evm-rpc.injective.network'],
  4663: ['https://rpc.mainnet.chain.robinhood.com'],
  5000: ['https://rpc.mantle.xyz', 'https://mantle.drpc.org'],
  81457: ['https://rpc.blast.io', 'https://blast.drpc.org'],
  8453: ['https://mainnet.base.org'],
  9745: ['https://rpc.plasma.to'],
  34443: ['https://mainnet.mode.network', 'https://mode.drpc.org'],
  42161: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum.llamarpc.com', 'https://arbitrum-one-rpc.publicnode.com'],
  43114: ['https://api.avax.network/ext/bc/C/rpc', 'https://avalanche.drpc.org'],
  534352: ['https://rpc.scroll.io', 'https://scroll.drpc.org'],
  59144: ['https://rpc.linea.build', 'https://linea.drpc.org'],
  80094: ['https://rpc.berachain.com', 'https://berachain.drpc.org'],
};

const CHAIN_ALIASES = new Map([
  ['eth', 1], ['ethereum', 1], ['bsc', 56], ['polygon', 137], ['avax', 43114], ['avalanche', 43114],
  ['arbitrum', 42161], ['optimism', 10], ['base', 8453], ['linea', 59144], ['scroll', 534352],
  ['unichain', 130], ['uni', 130], ['sonic', 146], ['berachain', 80094], ['bera', 80094],
  ['mantle', 5000], ['blast', 81457], ['mode', 34443], ['hyperevm', 999], ['sei', 1329],
  ['plasma', 9745], ['monad', 143], ['injective', 1776], ['zksync', 324],
]);

const ALLOWANCE_SELECTOR = '0xdd62ed3e';

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

function rpcQuantity(value) {
  const raw = String(value ?? '0');
  if (/^0x[0-9a-fA-F]+$/.test(raw)) return `0x${BigInt(raw).toString(16)}`;
  if (/^[0-9]+$/.test(raw)) return `0x${BigInt(raw).toString(16)}`;
  throw new Error('Invalid RPC quantity');
}

export function normalizeChainId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  const raw = String(value || '').toLowerCase();
  if (/^[0-9]+$/.test(raw)) {
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
  }
  return CHAIN_ALIASES.get(raw) || 0;
}

export function rpcUrls(chainId, env) {
  const cid = normalizeChainId(chainId);
  const urls = [];
  
  if (env) {
    if (env.ALCHEMY_API_KEY) {
      const alchemyNetworks = {
        1: 'eth-mainnet',
        10: 'opt-mainnet',
        56: 'bnb-mainnet',
        137: 'polygon-mainnet',
        8453: 'base-mainnet',
        42161: 'arb-mainnet',
        43114: 'avax-mainnet',
        534352: 'scroll-mainnet',
        59144: 'linea-mainnet',
        324: 'zksync-mainnet'
      };
      if (alchemyNetworks[cid]) {
        urls.push(`https://${alchemyNetworks[cid]}.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`);
      }
    }
    
    if (env.INFURA_API_KEY) {
      const infuraNetworks = {
        1: 'mainnet',
        10: 'optimism-mainnet',
        137: 'polygon-mainnet',
        42161: 'arbitrum-mainnet',
        43114: 'avalanche-mainnet',
        59144: 'linea-mainnet'
      };
      if (infuraNetworks[cid]) {
        urls.push(`https://${infuraNetworks[cid]}.infura.io/v3/${env.INFURA_API_KEY}`);
      }
    }

    if (cid === 8453 && env.CDP_API_KEY) {
      urls.push(`https://api.developer.coinbase.com/rpc/v1/base/${env.CDP_API_KEY}`);
    }
  }

  urls.push(...(RPCS[cid] || []));
  return [...new Set(urls)];
}

async function rpcRequest(rpcUrl, method, params, timeoutMs = 10000) {
  const timeout = timeoutSignal(timeoutMs);
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: timeout.signal,
    });
    if (!response.ok) throw new Error(`RPC ${response.status}`);
    const payload = await response.json();
    if (payload?.error) throw new Error(payload.error.message || 'RPC error');
    return payload?.result;
  } finally {
    timeout.cancel();
  }
}

async function withRpcFallback(chainId, env, callback) {
  const urls = rpcUrls(chainId, env);
  if (!urls.length) throw new Error('No RPC configured for chain');
  let lastError = new Error('RPC unavailable');
  for (const rpcUrl of urls) {
    try {
      return await callback(rpcUrl);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function readAllowance({ chainId, token, owner, spender, env }) {
  if (!isAddr(token) || !isAddr(owner) || !isAddr(spender)) return null;
  const data = ALLOWANCE_SELECTOR + owner.slice(2).padStart(64, '0') + spender.slice(2).padStart(64, '0');
  try {
    const result = await withRpcFallback(chainId, env, rpcUrl => rpcRequest(rpcUrl, 'eth_call', [{ to: token, data }, 'latest']));
    if (typeof result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(result)) return null;
    return BigInt(result);
  } catch {
    return null;
  }
}

export async function allowanceTargetIfNeeded({ chainId, token, owner, spender, amount, env }) {
  if (!isAddr(token) || !isAddr(owner) || !isAddr(spender)) return spender || null;
  let required;
  try {
    required = BigInt(String(amount));
  } catch {
    return spender;
  }
  const current = await readAllowance({ chainId, token, owner, spender, env });
  return current !== null && current >= required ? '' : spender;
}

export async function estimateTransaction({ chainId, from, to, data, value = '0x0', env }) {
  if (!isAddr(from) || !isAddr(to) || typeof data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(data)) {
    return { ok: false, error: 'Invalid simulation transaction' };
  }
  let normalizedValue;
  try {
    normalizedValue = rpcQuantity(value);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  try {
    const gas = await withRpcFallback(chainId, env, rpcUrl => rpcRequest(rpcUrl, 'eth_estimateGas', [{ from, to, data, value: normalizedValue }]));
    if (typeof gas !== 'string' || !/^0x[0-9a-fA-F]+$/.test(gas)) return { ok: false, error: 'RPC returned invalid gas estimate' };
    return { ok: true, gas };
  } catch (error) {
    return { ok: false, error: error?.message || 'Simulation failed' };
  }
}
