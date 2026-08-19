import {
  checkRateLimit,
  getClientIp,
  getCorsHeaders,
  isAddr,
  isNumericString,
  rejectDisallowedOrigin,
} from '../_security.js';
import { allowanceTargetIfNeeded, estimateTransaction } from '../_evm-rpc.js';

const BASE = 'https://api.odos.xyz';
const RATE_LIMIT = new Map();
const ALLOWED_PATHS = new Set(['sor/quote/v2', 'sor/quote/v3', 'sor/assemble']);
const MAX_BODY_BYTES = 64 * 1024;
const QUOTE_TTL_SECONDS = 90;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function isTokenAddress(value) {
  return typeof value === 'string' && (value.toLowerCase() === ZERO_ADDRESS || isAddr(value));
}

function quoteMetaRequest(pathId) {
  return new Request(`https://odos-quote-cache.invalid/path/${encodeURIComponent(pathId)}`, { method: 'GET' });
}

async function saveQuoteMeta(pathId, meta) {
  const cache = globalThis.caches?.default;
  if (!cache || !pathId) return;
  await cache.put(quoteMetaRequest(pathId), new Response(JSON.stringify(meta), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${QUOTE_TTL_SECONDS}`,
    },
  }));
}

async function loadQuoteMeta(pathId) {
  const cache = globalThis.caches?.default;
  if (!cache || !pathId) return null;
  const response = await cache.match(quoteMetaRequest(pathId));
  if (!response) return null;
  return response.json().catch(() => null);
}

function validateQuoteBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Invalid quote body';
  if (!Number.isInteger(body.chainId) || body.chainId <= 0 || body.chainId > 2147483647) return 'Invalid chainId';
  if (!Array.isArray(body.inputTokens) || body.inputTokens.length < 1 || body.inputTokens.length > 4) return 'Invalid inputTokens';
  if (!Array.isArray(body.outputTokens) || body.outputTokens.length < 1 || body.outputTokens.length > 4) return 'Invalid outputTokens';
  for (const token of body.inputTokens) {
    if (!isTokenAddress(token?.tokenAddress) || !isNumericString(String(token?.amount || ''), 80) || BigInt(token.amount) <= 0n) return 'Invalid input token';
  }
  let proportionTotal = 0;
  for (const token of body.outputTokens) {
    const proportion = Number(token?.proportion);
    if (!isTokenAddress(token?.tokenAddress) || !Number.isFinite(proportion) || proportion <= 0 || proportion > 1) return 'Invalid output token';
    proportionTotal += proportion;
  }
  if (Math.abs(proportionTotal - 1) > 0.000001) return 'Output proportions must total 1';
  if (body.userAddr !== undefined && body.userAddr !== null && body.userAddr !== '' && !isAddr(body.userAddr)) return 'Invalid userAddr';
  const slippage = Number(body.slippageLimitPercent);
  if (!Number.isFinite(slippage) || slippage < 0.01 || slippage > 5) return 'Slippage must be between 0.01% and 5%';
  if (body.compact !== undefined && typeof body.compact !== 'boolean') return 'Invalid compact value';
  return '';
}

function validateAssembleBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Invalid assemble body';
  if (!isAddr(body.userAddr)) return 'Invalid userAddr';
  if (typeof body.pathId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(body.pathId)) return 'Invalid pathId';
  if (body.simulate !== true) return 'Odos assembly must include simulation';
  return '';
}

function json(request, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: getCorsHeaders(request, 'POST, OPTIONS', { 'Cache-Control': 'no-store' }),
  });
}

function simulationFailed(simulation) {
  if (!simulation || typeof simulation !== 'object') return true;
  if (simulation.isSuccess === false || simulation.success === false) return true;
  if (simulation.error || simulation.errorMessage) return true;
  return false;
}

export async function onRequest(context) {
  const { request, params, env } = context;
  const CORS = getCorsHeaders(request, 'POST, OPTIONS', { 'Cache-Control': 'no-store' });

  const blocked = rejectDisallowedOrigin(request, 'POST, OPTIONS');
  if (blocked) return blocked;
  if (request.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS });
  if (request.method !== 'POST') return json(request, { error: 'Method not allowed' }, 405);

  const ip = getClientIp(request);
  if (!checkRateLimit(RATE_LIMIT, ip, 60, 60000)) return json(request, { error: 'Rate limit exceeded' }, 429);

  const path = params.path ? (Array.isArray(params.path) ? params.path.join('/') : String(params.path)) : '';
  if (!ALLOWED_PATHS.has(path)) return json(request, { error: 'Endpoint not allowed' }, 404);

  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_BODY_BYTES) return json(request, { error: 'Request body too large' }, 413);
  const bodyText = await request.text();
  if (new TextEncoder().encode(bodyText).byteLength > MAX_BODY_BYTES) return json(request, { error: 'Request body too large' }, 413);

  let parsedBody;
  try {
    parsedBody = JSON.parse(bodyText || '{}');
  } catch {
    return json(request, { error: 'Invalid JSON body' }, 400);
  }
  const validationError = path.startsWith('sor/quote/') ? validateQuoteBody(parsedBody) : validateAssembleBody(parsedBody);
  if (validationError) return json(request, { error: validationError }, 400);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18000);
  try {
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'primus-stat.xyz',
    };
    if (env?.ODOS_API_KEY) headers['x-api-key'] = env.ODOS_API_KEY;

    const upstream = await fetch(`${BASE}/${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(parsedBody),
      signal: controller.signal,
    });
    const text = await upstream.text();
    if (!upstream.ok) return new Response(text, {
      status: upstream.status,
      headers: { ...CORS, 'Content-Type': upstream.headers.get('content-type') || 'application/json' },
    });

    const payload = JSON.parse(text);
    if (path.startsWith('sor/quote/')) {
      const pathId = String(payload?.pathId || '');
      if (!pathId) return json(request, { error: 'Odos returned no route' }, 502);
      const impact = Math.abs(Number(payload?.priceImpact || 0));
      if (Number.isFinite(impact) && impact > 5) return json(request, { error: 'Odos price impact exceeds 5%' }, 409);
      const input = parsedBody.inputTokens[0];
      await saveQuoteMeta(pathId, {
        chainId: parsedBody.chainId,
        userAddr: parsedBody.userAddr,
        inputToken: input.tokenAddress,
        inputAmount: String(input.amount),
        generatedAt: Date.now(),
      });
      payload.generatedAt = Date.now();
      payload.expiresAt = Date.now() + 55000;
      return json(request, payload, 200);
    }

    const meta = await loadQuoteMeta(parsedBody.pathId);
    if (!meta || meta.userAddr?.toLowerCase() !== parsedBody.userAddr.toLowerCase()) {
      return json(request, { error: 'Odos quote expired. Refresh routes.' }, 409);
    }
    const transaction = payload?.transaction;
    if (!transaction || !isAddr(transaction.to) || typeof transaction.data !== 'string' || !/^0x[0-9a-fA-F]+$/.test(transaction.data)) {
      return json(request, { error: 'Odos returned invalid transaction data' }, 502);
    }

    const native = String(meta.inputToken || '').toLowerCase() === ZERO_ADDRESS;
    const allowanceTarget = native
      ? ''
      : await allowanceTargetIfNeeded({
          chainId: meta.chainId,
          token: meta.inputToken,
          owner: meta.userAddr,
          spender: transaction.to,
          amount: meta.inputAmount,
          env,
        });
    transaction.allowanceTarget = allowanceTarget;

    if (!allowanceTarget) {
      if (simulationFailed(payload.simulation)) {
        return json(request, { error: payload?.simulation?.errorMessage || payload?.simulation?.error || 'Odos simulation failed' }, 409);
      }
      const rpcSimulation = await estimateTransaction({
        chainId: meta.chainId,
        from: meta.userAddr,
        to: transaction.to,
        data: transaction.data,
        value: transaction.value || '0',
        env,
      });
      if (!rpcSimulation.ok) return json(request, { error: `Odos RPC simulation failed: ${rpcSimulation.error}` }, 409);
      transaction.gas = transaction.gas || rpcSimulation.gas;
    }

    payload.expiresAt = Date.now() + 45000;
    payload.quoteId = parsedBody.pathId;
    return json(request, payload, 200);
  } catch (error) {
    if (error?.name === 'AbortError') return json(request, { error: 'Upstream timeout' }, 504);
    return json(request, { error: error?.message || 'Odos proxy failed' }, 502);
  } finally {
    clearTimeout(timer);
  }
}
