import { checkRateLimit, getClientIp, getCorsHeaders, isAddr, rejectDisallowedOrigin } from './_security.js';
import {
  fetchLifi,
  isSafeChainId,
  isSafeRawAmount,
  isValidToken,
  rejectCrossSite,
  sanitizeRoute,
  issueBridgeStepCredential,
  toLifiTokenAddress,
} from './_bridge-common.js';

const RATE_LIMIT = new Map();
const ROUTE_TTL_SECONDS = 90;

function routeTicketRequest(ticket) {
  return new Request(`https://bridge-route-cache.invalid/route/${ticket}`, { method: 'GET' });
}

async function issueRouteTicket(route) {
  const cache = globalThis.caches?.default;
  if (!cache || !globalThis.crypto?.randomUUID) return '';
  const ticket = crypto.randomUUID().replace(/-/g, '').toLowerCase();
  await cache.put(routeTicketRequest(ticket), new Response(JSON.stringify(route), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${ROUTE_TTL_SECONDS}`,
    },
  }));
  return ticket;
}

export async function onRequest(context) {
  const { request, env } = context;
  const CORS = getCorsHeaders(request, 'GET, OPTIONS', { 'Cache-Control': 'no-store' });
  const blocked = rejectDisallowedOrigin(request, 'GET, OPTIONS') || rejectCrossSite(request);
  if (blocked) return blocked;
  if (request.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS });
  if (request.method !== 'GET') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: CORS });
  if (!checkRateLimit(RATE_LIMIT, getClientIp(request), 24, 60000)) return new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: CORS });

  const url = new URL(request.url);
  const fromChainId = Number(url.searchParams.get('fromChainId'));
  const toChainId = Number(url.searchParams.get('toChainId'));
  const fromToken = String(url.searchParams.get('fromToken') || '').toLowerCase();
  const toToken = String(url.searchParams.get('toToken') || '').toLowerCase();
  const fromAmount = String(url.searchParams.get('fromAmount') || '');
  const fromAddress = String(url.searchParams.get('fromAddress') || '');
  const toAddress = String(url.searchParams.get('toAddress') || fromAddress || '');
  const fromAmountForGas = String(url.searchParams.get('fromAmountForGas') || '');
  const slippage = Number(url.searchParams.get('slippage') || 0.005);

  if (!isSafeChainId(fromChainId) || !isSafeChainId(toChainId) || fromChainId === toChainId) return new Response(JSON.stringify({ error: 'Invalid chain pair' }), { status: 400, headers: CORS });
  if (!isValidToken(fromToken) || !isValidToken(toToken)) return new Response(JSON.stringify({ error: 'Invalid token address' }), { status: 400, headers: CORS });
  if (!isSafeRawAmount(fromAmount)) return new Response(JSON.stringify({ error: 'Invalid amount' }), { status: 400, headers: CORS });
  if (!isAddr(fromAddress)) return new Response(JSON.stringify({ error: 'Valid sender address is required' }), { status: 400, headers: CORS });
  if (toAddress && !isAddr(toAddress)) return new Response(JSON.stringify({ error: 'Invalid recipient address' }), { status: 400, headers: CORS });
  if (fromAmountForGas && (!isSafeRawAmount(fromAmountForGas) || BigInt(fromAmountForGas) >= BigInt(fromAmount))) return new Response(JSON.stringify({ error: 'Invalid destination gas amount' }), { status: 400, headers: CORS });
  if (!Number.isFinite(slippage) || slippage < 0.0001 || slippage > 0.05) return new Response(JSON.stringify({ error: 'Slippage must be between 0.01% and 5%' }), { status: 400, headers: CORS });

  try {
    const body = {
      fromChainId,
      toChainId,
      fromTokenAddress: toLifiTokenAddress(fromToken),
      toTokenAddress: toLifiTokenAddress(toToken),
      fromAmount,
      fromAddress,
      ...(toAddress ? { toAddress } : {}),
      ...(fromAmountForGas ? { fromAmountForGas } : {}),
      options: {
        integrator: 'coinblog',
        slippage,
        order: 'CHEAPEST',
        maxPriceImpact: 0.05,
        allowSwitchChain: false,
        allowDestinationCall: true,
        executionType: 'transaction',
      },
    };
    const upstream = await fetchLifi('/advanced/routes', { env, method: 'POST', body, timeoutMs: 18000 });
    const text = await upstream.text();
    if (!upstream.ok) return new Response(JSON.stringify({ error: 'Bridge API unavailable', status: upstream.status, details: text.slice(0, 500) }), { status: 502, headers: CORS });
    const data = JSON.parse(text);
    const rawRoutes = (Array.isArray(data.routes) ? data.routes : [])
      .filter(route => route && Array.isArray(route.steps) && route.steps.length > 0)
      .slice(0, 8);
    const routes = await Promise.all(rawRoutes.map(async route => {
      const clean = sanitizeRoute(route);
      clean.steps = await Promise.all((clean.steps || []).map(async step => {
        const credential = await issueBridgeStepCredential(step, env);
        if (!credential) throw new Error('Bridge route security is unavailable');
        return { ...step, ...credential };
      }));

      const ticket = await issueRouteTicket(clean);
      if (!ticket) throw new Error('Bridge route cache is unavailable');
      return { ...clean, id: ticket };
    }));
    return new Response(JSON.stringify({ routes, expiresAt: Date.now() + 55000 }), { status: 200, headers: CORS });
  } catch (error) {
    const status = error?.name === 'AbortError' ? 504 : 500;
    return new Response(JSON.stringify({ error: status === 504 ? 'Bridge API timed out' : 'Internal error' }), { status, headers: CORS });
  }
}
