import { state } from '../core/state.js';
import { renderTokList } from '../core/tokens.js';
import { getBalanceCacheKey, lastKnownBalanceCache } from '../core/icons.js';
import { onAmtInput, updateBtnState } from '../ui/renderer.js';
import { _activeProvider } from '../core/wallet.js';
import { NATIVE, NETWORKS, TOKENS } from '../core/networks.js';
import { esc, formatUnitsExact } from '../security/goplus.js';
import { balStorageKey, fetchBalancesViaProxy, getChainTokens } from '../core/utils.js';

// BALANCES
// ═══════════════════════════════════════════

// Apply balances to modal list - only updates tokens explicitly present in balMap
// Does NOT clear tokens missing from balMap (prevents flicker with partial data)
export function applyModalBals(side, balMap, clearMissing = false) {
  const chainId = side === 'from' ? state.fromChainId : state.toChainId;
  const list = getChainTokens(chainId);
  let anyUpdated = false;
  list.forEach(t => {
    const el = document.getElementById('tbal-' + esc(t.addr));
    if (!el) return;
    const key = t.addr === NATIVE ? 'native' : t.addr.toLowerCase();
    // Only update if this token is explicitly in balMap, or clearMissing=true (full refresh)
    if (!(key in balMap) && !clearMissing) return;
    const rawHex = balMap[key];
    const rawValue = rawHexToBigInt(rawHex);
    if (rawValue > 0n) {
      el.textContent = formatRawBalance(rawHex, t.dec === undefined ? 18 : t.dec);
      el.classList.add('hasbal');
      anyUpdated = true;
    } else {
      el.textContent = '';
      el.classList.remove('hasbal');
    }
  });
  // Re-sort only when we actually updated something
  if (anyUpdated && state.tokModalFor === side) {
    const listEl = document.getElementById('tok-list');
    if (!listEl) return;
    const items = [...listEl.querySelectorAll('.tok-item')];
    items.sort((a, b) => {
      const aH = a.querySelector('.tok-bal2')?.classList.contains('hasbal') ? 1 : 0;
      const bH = b.querySelector('.tok-bal2')?.classList.contains('hasbal') ? 1 : 0;
      return bH - aH;
    });
    items.forEach(i => listEl.appendChild(i));
  }
}
export async function loadBalsForModal(side) {
  if (!state.wallet) return;
  const chainId = side === 'from' ? state.fromChainId : state.toChainId;
  const seededList = getChainTokens(chainId);
  if (seededList.length) {
    const cachedMap = {};
    seededList.forEach(t => {
      const key = t.addr === NATIVE ? 'native' : t.addr.toLowerCase();
      const storageKey = balStorageKey(chainId, t.addr);
      if (storageKey in state.bals) cachedMap[key] = state.bals[storageKey];
    });
    if (Object.keys(cachedMap).length > 0) applyModalBals(side, cachedMap);
    const result = await fetchBalancesViaProxy(chainId, seededList);
    if (result?.balances) {
      Object.entries(result.balances).forEach(([key, value]) => {
        const addr = key === 'native' ? NATIVE : key;
        state.bals[balStorageKey(chainId, addr)] = value;
      });
      applyModalBals(side, result.balances, !!result.complete);
      if (state.tokModalFor === side && document.getElementById('tok-modal-overlay').classList.contains('open')) {
        renderTokList(document.getElementById('tok-search')?.value || '');
      }
    }
    if (side === 'from') updateBals();
    if (result?.complete) return;
  }
  const list = TOKENS[chainId] || [];
  const net = NETWORKS.find(n => n.id === chainId);
  if (!net?.rpc) return;
  const paddedWallet = state.wallet.slice(2).padStart(64, '0');

  // ── Step 1: show cached instantly ──
  const cachedMap = {};
  list.forEach(t => {
    const key = t.addr === NATIVE ? 'native' : t.addr.toLowerCase();
    const storageKey = balStorageKey(chainId, t.addr);
    if (storageKey in state.bals) cachedMap[key] = state.bals[storageKey];
  });
  if (Object.keys(cachedMap).length > 0) applyModalBals(side, cachedMap);

  // ── Step 2: fetch each token individually in parallel (no batch - avoids RPC limits) ──
  // Fire all requests at once, apply each result the moment it arrives
  const freshBals = {};
  const requests = list.map(async t => {
    const key = t.addr === NATIVE ? 'native' : t.addr.toLowerCase();
    const storageKey = balStorageKey(chainId, t.addr);
    const req = t.addr === NATIVE ? {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getBalance',
      params: [state.wallet, 'latest']
    } : {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{
        to: t.addr,
        data: '0x70a08231' + paddedWallet
      }, 'latest']
    };
    try {
      const r = await fetch(net.rpc, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(6000)
      });
      const d = await r.json();
      if (d.result && d.result !== '0x' && d.result !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
        freshBals[key] = d.result;
        state.bals[storageKey] = d.result;
        // Show each token balance the moment it arrives - no waiting for all
        applyModalBals(side, {
          [key]: d.result
        });
      }
    } catch (e) {}
  });
  await Promise.allSettled(requests);

  // Final: merge and refresh main balance display
  if (state.tokModalFor === side && document.getElementById('tok-modal-overlay').classList.contains('open')) {
    renderTokList(document.getElementById('tok-search')?.value || '');
  }
  if (side === 'from') updateBals();
}
export async function fetchDirectRawBalance(chainId, tok) {
  if (!state.wallet || !tok) return null;
  const net = NETWORKS.find(item => item.id === Number(chainId));
  if (!net?.rpc) return null;
  const request = tok.addr === NATIVE ? {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getBalance',
    params: [state.wallet, 'latest']
  } : {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{
      to: tok.addr,
      data: '0x70a08231' + state.wallet.slice(2).padStart(64, '0')
    }, 'latest']
  };
  try {
    const response = await fetch(net.rpc, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(7000)
    });
    const data = await response.json();
    return typeof data?.result === 'string' && /^0x[0-9a-fA-F]+$/.test(data.result) ? data.result : null;
  } catch (e) {
    return null;
  }
}

// Fast: fetch only the visible from-token via direct RPC (instant)
export async function loadBalsFast() {
  if (!state.wallet) return;
  const tok = state.fromTok;
  if (!tok) return;
  updateBals();
  try {
    const result = await fetchBalancesViaProxy(state.fromChainId, [tok], 4500);
    let raw = result?.balances?.[tok.addr === NATIVE ? 'native' : tok.addr.toLowerCase()];
    if (!raw) raw = await fetchDirectRawBalance(state.fromChainId, tok);
    if (raw) {
      state.bals[balStorageKey(state.fromChainId, tok.addr)] = raw;
      updateBals();
    }
  } catch (e) {}
}

// Full: all tokens for modal (background)
export async function loadBals() {
  if (!state.wallet) return;
  updateBals();
  loadBalsFast().catch(() => {});
  Promise.resolve().then(async () => {
    const list = getChainTokens(state.fromChainId);
    const result = await fetchBalancesViaProxy(state.fromChainId, list);
    if (result?.balances) {
      Object.entries(result.balances).forEach(([key, value]) => {
        const addr = key === 'native' ? NATIVE : key;
        state.bals[balStorageKey(state.fromChainId, addr)] = value;
      });
    }
    updateBals();
  }).catch(() => {});
}
export function rawHexToBigInt(hex) {
  if (!hex || hex === '0x') return 0n;
  try {
    return BigInt(hex);
  } catch (e) {
    return 0n;
  }
}
export function hexToDec(hex, dec) {
  try {
    return Number(formatUnitsExact(rawHexToBigInt(hex), dec, 12));
  } catch (e) {
    return 0;
  }
}
export function getBalRawHex(tok, chainId = state.fromChainId) {
  if (!tok || !state.wallet) return null;
  const key = balStorageKey(chainId, tok.addr),
    cacheKey = getBalanceCacheKey(tok, chainId);
  const raw = state.bals[key];
  if (raw !== undefined) {
    lastKnownBalanceCache[cacheKey] = raw;
    return raw;
  }
  return Object.prototype.hasOwnProperty.call(lastKnownBalanceCache, cacheKey) ? lastKnownBalanceCache[cacheKey] : null;
}
export function getBal(tok, chainId = state.fromChainId) {
  const raw = getBalRawHex(tok, chainId);
  if (raw === null) return null;
  return hexToDec(raw, tok?.addr === NATIVE ? 18 : Number(tok?.dec ?? 18));
}
export function formatRawBalance(raw, dec) {
  if (raw === null || raw === undefined) return '-';
  const value = rawHexToBigInt(raw);
  if (value === 0n) return '0';
  const exact = formatUnitsExact(value, Number(dec), 8);
  const numeric = Number(exact);
  if (Number.isFinite(numeric) && numeric >= 1000) return numeric.toLocaleString('en-US', {
    maximumFractionDigits: 4
  });
  return exact;
}
export function fmtBal(v) {
  if (v === null || v === undefined) return '-';
  if (v === 0) return '0';
  return v > 0.001 ? v.toFixed(v < 1 ? 4 : 2) : v.toFixed(6);
}
export function updateBals() {
  const raw = getBalRawHex(state.fromTok);
  document.getElementById('send-bal').textContent = formatRawBalance(raw, state.fromTok?.addr === NATIVE ? 18 : Number(state.fromTok?.dec ?? 18));
  if (state.wallet) {
    document.getElementById('receive-bal-wrap').style.display = 'inline';
    loadReceiveBal();
  }
  if (document.getElementById('tok-modal-overlay').classList.contains('open') && state.tokModalFor === 'from') {
    renderTokList(document.getElementById('tok-search')?.value || '');
  }
  updateSendUsd();
}
export async function loadReceiveBal() {
  if (!state.wallet || !state.toTok) return;
  const cacheKey = getBalanceCacheKey(state.toTok, state.toChainId);
  try {
    const result = await fetchBalancesViaProxy(state.toChainId, [state.toTok], 4500);
    let raw = result?.balances?.[state.toTok.addr === NATIVE ? 'native' : state.toTok.addr.toLowerCase()];
    if (!raw) raw = await fetchDirectRawBalance(state.toChainId, state.toTok);
    if (raw) {
      lastKnownBalanceCache[cacheKey] = raw;
      document.getElementById('receive-bal').textContent = formatRawBalance(raw, state.toTok.addr === NATIVE ? 18 : state.toTok.dec);
      return;
    }
  } catch (e) {}
  if (Object.prototype.hasOwnProperty.call(lastKnownBalanceCache, cacheKey)) {
    document.getElementById('receive-bal').textContent = formatRawBalance(lastKnownBalanceCache[cacheKey], state.toTok.addr === NATIVE ? 18 : state.toTok.dec);
  }
}
export const priceCache = {};
export async function getTokenPriceUSD(tok, activeChainId = state.fromChainId) {
  if (!tok) return 0;
  const key = `${activeChainId}:${String(tok.addr || 'native').toLowerCase()}:${tok.cmc || 0}`;
  if (Object.prototype.hasOwnProperty.call(priceCache, key)) return priceCache[key];
  try {
    let price = Number(tok.priceUSD || 0);
    if (tok.cmc) {
      const r = await fetch(`/api/coingecko?ids=${tok.cmc}`, {
        signal: AbortSignal.timeout(8000)
      });
      const d = await r.json();
      price = Number(d?.data?.[tok.cmc]?.quote?.USD?.price || d?.data?.[String(tok.cmc)]?.quote?.USD?.price || 0);
    }
    if (!(price > 0) && tok.addr && tok.addr !== NATIVE) {
      const r = await fetch(`/api/coingecko?address=${tok.addr}&chainId=${activeChainId}`, {
        signal: AbortSignal.timeout(8000)
      });
      const d = await r.json();
      price = Number(d?.[tok.addr.toLowerCase()]?.usd || 0);
    }
    priceCache[key] = price;
    return price;
  } catch (e) {
    return 0;
  }
}
export async function onFromChange() {
  state._bridgeNeedsApproval = false;
  state._lastBridgeApprove = null;
  updateBtnState();
}
export async function updateSendUsd() {
  const amt = parseFloat(document.getElementById('send-amt').value);
  if (!amt || isNaN(amt) || amt <= 0) {
    document.getElementById('send-usd').textContent = '\u2248 $0.00';
    return;
  }
  const price = await getTokenPriceUSD(state.fromTok, state.fromChainId);
  if (!price) return;
  document.getElementById('send-usd').textContent = `\u2248 $${(amt * price).toLocaleString('en-US', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  })}`;
}
export async function estimateNativeReserveRaw(chainId) {
  try {
    const net = NETWORKS.find(n => n.id === chainId);
    const provider = _activeProvider();
    let gasPriceHex = null;
    if (provider) {
      const current = await provider.request({
        method: 'eth_chainId'
      }).catch(() => null);
      if (current && parseInt(current, 16) === chainId) gasPriceHex = await provider.request({
        method: 'eth_gasPrice'
      }).catch(() => null);
    }
    if (!gasPriceHex && net?.rpc) {
      const response = await fetch(net.rpc, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_gasPrice',
          params: []
        }),
        signal: AbortSignal.timeout(5000)
      });
      gasPriceHex = (await response.json()).result;
    }
    if (gasPriceHex) {
      const dynamic = BigInt(gasPriceHex) * 500000n * 13n / 10n;
      const floor = chainId === 1 ? 3000000000000000n : 100000000000000n;
      return dynamic > floor ? dynamic : floor;
    }
  } catch (e) {}
  return chainId === 1 ? 5000000000000000n : 300000000000000n;
}
export function getRawBalance(tok, chainId = state.fromChainId) {
  const hex = state.bals[balStorageKey(chainId, tok?.addr)];
  try {
    return hex ? BigInt(hex) : null;
  } catch (e) {
    return null;
  }
}
export async function setPct(pct) {
  if (!state.fromTok) return;
  const balance = getRawBalance(state.fromTok);
  if (balance === null) return;
  let raw = balance * BigInt(pct) / 100n;
  if (pct === 100 && state.fromTok.addr === NATIVE) {
    const reserve = await estimateNativeReserveRaw(state.fromChainId);
    raw = raw > reserve ? raw - reserve : 0n;
  }
  document.getElementById('send-amt').value = raw > 0n ? formatUnitsExact(raw, state.fromTok.dec, 12) : '';
  onAmtInput();
}

// ═══════════════════════════════════════════