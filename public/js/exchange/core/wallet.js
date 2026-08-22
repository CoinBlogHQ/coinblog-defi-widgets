import { state } from './state.js';
import { clearRoutes, scheduleQuote, setStatus, updateBtnState } from '../ui/renderer.js';
import { switchWalletToChain } from '../ui/modals.js';
import { loadCustomTokens } from './tokens.js';
import { loadBals, loadBalsFast, updateBals } from '../execution/balances.js';
import { chainIconHTML, hydrateMajorTokensForChain, loadSupportedBridgeChains, queueTokenLogoHydration, resumePendingBridgeHistory, tokIconEl } from './icons.js';
import { NETWORKS, TOKENS } from './networks.js';
import { esc, validateAmount } from '../security/goplus.js';
import { getChainTokens, mergeBridgeRecentTokens } from './utils.js';
import { renderHistory, startComets } from '../execution/tracker.js';

// INIT
// ═══════════════════════════════════════════
export async function init() {
  loadCustomTokens();
  await loadSupportedBridgeChains();
  for (const net of NETWORKS) mergeBridgeRecentTokens(net.id);
  // Detect wallet chain
  if (window.ethereum) {
    try {
      const hex = await window.ethereum.request({
        method: 'eth_chainId'
      });
      const id = parseInt(hex, 16);
      if (NETWORKS.find(n => n.id === id)) {
        state.fromChainId = id;
        // Pick a different default toChain
        state.toChainId = id === 42161 ? 1 : id === 1 ? 42161 : 1;
      }
    } catch (e) {}
  }
  await Promise.all([hydrateMajorTokensForChain(state.fromChainId), hydrateMajorTokensForChain(state.toChainId)]);
  // Set default tokens
  state.fromTok = TOKENS[state.fromChainId]?.[0] || TOKENS[1][0];
  state.toTok = TOKENS[state.toChainId]?.[0] || TOKENS[42161][0];
  updateChainUI();
  updateTokenUI();
  renderHistory();
  resumePendingBridgeHistory();
  const reconnected = await _trySilentReconnect();
  if (!reconnected) _discoverWallets();
  startComets();
  if (state.txHistory.length) document.getElementById('hist-meta').textContent = state.txHistory.length + ' transaction' + (state.txHistory.length !== 1 ? 's' : '');
}

// ═══════════════════════════════════════════
// CHAIN / TOKEN UI
// ═══════════════════════════════════════════
export function updateChainUI() {
  const from = NETWORKS.find(n => n.id === state.fromChainId) || NETWORKS[0];
  const to = NETWORKS.find(n => n.id === state.toChainId) || NETWORKS[2];
  document.getElementById('from-chain-icon-wrap').innerHTML = chainIconHTML(from, 28);
  document.getElementById('to-chain-icon-wrap').innerHTML = chainIconHTML(to, 28);
  document.getElementById('from-chain-name').textContent = from.name;
  document.getElementById('to-chain-name').textContent = to.name;
  const advBox = document.getElementById('advanced-transfer-box');
  if (advBox) {
    advBox.style.display = state.fromChainId === state.toChainId ? 'none' : 'block';
  }
  const histTitle = document.getElementById('history-title-text');
  if (histTitle) {
    histTitle.textContent = state.fromChainId === state.toChainId ? 'Swap History' : 'Bridge History';
  }
}
export let _currentSecCache = {};
export async function checkTokenSecurity(token) {
  const badge = document.getElementById('sell-sec-badge');
  const warnBox = document.getElementById('sec-warning-box');
  const btn = document.getElementById('submit-btn');
  if (!badge || !warnBox) return;
  badge.className = 'sec-badge';
  badge.innerHTML = '';
  warnBox.style.display = 'none';
  const addr = (token.addr || '').toLowerCase();
  const chainId = state.fromChainId;
  if (!token || !addr || addr === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') return;
  const key = chainId + '-' + addr;
  if (_currentSecCache[key] === undefined) {
    try {
      const res = await fetch(`https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${addr}`);
      if (res.ok) {
        const raw = await res.json();
        const info = raw?.result?.[addr];
        if (info) {
          _currentSecCache[key] = {
            is_honeypot: info.is_honeypot === '1',
            cannot_sell: info.cannot_sell === '1' || info.is_honeypot === '1',
            buy_tax: info.buy_tax ? parseFloat(info.buy_tax) * 100 : 0,
            sell_tax: info.sell_tax ? parseFloat(info.sell_tax) * 100 : 0,
            is_mintable: info.is_mintable === '1',
            is_proxy: info.is_proxy === '1',
            transfer_pausable: info.transfer_pausable === '1',
            trust_list: info.trust_list === '1',
            is_open_source: info.is_open_source === '1'
          };
        } else {
          _currentSecCache[key] = null;
        }
      } else {
        _currentSecCache[key] = null;
      }
    } catch (e) {
      _currentSecCache[key] = null;
    }
  }
  const sec = _currentSecCache[key];
  if (!sec) return;
  let isBlocker = false;
  let warnings = [];
  if (sec.is_honeypot || sec.cannot_sell) {
    isBlocker = true;
    warnings.push('CRITICAL: This token is a Honeypot (cannot be sold).');
  }
  if (sec.buy_tax > 10 || sec.sell_tax > 10) {
    warnings.push(`High Tax: Buy ${sec.buy_tax.toFixed(1)}% / Sell ${sec.sell_tax.toFixed(1)}%`);
  }
  if (!sec.trust_list) {
    if (!sec.is_open_source) {
      warnings.push('Contract source code is not verified (high risk).');
    }
    if (sec.transfer_pausable) {
      warnings.push('Admin can pause transfers.');
    }
  }
  if (isBlocker) {
    badge.className = 'sec-badge warn';
    badge.innerHTML = '⚠️ SCAM';
    warnBox.style.display = 'block';
    warnBox.innerHTML = '<strong>Security Warning:</strong><br>' + warnings.join('<br>');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'SWAP DISABLED (SCAM)';
      btn.classList.add('btn-disabled');
    }
  } else if (warnings.length > 0) {
    badge.className = 'sec-badge warn';
    badge.innerHTML = '⚠️ RISK';
    warnBox.style.display = 'block';
    warnBox.innerHTML = '<strong>Security Warning:</strong><br>' + warnings.join('<br>');
  } else {
    badge.className = 'sec-badge safe';
    badge.innerHTML = sec.trust_list ? '✓ VERIFIED' : '✓ SAFE';
    warnBox.style.display = 'none';
  }
}
export function updateTokenUI() {
  if (state.fromTok) {
    checkTokenSecurity(state.fromTok).then(() => updateBtnState());
    document.getElementById('from-tok-icon-wrap').innerHTML = tokIconEl(state.fromTok, 32, state.fromChainId);
    document.getElementById('from-tok-sym').textContent = state.fromTok.sym;
    queueTokenLogoHydration(state.fromChainId, [state.fromTok], () => updateTokenUI());
  }
  if (state.toTok) {
    document.getElementById('to-tok-icon-wrap').innerHTML = tokIconEl(state.toTok, 32, state.toChainId);
    document.getElementById('to-tok-sym').textContent = state.toTok.sym;
    queueTokenLogoHydration(state.toChainId, [state.toTok], () => updateTokenUI());
  }
}
export function flipTokens() {
  [state.fromTok, state.toTok] = [state.toTok, state.fromTok];
  state._bridgeNeedsApproval = false;
  state._lastBridgeApprove = null;
  updateTokenUI();
  clearRoutes();
  updateBals();
  if (state.wallet) {
    loadBalsFast();
    loadBals();
  }
  scheduleQuote();
}
export function flipChains() {
  [state.fromChainId, state.toChainId] = [state.toChainId, state.fromChainId];
  [state.fromTok, state.toTok] = [state.toTok, state.fromTok];
  if (!TOKENS[state.fromChainId]) state.fromTok = TOKENS[1][0];
  if (!TOKENS[state.toChainId]) state.toTok = TOKENS[42161][0];
  state._bridgeNeedsApproval = false;
  state._lastBridgeApprove = null;
  updateChainUI();
  updateTokenUI();
  clearRoutes();
  updateBals();
  if (state.wallet) {
    loadBalsFast();
    loadBals();
  }
  if (state.wallet && _activeProvider()) {
    switchWalletToChain(state.fromChainId).catch(error => setStatus(error?.code === 4001 ? 'Network switch rejected' : error?.message || 'Unable to switch network', 'err'));
  }
  scheduleQuote();
}

// ═════════════════���═════════════════════════
// WALLET - EIP-6963 and WalletConnect
// ═══════════════════════════════════════════
export const _wDetected = new Map();
export let _wProvider = null;
export let _wcProvider = null;
export let _wcFactoryPromise = null;
export const WC_PROJECT_ID = '704069969e567ac0da6a87f58563af90';
export const WC_METHODS = ['eth_accounts', 'eth_requestAccounts', 'eth_chainId', 'eth_sendTransaction', 'eth_call', 'eth_getBalance', 'eth_gasPrice', 'eth_estimateGas', 'eth_getTransactionReceipt', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_watchAsset'];
export const WC_EVENTS = ['chainChanged', 'accountsChanged'];
export let WC_OPTIONAL_CHAINS = NETWORKS.map(n => n.id);
export let WC_RPC_MAP = Object.fromEntries(NETWORKS.map(n => [n.id, n.rpc]));
export const MOBILE_WALLET_LINKS = [{
  name: 'MetaMask',
  desc: 'Open Coin Blog in MetaMask',
  icon: 'https://upload.wikimedia.org/wikipedia/commons/3/36/MetaMask_Fox.svg',
  href: () => `https://metamask.app.link/dapp/${window.location.host}${window.location.pathname}${window.location.search}${window.location.hash}`
}, {
  name: 'Trust Wallet',
  desc: 'Open Coin Blog in Trust Wallet',
  icon: 'https://trustwallet.com/assets/images/media/assets/trust_platform.svg',
  href: () => `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(window.location.href)}`
}, {
  name: 'Coinbase Wallet',
  desc: 'Open Coin Blog in Coinbase Wallet',
  icon: 'https://avatars.githubusercontent.com/u/1885080?s=200&v=4',
  href: () => `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(window.location.href)}`
}, {
  name: 'Rainbow',
  desc: 'Open Coin Blog in Rainbow',
  icon: 'https://avatars.githubusercontent.com/u/38057539?s=200&v=4',
  href: () => `https://rnbwapp.com/browser?url=${encodeURIComponent(window.location.href)}`
}];
export let _walletEventProvider = null;
export let _walletAccountsHandler = null;
export let _walletChainHandler = null;
export function _activeProvider() {
  return _wProvider && typeof _wProvider.request === 'function' ? _wProvider : null;
}
export function _signingProvider() {
  return _activeProvider();
}
export async function _requestWallet(method, params, opts = {}) {
  const provider = _activeProvider();
  if (!provider?.request) throw new Error('No selected wallet provider');
  const payload = params === undefined || Array.isArray(params) && params.length === 0 ? {
    method
  } : {
    method,
    params
  };
  const timeoutMs = opts.timeoutMs ?? 20000;
  let timer;
  try {
    return await Promise.race([provider.request(payload), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Wallet request timeout: ${method}`)), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
export function unbindWalletEvents() {
  if (!_walletEventProvider) return;
  const off = typeof _walletEventProvider.removeListener === 'function' ? 'removeListener' : typeof _walletEventProvider.off === 'function' ? 'off' : '';
  if (off && _walletAccountsHandler) _walletEventProvider[off]('accountsChanged', _walletAccountsHandler);
  if (off && _walletChainHandler) _walletEventProvider[off]('chainChanged', _walletChainHandler);
  _walletEventProvider = null;
  _walletAccountsHandler = null;
  _walletChainHandler = null;
}
export function bindWalletEvents(provider) {
  unbindWalletEvents();
  if (!provider?.on) return;
  _walletEventProvider = provider;
  _walletAccountsHandler = _onAccChange;
  _walletChainHandler = async hex => {
    const id = typeof hex === 'string' ? parseInt(hex, 16) : Number(hex);
    // Programmatic chain switches are part of multi-step execution. Do not
    // mutate the route form or clear the selected route while it is running.
    if (state.bridgeBusy) return;
    if (NETWORKS.some(n => n.id === id)) {
      state.fromChainId = id;
      await hydrateMajorTokensForChain(id);
      mergeBridgeRecentTokens(id);
      state.fromTok = getChainTokens(id)[0] || state.fromTok;
      state.bals = {};
      state._bridgeNeedsApproval = false;
      state._lastBridgeApprove = null;
      updateChainUI();
      updateTokenUI();
      clearRoutes();
      updateBals();
      if (state.wallet) {
        loadBalsFast();
        loadBals();
      }
    }
  };
  provider.on('accountsChanged', _walletAccountsHandler);
  provider.on('chainChanged', _walletChainHandler);
}
export function _isMobileBrowser() {
  return /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent || '');
}
export function _renderMobileWalletFallback() {
  const list = document.getElementById('wpm-list');
  if (!list) return;
  list.innerHTML = '';
  for (const item of MOBILE_WALLET_LINKS) {
    const btn = document.createElement('button');
    btn.className = 'wpm-wallet';
    btn.onclick = () => {
      window.location.href = item.href();
    };
    btn.innerHTML = `<img class="wpm-wicon" src="${item.icon}" alt="${item.name}" onerror="this.style.display='none'"><div><div class="wpm-wname">${item.name}</div><div class="wpm-wdesc">${item.desc}</div></div><div class="wpm-badge">Open</div>`;
    list.appendChild(btn);
  }
}
export async function _getWcFactory() {
  const globalFactory = window.__wcEthereumProvider || window.WalletConnectEthereumProvider || window.walletconnectEthereumProvider || window['@walletconnect/ethereum-provider']?.EthereumProvider || window['@walletconnect/ethereum-provider']?.default || null;
  if (globalFactory?.init) return globalFactory;
  if (!_wcFactoryPromise) _wcFactoryPromise = Promise.reject(new Error('WalletConnect library not loaded'));
  return _wcFactoryPromise;
}
export async function _getWalletConnectProvider() {
  if (_wcProvider) return _wcProvider;
  const Factory = await _getWcFactory();
  _wcProvider = await Factory.init({
    projectId: WC_PROJECT_ID,
    optionalChains: WC_OPTIONAL_CHAINS,
    methods: WC_METHODS,
    optionalMethods: WC_METHODS,
    events: WC_EVENTS,
    showQrModal: true,
    rpcMap: WC_RPC_MAP,
    metadata: {
      name: 'Coin Blog Bridge',
      description: 'Coin Blog multi-chain bridge',
      url: window.location.origin,
      icons: ['/theme/assets/coin-blog-icon-192.png']
    }
  });
  return _wcProvider;
}
export async function _trySilentReconnect() {
  const candidates = [];
  if (window.ethereum?.request) candidates.push(window.ethereum);
  const wc = await _getWalletConnectProvider().catch(() => null);
  if (wc?.request) candidates.push(wc);
  for (const provider of candidates) {
    try {
      const accounts = await provider.request({
        method: 'eth_accounts'
      });
      if (!accounts?.length) continue;
      state.wallet = accounts[0];
      _wProvider = provider;
      bindWalletEvents(provider);
      onWalletConnected();
      return true;
    } catch (e) {}
  }
  return false;
}
window.addEventListener('eip6963:announceProvider', e => {
  const {
    info,
    provider
  } = e.detail;
  _wDetected.set(info.rdns, {
    info,
    provider
  });
  _renderWalletList();
});
export function _discoverWallets() {
  if (window.ethereum && _wDetected.size === 0) {
    const name = window.ethereum.isRabby ? 'Rabby' : window.ethereum.isMetaMask ? 'MetaMask' : window.ethereum.isBraveWallet ? 'Brave Wallet' : window.ethereum.isCoinbaseWallet ? 'Coinbase Wallet' : 'EVM Wallet';
    const icon = window.ethereum.isRabby ? 'https://rabby.io/assets/images/logo-64.png' : window.ethereum.isMetaMask ? 'https://upload.wikimedia.org/wikipedia/commons/3/36/MetaMask_Fox.svg' : null;
    _wDetected.set('legacy', {
      info: {
        rdns: 'legacy',
        name,
        icon
      },
      provider: window.ethereum
    });
  }
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  _renderWalletList();
  setTimeout(_renderWalletList, 400);
}
export function _renderWalletList() {
  const list = document.getElementById('wpm-list');
  if (!list) return;
  list.innerHTML = '';
  const wcBtn = document.createElement('button');
  wcBtn.className = 'wpm-wallet';
  wcBtn.onclick = () => _connectWalletConnect();
  wcBtn.innerHTML = `<img class="wpm-wicon" src="https://avatars.githubusercontent.com/u/37784886?s=200&v=4" alt="WalletConnect" onerror="this.style.display='none'"><div><div class="wpm-wname">WalletConnect</div><div class="wpm-wdesc">Mobile wallets and QR connect</div></div><div class="wpm-badge">Popular</div>`;
  list.appendChild(wcBtn);
  if (_wDetected.size === 0) {
    return;
  }
  for (const [rdns, {
    info
  }] of _wDetected) {
    const btn = document.createElement('button');
    btn.className = 'wpm-wallet';
    btn.onclick = () => _connectWith(rdns);
    const safeName = esc(info.name || 'EVM Wallet');
    const iconStr = String(info.icon || '');
    const safeIcon = /^https:\/\//i.test(iconStr) || /^data:image\//i.test(iconStr) ? esc(iconStr) : '';
    const ico = safeIcon ? `<img class="wpm-wicon" src="${safeIcon}" alt="${safeName}" onerror="this.style.display='none'">` : `<div class="wpm-wicon">💼</div>`;
    btn.innerHTML = `${ico}<div><div class="wpm-wname">${safeName}</div><div class="wpm-wdesc">EVM compatible</div></div><div class="wpm-badge">Connect</div>`;
    list.appendChild(btn);
  }
}
export async function _connectWalletConnect() {
  _setWpmStatus('Opening WalletConnect...');
  try {
    const provider = await _getWalletConnectProvider();
    const accounts = await provider.enable();
    if (!accounts?.length) throw new Error('No accounts found');
    state.wallet = accounts[0];
    _wProvider = provider;
    bindWalletEvents(provider);
    _setWpmStatus('');
    document.getElementById('wpm-overlay').classList.add('hidden');
    onWalletConnected();
  } catch (e) {
    if ((e?.message || '').includes('WalletConnect library not loaded')) {
      _setWpmStatus('WalletConnect is unavailable here. Open Coin Blog in a wallet app below.', 'err');
      _renderMobileWalletFallback();
      return;
    }
    _setWpmStatus(`WalletConnect failed: ${e?.message || 'unknown error'}`, 'err');
  }
}
export function _setWpmStatus(msg, type = '') {
  const el = document.getElementById('wpm-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'wpm-status' + (type ? ' ' + type : '');
}
export async function _connectWith(rdns) {
  const entry = _wDetected.get(rdns);
  if (!entry) return;
  const provider = entry.provider;
  _setWpmStatus('Connecting…');
  try {
    const accounts = await provider.request({
      method: 'eth_requestAccounts'
    });
    if (!accounts?.length) throw new Error('No accounts found');
    state.wallet = accounts[0];
    _wProvider = provider;
    bindWalletEvents(provider);
    _setWpmStatus('');
    document.getElementById('wpm-overlay').classList.add('hidden');
    onWalletConnected();
  } catch (e) {
    _setWpmStatus(e?.code === 4001 ? 'Connection rejected' : 'Connection failed', 'err');
  }
}
export async function _onAccChange(accs) {
  if (!accs?.length) {
    await wDisconnect();
    return;
  }
  const next = String(accs[0]);
  if (next.toLowerCase() === String(state.wallet || '').toLowerCase()) return;
  state.wallet = next;
  state.bals = {};
  clearRoutes();
  onWalletConnected();
}
export function connectWallet() {
  _setWpmStatus('');
  _renderWalletList();
  document.getElementById('wpm-overlay').classList.remove('hidden');
  _discoverWallets();
}
export function closeWalletModal(e) {
  if (e && e.target !== document.getElementById('wpm-overlay')) return;
  document.getElementById('wpm-overlay').classList.add('hidden');
}
export function onWalletConnected() {
  document.getElementById('conn-btn').style.display = 'none';
  const p = document.getElementById('wallet-pill');
  p.style.display = 'flex';
  document.getElementById('w-addr-disp').textContent = state.wallet.slice(0, 6) + '…' + state.wallet.slice(-4);
  loadBals();
  updateBtnState();
  if (validateAmount(document.getElementById('send-amt').value)) scheduleQuote();
}
export function toggleWMenu() {
  document.getElementById('w-menu').classList.toggle('open');
}
export function wCopy() {
  if (state.wallet) navigator.clipboard.writeText(state.wallet);
  setStatus('Address copied!', 'ok');
  document.getElementById('w-menu').classList.remove('open');
}
export function wExplorer() {
  const n = NETWORKS.find(n => n.id === state.fromChainId);
  if (n && state.wallet) window.open(n.explorer + '/address/' + state.wallet, '_blank');
  document.getElementById('w-menu').classList.remove('open');
}
export async function wDisconnect() {
  unbindWalletEvents();
  if (_wProvider === _wcProvider && _wProvider?.disconnect) {
    try {
      await _wProvider.disconnect();
    } catch (e) {}
  }
  state.wallet = null;
  _wProvider = null;
  document.getElementById('conn-btn').style.display = '';
  document.getElementById('wallet-pill').style.display = 'none';
  document.getElementById('w-menu').classList.remove('open');
  state.bals = {};
  clearRoutes();
  updateBtnState();
}
document.addEventListener('click', e => {
  if (!e.target.closest('#top-right')) {
    document.getElementById('w-menu').classList.remove('open');
  }
  if (!e.target.closest('#chain-modal,#chain-modal-overlay')) {}
});

// ═══════════════════════════════════════════