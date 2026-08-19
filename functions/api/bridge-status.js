import { checkRateLimit, getClientIp, getCorsHeaders, isTxHash, rejectDisallowedOrigin } from './_security.js';
import { fetchLifi, isSafeChainId, rejectCrossSite, safeText, safeUrl } from './_bridge-common.js';

const RATE_LIMIT = new Map();

function tokenView(token) {
  if (!token || typeof token !== 'object') return null;
  return {
    address: safeText(token.address, 80),
    symbol: safeText(token.symbol, 24),
    name: safeText(token.name, 100),
    decimals: Number.isFinite(Number(token.decimals)) ? Number(token.decimals) : null,
    chainId: isSafeChainId(token.chainId) ? Number(token.chainId) : null,
    logoURI: safeUrl(token.logoURI),
  };
}

function txView(tx) {
  if (!tx || typeof tx !== 'object') return null;
  return {
    txHash: isTxHash(tx.txHash) ? tx.txHash : null,
    chainId: isSafeChainId(tx.chainId) ? Number(tx.chainId) : null,
    amount: typeof tx.amount === 'string' && /^[0-9]+$/.test(tx.amount) ? tx.amount : null,
    amountUSD: Number.isFinite(Number(tx.amountUSD)) ? Number(tx.amountUSD) : null,
    txLink: safeUrl(tx.txLink),
    timestamp: Number.isFinite(Number(tx.timestamp)) ? Number(tx.timestamp) : null,
    token: tokenView(tx.token),
  };
}

export async function onRequest(context) {
  const { request, env } = context;
  const CORS = getCorsHeaders(request, 'GET, OPTIONS', { 'Cache-Control': 'no-store' });
  const blocked = rejectDisallowedOrigin(request, 'GET, OPTIONS') || rejectCrossSite(request);
  if (blocked) return blocked;
  if (request.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS });
  if (request.method !== 'GET') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: CORS });
  if (!checkRateLimit(RATE_LIMIT, getClientIp(request), 90, 60000)) return new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: CORS });

  const url = new URL(request.url);
  const txHash = String(url.searchParams.get('txHash') || '');
  if (!isTxHash(txHash)) return new Response(JSON.stringify({ error: 'Invalid txHash' }), { status: 400, headers: CORS });
  const params = new URLSearchParams({ txHash });
  const bridge = String(url.searchParams.get('bridge') || '');
  const fromChain = Number(url.searchParams.get('fromChain'));
  const toChain = Number(url.searchParams.get('toChain'));
  if (/^[A-Za-z0-9_-]{1,80}$/.test(bridge)) params.set('bridge', bridge);
  if (isSafeChainId(fromChain)) params.set('fromChain', String(fromChain));
  if (isSafeChainId(toChain)) params.set('toChain', String(toChain));

  try {
    const upstream = await fetchLifi(`/status?${params}`, { env, timeoutMs: 10000 });
    const text = await upstream.text();
    if (!upstream.ok) return new Response(JSON.stringify({ error: 'Status API error', status: upstream.status, details: text.slice(0, 300) }), { status: 502, headers: CORS });
    const data = JSON.parse(text);
    return new Response(JSON.stringify({
      status: safeText(data.status || 'PENDING', 30),
      substatus: safeText(data.substatus || '', 80),
      substatusMessage: safeText(data.substatusMessage || '', 300),
      sending: txView(data.sending),
      receiving: txView(data.receiving),
      lifiExplorerLink: safeUrl(data.lifiExplorerLink || data.explorerLink),
      tool: safeText(data.tool || bridge, 80),
    }), { status: 200, headers: CORS });
  } catch (error) {
    const status = error?.name === 'AbortError' ? 504 : 500;
    return new Response(JSON.stringify({ error: status === 504 ? 'Status API timed out' : 'Internal error' }), { status, headers: CORS });
  }
}
