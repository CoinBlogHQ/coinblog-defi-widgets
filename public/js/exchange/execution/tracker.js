import { state } from '../core/state.js';
import { rememberHistoryTokens } from '../core/utils.js';
import { fmtAmt, setStatus } from '../ui/renderer.js';
import { init } from '../core/wallet.js';
import { esc, isValidTxHash } from '../security/goplus.js';
import { NATIVE, NETWORKS } from '../core/networks.js';
import { loadBals } from './balances.js';

// PROGRESS AND STATUS
// ═══════════════════════════════════════════
export function showProgress(txHash, customTitle = '') {
  const wrap = document.getElementById('progress-wrap');
  wrap.classList.add('show');
  const isSwap = state.fromChainId === state.toChainId;
  const titleEl = wrap.querySelector('.prog-title');
  if (titleEl) {
    titleEl.textContent = isSwap ? '⚡ Swap in progress…' : '🔗 Bridge in progress…';
  }

  // Update step labels
  const steps = wrap.querySelectorAll('.prog-step');
  const lines = wrap.querySelectorAll('.prog-line');
  if (isSwap) {
    if (steps[0]) steps[0].querySelector('.prog-label').textContent = state.fromTok.addr === NATIVE ? 'Ready' : 'Approve';
    if (steps[1]) steps[1].querySelector('.prog-label').textContent = 'Swap';
    if (steps[2]) steps[2].querySelector('.prog-label').textContent = 'Done';
    if (steps[3]) steps[3].style.display = 'none';
    if (lines[2]) lines[2].style.display = 'none';
  } else {
    if (steps[0]) steps[0].querySelector('.prog-label').textContent = 'Approved';
    if (steps[1]) steps[1].querySelector('.prog-label').textContent = 'Sent';
    if (steps[2]) steps[2].querySelector('.prog-label').textContent = 'Bridging';
    if (steps[3]) {
      steps[3].style.display = 'flex';
      steps[3].querySelector('.prog-label').textContent = 'Done';
    }
    if (lines[2]) lines[2].style.display = 'block';
  }
  for (let i = 0; i < 4; i++) setProgStep(i, i === 0 ? 'active' : 'pending');
  if (txHash) document.getElementById('prog-tx-link').innerHTML = getBridgeTxLinks(state.fromChainId, txHash, state.toChainId, '');else document.getElementById('prog-tx-link').innerHTML = '';
}
export function hideProgress() {
  document.getElementById('progress-wrap').classList.remove('show');
}
export function getBridgeTxLinks(fromChain, sourceHash, toChain, destinationHash, lifiLink = '') {
  const links = [],
    fromNet = NETWORKS.find(n => n.id === Number(fromChain)),
    toNet = NETWORKS.find(n => n.id === Number(toChain));
  if (fromNet && isValidTxHash(sourceHash)) links.push(`<a class="tx-link" href="${esc(fromNet.explorer)}/tx/${esc(sourceHash)}" target="_blank" rel="noopener noreferrer">Source tx ?</a>`);
  if (toNet && isValidTxHash(destinationHash)) links.push(`<a class="tx-link" href="${esc(toNet.explorer)}/tx/${esc(destinationHash)}" target="_blank" rel="noopener noreferrer">Destination tx ?</a>`);
  if (/^https:\/\//i.test(lifiLink)) links.push(`<a class="tx-link" href="${esc(lifiLink)}" target="_blank" rel="noopener noreferrer">LI.FI Explorer ?</a>`);
  return links.join(' &nbsp;•&nbsp; ');
}
export function setProgStep(index, state) {
  const dot = document.getElementById('prog-' + index);
  if (!dot) return;
  dot.className = 'prog-dot' + (state !== 'pending' ? ` ${state}` : '');
  dot.innerHTML = state === 'done' ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"></path></svg>' : state === 'failed' ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' : state === 'active' ? '<div class="tx-premium-spinner" style="width:14px;height:14px;border-width:2px;margin:0;box-shadow:none;"></div>' : '';
  if (index > 0) {
    const line = document.getElementById('prog-line-' + (index - 1));
    if (line) line.className = 'prog-line' + (state === 'done' ? ' done' : '');
  }
}
export async function fetchBridgeStatus(txHash, fromChain, toChain, bridgeName) {
  const params = new URLSearchParams({
    txHash
  });
  if (bridgeName) params.set('bridge', bridgeName);
  if (fromChain) params.set('fromChain', String(fromChain));
  if (toChain) params.set('toChain', String(toChain));
  const response = await fetch('/api/bridge-status?' + params, {
    signal: AbortSignal.timeout(12000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data.error || 'Status API error');
  return data;
}
export async function waitBridgeStatusFinal(txHash, fromChain, toChain, bridgeName) {
  for (let i = 0; i < 240; i++) {
    const status = await fetchBridgeStatus(txHash, fromChain, toChain, bridgeName).catch(() => null);
    if (status && (status.status === 'DONE' || status.status === 'FAILED')) return status;
    await new Promise(resolve => setTimeout(resolve, 15000));
  }
  throw new Error('Cross-chain step is still pending. It will continue to be tracked in history.');
}
export function pollBridgeStatus(txHash, fromChain, toChain, bridgeName, options = {}) {
  if (!isValidTxHash(txHash) || state.bridgePollTimers.has(txHash)) return;
  let attempts = 0;
  const check = async () => {
    attempts++;
    try {
      const data = await fetchBridgeStatus(txHash, fromChain, toChain, bridgeName);
      const destinationHash = data.receiving?.txHash || null;
      const receivedToken = data.receiving?.token || null;
      const receivedAmount = data.receiving?.amount || null;
      let actualAmount = null;
      if (receivedAmount && Number.isInteger(Number(receivedToken?.decimals))) actualAmount = fmtAmt(receivedAmount, Number(receivedToken.decimals));
      updateHistoryRecord(txHash, {
        substatus: data.substatus,
        message: data.substatusMessage,
        destinationHash,
        lifiExplorerLink: data.lifiExplorerLink,
        receivedAmount,
        receivedToken,
        ...(actualAmount ? {
          recvAmt: actualAmount,
          toSym: receivedToken?.symbol || ''
        } : {})
      });
      if (!options.silent) {
        document.getElementById('prog-tx-link').innerHTML = getBridgeTxLinks(fromChain, txHash, toChain, destinationHash, data.lifiExplorerLink);
      }
      if (data.status === 'DONE') {
        let status = 'confirmed',
          message = 'Bridge completed successfully.';
        if (data.substatus === 'PARTIAL') {
          status = 'partial';
          message = data.substatusMessage || 'Bridge completed, but a different destination token was received.';
        } else if (data.substatus === 'REFUNDED') {
          status = 'refunded';
          message = data.substatusMessage || 'The bridge was refunded to the source wallet.';
        }
        updateHistoryRecord(txHash, {
          status
        });
        if (status === 'confirmed') {
          const item = state.txHistory.find(entry => entry.hash === txHash);
          if (item) rememberHistoryTokens({
            ...item,
            status: 'confirmed'
          });
          if (!options.silent) {
            setProgStep(1, 'done');
            setProgStep(2, 'done');
            setProgStep(3, 'done');
            setStatus(message, 'ok');
            setTimeout(() => {
              loadBals();
              hideProgress();
            }, 2500);
          }
        } else if (!options.silent) {
          setProgStep(2, 'failed');
          setStatus(message, status === 'refunded' ? 'warn' : 'err');
        }
        state.bridgePollTimers.delete(txHash);
        return;
      }
      if (data.status === 'FAILED' || data.status === 'INVALID') {
        const refunded = data.substatus === 'REFUNDED';
        updateHistoryRecord(txHash, {
          status: refunded ? 'refunded' : 'failed'
        });
        if (!options.silent) {
          setProgStep(2, 'failed');
          setStatus(data.substatusMessage || (refunded ? 'The transfer was refunded.' : 'Bridge failed. Check the transaction details.'), refunded ? 'warn' : 'err');
        }
        state.bridgePollTimers.delete(txHash);
        return;
      }
      if (!options.silent) {
        if (data.substatus === 'WAIT_SOURCE_CONFIRMATIONS') {
          setProgStep(1, 'active');
          setStatus('Waiting for source-chain confirmations…', 'warn');
        } else {
          setProgStep(1, 'done');
          setProgStep(2, 'active');
          setStatus(data.substatusMessage || 'Waiting for the destination transfer…', 'warn');
        }
      }
    } catch (e) {}
    if (attempts < 1440) {
      const timer = setTimeout(check, attempts < 30 ? 8000 : 20000);
      state.bridgePollTimers.set(txHash, timer);
    } else state.bridgePollTimers.delete(txHash);
  };
  state.bridgePollTimers.set(txHash, setTimeout(check, options.immediate ? 0 : 3000));
}
export function checkBridgeNow(hash) {
  const item = state.txHistory.find(entry => entry.hash === hash);
  if (!item) return;
  const old = state.bridgePollTimers.get(hash);
  if (old) clearTimeout(old);
  state.bridgePollTimers.delete(hash);
  pollBridgeStatus(hash, item.statusFromChainId || item.fromChainId, item.statusToChainId || item.toChainId, item.bridge || '', {
    immediate: true
  });
}

// ═══════════════════════════════════════════
// HISTORY
// ═══════════════════════════════════════════
export function saveBridgeHistory() {
  state.txHistory = state.txHistory.slice(0, 30);
  localStorage.setItem('bridge_history', JSON.stringify(state.txHistory));
  const meta = document.getElementById('hist-meta');
  if (meta) meta.textContent = `${state.txHistory.length} transaction${state.txHistory.length === 1 ? '' : 's'}`;
}
export function addToHistory(item) {
  if (!item || !isValidTxHash(item.hash)) return;
  const existing = state.txHistory.findIndex(entry => entry.hash === item.hash);
  if (existing >= 0) state.txHistory[existing] = {
    ...state.txHistory[existing],
    ...item
  };else state.txHistory.unshift(item);
  saveBridgeHistory();
  renderHistory();
}
export function updateHistoryRecord(hash, patch) {
  const item = state.txHistory.find(entry => entry.hash === hash || entry.stepHashes?.includes(hash));
  if (!item) return null;
  Object.assign(item, patch || {});
  saveBridgeHistory();
  renderHistory();
  return item;
}
export function updateHistoryStatus(hash, status) {
  return updateHistoryRecord(hash, {
    status
  });
}
export function clearHistory() {
  for (const timer of state.bridgePollTimers.values()) clearTimeout(timer);
  state.bridgePollTimers.clear();
  state.txHistory = [];
  localStorage.removeItem('bridge_history');
  saveBridgeHistory();
  renderHistory();
}
export function toggleHist() {
  const body = document.getElementById('hist-body'),
    caret = document.getElementById('hist-caret');
  const open = body.style.display === 'none';
  body.style.display = open ? 'block' : 'none';
  caret.classList.toggle('open', open);
}
export function timeAgo(ts) {
  const seconds = Math.floor((Date.now() - Number(ts || Date.now())) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
export function renderHistory() {
  const list = document.getElementById('hist-list');
  if (!list) return;
  const isSwap = state.fromChainId === state.toChainId;
  const filtered = state.txHistory.filter(item => isSwap ? item.fromChainId === item.toChainId : item.fromChainId !== item.toChainId);
  const meta = document.getElementById('hist-meta');
  if (meta) meta.textContent = `${filtered.length} transaction${filtered.length === 1 ? '' : 's'}`;
  if (!filtered.length) {
    list.innerHTML = `<div class="hist-empty">No ${isSwap ? 'swap' : 'bridge'} transactions yet</div>`;
    return;
  }
  const statusMeta = {
    confirmed: ['ok', '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px;"><path d="M20 6L9 17l-5-5"></path></svg><span style="vertical-align:middle;">Completed</span>'],
    partial: ['err', '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px;"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg><span style="vertical-align:middle;">Partial</span>'],
    refunded: ['err', '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px;"><polyline points="9 14 4 9 9 4"></polyline><path d="M20 20v-7a4 4 0 0 0-4-4H4"></path></svg><span style="vertical-align:middle;">Refunded</span>'],
    failed: ['err', '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px;"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg><span style="vertical-align:middle;">Failed</span>'],
    pending: ['pending', '<div class="tx-premium-spinner" style="width:10px;height:10px;border-width:2px;margin:0 4px 0 0;box-shadow:none;display:inline-block;vertical-align:middle;"></div><span style="vertical-align:middle;">Pending</span>']
  };
  list.innerHTML = filtered.map(item => {
    const [cls, label] = statusMeta[item.status] || statusMeta.pending;
    const source = item.explorer && isValidTxHash(item.hash) ? `<a class="hi-link" href="${esc(item.explorer)}/tx/${esc(item.hash)}" target="_blank" rel="noopener noreferrer">Source tx ?</a>` : '';
    const toNet = NETWORKS.find(net => net.id === Number(item.toChainId));
    const destination = toNet && isValidTxHash(item.destinationHash) ? `<a class="hi-link" href="${esc(toNet.explorer)}/tx/${esc(item.destinationHash)}" target="_blank" rel="noopener noreferrer">Destination tx ?</a>` : '';
    const lifi = /^https:\/\//i.test(String(item.lifiExplorerLink || '')) ? `<a class="hi-link" href="${esc(item.lifiExplorerLink)}" target="_blank" rel="noopener noreferrer">LI.FI ↗</a>` : '';
    const check = item.status === 'pending' ? `<button class="hi-check" onclick="checkBridgeNow('${esc(item.hash)}')">Check status</button>` : '';
    const details = item.message ? `<div class="hi-detail">${esc(item.message)}</div>` : '';
    return `<div class="hist-item"><div><div class="hi-pair">${esc(item.sendAmt || '')} ${esc(item.fromSym || '')} → ${esc(item.recvAmt || '')} ${esc(item.toSym || '')}</div><div class="hi-detail">${esc(item.fromNet || '')} → ${esc(item.toNet || '')} via ${esc(item.bridge || '')}</div>${details}</div><div class="hi-right"><div class="hi-status ${cls}">${label}</div><div class="hi-actions">${source}${destination}${lifi}${check}</div><div class="hi-time">${timeAgo(item.ts)}</div></div></div>`;
  }).join('');
}

// ═══════════════════════════════════════════
// COMET ANIMATION - follows bridge card border
// ═══════════════════════════════════════════
export function startComets() {
  const canvas = document.getElementById('comet-canvas');
  if (!canvas || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const COLORS = ['#38bdf8', '#9b51e0', '#38bdf8'],
    TAIL_LEN = 110,
    NUM = 3,
    comets = [];
  let W = 0,
    H = 0,
    lastFrame = 0,
    raf = 0;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function getRect() {
    const wrap = document.querySelector('.bridge-wrap');
    if (!wrap) return null;
    const r = wrap.getBoundingClientRect(),
      pad = 6;
    return {
      x: r.left - pad,
      y: r.top - pad,
      w: r.width + pad * 2,
      h: r.height + pad * 2
    };
  }
  function perimeter(r) {
    return 2 * (r.w + r.h);
  }
  function perimToXY(r, dist) {
    const p = perimeter(r);
    dist = (dist % p + p) % p;
    if (dist < r.w) return {
      x: r.x + dist,
      y: r.y
    };
    if (dist < r.w + r.h) return {
      x: r.x + r.w,
      y: r.y + (dist - r.w)
    };
    if (dist < 2 * r.w + r.h) return {
      x: r.x + r.w - (dist - r.w - r.h),
      y: r.y + r.h
    };
    return {
      x: r.x,
      y: r.y + r.h - (dist - 2 * r.w - r.h)
    };
  }
  function seed() {
    const r = getRect();
    if (!r || comets.length) return;
    const p = perimeter(r);
    for (let i = 0; i < NUM; i++) comets.push({
      dist: p / NUM * i,
      speed: 1.8 + Math.random() * .8,
      color: COLORS[i],
      size: 2.5 + Math.random()
    });
  }
  function draw(now) {
    raf = requestAnimationFrame(draw);
    if (document.hidden || now - lastFrame < 33) return;
    lastFrame = now;
    ctx.clearRect(0, 0, W, H);
    seed();
    const rect = getRect();
    if (!rect || comets.length !== NUM) return;
    const p = perimeter(rect);
    for (const cm of comets) {
      const head = perimToXY(rect, cm.dist),
        steps = 28,
        stepLen = TAIL_LEN / steps;
      for (let i = steps; i >= 1; i--) {
        const from = perimToXY(rect, cm.dist - i * stepLen),
          to = perimToXY(rect, cm.dist - (i - 1) * stepLen),
          alpha = 1 - i / steps;
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.strokeStyle = cm.color + Math.round(alpha * 200).toString(16).padStart(2, '0');
        ctx.lineWidth = cm.size * alpha;
        ctx.shadowBlur = 8 * alpha;
        ctx.shadowColor = cm.color;
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.arc(head.x, head.y, cm.size * 2.2, 0, Math.PI * 2);
      const gradient = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, cm.size * 2.2);
      gradient.addColorStop(0, cm.color + 'ff');
      gradient.addColorStop(1, cm.color + '00');
      ctx.fillStyle = gradient;
      ctx.shadowBlur = 18;
      ctx.shadowColor = cm.color;
      ctx.fill();
      ctx.shadowBlur = 0;
      cm.dist = (cm.dist + cm.speed) % p;
    }
  }
  window.addEventListener('resize', resize, {
    passive: true
  });
  resize();
  raf = requestAnimationFrame(draw);
  window.addEventListener('pagehide', () => cancelAnimationFrame(raf), {
    once: true
  });
}
window.addEventListener('load', init);
export function toggleTheme() {
  const d = document.body.classList.contains('dark');
  document.body.classList.toggle('dark', !d);
  document.body.classList.toggle('light', d);
  localStorage.setItem('coinblog-theme', d ? 'light' : 'dark');
  updateThemeIcon();
}
export function updateThemeIcon() {
  const d = document.body.classList.contains('dark');
  const el = document.getElementById('theme-ico');
  if (!el) return;
  el.innerHTML = d ? '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>' : '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';
}
export function toggleAnalyticsDD(e) {
  e.stopPropagation();
  document.getElementById('analytics-dd')?.classList.toggle('open');
}
document.addEventListener('click', () => document.getElementById('analytics-dd')?.classList.remove('open'));
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  document.getElementById('chain-modal-overlay')?.classList.remove('open');
  document.getElementById('tok-modal-overlay')?.classList.remove('open');
  document.getElementById('wpm-overlay')?.classList.add('hidden');
  document.getElementById('w-menu')?.classList.remove('open');
});
(function () {
  const s = localStorage.getItem('coinblog-theme') || 'dark';
  document.body.className = s;
  updateThemeIcon();
})();