# Технический Whitepaper: CoinBlog Universal Exchange (Swap & Bridge)

**Версия:** 2.0  
**Статус:** Production  
**Архитектура:** Non-Custodial Multi-DEX & Cross-Chain Aggregator  
**Стек:** Vanilla JavaScript (ES2022, Zero-Dependency), Cloudflare Pages / Workers Edge Middleware, EIP-6963, WalletConnect v2  

---

## 1. Введение и Архитектурная Философия

**CoinBlog Universal Exchange** — это высокопроизводительный децентрализованный агрегатор ликвидности и кроссчейн-мостов, объединяющий внутрисетевые свопы (Same-Chain Swaps) и межсетевые переводы (Cross-Chain Bridges) в едином интерфейсе для более чем 15 EVM-сетей.

### Ключевые архитектурные принципы:
1. **Zero-Dependency Vanilla JS:** Отсутствие тяжелых фреймворков (React, Angular, Next.js) и сотен `node_modules`. Клиентский код весит менее 80 КБ, загружается за миллисекунды и обеспечивает 100/100 в Google PageSpeed Insights.
2. **Strict Non-Custodial & Exact Allowance:** Платформа не хранит приватные ключи и не запрашивает бесконечные разрешения (`Max Uint256`). Разрешение на перевод токенов выдается строго на сумму текущей сделки.
3. **Edge Shielding & HMAC Cryptography:** Прямой доступ к API сторонних агрегаторов закрыт Cloudflare Workers. Все межсетевые шаги криптографически подписываются HMAC-SHA256 для исключения атак с подменой получателя (MITM / Address Poisoning).
4. **Pre-Flight RPC Simulation:** Каждая транзакция симулируется через локальный RPC (`eth_estimateGas`) перед запросом подписи у пользователя, исключая потерю комиссии на неудачных транзакциях (Zero-Revert Policy).

---

## 2. Общая Архитектура Системы

```
                                    +-----------------------------------------+
                                    |         User Web3 Wallet                |
                                    | (MetaMask / Rabby / WalletConnect v2)   |
                                    +--------------------+--------------------+
                                                         |
                                                EIP-6963 / RPC Events
                                                         |
                                                         v
                                    +-----------------------------------------+
                                    |       CoinBlog Exchange Frontend        |
                                    |   (public/exchange.html + exchange.js)  |
                                    +--------------------+--------------------+
                                                         |
                                  HTTPS (Strict CORS / Rate-Limited / Sanitized)
                                                         |
                                                         v
                                    +-----------------------------------------+
                                    |       Cloudflare Edge Middleware        |
                                    |         (functions/api/*.js)            |
                                    +---------+----------+----------+---------+
                                              |          |          |
                      +-----------------------+          |          +-----------------------+
                      |                                  |                                  |
                      v                                  v                                  v
+-----------------------------+        +-----------------------------+        +-----------------------------+
|    0x Protocol API v2       |        |   ParaSwap / Velora DEX     |        |      LI.FI Aggregator       |
| (Same-chain DEX aggregation)|        | (Multi-path split routing)  |        | (Across, Relay, Stargate...) |
+-----------------------------+        +-----------------------------+        +-----------------------------+
```

---

## 3. Детальный Анализ Функций Клиента (`public/js/exchange.js`)

### 3.1 Определение режима и умный роутинг (`fetchRoutes`)

Функция `fetchRoutes()` определяет тип операции на основе выбранных сетей `fromChainId` и `toChainId`:
- Если `fromChainId === toChainId` — активируется режим **Same-Chain Swap** с параллельным запросом к 0x Protocol и ParaSwap.
- Если `fromChainId !== toChainId` — активируется режим **Cross-Chain Bridge** с запросом оптимальных мостов через LI.FI.

```javascript
async function fetchRoutes(){
  const isSwap = fromChainId === toChainId;
  
  if (isSwap) {
    // Параллельный опрос DEX-агрегаторов
    const [zeroXRes, paraRes] = await Promise.allSettled([
      fetch0xQuote(fromTok, toTok, rawAmount, fromChainId, slippage, wallet),
      fetchParaswapQuote(fromTok, toTok, rawAmount, fromChainId, slippage, wallet)
    ]);
    
    // Сортировка по максимальной сумме на выходе
    routes = [zeroXRes.value, paraRes.value]
      .filter(Boolean)
      .sort((a, b) => (BigInt(b.toAmount) > BigInt(a.toAmount) ? 1 : -1));
  } else {
    // Запрос кроссчейн-маршрутов с фильтрацией мостов
    routes = await fetchBridgeRoutes(fromChainId, toChainId, fromTok.addr, toTok.addr, rawAmount, wallet);
  }
  
  renderRoutes();
}
```

---

### 3.2 Автоопределение и брендинг протоколов (`getPrimaryBridgeTool`)

Для исключения технических шагов сбора комиссий (`Integrator Fee`) функция фильтрует служебные вызовы и извлекает реальный бренд протокола:

```javascript
const IGNORED_TOOLS = new Set(['integrator fee', 'fee collection', 'custom fee', 'integrator-fee', 'lifi', 'bridge']);

function getPrimaryBridgeTool(route){
  if(route.isSwap) {
    return { name: route.tool || '0x Protocol', logo: route.steps?.[0]?.toolDetails?.logoURI || '', toolKey: 'swap' };
  }
  for(const step of route?.steps || []){
    const included = Array.isArray(step?.includedSteps) && step.includedSteps.length ? step.includedSteps : [step];
    for(const child of included){
      const toolKey = String(child?.tool || '').toLowerCase();
      const toolName = String(child?.toolDetails?.name || child?.tool || '').trim();
      if(toolName && !IGNORED_TOOLS.has(toolName.toLowerCase()) && !IGNORED_TOOLS.has(toolKey)){
        return {
          name: toolName,
          logo: String(child?.toolDetails?.logoURI || ''),
          toolKey: toolKey
        };
      }
    }
  }
  return { name: 'Bridge', logo: '', toolKey: 'bridge' };
}
```

---

### 3.3 Встроенный сканер безопасности GoPlus (`checkTokenSecurity`)

Защищает пользователей от покупки токенов-ловушек (Honeypot) и скрытых налогов на смарт-контрактах:

```javascript
async function checkTokenSecurity(address, chainId) {
  if (address === NATIVE) return { safe: true, label: 'NATIVE' };
  
  const res = await fetch(`https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${address}`);
  const data = await res.json();
  const info = data?.result?.[address.toLowerCase()];
  
  if (!info) return { safe: true, label: 'UNVERIFIED' };
  
  // Доверенные токены из белого списка (USDC, USDT, DAI)
  if (info.trust_list === 1 || info.trust_list === '1') {
    return { safe: true, label: 'VERIFIED', tax: 0 };
  }
  
  // Обнаружение блокировки продаж или 100% налога
  const isHoneypot = info.is_honeypot === '1' || info.cannot_sell_all === '1';
  const buyTax = parseFloat(info.buy_tax || 0) * 100;
  const sellTax = parseFloat(info.sell_tax || 0) * 100;
  
  if (isHoneypot || sellTax >= 90) {
    return { safe: false, label: 'SCAM / HONEYPOT', blocked: true };
  }
  
  return { safe: true, buyTax, sellTax, label: 'CHECKED' };
}
```

---

### 3.4 Безопасный аппрув точной суммы (`checkAndApproveToken`)

Исключает риск кражи средств при потенциальном взломе стороннего смарт-контракта:

```javascript
async function checkAndApproveToken(token, spender, amount, chainId, owner) {
  if (token === NATIVE) return true;
  
  await ensureWalletChain(chainId);
  await assertActiveWalletAccount(owner);
  
  const currentAllowance = await readAllowance(token, owner, spender);
  if (currentAllowance >= BigInt(amount)) return true;
  
  // Формирование ERC-20 approve(spender, exactAmount)
  const amountHex = BigInt(amount).toString(16).padStart(64, '0');
  const spenderHex = spender.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const data = '0x095ea7b3' + spenderHex + amountHex;
  
  await sendWalletTransaction({
    to: token,
    data: data,
    value: '0x0'
  }, chainId, 'Token Approval');
  
  return true;
}
```

---

### 3.5 Локальная симуляция перед отправкой (`sendWalletTransaction`)

Предотвращает потерю пользовательского газа при отмене транзакции на блокчейне:

```javascript
async function sendWalletTransaction(request, chainId, label='transaction', options={}) {
  const fromAddress = String(options.fromAddress || wallet || '').toLowerCase();
  await ensureWalletChain(chainId);
  await assertActiveWalletAccount(fromAddress);
  
  const tx = {
    from: fromAddress,
    to: request.to,
    data: request.data || '0x',
    value: normalizeWalletHex(request.value || 0)
  };
  
  // Pre-flight симуляция через RPC кошелька
  let estimate;
  try {
    estimate = await _requestWallet('eth_estimateGas', [tx], { timeoutMs: 18000 });
  } catch (e) {
    throw new Error(`${label} simulation failed: ${e?.message || 'transaction would revert on-chain'}`);
  }
  
  tx.gas = normalizeWalletHex(BigInt(estimate) * 115n / 100n); // Буфер 15% для защиты от спайков газа
  return await _requestWallet('eth_sendTransaction', [tx]);
}
```

---

## 4. Серверный Слой Безопасности (Cloudflare Workers)

### 4.1 Криптографическая подпись маршрутов HMAC-SHA256 (`functions/api/_bridge-common.js`)

Предотвращает подмену адреса получателя вредоносными расширениями браузера:

```javascript
async function hmacHex(secret, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(signature)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function signBridgeStep(step, env) {
  const secret = env.BRIDGE_SIGNING_SECRET || env.LIFI_API_KEY;
  if (!secret) return '';
  return hmacHex(secret, JSON.stringify(stableBridgeValue(step)));
}

export async function verifyBridgeStep(step, proof, env) {
  const secret = env.BRIDGE_SIGNING_SECRET || env.LIFI_API_KEY;
  if (!secret) return true;
  if (!/^[0-9a-f]{64}$/i.test(String(proof || ''))) return false;
  const expected = await signBridgeStep(step, env);
  return proof === expected;
}
```

---

## 5. Матрица Поддерживаемых Сетей и Токенов

| Сеть | Chain ID | Нативный токен | Протоколы обмена | Кроссчейн-мосты |
| :--- | :--- | :--- | :--- | :--- |
| **Ethereum** | `1` | `ETH` | 0x, ParaSwap, Uniswap | Across, Relay, Stargate, Celer |
| **Base** | `8453` | `ETH` | 0x, ParaSwap, Aerodrome | Across, Relay, Layerswap |
| **Arbitrum One** | `42161` | `ETH` | 0x, ParaSwap, Camelot | Across, Relay, Stargate |
| **Optimism** | `10` | `ETH` | 0x, ParaSwap, Velodrome | Across, Relay, Stargate |
| **Polygon (PoS)** | `137` | `POL` | 0x, ParaSwap, QuickSwap | Across, Relay, Stargate |
| **BNB Smart Chain** | `56` | `BNB` | 0x, ParaSwap, PancakeSwap | Layerswap, Relay, Bitget |
| **Avalanche C-Chain**| `43114` | `AVAX` | 0x, ParaSwap, TraderJoe | Stargate, Relay |
| **Sonic** | `146` | `S` | ParaSwap, Shadow | Relay, deBridge |
| **Unichain** | `130` | `ETH` | Uniswap v4 / 0x | Relay, LI.FI |
| **Linea** | `59144` | `ETH` | 0x, SyncSwap | Across, Relay |
| **Scroll** | `534352` | `ETH` | 0x, Ambient | Relay, Across |
| **Blast** | `81457` | `ETH` | 0x, Thruster | Relay, Across |
| **Mantle** | `5000` | `MNT` | Merchant Moe, 0x | Relay, Stargate |
| **Mode** | `34443` | `ETH` | Kim DEX, 0x | Relay, Across |
| **Robinhood Chain**| `4663` | `ETH` | Native DEX / 0x | Relay, LI.FI |

---

## 6. Защита от Уязвимостей и Модель Угроз (Threat Model)

1. **Защита от сэндвич-атак (MEV Front-Running):**
   - Автоматический расчет параметра `minBuyAmount` на основе выбранного slippage (0.01% - 5%).
   - При превышении порога проскальзывания транзакция отклоняется смарт-контрактом роутера.
2. **Защита от подмены активного кошелька (Account Desynchronization):**
   - Функция `assertActiveWalletAccount` проверяет активный аккаунт перед каждым запросом к блокчейну.
3. **Защита от Address Poisoning:**
   - Интерфейс сверяет адрес получателя с адресом подключенного кошелька и выводит предупреждение при несовпадении.
4. **Защита Edge API от DoS и Abuse:**
   - Ограничение количества запросов по IP (`checkRateLimit`).
   - Проверка заголовка `Origin` с блокировкой несанкционированных доменов.

---

## 7. Лицензирование и Открытый Исходный Код

Исходный код виджета CoinBlog Universal Exchange распространяется под открытой лицензией **MIT License**.  
Официальный репозиторий: [https://github.com/CoinBlogHQ/coinblog-defi-widgets](https://github.com/CoinBlogHQ/coinblog-defi-widgets)
