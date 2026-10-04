/*
 * Mock browser wallet for local e2e tests. Self-contained, plain ES2017, no imports.
 * Paste it as the body of an `evaluate` call AFTER the page loaded (re-injecting is safe).
 *
 * What it does
 *  - Installs window.ethereum (EIP-1193) and announces itself via EIP-6963 (immediately and on every
 *    'eip6963:requestProvider'): name 'Mock Wallet', rdns 'test.mock.wallet'. isMetaMask is false, no `providers`.
 *  - Forwards JSON-RPC to the local hardhat node http://127.0.0.1:8545 (unlocked accounts), except:
 *      eth_requestAccounts / eth_accounts            -> [accounts[accountIndex]] (lower-case)
 *      eth_chainId / net_version                     -> the mock's current chain (default 0x7a69)
 *      wallet_switchEthereumChain({chainId})         -> known chain: switch + 'chainChanged', null; else error 4902
 *      wallet_addEthereumChain(cfg)                  -> recorded in addedChains, becomes known, switch + 'chainChanged', null
 *      eth_sendTransaction / eth_signTransaction     -> error -32603 unless the current chain is 0x7a69; otherwise forwarded
 *                                                       with `from` forced to the current account
 *  - Options, read from window.__mockWalletOptions at injection time: { accountIndex: 0, chainId: '0x7a69', knownChains: ['0x7a69'], arcStyleFailures: false }.
 *    arcStyleFailures: a transaction that reverts when mined is answered with its hash (like Arc) instead of an error.
 *    window.__mockWallet.beforeSend = async (tx) => {...} runs once before the next eth_sendTransaction is forwarded.
 *  - Test controls on window.__mockWallet:
 *      accountIndex, chainId, knownChains, addedChains, calls ([{method, params, t}]), accounts (cached list),
 *      rejectNext = { code: 4001, message: 'User rejected the request.', methods: ['eth_sendTransaction','eth_requestAccounts'] }
 *        -> rejects the next matching request once (any field optional; `true` means all defaults),
 *      setAccountIndex(i) -> emits 'accountsChanged', setChainId(hex) -> emits 'chainChanged', emit(event, payload).
 *  - Errors are Error objects with numeric .code (and .data, e.g. hardhat revert data, passed through unchanged).
 *  - Injecting twice: the second run disposes the first (listener removed), keeps the page's event listeners, and the
 *    old provider object keeps working by forwarding to the new one. State starts fresh from the options.
 */
(() => {
  'use strict';
  var RPC = 'http://127.0.0.1:8545';
  var LOCAL = '0x7a69';
  var DEFAULT_REJECT_METHODS = ['eth_sendTransaction', 'eth_requestAccounts'];
  var prev = window.__mockWallet;
  var opts = window.__mockWalletOptions || {};

  // Re-injection: dispose the previous instance first (removes its EIP-6963 listener), keep what the page registered.
  var carried = null;
  if (prev && typeof prev.__dispose === 'function') {
    try { carried = prev.__dispose(); } catch (e) { carried = null; }
  }

  function hex(c) {
    if (typeof c === 'number') return '0x' + c.toString(16);
    var s = String(c).toLowerCase();
    var n = parseInt(s, s.indexOf('0x') === 0 ? 16 : 10);
    return isNaN(n) ? s : '0x' + n.toString(16);
  }
  function rpcError(code, message, data) {
    var e = new Error(message);
    e.code = code;
    if (data !== undefined) e.data = data;
    return e;
  }
  function makeUuid() {
    var c = window.crypto;
    if (c && typeof c.randomUUID === 'function') { try { return c.randomUUID(); } catch (e) { /* fall through */ } }
    var b = new Uint8Array(16);
    for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  var mw = {
    accountIndex: Number.isInteger(Number(opts.accountIndex)) ? Number(opts.accountIndex) : 0,
    chainId: opts.chainId !== undefined ? hex(opts.chainId) : LOCAL,
    knownChains: (Array.isArray(opts.knownChains) ? opts.knownChains : [LOCAL]).map(hex),
    addedChains: [],
    calls: [],
    rejectNext: null,
    // Arc mines a failing transaction and returns its hash; Hardhat reports the revert as an error. With arcStyleFailures
    // the mock hands back the hash from that error (error.data.txHash) so the page sees a mined transaction with status 0x0.
    arcStyleFailures: !!opts.arcStyleFailures,
    // beforeSend: async function(tx) run once, right before the next eth_sendTransaction is forwarded (to race another payment).
    beforeSend: null,
    // swallowNextSend: true -> the next eth_sendTransaction answers with a made-up hash and nothing is sent (a transaction that never confirms).
    swallowNextSend: false,
    // flipAccountsOnce: true -> the next eth_accounts call answers with a different account (the user switched accounts in the wallet).
    flipAccountsOnce: false,
    accounts: null,
    setAccountIndex: function (i) {
      mw.accountIndex = i;
      return loadAccounts().then(function (list) {
        emit('accountsChanged', list[i] ? [list[i]] : []);
        return list[i] || null;
      });
    },
    setChainId: function (c) {
      mw.chainId = hex(c);
      emit('chainChanged', mw.chainId);
      return mw.chainId;
    },
    emit: function (event, payload) { return emit(event, payload); }
  };

  // ---- event emitter (listener map is shared with the previous instance on re-injection; mutated in place only)
  var listeners = carried ? carried.listeners : {};
  function emit(event, payload) {
    (listeners[event] || []).slice().forEach(function (fn) {
      try { fn(payload); } catch (e) { console.error('mock wallet: "' + event + '" listener threw', e); }
    });
    return true;
  }
  function on(event, fn) {
    (listeners[event] = listeners[event] || []).push(fn);
    return provider;
  }
  function once(event, fn) {
    var wrapper = function (payload) { removeListener(event, wrapper); fn(payload); };
    wrapper.listener = fn;
    return on(event, wrapper);
  }
  function removeListener(event, fn) {
    if (listeners[event]) listeners[event] = listeners[event].filter(function (l) { return l !== fn && l.listener !== fn; });
    return provider;
  }
  function removeAllListeners(event) {
    if (event === undefined) Object.keys(listeners).forEach(function (k) { delete listeners[k]; });
    else delete listeners[event];
    return provider;
  }

  // ---- JSON-RPC to the local node
  var nextId = 0;
  function forward(method, params) {
    var id = ++nextId;
    return fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params === undefined ? [] : params })
    }).then(function (res) { return res.json(); }).then(function (json) {
      if (json && json.error) throw rpcError(json.error.code, json.error.message, json.error.data);
      return json.result;
    }, function (err) {
      throw rpcError(-32603, 'mock wallet: cannot reach ' + RPC + ' (' + (err && err.message) + ')');
    });
  }

  var accountsPromise = null;
  function loadAccounts() {
    if (mw.accounts && mw.accounts.length) return Promise.resolve(mw.accounts);
    if (!accountsPromise) {
      accountsPromise = forward('eth_accounts', []).then(function (list) {
        mw.accounts = list.map(function (a) { return String(a).toLowerCase(); });
        return mw.accounts;
      });
      accountsPromise.catch(function () { accountsPromise = null; });
    }
    return accountsPromise;
  }
  function currentAccount() {
    return loadAccounts().then(function (list) {
      var a = list[mw.accountIndex];
      if (!a) throw rpcError(-32603, 'mock wallet: no unlocked account at index ' + mw.accountIndex);
      return a;
    });
  }
  function switchChain(id) {
    var changed = hex(mw.chainId) !== id;
    mw.chainId = id;
    if (changed) emit('chainChanged', id);
  }

  async function handle(method, params) {
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        if (method === 'eth_accounts' && mw.flipAccountsOnce) {
          mw.flipAccountsOnce = false;
          var all = await loadAccounts();
          return [all[(mw.accountIndex + 1) % all.length]];
        }
        return [await currentAccount()];
      case 'eth_chainId':
        return hex(mw.chainId);
      case 'net_version':
        return String(parseInt(hex(mw.chainId), 16));
      case 'wallet_switchEthereumChain': {
        var want = params && params[0] && params[0].chainId;
        if (!want) throw rpcError(-32602, 'Invalid parameters: must provide an object with a chainId');
        var id = hex(want);
        if (mw.knownChains.map(hex).indexOf(id) === -1) throw rpcError(4902, 'Unrecognized chain ID');
        switchChain(id);
        return null;
      }
      case 'wallet_addEthereumChain': {
        var cfg = params && params[0];
        if (!cfg || !cfg.chainId) throw rpcError(-32602, 'Invalid parameters: must provide an object with a chainId');
        var cid = hex(cfg.chainId);
        mw.addedChains.push(cfg);
        if (mw.knownChains.map(hex).indexOf(cid) === -1) mw.knownChains.push(cid);
        switchChain(cid);
        return null;
      }
      case 'eth_sendTransaction':
      case 'eth_signTransaction': {
        if (hex(mw.chainId) !== LOCAL) throw rpcError(-32603, 'mock wallet: only the local chain can send');
        var from = await currentAccount();
        var list = Array.isArray(params) ? params : [];
        if (mw.swallowNextSend) {
          mw.swallowNextSend = false;
          return '0x' + Array.prototype.map.call(crypto.getRandomValues(new Uint8Array(32)), function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('');
        }
        if (typeof mw.beforeSend === 'function') {
          var hook = mw.beforeSend;
          mw.beforeSend = null;
          await hook(list[0]);
        }
        try {
          return await forward(method, [Object.assign({}, list[0], { from: from })].concat(list.slice(1)));
        } catch (err) {
          if (mw.arcStyleFailures && err && err.data && typeof err.data.txHash === 'string') return err.data.txHash;
          throw err;
        }
      }
      default:
        return forward(method, params);
    }
  }

  async function request(args) {
    if (!args || typeof args !== 'object' || typeof args.method !== 'string') throw rpcError(-32600, 'Invalid request: expected { method, params }');
    var method = args.method;
    var params = args.params === undefined ? [] : args.params;
    mw.calls.push({ method: method, params: params, t: Date.now() });
    if (mw.calls.length > 2000) mw.calls.shift();
    var rej = mw.rejectNext === true ? {} : mw.rejectNext;
    if (rej && typeof rej === 'object') {
      var methods = Array.isArray(rej.methods) ? rej.methods : DEFAULT_REJECT_METHODS;
      if (methods.indexOf(method) !== -1) {
        mw.rejectNext = null;
        throw rpcError(typeof rej.code === 'number' ? rej.code : 4001, rej.message || 'User rejected the request.', rej.data);
      }
    }
    return handle(method, params);
  }

  var provider = {
    isMetaMask: false,
    request: request,
    on: on,
    addListener: on,
    once: once,
    removeListener: removeListener,
    off: removeListener,
    removeAllListeners: removeAllListeners,
    isConnected: function () { return true; }
  };
  Object.defineProperty(provider, 'chainId', { enumerable: true, get: function () { return hex(mw.chainId); } });
  Object.defineProperty(provider, 'networkVersion', { enumerable: true, get: function () { return String(parseInt(hex(mw.chainId), 16)); } });
  Object.defineProperty(provider, 'selectedAddress', { enumerable: true, get: function () { return (mw.accounts && mw.accounts[mw.accountIndex]) || null; } });

  // ---- EIP-6963
  var uuid = (carried && carried.uuid) || makeUuid();
  var icon = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#5b21b6"/><text x="16" y="22" font-size="17" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="#fff">M</text></svg>');
  var detail = Object.freeze({ info: Object.freeze({ uuid: uuid, name: 'Mock Wallet', icon: icon, rdns: 'test.mock.wallet' }), provider: provider });
  function announce() { window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: detail })); }
  window.addEventListener('eip6963:requestProvider', announce);

  // Internals for re-injection (non-enumerable so they stay out of JSON dumps and for..in loops).
  Object.defineProperty(mw, '__dispose', {
    value: function () {
      window.removeEventListener('eip6963:requestProvider', announce);
      return { provider: provider, listeners: listeners, uuid: uuid, chainId: hex(mw.chainId), account: (mw.accounts && mw.accounts[mw.accountIndex]) || null };
    }
  });

  try {
    Object.defineProperty(window, 'ethereum', { value: provider, writable: true, configurable: true, enumerable: true });
  } catch (e) {
    window.ethereum = provider;
  }
  window.__mockWallet = mw;

  if (carried) {
    // A stale provider reference held by the page keeps working: every method now forwards to the new instance.
    Object.keys(provider).forEach(function (k) { if (typeof provider[k] === 'function') carried.provider[k] = provider[k]; });
  }
  loadAccounts().then(function (list) {
    // Tell the page about differences caused by a re-injection (new options), like a real wallet would.
    if (carried) {
      if (carried.chainId !== hex(mw.chainId)) emit('chainChanged', hex(mw.chainId));
      var now = list[mw.accountIndex] || null;
      if (carried.account && carried.account !== now) emit('accountsChanged', now ? [now] : []);
    }
  }, function () { /* node not reachable yet; requests will retry */ });

  announce();
  return 'mock wallet installed: account index ' + mw.accountIndex + ', chain ' + hex(mw.chainId);
})();
