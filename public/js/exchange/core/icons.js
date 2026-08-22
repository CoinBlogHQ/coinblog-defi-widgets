import { setWCOptionalChains, setWCRpcMap } from './networks.js';
import { state } from './state.js';
import { mergeBridgeRecentTokens, rememberHistoryTokens } from './utils.js';
import { WC_OPTIONAL_CHAINS, WC_RPC_MAP } from './networks.js';
import { esc, isValidTxHash } from '../security/goplus.js';
import { NATIVE, NETWORKS, TOKENS } from './networks.js';
import { pollBridgeStatus } from '../execution/tracker.js';

// ICON HELPERS
// ═══════════════════════════════════════════
export function tokIcon(cmc) {
  return cmc ? `https://s2.coinmarketcap.com/static/img/coins/64x64/${cmc}.png` : '';
}
export const tokenLogoCache = {};
export const lastKnownBalanceCache = {};
export const TOKEN_ICON_PROXY_VERSION = '20260408-1';
export function isLegacyTokenIconUrl(url) {
  const raw = String(url || '').trim();
  return raw.startsWith('/api/token-icons?image=1') && !/[?&]url=/.test(raw);
}
export function proxyTokenImageUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (isLegacyTokenIconUrl(raw)) return '';
  if (raw.startsWith('/api/token-icons?image=1')) return raw;
  if (/^https?:\/\//i.test(raw)) return `/api/token-icons?image=1&v=${TOKEN_ICON_PROXY_VERSION}&url=${encodeURIComponent(raw)}`;
  return raw;
}
export function getTokenLogoKey(chainId, tok) {
  const addr = String(tok?.addr || '').toLowerCase();
  return `${chainId}:${addr}`;
}
export function primeTokenLogo(chainId, tok, url) {
  const next = String(url || '').trim();
  if (!tok || !next || isLegacyTokenIconUrl(next)) return false;
  tok.logo = next;
  tokenLogoCache[getTokenLogoKey(chainId, tok)] = next;
  return true;
}
export function getRenderableTokenIconUrl(tok, activeChainId = state.fromChainId) {
  if (tok?.cmc) return proxyTokenImageUrl(tokIcon(tok.cmc));
  const explicit = proxyTokenImageUrl(tok?.logo || '');
  if (explicit) return explicit;
  return '';
}
export const DEX_CHAIN_IDS_BRIDGE = {
  1: 'ethereum',
  8453: 'base',
  42161: 'arbitrum',
  10: 'optimism',
  137: 'polygon',
  56: 'bsc',
  130: 'unichain',
  81457: 'blast',
  534352: 'scroll',
  59144: 'linea',
  5000: 'mantle',
  34443: 'mode',
  43114: 'avalanche',
  250: 'fantom',
  4663: 'robinhood'
};
export const CHAIN_BLOCKSCOUT_BASES = {
  1: 'https://eth.blockscout.com',
  8453: 'https://base.blockscout.com',
  42161: 'https://arbitrum.blockscout.com',
  10: 'https://optimism.blockscout.com',
  137: 'https://polygon.blockscout.com',
  56: 'https://bsc.blockscout.com',
  130: 'https://unichain.blockscout.com',
  81457: 'https://blast.blockscout.com',
  534352: 'https://scroll.blockscout.com',
  59144: 'https://explorer.linea.build',
  5000: 'https://explorer.mantle.xyz',
  34443: 'https://explorer.mode.network',
  4663: 'https://robinhoodchain.blockscout.com'
};
export async function fetchBlockscoutTokenLogo(chainId, tok) {
  const addr = String(tok?.addr || '').toLowerCase();
  const base = CHAIN_BLOCKSCOUT_BASES[chainId];
  if (!base || !addr || addr === NATIVE) return '';
  try {
    const r = await fetch(`${base}/api/v2/tokens/${addr}`, {
      signal: AbortSignal.timeout(7000)
    });
    if (!r.ok) return '';
    const data = await r.json();
    return String(data?.icon_url || '').trim();
  } catch {
    return '';
  }
}
export async function fetchDexscreenerTokenLogo(chainId, tok) {
  const addr = String(tok?.addr || '').toLowerCase();
  const dexChain = DEX_CHAIN_IDS_BRIDGE[chainId] || '';
  if (!addr || addr === NATIVE) return '';
  try {
    const r = await fetch(`/api/proxy-dexscreener/latest/dex/tokens/${addr}`, {
      signal: AbortSignal.timeout(7000)
    });
    if (!r.ok) return '';
    const data = await r.json();
    let best = '',
      bestLiq = -1;
    for (const pair of data?.pairs || []) {
      if (dexChain && String(pair?.chainId || '').toLowerCase() !== dexChain) continue;
      const icon = String(pair?.info?.imageUrl || '').trim();
      if (!icon) continue;
      const liq = Number(pair?.liquidity?.usd || 0);
      if (liq > bestLiq) {
        bestLiq = liq;
        best = icon;
      }
    }
    return best;
  } catch {
    return '';
  }
}
export async function resolveTokenLogosForChain(chainId, tokens, force = false) {
  const list = [...new Map((tokens || []).filter(Boolean).map(tok => [String(tok.addr || '').toLowerCase(), tok])).values()];
  const pending = [];
  let changed = false;
  for (const tok of list) {
    if (!tok || !tok.addr) continue;
    const key = getTokenLogoKey(chainId, tok);
    if (!force && tok.logo) {
      tokenLogoCache[key] = tok.logo;
      continue;
    }
    if (!force && tok.cmc && !tok.logo) continue;
    if (!force && Object.prototype.hasOwnProperty.call(tokenLogoCache, key)) {
      const cached = tokenLogoCache[key];
      if (cached && !tok.logo) {
        tok.logo = cached;
        changed = true;
      }
      continue;
    }
    pending.push(tok);
  }
  if (!pending.length) return changed;
  // Step 1: Trust Wallet asset list via /api/token-icons (curated, fast)
  try {
    const qs = new URLSearchParams({
      chainId: String(chainId),
      tokens: pending.map(tok => tok.addr === NATIVE ? 'native' : tok.addr).join(',')
    });
    const res = await fetch(`/api/token-icons?${qs.toString()}`, {
      signal: AbortSignal.timeout(10000)
    });
    if (res.ok) {
      const data = await res.json();
      const icons = data?.icons || {};
      for (const tok of pending) {
        const key = getTokenLogoKey(chainId, tok);
        const icon = String(icons[key] || '').trim();
        if (icon && primeTokenLogo(chainId, tok, icon)) {
          tokenLogoCache[key] = icon;
          changed = true;
        }
      }
    }
  } catch {}
  // Step 2: Blockscout then Dexscreener fallback for tokens still without logo
  const unresolved = pending.filter(tok => !tok.logo && tok.addr !== NATIVE);
  if (unresolved.length) {
    const batchSize = 6;
    for (let i = 0; i < unresolved.length; i += batchSize) {
      const batch = unresolved.slice(i, i + batchSize);
      await Promise.all(batch.map(async tok => {
        let found = await fetchBlockscoutTokenLogo(chainId, tok);
        if (!found) found = await fetchDexscreenerTokenLogo(chainId, tok);
        if (found) {
          const key = getTokenLogoKey(chainId, tok);
          if (primeTokenLogo(chainId, tok, found)) {
            tokenLogoCache[key] = found;
            changed = true;
          }
        }
      }));
    }
  }
  return changed;
}
export function queueTokenLogoHydration(chainId, tokens, rerender) {
  resolveTokenLogosForChain(chainId, tokens).then(changed => {
    if (!changed) return;
    if (typeof rerender === 'function') rerender();
  }).catch(() => {});
}
export function getBalanceCacheKey(tok, chainId) {
  return `${chainId}:${String(tok?.addr || '').toLowerCase()}`;
}
export function letterAvatarHTML(sym, size = 32) {
  const colors = ['#ff007a', '#9b51e0', '#00dc82', '#fbbf24', '#3b82f6', '#38bdf8'];
  const col = colors[esc(sym).charCodeAt(0) % colors.length];
  return `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${col}22;border:1.5px solid ${col}55;display:flex;align-items:center;justify-content:center;font-size:${Math.round(size * 0.35)}px;font-weight:900;color:${col};flex-shrink:0;">${esc(sym.slice(0, 2).toUpperCase())}</div>`;
}
export function chainIconHTML(net, size = 28) {
  return `<img style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;flex-shrink:0;" src="${esc(net.icon)}" onerror="chainImgFallback(this,'${esc(net.sym)}',${size})" alt="">`;
}
export function chainImgFallback(el, sym, size) {
  const div = document.createElement('div');
  div.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;background:#38bdf822;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:900;color:#38bdf8;flex-shrink:0;`;
  div.textContent = sym.slice(0, 2).toUpperCase();
  el.replaceWith(div);
}
export function tokIconEl(tok, size = 32, activeChainId = state.fromChainId) {
  const src = getRenderableTokenIconUrl(tok, activeChainId);
  if (src) return `<img style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;flex-shrink:0;" src="${src}" onerror="imgFallback(this,'${esc(tok.sym)}',${size})" alt="">`;
  return letterAvatarHTML(tok.sym, size);
}
export function imgFallback(el, sym, size) {
  const div = document.createElement('div');
  div.innerHTML = letterAvatarHTML(sym, size);
  el.replaceWith(div.firstChild);
}
export async function loadSupportedBridgeChains() {
  try {
    const response = await fetch('/api/bridge-chains', {
      signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) return;
    const data = await response.json();
    if (!Array.isArray(data?.chains)) return;
    const byId = new Map(NETWORKS.map(net => [net.id, net]));
    for (const chain of data.chains) {
      if (!Number.isSafeInteger(Number(chain.id)) || !chain.name || !chain.rpc || !chain.explorer) continue;
      const id = Number(chain.id);
      const existing = byId.get(id);
      const merged = {
        ...(existing || {}),
        id,
        name: String(chain.name).slice(0, 80),
        sym: String(chain.sym || existing?.sym || 'ETH').slice(0, 16),
        decimals: Number.isInteger(Number(chain.decimals)) ? Number(chain.decimals) : 18,
        icon: String(chain.icon || existing?.icon || ''),
        explorer: String(chain.explorer || existing?.explorer || '').replace(/\/$/, ''),
        rpc: String(chain.rpc || existing?.rpc || ''),
        currency: String(chain.sym || existing?.currency || existing?.sym || 'ETH').slice(0, 16)
      };
      if (existing) Object.assign(existing, merged);else {
        NETWORKS.push(merged);
        byId.set(id, merged);
      }
      if (!TOKENS[id]?.length) {
        TOKENS[id] = [{
          sym: merged.sym,
          name: merged.sym,
          addr: NATIVE,
          dec: merged.decimals,
          cmc: 0,
          logo: String(chain.tokenIcon || chain.icon || '')
        }];
      } else if (TOKENS[id][0]?.addr === NATIVE && chain.tokenIcon && !TOKENS[id][0].logo) {
        TOKENS[id][0].logo = String(chain.tokenIcon);
      }
      mergeBridgeRecentTokens(id);
    }
    NETWORKS.sort((a, b) => a.name.localeCompare(b.name));
    setWCOptionalChains(NETWORKS.map(net => net.id));
    setWCRpcMap(Object.fromEntries(NETWORKS.map(net => [net.id, net.rpc])));
  } catch (e) {}
}
export const bridgeTokenHydration = new Map();
export async function hydrateMajorTokensForChain(chainId) {
  const id = Number(chainId);
  if (bridgeTokenHydration.has(id)) return bridgeTokenHydration.get(id);
  const task = (async () => {
    try {
      const response = await fetch(`/api/bridge-tokens?chainId=${encodeURIComponent(id)}`, {
        signal: AbortSignal.timeout(18000)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(data.tokens)) return;
      if (!TOKENS[id]) TOKENS[id] = [];
      const byAddress = new Map(TOKENS[id].map(token => [String(token.addr || '').toLowerCase(), token]));
      for (const raw of data.tokens) {
        const address = String(raw.addr || '').toLowerCase();
        if (address !== NATIVE && !/^0x[0-9a-f]{40}$/.test(address)) continue;
        if (!Number.isInteger(Number(raw.dec)) || !String(raw.sym || '').trim()) continue;
        const normalized = {
          addr: address,
          sym: String(raw.sym).slice(0, 20),
          name: String(raw.name || raw.sym).slice(0, 80),
          dec: Number(raw.dec),
          logo: /^https:\/\//i.test(String(raw.logo || '')) ? String(raw.logo) : '',
          priceUSD: Number.isFinite(Number(raw.priceUSD)) ? Number(raw.priceUSD) : null,
          coinKey: String(raw.coinKey || '').slice(0, 30),
          verified: true,
          cmc: 0
        };
        const existing = byAddress.get(address);
        if (existing) {
          if (!existing.logo && normalized.logo) existing.logo = normalized.logo;
          existing.verified = true;
          if (normalized.priceUSD !== null) existing.priceUSD = normalized.priceUSD;
          if (!existing.coinKey && normalized.coinKey) existing.coinKey = normalized.coinKey;
        } else {
          TOKENS[id].push(normalized);
          byAddress.set(address, normalized);
        }
      }
      mergeBridgeRecentTokens(id);
    } catch (e) {}
  })();
  bridgeTokenHydration.set(id, task);
  return task;
}
export function resumePendingBridgeHistory() {
  for (const item of state.txHistory) {
    if (item?.status === 'pending' && isValidTxHash(item.hash)) pollBridgeStatus(item.hash, item.statusFromChainId || item.fromChainId, item.statusToChainId || item.toChainId, item.bridge || '', {
      silent: true
    });
    if (item?.status === 'confirmed') rememberHistoryTokens(item);
  }
}

// ══════════════�����════════════════════════════