import { checkRateLimit, getClientIp, getCorsHeaders, rejectDisallowedOrigin } from './_security.js';
import { fetchLifi, isSafeChainId, rejectCrossSite, safeText, safeUrl } from './_bridge-common.js';

const RATE_LIMIT = new Map();

function pickRpc(chain) {
  const urls = Array.isArray(chain?.metamask?.rpcUrls) ? chain.metamask.rpcUrls : [];
  return urls.find(url => {
    const value = String(url || '');
    return safeUrl(value) && !/[${}<>]/.test(value) && !/YOUR_|API_KEY|PROJECT_ID/i.test(value);
  }) || '';
}

export async function onRequest(context) {
  const { request, env } = context;
  const CORS = getCorsHeaders(request, 'GET, OPTIONS', { 'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=86400' });
  const blocked = rejectDisallowedOrigin(request, 'GET, OPTIONS') || rejectCrossSite(request);
  if (blocked) return blocked;
  if (request.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS });
  if (request.method !== 'GET') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: CORS });
  if (!checkRateLimit(RATE_LIMIT, getClientIp(request), 30, 60000)) return new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: CORS });
  try {
    const upstream = await fetchLifi('/chains?chainTypes=EVM', { env, timeoutMs: 12000 });
    const text = await upstream.text();
    if (!upstream.ok) return new Response(JSON.stringify({ error: 'Chains API unavailable' }), { status: 502, headers: CORS });
    const data = JSON.parse(text);
    const chains = (Array.isArray(data.chains) ? data.chains : [])
      .filter(chain => chain?.chainType === 'EVM' && chain.mainnet !== false && isSafeChainId(chain.id))
      .map(chain => ({
        id: Number(chain.id),
        key: safeText(chain.key, 30),
        name: safeText(chain.name, 80),
        sym: safeText(chain.nativeToken?.symbol || chain.coin || chain.metamask?.nativeCurrency?.symbol, 16),
        decimals: Number(chain.nativeToken?.decimals ?? chain.metamask?.nativeCurrency?.decimals ?? 18),
        icon: safeUrl(chain.logoURI),
        tokenIcon: safeUrl(chain.nativeToken?.logoURI),
        explorer: safeUrl(chain.metamask?.blockExplorerUrls?.[0]),
        rpc: pickRpc(chain),
      }))
      .filter(chain => chain.name && chain.sym && chain.explorer && chain.rpc)
      .sort((a, b) => a.name.localeCompare(b.name));
    return new Response(JSON.stringify({ chains }), { status: 200, headers: CORS });
  } catch (error) {
    const status = error?.name === 'AbortError' ? 504 : 500;
    return new Response(JSON.stringify({ error: status === 504 ? 'Chains API timed out' : 'Internal error' }), { status, headers: CORS });
  }
}
