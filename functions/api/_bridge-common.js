import { isAddr, isSafeHttpUrl } from './_security.js';

export const LIFI_BASE = 'https://li.quest/v1';
export const NATIVE_EEEE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
export const NATIVE_ZERO = '0x0000000000000000000000000000000000000000';

export function isNativeToken(value) {
  const lower = String(value || '').toLowerCase();
  return lower === NATIVE_EEEE || lower === NATIVE_ZERO;
}

export function isValidToken(value) {
  return isAddr(value) || isNativeToken(value);
}

export function toLifiTokenAddress(value) {
  return isNativeToken(value) ? NATIVE_ZERO : String(value || '').toLowerCase();
}

export function isSafeChainId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0;
}

export function isSafeRawAmount(value) {
  return typeof value === 'string' && /^[0-9]{1,80}$/.test(value) && BigInt(value) > 0n;
}

export function safeText(value, max = 160) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
}

export function safeUrl(value) {
  const url = isSafeHttpUrl(value) ? String(value) : '';
  return /^https:\/\//i.test(url) ? url : '';
}

export function rejectCrossSite(request) {
  const site = String(request.headers.get('Sec-Fetch-Site') || '').toLowerCase();
  if (site === 'cross-site') {
    return new Response(JSON.stringify({ error: 'Cross-site request blocked' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
  return null;
}

export async function fetchLifi(path, { env, method = 'GET', body, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${LIFI_BASE}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(env?.LIFI_API_KEY ? { 'x-lifi-api-key': env.LIFI_API_KEY } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeAny(value, depth = 0) {
  if (depth > 14) return null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.slice(0, 25000);
  if (Array.isArray(value)) return value.slice(0, 120).map(item => sanitizeAny(item, depth + 1));
  if (typeof value === 'object') {
    const output = {};
    for (const [key, child] of Object.entries(value).slice(0, 160)) {
      if (!/^[A-Za-z0-9_$-]{1,80}$/.test(key)) continue;
      output[key] = sanitizeAny(child, depth + 1);
    }
    return output;
  }
  return null;
}

export function sanitizeRoute(route) {
  return sanitizeAny(route);
}

export function validateStep(step) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) return 'Invalid step';
  if (!/^[A-Za-z0-9_.:-]{1,180}$/.test(String(step.id || ''))) return 'Invalid step id';
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(step.tool || ''))) return 'Invalid bridge tool';
  const action = step.action;
  if (!action || typeof action !== 'object') return 'Missing step action';
  if (!isSafeChainId(action.fromChainId) || !isSafeChainId(action.toChainId)) return 'Invalid step chains';
  if (!isValidToken(action.fromToken?.address)) return 'Invalid step source token';
  if (!isValidToken(action.toToken?.address)) return 'Invalid step destination token';
  if (!isSafeRawAmount(String(action.fromAmount || ''))) return 'Invalid step amount';
  if (action.fromAddress && !isAddr(action.fromAddress)) return 'Invalid step sender';
  if (action.toAddress && !isAddr(action.toAddress)) return 'Invalid step recipient';
  const approval = step.estimate?.approvalAddress;
  if (approval && !isAddr(approval)) return 'Invalid approval address';
  return '';
}

export function normalizeTxRequest(tx, expectedChainId) {
  if (!tx || typeof tx !== 'object') throw new Error('Missing transaction request');
  if (!isAddr(tx.to)) throw new Error('Invalid transaction target');
  if (typeof tx.data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(tx.data)) throw new Error('Invalid transaction calldata');
  const chainId = Number(tx.chainId ?? expectedChainId);
  if (!isSafeChainId(chainId) || Number(chainId) !== Number(expectedChainId)) throw new Error('Unexpected transaction chain');
  const value = tx.value === undefined ? '0x0' : String(tx.value);
  if (!/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) throw new Error('Invalid transaction value');
  const gasLimit = tx.gasLimit ?? tx.gas;
  if (gasLimit !== undefined && !/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(String(gasLimit))) throw new Error('Invalid gas limit');
  return {
    to: tx.to,
    data: tx.data,
    value,
    chainId,
    ...(gasLimit !== undefined ? { gasLimit: String(gasLimit) } : {}),
  };
}


function stableBridgeValue(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(stableBridgeValue);
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).filter(key => key !== '_bridgeProof' && key !== '_bridgeTicket').sort()) {
      result[key] = stableBridgeValue(value[key]);
    }
    return result;
  }
  return null;
}

function bridgeSigningSecret(env) {
  return String(env?.BRIDGE_SIGNING_SECRET || env?.LIFI_API_KEY || '');
}

async function hmacHex(secret, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function signBridgeStep(step, env) {
  const secret = bridgeSigningSecret(env);
  if (!secret) return '';
  return hmacHex(secret, JSON.stringify(stableBridgeValue(step)));
}

export async function verifyBridgeStep(step, proof, env) {
  const secret = bridgeSigningSecret(env);
  if (!secret) return true;
  if (!/^[0-9a-f]{64}$/i.test(String(proof || ''))) return false;
  const expected = await hmacHex(secret, JSON.stringify(stableBridgeValue(step)));
  const actual = String(proof).toLowerCase();
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return diff === 0;
}


function bridgeTicketRequest(ticket) {
  return new Request(`https://bridge-route-cache.invalid/step/${ticket}`, { method: 'GET' });
}

export async function issueBridgeStepCredential(step, env) {
  const secret = bridgeSigningSecret(env);
  if (secret) return { _bridgeProof: await hmacHex(secret, JSON.stringify(stableBridgeValue(step))) };
  const cache = globalThis.caches?.default;
  if (!cache || !globalThis.crypto?.randomUUID) return null;
  const ticket = crypto.randomUUID().replace(/-/g, '');
  await cache.put(bridgeTicketRequest(ticket), new Response(JSON.stringify(step), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=90' },
  }));
  return { _bridgeTicket: ticket };
}

export async function resolveBridgeStepCredential(step, proof, ticket, env) {
  const secret = bridgeSigningSecret(env);
  if (secret) return (await verifyBridgeStep(step, proof, env)) ? step : null;
  if (!/^[0-9a-f]{32}$/i.test(String(ticket || ''))) return null;
  const cache = globalThis.caches?.default;
  if (!cache) return null;
  const response = await cache.match(bridgeTicketRequest(String(ticket).toLowerCase()));
  if (!response) return null;
  const cached = await response.json().catch(() => null);
  return cached && typeof cached === 'object' && !Array.isArray(cached) ? cached : null;
}
