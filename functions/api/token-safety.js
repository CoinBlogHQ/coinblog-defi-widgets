import {
  checkRateLimit,
  getClientIp,
  getCorsHeaders,
  isAddr,
  rejectDisallowedOrigin,
} from './_security.js';

// Free best-effort token checks. Security data comes from GoPlus when the chain is supported;
// market metadata comes from GeckoTerminal. Unknown data never becomes a false "safe" result.
const RATE_LIMIT = new Map();
const GECKO_NETWORKS = Object.freeze({
  1: 'eth',
  10: 'optimism',
  56: 'bsc',
  137: 'polygon_pos',
  8453: 'base',
  42161: 'arbitrum',
  43114: 'avax',
  130: 'unichain',
  81457: 'blast',
  534352: 'scroll',
  59144: 'linea',
  146: 'sonic',
  80094: 'berachain',
  5000: 'mantle',
  34443: 'mode',
  2741: 'abstract',
  999: 'hyperevm',
  57073: 'ink',
  143: 'monad',
  9745: 'plasma',
  4663: 'robinhood',
  480: 'world-chain',
  324: 'zksync',
  1329: 'sei-network',
  1776: 'injective',
});
const GOPLUS_CHAINS = new Set([1, 10, 25, 56, 100, 128, 137, 250, 321, 324, 1101, 1284, 1285, 42161, 42220, 43114, 59144, 8453, 534352, 81457, 5000]);

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchJson(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'coinbloghq.com' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function onRequest(context) {
  const { request } = context;
  const CORS = getCorsHeaders(request, 'GET, OPTIONS', { 'Cache-Control': 's-maxage=120' });
  const blocked = rejectDisallowedOrigin(request, 'GET, OPTIONS');
  if (blocked) return blocked;
  if (request.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS });
  if (request.method !== 'GET') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: CORS });

  const ip = getClientIp(request);
  if (!checkRateLimit(RATE_LIMIT, ip, 60, 60000)) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), { status: 429, headers: CORS });
  }

  const url = new URL(request.url);
  const chainId = Number.parseInt(url.searchParams.get('chainId') || '130', 10);
  const address = String(url.searchParams.get('address') || '').trim().toLowerCase();
  if (!Number.isInteger(chainId) || chainId <= 0 || !isAddr(address)) {
    return new Response(JSON.stringify({ error: 'Invalid chainId or address' }), { status: 400, headers: CORS });
  }

  const result = {
    chainId,
    address,
    name: null,
    symbol: null,
    price: null,
    liquidityUsd: null,
    volume24h: null,
    security: null,
    riskScore: null,
    riskLevel: 'unknown',
    sources: [],
  };

  const geckoNetwork = GECKO_NETWORKS[chainId];
  const [goplus, gecko] = await Promise.all([
    GOPLUS_CHAINS.has(chainId)
      ? fetchJson(`https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${address}`)
      : Promise.resolve(null),
    geckoNetwork
      ? fetchJson(`https://api.geckoterminal.com/api/v2/networks/${geckoNetwork}/tokens/${address}`)
      : Promise.resolve(null),
  ]);

  const market = gecko?.data?.attributes;
  if (market) {
    result.name = market.name || null;
    result.symbol = market.symbol || null;
    result.price = numberOrNull(market.price_usd);
    result.liquidityUsd = numberOrNull(market.total_reserve_in_usd);
    result.volume24h = numberOrNull(market.volume_usd?.h24);
    result.sources.push('GeckoTerminal');
  }

  const security = goplus?.result?.[address];
  if (security) {
    const buyTax = numberOrNull(security.buy_tax);
    const sellTax = numberOrNull(security.sell_tax);
    const warnings = [];
    const flag = (condition, message) => { if (condition) warnings.push(message); };
    flag(security.is_honeypot === '1', 'Honeypot: selling may be blocked');
    flag(security.cannot_sell_all === '1', 'Cannot sell all tokens at once');
    flag(security.transfer_pausable === '1', 'Transfers can be paused by owner');
    flag(security.owner_change_balance === '1', 'Owner can change holder balances');
    flag(security.hidden_owner === '1', 'Hidden owner privileges detected');
    flag(security.can_take_back_ownership === '1', 'Ownership can be reclaimed');
    flag(security.is_mintable === '1', 'Owner can mint additional supply');
    flag(security.is_open_source === '0', 'Source code is not verified');
    flag(sellTax !== null && sellTax > 0.1, 'High sell tax (over 10%)');
    flag(buyTax !== null && buyTax > 0.1, 'High buy tax (over 10%)');

    result.name = result.name || security.token_name || null;
    result.symbol = result.symbol || security.token_symbol || null;
    result.security = {
      honeypot: security.is_honeypot === '1',
      buyTaxPct: buyTax === null ? null : buyTax * 100,
      sellTaxPct: sellTax === null ? null : sellTax * 100,
      mintable: security.is_mintable === '1',
      openSource: security.is_open_source === '1',
      ownerAddress: security.owner_address || null,
      transferPausable: security.transfer_pausable === '1',
      isProxy: security.is_proxy === '1',
      canTakeBackOwnership: security.can_take_back_ownership === '1',
      holderCount: numberOrNull(security.holder_count),
      lpHolderCount: numberOrNull(security.lp_holder_count),
      warnings,
    };
    result.sources.push('GoPlus');

    let score = 100;
    if (result.security.honeypot) score -= 70;
    if (security.cannot_sell_all === '1') score -= 30;
    if (security.owner_change_balance === '1') score -= 30;
    score -= warnings.filter(warning => !warning.startsWith('Honeypot')).length * 7;
    if (sellTax !== null) score -= Math.min(20, sellTax * 100);
    score = Math.max(0, Math.min(100, Math.round(score)));
    result.riskScore = score;
    result.riskLevel = score >= 75 ? 'low' : score >= 45 ? 'medium' : 'high';
  }

  return new Response(JSON.stringify(result), { status: 200, headers: CORS });
}
