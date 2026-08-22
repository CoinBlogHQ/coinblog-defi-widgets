// NETWORKS
// ═══════════════════════════════════════════
export const NETWORKS = [{
  id: 1,
  name: 'Ethereum',
  sym: 'ETH',
  decimals: 18,
  icon: 'https://s2.coinmarketcap.com/static/img/coins/64x64/1027.png',
  explorer: 'https://etherscan.io',
  rpc: 'https://eth.llamarpc.com',
  currency: 'ETH'
}, {
  id: 8453,
  name: 'Base',
  sym: 'ETH',
  decimals: 18,
  icon: 'https://s2.coinmarketcap.com/static/img/coins/64x64/27716.png',
  explorer: 'https://basescan.org',
  rpc: 'https://mainnet.base.org',
  currency: 'ETH'
}, {
  id: 42161,
  name: 'Arbitrum',
  sym: 'ETH',
  decimals: 18,
  icon: 'https://s2.coinmarketcap.com/static/img/coins/64x64/11841.png',
  explorer: 'https://arbiscan.io',
  rpc: 'https://arb1.arbitrum.io/rpc',
  currency: 'ETH'
}, {
  id: 10,
  name: 'Optimism',
  sym: 'ETH',
  decimals: 18,
  icon: 'https://s2.coinmarketcap.com/static/img/coins/64x64/11840.png',
  explorer: 'https://optimistic.etherscan.io',
  rpc: 'https://mainnet.optimism.io',
  currency: 'ETH'
}, {
  id: 137,
  name: 'Polygon',
  sym: 'POL',
  decimals: 18,
  icon: 'https://s2.coinmarketcap.com/static/img/coins/64x64/28321.png',
  explorer: 'https://polygonscan.com',
  rpc: 'https://polygon-rpc.com',
  currency: 'POL'
}, {
  id: 56,
  name: 'BSC',
  sym: 'BNB',
  decimals: 18,
  icon: 'https://s2.coinmarketcap.com/static/img/coins/64x64/1839.png',
  explorer: 'https://bscscan.com',
  rpc: 'https://bsc-dataseed.binance.org',
  currency: 'BNB'
}, {
  id: 43114,
  name: 'Avalanche',
  sym: 'AVAX',
  decimals: 18,
  icon: 'https://s2.coinmarketcap.com/static/img/coins/64x64/5805.png',
  explorer: 'https://snowtrace.io',
  rpc: 'https://api.avax.network/ext/bc/C/rpc',
  currency: 'AVAX'
}, {
  id: 130,
  name: 'Unichain',
  sym: 'ETH',
  decimals: 18,
  icon: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/unichain.svg',
  explorer: 'https://unichain.blockscout.com',
  rpc: 'https://mainnet.unichain.org',
  currency: 'ETH'
}, {
  id: 4663,
  name: 'Robinhood Chain',
  sym: 'ETH',
  decimals: 18,
  icon: '/theme/assets/robinhood-chain-icon.svg',
  explorer: 'https://robinhoodchain.blockscout.com',
  rpc: 'https://rpc.mainnet.chain.robinhood.com',
  currency: 'ETH'
}, {
  id: 81457,
  name: 'Blast',
  sym: 'ETH',
  decimals: 18,
  icon: 'https://s2.coinmarketcap.com/static/img/coins/64x64/28480.png',
  explorer: 'https://blastscan.io',
  rpc: 'https://rpc.blast.io',
  currency: 'ETH'
}, {
  id: 534352,
  name: 'Scroll',
  sym: 'ETH',
  decimals: 18,
  icon: 'https://s2.coinmarketcap.com/static/img/coins/64x64/26998.png',
  explorer: 'https://scrollscan.com',
  rpc: 'https://rpc.scroll.io',
  currency: 'ETH'
}, {
  id: 59144,
  name: 'Linea',
  sym: 'ETH',
  decimals: 18,
  icon: 'https://s2.coinmarketcap.com/static/img/coins/64x64/27657.png',
  explorer: 'https://lineascan.build',
  rpc: 'https://rpc.linea.build',
  currency: 'ETH'
}, {
  id: 146,
  name: 'Sonic',
  sym: 'S',
  decimals: 18,
  icon: 'https://s2.coinmarketcap.com/static/img/coins/64x64/32684.png',
  explorer: 'https://sonicscan.org',
  rpc: 'https://rpc.soniclabs.com',
  currency: 'S'
}, {
  id: 5000,
  name: 'Mantle',
  sym: 'MNT',
  decimals: 18,
  icon: 'https://s2.coinmarketcap.com/static/img/coins/64x64/27075.png',
  explorer: 'https://mantlescan.xyz',
  rpc: 'https://rpc.mantle.xyz',
  currency: 'MNT'
}, {
  id: 34443,
  name: 'Mode',
  sym: 'ETH',
  decimals: 18,
  icon: 'https://s2.coinmarketcap.com/static/img/coins/64x64/29136.png',
  explorer: 'https://explorer.mode.network',
  rpc: 'https://mainnet.mode.network',
  currency: 'ETH'
}];
export let WC_OPTIONAL_CHAINS = [];
export let WC_RPC_MAP = {};
export const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

// Bridge and exchange logos are taken from the current LI.FI toolDetails response.

// Tokens per chain (native + major stables/ETH variants)
export const TOKENS = {
  1: [{
    sym: 'ETH',
    name: 'Ethereum',
    addr: NATIVE,
    dec: 18,
    cmc: 1027
  }, {
    sym: 'USDC',
    name: 'USD Coin',
    addr: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    dec: 6,
    cmc: 3408
  }, {
    sym: 'USDT',
    name: 'Tether USD',
    addr: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    dec: 6,
    cmc: 825
  }, {
    sym: 'WBTC',
    name: 'Wrapped Bitcoin',
    addr: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
    dec: 8,
    cmc: 3717
  }, {
    sym: 'DAI',
    name: 'Dai Stablecoin',
    addr: '0x6b175474e89094c44da98b954eedeac495271d0f',
    dec: 18,
    cmc: 4943
  }, {
    sym: 'WETH',
    name: 'Wrapped ETH',
    addr: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    dec: 18,
    cmc: 2396
  }],
  8453: [{
    sym: 'ETH',
    name: 'Ethereum',
    addr: NATIVE,
    dec: 18,
    cmc: 1027
  }, {
    sym: 'USDC',
    name: 'USD Coin',
    addr: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    dec: 6,
    cmc: 3408
  }, {
    sym: 'WETH',
    name: 'Wrapped ETH',
    addr: '0x4200000000000000000000000000000000000006',
    dec: 18,
    cmc: 2396
  }, {
    sym: 'DAI',
    name: 'Dai Stablecoin',
    addr: '0x50c5725949a6f0c72e6c4a641f24049a917db0cb',
    dec: 18,
    cmc: 4943
  }],
  42161: [{
    sym: 'ETH',
    name: 'Ethereum',
    addr: NATIVE,
    dec: 18,
    cmc: 1027
  }, {
    sym: 'USDC',
    name: 'USD Coin',
    addr: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    dec: 6,
    cmc: 3408
  }, {
    sym: 'USDT',
    name: 'Tether USD',
    addr: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
    dec: 6,
    cmc: 825
  }, {
    sym: 'WETH',
    name: 'Wrapped ETH',
    addr: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
    dec: 18,
    cmc: 2396
  }, {
    sym: 'WBTC',
    name: 'Wrapped Bitcoin',
    addr: '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f',
    dec: 8,
    cmc: 3717
  }, {
    sym: 'ARB',
    name: 'Arbitrum',
    addr: '0x912ce59144191c1204e64559fe8253a0e49e6548',
    dec: 18,
    cmc: 11841
  }],
  10: [{
    sym: 'ETH',
    name: 'Ethereum',
    addr: NATIVE,
    dec: 18,
    cmc: 1027
  }, {
    sym: 'USDC',
    name: 'USD Coin',
    addr: '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
    dec: 6,
    cmc: 3408
  }, {
    sym: 'USDT',
    name: 'Tether USD',
    addr: '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58',
    dec: 6,
    cmc: 825
  }, {
    sym: 'WETH',
    name: 'Wrapped ETH',
    addr: '0x4200000000000000000000000000000000000006',
    dec: 18,
    cmc: 2396
  }, {
    sym: 'OP',
    name: 'Optimism',
    addr: '0x4200000000000000000000000000000000000042',
    dec: 18,
    cmc: 11840
  }],
  137: [{
    sym: 'POL',
    name: 'Polygon',
    addr: NATIVE,
    dec: 18,
    cmc: 28321
  }, {
    sym: 'USDC',
    name: 'USD Coin',
    addr: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
    dec: 6,
    cmc: 3408
  }, {
    sym: 'USDC.e',
    name: 'Bridged USD Coin',
    addr: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
    dec: 6,
    cmc: 3408
  }, {
    sym: 'USDT',
    name: 'Tether USD',
    addr: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
    dec: 6,
    cmc: 825
  }, {
    sym: 'WETH',
    name: 'Wrapped ETH',
    addr: '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619',
    dec: 18,
    cmc: 2396
  }, {
    sym: 'WBTC',
    name: 'Wrapped Bitcoin',
    addr: '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6',
    dec: 8,
    cmc: 3717
  }],
  56: [{
    sym: 'BNB',
    name: 'BNB',
    addr: NATIVE,
    dec: 18,
    cmc: 1839
  }, {
    sym: 'USDC',
    name: 'USD Coin',
    addr: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
    dec: 18,
    cmc: 3408
  }, {
    sym: 'USDT',
    name: 'Tether USD',
    addr: '0x55d398326f99059ff775485246999027b3197955',
    dec: 18,
    cmc: 825
  }, {
    sym: 'ETH',
    name: 'ETH (BEP-20)',
    addr: '0x2170ed0880ac9a755fd29b2688956bd959f933f8',
    dec: 18,
    cmc: 1027
  }]
};
// Avalanche
TOKENS[43114] = [{
  sym: 'AVAX',
  name: 'Avalanche',
  addr: NATIVE,
  dec: 18,
  cmc: 5805
}, {
  sym: 'USDC',
  name: 'USD Coin',
  addr: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e',
  dec: 6,
  cmc: 3408
}, {
  sym: 'USDT',
  name: 'Tether USD',
  addr: '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7',
  dec: 6,
  cmc: 825
}, {
  sym: 'WETH',
  name: 'Wrapped ETH',
  addr: '0x49d5c2bdffac6ce2bfdb6640f4f80f226bc10bab',
  dec: 18,
  cmc: 2396
}, {
  sym: 'WBTC',
  name: 'Wrapped Bitcoin',
  addr: '0x50b7545627a5162f82a992c33b87adc75187b218',
  dec: 8,
  cmc: 3717
}];
// Unichain
TOKENS[130] = [{
  sym: 'ETH',
  name: 'Ethereum',
  addr: NATIVE,
  dec: 18,
  cmc: 1027
}, {
  sym: 'WETH',
  name: 'Wrapped ETH',
  addr: '0x4200000000000000000000000000000000000006',
  dec: 18,
  cmc: 2396
}, {
  sym: 'USDC',
  name: 'USD Coin',
  addr: '0x078d782b760474a361dda0af3839290b0ef57ad6',
  dec: 6,
  cmc: 3408
}, {
  sym: 'USDT0',
  name: 'Tether USD0',
  addr: '0x9151434b16b9763660705744891fa906f660ecc5',
  dec: 6,
  cmc: 825
}, {
  sym: 'UNI',
  name: 'Uniswap',
  addr: '0x8f187aa05619a017077f5308904739877ce9ea21',
  dec: 18,
  cmc: 7083
}, {
  sym: 'wBTC',
  name: 'Wrapped Bitcoin',
  addr: '0x0555e30da8f98308edb960aa94c0db47230d2b9c',
  dec: 8,
  cmc: 3717
}];
// Robinhood Chain mainnet
TOKENS[4663] = [{
  sym: 'ETH',
  name: 'Ethereum',
  addr: NATIVE,
  dec: 18,
  cmc: 1027
}, {
  sym: 'WETH',
  name: 'Wrapped ETH',
  addr: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  dec: 18,
  cmc: 2396
}, {
  sym: 'USDG',
  name: 'USDG',
  addr: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  dec: 6,
  cmc: 33793
}];
// Blast
TOKENS[81457] = [{
  sym: 'ETH',
  name: 'Ethereum',
  addr: NATIVE,
  dec: 18,
  cmc: 1027
}, {
  sym: 'USDB',
  name: 'USDB',
  addr: '0x4300000000000000000000000000000000000003',
  dec: 18,
  cmc: 0
}, {
  sym: 'WETH',
  name: 'Wrapped ETH',
  addr: '0x4300000000000000000000000000000000000004',
  dec: 18,
  cmc: 2396
}, {
  sym: 'BLAST',
  name: 'Blast',
  addr: '0xb1a5700fa2358173fe465e6ea4ff52e36e88e2ad',
  dec: 18,
  cmc: 29743
}];
// Scroll
TOKENS[534352] = [{
  sym: 'ETH',
  name: 'Ethereum',
  addr: NATIVE,
  dec: 18,
  cmc: 1027
}, {
  sym: 'USDC',
  name: 'USD Coin',
  addr: '0x06efdbff2a14a7c8e15944d1f4a48f9f95f663a4',
  dec: 6,
  cmc: 3408
}, {
  sym: 'USDT',
  name: 'Tether USD',
  addr: '0xf55bec9cafdbe8730f096aa55dad6d22d44099df',
  dec: 6,
  cmc: 825
}, {
  sym: 'WETH',
  name: 'Wrapped ETH',
  addr: '0x5300000000000000000000000000000000000004',
  dec: 18,
  cmc: 2396
}, {
  sym: 'WBTC',
  name: 'Wrapped Bitcoin',
  addr: '0x3c1bca5a656e69edcd0d4e36bebb3fcdaca60cf1',
  dec: 8,
  cmc: 3717
}];
// Linea
TOKENS[59144] = [{
  sym: 'ETH',
  name: 'Ethereum',
  addr: NATIVE,
  dec: 18,
  cmc: 1027
}, {
  sym: 'USDC',
  name: 'USD Coin',
  addr: '0x176211869ca2b568f2a7d4ee941e073a821ee1ff',
  dec: 6,
  cmc: 3408
}, {
  sym: 'USDT',
  name: 'Tether USD',
  addr: '0xa219439258ca9da29e9cc4ce5596924745e12b93',
  dec: 6,
  cmc: 825
}, {
  sym: 'WETH',
  name: 'Wrapped ETH',
  addr: '0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34e',
  dec: 18,
  cmc: 2396
}, {
  sym: 'WBTC',
  name: 'Wrapped Bitcoin',
  addr: '0x3aab2285ddcddad8edf438c1bab47e1a9d05a9b4',
  dec: 8,
  cmc: 3717
}];
// Sonic
TOKENS[146] = [{
  sym: 'S',
  name: 'Sonic',
  addr: NATIVE,
  dec: 18,
  cmc: 32684
}, {
  sym: 'USDC',
  name: 'USD Coin',
  addr: '0x29219dd400f2bf60e5a23d13be72b486d4038894',
  dec: 6,
  cmc: 3408
}, {
  sym: 'USDT',
  name: 'Tether USD',
  addr: '0x6047828dc181963ba44974c3e27b36a6b8b35ceb',
  dec: 6,
  cmc: 825
}, {
  sym: 'WETH',
  name: 'Wrapped ETH',
  addr: '0x50c42deacd8fc9773493ed674b675be577f2634b',
  dec: 18,
  cmc: 2396
}];
// Mantle
TOKENS[5000] = [{
  sym: 'MNT',
  name: 'Mantle',
  addr: NATIVE,
  dec: 18,
  cmc: 27075
}, {
  sym: 'USDC',
  name: 'USD Coin',
  addr: '0x09bc4e0d864854c6afb6eb9a9cdf58ac190d0df5',
  dec: 6,
  cmc: 3408
}, {
  sym: 'USDT',
  name: 'Tether USD',
  addr: '0x201eba5cc46d216ce6dc03f6a759e8e766e956ae',
  dec: 6,
  cmc: 825
}, {
  sym: 'WETH',
  name: 'Wrapped ETH',
  addr: '0xdeaddeaddeaddeaddeaddeaddeaddeaddead1111',
  dec: 18,
  cmc: 2396
}, {
  sym: 'WMNT',
  name: 'Wrapped Mantle',
  addr: '0x78c1b0c915c4faa5fffa6cabf0219da63d7f4cb8',
  dec: 18,
  cmc: 27075
}];
// Mode
TOKENS[34443] = [{
  sym: 'ETH',
  name: 'Ethereum',
  addr: NATIVE,
  dec: 18,
  cmc: 1027
}, {
  sym: 'USDC',
  name: 'USD Coin',
  addr: '0xd988097fb8612cc24eec14542bc03424c656005f',
  dec: 6,
  cmc: 3408
}, {
  sym: 'USDT',
  name: 'Tether USD',
  addr: '0xf0f161fda2712db8b566946122a5af183995e2ed',
  dec: 6,
  cmc: 825
}, {
  sym: 'WETH',
  name: 'Wrapped ETH',
  addr: '0x4200000000000000000000000000000000000006',
  dec: 18,
  cmc: 2396
}];

// ═══════════════════════════════════════════
export function setWCOptionalChains(v) {
  WC_OPTIONAL_CHAINS = v;
}
export function setWCRpcMap(v) {
  WC_RPC_MAP = v;
}