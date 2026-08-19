import { getCorsHeaders, rejectDisallowedOrigin, isAddr, isSafeHttpUrl } from './_security.js';

const CHAIN_CONFIG = {
  1: { rpc: ['https://eth.llamarpc.com'], explorer: 'https://eth.blockscout.com/api/v2' },
  8453: { rpc: ['https://mainnet.base.org'], explorer: 'https://base.blockscout.com/api/v2' },
  42161: { rpc: ['https://arb1.arbitrum.io/rpc'], explorer: 'https://arbitrum.blockscout.com/api/v2' },
  10: { rpc: ['https://mainnet.optimism.io'], explorer: 'https://optimism.blockscout.com/api/v2' },
  137: { rpc: ['https://polygon.llamarpc.com', 'https://polygon-rpc.com', 'https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org'], explorer: 'https://polygon.blockscout.com/api/v2' },
  56: { rpc: ['https://bsc-dataseed.binance.org'], explorer: 'https://bsc.blockscout.com/api/v2' },
  43114: { rpc: ['https://api.avax.network/ext/bc/C/rpc'], explorer: 'https://avalanche.blockscout.com/api/v2' },
  130: { rpc: ['https://mainnet.unichain.org'], explorer: 'https://unichain.blockscout.com/api/v2' },
  81457: { rpc: ['https://rpc.blast.io'], explorer: 'https://blast.blockscout.com/api/v2' },
  534352: { rpc: ['https://rpc.scroll.io'], explorer: 'https://scroll.blockscout.com/api/v2' },
  59144: { rpc: ['https://rpc.linea.build'], explorer: 'https://explorer.linea.build/api/v2' },
  5000: { rpc: ['https://rpc.mantle.xyz'] },
  146: { rpc: ['https://rpc.soniclabs.com'] },
  34443: { rpc: ['https://mainnet.mode.network'] },
  2741: { rpc: ['https://api.mainnet.abs.xyz'] },
  999: { rpc: ['https://rpc.hyperliquid.xyz/evm'] },
  57073: { rpc: ['https://rpc-gel.inkonchain.com', 'https://rpc-qnd.inkonchain.com'], explorer: 'https://explorer.inkonchain.com/api/v2' },
  143: { rpc: ['https://rpc.monad.xyz'] },
  9745: { rpc: ['https://rpc.plasma.to'] },
  4663: { rpc: ['https://rpc.mainnet.chain.robinhood.com'], explorer: 'https://robinhoodchain.blockscout.com/api/v2' },
  480: { rpc: ['https://worldchain-mainnet.g.alchemy.com/public'] },
  324: { rpc: ['https://mainnet.era.zksync.io'], explorer: 'https://zksync.blockscout.com/api/v2' },
  1329: { rpc: ['https://evm-rpc.sei-apis.com'] },
  1776: { rpc: ['https://sentry.evm-rpc.injective.network'], explorer: 'https://blockscout.injective.network/api/v2' },
};

async function fetchJson(url, options = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function decodeAbiString(hex) {
  if (!hex || hex === '0x' || hex === '0x0') return '';
  try {
    const data = hex.slice(2);
    if (data.length >= 128) {
      const len = parseInt(data.slice(64, 128), 16);
      if (len > 0 && len < 200) {
        const bytes = data.slice(128, 128 + len * 2);
        let out = '';
        for (let i = 0; i < bytes.length; i += 2) out += String.fromCharCode(parseInt(bytes.slice(i, i + 2), 16));
        out = out.replace(/[^\x20-\x7E]/g, '').trim();
        if (out) return out;
      }
    }
    let out = '';
    for (let i = 0; i < Math.min(data.length, 64); i += 2) {
      const code = parseInt(data.slice(i, i + 2), 16);
      if (!code) break;
      if (code >= 32 && code < 127) out += String.fromCharCode(code);
    }
    return out.trim();
  } catch {
    return '';
  }
}

async function fetchExplorerToken(config, address) {
  if (!config?.explorer) return null;
  try {
    const response = await fetchJson(`${config.explorer}/tokens/${address}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible)',
      },
    }, 9000);
    if (!response.ok) return null;
    const data = await response.json();
    const sym = String(data?.symbol || '').trim();
    if (!sym) return null;
    return {
      sym,
      name: String(data?.name || sym).trim(),
      dec: Number.parseInt(data?.decimals || 18, 10) || 18,
      logo: String(data?.icon_url || data?.iconUrl || data?.image_url || data?.imageUrl || '').trim(),
    };
  } catch {
    return null;
  }
}

async function fetchRpcToken(config, address) {
  const calls = [
    { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: address, data: '0x95d89b41' }, 'latest'] },
    { jsonrpc: '2.0', id: 2, method: 'eth_call', params: [{ to: address, data: '0x313ce567' }, 'latest'] },
    { jsonrpc: '2.0', id: 3, method: 'eth_call', params: [{ to: address, data: '0x06fdde03' }, 'latest'] },
  ];
  for (const rpc of (config?.rpc || [])) {
    try {
      const response = await fetchJson(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(calls),
      }, 9000);
      if (!response.ok) continue;
      const data = await response.json();
      const symbol = decodeAbiString(data.find(row => row?.id === 1)?.result || '');
      const decRaw = data.find(row => row?.id === 2)?.result || '';
      const name = decodeAbiString(data.find(row => row?.id === 3)?.result || '') || symbol;
      const dec = decRaw && decRaw !== '0x' ? parseInt(decRaw, 16) : 18;
      if (symbol) {
        return {
          sym: symbol,
          name: name || symbol,
          dec: Number.isFinite(dec) ? dec : 18,
          logo: '',
        };
      }
    } catch {}
  }
  return null;
}

export async function onRequest(context) {
  const { request } = context;
  const CORS = getCorsHeaders(request, 'GET, OPTIONS', { 'Cache-Control': 's-maxage=3600' });

  const blocked = rejectDisallowedOrigin(request, 'GET, OPTIONS');
  if (blocked) return blocked;

  if (request.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS });
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: CORS });
  }

  const url = new URL(request.url);
  const chainId = Number(url.searchParams.get('chainId') || 0);
  const address = String(url.searchParams.get('address') || '').trim().toLowerCase();
  if (!CHAIN_CONFIG[chainId] || !isAddr(address)) {
    return new Response(JSON.stringify({ error: 'Invalid chainId or address' }), { status: 400, headers: CORS });
  }

  const config = CHAIN_CONFIG[chainId];
  const explorerToken = await fetchExplorerToken(config, address);
  const rpcToken = explorerToken?.sym ? null : await fetchRpcToken(config, address);
  const token = explorerToken || rpcToken;

  if (!token?.sym) {
    return new Response(JSON.stringify({ token: null, error: 'Token not found on this network' }), { status: 404, headers: CORS });
  }

  return new Response(JSON.stringify({
    token: {
      addr: address,
      sym: token.sym,
      name: token.name || token.sym,
      dec: token.dec ?? 18,
      logo: isSafeHttpUrl(token.logo) ? token.logo : '',
      chainId,
    },
  }), { status: 200, headers: CORS });
}
