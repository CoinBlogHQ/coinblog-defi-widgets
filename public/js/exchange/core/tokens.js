import { state } from './state.js';
import { clearRoutes, scheduleQuote, setStatus } from '../ui/renderer.js';
import { formatRawBalance, getBal, getBalRawHex, loadBals, loadBalsFast, loadBalsForModal, rawHexToBigInt } from '../execution/balances.js';
import { hydrateMajorTokensForChain, queueTokenLogoHydration, resolveTokenLogosForChain, tokIconEl } from './icons.js';
import { NATIVE, NETWORKS, TOKENS } from './networks.js';
import { esc, isValidAddr } from '../security/goplus.js';
import { updateTokenUI } from './wallet.js';
import { getChainTokens } from './utils.js';

// TOKEN MODAL
// ═══════════════════════════════════════════

export function openTokenModal(side) {
  state.tokModalFor = side;
  const chainId = side === 'from' ? state.fromChainId : state.toChainId;
  const chainName = NETWORKS.find(n => n.id === chainId)?.name || '';
  document.getElementById('tok-modal-title').textContent = side === 'from' ? 'Send Token' : 'Receive Token';
  document.getElementById('tok-modal-sub').textContent = `Tokens on ${chainName}`;
  document.getElementById('tok-modal-overlay').classList.add('open');
  document.getElementById('tok-search').value = '';
  renderTokList('');
  hydrateMajorTokensForChain(chainId).then(() => {
    if (document.getElementById('tok-modal-overlay').classList.contains('open') && state.tokModalFor === side) renderTokList(document.getElementById('tok-search').value || '');
  });
  setTimeout(() => document.getElementById('tok-search').focus(), 80);
  // Load balances only for the curated and recently used tokens.
  if (state.wallet) {
    loadBalsForModal(side);
  }
}
export function closeTokModal(e) {
  if (e && e.target !== document.getElementById('tok-modal-overlay')) return;
  document.getElementById('tok-modal-overlay').classList.remove('open');
}
export function filterTokens() {
  renderTokList(document.getElementById('tok-search').value);
}

// Exact token metadata is resolved through LI.FI and on-chain metadata APIs.
export async function resolveTokenByAddr(addr, chainId) {
  const lower = String(addr || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(lower)) return null;
  let token = null;
  try {
    const response = await fetch(`/api/bridge-token?chainId=${encodeURIComponent(chainId)}&address=${encodeURIComponent(lower)}`, {
      signal: AbortSignal.timeout(12000)
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data?.token?.sym && Number.isInteger(Number(data.token.dec))) token = {
      ...data.token,
      addr: lower,
      dec: Number(data.token.dec),
      cmc: 0,
      custom: true,
      searchOnly: true
    };
  } catch (e) {}
  if (!token) {
    try {
      const response = await fetch(`/api/token-metadata?chainId=${encodeURIComponent(chainId)}&address=${encodeURIComponent(lower)}`, {
        signal: AbortSignal.timeout(12000)
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data?.token?.sym && Number.isInteger(Number(data.token.dec))) token = {
        sym: data.token.sym,
        name: data.token.name || data.token.sym,
        addr: lower,
        dec: Number(data.token.dec),
        cmc: 0,
        logo: data.token.logo || null,
        custom: true,
        searchOnly: true,
        verified: false
      };
    } catch (e) {}
  }
  if (!token) return null;
  try {
    const safetyResponse = await fetch(`/api/token-safety?chainId=${encodeURIComponent(chainId)}&address=${encodeURIComponent(lower)}`, {
      signal: AbortSignal.timeout(10000)
    });
    const safety = await safetyResponse.json().catch(() => null);
    if (safetyResponse.ok && safety) {
      token.riskLevel = safety.riskLevel || 'unknown';
      token.riskWarnings = safety.security?.warnings || [];
      token.security = safety.security || null;
      token.blockedRisk = !!safety.security?.honeypot;
    }
  } catch (e) {}
  resolveTokenLogosForChain(chainId, [token], true).catch(() => {});
  return token;
}
export let _lastResolvedBridgeToken = null;
export function pickResolvedBridgeToken() {
  const tok = _lastResolvedBridgeToken;
  if (!tok) return;
  pickTok(tok.addr, tok.sym, tok.name, tok.dec, tok.logo || '', tok);
}
export function renderTokList(q) {
  const chainId = state.tokModalFor === 'from' ? state.fromChainId : state.toChainId;
  const list = getChainTokens(chainId).length ? getChainTokens(chainId) : getChainTokens(1);
  q = q.trim().toLowerCase();
  const isFullAddr = /^0x[0-9a-f]{40}$/.test(q);
  let filtered = q ? list.filter(t => t.sym.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.addr.toLowerCase().includes(q)) : list;
  queueTokenLogoHydration(chainId, filtered.slice(0, 28), () => {
    const modal = document.getElementById('tok-modal-overlay');
    if (!modal || !modal.classList.contains('open')) return;
    renderTokList(document.getElementById('tok-search')?.value || '');
  });
  // Если полный адрес и не найден в списке - ищем через API
  if (isFullAddr && filtered.length === 0) {
    document.getElementById('tok-list').innerHTML = '<div style="padding:20px;text-align:center;color:rgba(255,255,255,0.4);font-family:\'DM Mono\',monospace;font-size:15px;">🔍 Looking up token...</div>';
    resolveTokenByAddr(q, chainId).then(tok => {
      if (!tok) {
        document.getElementById('tok-list').innerHTML = '<div style="padding:20px;text-align:center;color:rgba(255,255,255,0.4);font-family:\'DM Mono\',monospace;font-size:15px;">Token not found on this network</div>';
        return;
      }
      _lastResolvedBridgeToken = tok;
      const riskText = tok.blockedRisk ? 'Honeypot warning' : tok.riskLevel === 'high' ? 'High-risk token' : tok.verified ? 'Listed in LI.FI verified tokens' : 'Not in LI.FI verified token list';
      document.getElementById('tok-list').innerHTML = `
        <div class="tok-item" role="button" tabindex="0" onclick="pickResolvedBridgeToken()" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();pickResolvedBridgeToken()}">
          ${tokIconEl(tok, 40, chainId)}
          <div class="tok-info">
            <div class="tok-sym2">${esc(tok.sym)}</div>
            <div class="tok-name2">${esc(tok.name)}</div>
            <div class="token-risk">${esc(riskText)} · ${esc(tok.addr.slice(0, 8))}…${esc(tok.addr.slice(-6))}</div>
          </div>
          <div class="tok-bal2"></div>
        </div>`;
    });
    return;
  }
  const rows = filtered.map(t => {
    const rawBal = getBalRawHex(t, chainId);
    const bal = getBal(t, chainId);
    const isLoading = rawBal === null && state.wallet;
    const hasb = rawBal !== null && rawHexToBigInt(rawBal) > 0n;
    const balStr = isLoading ? '...' : rawBal === null ? '' : formatRawBalance(rawBal, t.addr === NATIVE ? 18 : t.dec);
    return `
    <div class="tok-item" role="button" tabindex="0" onclick="pickTok('${esc(t.addr)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();pickTok('${esc(t.addr)}')}">
      ${tokIconEl(t, 40, chainId)}
      <div class="tok-info">
        <div class="tok-sym2">${esc(t.sym)}</div>
        <div class="tok-name2">${esc(t.name)}</div>
      </div>
      <div class="tok-bal2 ${hasb ? 'hasbal' : ''}" id="tbal-${esc(t.addr)}">${balStr}</div>
    </div>`;
  }).join('');
  document.getElementById('tok-list').innerHTML = rows || `<div style="padding:20px;text-align:center;color:var(--muted);font-family:'DM Mono',monospace;font-size:15px;">No tokens found</div>`;
}
export function saveCustomToken(chainId, t) {
  try {
    let saved = JSON.parse(localStorage.getItem('cb_custom_tokens') || '[]');
    if (!saved.find(x => x.chainId === chainId && x.addr.toLowerCase() === t.addr.toLowerCase())) {
      saved.push({
        chainId,
        ...t,
        persistedBySwap: true
      });
      localStorage.setItem('cb_custom_tokens', JSON.stringify(saved));
    }
  } catch (e) {}
}
export function loadCustomTokens() {
  try {
    let saved = JSON.parse(localStorage.getItem('cb_custom_tokens') || '[]');
    saved.forEach(t => {
      if (!TOKENS[t.chainId]) TOKENS[t.chainId] = [];
      if (!TOKENS[t.chainId].find(x => x.addr.toLowerCase() === t.addr.toLowerCase())) {
        TOKENS[t.chainId].push(t);
      }
    });
  } catch (e) {}
}
export function removeCustomTok(e, chainId, addr) {
  e.stopPropagation();
  try {
    let saved = JSON.parse(localStorage.getItem('cb_custom_tokens') || '[]');
    saved = saved.filter(x => !(x.chainId === chainId && x.addr.toLowerCase() === addr.toLowerCase()));
    localStorage.setItem('cb_custom_tokens', JSON.stringify(saved));
    if (TOKENS[chainId]) {
      TOKENS[chainId] = TOKENS[chainId].filter(x => x.addr.toLowerCase() !== addr.toLowerCase());
    }
    document.getElementById('tok-search').dispatchEvent(new Event('input'));
  } catch (err) {}
}
export function pickTok(addr, sym, name, dec, logo, resolvedToken = null) {
  const chainId = state.tokModalFor === 'from' ? state.fromChainId : state.toChainId;
  if (!isValidAddr(addr) && addr !== NATIVE) {
    closeTokModal();
    return;
  }
  // Look in list first
  let t = (TOKENS[chainId] || []).find(x => x.addr.toLowerCase() === addr.toLowerCase());
  if (!t) {
    if (!sym) {
      closeTokModal();
      return;
    }
    // Custom token - build and store so tokIconEl can use logo
    t = {
      ...(resolvedToken || {}),
      addr: addr.toLowerCase(),
      sym,
      name: name || sym,
      dec: Number(dec),
      cmc: 0,
      logo: logo || null,
      custom: true,
      searchOnly: true
    };
    if (!TOKENS[chainId]) TOKENS[chainId] = [];
    TOKENS[chainId].push(t);
    saveCustomToken(chainId, t);
  } else if (logo && !t.logo) {
    t.logo = logo; // update with logo if now available
  }
  if (t.blockedRisk) {
    setStatus('This token is flagged as a honeypot and cannot be used in Bridge.', 'err');
    return;
  }
  if (t.riskLevel === 'high' && !confirm('This token has high-risk security warnings. Continue only if you trust the exact contract address.')) return;
  if (t.custom && !t.verified && !confirm(`This contract is not in the LI.FI verified token list.

${t.addr}

Continue only if you verified the exact address.`)) return;
  if (state.tokModalFor === 'from') state.fromTok = t;else state.toTok = t;
  if (state.tokModalFor === 'from') {
    state._bridgeNeedsApproval = false;
    state._lastBridgeApprove = null;
  }
  document.getElementById('tok-modal-overlay').classList.remove('open');
  updateTokenUI();
  clearRoutes();
  scheduleQuote();
  if (state.wallet) {
    loadBalsFast();
    loadBals();
  } // fast: show balance immediately
}

// ═══════════════════════════════════════════