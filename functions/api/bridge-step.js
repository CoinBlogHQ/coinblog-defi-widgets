import { checkRateLimit, getClientIp, getCorsHeaders, isAddr, rejectDisallowedOrigin } from './_security.js';
import { fetchLifi, isNativeToken, normalizeTxRequest, rejectCrossSite, resolveBridgeStepCredential, sanitizeRoute, validateStep } from './_bridge-common.js';

const RATE_LIMIT = new Map();

async function requestPopulatedStep(step, env) {
  let upstream = await fetchLifi('/advanced/stepTransaction', { env, method: 'POST', body: { step }, timeoutMs: 22000 });
  if ((upstream.status === 400 || upstream.status === 422) && upstream.body) {
    await upstream.text().catch(() => '');
    upstream = await fetchLifi('/advanced/stepTransaction', { env, method: 'POST', body: step, timeoutMs: 22000 });
  }
  return upstream;
}

export async function onRequest(context) {
  const { request, env } = context;
  const CORS = getCorsHeaders(request, 'POST, OPTIONS', { 'Cache-Control': 'no-store' });
  const blocked = rejectDisallowedOrigin(request, 'POST, OPTIONS') || rejectCrossSite(request);
  if (blocked) return blocked;
  if (request.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS });
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: CORS });
  if (!checkRateLimit(RATE_LIMIT, getClientIp(request), 16, 60000)) return new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: CORS });
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 600000) return new Response(JSON.stringify({ error: 'Request too large' }), { status: 413, headers: CORS });

  try {
    const payload = await request.json();
    const suppliedStep = payload?.step;
    const proof = suppliedStep?._bridgeProof;
    const ticket = suppliedStep?._bridgeTicket;
    const candidate = suppliedStep && typeof suppliedStep === 'object' ? { ...suppliedStep } : suppliedStep;
    if (candidate && typeof candidate === 'object') { delete candidate._bridgeProof; delete candidate._bridgeTicket; }
    const step = await resolveBridgeStepCredential(candidate, proof, ticket, env);
    if (!step) return new Response(JSON.stringify({ error: 'Route step verification failed or expired. Refresh the route.' }), { status: 400, headers: CORS });
    const validationError = validateStep(step);
    if (validationError) return new Response(JSON.stringify({ error: validationError }), { status: 400, headers: CORS });

    const upstream = await requestPopulatedStep(step, env);
    const text = await upstream.text();
    if (!upstream.ok) return new Response(JSON.stringify({ error: 'Unable to build bridge transaction', status: upstream.status, details: text.slice(0, 700) }), { status: 502, headers: CORS });
    const populated = JSON.parse(text);
    const resultStep = populated?.step || populated;
    const tx = normalizeTxRequest(resultStep.transactionRequest, step.action.fromChainId);
    const approvalAddress = resultStep.estimate?.approvalAddress;
    if (!isNativeToken(step.action.fromToken?.address) && !isAddr(approvalAddress)) {
      return new Response(JSON.stringify({ error: 'LI.FI did not return a valid approval target' }), { status: 502, headers: CORS });
    }
    return new Response(JSON.stringify({
      step: sanitizeRoute({ ...resultStep, transactionRequest: undefined }),
      transactionRequest: tx,
      approvalAddress: isAddr(approvalAddress) ? approvalAddress : null,
    }), { status: 200, headers: CORS });
  } catch (error) {
    const status = error?.name === 'AbortError' ? 504 : 500;
    return new Response(JSON.stringify({ error: status === 504 ? 'Bridge transaction generation timed out' : (error?.message || 'Internal error') }), { status, headers: CORS });
  }
}
