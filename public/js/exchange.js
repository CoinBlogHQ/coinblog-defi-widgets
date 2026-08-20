
const IGNORED_TOOLS = new Set(['integrator fee', 'fee collection', 'custom fee', 'integrator-fee', 'lifi', 'bridge']);

function getPrimaryBridgeTool(route){
  if(route.isSwap) {
    return { name: route.tool || '0x Protocol', logo: route.steps?.[0]?.toolDetails?.logoURI || '', toolKey: 'swap' };
  }
  for(const step of route?.steps||[]){
    const included=Array.isArray(step?.includedSteps)&&step.includedSteps.length?step.includedSteps:[step];
    for(const child of included){
      const toolKey=String(child?.tool||'').toLowerCase();
      const toolName=String(child?.toolDetails?.name||child?.tool||'').trim();
      if(toolName && !IGNORED_TOOLS.has(toolName.toLowerCase()) && !IGNORED_TOOLS.has(toolKey)){
        return {
          name: toolName,
          logo: String(child?.toolDetails?.logoURI||''),
          toolKey: toolKey
        };
      }
    }
  }
  return { name: 'Bridge', logo: '', toolKey: 'bridge' };
}


// ═══════════════════════════════════════════
// SWAP AGGREGATORS SUPPORT
// ═══════════════════════════════════════════
const OO_CHAIN = { 1:1,10:10,56:56,137:137,8453:8453,42161:42161,43114:43114,59144:59144,534352:534352,130:130,146:146,80094:80094,5000:5000,81457:81457,34443:34443,999:'hyperevm',143:'monad',9745:'plasma',4663:'4663',324:'zksync',1329:'sei',1776:'injective' };
const PARASWAP_CHAIN = new Set([1,10,56,130,137,146,8453,42161,43114,9745]);
const ooGasCache = new Map();

function openOceanTokenAddress(tok) {
  if(!tok || !tok.addr) return '';
  return tok.addr === NATIVE ? '0x0000000000000000000000000000000000000000' : tok.addr;
}

function parseOpenOceanGasPriceWei(payload) {
  const candidates = [
    payload?.data?.standard?.legacyGasPrice,
    payload?.data?.standard?.maxFeePerGas,
    payload?.data?.fast?.legacyGasPrice,
    payload?.data?.fast?.maxFeePerGas,
    payload?.data?.instant?.legacyGasPrice,
    payload?.data?.instant?.maxFeePerGas,
  ];
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const clean = String(candidate).trim();
    if (/^\d+$/.test(clean) && clean !== '0') return clean;
  }
  return null;
}

async function fetchOpenOceanGasPriceWei(ooChain) {
  const cached = ooGasCache.get(ooChain);
  if (cached && cached.expires > Date.now()) return cached.value;
  let value = '3000000000';
  try {
    const response = await fetch(`/api/proxy-openocean/v4/${ooChain}/gasPrice`, { signal: AbortSignal.timeout(8000) });
    const payload = await response.json().catch(() => ({}));
    if (response.ok && Number(payload.code) === 200) {
      const parsed = parseOpenOceanGasPriceWei(payload);
      if (parsed) value = parsed;
    }
  } catch {}
  ooGasCache.set(ooChain, { value, expires: Date.now() + 15000 });
  return value;
}

async function fetch0xQuote(sellAmt, slipBps) {
  const params = new URLSearchParams({ chainId:String(fromChainId), sellToken:fromTok.addr, buyToken:toTok.addr, sellAmount:sellAmt, slippageBps:String(slipBps) });
  if(wallet) params.set('taker', wallet);
  const response = await fetch('/api/swap-quote?' + params.toString(), { signal: AbortSignal.timeout(12000) });
  const q = await response.json();
  if(!response.ok || q.code || q.reason || q.validationErrors || q.error) {
    throw new Error(q.reason || q.error || q.validationErrors?.[0]?.reason || 'No route');
  }
  if(q.liquidityAvailable === false) throw new Error('0x reported no available liquidity');
  const allowanceTarget = q?.issues?.allowance?.spender || q?.allowanceTarget || null;
  return {
    ...q,
    _agg:'0x Protocol',
    _logo:'https://images.ctfassets.net/4n51k5s048w0/4X80u569iI2yMY4Y60OaWc/fa67746536551b9e26ff8903c733364f/0x-logo.png',
    buyAmount: q.buyAmount,
    minBuyAmount: q.minBuyAmount || q.buyAmount,
    transaction: q.transaction,
    allowanceTarget,
  };
}

async function fetchParaswapQuote(sellAmt, slipBps) {
  if(!PARASWAP_CHAIN.has(fromChainId)) throw new Error('Chain not supported');
  const params = new URLSearchParams({
    chainId:String(fromChainId), srcToken:fromTok.addr, destToken:toTok.addr,
    amount:sellAmt, srcDecimals:String(fromTok.dec), destDecimals:String(toTok.dec),
    slippageBps:String(slipBps),
  });
  if(wallet) params.set('taker', wallet);
  const response = await fetch('/api/paraswap-quote?' + params.toString(), { signal:AbortSignal.timeout(15000) });
  const q = await response.json();
  if(!response.ok || q.error) throw new Error(q.error || 'Paraswap route unavailable');
  return {
    ...q,
    _agg:'ParaSwap',
    _logo:'https://app.paraswap.xyz/logo.svg',
    buyAmount: q.buyAmount,
    minBuyAmount: q.minBuyAmount || q.buyAmount,
    transaction: q.transaction,
    allowanceTarget: q.allowanceTarget || q.tokenTransferProxy,
  };
}

async function fetchOpenOceanQuote(sellAmt, slipBps) {
  const ooChain = OO_CHAIN[fromChainId];
  if(!ooChain) throw new Error('Chain not supported');
  const gasPriceWei = await fetchOpenOceanGasPriceWei(ooChain);
  const params = new URLSearchParams({
    inTokenAddress:openOceanTokenAddress(fromTok),
    outTokenAddress:openOceanTokenAddress(toTok),
    amountDecimals:sellAmt,
    gasPriceDecimals:gasPriceWei,
    slippage:String(Math.max(0.05, slipBps / 100)),
  });
  if(wallet) params.set('account', wallet);
  const response = await fetch(`/api/proxy-openocean/v4/${ooChain}/swap?${params.toString()}`, { signal:AbortSignal.timeout(10000) });
  if(!response.ok) throw new Error('OpenOcean route unavailable');
  const payload = await response.json().catch(() => ({}));
  if(Number(payload?.code) !== 200 || !payload?.data) throw new Error(payload?.error || payload?.message || 'OpenOcean route unavailable');
  const data = payload.data;
  const rawOut = String(data.outAmount || '0');
  const transaction = data.to && data.data ? {
    to:data.to,
    data:data.data,
    value:data.value || '0',
    gas:data.estimatedGas,
    gasPrice:data.gasPrice || gasPriceWei,
  } : null;
  let allowanceTarget = data.allowanceTarget || data.approveContract || data.exchange || null;
  return {
    _agg:'OpenOcean',
    _logo:'https://openocean.finance/favicon.ico',
    buyAmount: rawOut,
    minBuyAmount: String(data.minOutAmount || rawOut),
    transaction,
    allowanceTarget,
  };
}

'use strict';
// ═══════════════════════════════════════════
// SECURITY HELPERS
// ═══════════════════════════════════════════
function esc(str){ return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function isValidAddr(addr){ return /^0x[0-9a-fA-F]{40}$/.test(addr); }
function isValidTxHash(h){ return /^0x[0-9a-fA-F]{64}$/.test(h); }
function normalizeDecimalInput(value){
  const raw=String(value??'').trim().replace(',','.');
  return /^\d*(?:\.\d*)?$/.test(raw)?raw:'';
}
function validateAmount(value){
  const raw=normalizeDecimalInput(value);
  return !!raw && /[1-9]/.test(raw) && raw.length<=100;
}
function parseUnitsExact(value,decimals){
  const raw=normalizeDecimalInput(value);
  if(!raw||!Number.isInteger(decimals)||decimals<0||decimals>36) throw new Error('Invalid token amount');
  const [whole='0',fraction='']=raw.split('.');
  if(fraction.length>decimals) throw new Error(`Too many decimal places. ${decimals} maximum.`);
  const digits=(whole||'0')+fraction.padEnd(decimals,'0');
  const normalized=digits.replace(/^0+(?=\d)/,'')||'0';
  return BigInt(normalized);
}
function formatUnitsExact(value,decimals,maxDecimals=8){
  const raw=BigInt(value||0);
  const negative=raw<0n;
  const abs=negative?-raw:raw;
  const base=10n**BigInt(decimals);
  const whole=abs/base;
  let fraction=(abs%base).toString().padStart(decimals,'0').slice(0,Math.max(0,maxDecimals)).replace(/0+$/,'');
  return `${negative?'-':''}${whole}${fraction?'.'+fraction:''}`;
}
function getSendRawAmount(){ return parseUnitsExact(document.getElementById('send-amt').value,Number(fromTok?.dec??18)); }
function parseSendAmt(){ const raw=normalizeDecimalInput(document.getElementById('send-amt').value); return Number(raw||0); }

// ═══════════════════════════════════════════
// NETWORKS
// ═══════════════════════════════════════════
const NETWORKS = [
  { id:1,      name:'Ethereum',  sym:'ETH',  decimals:18, icon:'https://s2.coinmarketcap.com/static/img/coins/64x64/1027.png',  explorer:'https://etherscan.io',              rpc:'https://eth.llamarpc.com',              currency:'ETH' },
  { id:8453,   name:'Base',      sym:'ETH',  decimals:18, icon:'https://s2.coinmarketcap.com/static/img/coins/64x64/27716.png', explorer:'https://basescan.org',              rpc:'https://mainnet.base.org',              currency:'ETH' },
  { id:42161,  name:'Arbitrum',  sym:'ETH',  decimals:18, icon:'https://s2.coinmarketcap.com/static/img/coins/64x64/11841.png', explorer:'https://arbiscan.io',               rpc:'https://arb1.arbitrum.io/rpc',          currency:'ETH' },
  { id:10,     name:'Optimism',  sym:'ETH',  decimals:18, icon:'https://s2.coinmarketcap.com/static/img/coins/64x64/11840.png', explorer:'https://optimistic.etherscan.io',   rpc:'https://mainnet.optimism.io',           currency:'ETH' },
  { id:137,    name:'Polygon',   sym:'POL',  decimals:18, icon:'https://s2.coinmarketcap.com/static/img/coins/64x64/28321.png', explorer:'https://polygonscan.com',           rpc:'https://polygon-rpc.com',               currency:'POL' },
  { id:56,     name:'BSC',       sym:'BNB',  decimals:18, icon:'https://s2.coinmarketcap.com/static/img/coins/64x64/1839.png',  explorer:'https://bscscan.com',               rpc:'https://bsc-dataseed.binance.org',       currency:'BNB' },
  { id:43114,  name:'Avalanche', sym:'AVAX', decimals:18, icon:'https://s2.coinmarketcap.com/static/img/coins/64x64/5805.png',  explorer:'https://snowtrace.io',              rpc:'https://api.avax.network/ext/bc/C/rpc', currency:'AVAX' },
  { id:130,    name:'Unichain',  sym:'ETH',  decimals:18, icon:'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/unichain.svg', explorer:'https://unichain.blockscout.com', rpc:'https://mainnet.unichain.org', currency:'ETH' },
  { id:4663,   name:'Robinhood Chain', sym:'ETH', decimals:18, icon:'/theme/assets/robinhood-chain-icon.svg', explorer:'https://robinhoodchain.blockscout.com', rpc:'https://rpc.mainnet.chain.robinhood.com', currency:'ETH' },
  { id:81457,  name:'Blast',     sym:'ETH',  decimals:18, icon:'https://s2.coinmarketcap.com/static/img/coins/64x64/28480.png', explorer:'https://blastscan.io',              rpc:'https://rpc.blast.io',                  currency:'ETH' },
  { id:534352, name:'Scroll',    sym:'ETH',  decimals:18, icon:'https://s2.coinmarketcap.com/static/img/coins/64x64/26998.png', explorer:'https://scrollscan.com',            rpc:'https://rpc.scroll.io',                 currency:'ETH' },
  { id:59144,  name:'Linea',     sym:'ETH',  decimals:18, icon:'https://s2.coinmarketcap.com/static/img/coins/64x64/27657.png', explorer:'https://lineascan.build',           rpc:'https://rpc.linea.build',               currency:'ETH' },
  { id:146,    name:'Sonic',     sym:'S',    decimals:18, icon:'https://s2.coinmarketcap.com/static/img/coins/64x64/32684.png', explorer:'https://sonicscan.org',             rpc:'https://rpc.soniclabs.com',             currency:'S'   },
  { id:5000,   name:'Mantle',    sym:'MNT',  decimals:18, icon:'https://s2.coinmarketcap.com/static/img/coins/64x64/27075.png', explorer:'https://mantlescan.xyz',            rpc:'https://rpc.mantle.xyz',                currency:'MNT' },
  { id:34443,  name:'Mode',      sym:'ETH',  decimals:18, icon:'https://s2.coinmarketcap.com/static/img/coins/64x64/29136.png', explorer:'https://explorer.mode.network',     rpc:'https://mainnet.mode.network',           currency:'ETH' },
];

const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

// Bridge and exchange logos are taken from the current LI.FI toolDetails response.

// Tokens per chain (native + major stables/ETH variants)
const TOKENS = {
  1:[
    {sym:'ETH',  name:'Ethereum',       addr:NATIVE,                                       dec:18,cmc:1027},
    {sym:'USDC', name:'USD Coin',        addr:'0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', dec:6, cmc:3408},
    {sym:'USDT', name:'Tether USD',      addr:'0xdac17f958d2ee523a2206206994597c13d831ec7', dec:6, cmc:825},
    {sym:'WBTC', name:'Wrapped Bitcoin', addr:'0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', dec:8, cmc:3717},
    {sym:'DAI',  name:'Dai Stablecoin',  addr:'0x6b175474e89094c44da98b954eedeac495271d0f', dec:18,cmc:4943},
    {sym:'WETH', name:'Wrapped ETH',     addr:'0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', dec:18,cmc:2396},
  ],
  8453:[
    {sym:'ETH',  name:'Ethereum',       addr:NATIVE,                                       dec:18,cmc:1027},
    {sym:'USDC', name:'USD Coin',        addr:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', dec:6, cmc:3408},
    {sym:'WETH', name:'Wrapped ETH',     addr:'0x4200000000000000000000000000000000000006', dec:18,cmc:2396},
    {sym:'DAI',  name:'Dai Stablecoin',  addr:'0x50c5725949a6f0c72e6c4a641f24049a917db0cb', dec:18,cmc:4943},
  ],
  42161:[
    {sym:'ETH',  name:'Ethereum',       addr:NATIVE,                                       dec:18,cmc:1027},
    {sym:'USDC', name:'USD Coin',        addr:'0xaf88d065e77c8cc2239327c5edb3a432268e5831', dec:6, cmc:3408},
    {sym:'USDT', name:'Tether USD',      addr:'0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', dec:6, cmc:825},
    {sym:'WETH', name:'Wrapped ETH',     addr:'0x82af49447d8a07e3bd95bd0d56f35241523fbab1', dec:18,cmc:2396},
    {sym:'WBTC', name:'Wrapped Bitcoin', addr:'0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f', dec:8, cmc:3717},
    {sym:'ARB',  name:'Arbitrum',        addr:'0x912ce59144191c1204e64559fe8253a0e49e6548', dec:18,cmc:11841},
  ],
  10:[
    {sym:'ETH',  name:'Ethereum',       addr:NATIVE,                                       dec:18,cmc:1027},
    {sym:'USDC', name:'USD Coin',        addr:'0x0b2c639c533813f4aa9d7837caf62653d097ff85', dec:6, cmc:3408},
    {sym:'USDT', name:'Tether USD',      addr:'0x94b008aa00579c1307b0ef2c499ad98a8ce58e58', dec:6, cmc:825},
    {sym:'WETH', name:'Wrapped ETH',     addr:'0x4200000000000000000000000000000000000006', dec:18,cmc:2396},
    {sym:'OP',   name:'Optimism',        addr:'0x4200000000000000000000000000000000000042', dec:18,cmc:11840},
  ],
  137:[
    {sym:'POL',  name:'Polygon',         addr:NATIVE,                                       dec:18,cmc:28321},
    {sym:'USDC',   name:'USD Coin',         addr:'0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', dec:6, cmc:3408},
    {sym:'USDC.e', name:'Bridged USD Coin', addr:'0x2791bca1f2de4661ed88a30c99a7a9449aa84174', dec:6, cmc:3408},
    {sym:'USDT', name:'Tether USD',      addr:'0xc2132d05d31c914a87c6611c10748aeb04b58e8f', dec:6, cmc:825},
    {sym:'WETH', name:'Wrapped ETH',     addr:'0x7ceb23fd6bc0add59e62ac25578270cff1b9f619', dec:18,cmc:2396},
    {sym:'WBTC', name:'Wrapped Bitcoin', addr:'0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6', dec:8, cmc:3717},
  ],
  56:[
    {sym:'BNB',  name:'BNB',             addr:NATIVE,                                       dec:18,cmc:1839},
    {sym:'USDC', name:'USD Coin',        addr:'0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', dec:18,cmc:3408},
    {sym:'USDT', name:'Tether USD',      addr:'0x55d398326f99059ff775485246999027b3197955', dec:18,cmc:825},
    {sym:'ETH',  name:'ETH (BEP-20)',    addr:'0x2170ed0880ac9a755fd29b2688956bd959f933f8', dec:18,cmc:1027},
  ],
};
// Avalanche
TOKENS[43114]=[
  {sym:'AVAX', name:'Avalanche',       addr:NATIVE,                                        dec:18,cmc:5805},
  {sym:'USDC', name:'USD Coin',        addr:'0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', dec:6, cmc:3408},
  {sym:'USDT', name:'Tether USD',      addr:'0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7', dec:6, cmc:825},
  {sym:'WETH', name:'Wrapped ETH',     addr:'0x49d5c2bdffac6ce2bfdb6640f4f80f226bc10bab', dec:18,cmc:2396},
  {sym:'WBTC', name:'Wrapped Bitcoin', addr:'0x50b7545627a5162f82a992c33b87adc75187b218', dec:8, cmc:3717},
];
// Unichain
TOKENS[130]=[
  {sym:'ETH',   name:'Ethereum',       addr:NATIVE,                                        dec:18,cmc:1027},
  {sym:'WETH',  name:'Wrapped ETH',    addr:'0x4200000000000000000000000000000000000006', dec:18,cmc:2396},
  {sym:'USDC',  name:'USD Coin',       addr:'0x078d782b760474a361dda0af3839290b0ef57ad6', dec:6, cmc:3408},
  {sym:'USDT0', name:'Tether USD0',    addr:'0x9151434b16b9763660705744891fa906f660ecc5', dec:6, cmc:825},
  {sym:'UNI',   name:'Uniswap',        addr:'0x8f187aa05619a017077f5308904739877ce9ea21', dec:18,cmc:7083},
  {sym:'wBTC',  name:'Wrapped Bitcoin',addr:'0x0555e30da8f98308edb960aa94c0db47230d2b9c', dec:8, cmc:3717},
];
// Robinhood Chain mainnet
TOKENS[4663]=[
  {sym:'ETH',  name:'Ethereum',  addr:NATIVE,                                        dec:18,cmc:1027},
  {sym:'WETH', name:'Wrapped ETH',addr:'0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', dec:18,cmc:2396},
  {sym:'USDG', name:'USDG',       addr:'0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', dec:6, cmc:33793},
];
// Blast
TOKENS[81457]=[
  {sym:'ETH',   name:'Ethereum',       addr:NATIVE,                                        dec:18,cmc:1027},
  {sym:'USDB',  name:'USDB',           addr:'0x4300000000000000000000000000000000000003', dec:18,cmc:0},
  {sym:'WETH',  name:'Wrapped ETH',    addr:'0x4300000000000000000000000000000000000004', dec:18,cmc:2396},
  {sym:'BLAST', name:'Blast',          addr:'0xb1a5700fa2358173fe465e6ea4ff52e36e88e2ad', dec:18,cmc:29743},
];
// Scroll
TOKENS[534352]=[
  {sym:'ETH',  name:'Ethereum',        addr:NATIVE,                                        dec:18,cmc:1027},
  {sym:'USDC', name:'USD Coin',        addr:'0x06efdbff2a14a7c8e15944d1f4a48f9f95f663a4', dec:6, cmc:3408},
  {sym:'USDT', name:'Tether USD',      addr:'0xf55bec9cafdbe8730f096aa55dad6d22d44099df', dec:6, cmc:825},
  {sym:'WETH', name:'Wrapped ETH',     addr:'0x5300000000000000000000000000000000000004', dec:18,cmc:2396},
  {sym:'WBTC', name:'Wrapped Bitcoin', addr:'0x3c1bca5a656e69edcd0d4e36bebb3fcdaca60cf1', dec:8, cmc:3717},
];
// Linea
TOKENS[59144]=[
  {sym:'ETH',  name:'Ethereum',        addr:NATIVE,                                        dec:18,cmc:1027},
  {sym:'USDC', name:'USD Coin',        addr:'0x176211869ca2b568f2a7d4ee941e073a821ee1ff', dec:6, cmc:3408},
  {sym:'USDT', name:'Tether USD',      addr:'0xa219439258ca9da29e9cc4ce5596924745e12b93', dec:6, cmc:825},
  {sym:'WETH', name:'Wrapped ETH',     addr:'0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34e', dec:18,cmc:2396},
  {sym:'WBTC', name:'Wrapped Bitcoin', addr:'0x3aab2285ddcddad8edf438c1bab47e1a9d05a9b4', dec:8, cmc:3717},
];
// Sonic
TOKENS[146]=[
  {sym:'S',    name:'Sonic',           addr:NATIVE,                                        dec:18,cmc:32684},
  {sym:'USDC', name:'USD Coin',        addr:'0x29219dd400f2bf60e5a23d13be72b486d4038894', dec:6, cmc:3408},
  {sym:'USDT', name:'Tether USD',      addr:'0x6047828dc181963ba44974c3e27b36a6b8b35ceb', dec:6, cmc:825},
  {sym:'WETH', name:'Wrapped ETH',     addr:'0x50c42deacd8fc9773493ed674b675be577f2634b', dec:18,cmc:2396},
];
// Mantle
TOKENS[5000]=[
  {sym:'MNT',  name:'Mantle',          addr:NATIVE,                                        dec:18,cmc:27075},
  {sym:'USDC', name:'USD Coin',        addr:'0x09bc4e0d864854c6afb6eb9a9cdf58ac190d0df5', dec:6, cmc:3408},
  {sym:'USDT', name:'Tether USD',      addr:'0x201eba5cc46d216ce6dc03f6a759e8e766e956ae', dec:6, cmc:825},
  {sym:'WETH', name:'Wrapped ETH',     addr:'0xdeaddeaddeaddeaddeaddeaddeaddeaddead1111', dec:18,cmc:2396},
  {sym:'WMNT', name:'Wrapped Mantle',  addr:'0x78c1b0c915c4faa5fffa6cabf0219da63d7f4cb8', dec:18,cmc:27075},
];
// Mode
TOKENS[34443]=[
  {sym:'ETH',  name:'Ethereum',        addr:NATIVE,                                        dec:18,cmc:1027},
  {sym:'USDC', name:'USD Coin',        addr:'0xd988097fb8612cc24eec14542bc03424c656005f', dec:6, cmc:3408},
  {sym:'USDT', name:'Tether USD',      addr:'0xf0f161fda2712db8b566946122a5af183995e2ed', dec:6, cmc:825},
  {sym:'WETH', name:'Wrapped ETH',     addr:'0x4200000000000000000000000000000000000006', dec:18,cmc:2396},
];

// ═══════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════
let wallet = null;
let fromChainId = 1;
let toChainId   = 42161;
let fromTok = null;
let toTok   = null;
let slippage = 0.5;

let autoRefreshTimer = null;
let quoteTimeLeft = 30;

function startQuoteTimer() {
  clearInterval(autoRefreshTimer);
  quoteTimeLeft = 30;
  const ui = document.getElementById('quote-timer-ui');
  if(ui) ui.textContent = `(Refreshes in ${quoteTimeLeft}s)`;
  autoRefreshTimer = setInterval(() => {
    quoteTimeLeft--;
    if(ui) ui.textContent = `(Refreshes in ${quoteTimeLeft}s)`;
    if (quoteTimeLeft <= 0) {
      clearInterval(autoRefreshTimer);
      if(ui) ui.textContent = 'Refreshing...';
      fetchRoutes();
    }
  }, 1000);
}

function clearQuoteTimer() {
  clearInterval(autoRefreshTimer);
  const ui = document.getElementById('quote-timer-ui');
  if(ui) ui.textContent = '';
}

let routes = [];
let selectedRouteIdx = 0;
let quoteTimer = null;
let bals = {};
let txHistory = JSON.parse(localStorage.getItem('bridge_history')||'[]');
const bridgePollTimers = new Map();
let routesExpiresAt = 0;
let bridgeBusy = false;
let _routeReqId = 0;

function balStorageKey(chainId, addr){
  const tokenKey = addr===NATIVE ? 'native' : String(addr).toLowerCase();
  return `${chainId}:${tokenKey}`;
}

const BRIDGE_RECENT_TOKENS_KEY='bridge_recent_tokens_v2';
const BRIDGE_RECENT_CLEANUP_KEY='bridge_recent_tokens_cleanup_v2';

function getChainTokens(chainId){
  const list=Array.isArray(TOKENS[chainId])?TOKENS[chainId]:[];
  const seen=new Set();
  return list.filter(tok=>{
    if(!tok||typeof tok!=='object'||!String(tok.sym||'').trim()||!String(tok.name||'').trim()) return false;
    const addr=String(tok.addr||'').toLowerCase();
    if(addr!==NATIVE&&!/^0x[0-9a-f]{40}$/.test(addr)) return false;
    if(seen.has(addr)) return false;
    seen.add(addr); return true;
  });
}
function isDefaultBridgeToken(chainId,address){
  const addr=typeof address==='string'?address.toLowerCase():String(address?.addr||'').toLowerCase();
  return (TOKENS[chainId]||[]).some(tok=>!tok.custom&&String(tok.addr||'').toLowerCase()===addr);
}
function validateBridgeCustomToken(tok){
  if(!tok||typeof tok!=='object') return false;
  if(!/^[A-Za-z0-9._-]{1,20}$/.test(String(tok.sym||''))) return false;
  if(!/^0x[0-9a-fA-F]{40}$/.test(String(tok.addr||''))) return false;
  if(!Number.isInteger(Number(tok.dec))||Number(tok.dec)<0||Number(tok.dec)>36) return false;
  if(tok.logo&&!/^https:\/\//i.test(String(tok.logo))) delete tok.logo;
  return true;
}
function loadBridgeRecentTokens(){
  try{
    const raw=JSON.parse(localStorage.getItem(BRIDGE_RECENT_TOKENS_KEY)||'{}');
    const cleaned={};
    for(const [chain,list] of Object.entries(raw||{})){
      if(!Array.isArray(list)) continue;
      const seen=new Set();
      cleaned[chain]=list.filter(tok=>{
        if(!validateBridgeCustomToken(tok)) return false;
        const addr=tok.addr.toLowerCase();
        if(seen.has(addr)) return false;
        seen.add(addr); return true;
      }).slice(-30);
      if(!cleaned[chain].length) delete cleaned[chain];
    }
    if(localStorage.getItem(BRIDGE_RECENT_CLEANUP_KEY)!=='1'){
      localStorage.setItem(BRIDGE_RECENT_CLEANUP_KEY,'1');
      localStorage.setItem(BRIDGE_RECENT_TOKENS_KEY,JSON.stringify(cleaned));
    }
    return cleaned;
  }catch(e){ localStorage.setItem(BRIDGE_RECENT_TOKENS_KEY,'{}'); return {}; }
}
function mergeBridgeRecentTokens(chainId){
  const recent=loadBridgeRecentTokens()[chainId]||[];
  if(!TOKENS[chainId]) TOKENS[chainId]=[];
  const byAddr=new Map(TOKENS[chainId].map(tok=>[String(tok.addr||'').toLowerCase(),tok]));
  for(const stored of recent){
    const addr=stored.addr.toLowerCase();
    const existing=byAddr.get(addr);
    if(existing){ if(!existing.logo&&stored.logo) existing.logo=stored.logo; continue; }
    const tok={...stored,addr,custom:true,searchOnly:false,persistedByBridge:true};
    TOKENS[chainId].push(tok); byAddr.set(addr,tok);
  }
}
function saveConfirmedBridgeToken(chainId,tok){
  if(!validateBridgeCustomToken(tok)||isDefaultBridgeToken(chainId,tok)) return;
  const all=loadBridgeRecentTokens();
  const list=all[chainId]||[];
  const addr=tok.addr.toLowerCase();
  const next={...tok,addr,custom:true,searchOnly:false,persistedByBridge:true,lastUsedAt:Date.now()};
  const idx=list.findIndex(item=>String(item.addr||'').toLowerCase()===addr);
  if(idx>=0) list[idx]={...list[idx],...next}; else list.push(next);
  all[chainId]=list.sort((a,b)=>Number(a.lastUsedAt||0)-Number(b.lastUsedAt||0)).slice(-30);
  localStorage.setItem(BRIDGE_RECENT_TOKENS_KEY,JSON.stringify(all));
  tok.searchOnly=false; tok.persistedByBridge=true;
}
function rememberHistoryTokens(item){
  if(!item||item.status!=='confirmed') return;
  for(const snap of item.tokenSnapshots||[]){
    if(snap&&snap.custom) saveConfirmedBridgeToken(Number(snap.chainId),snap);
  }
}

async function fetchBalancesViaProxy(chainId, tokens, timeoutMs=12000){
  if (!wallet || !tokens?.length) return null;
  const effectiveTimeoutMs = Number(chainId) === 4663 ? Math.max(timeoutMs, 25000) : timeoutMs;
  const erc20s = [...new Set(tokens
    .filter(tok => tok && tok.addr && tok.addr !== NATIVE)
    .map(tok => tok.addr.toLowerCase()))];
  try{
    const merged = {};
    const metaList = [];
    const chunks = erc20s.length
      ? Array.from({ length: Math.ceil(erc20s.length / 60) }, (_, i) => erc20s.slice(i * 60, (i + 1) * 60))
      : [[]];
    for(const chunk of chunks){
      const qs = new URLSearchParams({
        wallet,
        chainId: String(chainId),
      });
      if(chunk.length) qs.set('tokens', chunk.join(','));
      const r = await fetch(`/api/token-balances?${qs.toString()}`, { signal: AbortSignal.timeout(effectiveTimeoutMs) });
      if(!r.ok) throw new Error(`token-balances ${r.status}`);
      const d = await r.json();
      Object.assign(merged, d?.balances || {});
      if (d?.meta) metaList.push(d.meta);
    }
    const complete = metaList.length ? metaList.every(meta => meta?.complete) : false;
    return Object.keys(merged).length ? { balances: merged, complete, metaList } : null;
  }catch(e){
    return null;
  }
}

// ═══════════════════════════════════════════
// ICON HELPERS
// ═══════════════════════════════════════════
function tokIcon(cmc){ return cmc?`https://s2.coinmarketcap.com/static/img/coins/64x64/${cmc}.png`:''; }
const tokenLogoCache = {};
const lastKnownBalanceCache = {};
const TOKEN_ICON_PROXY_VERSION='20260408-1';
function isLegacyTokenIconUrl(url){
  const raw = String(url || '').trim();
  return raw.startsWith('/api/token-icons?image=1') && !/[?&]url=/.test(raw);
}
function proxyTokenImageUrl(url){
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (isLegacyTokenIconUrl(raw)) return '';
  if (raw.startsWith('/api/token-icons?image=1')) return raw;
  if (/^https?:\/\//i.test(raw)) return `/api/token-icons?image=1&v=${TOKEN_ICON_PROXY_VERSION}&url=${encodeURIComponent(raw)}`;
  return raw;
}

function getTokenLogoKey(chainId, tok){
  const addr = String(tok?.addr || '').toLowerCase();
  return `${chainId}:${addr}`;
}

function primeTokenLogo(chainId, tok, url){
  const next = String(url || '').trim();
  if (!tok || !next || isLegacyTokenIconUrl(next)) return false;
  tok.logo = next;
  tokenLogoCache[getTokenLogoKey(chainId, tok)] = next;
  return true;
}

function getRenderableTokenIconUrl(tok, activeChainId=fromChainId){
  if (tok?.cmc) return proxyTokenImageUrl(tokIcon(tok.cmc));
  const explicit = proxyTokenImageUrl(tok?.logo || '');
  if (explicit) return explicit;
  return '';
}

const DEX_CHAIN_IDS_BRIDGE = {
  1: 'ethereum', 8453: 'base', 42161: 'arbitrum', 10: 'optimism',
  137: 'polygon', 56: 'bsc', 130: 'unichain', 81457: 'blast',
  534352: 'scroll', 59144: 'linea', 5000: 'mantle', 34443: 'mode',
  43114: 'avalanche', 250: 'fantom', 4663: 'robinhood',
};
const CHAIN_BLOCKSCOUT_BASES = {
  1:      'https://eth.blockscout.com',
  8453:   'https://base.blockscout.com',
  42161:  'https://arbitrum.blockscout.com',
  10:     'https://optimism.blockscout.com',
  137:    'https://polygon.blockscout.com',
  56:     'https://bsc.blockscout.com',
  130:    'https://unichain.blockscout.com',
  81457:  'https://blast.blockscout.com',
  534352: 'https://scroll.blockscout.com',
  59144:  'https://explorer.linea.build',
  5000:   'https://explorer.mantle.xyz',
  34443:  'https://explorer.mode.network',
  4663:   'https://robinhoodchain.blockscout.com',
};

async function fetchBlockscoutTokenLogo(chainId, tok){
  const addr = String(tok?.addr || '').toLowerCase();
  const base = CHAIN_BLOCKSCOUT_BASES[chainId];
  if (!base || !addr || addr === NATIVE) return '';
  try {
    const r = await fetch(`${base}/api/v2/tokens/${addr}`, { signal: AbortSignal.timeout(7000) });
    if (!r.ok) return '';
    const data = await r.json();
    return String(data?.icon_url || '').trim();
  } catch { return ''; }
}

async function fetchDexscreenerTokenLogo(chainId, tok){
  const addr = String(tok?.addr || '').toLowerCase();
  const dexChain = DEX_CHAIN_IDS_BRIDGE[chainId] || '';
  if (!addr || addr === NATIVE) return '';
  try {
    const r = await fetch(`/api/proxy-dexscreener/latest/dex/tokens/${addr}`, { signal: AbortSignal.timeout(7000) });
    if (!r.ok) return '';
    const data = await r.json();
    let best = '', bestLiq = -1;
    for (const pair of (data?.pairs || [])) {
      if (dexChain && String(pair?.chainId || '').toLowerCase() !== dexChain) continue;
      const icon = String(pair?.info?.imageUrl || '').trim();
      if (!icon) continue;
      const liq = Number(pair?.liquidity?.usd || 0);
      if (liq > bestLiq) { bestLiq = liq; best = icon; }
    }
    return best;
  } catch { return ''; }
}

async function resolveTokenLogosForChain(chainId, tokens, force=false){
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
      if (cached && !tok.logo) { tok.logo = cached; changed = true; }
      continue;
    }
    pending.push(tok);
  }
  if (!pending.length) return changed;
  // Step 1: Trust Wallet asset list via /api/token-icons (curated, fast)
  try {
    const qs = new URLSearchParams({
      chainId: String(chainId),
      tokens: pending.map(tok => tok.addr === NATIVE ? 'native' : tok.addr).join(','),
    });
    const res = await fetch(`/api/token-icons?${qs.toString()}`, { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const data = await res.json();
      const icons = data?.icons || {};
      for (const tok of pending) {
        const key = getTokenLogoKey(chainId, tok);
        const icon = String(icons[key] || '').trim();
        if (icon && primeTokenLogo(chainId, tok, icon)) { tokenLogoCache[key] = icon; changed = true; }
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
          if (primeTokenLogo(chainId, tok, found)) { tokenLogoCache[key] = found; changed = true; }
        }
      }));
    }
  }
  return changed;
}

function queueTokenLogoHydration(chainId, tokens, rerender){
  resolveTokenLogosForChain(chainId, tokens).then(changed => {
    if (!changed) return;
    if (typeof rerender === 'function') rerender();
  }).catch(() => {});
}
function getBalanceCacheKey(tok, chainId){
  return `${chainId}:${String(tok?.addr || '').toLowerCase()}`;
}

function letterAvatarHTML(sym,size=32){
  const colors=['#ff007a','#9b51e0','#00dc82','#fbbf24','#3b82f6','#38bdf8'];
  const col=colors[esc(sym).charCodeAt(0)%colors.length];
  return `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${col}22;border:1.5px solid ${col}55;display:flex;align-items:center;justify-content:center;font-size:${Math.round(size*0.35)}px;font-weight:900;color:${col};flex-shrink:0;">${esc(sym.slice(0,2).toUpperCase())}</div>`;
}
function chainIconHTML(net,size=28){
  return `<img style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;flex-shrink:0;" src="${esc(net.icon)}" onerror="chainImgFallback(this,'${esc(net.sym)}',${size})" alt="">`;
}
function chainImgFallback(el,sym,size){
  const div=document.createElement('div');
  div.style.cssText=`width:${size}px;height:${size}px;border-radius:50%;background:#38bdf822;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:900;color:#38bdf8;flex-shrink:0;`;
  div.textContent=sym.slice(0,2).toUpperCase();
  el.replaceWith(div);
}

function tokIconEl(tok,size=32,activeChainId=fromChainId){
  const src = getRenderableTokenIconUrl(tok, activeChainId);
  if(src) return `<img style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;flex-shrink:0;" src="${src}" onerror="imgFallback(this,'${esc(tok.sym)}',${size})" alt="">`;
  return letterAvatarHTML(tok.sym,size);
}
function imgFallback(el,sym,size){
  const div=document.createElement('div');
  div.innerHTML=letterAvatarHTML(sym,size);
  el.replaceWith(div.firstChild);
}

async function loadSupportedBridgeChains(){
  try{
    const response=await fetch('/api/bridge-chains',{signal:AbortSignal.timeout(12000)});
    if(!response.ok) return;
    const data=await response.json();
    if(!Array.isArray(data?.chains)) return;
    const byId=new Map(NETWORKS.map(net=>[net.id,net]));
    for(const chain of data.chains){
      if(!Number.isSafeInteger(Number(chain.id))||!chain.name||!chain.rpc||!chain.explorer) continue;
      const id=Number(chain.id);
      const existing=byId.get(id);
      const merged={
        ...(existing||{}), id,
        name:String(chain.name).slice(0,80),
        sym:String(chain.sym||existing?.sym||'ETH').slice(0,16),
        decimals:Number.isInteger(Number(chain.decimals))?Number(chain.decimals):18,
        icon:String(chain.icon||existing?.icon||''),
        explorer:String(chain.explorer||existing?.explorer||'').replace(/\/$/,''),
        rpc:String(chain.rpc||existing?.rpc||''),
        currency:String(chain.sym||existing?.currency||existing?.sym||'ETH').slice(0,16),
      };
      if(existing) Object.assign(existing,merged);
      else { NETWORKS.push(merged); byId.set(id,merged); }
      if(!TOKENS[id]?.length){
        TOKENS[id]=[{sym:merged.sym,name:merged.sym,addr:NATIVE,dec:merged.decimals,cmc:0,logo:String(chain.tokenIcon||chain.icon||'')}];
      }else if(TOKENS[id][0]?.addr===NATIVE&&chain.tokenIcon&&!TOKENS[id][0].logo){
        TOKENS[id][0].logo=String(chain.tokenIcon);
      }
      mergeBridgeRecentTokens(id);
    }
    NETWORKS.sort((a,b)=>a.name.localeCompare(b.name));
    WC_OPTIONAL_CHAINS=NETWORKS.map(net=>net.id);
    WC_RPC_MAP=Object.fromEntries(NETWORKS.map(net=>[net.id,net.rpc]));
  }catch(e){}
}

const bridgeTokenHydration = new Map();
async function hydrateMajorTokensForChain(chainId){
  const id=Number(chainId);
  if(bridgeTokenHydration.has(id)) return bridgeTokenHydration.get(id);
  const task=(async()=>{
    try{
      const response=await fetch(`/api/bridge-tokens?chainId=${encodeURIComponent(id)}`,{signal:AbortSignal.timeout(18000)});
      const data=await response.json().catch(()=>({}));
      if(!response.ok||!Array.isArray(data.tokens)) return;
      if(!TOKENS[id]) TOKENS[id]=[];
      const byAddress=new Map(TOKENS[id].map(token=>[String(token.addr||'').toLowerCase(),token]));
      for(const raw of data.tokens){
        const address=String(raw.addr||'').toLowerCase();
        if(address!==NATIVE&&!/^0x[0-9a-f]{40}$/.test(address)) continue;
        if(!Number.isInteger(Number(raw.dec))||!String(raw.sym||'').trim()) continue;
        const normalized={addr:address,sym:String(raw.sym).slice(0,20),name:String(raw.name||raw.sym).slice(0,80),dec:Number(raw.dec),logo:/^https:\/\//i.test(String(raw.logo||''))?String(raw.logo):'',priceUSD:Number.isFinite(Number(raw.priceUSD))?Number(raw.priceUSD):null,coinKey:String(raw.coinKey||'').slice(0,30),verified:true,cmc:0};
        const existing=byAddress.get(address);
        if(existing){
          if(!existing.logo&&normalized.logo) existing.logo=normalized.logo;
          existing.verified=true;
          if(normalized.priceUSD!==null) existing.priceUSD=normalized.priceUSD;
          if(!existing.coinKey&&normalized.coinKey) existing.coinKey=normalized.coinKey;
        }else{
          TOKENS[id].push(normalized);byAddress.set(address,normalized);
        }
      }
      mergeBridgeRecentTokens(id);
    }catch(e){}
  })();
  bridgeTokenHydration.set(id,task);
  return task;
}

function resumePendingBridgeHistory(){
  for(const item of txHistory){
    if(item?.status==='pending'&&isValidTxHash(item.hash)) pollBridgeStatus(item.hash,item.statusFromChainId||item.fromChainId,item.statusToChainId||item.toChainId,item.bridge||'',{silent:true});
    if(item?.status==='confirmed') rememberHistoryTokens(item);
  }
}

// ══════════════�����════════════════════════════
// INIT
// ═══════════════════════════════════════════
async function init(){ loadCustomTokens();
  await loadSupportedBridgeChains();
  for(const net of NETWORKS) mergeBridgeRecentTokens(net.id);
  // Detect wallet chain
  if(window.ethereum){
    try{
      const hex=await window.ethereum.request({method:'eth_chainId'});
      const id=parseInt(hex,16);
      if(NETWORKS.find(n=>n.id===id)){
        fromChainId=id;
        // Pick a different default toChain
        toChainId = id===42161?1:(id===1?42161:1);
      }
    }catch(e){}
  }

  await Promise.all([hydrateMajorTokensForChain(fromChainId),hydrateMajorTokensForChain(toChainId)]);
  // Set default tokens
  fromTok = TOKENS[fromChainId]?.[0] || TOKENS[1][0];
  toTok   = TOKENS[toChainId]?.[0]  || TOKENS[42161][0];

  updateChainUI();
  updateTokenUI();
  renderHistory();
  resumePendingBridgeHistory();

  const reconnected = await _trySilentReconnect();
  if (!reconnected) _discoverWallets();
  startComets();
  if(txHistory.length) document.getElementById('hist-meta').textContent=txHistory.length+' transaction'+(txHistory.length!==1?'s':'');
}

// ═══════════════════════════════════════════
// CHAIN / TOKEN UI
// ═══════════════════════════════════════════
function updateChainUI(){
  const from=NETWORKS.find(n=>n.id===fromChainId)||NETWORKS[0];
  const to=NETWORKS.find(n=>n.id===toChainId)||NETWORKS[2];
  document.getElementById('from-chain-icon-wrap').innerHTML=chainIconHTML(from,28);
  document.getElementById('to-chain-icon-wrap').innerHTML=chainIconHTML(to,28);
  document.getElementById('from-chain-name').textContent=from.name;
  document.getElementById('to-chain-name').textContent=to.name;
  
  const advBox = document.getElementById('advanced-transfer-box');
  if (advBox) {
    advBox.style.display = (fromChainId === toChainId) ? 'none' : 'block';
  }
  
  const histTitle = document.getElementById('history-title-text');
  if (histTitle) {
    histTitle.textContent = (fromChainId === toChainId) ? 'Swap History' : 'Bridge History';
  }
}

let _currentSecCache = {};
async function checkTokenSecurity(token) {
    const badge = document.getElementById('sell-sec-badge');
    const warnBox = document.getElementById('sec-warning-box');
    const btn = document.getElementById('submit-btn');
    if (!badge || !warnBox) return;
    
    badge.className = 'sec-badge';
    badge.innerHTML = '';
    warnBox.style.display = 'none';
    
    const addr = (token.addr || '').toLowerCase();
    const chainId = fromChainId;
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
      } catch(e) {
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

function updateTokenUI(){
  if(fromTok){ checkTokenSecurity(fromTok).then(()=>updateBtnState());
    document.getElementById('from-tok-icon-wrap').innerHTML=tokIconEl(fromTok,32,fromChainId);
    document.getElementById('from-tok-sym').textContent=fromTok.sym;
    queueTokenLogoHydration(fromChainId, [fromTok], ()=>updateTokenUI());
  }
  if(toTok){
    document.getElementById('to-tok-icon-wrap').innerHTML=tokIconEl(toTok,32,toChainId);
    document.getElementById('to-tok-sym').textContent=toTok.sym;
    queueTokenLogoHydration(toChainId, [toTok], ()=>updateTokenUI());
  }
}


function flipTokens(){
  [fromTok, toTok] = [toTok, fromTok];
  _bridgeNeedsApproval = false;
  _lastBridgeApprove = null;
  updateTokenUI();
  clearRoutes();
  updateBals();
  if (wallet) {
    loadBalsFast();
    loadBals();
  }
  scheduleQuote();
}

function flipChains(){
  [fromChainId,toChainId]=[toChainId,fromChainId];
  [fromTok,toTok]=[toTok,fromTok];
  if(!TOKENS[fromChainId]) fromTok=TOKENS[1][0];
  if(!TOKENS[toChainId])   toTok=TOKENS[42161][0];
  _bridgeNeedsApproval=false; _lastBridgeApprove=null;
  updateChainUI(); updateTokenUI(); clearRoutes(); updateBals();
  if(wallet){ loadBalsFast(); loadBals(); }
  if(wallet && _activeProvider()){
    switchWalletToChain(fromChainId).catch(error=>setStatus(error?.code===4001?'Network switch rejected':(error?.message||'Unable to switch network'),'err'));
  }
  scheduleQuote();
}

// ═════════════════���═════════════════════════
// WALLET - EIP-6963 and WalletConnect
// ═══════════════════════════════════════════
const _wDetected = new Map();
let _wProvider = null;
let _wcProvider = null;
let _wcFactoryPromise = null;
const WC_PROJECT_ID = '704069969e567ac0da6a87f58563af90';
const WC_METHODS = ['eth_accounts','eth_requestAccounts','eth_chainId','eth_sendTransaction','eth_call','eth_getBalance','eth_gasPrice','eth_estimateGas','eth_getTransactionReceipt','wallet_switchEthereumChain','wallet_addEthereumChain','wallet_watchAsset'];
const WC_EVENTS = ['chainChanged','accountsChanged'];
let WC_OPTIONAL_CHAINS = NETWORKS.map(n => n.id);
let WC_RPC_MAP = Object.fromEntries(NETWORKS.map(n => [n.id, n.rpc]));
const MOBILE_WALLET_LINKS = [
  { name:'MetaMask', desc:'Open Coin Blog in MetaMask', icon:'https://upload.wikimedia.org/wikipedia/commons/3/36/MetaMask_Fox.svg', href:() => `https://metamask.app.link/dapp/${window.location.host}${window.location.pathname}${window.location.search}${window.location.hash}` },
  { name:'Trust Wallet', desc:'Open Coin Blog in Trust Wallet', icon:'https://trustwallet.com/assets/images/media/assets/trust_platform.svg', href:() => `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(window.location.href)}` },
  { name:'Coinbase Wallet', desc:'Open Coin Blog in Coinbase Wallet', icon:'https://avatars.githubusercontent.com/u/1885080?s=200&v=4', href:() => `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(window.location.href)}` },
  { name:'Rainbow', desc:'Open Coin Blog in Rainbow', icon:'https://avatars.githubusercontent.com/u/38057539?s=200&v=4', href:() => `https://rnbwapp.com/browser?url=${encodeURIComponent(window.location.href)}` }
];

let _walletEventProvider=null;
let _walletAccountsHandler=null;
let _walletChainHandler=null;

function _activeProvider(){
  return _wProvider&&typeof _wProvider.request==='function'?_wProvider:null;
}

function _signingProvider(){ return _activeProvider(); }
async function _requestWallet(method,params,opts={}){
  const provider=_activeProvider();
  if(!provider?.request) throw new Error('No selected wallet provider');
  const payload=params===undefined||Array.isArray(params)&&params.length===0?{method}:{method,params};
  const timeoutMs=opts.timeoutMs??20000;
  let timer;
  try{
    return await Promise.race([
      provider.request(payload),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`Wallet request timeout: ${method}`)),timeoutMs);}),
    ]);
  }finally{ clearTimeout(timer); }
}
function unbindWalletEvents(){
  if(!_walletEventProvider) return;
  const off=typeof _walletEventProvider.removeListener==='function'?'removeListener':(typeof _walletEventProvider.off==='function'?'off':'');
  if(off&&_walletAccountsHandler) _walletEventProvider[off]('accountsChanged',_walletAccountsHandler);
  if(off&&_walletChainHandler) _walletEventProvider[off]('chainChanged',_walletChainHandler);
  _walletEventProvider=null; _walletAccountsHandler=null; _walletChainHandler=null;
}
function bindWalletEvents(provider){
  unbindWalletEvents();
  if(!provider?.on) return;
  _walletEventProvider=provider;
  _walletAccountsHandler=_onAccChange;
  _walletChainHandler=async hex=>{
    const id=typeof hex==='string'?parseInt(hex,16):Number(hex);
    // Programmatic chain switches are part of multi-step execution. Do not
    // mutate the route form or clear the selected route while it is running.
    if(bridgeBusy) return;
    if(NETWORKS.some(n=>n.id===id)){
      fromChainId=id;
      await hydrateMajorTokensForChain(id);
      mergeBridgeRecentTokens(id);
      fromTok=getChainTokens(id)[0]||fromTok;
      bals={}; _bridgeNeedsApproval=false; _lastBridgeApprove=null;
      updateChainUI(); updateTokenUI(); clearRoutes(); updateBals();
      if(wallet){loadBalsFast();loadBals();}
    }
  };
  provider.on('accountsChanged',_walletAccountsHandler);
  provider.on('chainChanged',_walletChainHandler);
}

function _isMobileBrowser() {
  return /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent || '');
}

function _renderMobileWalletFallback() {
  const list = document.getElementById('wpm-list'); if (!list) return;
  list.innerHTML = '';
  for (const item of MOBILE_WALLET_LINKS) {
    const btn = document.createElement('button');
    btn.className = 'wpm-wallet';
    btn.onclick = () => { window.location.href = item.href(); };
    btn.innerHTML = `<img class="wpm-wicon" src="${item.icon}" alt="${item.name}" onerror="this.style.display='none'"><div><div class="wpm-wname">${item.name}</div><div class="wpm-wdesc">${item.desc}</div></div><div class="wpm-badge">Open</div>`;
    list.appendChild(btn);
  }
}

async function _getWcFactory() {
  const globalFactory = window.__wcEthereumProvider
    || window.WalletConnectEthereumProvider
    || window.walletconnectEthereumProvider
    || window['@walletconnect/ethereum-provider']?.EthereumProvider
    || window['@walletconnect/ethereum-provider']?.default
    || null;
  if (globalFactory?.init) return globalFactory;
  if (!_wcFactoryPromise) _wcFactoryPromise = Promise.reject(new Error('WalletConnect library not loaded'));
  return _wcFactoryPromise;
}

async function _getWalletConnectProvider() {
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

async function _trySilentReconnect(){
  const candidates=[];
  if(window.ethereum?.request) candidates.push(window.ethereum);
  const wc=await _getWalletConnectProvider().catch(()=>null);
  if(wc?.request) candidates.push(wc);
  for(const provider of candidates){
    try{
      const accounts=await provider.request({method:'eth_accounts'});
      if(!accounts?.length) continue;
      wallet=accounts[0]; _wProvider=provider; bindWalletEvents(provider); onWalletConnected(); return true;
    }catch(e){}
  }
  return false;
}

window.addEventListener('eip6963:announceProvider', e => {
  const {info, provider} = e.detail;
  _wDetected.set(info.rdns, {info, provider});
  _renderWalletList();
});

function _discoverWallets() {
  if (window.ethereum && _wDetected.size === 0) {
    const name = window.ethereum.isRabby ? 'Rabby' : window.ethereum.isMetaMask ? 'MetaMask' : window.ethereum.isBraveWallet ? 'Brave Wallet' : window.ethereum.isCoinbaseWallet ? 'Coinbase Wallet' : 'EVM Wallet';
    const icon = window.ethereum.isRabby ? 'https://rabby.io/assets/images/logo-64.png' : window.ethereum.isMetaMask ? 'https://upload.wikimedia.org/wikipedia/commons/3/36/MetaMask_Fox.svg' : null;
    _wDetected.set('legacy', {info:{rdns:'legacy',name,icon}, provider:window.ethereum});
  }
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  _renderWalletList();
  setTimeout(_renderWalletList, 400);
}

function _renderWalletList() {
  const list = document.getElementById('wpm-list'); if (!list) return;
  list.innerHTML = '';
  const wcBtn = document.createElement('button'); wcBtn.className = 'wpm-wallet';
  wcBtn.onclick = () => _connectWalletConnect();
  wcBtn.innerHTML = `<img class="wpm-wicon" src="https://avatars.githubusercontent.com/u/37784886?s=200&v=4" alt="WalletConnect" onerror="this.style.display='none'"><div><div class="wpm-wname">WalletConnect</div><div class="wpm-wdesc">Mobile wallets and QR connect</div></div><div class="wpm-badge">Popular</div>`;
  list.appendChild(wcBtn);
  if (_wDetected.size === 0) { return; }
  for (const [rdns, {info}] of _wDetected) {
    const btn = document.createElement('button'); btn.className = 'wpm-wallet';
    btn.onclick = () => _connectWith(rdns);
    const safeName=esc(info.name||'EVM Wallet');
    const safeIcon=/^https:\/\//i.test(String(info.icon||''))?esc(info.icon):'';
    const ico=safeIcon?`<img class="wpm-wicon" src="${safeIcon}" alt="${safeName}" onerror="this.style.display='none'">`:`<div class="wpm-wicon">💼</div>`;
    btn.innerHTML=`${ico}<div><div class="wpm-wname">${safeName}</div><div class="wpm-wdesc">EVM compatible</div></div><div class="wpm-badge">Connect</div>`;
    list.appendChild(btn);
  }
}

async function _connectWalletConnect(){
  _setWpmStatus('Opening WalletConnect...');
  try{
    const provider=await _getWalletConnectProvider();
    const accounts=await provider.enable();
    if(!accounts?.length) throw new Error('No accounts found');
    wallet=accounts[0]; _wProvider=provider; bindWalletEvents(provider);
    _setWpmStatus(''); document.getElementById('wpm-overlay').classList.add('hidden'); onWalletConnected();
  }catch(e){
    if((e?.message||'').includes('WalletConnect library not loaded')){ _setWpmStatus('WalletConnect is unavailable here. Open Coin Blog in a wallet app below.','err'); _renderMobileWalletFallback(); return; }
    _setWpmStatus(`WalletConnect failed: ${e?.message||'unknown error'}`,'err');
  }
}

function _setWpmStatus(msg, type='') {
  const el = document.getElementById('wpm-status'); if (!el) return;
  el.textContent = msg; el.className = 'wpm-status' + (type ? ' '+type : '');
}

async function _connectWith(rdns){
  const entry=_wDetected.get(rdns); if(!entry) return;
  const provider=entry.provider;
  _setWpmStatus('Connecting…');
  try{
    const accounts=await provider.request({method:'eth_requestAccounts'});
    if(!accounts?.length) throw new Error('No accounts found');
    wallet=accounts[0]; _wProvider=provider; bindWalletEvents(provider);
    _setWpmStatus(''); document.getElementById('wpm-overlay').classList.add('hidden'); onWalletConnected();
  }catch(e){ _setWpmStatus(e?.code===4001?'Connection rejected':'Connection failed','err'); }
}

async function _onAccChange(accs){
  if(!accs?.length){ await wDisconnect(); return; }
  const next=String(accs[0]);
  if(next.toLowerCase()===String(wallet||'').toLowerCase()) return;
  wallet=next; bals={}; clearRoutes(); onWalletConnected();
}

function connectWallet() {
  _setWpmStatus(''); _renderWalletList();
  document.getElementById('wpm-overlay').classList.remove('hidden');
  _discoverWallets();
}

function closeWalletModal(e) {
  if (e && e.target !== document.getElementById('wpm-overlay')) return;
  document.getElementById('wpm-overlay').classList.add('hidden');
}

function onWalletConnected(){
  document.getElementById('conn-btn').style.display='none';
  const p=document.getElementById('wallet-pill'); p.style.display='flex';
  document.getElementById('w-addr-disp').textContent=wallet.slice(0,6)+'…'+wallet.slice(-4);
  loadBals(); updateBtnState();
  if(validateAmount(document.getElementById('send-amt').value)) scheduleQuote();
}

function toggleWMenu(){ document.getElementById('w-menu').classList.toggle('open'); }
function wCopy(){ if(wallet) navigator.clipboard.writeText(wallet); setStatus('Address copied!','ok'); document.getElementById('w-menu').classList.remove('open'); }
function wExplorer(){ const n=NETWORKS.find(n=>n.id===fromChainId); if(n&&wallet)window.open(n.explorer+'/address/'+wallet,'_blank'); document.getElementById('w-menu').classList.remove('open'); }
async function wDisconnect(){ unbindWalletEvents(); if(_wProvider===_wcProvider&&_wProvider?.disconnect){try{await _wProvider.disconnect();}catch(e){}} wallet=null; _wProvider=null; document.getElementById('conn-btn').style.display=''; document.getElementById('wallet-pill').style.display='none'; document.getElementById('w-menu').classList.remove('open'); bals={}; clearRoutes(); updateBtnState(); }
document.addEventListener('click',e=>{ if(!e.target.closest('#top-right')) { document.getElementById('w-menu').classList.remove('open'); } if(!e.target.closest('#chain-modal,#chain-modal-overlay')) {} });

// ═══════════════════════════════════════════
// BALANCES
// ═══════════════════════════════════════════

// Apply balances to modal list - only updates tokens explicitly present in balMap
// Does NOT clear tokens missing from balMap (prevents flicker with partial data)
function applyModalBals(side, balMap, clearMissing=false) {
  const chainId = side==='from' ? fromChainId : toChainId;
  const list = getChainTokens(chainId);
  let anyUpdated = false;
  list.forEach(t => {
    const el = document.getElementById('tbal-'+esc(t.addr));
    if (!el) return;
    const key = t.addr===NATIVE ? 'native' : t.addr.toLowerCase();
    // Only update if this token is explicitly in balMap, or clearMissing=true (full refresh)
    if (!(key in balMap) && !clearMissing) return;
    const rawHex = balMap[key];
    const rawValue = rawHexToBigInt(rawHex);
    if (rawValue > 0n) {
      el.textContent = formatRawBalance(rawHex, t.dec===undefined?18:t.dec);
      el.classList.add('hasbal');
      anyUpdated = true;
    } else {
      el.textContent = '';
      el.classList.remove('hasbal');
    }
  });
  // Re-sort only when we actually updated something
  if (anyUpdated && tokModalFor === side) {
    const listEl = document.getElementById('tok-list');
    if (!listEl) return;
    const items = [...listEl.querySelectorAll('.tok-item')];
    items.sort((a,b) => {
      const aH = a.querySelector('.tok-bal2')?.classList.contains('hasbal') ? 1 : 0;
      const bH = b.querySelector('.tok-bal2')?.classList.contains('hasbal') ? 1 : 0;
      return bH - aH;
    });
    items.forEach(i => listEl.appendChild(i));
  }
}

async function loadBalsForModal(side){
  if(!wallet) return;
  const chainId = side==='from' ? fromChainId : toChainId;
  const seededList = getChainTokens(chainId);
  if(seededList.length){
    const cachedMap = {};
    seededList.forEach(t => {
      const key = t.addr===NATIVE ? 'native' : t.addr.toLowerCase();
      const storageKey = balStorageKey(chainId, t.addr);
      if(storageKey in bals) cachedMap[key] = bals[storageKey];
    });
    if(Object.keys(cachedMap).length > 0) applyModalBals(side, cachedMap);
    const result = await fetchBalancesViaProxy(chainId, seededList);
    if(result?.balances){
      Object.entries(result.balances).forEach(([key, value]) => {
        const addr = key === 'native' ? NATIVE : key;
        bals[balStorageKey(chainId, addr)] = value;
      });
      applyModalBals(side, result.balances, !!result.complete);
      if(tokModalFor===side && document.getElementById('tok-modal-overlay').classList.contains('open')){
        renderTokList(document.getElementById('tok-search')?.value || '');
      }
    }
    if(side === 'from') updateBals();
    if(result?.complete) return;
  }
  const list = TOKENS[chainId] || [];
  const net = NETWORKS.find(n => n.id === chainId);
  if(!net?.rpc) return;
  const paddedWallet = wallet.slice(2).padStart(64,'0');

  // ── Step 1: show cached instantly ──
  const cachedMap = {};
  list.forEach(t => {
    const key = t.addr===NATIVE ? 'native' : t.addr.toLowerCase();
    const storageKey = balStorageKey(chainId, t.addr);
    if(storageKey in bals) cachedMap[key] = bals[storageKey];
  });
  if(Object.keys(cachedMap).length > 0) applyModalBals(side, cachedMap);

  // ── Step 2: fetch each token individually in parallel (no batch - avoids RPC limits) ──
  // Fire all requests at once, apply each result the moment it arrives
  const freshBals = {};
  const requests = list.map(async t => {
    const key = t.addr===NATIVE ? 'native' : t.addr.toLowerCase();
    const storageKey = balStorageKey(chainId, t.addr);
    const req = t.addr===NATIVE
      ? {jsonrpc:'2.0',id:1,method:'eth_getBalance',params:[wallet,'latest']}
      : {jsonrpc:'2.0',id:1,method:'eth_call',params:[{to:t.addr,data:'0x70a08231'+paddedWallet},'latest']};
    try {
      const r = await fetch(net.rpc, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(6000)
      });
      const d = await r.json();
      if(d.result && d.result !== '0x' && d.result !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
        freshBals[key] = d.result;
        bals[storageKey] = d.result;
        // Show each token balance the moment it arrives - no waiting for all
        applyModalBals(side, {[key]: d.result});
      }
    } catch(e) {}
  });

  await Promise.allSettled(requests);

  // Final: merge and refresh main balance display
  if(tokModalFor===side && document.getElementById('tok-modal-overlay').classList.contains('open')){
    renderTokList(document.getElementById('tok-search')?.value || '');
  }
  if(side === 'from') updateBals();
}

async function fetchDirectRawBalance(chainId,tok){
  if(!wallet||!tok)return null;
  const net=NETWORKS.find(item=>item.id===Number(chainId));if(!net?.rpc)return null;
  const request=tok.addr===NATIVE
    ? {jsonrpc:'2.0',id:1,method:'eth_getBalance',params:[wallet,'latest']}
    : {jsonrpc:'2.0',id:1,method:'eth_call',params:[{to:tok.addr,data:'0x70a08231'+wallet.slice(2).padStart(64,'0')},'latest']};
  try{
    const response=await fetch(net.rpc,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(7000)});
    const data=await response.json();
    return typeof data?.result==='string'&&/^0x[0-9a-fA-F]+$/.test(data.result)?data.result:null;
  }catch(e){return null;}
}

// Fast: fetch only the visible from-token via direct RPC (instant)
async function loadBalsFast(){
  if(!wallet) return;
  const tok=fromTok;
  if(!tok) return;
  updateBals();
  try{
    const result = await fetchBalancesViaProxy(fromChainId, [tok], 4500);
    let raw = result?.balances?.[tok.addr===NATIVE ? 'native' : tok.addr.toLowerCase()];
    if(!raw) raw=await fetchDirectRawBalance(fromChainId,tok);
    if(raw){
      bals[balStorageKey(fromChainId, tok.addr)] = raw;
      updateBals();
    }
  }catch(e){}
}

// Full: all tokens for modal (background)
async function loadBals(){
  if(!wallet) return;
  updateBals();
  loadBalsFast().catch(()=>{});
  Promise.resolve().then(async ()=>{
    const list=getChainTokens(fromChainId);
    const result=await fetchBalancesViaProxy(fromChainId, list);
    if(result?.balances){
      Object.entries(result.balances).forEach(([key, value]) => {
        const addr = key === 'native' ? NATIVE : key;
        bals[balStorageKey(fromChainId, addr)] = value;
      });
    }
    updateBals();
  }).catch(()=>{});
}
function rawHexToBigInt(hex){if(!hex||hex==='0x')return 0n;try{return BigInt(hex);}catch(e){return 0n;}}
function hexToDec(hex,dec){try{return Number(formatUnitsExact(rawHexToBigInt(hex),dec,12));}catch(e){return 0;}}
function getBalRawHex(tok,chainId=fromChainId){
  if(!tok||!wallet)return null;
  const key=balStorageKey(chainId,tok.addr),cacheKey=getBalanceCacheKey(tok,chainId);
  const raw=bals[key];
  if(raw!==undefined){lastKnownBalanceCache[cacheKey]=raw;return raw;}
  return Object.prototype.hasOwnProperty.call(lastKnownBalanceCache,cacheKey)?lastKnownBalanceCache[cacheKey]:null;
}
function getBal(tok,chainId=fromChainId){
  const raw=getBalRawHex(tok,chainId);if(raw===null)return null;
  return hexToDec(raw,tok?.addr===NATIVE?18:Number(tok?.dec??18));
}
function formatRawBalance(raw,dec){
  if(raw===null||raw===undefined)return '-';
  const value=rawHexToBigInt(raw);if(value===0n)return '0';
  const exact=formatUnitsExact(value,Number(dec),8);
  const numeric=Number(exact);
  if(Number.isFinite(numeric)&&numeric>=1000)return numeric.toLocaleString('en-US',{maximumFractionDigits:4});
  return exact;
}
function fmtBal(v){ if(v===null||v===undefined) return '-'; if(v===0) return '0'; return v>0.001?v.toFixed(v<1?4:2):v.toFixed(6); }
function updateBals(){
  const raw=getBalRawHex(fromTok);
  document.getElementById('send-bal').textContent=formatRawBalance(raw,fromTok?.addr===NATIVE?18:Number(fromTok?.dec??18));
  if(wallet){
    document.getElementById('receive-bal-wrap').style.display='inline';
    loadReceiveBal();
  }
  if(document.getElementById('tok-modal-overlay').classList.contains('open') && tokModalFor==='from'){
    renderTokList(document.getElementById('tok-search')?.value || '');
  }
  updateSendUsd();
}
async function loadReceiveBal(){
  if(!wallet || !toTok) return;
  const cacheKey=getBalanceCacheKey(toTok, toChainId);
  try{
    const result = await fetchBalancesViaProxy(toChainId, [toTok], 4500);
    let raw = result?.balances?.[toTok.addr===NATIVE ? 'native' : toTok.addr.toLowerCase()];
    if(!raw) raw=await fetchDirectRawBalance(toChainId,toTok);
    if(raw){
      lastKnownBalanceCache[cacheKey]=raw;
      document.getElementById('receive-bal').textContent = formatRawBalance(raw,toTok.addr===NATIVE?18:toTok.dec);
      return;
    }
  }catch(e){}
  if(Object.prototype.hasOwnProperty.call(lastKnownBalanceCache, cacheKey)){
    document.getElementById('receive-bal').textContent = formatRawBalance(lastKnownBalanceCache[cacheKey],toTok.addr===NATIVE?18:toTok.dec);
  }
}
const priceCache={};
async function getTokenPriceUSD(tok, activeChainId=fromChainId){
  if(!tok) return 0;
  const key=`${activeChainId}:${String(tok.addr||'native').toLowerCase()}:${tok.cmc||0}`;
  if(Object.prototype.hasOwnProperty.call(priceCache,key)) return priceCache[key];
  try{
    let price = Number(tok.priceUSD||0);
    if(tok.cmc){
      const r=await fetch(`/api/coingecko?ids=${tok.cmc}`,{signal:AbortSignal.timeout(8000)});
      const d=await r.json();
      price=Number(d?.data?.[tok.cmc]?.quote?.USD?.price||d?.data?.[String(tok.cmc)]?.quote?.USD?.price||0);
    }
    if(!(price>0) && tok.addr && tok.addr !== NATIVE){
      const r=await fetch(`/api/coingecko?address=${tok.addr}&chainId=${activeChainId}`,{signal:AbortSignal.timeout(8000)});
      const d=await r.json();
      price=Number(d?.[tok.addr.toLowerCase()]?.usd||0);
    }
    priceCache[key]=price;
    return price;
  }catch(e){ return 0; }
}
async function onFromChange(){ _bridgeNeedsApproval=false; _lastBridgeApprove=null; updateBtnState(); }
async function updateSendUsd(){
  const amt=parseFloat(document.getElementById('send-amt').value);
  if(!amt||isNaN(amt)||amt<=0){ document.getElementById('send-usd').textContent='\u2248 $0.00'; return; }
  const price=await getTokenPriceUSD(fromTok, fromChainId);
  if(!price) return;
  document.getElementById('send-usd').textContent=`\u2248 $${(amt*price).toLocaleString('en-US',{maximumFractionDigits:2,minimumFractionDigits:2})}`;
}

async function estimateNativeReserveRaw(chainId){
  try{
    const net=NETWORKS.find(n=>n.id===chainId);
    const provider=_activeProvider();
    let gasPriceHex=null;
    if(provider){
      const current=await provider.request({method:'eth_chainId'}).catch(()=>null);
      if(current&&parseInt(current,16)===chainId) gasPriceHex=await provider.request({method:'eth_gasPrice'}).catch(()=>null);
    }
    if(!gasPriceHex&&net?.rpc){
      const response=await fetch(net.rpc,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_gasPrice',params:[]}),signal:AbortSignal.timeout(5000)});
      gasPriceHex=(await response.json()).result;
    }
    if(gasPriceHex){
      const dynamic=BigInt(gasPriceHex)*500000n*13n/10n;
      const floor=chainId===1?3000000000000000n:100000000000000n;
      return dynamic>floor?dynamic:floor;
    }
  }catch(e){}
  return chainId===1?5000000000000000n:300000000000000n;
}
function getRawBalance(tok,chainId=fromChainId){
  const hex=bals[balStorageKey(chainId,tok?.addr)];
  try{return hex?BigInt(hex):null;}catch(e){return null;}
}
async function setPct(pct){
  if(!fromTok) return;
  const balance=getRawBalance(fromTok);
  if(balance===null) return;
  let raw=balance*BigInt(pct)/100n;
  if(pct===100&&fromTok.addr===NATIVE){
    const reserve=await estimateNativeReserveRaw(fromChainId);
    raw=raw>reserve?raw-reserve:0n;
  }
  document.getElementById('send-amt').value=raw>0n?formatUnitsExact(raw,fromTok.dec,12):'';
  onAmtInput();
}

// ═══════════════════════════════════════════
// SLIPPAGE
// ═══════════════════════════════════════════
function setSlip(v,btn){
  slippage=v;
  document.querySelectorAll('.slip-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('slip-custom').value='';
  if(routes.length) scheduleQuote();
}
function setSlipCustom(v){
  const n=Number(v);
  if(Number.isFinite(n)&&n>=0.01&&n<=5){
    slippage=n;
    document.querySelectorAll('.slip-btn').forEach(b=>b.classList.remove('active'));
    if(n>1) setStatus('High slippage increases the risk of an unfavorable execution.','warn');
    scheduleQuote();
  }else setStatus('Slippage must be between 0.01% and 5%.','err');
}

function onRecipientChange(){
  const input = document.getElementById('recipient-address');
  const warn = document.getElementById('poisoning-warning');
  if(wallet && input.value.trim().length > 0 && input.value.trim().toLowerCase() !== wallet.toLowerCase() && isValidAddr(input.value.trim())) {
    warn.style.display = 'block';
  } else {
    warn.style.display = 'none';
  }
  scheduleQuote();
}

function getRecipientAddress(){
  const value=String(document.getElementById('recipient-address')?.value||'').trim();
  if(!value) return wallet||'';
  if(!isValidAddr(value)) throw new Error('Destination recipient is not a valid EVM address');
  return value;
}

// ═══════════════════════════════════════════
// QUOTE / ROUTES
// ═══════════════════════════════════════════
function onAmtInput(){
  const el=document.getElementById('send-amt');
  const normalized=normalizeDecimalInput(el.value);
  if(normalized!==el.value) el.value=normalized;
  updateSendUsd(); scheduleQuote();
}
function scheduleQuote(){
  clearQuoteTimer();
  clearTimeout(quoteTimer);
  if(!validateAmount(document.getElementById('send-amt').value)){ clearRoutes(); return; }
  if(!wallet){ routes=[];routesExpiresAt=0;document.getElementById('routes-section').style.display='none';updateBtnState();return; }
  showRoutesLoading(); quoteTimer=setTimeout(fetchRoutes,650);
}
function showRoutesLoading(){
  document.getElementById('routes-section').style.display='block';
  document.getElementById('routes-list').innerHTML='<div class="routes-loading"><div class="spinner"></div>Finding executable routes…</div>';
  document.getElementById('routes-count').textContent='';
  document.getElementById('fee-section').style.display='none';
  document.getElementById('receive-amt').textContent='0.0';
  document.getElementById('receive-usd').textContent='≈ $0.00';
}
async function fetchRoutes(){
  const requestId=++_routeReqId;
  if(!wallet){clearRoutes();updateBtnState();return;}
  if(!fromTok||!toTok){ clearRoutes(); return; }
  let rawAmount;
  try{ rawAmount=getSendRawAmount(); if(rawAmount<=0n) throw new Error('Invalid amount'); }
  catch(e){ setStatus(e.message,'err'); clearRoutes(); return; }
  let recipient='';
  try{ recipient=getRecipientAddress(); }catch(e){ setStatus(e.message,'err'); clearRoutes(); return; }
  const slip=Math.min(Math.max(slippage,0.01),5)/100;
  const params=new URLSearchParams({fromChainId:String(fromChainId),toChainId:String(toChainId),fromToken:fromTok.addr,toToken:toTok.addr,fromAmount:rawAmount.toString(),slippage:String(slip)});
  if(wallet) params.set('fromAddress',wallet);
  if(recipient) params.set('toAddress',recipient);
  if(document.getElementById('destination-gas')?.checked){
    const gasAmount=rawAmount/100n;
    if(gasAmount>0n) params.set('fromAmountForGas',gasAmount.toString());
  }

  try{
    let data;
    if (fromChainId === toChainId) {
       // Same Chain - query 0x, ParaSwap, OpenOcean concurrently
       const slipBps = Math.round(slip * 10000);
       const rawStr = rawAmount.toString();
       const fetchers = [
          { id: '0x', fn: () => fetch0xQuote(rawStr, slipBps) },
          { id: 'paraswap', fn: () => fetchParaswapQuote(rawStr, slipBps) },
          { id: 'openocean', fn: () => fetchOpenOceanQuote(rawStr, slipBps) }
       ];
       
       const settled = await Promise.allSettled(fetchers.map(f => f.fn()));
       if (requestId !== _routeReqId) return;
       
       const swapRoutes = [];
       for (const res of settled) {
          if (res.status === 'fulfilled' && res.value && res.value.buyAmount) {
             const q = res.value;
             swapRoutes.push({
                id: 'swap-' + q._agg.toLowerCase() + '-' + Date.now(),
                isSwap: true,
                tool: q._agg,
                toAmount: q.buyAmount,
                toAmountMin: q.minBuyAmount || q.buyAmount,
                executionDuration: 3,
                steps: [
                   {
                      type: 'swap',
                      tool: q._agg,
                      toolDetails: { name: q._agg, logoURI: q._logo },
                      estimate: { toAmount: q.buyAmount }
                   }
                ],
                txData: q.transaction,
                allowanceTarget: q.allowanceTarget
             });
          }
       }
       
       if (!swapRoutes.length) {
          throw new Error('No liquidity routes found for swap');
       }
       
       // Sort routes descending by output amount
       swapRoutes.sort((a, b) => BigInt(b.toAmount) > BigInt(a.toAmount) ? 1 : -1);
       routes = swapRoutes;
    } else {
       // Cross Chain - use bridge API
       const response=await fetch('/api/bridge-routes?'+params,{signal:AbortSignal.timeout(22000)});
       data=await response.json().catch(()=>({}));
       if(requestId!==_routeReqId) return;
       if(!response.ok||data.error) throw new Error(data.details||data.error||`Bridge API ${response.status}`);
       routes=(data.routes||[]).filter(route=>Array.isArray(route?.steps)&&route.steps.length>0);
    }

    routesExpiresAt=Number(data?.expiresAt||Date.now()+55000);
    if(!routes.length){ document.getElementById('routes-list').innerHTML='<div class="routes-loading" style="justify-content:center">No executable route found</div>'; updateBtnState(); return; }
    renderRoutes(); selectRoute(0); setStatus('');
  }catch(e){ if(requestId!==_routeReqId)return; setStatus(e.name==='AbortError'?'Route request timed out.':`Unable to find routes: ${e.message}`,'err'); clearRoutes(); }
}

function fmtTime(seconds){
  const secs=Math.max(0,Number(seconds)||0);
  if(secs<60) return `${Math.round(secs)}s`;
  if(secs<3600) return `${Math.round(secs/60)}m`;
  return `${(secs/3600).toFixed(1)}h`;
}
function fmtAmt(raw,dec,maxDec=8){
  try{return formatUnitsExact(BigInt(String(raw||'0')),Number(dec),maxDec);}catch(e){return '0';}
}
function routeEstimate(route){
  return {toAmount:route?.toAmount||route?.steps?.at(-1)?.estimate?.toAmount||'0',toAmountMin:route?.toAmountMin||route?.steps?.at(-1)?.estimate?.toAmountMin||'0',toAmountUSD:route?.toAmountUSD||route?.steps?.at(-1)?.estimate?.toAmountUSD||'',fromAmountUSD:route?.fromAmountUSD||route?.steps?.[0]?.estimate?.fromAmountUSD||'',executionDuration:route?.steps?.reduce((sum,step)=>sum+Number(step?.estimate?.executionDuration||0),0)||0};
}
function routeCosts(route){
  let gas=0,fees=0;
  for(const step of route?.steps||[]){
    for(const cost of step?.estimate?.gasCosts||[]) gas+=Number(cost?.amountUSD||0);
    for(const cost of step?.estimate?.feeCosts||[]) fees+=Number(cost?.amountUSD||0);
  }
  return {gas,fees,total:gas+fees};
}
function routeToolNames(route){
  const names=[];
  for(const step of route?.steps||[]){
    const included=Array.isArray(step?.includedSteps)&&step.includedSteps.length?step.includedSteps:[step];
    for(const child of included){
      const name=String(child?.toolDetails?.name||child?.tool||'').trim();
      if(name&&!names.includes(name)) names.push(name);
    }
  }
  return names.length?names:['Bridge'];
}
function routePathLabel(route){
  const first=route?.steps?.[0]?.action?.fromToken?.symbol||fromTok?.sym||'';
  const last=route?.steps?.at(-1)?.action?.toToken?.symbol||toTok?.sym||'';
  const primary=getPrimaryBridgeTool(route).name;
  const txCount=Math.max(1,route?.steps?.length||1);
  return `${first} · ${primary} · ${last} · ${txCount} wallet transaction${txCount===1?'':'s'}`;
}
function getBridgeIcon(route){
  const url=String(route?.steps?.[0]?.toolDetails?.logoURI||'');
  return /^https:\/\//i.test(url)?url:'';
}
function routePriceImpact(route){
  const est=routeEstimate(route); const input=Number(est.fromAmountUSD||0),output=Number(est.toAmountUSD||0);
  return input>0&&output>=0?Math.max(0,(input-output)/input*100):null;
}
function renderRoutes(){
  document.getElementById('routes-section').style.display='block';
  document.getElementById('routes-count').textContent=`${routes.length} found`;
  document.getElementById('routes-list').innerHTML=routes.map((route,index)=>{
    const est=routeEstimate(route),cost=routeCosts(route);
    const toolInfo = getPrimaryBridgeTool(route);
    const name = toolInfo.name;
    const icon = toolInfo.logo || getBridgeIcon(route);
    
    const isFast = (!route.isSwap && ((est.executionDuration && est.executionDuration <= 180) || ['across', 'relay', 'debridge', 'layerswap', 'stargate'].includes(toolInfo.toolKey)));
    const badgeHtml = isFast ? `<div style="display:inline-block; background:rgba(245,181,27,0.2); color:var(--accent); font-size:10px; font-weight:800; padding:2px 6px; border-radius:4px; margin-left:8px; vertical-align:middle;">⚡ FASTEST (${fmtTime(est.executionDuration||120)})</div>` : '';

    const toAmount=fmtAmt(est.toAmount,toTok.dec);
    const time=fmtTime(est.executionDuration||(route.isSwap ? 3 : 120));
    const impact=routePriceImpact(route);
    const iconHtml=icon?`<img class="rc-bridge-icon" src="${esc(icon)}" onerror="this.style.display='none'" alt="${esc(name)}">`:`<div class="rc-bridge-icon" style="background:rgba(56,189,248,.12);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:900;color:#38bdf8">${esc(name.slice(0,2).toUpperCase())}</div>`;
    return `<div class="route-card${index===0?' best-badge':''}" id="route-card-${index}" role="button" tabindex="0" onclick="selectRoute(${index})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();selectRoute(${index})}">
      <div class="rc-bridge">${iconHtml}<div><span class="rc-bridge-name">${esc(name)}</span>${badgeHtml}<div class="route-path" title="${esc(routePathLabel(route))}">${esc(routePathLabel(route))}</div></div></div>
      <div class="rc-mid"><div class="rc-amount">${esc(toAmount)} ${esc(toTok.sym)}</div><div class="rc-usd">${est.toAmountUSD?`≈ $${Number(est.toAmountUSD).toFixed(2)}`:''}</div></div>
      <div class="rc-right"><div class="rc-time">⏱ ${esc(time)}</div><div class="rc-fee">Route cost ~$${cost.total.toFixed(2)}</div><div class="rc-tags">${index===0?'<span class="rc-tag">CHEAPEST</span>':''}${impact!==null&&impact>3?'<span class="rc-tag" style="color:#fbbf24">HIGH IMPACT</span>':''}</div></div>
    </div>`;
  }).join('');
}
async function selectRoute(index){
  selectedRouteIdx=index;
  document.querySelectorAll('.route-card').forEach((el,i)=>el.classList.toggle('selected',i===index));
  const route=routes[index]; if(!route) return;
  const est=routeEstimate(route),cost=routeCosts(route),impact=routePriceImpact(route);
  document.getElementById('receive-amt').textContent=`${fmtAmt(est.toAmount,toTok.dec)} ${toTok.sym}`;
  document.getElementById('receive-usd').textContent=est.toAmountUSD?`≈ $${Number(est.toAmountUSD).toFixed(2)}`:'≈ -';
  document.getElementById('fee-src-gas').textContent=cost.gas?`~$${cost.gas.toFixed(2)}`:'-';
  document.getElementById('fee-bridge').textContent=cost.fees?`~$${cost.fees.toFixed(2)}`:'$0.00';
  document.getElementById('fee-approval').textContent='Checking…';
  document.getElementById('fee-time').textContent=fmtTime(est.executionDuration||120);
  document.getElementById('fee-min-out').textContent=`${fmtAmt(est.toAmountMin||est.toAmount,toTok.dec)} ${toTok.sym}`;
  document.getElementById('fee-section').style.display='block';
  if(impact!==null&&impact>3) setStatus(`Warning: estimated value impact is ${impact.toFixed(2)}%. Review the route carefully.`,'warn');
  _bridgeNeedsApproval=false;
  const spender=route.isSwap ? route.allowanceTarget : route.steps?.[0]?.estimate?.approvalAddress;
  if(wallet&&fromTok.addr!==NATIVE&&isValidAddr(spender)){
    try{
      const current=await _requestWallet('eth_chainId',[],{timeoutMs:6000});
      if(parseInt(current,16)===fromChainId){
        const allowance=await readAllowance(fromTok.addr,wallet,spender);
        _bridgeNeedsApproval=allowance<getSendRawAmount();
      }
    }catch(e){ _bridgeNeedsApproval=true; }
  }
  document.getElementById('fee-approval').textContent=_bridgeNeedsApproval?'Additional network gas':'Not required';
  updateBtnState();
}
function clearRoutes(){
  clearQuoteTimer();
  hideProgress();
  _routeReqId++; routes=[]; routesExpiresAt=0;
  document.getElementById('routes-section').style.display='none';
  document.getElementById('fee-section').style.display='none';
  document.getElementById('receive-amt').textContent='0.0';
  document.getElementById('receive-usd').textContent='≈ $0.00';
  updateBtnState();
}
function updateBtnState(){
  const btn=document.getElementById('bridge-btn');
  if(bridgeBusy){btn.disabled=true;btn.textContent='Processing…';btn.className='bridge-btn loading';return;}
  if(!validateAmount(document.getElementById('send-amt').value)){btn.disabled=true;btn.textContent='Enter Amount';btn.className='bridge-btn';return;}
  if(!wallet){btn.disabled=false;btn.textContent='Connect Wallet';btn.className='bridge-btn ready';return;}
  if(!routes.length){btn.disabled=true;btn.textContent='Select Route';btn.className='bridge-btn';return;}

    const consentBox = document.getElementById('impact-consent-box');
    const consentCb = document.getElementById('impact-consent-cb');
    if (routes.length > 0) {
      const activeRoute = routes[selectedRouteIdx] || routes[0];
      const est = routeEstimate(activeRoute);
      const inputUSD = Number(est.fromAmountUSD || 0);
      const outputUSD = Number(est.toAmountUSD || 0);
      const impact = routePriceImpact(activeRoute);
      // Only block if impact is genuinely high and loss is more than $1 (ignore fixed relayer fee on micro-tests)
      const isRealImpact = impact !== null && impact >= 15 && (inputUSD >= 5 || (inputUSD - outputUSD) >= 1.0);
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

    btn.disabled=false;
  const actionWord = fromChainId === toChainId ? 'Swap' : 'Bridge';
  btn.textContent = _bridgeNeedsApproval ? `Approve & ${actionWord} ${fromTok?.sym||''}` : `${actionWord} →`;
  btn.className = _bridgeNeedsApproval ? 'bridge-btn approve' : 'bridge-btn ready';

}
function setBtnLoading(on){bridgeBusy=!!on;updateBtnState();}
function setStatus(message,type){const el=document.getElementById('status-msg');el.textContent=String(message||'');el.className='status-msg'+(type?' '+type:'');}

// ═══════════════════════════════════════════
// EXECUTION
// ═══════════════════════════════════════════
let _bridgeNeedsApproval=false;
let _lastBridgeApprove=null;
function normalizeWalletHex(value){
  const text=String(value??'0');
  return /^0x/i.test(text)?`0x${BigInt(text).toString(16)}`:`0x${BigInt(text||'0').toString(16)}`;
}
async function ensureWalletChain(chainId){
  const current=await _requestWallet('eth_chainId',[],{timeoutMs:8000});
  if(parseInt(current,16)!==Number(chainId)) await switchWalletToChain(chainId);
  const verified=await _requestWallet('eth_chainId',[],{timeoutMs:8000});
  if(parseInt(verified,16)!==Number(chainId)) throw new Error('Wallet is connected to the wrong network');
}
async function populateBridgeStep(step){
  const response=await fetch('/api/bridge-step',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({step}),signal:AbortSignal.timeout(26000)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||data.error) throw new Error(data.details||data.error||'Unable to build bridge transaction');
  return data;
}
async function readAllowance(token,owner,spender){
  if(!isValidAddr(token)||!isValidAddr(owner)||!isValidAddr(spender)) throw new Error('Invalid allowance parameters');
  const data='0xdd62ed3e'+owner.slice(2).padStart(64,'0')+spender.slice(2).padStart(64,'0');
  const result=await _requestWallet('eth_call',[{to:token,data},'latest'],{timeoutMs:12000});
  if(typeof result!=='string'||!/^0x[0-9a-fA-F]+$/.test(result)) throw new Error('Unable to verify token allowance');
  return BigInt(result);
}
async function assertActiveWalletAccount(expectedAddress){
  const accounts=await _requestWallet('eth_accounts',[],{timeoutMs:8000});
  const active=String(accounts?.[0]||'').toLowerCase();
  if(!isValidAddr(active)||active!==String(expectedAddress||'').toLowerCase()) throw new Error('The active wallet account changed. Reconnect and review the route again.');
  return active;
}
async function sendWalletTransaction(request,chainId,label='transaction',options={}){
  const fromAddress=String(options.fromAddress||wallet||'').toLowerCase();
  if(!isValidAddr(fromAddress)) throw new Error('Invalid transaction sender');
  await ensureWalletChain(chainId);
  await assertActiveWalletAccount(fromAddress);
  if(!request||!isValidAddr(request.to)||!/^0x[0-9a-fA-F]*$/.test(String(request.data||''))) throw new Error(`Invalid ${label} transaction data`);
  const tx={from:fromAddress,to:request.to,data:request.data||'0x',value:normalizeWalletHex(request.value||0),chainId:`0x${Number(chainId).toString(16)}`};
  let estimate;
  try{ estimate=await _requestWallet('eth_estimateGas',[tx],{timeoutMs:18000}); }
  catch(e){ throw new Error(`${label} simulation failed: ${e?.message||'transaction would revert'}`); }
  const gas=BigInt(estimate)*115n/100n;
  tx.gas=`0x${gas.toString(16)}`;
  const hash=await _requestWallet('eth_sendTransaction',[tx],{timeoutMs:45000});
  if(!isValidTxHash(hash)) throw new Error(`Invalid ${label} transaction hash`);
  try{ if(typeof options.onHash==='function') options.onHash(hash); }catch(e){}
  await waitForTx(hash,chainId);
  return hash;
}
async function sendApproval(token,spender,amount,chainId,owner){
  const amountHex=BigInt(amount).toString(16).padStart(64,'0');
  const data='0x095ea7b3'+spender.slice(2).padStart(64,'0')+amountHex;
  return sendWalletTransaction({to:token,data,value:'0x0'},chainId,'approval',{fromAddress:owner});
}
async function checkAndApproveToken(token,spender,amount,chainId,owner){
  if(token===NATIVE||String(token).toLowerCase()==='0x0000000000000000000000000000000000000000') return true;
  if(!isValidAddr(token)||!isValidAddr(spender)||!isValidAddr(owner)) throw new Error('Invalid approval target');
  await ensureWalletChain(chainId);
  await assertActiveWalletAccount(owner);
  const required=BigInt(amount);
  const cache=_lastBridgeApprove;
  if(cache&&cache.chainId===chainId&&cache.owner===owner.toLowerCase()&&cache.token===token.toLowerCase()&&cache.spender===spender.toLowerCase()&&cache.amount>=required) return true;
  let allowance=await readAllowance(token,owner,spender);
  if(allowance>=required) return true;
  
  setStatus(`Confirm ${fromTok?.sym || 'token'} allowance in your wallet…`,'warn');
  try {
    await sendApproval(token,spender,required,chainId,owner);
  } catch(firstErr) {
    if(allowance>0n) {
      setStatus('Resetting existing token allowance to 0…','warn');
      await sendApproval(token,spender,0n,chainId,owner);
      setStatus(`Confirm new ${fromTok?.sym || 'token'} allowance…`,'warn');
      await sendApproval(token,spender,required,chainId,owner);
    } else {
      throw firstErr;
    }
  }
  const verified=await readAllowance(token,owner,spender);
  if(verified<required) throw new Error('Token allowance was not granted');
  _lastBridgeApprove={chainId,owner:owner.toLowerCase(),token:token.toLowerCase(),spender:spender.toLowerCase(),amount:required};
  return true;
}
async function waitForTx(hash,chainId){
  const provider=_activeProvider();
  if(!provider) throw new Error('Wallet provider disconnected');
  for(let attempt=0;attempt<100;attempt++){
    const receipt=await provider.request({method:'eth_getTransactionReceipt',params:[hash]}).catch(()=>null);
    if(receipt){
      if(receipt.status==='0x1'||receipt.status===1) return receipt;
      if(receipt.status==='0x0'||receipt.status===0) throw new Error('Transaction reverted on-chain');
    }
    await new Promise(resolve=>setTimeout(resolve,3000));
  }
  throw new Error('Transaction confirmation timed out');
}
async function doBridge(){
  if(!wallet){connectWallet();return;}
  const route=routes[selectedRouteIdx];
  if(!route){setStatus('Select a route first.','err');return;}
  if(Date.now()>routesExpiresAt){setStatus('The route expired. It has been refreshed; review it and press Swap/Bridge again.','warn');await fetchRoutes();return;}
  if(slippage>1&&!confirm(`Slippage is ${slippage}%. Continue with this high tolerance?`)) return;
  
  const secKey = fromChainId + '-' + (fromTok.addr || '').toLowerCase();
  const sec = _currentSecCache[secKey];
  if(sec) {
     if(sec.cannot_sell || sec.is_honeypot) {
         setStatus(`Security check failed: ${fromTok.sym} is flagged as a honeypot and cannot be sold.`, 'err');
         return;
     }
     if((sec.buy_tax > 0.05 || sec.sell_tax > 0.05) && !confirm(`${fromTok.sym} has high transfer taxes (Buy: ${(sec.buy_tax*100).toFixed(1)}%, Sell: ${(sec.sell_tax*100).toFixed(1)}%). This reduces your received amount. Continue?`)) {
         return;
     }
  }

  const executionWallet=String(wallet).toLowerCase();
  let recipient;
  try{
    recipient=getRecipientAddress();if(!recipient)throw new Error('Connect a wallet or enter a recipient address');
    const firstAction=route.steps?.[0]?.action||{};
    const finalAction=route.steps?.at(-1)?.action||{};
    if(firstAction.fromAddress&&String(firstAction.fromAddress).toLowerCase()!==executionWallet) throw new Error('The selected route belongs to another wallet. Refresh the route.');
    if(finalAction.toAddress&&String(finalAction.toAddress).toLowerCase()!==String(recipient).toLowerCase()) throw new Error('The destination recipient changed. Refresh the route.');
  }catch(e){setStatus(e.message,'err');return;}

  setBtnLoading(true); showProgress('',routeToolNames(route).join(' → '));
  const initialFromChainId=fromChainId,initialToChainId=toChainId;
  const initialFromTok={...fromTok},initialToTok={...toTok};
  const sendAmountText=document.getElementById('send-amt').value;
  const fromNet=NETWORKS.find(n=>n.id===initialFromChainId),toNet=NETWORKS.find(n=>n.id===initialToChainId);
  const tokenSnapshots=[{...initialFromTok,chainId:initialFromChainId},{...initialToTok,chainId:initialToChainId}];
  let historyItem=null,crossHash=null,crossTool='',crossFromChain=null,crossToChain=null,lastHash=null;

  try{
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

      if(initialFromTok.addr.toLowerCase()!==NATIVE && spender) {
        setProgStep(0, 'active');
        setStatus(`Approve ${initialFromTok.sym} in your wallet...`, 'warn');
        await checkAndApproveToken(initialFromTok.addr,spender,String(rawAmount),chainId,executionWallet);
      }
      
      setProgStep(0,'done'); setProgStep(1,'active');
      
      // Ensure we have executable transaction data (re-fetch if quote was obtained before approval)
      let txData = route.txData;
      if (!txData || !txData.to || !txData.data) {
        setStatus('Preparing swap transaction…', 'warn');
        const slipBps = Math.round(Math.min(Math.max(slippage,0.01),5) * 100);
        const rawStr = rawAmount.toString();
        if (route.tool === 'ParaSwap') {
          const fresh = await fetchParaswapQuote(rawStr, slipBps);
          txData = fresh.transaction;
        } else if (route.tool === '0x Protocol') {
          const fresh = await fetch0xQuote(rawStr, slipBps);
          txData = fresh.transaction;
        } else if (route.tool === 'OpenOcean') {
          const fresh = await fetchOpenOceanQuote(rawStr, slipBps);
          txData = fresh.transaction;
        }
      }

      if (!txData || !txData.to || !txData.data) {
        throw new Error('Could not build executable swap transaction. Please refresh quotes and try again.');
      }

      setStatus('Confirm swap in your wallet...','warn');
      
      const hash = await sendWalletTransaction(txData, chainId, 'swap', {
        fromAddress: executionWallet,
        onHash: submittedHash => {
          lastHash=submittedHash;
          const sourceNetwork=NETWORKS.find(net=>net.id===chainId)||fromNet;
          historyItem={hash:submittedHash,status:'pending',fromSym:initialFromTok.sym,toSym:initialToTok.sym,sendAmt:sendAmountText,recvAmt:fmtAmt(routeEstimate(route).toAmount,initialToTok.dec),fromNet:fromNet?.name,toNet:toNet?.name,fromChainId:initialFromChainId,toChainId:initialToChainId,statusFromChainId:initialFromChainId,statusToChainId:initialToChainId,bridge:route.tool,explorer:sourceNetwork?.explorer,recipient,routeId:String(route.id||''),tokenSnapshots,stepHashes:[submittedHash],ts:Date.now()};
          addToHistory(historyItem);
        }
      });
      lastHash = hash;
      setProgStep(1,'done');
      setProgStep(2,'done');
      setStatus('Swap completed successfully! 🎉','ok');
    } else {
      for(let index=0;index<route.steps.length;index++){
        const originalStep=route.steps[index];
        const populated=await populateBridgeStep(originalStep);
        const step=populated.step||originalStep;
        const action=step.action||originalStep.action;
        const chainId=Number(action.fromChainId);
        if(action.fromAddress&&String(action.fromAddress).toLowerCase()!==executionWallet) throw new Error('A route step has an unexpected sender address');
        await ensureWalletChain(chainId);
        await assertActiveWalletAccount(executionWallet);
        const tokenAddress=String(action.fromToken?.address||'').toLowerCase();
        const spender=String(populated.approvalAddress||'');
        if(tokenAddress!==NATIVE&&tokenAddress!=='0x0000000000000000000000000000000000000000') await checkAndApproveToken(tokenAddress,spender,String(action.fromAmount),chainId,executionWallet);
        setProgStep(0,'done'); setProgStep(1,'active');
        setStatus(`Confirm step ${index+1} of ${route.steps.length} in your wallet…`,'warn');
        const isCross=Number(action.fromChainId)!==Number(action.toChainId);
        const stepTool=String(step.tool||originalStep.tool||'bridge');
        const hash=await sendWalletTransaction(populated.transactionRequest,chainId,`bridge step ${index+1}`,{
          fromAddress:executionWallet,
          onHash:submittedHash=>{
            lastHash=submittedHash;
            if(isCross){crossHash=submittedHash;crossTool=stepTool;crossFromChain=Number(action.fromChainId);crossToChain=Number(action.toChainId);setProgStep(2,'active');}
            if(!historyItem){
              const sourceNetwork=NETWORKS.find(net=>net.id===chainId)||fromNet;
              historyItem={hash:submittedHash,status:'pending',fromSym:initialFromTok.sym,toSym:initialToTok.sym,sendAmt:sendAmountText,recvAmt:fmtAmt(routeEstimate(route).toAmount,initialToTok.dec),fromNet:fromNet?.name,toNet:toNet?.name,fromChainId:initialFromChainId,toChainId:initialToChainId,statusFromChainId:isCross?Number(action.fromChainId):initialFromChainId,statusToChainId:isCross?Number(action.toChainId):initialToChainId,bridge:isCross?stepTool:stepTool,explorer:sourceNetwork?.explorer,recipient,routeId:String(route.id||''),tokenSnapshots,stepHashes:[submittedHash],ts:Date.now()};
              addToHistory(historyItem);
            }else{
              const previousHash=historyItem.hash;
              if(!historyItem.stepHashes.includes(submittedHash)) historyItem.stepHashes.push(submittedHash);
              const patch={stepHashes:historyItem.stepHashes,bridge:isCross?stepTool:historyItem.bridge};
              if(isCross){const crossNet=NETWORKS.find(net=>net.id===Number(action.fromChainId));Object.assign(patch,{hash:submittedHash,explorer:crossNet?.explorer||historyItem.explorer,statusFromChainId:Number(action.fromChainId),statusToChainId:Number(action.toChainId)});}
              updateHistoryRecord(previousHash,patch);
              if(isCross) historyItem.hash=submittedHash;
            }
          }
        });
        lastHash=hash; setProgStep(1,'done');
        if(isCross&&index<route.steps.length-1){
          setStatus('Waiting for the cross-chain step before continuing…','warn');
          const final=await waitBridgeStatusFinal(hash,Number(action.fromChainId),Number(action.toChainId),crossTool);
          if(final.status!=='DONE'||final.substatus!=='COMPLETED'){
            const error=new Error(final.substatusMessage||`Cross-chain step ended as ${final.substatus||final.status}`);
            error.bridgeStatus=final.status==='DONE'&&final.substatus==='PARTIAL'?'partial':final.status==='DONE'&&final.substatus==='REFUNDED'?'refunded':'failed';
            error.bridgeData=final;throw error;
          }
        }
      }
    }

    // Common completion for both Swap and Bridge
    _bridgeNeedsApproval=false;_lastBridgeApprove=null;
    document.getElementById('send-amt').value='';document.getElementById('send-usd').textContent='≈ $0.00';clearRoutes();
    loadBalsFast();setTimeout(loadBals,4000);
    
    if(crossHash){
      pollBridgeStatus(crossHash,crossFromChain||initialFromChainId,crossToChain||initialToChainId,crossTool||historyItem?.bridge||'');
      setStatus('Source transaction confirmed. Tracking the destination transfer…','warn');
    }else{
      updateHistoryRecord(historyItem?.hash||lastHash,{status:'confirmed'}); 
      const confirmedItem=txHistory.find(entry=>entry.hash===(historyItem?.hash||lastHash));
      if(confirmedItem)rememberHistoryTokens({...confirmedItem,status:'confirmed'});
      setProgStep(2,'done');setProgStep(3,'done');
      if(!route.isSwap) setStatus('Bridge route completed.','ok');
    }
  }catch(e){
    const timedOut=/confirmation timed out/i.test(String(e?.message||''));
    if(historyItem) updateHistoryRecord(historyItem.hash,{status:timedOut?'pending':(e.bridgeStatus||'failed'),message:e.message,substatus:e.bridgeData?.substatus||''});
    if(timedOut&&crossHash) pollBridgeStatus(crossHash,crossFromChain||initialFromChainId,crossToChain||initialToChainId,crossTool||historyItem?.bridge||'',{immediate:true});
    setProgStep(2,timedOut?'active':'failed');
    setStatus(e?.code===4001?'Transaction rejected':(e?.message||(route.isSwap?'Swap failed':'Bridge failed')),timedOut?'warn':'err');
  }finally{setBtnLoading(false);}
}

// ═══════════════════════════════════════════
// PROGRESS AND STATUS
// ═══════════════════════════════════════════
function showProgress(txHash, customTitle=''){
  const wrap = document.getElementById('progress-wrap');
  wrap.classList.add('show');
  const isSwap = fromChainId === toChainId;
  const titleEl = wrap.querySelector('.prog-title');
  if (titleEl) {
    titleEl.textContent = isSwap ? '⚡ Swap in progress…' : '🔗 Bridge in progress…';
  }
  
  // Update step labels
  const steps = wrap.querySelectorAll('.prog-step');
  const lines = wrap.querySelectorAll('.prog-line');
  if (isSwap) {
    if (steps[0]) steps[0].querySelector('.prog-label').textContent = fromTok.addr === NATIVE ? 'Ready' : 'Approve';
    if (steps[1]) steps[1].querySelector('.prog-label').textContent = 'Swap';
    if (steps[2]) steps[2].querySelector('.prog-label').textContent = 'Done';
    if (steps[3]) steps[3].style.display = 'none';
    if (lines[2]) lines[2].style.display = 'none';
  } else {
    if (steps[0]) steps[0].querySelector('.prog-label').textContent = 'Approved';
    if (steps[1]) steps[1].querySelector('.prog-label').textContent = 'Sent';
    if (steps[2]) steps[2].querySelector('.prog-label').textContent = 'Bridging';
    if (steps[3]) { steps[3].style.display = 'flex'; steps[3].querySelector('.prog-label').textContent = 'Done'; }
    if (lines[2]) lines[2].style.display = 'block';
  }

  for(let i=0;i<4;i++) setProgStep(i,i===0?'active':'pending');
  if(txHash) document.getElementById('prog-tx-link').innerHTML=getBridgeTxLinks(fromChainId,txHash,toChainId,'');
  else document.getElementById('prog-tx-link').innerHTML='';
}
function hideProgress(){document.getElementById('progress-wrap').classList.remove('show');}
function getBridgeTxLinks(fromChain,sourceHash,toChain,destinationHash,lifiLink=''){
  const links=[],fromNet=NETWORKS.find(n=>n.id===Number(fromChain)),toNet=NETWORKS.find(n=>n.id===Number(toChain));
  if(fromNet&&isValidTxHash(sourceHash)) links.push(`<a class="tx-link" href="${esc(fromNet.explorer)}/tx/${esc(sourceHash)}" target="_blank" rel="noopener noreferrer">Source tx ?</a>`);
  if(toNet&&isValidTxHash(destinationHash)) links.push(`<a class="tx-link" href="${esc(toNet.explorer)}/tx/${esc(destinationHash)}" target="_blank" rel="noopener noreferrer">Destination tx ?</a>`);
  if(/^https:\/\//i.test(lifiLink)) links.push(`<a class="tx-link" href="${esc(lifiLink)}" target="_blank" rel="noopener noreferrer">LI.FI Explorer ?</a>`);
  return links.join(' &nbsp;•&nbsp; ');
}
function setProgStep(index,state){
  const dot=document.getElementById('prog-'+index);if(!dot)return;
  dot.className='prog-dot'+(state!=='pending'?` ${state}`:'');
  dot.innerHTML=state==='done'?'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"></path></svg>':state==='failed'?'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>':state==='active'?'<div class="tx-premium-spinner" style="width:14px;height:14px;border-width:2px;margin:0;box-shadow:none;"></div>':'';
  if(index>0){const line=document.getElementById('prog-line-'+(index-1));if(line)line.className='prog-line'+(state==='done'?' done':'');}
}
async function fetchBridgeStatus(txHash,fromChain,toChain,bridgeName){
  const params=new URLSearchParams({txHash});
  if(bridgeName)params.set('bridge',bridgeName);
  if(fromChain)params.set('fromChain',String(fromChain));
  if(toChain)params.set('toChain',String(toChain));
  const response=await fetch('/api/bridge-status?'+params,{signal:AbortSignal.timeout(12000)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||data.error)throw new Error(data.error||'Status API error');
  return data;
}
async function waitBridgeStatusFinal(txHash,fromChain,toChain,bridgeName){
  for(let i=0;i<240;i++){
    const status=await fetchBridgeStatus(txHash,fromChain,toChain,bridgeName).catch(()=>null);
    if(status&&(status.status==='DONE'||status.status==='FAILED'))return status;
    await new Promise(resolve=>setTimeout(resolve,15000));
  }
  throw new Error('Cross-chain step is still pending. It will continue to be tracked in history.');
}
function pollBridgeStatus(txHash,fromChain,toChain,bridgeName,options={}){
  if(!isValidTxHash(txHash)||bridgePollTimers.has(txHash))return;
  let attempts=0;
  const check=async()=>{
    attempts++;
    try{
      const data=await fetchBridgeStatus(txHash,fromChain,toChain,bridgeName);
      const destinationHash=data.receiving?.txHash||null;
      const receivedToken=data.receiving?.token||null;
      const receivedAmount=data.receiving?.amount||null;
      let actualAmount=null;
      if(receivedAmount&&Number.isInteger(Number(receivedToken?.decimals))) actualAmount=fmtAmt(receivedAmount,Number(receivedToken.decimals));
      updateHistoryRecord(txHash,{substatus:data.substatus,message:data.substatusMessage,destinationHash,lifiExplorerLink:data.lifiExplorerLink,receivedAmount,receivedToken,...(actualAmount?{recvAmt:actualAmount,toSym:receivedToken?.symbol||''}:{})});
      if(!options.silent){
        document.getElementById('prog-tx-link').innerHTML=getBridgeTxLinks(fromChain,txHash,toChain,destinationHash,data.lifiExplorerLink);
      }
      if(data.status==='DONE'){
        let status='confirmed',message='Bridge completed successfully.';
        if(data.substatus==='PARTIAL'){status='partial';message=data.substatusMessage||'Bridge completed, but a different destination token was received.';}
        else if(data.substatus==='REFUNDED'){status='refunded';message=data.substatusMessage||'The bridge was refunded to the source wallet.';}
        updateHistoryRecord(txHash,{status});
        if(status==='confirmed'){
          const item=txHistory.find(entry=>entry.hash===txHash);if(item)rememberHistoryTokens({...item,status:'confirmed'});
          if(!options.silent){setProgStep(1,'done');setProgStep(2,'done');setProgStep(3,'done');setStatus(message,'ok');setTimeout(()=>{loadBals();hideProgress();},2500);}
        }else if(!options.silent){setProgStep(2,'failed');setStatus(message,status==='refunded'?'warn':'err');}
        bridgePollTimers.delete(txHash);return;
      }
      if(data.status==='FAILED'||data.status==='INVALID'){
        const refunded=data.substatus==='REFUNDED';
        updateHistoryRecord(txHash,{status:refunded?'refunded':'failed'});
        if(!options.silent){setProgStep(2,'failed');setStatus(data.substatusMessage||(refunded?'The transfer was refunded.':'Bridge failed. Check the transaction details.'),refunded?'warn':'err');}
        bridgePollTimers.delete(txHash);return;
      }
      if(!options.silent){
        if(data.substatus==='WAIT_SOURCE_CONFIRMATIONS'){setProgStep(1,'active');setStatus('Waiting for source-chain confirmations…','warn');}
        else{setProgStep(1,'done');setProgStep(2,'active');setStatus(data.substatusMessage||'Waiting for the destination transfer…','warn');}
      }
    }catch(e){}
    if(attempts<1440){const timer=setTimeout(check,attempts<30?8000:20000);bridgePollTimers.set(txHash,timer);}else bridgePollTimers.delete(txHash);
  };
  bridgePollTimers.set(txHash,setTimeout(check,options.immediate?0:3000));
}
function checkBridgeNow(hash){
  const item=txHistory.find(entry=>entry.hash===hash);if(!item)return;
  const old=bridgePollTimers.get(hash);if(old)clearTimeout(old);bridgePollTimers.delete(hash);
  pollBridgeStatus(hash,item.statusFromChainId||item.fromChainId,item.statusToChainId||item.toChainId,item.bridge||'',{immediate:true});
}

// ═══════════════════════════════════════════
// CHAIN MODAL
// ═══���════════��═��════════════════════════════
let chainModalFor=null;
function openChainModal(side){
  chainModalFor=side;
  const ovr=document.getElementById('chain-modal-overlay');
  ovr.classList.add('open');
  document.getElementById('chain-modal-title').textContent=side==='from'?'From Network':'To Network';
  document.getElementById('chain-modal-sub').textContent=side==='from'?'Choose source network':'Choose destination network';
  document.getElementById('chain-search').value='';
  renderChainGrid('');
  setTimeout(()=>document.getElementById('chain-search').focus(),80);
}
function closeChainModal(e){
  if(e&&e.target!==document.getElementById('chain-modal-overlay')) return;
  document.getElementById('chain-modal-overlay').classList.remove('open');
}
function filterChains(){ renderChainGrid(document.getElementById('chain-search').value); }
function renderChainGrid(q){
  q=q.toLowerCase().trim();
  const filtered=q?NETWORKS.filter(n=>n.name.toLowerCase().includes(q)||n.sym.toLowerCase().includes(q)):NETWORKS;
  const activeId=chainModalFor==='from'?fromChainId:toChainId;
  document.getElementById('chain-grid').innerHTML=filtered.map(n=>`
    <div class="chain-grid-item${n.id===activeId?' active':''}" role="button" tabindex="0" onclick="pickChain(${n.id})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();pickChain(${n.id})}">
      ${chainIconHTML(n,32)}
      <div>
        <div class="cgi-name">${esc(n.name)}</div>
        <div class="cgi-sym">${esc(n.sym)}</div>
      </div>
    </div>`).join('');
}
async function switchWalletToChain(chainId){
  if(!wallet) throw new Error('Connect a wallet first');
  const net=NETWORKS.find(item=>item.id===Number(chainId));
  if(!net) throw new Error('Unsupported network');
  const hexId=`0x${Number(chainId).toString(16)}`;
  try{
    await _requestWallet('wallet_switchEthereumChain',[{chainId:hexId}],{timeoutMs:20000});
  }catch(error){
    if(error?.code!==4902&&error?.code!==-32603) throw error;
    await _requestWallet('wallet_addEthereumChain',[{
      chainId:hexId,
      chainName:net.name,
      nativeCurrency:{name:net.currency||net.sym,symbol:net.currency||net.sym,decimals:Number(net.decimals||18)},
      rpcUrls:[net.rpc],
      blockExplorerUrls:[net.explorer],
    }],{timeoutMs:25000});
    await _requestWallet('wallet_switchEthereumChain',[{chainId:hexId}],{timeoutMs:20000});
  }
  const current=await _requestWallet('eth_chainId',[],{timeoutMs:8000});
  if(parseInt(current,16)!==Number(chainId)) throw new Error('Network switch was not completed');
  return true;
}

async function pickChain(id){
  await hydrateMajorTokensForChain(id);
  const wasFrom=chainModalFor==='from';
  let swapped=false;
  if(wasFrom){
    fromChainId=id;
  }else{
    toChainId=id;
  }
  await Promise.all([hydrateMajorTokensForChain(fromChainId),hydrateMajorTokensForChain(toChainId)]);
  if(swapped){
    fromTok=TOKENS[fromChainId]?.[0]||TOKENS[1][0];
    toTok=TOKENS[toChainId]?.[0]||TOKENS[1][0];
  }else if(wasFrom) fromTok=TOKENS[fromChainId]?.[0]||TOKENS[1][0];
  else toTok=TOKENS[toChainId]?.[0]||TOKENS[1][0];
  if(wasFrom) switchWalletToChain(fromChainId).catch(error=>setStatus(error?.code===4001?'Network switch rejected':(error.message||'Unable to switch network'),'err'));
  document.getElementById('chain-modal-overlay').classList.remove('open');
  _bridgeNeedsApproval=false; _lastBridgeApprove=null;
  updateChainUI(); updateTokenUI(); clearRoutes(); updateBals(); scheduleQuote();
  if(wallet){ loadBalsFast(); loadBals(); }
}

// ═══════════════════════════════════════════
// TOKEN MODAL
// ═══════════════════════════════════════════
let tokModalFor=null;
function openTokenModal(side){
  tokModalFor=side;
  const chainId=side==='from'?fromChainId:toChainId;
  const chainName=NETWORKS.find(n=>n.id===chainId)?.name||'';
  document.getElementById('tok-modal-title').textContent=side==='from'?'Send Token':'Receive Token';
  document.getElementById('tok-modal-sub').textContent=`Tokens on ${chainName}`;
  document.getElementById('tok-modal-overlay').classList.add('open');
  document.getElementById('tok-search').value='';
  renderTokList('');
  hydrateMajorTokensForChain(chainId).then(()=>{
    if(document.getElementById('tok-modal-overlay').classList.contains('open')&&tokModalFor===side) renderTokList(document.getElementById('tok-search').value||'');
  });
  setTimeout(()=>document.getElementById('tok-search').focus(),80);
  // Load balances only for the curated and recently used tokens.
  if(wallet){
    loadBalsForModal(side);
  }
}
function closeTokModal(e){
  if(e&&e.target!==document.getElementById('tok-modal-overlay')) return;
  document.getElementById('tok-modal-overlay').classList.remove('open');
}
function filterTokens(){ renderTokList(document.getElementById('tok-search').value); }

// Exact token metadata is resolved through LI.FI and on-chain metadata APIs.
async function resolveTokenByAddr(addr,chainId){
  const lower=String(addr||'').toLowerCase();
  if(!/^0x[0-9a-f]{40}$/.test(lower)) return null;
  let token=null;
  try{
    const response=await fetch(`/api/bridge-token?chainId=${encodeURIComponent(chainId)}&address=${encodeURIComponent(lower)}`,{signal:AbortSignal.timeout(12000)});
    const data=await response.json().catch(()=>({}));
    if(response.ok&&data?.token?.sym&&Number.isInteger(Number(data.token.dec))) token={...data.token,addr:lower,dec:Number(data.token.dec),cmc:0,custom:true,searchOnly:true};
  }catch(e){}
  if(!token){
    try{
      const response=await fetch(`/api/token-metadata?chainId=${encodeURIComponent(chainId)}&address=${encodeURIComponent(lower)}`,{signal:AbortSignal.timeout(12000)});
      const data=await response.json().catch(()=>({}));
      if(response.ok&&data?.token?.sym&&Number.isInteger(Number(data.token.dec))) token={sym:data.token.sym,name:data.token.name||data.token.sym,addr:lower,dec:Number(data.token.dec),cmc:0,logo:data.token.logo||null,custom:true,searchOnly:true,verified:false};
    }catch(e){}
  }
  if(!token) return null;
  try{
    const safetyResponse=await fetch(`/api/token-safety?chainId=${encodeURIComponent(chainId)}&address=${encodeURIComponent(lower)}`,{signal:AbortSignal.timeout(10000)});
    const safety=await safetyResponse.json().catch(()=>null);
    if(safetyResponse.ok&&safety){ token.riskLevel=safety.riskLevel||'unknown'; token.riskWarnings=safety.security?.warnings||[]; token.security=safety.security||null; token.blockedRisk=!!safety.security?.honeypot; }
  }catch(e){}
  resolveTokenLogosForChain(chainId,[token],true).catch(()=>{});
  return token;
}

let _lastResolvedBridgeToken=null;
function pickResolvedBridgeToken(){ const tok=_lastResolvedBridgeToken; if(!tok) return; pickTok(tok.addr,tok.sym,tok.name,tok.dec,tok.logo||'',tok); }
function renderTokList(q){
  const chainId=tokModalFor==='from'?fromChainId:toChainId;
  const list=getChainTokens(chainId).length ? getChainTokens(chainId) : getChainTokens(1);
  q=q.trim().toLowerCase();
  const isFullAddr=/^0x[0-9a-f]{40}$/.test(q);
  let filtered=q?list.filter(t=>t.sym.toLowerCase().includes(q)||t.name.toLowerCase().includes(q)||t.addr.toLowerCase().includes(q)):list;
  queueTokenLogoHydration(chainId, filtered.slice(0, 28), ()=>{
    const modal=document.getElementById('tok-modal-overlay');
    if(!modal||!modal.classList.contains('open')) return;
    renderTokList(document.getElementById('tok-search')?.value || '');
  });
  // Если полный адрес и не найден в списке - ищем через API
  if(isFullAddr && filtered.length===0){
    document.getElementById('tok-list').innerHTML=
      '<div style="padding:20px;text-align:center;color:rgba(255,255,255,0.4);font-family:\'DM Mono\',monospace;font-size:15px;">🔍 Looking up token...</div>';
    resolveTokenByAddr(q, chainId).then(tok=>{
      if(!tok){
        document.getElementById('tok-list').innerHTML=
          '<div style="padding:20px;text-align:center;color:rgba(255,255,255,0.4);font-family:\'DM Mono\',monospace;font-size:15px;">Token not found on this network</div>';
        return;
      }
      _lastResolvedBridgeToken=tok;
      const riskText=tok.blockedRisk?'Honeypot warning':(tok.riskLevel==='high'?'High-risk token':(tok.verified?'Listed in LI.FI verified tokens':'Not in LI.FI verified token list'));
      document.getElementById('tok-list').innerHTML=`
        <div class="tok-item" role="button" tabindex="0" onclick="pickResolvedBridgeToken()" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();pickResolvedBridgeToken()}">
          ${tokIconEl(tok,40,chainId)}
          <div class="tok-info">
            <div class="tok-sym2">${esc(tok.sym)}</div>
            <div class="tok-name2">${esc(tok.name)}</div>
            <div class="token-risk">${esc(riskText)} · ${esc(tok.addr.slice(0,8))}…${esc(tok.addr.slice(-6))}</div>
          </div>
          <div class="tok-bal2"></div>
        </div>`;
    });
    return;
  }
  const rows=filtered.map(t=>{
    const rawBal=getBalRawHex(t,chainId);
    const bal=getBal(t, chainId);
    const isLoading=rawBal===null && wallet;
    const hasb=rawBal!==null&&rawHexToBigInt(rawBal)>0n;
    const balStr=isLoading?'...':(rawBal===null?'':formatRawBalance(rawBal,t.addr===NATIVE?18:t.dec));
    return `
    <div class="tok-item" role="button" tabindex="0" onclick="pickTok('${esc(t.addr)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();pickTok('${esc(t.addr)}')}">
      ${tokIconEl(t,40,chainId)}
      <div class="tok-info">
        <div class="tok-sym2">${esc(t.sym)}</div>
        <div class="tok-name2">${esc(t.name)}</div>
      </div>
      <div class="tok-bal2 ${hasb?'hasbal':''}" id="tbal-${esc(t.addr)}">${balStr}</div>
    </div>`;
  }).join('');
  document.getElementById('tok-list').innerHTML=rows||`<div style="padding:20px;text-align:center;color:var(--muted);font-family:'DM Mono',monospace;font-size:15px;">No tokens found</div>`;
}


function saveCustomToken(chainId, t) {
  try {
    let saved = JSON.parse(localStorage.getItem('cb_custom_tokens') || '[]');
    if (!saved.find(x => x.chainId === chainId && x.addr.toLowerCase() === t.addr.toLowerCase())) {
       saved.push({ chainId, ...t, persistedBySwap: true });
       localStorage.setItem('cb_custom_tokens', JSON.stringify(saved));
    }
  } catch(e){}
}
function loadCustomTokens() {
  try {
    let saved = JSON.parse(localStorage.getItem('cb_custom_tokens') || '[]');
    saved.forEach(t => {
       if(!TOKENS[t.chainId]) TOKENS[t.chainId] = [];
       if(!TOKENS[t.chainId].find(x => x.addr.toLowerCase() === t.addr.toLowerCase())) {
          TOKENS[t.chainId].push(t);
       }
    });
  } catch(e){}
}
function removeCustomTok(e, chainId, addr) {
  e.stopPropagation();
  try {
    let saved = JSON.parse(localStorage.getItem('cb_custom_tokens') || '[]');
    saved = saved.filter(x => !(x.chainId === chainId && x.addr.toLowerCase() === addr.toLowerCase()));
    localStorage.setItem('cb_custom_tokens', JSON.stringify(saved));
    if(TOKENS[chainId]) {
      TOKENS[chainId] = TOKENS[chainId].filter(x => x.addr.toLowerCase() !== addr.toLowerCase());
    }
    document.getElementById('tok-search').dispatchEvent(new Event('input'));
  } catch(err){}
}

function pickTok(addr, sym, name, dec, logo, resolvedToken=null){
  const chainId=tokModalFor==='from'?fromChainId:toChainId;
  if(!isValidAddr(addr)&&addr!==NATIVE){ closeTokModal(); return; }
  // Look in list first
  let t=(TOKENS[chainId]||[]).find(x=>x.addr.toLowerCase()===addr.toLowerCase());
  if(!t){
    if(!sym){ closeTokModal(); return; }
    // Custom token - build and store so tokIconEl can use logo
    t={ ...(resolvedToken||{}), addr:addr.toLowerCase(), sym, name:name||sym, dec:Number(dec), cmc:0, logo:logo||null, custom:true, searchOnly:true };
    if(!TOKENS[chainId]) TOKENS[chainId]=[];
    TOKENS[chainId].push(t);
    saveCustomToken(chainId, t);
  } else if(logo && !t.logo) {
    t.logo = logo; // update with logo if now available
  }
  if(t.blockedRisk){setStatus('This token is flagged as a honeypot and cannot be used in Bridge.','err');return;}
  if(t.riskLevel==='high'&&!confirm('This token has high-risk security warnings. Continue only if you trust the exact contract address.')) return;
  if(t.custom&&!t.verified&&!confirm(`This contract is not in the LI.FI verified token list.

${t.addr}

Continue only if you verified the exact address.`)) return;
  if(tokModalFor==='from') fromTok=t; else toTok=t;
  if(tokModalFor==='from'){ _bridgeNeedsApproval=false; _lastBridgeApprove=null; }
  document.getElementById('tok-modal-overlay').classList.remove('open');
  updateTokenUI(); clearRoutes(); scheduleQuote();
  if(wallet){ loadBalsFast(); loadBals(); } // fast: show balance immediately
}

// ═══════════════════════════════════════════
// HISTORY
// ═══════════════════════════════════════════
function saveBridgeHistory(){
  txHistory=txHistory.slice(0,30);
  localStorage.setItem('bridge_history',JSON.stringify(txHistory));
  const meta=document.getElementById('hist-meta');
  if(meta)meta.textContent=`${txHistory.length} transaction${txHistory.length===1?'':'s'}`;
}
function addToHistory(item){
  if(!item||!isValidTxHash(item.hash))return;
  const existing=txHistory.findIndex(entry=>entry.hash===item.hash);
  if(existing>=0)txHistory[existing]={...txHistory[existing],...item};else txHistory.unshift(item);
  saveBridgeHistory();renderHistory();
}
function updateHistoryRecord(hash,patch){
  const item=txHistory.find(entry=>entry.hash===hash||entry.stepHashes?.includes(hash));
  if(!item)return null;
  Object.assign(item,patch||{});saveBridgeHistory();renderHistory();return item;
}
function updateHistoryStatus(hash,status){return updateHistoryRecord(hash,{status});}
function clearHistory(){
  for(const timer of bridgePollTimers.values())clearTimeout(timer);
  bridgePollTimers.clear();txHistory=[];localStorage.removeItem('bridge_history');saveBridgeHistory();renderHistory();
}
function toggleHist(){
  const body=document.getElementById('hist-body'),caret=document.getElementById('hist-caret');
  const open=body.style.display==='none';body.style.display=open?'block':'none';caret.classList.toggle('open',open);
}
function timeAgo(ts){const seconds=Math.floor((Date.now()-Number(ts||Date.now()))/1000);if(seconds<60)return`${seconds}s ago`;if(seconds<3600)return`${Math.floor(seconds/60)}m ago`;if(seconds<86400)return`${Math.floor(seconds/3600)}h ago`;return`${Math.floor(seconds/86400)}d ago`;}
function renderHistory(){
  const list=document.getElementById('hist-list');if(!list)return;
  const isSwap = fromChainId === toChainId;
  const filtered = txHistory.filter(item => isSwap ? item.fromChainId === item.toChainId : item.fromChainId !== item.toChainId);
  const meta = document.getElementById('hist-meta');
  if (meta) meta.textContent = `${filtered.length} transaction${filtered.length === 1 ? '' : 's'}`;
  if(!filtered.length){list.innerHTML=`<div class="hist-empty">No ${isSwap ? 'swap' : 'bridge'} transactions yet</div>`;return;}
  const statusMeta={confirmed:['ok','<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px;"><path d="M20 6L9 17l-5-5"></path></svg><span style="vertical-align:middle;">Completed</span>'],partial:['err','<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px;"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg><span style="vertical-align:middle;">Partial</span>'],refunded:['err','<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px;"><polyline points="9 14 4 9 9 4"></polyline><path d="M20 20v-7a4 4 0 0 0-4-4H4"></path></svg><span style="vertical-align:middle;">Refunded</span>'],failed:['err','<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px;"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg><span style="vertical-align:middle;">Failed</span>'],pending:['pending','<div class="tx-premium-spinner" style="width:10px;height:10px;border-width:2px;margin:0 4px 0 0;box-shadow:none;display:inline-block;vertical-align:middle;"></div><span style="vertical-align:middle;">Pending</span>']};
  list.innerHTML=filtered.map(item=>{
    const [cls,label]=statusMeta[item.status]||statusMeta.pending;
    const source=item.explorer&&isValidTxHash(item.hash)?`<a class="hi-link" href="${esc(item.explorer)}/tx/${esc(item.hash)}" target="_blank" rel="noopener noreferrer">Source tx ?</a>`:'';
    const toNet=NETWORKS.find(net=>net.id===Number(item.toChainId));
    const destination=toNet&&isValidTxHash(item.destinationHash)?`<a class="hi-link" href="${esc(toNet.explorer)}/tx/${esc(item.destinationHash)}" target="_blank" rel="noopener noreferrer">Destination tx ?</a>`:'';
    const lifi=/^https:\/\//i.test(String(item.lifiExplorerLink||''))?`<a class="hi-link" href="${esc(item.lifiExplorerLink)}" target="_blank" rel="noopener noreferrer">LI.FI ↗</a>`:'';
    const check=item.status==='pending'?`<button class="hi-check" onclick="checkBridgeNow('${esc(item.hash)}')">Check status</button>`:'';
    const details=item.message?`<div class="hi-detail">${esc(item.message)}</div>`:'';
    return `<div class="hist-item"><div><div class="hi-pair">${esc(item.sendAmt||'')} ${esc(item.fromSym||'')} → ${esc(item.recvAmt||'')} ${esc(item.toSym||'')}</div><div class="hi-detail">${esc(item.fromNet||'')} → ${esc(item.toNet||'')} via ${esc(item.bridge||'')}</div>${details}</div><div class="hi-right"><div class="hi-status ${cls}">${label}</div><div class="hi-actions">${source}${destination}${lifi}${check}</div><div class="hi-time">${timeAgo(item.ts)}</div></div></div>`;
  }).join('');
}

// ═══════════════════════════════════════════
// COMET ANIMATION - follows bridge card border
// ═══════════════════════════════════════════
function startComets(){
  const canvas=document.getElementById('comet-canvas');
  if(!canvas||window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)return;
  const ctx=canvas.getContext('2d');if(!ctx)return;
  const COLORS=['#38bdf8','#9b51e0','#38bdf8'],TAIL_LEN=110,NUM=3,comets=[];
  let W=0,H=0,lastFrame=0,raf=0;
  function resize(){
    const dpr=Math.min(window.devicePixelRatio||1,1.5);
    W=window.innerWidth;H=window.innerHeight;
    canvas.width=Math.round(W*dpr);canvas.height=Math.round(H*dpr);
    canvas.style.width=W+'px';canvas.style.height=H+'px';
    ctx.setTransform(dpr,0,0,dpr,0,0);
  }
  function getRect(){const wrap=document.querySelector('.bridge-wrap');if(!wrap)return null;const r=wrap.getBoundingClientRect(),pad=6;return{x:r.left-pad,y:r.top-pad,w:r.width+pad*2,h:r.height+pad*2};}
  function perimeter(r){return 2*(r.w+r.h);}
  function perimToXY(r,dist){const p=perimeter(r);dist=((dist%p)+p)%p;if(dist<r.w)return{x:r.x+dist,y:r.y};if(dist<r.w+r.h)return{x:r.x+r.w,y:r.y+(dist-r.w)};if(dist<2*r.w+r.h)return{x:r.x+r.w-(dist-r.w-r.h),y:r.y+r.h};return{x:r.x,y:r.y+r.h-(dist-2*r.w-r.h)};}
  function seed(){const r=getRect();if(!r||comets.length)return;const p=perimeter(r);for(let i=0;i<NUM;i++)comets.push({dist:(p/NUM)*i,speed:1.8+Math.random()*.8,color:COLORS[i],size:2.5+Math.random()});}
  function draw(now){
    raf=requestAnimationFrame(draw);
    if(document.hidden||now-lastFrame<33)return;
    lastFrame=now;ctx.clearRect(0,0,W,H);seed();
    const rect=getRect();if(!rect||comets.length!==NUM)return;
    const p=perimeter(rect);
    for(const cm of comets){
      const head=perimToXY(rect,cm.dist),steps=28,stepLen=TAIL_LEN/steps;
      for(let i=steps;i>=1;i--){const from=perimToXY(rect,cm.dist-i*stepLen),to=perimToXY(rect,cm.dist-(i-1)*stepLen),alpha=1-i/steps;ctx.beginPath();ctx.moveTo(from.x,from.y);ctx.lineTo(to.x,to.y);ctx.strokeStyle=cm.color+Math.round(alpha*200).toString(16).padStart(2,'0');ctx.lineWidth=cm.size*alpha;ctx.shadowBlur=8*alpha;ctx.shadowColor=cm.color;ctx.stroke();}
      ctx.shadowBlur=0;ctx.beginPath();ctx.arc(head.x,head.y,cm.size*2.2,0,Math.PI*2);const gradient=ctx.createRadialGradient(head.x,head.y,0,head.x,head.y,cm.size*2.2);gradient.addColorStop(0,cm.color+'ff');gradient.addColorStop(1,cm.color+'00');ctx.fillStyle=gradient;ctx.shadowBlur=18;ctx.shadowColor=cm.color;ctx.fill();ctx.shadowBlur=0;cm.dist=(cm.dist+cm.speed)%p;
    }
  }
  window.addEventListener('resize',resize,{passive:true});resize();raf=requestAnimationFrame(draw);
  window.addEventListener('pagehide',()=>cancelAnimationFrame(raf),{once:true});
}

window.addEventListener('load',init);

function toggleTheme(){
  const d=document.body.classList.contains('dark');
  document.body.classList.toggle('dark',!d);
  document.body.classList.toggle('light',d);
  localStorage.setItem('coinblog-theme',d?'light':'dark');
  updateThemeIcon();
}
function updateThemeIcon(){
  const d=document.body.classList.contains('dark');
  const el=document.getElementById('theme-ico');if(!el)return;
  el.innerHTML=d
    ?'<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'
    :'<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';
}
function toggleAnalyticsDD(e){
  e.stopPropagation();
  document.getElementById('analytics-dd')?.classList.toggle('open');
}
document.addEventListener('click',()=>document.getElementById('analytics-dd')?.classList.remove('open'));
document.addEventListener('keydown',event=>{
  if(event.key!=='Escape')return;
  document.getElementById('chain-modal-overlay')?.classList.remove('open');
  document.getElementById('tok-modal-overlay')?.classList.remove('open');
  document.getElementById('wpm-overlay')?.classList.add('hidden');
  document.getElementById('w-menu')?.classList.remove('open');
});
(function(){
  const s=localStorage.getItem('coinblog-theme')||'dark';
  document.body.className=s;
  updateThemeIcon();
})();
