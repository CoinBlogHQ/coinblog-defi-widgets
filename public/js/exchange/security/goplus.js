import { state } from '../core/state.js';

// SECURITY HELPERS
// ═══════════════════════════════════════════
export function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
export function isValidAddr(addr) {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}
export function isValidTxHash(h) {
  return /^0x[0-9a-fA-F]{64}$/.test(h);
}
export function normalizeDecimalInput(value) {
  const raw = String(value ?? '').trim().replace(',', '.');
  return /^\d*(?:\.\d*)?$/.test(raw) ? raw : '';
}
export function validateAmount(value) {
  const raw = normalizeDecimalInput(value);
  return !!raw && /[1-9]/.test(raw) && raw.length <= 100;
}
export function parseUnitsExact(value, decimals) {
  const raw = normalizeDecimalInput(value);
  if (!raw || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('Invalid token amount');
  const [whole = '0', fraction = ''] = raw.split('.');
  if (fraction.length > decimals) throw new Error(`Too many decimal places. ${decimals} maximum.`);
  const digits = (whole || '0') + fraction.padEnd(decimals, '0');
  const normalized = digits.replace(/^0+(?=\d)/, '') || '0';
  return BigInt(normalized);
}
export function formatUnitsExact(value, decimals, maxDecimals = 8) {
  const raw = BigInt(value || 0);
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let fraction = (abs % base).toString().padStart(decimals, '0').slice(0, Math.max(0, maxDecimals)).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? '.' + fraction : ''}`;
}
export function getSendRawAmount() {
  return parseUnitsExact(document.getElementById('send-amt').value, Number(state.fromTok?.dec ?? 18));
}
export function parseSendAmt() {
  const raw = normalizeDecimalInput(document.getElementById('send-amt').value);
  return Number(raw || 0);
}

// ═══════════════════════════════════════════