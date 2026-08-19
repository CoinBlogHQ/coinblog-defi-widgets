import { checkRateLimit, getClientIp, getCorsHeaders, isAddr, rejectDisallowedOrigin } from './_security.js';
import {
  fetchLifi,
  isNativeToken,
  isSafeChainId,
  isSafeRawAmount,
  isValidToken,
  normalizeTxRequest,
  rejectCrossSite,
  safeText,
  toLifiTokenAddress,
  validateStep,
} from './_bridge-common.js';
import { allowanceTargetIfNeeded, estimateTransaction } from './_evm-rpc.js';

const RATE_LIMIT = new Map();

function routeTicketRequest(ticket) {
  return new Request(`https://bridge-route-cache.invalid/route/${ticket}`, { method: 'GET' });
}

async function resolveRouteTicket(ticket) {
  if (!/^[0-9a-f]{32}$/i.test(String(ticket || ''))) return null;
  const cache = globalThis.caches?.default;
  if (!cache) return null;
  const response = await cache.match(routeTicketRequest(String(ticket).toLowerCase()));
  if (!response) return null;
  const route = await response.json().catch(() => null);
  return route && typeof route === 'object' && !Array.isArray(route) ? route : null;
}

async function requestPopulatedStep(step, env) {
  let upstream = await fetchLifi('/advanced/stepTransaction', { env, method: 'POST', body: { step }, timeoutMs: 22000 });
  if (upstream.status === 400 || upstream.status === 422) {
    await upstream.text().catch(() => '');
    upstream = await fetchLifi('/advanced/stepTransaction', { env, method: 'POST', body: step, timeoutMs: 22000 });
  }
  return upstream;
}

function sameToken(a, b) {
  return toLifiTokenAddress(a).toLowerCase() === toLifiTokenAddress(b).toLowerCase();
}

function routeMatchesRequest(step, requestData) {
  const action = step?.action;
  if (!action) return false;
  if (Number(action.fromChainId) !== requestData.fromChainId || Number(action.toChainId) !== requestData.toChainId) return false;
  if (!sameToken(action.fromToken?.address, requestData.fromToken) || !sameToken(action.toToken?.address, requestData.toToken)) return false;
  if (String(action.fromAmount || '') !== requestData.fromAmount) return false;
  if (action.fromAddress && String(action.fromAddress).toLowerCase() !== requestData.fromAddress.toLowerCase()) return false;
  if (action.toAddress && String(action.toAddress).toLowerCase() !== requestData.toAddress.toLowerCase()) return false;
  return true;
}

async function validateApprovalAndSimulation({ token, amount, owner, approvalAddress, tx, chainId, env }) {
  const native = isNativeToken(token);
  const effectiveApproval = native
    ? ''
    : await allowanceTargetIfNeeded({
        chainId,
        token,
        owner,
        spender: approvalAddress,
        amount,
        env,
      });

  if (!effectiveApproval) {
    const simulation = await estimateTransaction({
      chainId,
      from: owner,
      to: tx.to,
      data: tx.data,
      value: tx.value,
      env,
    });
    if (!simulation.ok) throw new Error(`Bridge simulation failed: ${simulation.error}`);
    if (!tx.gasLimit) tx.gasLimit = simulation.gas;
  }

  return effectiveApproval;
}

async function exactSelectedRouteResponse({ routeTicket, requestData, env, CORS }) {
  const route = await resolveRouteTicket(routeTicket);
  if (!route) return new Response(JSON.stringify({ error: 'Selected bridge route expired. Refresh routes.' }), { status: 409, headers: CORS });

  const suppliedStep = Array.isArray(route.steps) ? route.steps[0] : null;
  const step = suppliedStep && typeof suppliedStep === 'object' ? { ...suppliedStep } : null;
  if (step) {
    delete step._bridgeProof;
    delete step._bridgeTicket;
  }
  const validationError = validateStep(step);
  if (validationError) return new Response(JSON.stringify({ error: validationError }), { status: 400, headers: CORS });
  if (!routeMatchesRequest(step, requestData)) {
    return new Response(JSON.stringify({ error: 'Selected bridge route no longer matches the requested transfer.' }), { status: 409, headers: CORS });
  }

  const upstream = await requestPopulatedStep(step, env);
  const text = await upstream.text();
  if (!upstream.ok) return new Response(JSON.stringify({ error: 'Unable to build selected bridge route', status: upstream.status, details: text.slice(0, 700) }), { status: 502, headers: CORS });
  const populated = JSON.parse(text);
  const resultStep = populated?.step || populated;
  const tx = normalizeTxRequest(resultStep.transactionRequest, requestData.fromChainId);
  const approvalAddress = resultStep.estimate?.approvalAddress;
  if (!isNativeToken(step.action.fromToken?.address) && !isAddr(approvalAddress)) {
    return new Response(JSON.stringify({ error: 'LI.FI did not return a valid approval target' }), { status: 502, headers: CORS });
  }

  let effectiveApproval;
  try {
    effectiveApproval = await validateApprovalAndSimulation({
      token: step.action.fromToken?.address,
      amount: step.action.fromAmount,
      owner: requestData.fromAddress,
      approvalAddress,
      tx,
      chainId: requestData.fromChainId,
      env,
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 409, headers: CORS });
  }

  return new Response(JSON.stringify({
    tool: safeText(resultStep.tool || route.tool || resultStep.toolDetails?.name || 'bridge', 80),
    transactionRequest: tx,
    estimate: resultStep.estimate || step.estimate || null,
    approvalAddress: effectiveApproval,
    selectedRouteTicket: routeTicket,
    expiresAt: Date.now() + 45000,
  }), { status: 200, headers: CORS });
}

export async function onRequest(context) {
  const { request, env } = context;
  const CORS = getCorsHeaders(request, 'GET, OPTIONS', { 'Cache-Control': 'no-store' });
  const blocked = rejectDisallowedOrigin(request, 'GET, OPTIONS') || rejectCrossSite(request);
  if (blocked) return blocked;
  if (request.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS });
  if (request.method !== 'GET') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: CORS });
  if (!checkRateLimit(RATE_LIMIT, getClientIp(request), 12, 60000)) return new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: CORS });

  const url = new URL(request.url);
  const fromChainId = Number(url.searchParams.get('fromChainId'));
  const toChainId = Number(url.searchParams.get('toChainId'));
  const fromToken = String(url.searchParams.get('fromToken') || '').toLowerCase();
  const toToken = String(url.searchParams.get('toToken') || '').toLowerCase();
  const rawFromAddress = String(url.searchParams.get('fromAddress') || '');
  const separator = rawFromAddress.indexOf('|');
  const fromAddress = separator > 0 ? rawFromAddress.slice(0, separator) : rawFromAddress;
  const routeTicket = separator > 0 ? rawFromAddress.slice(separator + 1) : '';
  const fromAmount = String(url.searchParams.get('fromAmount') || '');
  const toAddress = String(url.searchParams.get('toAddress') || fromAddress || '');
  const fromAmountForGas = String(url.searchParams.get('fromAmountForGas') || '');
  const slippage = Number(url.searchParams.get('slippage') || 0.005);

  if (!isSafeChainId(fromChainId) || !isSafeChainId(toChainId) || fromChainId === toChainId) return new Response(JSON.stringify({ error: 'Invalid chain pair' }), { status: 400, headers: CORS });
  if (!isValidToken(fromToken) || !isValidToken(toToken) || !isSafeRawAmount(fromAmount)) return new Response(JSON.stringify({ error: 'Invalid token or amount' }), { status: 400, headers: CORS });
  if (!isAddr(fromAddress) || !isAddr(toAddress)) return new Response(JSON.stringify({ error: 'Valid sender and recipient are required' }), { status: 400, headers: CORS });
  if (routeTicket && !/^[0-9a-f]{32}$/i.test(routeTicket)) return new Response(JSON.stringify({ error: 'Invalid selected route ticket' }), { status: 400, headers: CORS });
  if (fromAmountForGas && (!isSafeRawAmount(fromAmountForGas) || BigInt(fromAmountForGas) >= BigInt(fromAmount))) return new Response(JSON.stringify({ error: 'Invalid destination gas amount' }), { status: 400, headers: CORS });
  if (!Number.isFinite(slippage) || slippage < 0.0001 || slippage > 0.05) return new Response(JSON.stringify({ error: 'Slippage must be between 0.01% and 5%' }), { status: 400, headers: CORS });

  const requestData = { fromChainId, toChainId, fromToken, toToken, fromAmount, fromAddress, toAddress };

  try {
    if (routeTicket) return await exactSelectedRouteResponse({ routeTicket, requestData, env, CORS });

    const params = new URLSearchParams({
      fromChain: String(fromChainId), toChain: String(toChainId), fromToken: toLifiTokenAddress(fromToken), toToken: toLifiTokenAddress(toToken),
      fromAmount, fromAddress, toAddress, slippage: String(slippage), integrator: 'primus-analytics',
      maxPriceImpact: '0.05', allowDestinationCall: 'true', skipSimulation: 'false', order: 'CHEAPEST',
    });
    if (fromAmountForGas) params.set('fromAmountForGas', fromAmountForGas);

    const upstream = await fetchLifi(`/quote?${params}`, { env, timeoutMs: 20000 });
    const text = await upstream.text();
    if (!upstream.ok) return new Response(JSON.stringify({ error: 'Bridge API error', status: upstream.status, details: text.slice(0, 500) }), { status: 502, headers: CORS });
    const data = JSON.parse(text);
    const tx = normalizeTxRequest(data.transactionRequest, fromChainId);
    const approvalAddress = data.estimate?.approvalAddress;
    if (!isNativeToken(fromToken) && !isAddr(approvalAddress)) {
      return new Response(JSON.stringify({ error: 'LI.FI did not return a valid approval target' }), { status: 502, headers: CORS });
    }
    let effectiveApproval;
    try {
      effectiveApproval = await validateApprovalAndSimulation({
        token: fromToken,
        amount: fromAmount,
        owner: fromAddress,
        approvalAddress,
        tx,
        chainId: fromChainId,
        env,
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 409, headers: CORS });
    }
    return new Response(JSON.stringify({
      tool: safeText(data.tool || data.toolDetails?.name || 'bridge', 80),
      transactionRequest: tx,
      estimate: data.estimate || null,
      approvalAddress: effectiveApproval,
      expiresAt: Date.now() + 45000,
    }), { status: 200, headers: CORS });
  } catch (error) {
    const status = error?.name === 'AbortError' ? 504 : 500;
    return new Response(JSON.stringify({ error: status === 504 ? 'Bridge API timed out' : (error?.message || 'Internal error') }), { status, headers: CORS });
  }
}
