import { state } from '../core/state.js';
import { NATIVE } from '../core/networks.js';

// SWAP AGGREGATORS SUPPORT
// ═══════════════════════════════════════════
export const OO_CHAIN = {
  1: 1,
  10: 10,
  56: 56,
  137: 137,
  8453: 8453,
  42161: 42161,
  43114: 43114,
  59144: 59144,
  534352: 534352,
  130: 130,
  146: 146,
  80094: 80094,
  5000: 5000,
  81457: 81457,
  34443: 34443,
  999: 'hyperevm',
  143: 'monad',
  9745: 'plasma',
  4663: '4663',
  324: 'zksync',
  1329: 'sei',
  1776: 'injective'
};
export const PARASWAP_CHAIN = new Set([1, 10, 56, 130, 137, 146, 8453, 42161, 43114, 9745]);
export const ooGasCache = new Map();
export function openOceanTokenAddress(tok) {
  if (!tok || !tok.addr) return '';
  return tok.addr === NATIVE ? '0x0000000000000000000000000000000000000000' : tok.addr;
}
export function parseOpenOceanGasPriceWei(payload) {
  const candidates = [payload?.data?.standard?.legacyGasPrice, payload?.data?.standard?.maxFeePerGas, payload?.data?.fast?.legacyGasPrice, payload?.data?.fast?.maxFeePerGas, payload?.data?.instant?.legacyGasPrice, payload?.data?.instant?.maxFeePerGas];
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const clean = String(candidate).trim();
    if (/^\d+$/.test(clean) && clean !== '0') return clean;
  }
  return null;
}
export async function fetchOpenOceanGasPriceWei(ooChain) {
  const cached = ooGasCache.get(ooChain);
  if (cached && cached.expires > Date.now()) return cached.value;
  let value = '3000000000';
  try {
    const response = await fetch(`/api/proxy-openocean/v4/${ooChain}/gasPrice`, {
      signal: AbortSignal.timeout(8000)
    });
    const payload = await response.json().catch(() => ({}));
    if (response.ok && Number(payload.code) === 200) {
      const parsed = parseOpenOceanGasPriceWei(payload);
      if (parsed) value = parsed;
    }
  } catch {}
  ooGasCache.set(ooChain, {
    value,
    expires: Date.now() + 15000
  });
  return value;
}
export async function fetch0xQuote(sellAmt, slipBps) {
  const params = new URLSearchParams({
    chainId: String(state.fromChainId),
    sellToken: state.fromTok.addr,
    buyToken: state.toTok.addr,
    sellAmount: sellAmt,
    slippageBps: String(slipBps)
  });
  if (state.wallet) params.set('taker', state.wallet);
  const response = await fetch('/api/swap-quote?' + params.toString(), {
    signal: AbortSignal.timeout(12000)
  });
  const q = await response.json();
  if (!response.ok || q.code || q.reason || q.validationErrors || q.error) {
    throw new Error(q.reason || q.error || q.validationErrors?.[0]?.reason || 'No route');
  }
  if (q.liquidityAvailable === false) throw new Error('0x reported no available liquidity');
  const allowanceTarget = q?.issues?.allowance?.spender || q?.allowanceTarget || null;
  return {
    aggregator: '0x Protocol',
    isBridge: false,
    buyAmount: String(q.buyAmount),
    minBuyAmount: String(q.minBuyAmount || q.buyAmount),
    createdAt: Date.now(),
    expiresAt: Date.now() + 60000,
    allowanceTarget,
    txRequest: q.transaction,
    _logo: 'https://images.ctfassets.net/4n51k5s048w0/4X80u569iI2yMY4Y60OaWc/fa67746536551b9e26ff8903c733364f/0x-logo.png',
    raw: q
  };
}
export async function fetchParaswapQuote(sellAmt, slipBps) {
  if (!PARASWAP_CHAIN.has(state.fromChainId)) throw new Error('Chain not supported');
  const params = new URLSearchParams({
    chainId: String(state.fromChainId),
    srcToken: state.fromTok.addr,
    destToken: state.toTok.addr,
    amount: sellAmt,
    srcDecimals: String(state.fromTok.dec),
    destDecimals: String(state.toTok.dec),
    slippageBps: String(slipBps)
  });
  if (state.wallet) params.set('taker', state.wallet);
  const response = await fetch('/api/paraswap-quote?' + params.toString(), {
    signal: AbortSignal.timeout(15000)
  });
  const q = await response.json();
  if (!response.ok || q.error) throw new Error(q.error || 'Paraswap route unavailable');
  return {
    aggregator: 'ParaSwap',
    isBridge: false,
    buyAmount: String(q.buyAmount),
    minBuyAmount: String(q.minBuyAmount || q.buyAmount),
    createdAt: Date.now(),
    expiresAt: Date.now() + 30000,
    allowanceTarget: q.allowanceTarget || q.tokenTransferProxy,
    txRequest: q.transaction,
    _logo: 'https://app.paraswap.xyz/logo.svg',
    raw: q
  };
}
export async function fetchOpenOceanQuote(sellAmt, slipBps) {
  const ooChain = OO_CHAIN[state.fromChainId];
  if (!ooChain) throw new Error('Chain not supported');
  const gasPriceWei = await fetchOpenOceanGasPriceWei(ooChain);
  const params = new URLSearchParams({
    inTokenAddress: openOceanTokenAddress(state.fromTok),
    outTokenAddress: openOceanTokenAddress(state.toTok),
    amountDecimals: sellAmt,
    gasPriceDecimals: gasPriceWei,
    slippage: String(Math.max(0.05, slipBps / 100))
  });
  if (state.wallet) params.set('account', state.wallet);
  const response = await fetch(`/api/proxy-openocean/v4/${ooChain}/swap?${params.toString()}`, {
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error('OpenOcean route unavailable');
  const payload = await response.json().catch(() => ({}));
  if (Number(payload?.code) !== 200 || !payload?.data) throw new Error(payload?.error || payload?.message || 'OpenOcean route unavailable');
  const data = payload.data;
  const rawOut = String(data.outAmount || '0');
  const transaction = data.to && data.data ? {
    to: data.to,
    data: data.data,
    value: data.value || '0',
    gas: data.estimatedGas,
    gasPrice: data.gasPrice || gasPriceWei
  } : null;
  let allowanceTarget = data.allowanceTarget || data.approveContract || data.exchange || null;
  return {
    _agg: 'OpenOcean',
    _logo: 'https://openocean.finance/favicon.ico',
    buyAmount: rawOut,
    minBuyAmount: String(data.minOutAmount || rawOut),
    transaction,
    allowanceTarget
  };
}
'use strict';
// ═══════════════════════════════════════════