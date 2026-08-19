const ALLOWED_ORIGINS = new Set([
  'https://coinbloghq.com',
  'https://www.coinbloghq.com',
  // Keep the previous production origins during the migration so existing
  // clients are not broken before the old domain redirect is fully propagated.
  'https://coinbloghq.com',
  'https://coinbloghq.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://localhost:8788',
  'http://127.0.0.1:8788',
]);

export function getCorsHeaders(request, methods = 'GET, OPTIONS', extra = {}) {
  const origin = request.headers.get('origin');
  const headers = {
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

export function rejectDisallowedOrigin(request, methods = 'GET, OPTIONS') {
  const origin = request.headers.get('origin');
  if (!origin || ALLOWED_ORIGINS.has(origin)) return null;
  return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
    status: 403,
    headers: getCorsHeaders(request, methods),
  });
}

export function getClientIp(request) {
  return request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || 'unknown';
}

export function checkRateLimit(store, ip, limit, windowMs = 60000, maxEntries = 5000) {
  const now = Date.now();
  const entry = store.get(ip) || { count: 0, reset: now + windowMs };
  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + windowMs;
  }
  entry.count++;
  store.set(ip, entry);
  if (store.size > maxEntries) store.clear();
  return entry.count <= limit;
}

export function isAddr(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function isTxHash(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

export function isHexData(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value);
}

export function isSafeHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

export function isNumericString(value, maxDigits = 80) {
  return typeof value === 'string' && new RegExp(`^[0-9]{1,${maxDigits}}$`).test(value);
}

export function clampText(value, max = 120) {
  if (typeof value !== 'string') return '';
  return value.slice(0, max);
}
