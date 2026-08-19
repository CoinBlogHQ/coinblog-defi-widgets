import { checkRateLimit, getClientIp, getCorsHeaders, isAddr, rejectDisallowedOrigin } from './_security.js';
import { fetchLifi, isNativeToken, isSafeChainId, rejectCrossSite, safeText, safeUrl } from './_bridge-common.js';

const RATE_LIMIT = new Map();
const PRIORITY = new Map(['USDC','USDT','USDT0','DAI','WETH','WBTC','BTC','ETH','BNB','POL','MATIC','AVAX'].map((key, index) => [key, index]));

function tokenListForChain(data, chainId) {
  const root = data?.tokens && typeof data.tokens === 'object' ? data.tokens : data;
  return Array.isArray(root?.[String(chainId)]) ? root[String(chainId)] : [];
}

function normalizeToken(token, chainId) {
  const address = String(token?.address || '').toLowerCase();
  if ((!isAddr(address) && !isNativeToken(address)) || Number(token?.chainId) !== chainId) return null;
  const decimals = Number(token?.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const symbol = safeText(token.symbol, 20);
  if (!symbol) return null;
  return {
    addr: isNativeToken(address) ? '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' : address,
    sym: symbol,
    name: safeText(token.name || symbol, 80),
    dec: decimals,
    logo: safeUrl(token.logoURI),
    priceUSD: Number.isFinite(Number(token.priceUSD)) ? Number(token.priceUSD) : null,
    coinKey: safeText(token.coinKey, 30),
    verified: true,
  };
}

export async function onRequest(context) {
  const { request, env } = context;
  const CORS = getCorsHeaders(request, 'GET, OPTIONS', { 'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=86400' });
  const blocked = rejectDisallowedOrigin(request, 'GET, OPTIONS') || rejectCrossSite(request);
  if (blocked) return blocked;
  if (request.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS });
  if (request.method !== 'GET') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: CORS });
  if (!checkRateLimit(RATE_LIMIT, getClientIp(request), 30, 60000)) return new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: CORS });

  const chainId = Number(new URL(request.url).searchParams.get('chainId'));
  if (!isSafeChainId(chainId)) return new Response(JSON.stringify({ error: 'Invalid chain ID' }), { status: 400, headers: CORS });
  try {
    const upstream = await fetchLifi(`/tokens?chains=${encodeURIComponent(chainId)}`, { env, timeoutMs: 15000 });
    const text = await upstream.text();
    if (!upstream.ok) return new Response(JSON.stringify({ error: 'Token list unavailable' }), { status: 502, headers: CORS });
    const list = tokenListForChain(JSON.parse(text), chainId)
      .map(token => normalizeToken(token, chainId))
      .filter(Boolean);
    const selected = list
      .filter(token => token.addr === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' || PRIORITY.has(String(token.coinKey || token.sym).toUpperCase()) || ['USDC','USDT','DAI','WETH','WBTC'].includes(token.sym.toUpperCase()))
      .sort((a, b) => {
        if (a.addr === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') return -1;
        if (b.addr === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') return 1;
        return (PRIORITY.get(String(a.coinKey || a.sym).toUpperCase()) ?? 99) - (PRIORITY.get(String(b.coinKey || b.sym).toUpperCase()) ?? 99);
      })
      .filter((token, index, all) => all.findIndex(other => other.addr === token.addr) === index)
      .slice(0, 12);
    return new Response(JSON.stringify({ tokens: selected }), { status: 200, headers: CORS });
  } catch (error) {
    const status = error?.name === 'AbortError' ? 504 : 500;
    return new Response(JSON.stringify({ error: status === 504 ? 'Token list timed out' : 'Internal error' }), { status, headers: CORS });
  }
}
