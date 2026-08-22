import { state } from './state.js';
import { NATIVE, TOKENS } from './networks.js';
import { fetchRoutes } from '../ui/renderer.js';

export const IGNORED_TOOLS = new Set(['integrator fee', 'fee collection', 'custom fee', 'integrator-fee', 'lifi', 'bridge']);
export function getPrimaryBridgeTool(route) {
  if (route.isSwap) {
    return {
      name: route.tool || '0x Protocol',
      logo: route.steps?.[0]?.toolDetails?.logoURI || '',
      toolKey: 'swap'
    };
  }
  for (const step of route?.steps || []) {
    const included = Array.isArray(step?.includedSteps) && step.includedSteps.length ? step.includedSteps : [step];
    for (const child of included) {
      const toolKey = String(child?.tool || '').toLowerCase();
      const toolName = String(child?.toolDetails?.name || child?.tool || '').trim();
      if (toolName && !IGNORED_TOOLS.has(toolName.toLowerCase()) && !IGNORED_TOOLS.has(toolKey)) {
        return {
          name: toolName,
          logo: String(child?.toolDetails?.logoURI || ''),
          toolKey: toolKey
        };
      }
    }
  }
  return {
    name: 'Bridge',
    logo: '',
    toolKey: 'bridge'
  };
}

// ═══════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════
export function startQuoteTimer() {
  clearInterval(state.autoRefreshTimer);
  state.quoteTimeLeft = 30;
  const ui = document.getElementById('quote-timer-ui');
  if (ui) ui.textContent = `(Refreshes in ${state.quoteTimeLeft}s)`;
  state.autoRefreshTimer = setInterval(() => {
    state.quoteTimeLeft--;
    if (ui) ui.textContent = `(Refreshes in ${state.quoteTimeLeft}s)`;
    if (state.quoteTimeLeft <= 0) {
      clearInterval(state.autoRefreshTimer);
      if (ui) ui.textContent = 'Refreshing...';
      fetchRoutes();
    }
  }, 1000);
}
export function clearQuoteTimer() {
  clearInterval(state.autoRefreshTimer);
  const ui = document.getElementById('quote-timer-ui');
  if (ui) ui.textContent = '';
}
export function balStorageKey(chainId, addr) {
  const tokenKey = addr === NATIVE ? 'native' : String(addr).toLowerCase();
  return `${chainId}:${tokenKey}`;
}
export const BRIDGE_RECENT_TOKENS_KEY = 'bridge_recent_tokens_v2';
export const BRIDGE_RECENT_CLEANUP_KEY = 'bridge_recent_tokens_cleanup_v2';
export function getChainTokens(chainId) {
  const list = Array.isArray(TOKENS[chainId]) ? TOKENS[chainId] : [];
  const seen = new Set();
  return list.filter(tok => {
    if (!tok || typeof tok !== 'object' || !String(tok.sym || '').trim() || !String(tok.name || '').trim()) return false;
    const addr = String(tok.addr || '').toLowerCase();
    if (addr !== NATIVE && !/^0x[0-9a-f]{40}$/.test(addr)) return false;
    if (seen.has(addr)) return false;
    seen.add(addr);
    return true;
  });
}
export function isDefaultBridgeToken(chainId, address) {
  const addr = typeof address === 'string' ? address.toLowerCase() : String(address?.addr || '').toLowerCase();
  return (TOKENS[chainId] || []).some(tok => !tok.custom && String(tok.addr || '').toLowerCase() === addr);
}
export function validateBridgeCustomToken(tok) {
  if (!tok || typeof tok !== 'object') return false;
  if (!/^[A-Za-z0-9._-]{1,20}$/.test(String(tok.sym || ''))) return false;
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(tok.addr || ''))) return false;
  if (!Number.isInteger(Number(tok.dec)) || Number(tok.dec) < 0 || Number(tok.dec) > 36) return false;
  if (tok.logo && !/^https:\/\//i.test(String(tok.logo))) delete tok.logo;
  return true;
}
export function loadBridgeRecentTokens() {
  try {
    const raw = JSON.parse(localStorage.getItem(BRIDGE_RECENT_TOKENS_KEY) || '{}');
    const cleaned = {};
    for (const [chain, list] of Object.entries(raw || {})) {
      if (!Array.isArray(list)) continue;
      const seen = new Set();
      cleaned[chain] = list.filter(tok => {
        if (!validateBridgeCustomToken(tok)) return false;
        const addr = tok.addr.toLowerCase();
        if (seen.has(addr)) return false;
        seen.add(addr);
        return true;
      }).slice(-30);
      if (!cleaned[chain].length) delete cleaned[chain];
    }
    if (localStorage.getItem(BRIDGE_RECENT_CLEANUP_KEY) !== '1') {
      localStorage.setItem(BRIDGE_RECENT_CLEANUP_KEY, '1');
      localStorage.setItem(BRIDGE_RECENT_TOKENS_KEY, JSON.stringify(cleaned));
    }
    return cleaned;
  } catch (e) {
    localStorage.setItem(BRIDGE_RECENT_TOKENS_KEY, '{}');
    return {};
  }
}
export function mergeBridgeRecentTokens(chainId) {
  const recent = loadBridgeRecentTokens()[chainId] || [];
  if (!TOKENS[chainId]) TOKENS[chainId] = [];
  const byAddr = new Map(TOKENS[chainId].map(tok => [String(tok.addr || '').toLowerCase(), tok]));
  for (const stored of recent) {
    const addr = stored.addr.toLowerCase();
    const existing = byAddr.get(addr);
    if (existing) {
      if (!existing.logo && stored.logo) existing.logo = stored.logo;
      continue;
    }
    const tok = {
      ...stored,
      addr,
      custom: true,
      searchOnly: false,
      persistedByBridge: true
    };
    TOKENS[chainId].push(tok);
    byAddr.set(addr, tok);
  }
}
export function saveConfirmedBridgeToken(chainId, tok) {
  if (!validateBridgeCustomToken(tok) || isDefaultBridgeToken(chainId, tok)) return;
  const all = loadBridgeRecentTokens();
  const list = all[chainId] || [];
  const addr = tok.addr.toLowerCase();
  const next = {
    ...tok,
    addr,
    custom: true,
    searchOnly: false,
    persistedByBridge: true,
    lastUsedAt: Date.now()
  };
  const idx = list.findIndex(item => String(item.addr || '').toLowerCase() === addr);
  if (idx >= 0) list[idx] = {
    ...list[idx],
    ...next
  };else list.push(next);
  all[chainId] = list.sort((a, b) => Number(a.lastUsedAt || 0) - Number(b.lastUsedAt || 0)).slice(-30);
  localStorage.setItem(BRIDGE_RECENT_TOKENS_KEY, JSON.stringify(all));
  tok.searchOnly = false;
  tok.persistedByBridge = true;
}
export function rememberHistoryTokens(item) {
  if (!item || item.status !== 'confirmed') return;
  for (const snap of item.tokenSnapshots || []) {
    if (snap && snap.custom) saveConfirmedBridgeToken(Number(snap.chainId), snap);
  }
}
export async function fetchBalancesViaProxy(chainId, tokens, timeoutMs = 12000) {
  if (!state.wallet || !tokens?.length) return null;
  const effectiveTimeoutMs = Number(chainId) === 4663 ? Math.max(timeoutMs, 25000) : timeoutMs;
  const erc20s = [...new Set(tokens.filter(tok => tok && tok.addr && tok.addr !== NATIVE).map(tok => tok.addr.toLowerCase()))];
  try {
    const merged = {};
    const metaList = [];
    const chunks = erc20s.length ? Array.from({
      length: Math.ceil(erc20s.length / 60)
    }, (_, i) => erc20s.slice(i * 60, (i + 1) * 60)) : [[]];
    for (const chunk of chunks) {
      const qs = new URLSearchParams({
        wallet: state.wallet,
        chainId: String(chainId)
      });
      if (chunk.length) qs.set('tokens', chunk.join(','));
      const r = await fetch(`/api/token-balances?${qs.toString()}`, {
        signal: AbortSignal.timeout(effectiveTimeoutMs)
      });
      if (!r.ok) throw new Error(`token-balances ${r.status}`);
      const d = await r.json();
      Object.assign(merged, d?.balances || {});
      if (d?.meta) metaList.push(d.meta);
    }
    const complete = metaList.length ? metaList.every(meta => meta?.complete) : false;
    return Object.keys(merged).length ? {
      balances: merged,
      complete,
      metaList
    } : null;
  } catch (e) {
    return null;
  }
}

// ═══════════════════════════════════════════