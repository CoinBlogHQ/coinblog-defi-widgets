import { state } from '../core/state.js';
import { fetch0xQuote, fetchOpenOceanQuote, fetchParaswapQuote } from '../aggregators/api.js';
import { _requestWallet } from '../core/wallet.js';
import { clearQuoteTimer, getPrimaryBridgeTool } from '../core/utils.js';
import { esc, formatUnitsExact, getSendRawAmount, isValidAddr, normalizeDecimalInput, validateAmount } from '../security/goplus.js';
import { readAllowance } from '../execution/transaction.js';
import { updateSendUsd } from '../execution/balances.js';
import { NATIVE } from '../core/networks.js';
import { hideProgress } from '../execution/tracker.js';

// SLIPPAGE
// ═══════════════════════════════════════════
export function setSlip(v, btn) {
  state.slippage = v;
  document.querySelectorAll('.slip-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('slip-custom').value = '';
  if (state.routes.length) scheduleQuote();
}
export function setSlipCustom(v) {
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0.01 && n <= 5) {
    state.slippage = n;
    document.querySelectorAll('.slip-btn').forEach(b => b.classList.remove('active'));
    if (n > 1) setStatus('High slippage increases the risk of an unfavorable execution.', 'warn');
    scheduleQuote();
  } else setStatus('Slippage must be between 0.01% and 5%.', 'err');
}
export function onRecipientChange() {
  const input = document.getElementById('recipient-address');
  const warn = document.getElementById('poisoning-warning');
  if (state.wallet && input.value.trim().length > 0 && input.value.trim().toLowerCase() !== state.wallet.toLowerCase() && isValidAddr(input.value.trim())) {
    warn.style.display = 'block';
  } else {
    warn.style.display = 'none';
  }
  scheduleQuote();
}
export function getRecipientAddress() {
  const value = String(document.getElementById('recipient-address')?.value || '').trim();
  if (!value) return state.wallet || '';
  if (!isValidAddr(value)) throw new Error('Destination recipient is not a valid EVM address');
  return value;
}

// ═══════════════════════════════════════════
// QUOTE / ROUTES
// ═══════════════════════════════════════════
export function onAmtInput() {
  const el = document.getElementById('send-amt');
  const normalized = normalizeDecimalInput(el.value);
  if (normalized !== el.value) el.value = normalized;
  updateSendUsd();
  scheduleQuote();
}
export function scheduleQuote() {
  clearQuoteTimer();
  clearTimeout(state.quoteTimer);
  if (!validateAmount(document.getElementById('send-amt').value)) {
    clearRoutes();
    return;
  }
  if (!state.wallet) {
    state.routes = [];
    state.routesExpiresAt = 0;
    document.getElementById('routes-section').style.display = 'none';
    updateBtnState();
    return;
  }
  showRoutesLoading();
  state.quoteTimer = setTimeout(fetchRoutes, 650);
}
export function showRoutesLoading() {
  document.getElementById('routes-section').style.display = 'block';
  document.getElementById('routes-list').innerHTML = '<div class="routes-loading"><div class="spinner"></div>Finding executable routes…</div>';
  document.getElementById('routes-count').textContent = '';
  document.getElementById('fee-section').style.display = 'none';
  document.getElementById('receive-amt').textContent = '0.0';
  document.getElementById('receive-usd').textContent = '≈ $0.00';
}
export async function fetchRoutes() {
  const requestId = ++state._routeReqId;
  if (!state.wallet) {
    clearRoutes();
    updateBtnState();
    return;
  }
  if (!state.fromTok || !state.toTok) {
    clearRoutes();
    return;
  }
  let rawAmount;
  try {
    rawAmount = getSendRawAmount();
    if (rawAmount <= 0n) throw new Error('Invalid amount');
  } catch (e) {
    setStatus(e.message, 'err');
    clearRoutes();
    return;
  }
  let recipient = '';
  try {
    recipient = getRecipientAddress();
  } catch (e) {
    setStatus(e.message, 'err');
    clearRoutes();
    return;
  }
  const slip = Math.min(Math.max(state.slippage, 0.01), 5) / 100;
  const params = new URLSearchParams({
    fromChainId: String(state.fromChainId),
    toChainId: String(state.toChainId),
    fromToken: state.fromTok.addr,
    toToken: state.toTok.addr,
    fromAmount: rawAmount.toString(),
    slippage: String(slip)
  });
  if (state.wallet) params.set('fromAddress', state.wallet);
  if (recipient) params.set('toAddress', recipient);
  if (document.getElementById('destination-gas')?.checked) {
    const gasAmount = rawAmount / 100n;
    if (gasAmount > 0n) params.set('fromAmountForGas', gasAmount.toString());
  }
  try {
    let data;
    if (state.fromChainId === state.toChainId) {
      // Same Chain - query 0x, ParaSwap, OpenOcean concurrently
      const slipBps = Math.round(slip * 10000);
      const rawStr = rawAmount.toString();
      const fetchers = [{
        id: '0x',
        fn: () => fetch0xQuote(rawStr, slipBps)
      }, {
        id: 'paraswap',
        fn: () => fetchParaswapQuote(rawStr, slipBps)
      }, {
        id: 'openocean',
        fn: () => fetchOpenOceanQuote(rawStr, slipBps)
      }];
      const settled = await Promise.allSettled(fetchers.map(f => f.fn()));
      if (requestId !== state._routeReqId) return;
      const swapRoutes = [];
      for (const res of settled) {
        if (res.status === 'fulfilled' && res.value && res.value.buyAmount) {
          const q = res.value;
          swapRoutes.push({
            id: 'swap-' + q.aggregator.toLowerCase() + '-' + Date.now(),
            isSwap: true,
            tool: q.aggregator,
            toAmount: q.buyAmount,
            toAmountMin: q.minBuyAmount,
            executionDuration: 3,
            steps: [{
              type: 'swap',
              tool: q.aggregator,
              toolDetails: {
                name: q.aggregator,
                logoURI: q._logo
              },
              estimate: {
                toAmount: q.buyAmount
              }
            }],
            txData: q.txRequest,
            allowanceTarget: q.allowanceTarget,
            normalized: q
          });
        }
      }
      if (!swapRoutes.length) {
        throw new Error('No liquidity routes found for swap');
      }

      // Sort routes descending by output amount
      swapRoutes.sort((a, b) => BigInt(b.toAmount) > BigInt(a.toAmount) ? 1 : -1);
      state.routes = swapRoutes;
    } else {
      // Cross Chain - use bridge API
      const response = await fetch('/api/bridge-routes?' + params, {
        signal: AbortSignal.timeout(22000)
      });
      data = await response.json().catch(() => ({}));
      if (requestId !== state._routeReqId) return;
      if (!response.ok || data.error) throw new Error(data.details || data.error || `Bridge API ${response.status}`);
      state.routes = (data.routes || []).filter(route => Array.isArray(route?.steps) && route.steps.length > 0);
    }
    state.routesExpiresAt = Number(data?.expiresAt || Date.now() + 55000);
      state.routes.forEach(r => {
        if (!r.normalized) r.normalized = { expiresAt: state.routesExpiresAt };
      });
    if (!state.routes.length) {
      document.getElementById('routes-list').innerHTML = '<div class="routes-loading" style="justify-content:center">No executable route found</div>';
      updateBtnState();
      return;
    }
    renderRoutes();
    selectRoute(0);
    setStatus('');
  } catch (e) {
    if (requestId !== state._routeReqId) return;
    setStatus(e.name === 'AbortError' ? 'Route request timed out.' : `Unable to find routes: ${e.message}`, 'err');
    clearRoutes();
  }
}
export function fmtTime(seconds) {
  const secs = Math.max(0, Number(seconds) || 0);
  if (secs < 60) return `${Math.round(secs)}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  return `${(secs / 3600).toFixed(1)}h`;
}
export function fmtAmt(raw, dec, maxDec = 8) {
  try {
    return formatUnitsExact(BigInt(String(raw || '0')), Number(dec), maxDec);
  } catch (e) {
    return '0';
  }
}
export function routeEstimate(route) {
  return {
    toAmount: route?.toAmount || route?.steps?.at(-1)?.estimate?.toAmount || '0',
    toAmountMin: route?.toAmountMin || route?.steps?.at(-1)?.estimate?.toAmountMin || '0',
    toAmountUSD: route?.toAmountUSD || route?.steps?.at(-1)?.estimate?.toAmountUSD || '',
    fromAmountUSD: route?.fromAmountUSD || route?.steps?.[0]?.estimate?.fromAmountUSD || '',
    executionDuration: route?.steps?.reduce((sum, step) => sum + Number(step?.estimate?.executionDuration || 0), 0) || 0
  };
}
export function routeCosts(route) {
  let gas = 0,
    fees = 0;
  for (const step of route?.steps || []) {
    for (const cost of step?.estimate?.gasCosts || []) gas += Number(cost?.amountUSD || 0);
    for (const cost of step?.estimate?.feeCosts || []) fees += Number(cost?.amountUSD || 0);
  }
  return {
    gas,
    fees,
    total: gas + fees
  };
}
export function routeToolNames(route) {
  const names = [];
  for (const step of route?.steps || []) {
    const included = Array.isArray(step?.includedSteps) && step.includedSteps.length ? step.includedSteps : [step];
    for (const child of included) {
      const name = String(child?.toolDetails?.name || child?.tool || '').trim();
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names.length ? names : ['Bridge'];
}
export function routePathLabel(route) {
  const first = route?.steps?.[0]?.action?.fromToken?.symbol || state.fromTok?.sym || '';
  const last = route?.steps?.at(-1)?.action?.toToken?.symbol || state.toTok?.sym || '';
  const primary = getPrimaryBridgeTool(route).name;
  const txCount = Math.max(1, route?.steps?.length || 1);
  return `${first} · ${primary} · ${last} · ${txCount} wallet transaction${txCount === 1 ? '' : 's'}`;
}
export function getBridgeIcon(route) {
  const url = String(route?.steps?.[0]?.toolDetails?.logoURI || '');
  return /^https:\/\//i.test(url) ? url : '';
}
export function routePriceImpact(route) {
  const est = routeEstimate(route);
  const input = Number(est.fromAmountUSD || 0),
    output = Number(est.toAmountUSD || 0);
  return input > 0 && output >= 0 ? Math.max(0, (input - output) / input * 100) : null;
}
export function renderRoutes() {
  document.getElementById('routes-section').style.display = 'block';
  document.getElementById('routes-count').textContent = `${state.routes.length} found`;
  document.getElementById('routes-list').innerHTML = state.routes.map((route, index) => {
    const est = routeEstimate(route),
      cost = routeCosts(route);
    const toolInfo = getPrimaryBridgeTool(route);
    const name = toolInfo.name;
    const icon = toolInfo.logo || getBridgeIcon(route);
    const isFast = !route.isSwap && (est.executionDuration && est.executionDuration <= 180 || ['across', 'relay', 'debridge', 'layerswap', 'stargate'].includes(toolInfo.toolKey));
    const badgeHtml = isFast ? `<div style="display:inline-block; background:rgba(245,181,27,0.2); color:var(--accent); font-size:10px; font-weight:800; padding:2px 6px; border-radius:4px; margin-left:8px; vertical-align:middle;">⚡ FASTEST (${fmtTime(est.executionDuration || 120)})</div>` : '';
    const toAmount = fmtAmt(est.toAmount, state.toTok.dec);
    const time = fmtTime(est.executionDuration || (route.isSwap ? 3 : 120));
    const impact = routePriceImpact(route);
    const iconHtml = icon ? `<img class="rc-bridge-icon" src="${esc(icon)}" onerror="this.style.display='none'" alt="${esc(name)}">` : `<div class="rc-bridge-icon" style="background:rgba(56,189,248,.12);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:900;color:#38bdf8">${esc(name.slice(0, 2).toUpperCase())}</div>`;
    return `<div class="route-card${index === 0 ? ' best-badge' : ''}" id="route-card-${index}" role="button" tabindex="0" onclick="selectRoute(${index})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();selectRoute(${index})}">
      <div class="rc-bridge">${iconHtml}<div><span class="rc-bridge-name">${esc(name)}</span>${badgeHtml}<div class="route-path" title="${esc(routePathLabel(route))}">${esc(routePathLabel(route))}</div></div></div>
      <div class="rc-mid"><div class="rc-amount">${esc(toAmount)} ${esc(state.toTok.sym)}</div><div class="rc-usd">${est.toAmountUSD ? `≈ $${Number(est.toAmountUSD).toFixed(2)}` : ''}</div></div>
      <div class="rc-right"><div class="rc-time">⏱ ${esc(time)}</div><div class="rc-fee">Route cost ~$${cost.total.toFixed(2)}</div><div class="rc-tags">${index === 0 ? '<span class="rc-tag">CHEAPEST</span>' : ''}${impact !== null && impact > 3 ? '<span class="rc-tag" style="color:#fbbf24">HIGH IMPACT</span>' : ''}</div></div>
    </div>`;
  }).join('');
}
export async function selectRoute(index) {
  state.selectedRouteIdx = index;
  document.querySelectorAll('.route-card').forEach((el, i) => el.classList.toggle('selected', i === index));
  const route = state.routes[index];
  if (!route) return;
  const est = routeEstimate(route),
    cost = routeCosts(route),
    impact = routePriceImpact(route);
  document.getElementById('receive-amt').textContent = `${fmtAmt(est.toAmount, state.toTok.dec)} ${state.toTok.sym}`;
  document.getElementById('receive-usd').textContent = est.toAmountUSD ? `≈ $${Number(est.toAmountUSD).toFixed(2)}` : '≈ -';
  document.getElementById('fee-src-gas').textContent = cost.gas ? `~$${cost.gas.toFixed(2)}` : '-';
  document.getElementById('fee-bridge').textContent = cost.fees ? `~$${cost.fees.toFixed(2)}` : '$0.00';
  document.getElementById('fee-approval').textContent = 'Checking…';
  document.getElementById('fee-time').textContent = fmtTime(est.executionDuration || 120);
  document.getElementById('fee-min-out').textContent = `${fmtAmt(est.toAmountMin || est.toAmount, state.toTok.dec)} ${state.toTok.sym}`;
  document.getElementById('fee-section').style.display = 'block';
  if (impact !== null && impact > 3) setStatus(`Warning: estimated value impact is ${impact.toFixed(2)}%. Review the route carefully.`, 'warn');
  state._bridgeNeedsApproval = false;
  const spender = route.isSwap ? route.allowanceTarget : route.steps?.[0]?.estimate?.approvalAddress;
  if (state.wallet && state.fromTok.addr !== NATIVE && isValidAddr(spender)) {
    try {
      const current = await _requestWallet('eth_chainId', [], {
        timeoutMs: 6000
      });
      if (parseInt(current, 16) === state.fromChainId) {
        const allowance = await readAllowance(state.fromTok.addr, state.wallet, spender);
        state._bridgeNeedsApproval = allowance < getSendRawAmount();
      }
    } catch (e) {
      state._bridgeNeedsApproval = true;
    }
  }
  document.getElementById('fee-approval').textContent = state._bridgeNeedsApproval ? 'Additional network gas' : 'Not required';
  updateBtnState();
}
export function clearRoutes() {
  clearQuoteTimer();
  hideProgress();
  state._routeReqId++;
  state.routes = [];
  state.routesExpiresAt = 0;
  document.getElementById('routes-section').style.display = 'none';
  document.getElementById('fee-section').style.display = 'none';
  document.getElementById('receive-amt').textContent = '0.0';
  document.getElementById('receive-usd').textContent = '≈ $0.00';
  updateBtnState();
}
export function updateBtnState() {
  const btn = document.getElementById('bridge-btn');
  if (state.bridgeBusy) {
    btn.disabled = true;
    btn.textContent = 'Processing…';
    btn.className = 'bridge-btn loading';
    return;
  }
  if (!validateAmount(document.getElementById('send-amt').value)) {
    btn.disabled = true;
    btn.textContent = 'Enter Amount';
    btn.className = 'bridge-btn';
    return;
  }
  if (!state.wallet) {
    btn.disabled = false;
    btn.textContent = 'Connect Wallet';
    btn.className = 'bridge-btn ready';
    return;
  }
  if (!state.routes.length) {
    btn.disabled = true;
    btn.textContent = 'Select Route';
    btn.className = 'bridge-btn';
    return;
  }
  const consentBox = document.getElementById('impact-consent-box');
  const consentCb = document.getElementById('impact-consent-cb');
  if (state.routes.length > 0) {
    const activeRoute = state.routes[state.selectedRouteIdx] || state.routes[0];
    const est = routeEstimate(activeRoute);
    const inputUSD = Number(est.fromAmountUSD || 0);
    const outputUSD = Number(est.toAmountUSD || 0);
    const impact = routePriceImpact(activeRoute);
    // Only block if impact is genuinely high and loss is more than $1 (ignore fixed relayer fee on micro-tests)
    const isRealImpact = impact !== null && impact >= 15 && (inputUSD >= 5 || inputUSD - outputUSD >= 1.0);
    if (isRealImpact) {
      consentBox.style.display = 'block';
      if (!consentCb.checked) {
        btn.textContent = 'Accept Price Impact Risk';
        btn.disabled = true;
        btn.className = 'bridge-btn';
        return;
      }
    } else {
      consentBox.style.display = 'none';
    }
  } else {
    consentBox.style.display = 'none';
  }
  btn.disabled = false;
  const actionWord = state.fromChainId === state.toChainId ? 'Swap' : 'Bridge';
  btn.textContent = state._bridgeNeedsApproval ? `Approve & ${actionWord} ${state.fromTok?.sym || ''}` : `${actionWord} →`;
  btn.className = state._bridgeNeedsApproval ? 'bridge-btn approve' : 'bridge-btn ready';
}
export function setBtnLoading(on) {
  state.bridgeBusy = !!on;
  updateBtnState();
}
export function setStatus(message, type) {
  const el = document.getElementById('status-msg');
  el.textContent = String(message || '');
  el.className = 'status-msg' + (type ? ' ' + type : '');
}

// ═══════════════════════════════════════════