import { state } from './core/state.js';
import * as utils from './core/utils.js';
import * as api from './aggregators/api.js';
import * as goplus from './security/goplus.js';
import * as networks from './core/networks.js';
import * as icons from './core/icons.js';
import * as wallet from './core/wallet.js';
import * as balances from './execution/balances.js';
import * as renderer from './ui/renderer.js';
import * as transaction from './execution/transaction.js';
import * as tracker from './execution/tracker.js';
import * as modals from './ui/modals.js';
import * as tokens from './core/tokens.js';

// Expose globally for HTML onclick handlers
Object.assign(window, utils, api, goplus, networks, icons, wallet, balances, renderer, transaction, tracker, modals, tokens);
window.exchangeState = state;