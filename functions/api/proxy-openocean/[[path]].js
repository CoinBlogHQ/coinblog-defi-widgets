import {
  checkRateLimit,
  getClientIp,
  getCorsHeaders,
  isAddr,
  isNumericString,
  rejectDisallowedOrigin,
} from '../_security.js';
import { allowanceTargetIfNeeded, estimateTransaction, normalizeChainId } from '../_evm-rpc.js';

const BASE = 'https://open-api.openocean.finance';
const RATE_LIMIT = new Map();
const ALLOWED_ACTIONS = new Set(['swap', 'swap_quote', 'quote', 'gasPrice']);
const ALLOWED_CHAINS = new Set([
  '1', '10', '56', '137', '8453', '42161', '43114', '59144', '534352',
  '130', '146', '80094', '5000', '81457', '34443', '999', '1329', '9745', '143', '1776', '324', '4663',
  'eth', 'bsc', 'polygon', 'avax', 'arbitrum', 'optimism', 'base', 'linea', 'scroll', 'unichain', 'uni',
  'sonic', 'berachain', 'bera', 'mantle', 'blast', 'mode', 'hyperevm', 'sei', 'plasma', 'monad', 'injective', 'zksync',
]);
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const DEFAULT_EXCHANGE = '0x6352a56caadC4F1E25CD6c75970Fa768A3304e64';
const EXCHANGE_BY_CHAIN = new Map([
  ['324', '0x36A1aCbbCAfca2468b85011DDD16E7Cb4d673230'],
  ['zksync', '0x36A1aCbbCAfca2468b85011DDD16E7Cb4d673230'],
]);

function json(request, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: getCorsHeaders(request, 'GET, OPTIONS', { 'Cache-Control': 'no-store' }),
  });
}

function isToken(value) {
  return typeof value === 'string' && (value.toLowerCase() === NATIVE || isAddr(value));
}

function isPositiveDecimal(value, maxInteger = 80, maxFraction = 36) {
  if (typeof value !== 'string' || value.length > maxInteger + maxFraction + 1) return false;
  if (!new RegExp(`^(?:0|[1-9][0-9]{0,${maxInteger - 1}})(?:\\.[0-9]{1,${maxFraction}})?$`).test(value)) return false;
  return Number(value) > 0;
}

function parseImpact(value) {
  const parsed = Number(String(value ?? '').replace('%', '').trim());
  return Number.isFinite(parsed) ? Math.abs(parsed) : null;
}

export async function onRequest(context) {
  const { request, params, env } = context;
  const CORS = getCorsHeaders(request, 'GET, OPTIONS', { 'Cache-Control': 'no-store' });

  const blocked = rejectDisallowedOrigin(request, 'GET, OPTIONS');
  if (blocked) return blocked;
  if (request.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS });
  if (request.method !== 'GET') return json(request, { error: 'Method not allowed' }, 405);

  const ip = getClientIp(request);
  if (!checkRateLimit(RATE_LIMIT, ip, 90, 60000)) return json(request, { error: 'Rate limit exceeded' }, 429);

  const path = params.path ? (Array.isArray(params.path) ? params.path.join('/') : String(params.path)) : '';
  const match = /^v(3|4)\/([^/]+)\/([^/]+)$/.exec(path);
  if (!match || !ALLOWED_CHAINS.has(match[2]) || !ALLOWED_ACTIONS.has(match[3])) return json(request, { error: 'Endpoint not allowed' }, 404);

  const version = Number(match[1]);
  const chain = match[2];
  const chainId = normalizeChainId(chain);
  const action = match[3];
  const isSwap = action === 'swap' || action === 'swap_quote';
  const isQuote = action === 'quote';
  const url = new URL(request.url);

  if (isSwap || isQuote) {
    const input = url.searchParams.get('inTokenAddress');
    const output = url.searchParams.get('outTokenAddress');
    const amountKey = version === 3 ? 'amount' : 'amountDecimals';
    const gasKey = version === 3 ? 'gasPrice' : 'gasPriceDecimals';
    const amount = url.searchParams.get(amountKey);
    const gasPrice = url.searchParams.get(gasKey);
    const slippage = Number(url.searchParams.get('slippage') || '1');
    const account = url.searchParams.get('account');
    const sender = url.searchParams.get('sender');
    const minOutput = url.searchParams.get('minOutput');
    const disableRfq = url.searchParams.get('disableRfq');

    if (!isToken(input) || !isToken(output)) return json(request, { error: 'Invalid token address' }, 400);
    if (version === 3) {
      if (!isPositiveDecimal(amount || '')) return json(request, { error: 'Invalid amount' }, 400);
      if (!isPositiveDecimal(gasPrice || '', 30, 18)) return json(request, { error: 'Invalid gasPrice' }, 400);
    } else {
      if (!isNumericString(amount || '') || BigInt(amount) <= 0n) return json(request, { error: 'Invalid amountDecimals' }, 400);
      if (!isNumericString(gasPrice || '') || BigInt(gasPrice) <= 0n) return json(request, { error: 'Invalid gasPriceDecimals' }, 400);
    }
    if (!Number.isFinite(slippage) || slippage < 0.05 || slippage > 5) return json(request, { error: 'Slippage must be between 0.05% and 5%' }, 400);
    if (account && !isAddr(account)) return json(request, { error: 'Invalid account' }, 400);
    if (isSwap && !account) return json(request, { error: 'account is required for swap calldata' }, 400);
    if (sender && !isAddr(sender)) return json(request, { error: 'Invalid sender' }, 400);

    const enabledDexIds = url.searchParams.get('enabledDexIds');
    const disabledDexIds = url.searchParams.get('disabledDexIds');
    const validDexList = value => !value || /^\d+(,\d+)*$/.test(value);
    if (!validDexList(enabledDexIds) || !validDexList(disabledDexIds)) return json(request, { error: 'Invalid DEX ID list' }, 400);
    if (minOutput && !(version === 3 ? isPositiveDecimal(minOutput) : isNumericString(minOutput, 80))) return json(request, { error: 'Invalid minOutput' }, 400);
    if (disableRfq && !['true', 'false', '1', '0'].includes(disableRfq)) return json(request, { error: 'Invalid disableRfq' }, 400);
    if (String(input).toLowerCase() === String(output).toLowerCase()) return json(request, { error: 'Input and output token must differ' }, 400);

    const allowed = new Set([
      'inTokenAddress', 'outTokenAddress', amountKey, gasKey,
      'slippage', 'enabledDexIds', 'disabledDexIds',
      ...(isSwap ? ['account', 'sender', 'minOutput', 'disableRfq'] : []),
    ]);
    for (const key of url.searchParams.keys()) if (!allowed.has(key)) return json(request, { error: `Unsupported parameter: ${key}` }, 400);
  } else if (url.searchParams.size) {
    return json(request, { error: 'gasPrice does not accept query parameters' }, 400);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const upstream = await fetch(`${BASE}/${path}${url.search}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'coinbloghq.com' },
      signal: controller.signal,
    });
    const text = await upstream.text();
    const contentType = upstream.headers.get('content-type') || 'application/json';

    if (upstream.ok && (isSwap || isQuote) && /json/i.test(contentType)) {
      const payload = JSON.parse(text);
      const data = payload?.data;
      if (!data || typeof data !== 'object') return json(request, { error: 'OpenOcean returned no route' }, 502);
      const impact = parseImpact(data.price_impact);
      if (impact !== null && impact > 5) return json(request, { error: 'OpenOcean price impact exceeds 5%' }, 409);

      if (isSwap) {
        if (!chainId) return json(request, { error: 'Unsupported EVM chain for transaction validation' }, 400);
        if (!isAddr(data.to) || typeof data.data !== 'string' || !/^0x[0-9a-fA-F]+$/.test(data.data)) return json(request, { error: 'OpenOcean returned invalid transaction data' }, 502);
        const configured = EXCHANGE_BY_CHAIN.get(chain) || DEFAULT_EXCHANGE;
        const reported = isAddr(data.exchange) ? data.exchange : data.to;
        if (reported.toLowerCase() !== data.to.toLowerCase() && configured.toLowerCase() !== data.to.toLowerCase()) return json(request, { error: 'Unexpected OpenOcean transaction target' }, 502);

        const account = url.searchParams.get('account');
        const inputToken = String(url.searchParams.get('inTokenAddress') || '').toLowerCase();
        const rawInAmount = String(data.inAmount || '');
        const spender = isAddr(reported) ? reported : configured;
        data.allowanceTarget = inputToken === NATIVE
          ? ''
          : await allowanceTargetIfNeeded({
              chainId,
              token: inputToken,
              owner: account,
              spender,
              amount: rawInAmount,
              env,
            });

        const simulation = await estimateTransaction({
          chainId,
          from: account,
          to: data.to,
          data: data.data,
          value: data.value || '0',
          env,
        });
        if (!simulation.ok) return json(request, { error: `OpenOcean simulation failed: ${simulation.error}` }, 409);
        data.estimatedGasRpc = simulation.gas;
        data.simulation = { ok: true };
      }
      return json(request, payload, upstream.status);
    }

    return new Response(text, { status: upstream.status, headers: { ...CORS, 'Content-Type': contentType } });
  } catch (error) {
    if (error?.name === 'AbortError') return json(request, { error: 'Upstream timeout' }, 504);
    return json(request, { error: error?.message || 'OpenOcean proxy failed' }, 502);
  } finally {
    clearTimeout(timer);
  }
}
