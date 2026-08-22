import {
  checkRateLimit,
  getClientIp,
  getCorsHeaders,
  isAddr,
  isHexData,
  isNumericString,
  rejectDisallowedOrigin,
} from './_security.js';
import { allowanceTargetIfNeeded, estimateTransaction } from './_evm-rpc.js';

const RATE_LIMIT = new Map();
const SUPPORTED = new Set([1, 10, 56, 100, 130, 137, 146, 8453, 42161, 43114, 9745]);
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const QUOTE_TTL_MS = 30000;

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isTokenRef(value) {
  return typeof value === 'string' && (value.toLowerCase() === 'native' || value.toLowerCase() === NATIVE || isAddr(value));
}

function minAmount(amount, slippageBps) {
  const raw = BigInt(amount);
  return ((raw * BigInt(10000 - slippageBps)) / 10000n).toString();
}

function priceImpact(route) {
  const srcUsd = Number(route?.srcUSD || 0);
  const destUsd = Number(route?.destUSD || 0);
  if (srcUsd > 0 && destUsd >= 0) return Math.max(0, ((srcUsd - destUsd) / srcUsd) * 100);
  return null;
}

export async function onRequest(context) {
  const { request, env } = context;
  const CORS = getCorsHeaders(request, 'GET, OPTIONS', { 'Cache-Control': 'no-store' });
  const blocked = rejectDisallowedOrigin(request, 'GET, OPTIONS');
  if (blocked) return blocked;
  if (request.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS });
  if (request.method !== 'GET') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: CORS });
  if (!checkRateLimit(RATE_LIMIT, getClientIp(request), 90, 60000)) return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), { status: 429, headers: CORS });

  const url = new URL(request.url);
  const { chainId, srcToken, destToken, amount, srcDecimals, destDecimals, slippageBps, taker } = Object.fromEntries(url.searchParams);
  const cid = parseInt(chainId, 10);
  if (!SUPPORTED.has(cid)) return new Response(JSON.stringify({ error: `Chain ${chainId} not supported by ParaSwap` }), { status: 400, headers: CORS });
  if (!isTokenRef(srcToken) || !isTokenRef(destToken)) return new Response(JSON.stringify({ error: 'Invalid token address' }), { status: 400, headers: CORS });
  if (String(srcToken).toLowerCase() === String(destToken).toLowerCase()) return new Response(JSON.stringify({ error: 'Source and destination token must differ' }), { status: 400, headers: CORS });
  if (!isNumericString(amount)) return new Response(JSON.stringify({ error: 'Invalid amount' }), { status: 400, headers: CORS });
  if (!isNumericString(srcDecimals || '', 3) || !isNumericString(destDecimals || '', 3)) return new Response(JSON.stringify({ error: 'Invalid token decimals' }), { status: 400, headers: CORS });

  const srcDec = parseInt(srcDecimals, 10);
  const destDec = parseInt(destDecimals, 10);
  if (srcDec < 0 || srcDec > 36 || destDec < 0 || destDec > 36) return new Response(JSON.stringify({ error: 'Unsupported token decimals' }), { status: 400, headers: CORS });
  const slipBps = parseInt(slippageBps || '50', 10);
  if (Number.isNaN(slipBps) || slipBps < 1 || slipBps > 500) return new Response(JSON.stringify({ error: 'Slippage must be between 0.01% and 5%' }), { status: 400, headers: CORS });
  if (taker && !isAddr(taker)) return new Response(JSON.stringify({ error: 'Invalid taker address' }), { status: 400, headers: CORS });

  try {
    const generatedAt = Date.now();
    const priceParams = new URLSearchParams({
      srcToken, destToken, amount, srcDecimals, destDecimals,
      side: 'SELL', network: String(cid), maxImpact: '5', version: '6.2',
    });
    if (taker) priceParams.set('userAddress', taker);

    const priceResponse = await fetchWithTimeout(`https://api.paraswap.io/prices?${priceParams.toString()}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'coinbloghq.com' },
    });
    const priceData = await priceResponse.json();
    if (!priceResponse.ok || !priceData.priceRoute) return new Response(JSON.stringify({ error: priceData.error || priceData.message || 'No route' }), { status: 400, headers: CORS });

    const route = priceData.priceRoute;
    const impact = priceImpact(route);
    if (impact !== null && impact > 5) return new Response(JSON.stringify({ error: 'ParaSwap price impact exceeds 5%' }), { status: 409, headers: CORS });
    const allowanceTarget = isAddr(route.tokenTransferProxy) ? route.tokenTransferProxy : null;
    if (!allowanceTarget) return new Response(JSON.stringify({ error: 'ParaSwap did not provide a verified tokenTransferProxy' }), { status: 502, headers: CORS });
    const userAddr = taker && taker.length > 5 ? taker : null;

    let transaction = null;
    let transactionError = '';
    if (userAddr) {
      try {
        const txResponse = await fetchWithTimeout(`https://api.paraswap.io/transactions/${cid}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'coinbloghq.com' },
          body: JSON.stringify({
            srcToken, destToken, srcAmount: amount, srcDecimals: srcDec, destDecimals: destDec,
            priceRoute: route, userAddress: userAddr, slippage: slipBps, ignoreChecks: false,
          }),
        });
        const txData = await txResponse.json();
        if (txResponse.ok && isAddr(txData.to) && isHexData(txData.data)) {
          transaction = {
            to: txData.to,
            data: txData.data,
            value: txData.value || '0',
            gas: txData.gas,
            gasPrice: txData.gasPrice,
            maxFeePerGas: txData.maxFeePerGas,
            maxPriorityFeePerGas: txData.maxPriorityFeePerGas,
          };
          const simulation = await estimateTransaction({
            chainId: cid,
            from: userAddr,
            to: transaction.to,
            data: transaction.data,
            value: transaction.value || '0x0',
            env,
          });
          if (!simulation.ok) {
            transaction = null;
            transactionError = `Simulation failed: ${simulation.error}`;
          } else if (!transaction.gas) {
            transaction.gas = simulation.gas;
          }
        } else {
          transactionError = txData?.error || txData?.message || 'Transaction requires allowance or refreshed route';
        }
      } catch (error) {
        transactionError = error?.message || 'Transaction build failed';
      }
    }

    const srcIsNative = String(srcToken).toLowerCase() === 'native' || String(srcToken).toLowerCase() === NATIVE;
    const effectiveAllowanceTarget = srcIsNative || !userAddr
      ? ''
      : await allowanceTargetIfNeeded({
          chainId: cid,
          token: srcToken,
          owner: userAddr,
          spender: allowanceTarget,
          amount,
          env,
        });

    const fills = route.bestRoute?.flatMap(part =>
      (part?.swaps || []).flatMap(swap =>
        (swap?.swapExchanges || []).map(exchange => ({
          name: typeof exchange.exchange === 'string' ? exchange.exchange.slice(0, 80) : 'Unknown',
          proportion: Number(exchange.percent || 0) / 100,
        })),
      ),
    ) || [];

    return new Response(JSON.stringify({
      quoteId: String(route.blockNumber || route.hmac || `${cid}-${generatedAt}`),
      generatedAt,
      expiresAt: generatedAt + QUOTE_TTL_MS,
      buyAmount: String(route.destAmount),
      minBuyAmount: minAmount(String(route.destAmount), slipBps),
      sellAmount: amount,
      estimatedPriceImpact: impact,
      gas: transaction?.gas || route.gasCost || null,
      gasPrice: transaction?.gasPrice || null,
      gasCostUSD: Number.isFinite(Number(route.gasCostUSD)) ? Number(route.gasCostUSD) : null,
      transaction,
      transactionError,
      allowanceTarget: effectiveAllowanceTarget,
      route: { fills },
      sources: fills,
      fees: null,
      issues: transactionError ? { transaction: transactionError } : null,
    }), { status: 200, headers: CORS });
  } catch (error) {
    return new Response(JSON.stringify({ error: error?.message || 'ParaSwap quote failed' }), { status: 500, headers: CORS });
  }
}
