import { state } from '../core/state.js';
import { chainIconHTML, hydrateMajorTokensForChain } from '../core/icons.js';
import { clearRoutes, scheduleQuote, setStatus } from './renderer.js';
import { _requestWallet, updateChainUI, updateTokenUI } from '../core/wallet.js';
import { loadBals, loadBalsFast, updateBals } from '../execution/balances.js';
import { NETWORKS, TOKENS } from '../core/networks.js';
import { esc } from '../security/goplus.js';

// CHAIN MODAL
// ═══���════════��═��════════════════════════════
export let chainModalFor = null;
export function openChainModal(side) {
  chainModalFor = side;
  const ovr = document.getElementById('chain-modal-overlay');
  ovr.classList.add('open');
  document.getElementById('chain-modal-title').textContent = side === 'from' ? 'From Network' : 'To Network';
  document.getElementById('chain-modal-sub').textContent = side === 'from' ? 'Choose source network' : 'Choose destination network';
  document.getElementById('chain-search').value = '';
  renderChainGrid('');
  setTimeout(() => document.getElementById('chain-search').focus(), 80);
}
export function closeChainModal(e) {
  if (e && e.target !== document.getElementById('chain-modal-overlay')) return;
  document.getElementById('chain-modal-overlay').classList.remove('open');
}
export function filterChains() {
  renderChainGrid(document.getElementById('chain-search').value);
}
export function renderChainGrid(q) {
  q = q.toLowerCase().trim();
  const filtered = q ? NETWORKS.filter(n => n.name.toLowerCase().includes(q) || n.sym.toLowerCase().includes(q)) : NETWORKS;
  const activeId = chainModalFor === 'from' ? state.fromChainId : state.toChainId;
  document.getElementById('chain-grid').innerHTML = filtered.map(n => `
    <div class="chain-grid-item${n.id === activeId ? ' active' : ''}" role="button" tabindex="0" onclick="pickChain(${n.id})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();pickChain(${n.id})}">
      ${chainIconHTML(n, 32)}
      <div>
        <div class="cgi-name">${esc(n.name)}</div>
        <div class="cgi-sym">${esc(n.sym)}</div>
      </div>
    </div>`).join('');
}
export async function switchWalletToChain(chainId) {
  if (!state.wallet) throw new Error('Connect a wallet first');
  const net = NETWORKS.find(item => item.id === Number(chainId));
  if (!net) throw new Error('Unsupported network');
  const hexId = `0x${Number(chainId).toString(16)}`;
  try {
    await _requestWallet('wallet_switchEthereumChain', [{
      chainId: hexId
    }], {
      timeoutMs: 20000
    });
  } catch (error) {
    if (error?.code !== 4902 && error?.code !== -32603) throw error;
    await _requestWallet('wallet_addEthereumChain', [{
      chainId: hexId,
      chainName: net.name,
      nativeCurrency: {
        name: net.currency || net.sym,
        symbol: net.currency || net.sym,
        decimals: Number(net.decimals || 18)
      },
      rpcUrls: [net.rpc],
      blockExplorerUrls: [net.explorer]
    }], {
      timeoutMs: 25000
    });
    await _requestWallet('wallet_switchEthereumChain', [{
      chainId: hexId
    }], {
      timeoutMs: 20000
    });
  }
  const current = await _requestWallet('eth_chainId', [], {
    timeoutMs: 8000
  });
  if (parseInt(current, 16) !== Number(chainId)) throw new Error('Network switch was not completed');
  return true;
}
export async function pickChain(id) {
  await hydrateMajorTokensForChain(id);
  const wasFrom = chainModalFor === 'from';
  let swapped = false;
  if (wasFrom) {
    state.fromChainId = id;
  } else {
    state.toChainId = id;
  }
  await Promise.all([hydrateMajorTokensForChain(state.fromChainId), hydrateMajorTokensForChain(state.toChainId)]);
  if (swapped) {
    state.fromTok = TOKENS[state.fromChainId]?.[0] || TOKENS[1][0];
    state.toTok = TOKENS[state.toChainId]?.[0] || TOKENS[1][0];
  } else if (wasFrom) state.fromTok = TOKENS[state.fromChainId]?.[0] || TOKENS[1][0];else state.toTok = TOKENS[state.toChainId]?.[0] || TOKENS[1][0];
  if (wasFrom) switchWalletToChain(state.fromChainId).catch(error => setStatus(error?.code === 4001 ? 'Network switch rejected' : error.message || 'Unable to switch network', 'err'));
  document.getElementById('chain-modal-overlay').classList.remove('open');
  state._bridgeNeedsApproval = false;
  state._lastBridgeApprove = null;
  updateChainUI();
  updateTokenUI();
  clearRoutes();
  updateBals();
  scheduleQuote();
  if (state.wallet) {
    loadBalsFast();
    loadBals();
  }
}

// ═══════════════════════════════════════════