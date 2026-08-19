import { checkRateLimit, getClientIp, getCorsHeaders, isAddr, rejectDisallowedOrigin } from './_security.js';
import { fetchLifi, isSafeChainId, rejectCrossSite, safeText, safeUrl } from './_bridge-common.js';

const RATE_LIMIT = new Map();

function tokenListForChain(data, chainId) {
  const root = data?.tokens && typeof data.tokens === 'object' ? data.tokens : data;
  return Array.isArray(root?.[String(chainId)]) ? root[String(chainId)] : [];
}

export async function onRequest(context) {
  const { request, env } = context;
  const CORS = getCorsHeaders(request, 'GET, OPTIONS', { 'Cache-Control': 'public, s-maxage=300' });
  const blocked = rejectDisallowedOrigin(request, 'GET, OPTIONS') || rejectCrossSite(request);
  if (blocked) return blocked;
  if (request.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS });
  if (request.method !== 'GET') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: CORS });
  if (!checkRateLimit(RATE_LIMIT, getClientIp(request), 50, 60000)) return new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: CORS });

  const url = new URL(request.url);
  const chainId = Number(url.searchParams.get('chainId'));
  const address = String(url.searchParams.get('address') || '').toLowerCase();
  if (!isSafeChainId(chainId) || !isAddr(address)) return new Response(JSON.stringify({ error: 'Invalid chain or token address' }), { status: 400, headers: CORS });
  try {
    const [tokenUpstream, listUpstream] = await Promise.all([
      fetchLifi(`/token?chain=${encodeURIComponent(chainId)}&token=${encodeURIComponent(address)}`, { env, timeoutMs: 10000 }),
      fetchLifi(`/tokens?chains=${encodeURIComponent(chainId)}`, { env, timeoutMs: 12000 }).catch(() => null),
    ]);
    const text = await tokenUpstream.text();
    if (!tokenUpstream.ok) return new Response(JSON.stringify({ error: 'Token not found' }), { status: tokenUpstream.status === 404 ? 404 : 502, headers: CORS });
    const token = JSON.parse(text);
    if (Number(token.chainId) !== chainId || String(token.address || '').toLowerCase() !== address || !Number.isInteger(Number(token.decimals))) {
      return new Response(JSON.stringify({ error: 'Invalid token metadata' }), { status: 502, headers: CORS });
    }
    let verified = false;
    if (listUpstream?.ok) {
      const listData = await listUpstream.json().catch(() => null);
      verified = tokenListForChain(listData, chainId).some(item => String(item?.address || '').toLowerCase() === address);
    }
    return new Response(JSON.stringify({ token: {
      addr: address,
      sym: safeText(token.symbol, 20),
      name: safeText(token.name || token.symbol, 80),
      dec: Number(token.decimals),
      logo: safeUrl(token.logoURI),
      priceUSD: Number.isFinite(Number(token.priceUSD)) ? Number(token.priceUSD) : null,
      coinKey: safeText(token.coinKey, 30),
      verified,
    } }), { status: 200, headers: CORS });
  } catch (error) {
    const status = error?.name === 'AbortError' ? 504 : 500;
    return new Response(JSON.stringify({ error: status === 504 ? 'Token lookup timed out' : 'Internal error' }), { status, headers: CORS });
  }
}
