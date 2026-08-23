import { state } from '../core/state.js';
import { rememberHistoryTokens } from '../core/utils.js';
import { clearRoutes, fetchRoutes, fmtAmt, getRecipientAddress, routeEstimate, routeToolNames, setBtnLoading, setStatus } from '../ui/renderer.js';
import { switchWalletToChain } from '../ui/modals.js';
import { addToHistory, pollBridgeStatus, setProgStep, showProgress, updateHistoryRecord, waitBridgeStatusFinal } from './tracker.js';
import { getRawBalance, loadBals, loadBalsFast } from './balances.js';
import { isValidAddr, isValidTxHash, parseUnitsExact } from '../security/goplus.js';
import { fetch0xQuote, fetchOpenOceanQuote, fetchParaswapQuote } from '../aggregators/api.js';
import { _activeProvider, _currentSecCache, _requestWallet, connectWallet } from '../core/wallet.js';
import { NATIVE, NETWORKS } from '../core/networks.js';

// EXECUTION
// ═══════════════════════════════════════════

export function normalizeWalletHex(value) {
  const text = String(value ?? '0');
  return /^0x/i.test(text) ? `0x${BigInt(text).toString(16)}` : `0x${BigInt(text || '0').toString(16)}`;
}
export async function ensureWalletChain(chainId) {
  const current = await _requestWallet('eth_chainId', [], {
    timeoutMs: 8000
  });
  if (parseInt(current, 16) !== Number(chainId)) await switchWalletToChain(chainId);
  const verified = await _requestWallet('eth_chainId', [], {
    timeoutMs: 8000
  });
  if (parseInt(verified, 16) !== Number(chainId)) throw new Error('Wallet is connected to the wrong network');
}
export async function populateBridgeStep(step) {
  const response = await fetch('/api/bridge-step', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      step
    }),
    signal: AbortSignal.timeout(26000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data.details || data.error || 'Unable to build bridge transaction');
  return data;
}
export async function readAllowance(token, owner, spender) {
  if (!isValidAddr(token) || !isValidAddr(owner) || !isValidAddr(spender)) throw new Error('Invalid allowance parameters');
  const data = '0xdd62ed3e' + owner.slice(2).padStart(64, '0') + spender.slice(2).padStart(64, '0');
  const result = await _requestWallet('eth_call', [{
    to: token,
    data
  }, 'latest'], {
    timeoutMs: 12000
  });
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(result)) throw new Error('Unable to verify token allowance');
  return BigInt(result);
}
export async function assertActiveWalletAccount(expectedAddress) {
  const accounts = await _requestWallet('eth_accounts', [], {
    timeoutMs: 8000
  });
  const active = String(accounts?.[0] || '').toLowerCase();
  if (!isValidAddr(active) || active !== String(expectedAddress || '').toLowerCase()) throw new Error('The active wallet account changed. Reconnect and review the route again.');
  return active;
}

export function validateTransactionPolicy(txData, routeContext, label) {
  // 3. Sanitation Guard
  if (!txData || !txData.to || !txData.data) {
    throw new Error(`Invalid ${label} transaction payload`);
  }
  if (!/^0x[0-9a-fA-F]*$/.test(String(txData.data))) {
    throw new Error(`Invalid ${label} transaction data (not hex)`);
  }
  
  // 4. Native token guard
  const rawValue = String(txData.value || '0');
  let parsedValue = 0n;
  try {
    if (/^0x[0-9a-fA-F]+$/i.test(rawValue)) {
      parsedValue = BigInt(rawValue);
    } else if (/^\d+$/.test(rawValue)) {
      parsedValue = BigInt(rawValue);
    } else {
      throw new Error('Not a number');
    }
  } catch (err) {
    throw new Error(`Invalid ${label} transaction value format`);
  }

  if (parsedValue < 0n) {
    throw new Error(`Invalid ${label} transaction value (negative)`);
  }

  if (label === 'approval' && parsedValue !== 0n) {
    throw new Error('Approval transactions cannot have a native value attached');
  }

  if (label === 'swap' && routeContext && routeContext.txData) {
    const expectedRaw = String(routeContext.txData.value || '0');
    let expectedVal = 0n;
    try {
      if (/^0x[0-9a-fA-F]+$/i.test(expectedRaw)) expectedVal = BigInt(expectedRaw);
      else if (/^\d+$/.test(expectedRaw)) expectedVal = BigInt(expectedRaw);
    } catch (e) {}
    
    if (parsedValue > expectedVal) {
      throw new Error('Swap transaction value exceeds quote requirement');
    }
  }
  
  // 5. TTL Guard
  if (routeContext && routeContext.normalized) {
    if (Date.now() > routeContext.normalized.expiresAt) {
      throw new Error('Quote has expired. Please refresh the route.');
    }
  }
  return true;
}

export async function sendWalletTransaction(request, chainId, label = 'transaction', options = {}) {
  const fromAddress = String(options.fromAddress || state.wallet || '').toLowerCase();
  if (!isValidAddr(fromAddress)) throw new Error('Invalid transaction sender');
  await ensureWalletChain(chainId);
  await assertActiveWalletAccount(fromAddress);
    validateTransactionPolicy(request, options.routeContext, label);
  const tx = {
    from: fromAddress,
    to: request.to,
    data: request.data || '0x',
    value: normalizeWalletHex(request.value || 0),
    chainId: `0x${Number(chainId).toString(16)}`
  };
  let estimate;
  try {
    estimate = await _requestWallet('eth_estimateGas', [tx], {
      timeoutMs: 18000
    });
  } catch (e) {
    throw new Error(`${label} simulation failed: ${e?.message || 'transaction would revert'}`);
  }
  const gas = BigInt(estimate) * 115n / 100n;
  tx.gas = `0x${gas.toString(16)}`;
  const hash = await _requestWallet('eth_sendTransaction', [tx], {
    timeoutMs: 45000
  });
  if (!isValidTxHash(hash)) throw new Error(`Invalid ${label} transaction hash`);
  try {
    if (typeof options.onHash === 'function') options.onHash(hash);
  } catch (e) {}
  await waitForTx(hash, chainId);
  return hash;
}
export async function sendApproval(token, spender, amount, chainId, owner) {
  const amountHex = BigInt(amount).toString(16).padStart(64, '0');
  const data = '0x095ea7b3' + spender.slice(2).padStart(64, '0') + amountHex;
  return sendWalletTransaction({
    to: token,
    data,
    value: '0x0'
  }, chainId, 'approval', {
    fromAddress: owner
  });
}
export async function checkAndApproveToken(token, spender, amount, chainId, owner) {
  if (token === NATIVE || String(token).toLowerCase() === '0x0000000000000000000000000000000000000000') return true;
  if (!isValidAddr(token) || !isValidAddr(spender) || !isValidAddr(owner)) throw new Error('Invalid approval target');
  await ensureWalletChain(chainId);
  await assertActiveWalletAccount(owner);
  const required = BigInt(amount);
  const cache = state._lastBridgeApprove;
  if (cache && cache.chainId === chainId && cache.owner === owner.toLowerCase() && cache.token === token.toLowerCase() && cache.spender === spender.toLowerCase() && cache.amount >= required) return true;
  let allowance = await readAllowance(token, owner, spender);
  if (allowance >= required) return true;
  setStatus(`Confirm ${state.fromTok?.sym || 'token'} allowance in your wallet…`, 'warn');
  try {
    await sendApproval(token, spender, required, chainId, owner);
  } catch (firstErr) {
    if (allowance > 0n) {
      setStatus('Resetting existing token allowance to 0…', 'warn');
      await sendApproval(token, spender, 0n, chainId, owner);
      setStatus(`Confirm new ${state.fromTok?.sym || 'token'} allowance…`, 'warn');
      await sendApproval(token, spender, required, chainId, owner);
    } else {
      throw firstErr;
    }
  }
  let verified = await readAllowance(token, owner, spender);
  for (let i = 0; i < 5 && verified < required; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    verified = await readAllowance(token, owner, spender);
  }
  if (verified < required) throw new Error('Token allowance was not granted');
  state._lastBridgeApprove = {
    chainId,
    owner: owner.toLowerCase(),
    token: token.toLowerCase(),
    spender: spender.toLowerCase(),
    amount: required
  };
  return true;
}
export async function waitForTx(hash, chainId) {
  const provider = _activeProvider();
  if (!provider) throw new Error('Wallet provider disconnected');
  for (let attempt = 0; attempt < 100; attempt++) {
    const receipt = await provider.request({
      method: 'eth_getTransactionReceipt',
      params: [hash]
    }).catch(() => null);
    if (receipt) {
      if (receipt.status === '0x1' || receipt.status === 1) return receipt;
      if (receipt.status === '0x0' || receipt.status === 0) throw new Error('Transaction reverted on-chain');
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  throw new Error('Transaction confirmation timed out');
}
export async function doBridge() {
  if (!state.wallet) {
    connectWallet();
    return;
  }
  const route = state.routes[state.selectedRouteIdx];
  if (!route) {
    setStatus('Select a route first.', 'err');
    return;
  }
  if (Date.now() > state.routesExpiresAt) {
    setStatus('The route expired. It has been refreshed; review it and press Swap/Bridge again.', 'warn');
    await fetchRoutes();
    return;
  }
  if (state.slippage > 1 && !confirm(`Slippage is ${state.slippage}%. Continue with this high tolerance?`)) return;
  const secKey = state.fromChainId + '-' + (state.fromTok.addr || '').toLowerCase();
  const sec = _currentSecCache[secKey];
  if (sec) {
    if (sec.cannot_sell || sec.is_honeypot) {
      setStatus(`Security check failed: ${state.fromTok.sym} is flagged as a honeypot and cannot be sold.`, 'err');
      return;
    }
    if ((sec.buy_tax > 0.05 || sec.sell_tax > 0.05) && !confirm(`${state.fromTok.sym} has high transfer taxes (Buy: ${(sec.buy_tax * 100).toFixed(1)}%, Sell: ${(sec.sell_tax * 100).toFixed(1)}%). This reduces your received amount. Continue?`)) {
      return;
    }
  }
  const executionWallet = String(state.wallet).toLowerCase();
  let recipient;
  try {
    recipient = getRecipientAddress();
    if (!recipient) throw new Error('Connect a wallet or enter a recipient address');
    const firstAction = route.steps?.[0]?.action || {};
    const finalAction = route.steps?.at(-1)?.action || {};
    if (firstAction.fromAddress && String(firstAction.fromAddress).toLowerCase() !== executionWallet) throw new Error('The selected route belongs to another wallet. Refresh the route.');
    if (finalAction.toAddress && String(finalAction.toAddress).toLowerCase() !== String(recipient).toLowerCase()) throw new Error('The destination recipient changed. Refresh the route.');
  } catch (e) {
    setStatus(e.message, 'err');
    return;
  }
  setBtnLoading(true);
  showProgress('', routeToolNames(route).join(' → '));
  const initialFromChainId = state.fromChainId,
    initialToChainId = state.toChainId;
  const initialFromTok = {
      ...state.fromTok
    },
    initialToTok = {
      ...state.toTok
    };
  const sendAmountText = document.getElementById('send-amt').value;
  const fromNet = NETWORKS.find(n => n.id === initialFromChainId),
    toNet = NETWORKS.find(n => n.id === initialToChainId);
  const tokenSnapshots = [{
    ...initialFromTok,
    chainId: initialFromChainId
  }, {
    ...initialToTok,
    chainId: initialToChainId
  }];
  let historyItem = null,
    crossHash = null,
    crossTool = '',
    crossFromChain = null,
    crossToChain = null,
    lastHash = null;
  try {
    await assertActiveWalletAccount(executionWallet);
    if (route.isSwap) {
      const chainId = initialFromChainId;
      await ensureWalletChain(chainId);
      await assertActiveWalletAccount(executionWallet);
      const spender = route.allowanceTarget;
      const rawAmount = parseUnitsExact(sendAmountText, initialFromTok.dec);

      // Check native balance + gas reserve
      if (initialFromTok.addr.toLowerCase() === NATIVE) {
        const bal = getRawBalance(initialFromTok);
        if (bal !== null && rawAmount > bal) {
          throw new Error(`Insufficient ${initialFromTok.sym} balance for amount and network gas.`);
        }
      }
      if (initialFromTok.addr.toLowerCase() !== NATIVE && spender) {
        setProgStep(0, 'active');
        setStatus(`Approve ${initialFromTok.sym} in your wallet...`, 'warn');
        await checkAndApproveToken(initialFromTok.addr, spender, String(rawAmount), chainId, executionWallet);
      }
      setProgStep(0, 'done');
      setProgStep(1, 'active');

      // Ensure we have executable transaction data (re-fetch if quote was obtained before approval)
      let txData = route.txData;
      if (!txData || !txData.to || !txData.data) {
        setStatus('Preparing swap transaction…', 'warn');
        const slipBps = Math.round(Math.min(Math.max(state.slippage, 0.01), 5) * 100);
        const rawStr = rawAmount.toString();
        let fresh;
        if (route.tool === 'ParaSwap') {
          fresh = await fetchParaswapQuote(rawStr, slipBps);
        } else if (route.tool === '0x Protocol') {
          fresh = await fetch0xQuote(rawStr, slipBps);
        } else if (route.tool === 'OpenOcean') {
          fresh = await fetchOpenOceanQuote(rawStr, slipBps);
        }
        if (fresh) {
          txData = fresh.txRequest;
          route.normalized = fresh;
          route.allowanceTarget = fresh.allowanceTarget;
        }
      }
      if (!txData || !txData.to || !txData.data) {
        throw new Error('Could not build executable swap transaction. Please refresh quotes and try again.');
      }
      setStatus('Confirm swap in your wallet...', 'warn');
      const hash = await sendWalletTransaction(txData, chainId, 'swap', {
          routeContext: route,
        fromAddress: executionWallet,
        onHash: submittedHash => {
          lastHash = submittedHash;
          const sourceNetwork = NETWORKS.find(net => net.id === chainId) || fromNet;
          historyItem = {
            hash: submittedHash,
            status: 'pending',
            fromSym: initialFromTok.sym,
            toSym: initialToTok.sym,
            sendAmt: sendAmountText,
            recvAmt: fmtAmt(routeEstimate(route).toAmount, initialToTok.dec),
            fromNet: fromNet?.name,
            toNet: toNet?.name,
            fromChainId: initialFromChainId,
            toChainId: initialToChainId,
            statusFromChainId: initialFromChainId,
            statusToChainId: initialToChainId,
            bridge: route.tool,
            explorer: sourceNetwork?.explorer,
            recipient,
            routeId: String(route.id || ''),
            tokenSnapshots,
            stepHashes: [submittedHash],
            ts: Date.now()
          };
          addToHistory(historyItem);
        }
      });
      lastHash = hash;
      setProgStep(1, 'done');
      setProgStep(2, 'done');
      setStatus('Swap completed successfully! 🎉', 'ok');
    } else {
      for (let index = 0; index < route.steps.length; index++) {
        const originalStep = route.steps[index];
        const populated = await populateBridgeStep(originalStep);
        const step = populated.step || originalStep;
        const action = step.action || originalStep.action;
        const chainId = Number(action.fromChainId);
        if (action.fromAddress && String(action.fromAddress).toLowerCase() !== executionWallet) throw new Error('A route step has an unexpected sender address');
        await ensureWalletChain(chainId);
        await assertActiveWalletAccount(executionWallet);
        const tokenAddress = String(action.fromToken?.address || '').toLowerCase();
        const spender = String(populated.approvalAddress || '');
        if (tokenAddress !== NATIVE && tokenAddress !== '0x0000000000000000000000000000000000000000') await checkAndApproveToken(tokenAddress, spender, String(action.fromAmount), chainId, executionWallet);
        setProgStep(0, 'done');
        setProgStep(1, 'active');
        setStatus(`Confirm step ${index + 1} of ${route.steps.length} in your wallet…`, 'warn');
        const isCross = Number(action.fromChainId) !== Number(action.toChainId);
        const stepTool = String(step.tool || originalStep.tool || 'bridge');
        const hash = await sendWalletTransaction(populated.transactionRequest, chainId, `bridge step ${index + 1}`, {
            routeContext: route,
            fromAddress: executionWallet,
          onHash: submittedHash => {
            lastHash = submittedHash;
            if (isCross) {
              crossHash = submittedHash;
              crossTool = stepTool;
              crossFromChain = Number(action.fromChainId);
              crossToChain = Number(action.toChainId);
              setProgStep(2, 'active');
            }
            if (!historyItem) {
              const sourceNetwork = NETWORKS.find(net => net.id === chainId) || fromNet;
              historyItem = {
                hash: submittedHash,
                status: 'pending',
                fromSym: initialFromTok.sym,
                toSym: initialToTok.sym,
                sendAmt: sendAmountText,
                recvAmt: fmtAmt(routeEstimate(route).toAmount, initialToTok.dec),
                fromNet: fromNet?.name,
                toNet: toNet?.name,
                fromChainId: initialFromChainId,
                toChainId: initialToChainId,
                statusFromChainId: isCross ? Number(action.fromChainId) : initialFromChainId,
                statusToChainId: isCross ? Number(action.toChainId) : initialToChainId,
                bridge: isCross ? stepTool : stepTool,
                explorer: sourceNetwork?.explorer,
                recipient,
                routeId: String(route.id || ''),
                tokenSnapshots,
                stepHashes: [submittedHash],
                ts: Date.now()
              };
              addToHistory(historyItem);
            } else {
              const previousHash = historyItem.hash;
              if (!historyItem.stepHashes.includes(submittedHash)) historyItem.stepHashes.push(submittedHash);
              const patch = {
                stepHashes: historyItem.stepHashes,
                bridge: isCross ? stepTool : historyItem.bridge
              };
              if (isCross) {
                const crossNet = NETWORKS.find(net => net.id === Number(action.fromChainId));
                Object.assign(patch, {
                  hash: submittedHash,
                  explorer: crossNet?.explorer || historyItem.explorer,
                  statusFromChainId: Number(action.fromChainId),
                  statusToChainId: Number(action.toChainId)
                });
              }
              updateHistoryRecord(previousHash, patch);
              if (isCross) historyItem.hash = submittedHash;
            }
          }
        });
        lastHash = hash;
        setProgStep(1, 'done');
        if (isCross && index < route.steps.length - 1) {
          setStatus('Waiting for the cross-chain step before continuing…', 'warn');
          const final = await waitBridgeStatusFinal(hash, Number(action.fromChainId), Number(action.toChainId), crossTool);
          if (final.status !== 'DONE' || final.substatus !== 'COMPLETED') {
            const error = new Error(final.substatusMessage || `Cross-chain step ended as ${final.substatus || final.status}`);
            error.bridgeStatus = final.status === 'DONE' && final.substatus === 'PARTIAL' ? 'partial' : final.status === 'DONE' && final.substatus === 'REFUNDED' ? 'refunded' : 'failed';
            error.bridgeData = final;
            throw error;
          }
        }
      }
    }

    // Common completion for both Swap and Bridge
    state._bridgeNeedsApproval = false;
    state._lastBridgeApprove = null;
    document.getElementById('send-amt').value = '';
    document.getElementById('send-usd').textContent = '≈ $0.00';
    clearRoutes();
    loadBalsFast();
    setTimeout(loadBals, 4000);
    if (crossHash) {
      pollBridgeStatus(crossHash, crossFromChain || initialFromChainId, crossToChain || initialToChainId, crossTool || historyItem?.bridge || '');
      setStatus('Source transaction confirmed. Tracking the destination transfer…', 'warn');
    } else {
      updateHistoryRecord(historyItem?.hash || lastHash, {
        status: 'confirmed'
      });
      const confirmedItem = state.txHistory.find(entry => entry.hash === (historyItem?.hash || lastHash));
      if (confirmedItem) rememberHistoryTokens({
        ...confirmedItem,
        status: 'confirmed'
      });
      setProgStep(2, 'done');
      setProgStep(3, 'done');
      if (!route.isSwap) setStatus('Bridge route completed.', 'ok');
    }
  } catch (e) {
    const timedOut = /confirmation timed out/i.test(String(e?.message || ''));
    if (historyItem) updateHistoryRecord(historyItem.hash, {
      status: timedOut ? 'pending' : e.bridgeStatus || 'failed',
      message: e.message,
      substatus: e.bridgeData?.substatus || ''
    });
    if (timedOut && crossHash) pollBridgeStatus(crossHash, crossFromChain || initialFromChainId, crossToChain || initialToChainId, crossTool || historyItem?.bridge || '', {
      immediate: true
    });
    setProgStep(2, timedOut ? 'active' : 'failed');
    setStatus(e?.code === 4001 ? 'Transaction rejected' : e?.message || (route.isSwap ? 'Swap failed' : 'Bridge failed'), timedOut ? 'warn' : 'err');
  } finally {
    setBtnLoading(false);
  }
}

// ═══════════════════════════════════════════
