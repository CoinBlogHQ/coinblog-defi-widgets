import {
  checkRateLimit,
  getClientIp,
  getCorsHeaders,
  isAddr,
  isNumericString,
  rejectDisallowedOrigin,
} from './_security.js';

const ALLOWED_PARAMS = new Set([
  'chainId', 'sellToken', 'buyToken', 'sellAmount', 'buyAmount',
  'slippageBps', 'taker', 'endpoint',
]);
const RATE_LIMIT = new Map();
const SUPPORTED_CHAINS = new Set([1, 10, 56, 137, 8453, 42161, 43114, 130, 534352, 59144, 146, 80094, 5000, 2741, 999, 57073, 143, 9745, 4663, 480]);

function isTokenRef(value) {
  return typeof value === 'string' && (value.toLowerCase() === 'native' || isAddr(value));
}

export async function onRequest(context) {
  const { request, env } = context;
  const CORS = getCorsHeaders(request, 'GET, OPTIONS');

  const blocked = rejectDisallowedOrigin(request, 'GET, OPTIONS');
  if (blocked) return blocked;

  if (request.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS });
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: CORS });
  }

  const ip = getClientIp(request);
  if (!checkRateLimit(RATE_LIMIT, ip, 120, 60000)) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), { status: 429, headers: CORS });
  }

  const apiKey = env.ZEROX_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ error: 'API key not configured' }), { status: 500, headers: CORS });

  const url = new URL(request.url);
  const query = Object.fromEntries(url.searchParams);

  const unknown = Object.keys(query).filter(k => !ALLOWED_PARAMS.has(k));
  if (unknown.length) {
    return new Response(JSON.stringify({ error: `Unknown params: ${unknown.join(', ')}` }), { status: 400, headers: CORS });
  }

  const endpoint = query.endpoint || 'allowance-holder/quote';
  if (!['allowance-holder/quote', 'permit2/quote'].includes(endpoint)) {
    return new Response(JSON.stringify({ error: 'Invalid endpoint' }), { status: 400, headers: CORS });
  }

  const chainId = parseInt(query.chainId || '', 10);
  if (!SUPPORTED_CHAINS.has(chainId)) {
    return new Response(JSON.stringify({ error: 'Unsupported chainId' }), { status: 400, headers: CORS });
  }
  if (!isTokenRef(query.sellToken) || !isTokenRef(query.buyToken)) {
    return new Response(JSON.stringify({ error: 'Invalid token address' }), { status: 400, headers: CORS });
  }
  const amountFields = ['sellAmount', 'buyAmount'].filter(key => query[key] !== undefined && query[key] !== '');
  if (amountFields.length !== 1) {
    return new Response(JSON.stringify({ error: 'Provide exactly one of sellAmount or buyAmount' }), { status: 400, headers: CORS });
  }
  const amountValue = query[amountFields[0]];
  if (!isNumericString(amountValue, 80) || BigInt(amountValue) <= 0n) {
    return new Response(JSON.stringify({ error: `Invalid ${amountFields[0]}` }), { status: 400, headers: CORS });
  }
  if (String(query.sellToken).toLowerCase() === String(query.buyToken).toLowerCase()) {
    return new Response(JSON.stringify({ error: 'Sell and buy token must differ' }), { status: 400, headers: CORS });
  }
  if (query.slippageBps) {
    const slippage = parseInt(query.slippageBps, 10);
    if (Number.isNaN(slippage) || slippage < 1 || slippage > 5000) {
      return new Response(JSON.stringify({ error: 'Invalid slippageBps' }), { status: 400, headers: CORS });
    }
  }
  if (query.taker && !isAddr(query.taker)) {
    return new Response(JSON.stringify({ error: 'Invalid taker address' }), { status: 400, headers: CORS });
  }

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (k !== 'endpoint') params.set(k, v);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(`https://api.0x.org/swap/${endpoint}?${params.toString()}`, {
      headers: {
        '0x-api-key': apiKey,
        '0x-version': 'v2',
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    const text = await r.text();
    return new Response(text, {
      status: r.status,
      headers: { ...CORS, 'Content-Type': r.headers.get('content-type') || 'application/json' },
    });
  } catch (e) {
    const status = e?.name === 'AbortError' ? 504 : 502;
    return new Response(JSON.stringify({ error: e?.name === 'AbortError' ? '0x upstream timeout' : (e.message || '0x proxy failed') }), { status, headers: CORS });
  } finally {
    clearTimeout(timer);
  }
}
