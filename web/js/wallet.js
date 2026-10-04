/*
 * Wallet access (EIP-1193 providers found through EIP-6963 with a window.ethereum fallback).
 * Wallets are looked up lazily, at click time, because they may inject late. Reads never need a wallet.
 * Browser only. Adds ArcInvoice.wallet.
 */
(function (root) {
  'use strict';
  var A = (root.ArcInvoice = root.ArcInvoice || {});
  var util = A.util;

  var announced = []; // { info, provider } from EIP-6963
  var listening = false;
  var current = null; // { info, provider } currently in use
  var attached = null; // { provider, accountsHandler, chainHandler }
  var subscribers = [];
  var state = { account: null, chainId: null, walletName: null };
  var STORE_KEY = 'arcInvoice.wallet';
  var store = util.createStore((function () { try { return root.localStorage; } catch (e) { return null; } })());

  function noWalletError() {
    var e = new Error('No browser wallet was found. Install a wallet extension that supports Arc (any EIP-1193 compatible wallet), then reload this page.');
    e.code = 'NO_WALLET';
    return e;
  }

  function onAnnounce(ev) {
    var d = ev && ev.detail;
    if (!d || !d.provider || typeof d.provider.request !== 'function') return;
    if (announced.some(function (p) { return p.provider === d.provider; })) return;
    announced.push({ info: d.info || { name: 'Wallet', rdns: '', uuid: '' }, provider: d.provider });
  }

  /** Providers visible right now (asks wallets to announce themselves again each time). */
  function list() {
    if (!listening) {
      root.addEventListener('eip6963:announceProvider', onAnnounce);
      listening = true;
    }
    try {
      root.dispatchEvent(new Event('eip6963:requestProvider'));
    } catch (e) { /* ignore */ }
    var out = announced.slice();
    var eth = root.ethereum;
    // window.ethereum is only a fallback: wallets that announce themselves (EIP-6963) often also set it, as a different object.
    if (!out.length && eth && typeof eth.request === 'function') {
      out.push({ info: { name: 'Browser wallet', rdns: 'window.ethereum', uuid: 'window.ethereum' }, provider: eth });
    }
    return out;
  }

  function available() {
    return list().length > 0;
  }

  function notify() {
    subscribers.slice().forEach(function (fn) {
      try { fn(Object.assign({}, state)); } catch (e) { /* subscriber bug must not break the wallet */ }
    });
  }

  function detach() {
    if (attached && attached.provider) {
      var p = attached.provider;
      var off = p.removeListener || p.off;
      if (typeof off === 'function') {
        try {
          off.call(p, 'accountsChanged', attached.accountsHandler);
          off.call(p, 'chainChanged', attached.chainHandler);
        } catch (e) { /* ignore */ }
      }
    }
    attached = null;
  }

  function parseChainId(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v)) return parseInt(v, 16);
    if (typeof v === 'string' && /^[0-9]+$/.test(v)) return parseInt(v, 10);
    return null;
  }

  function attach(entry) {
    detach();
    var p = entry.provider;
    var on = p.on || p.addListener;
    var accountsHandler = function (accounts) {
      state.account = accounts && accounts.length ? accounts[0] : null;
      notify();
    };
    var chainHandler = function (chainId) {
      state.chainId = parseChainId(chainId);
      notify();
    };
    if (typeof on === 'function') {
      on.call(p, 'accountsChanged', accountsHandler);
      on.call(p, 'chainChanged', chainHandler);
    }
    attached = { provider: p, accountsHandler: accountsHandler, chainHandler: chainHandler };
  }

  /** Choose the provider to use: the remembered one, else the first announced, else window.ethereum. */
  function pick() {
    var ps = list();
    if (!ps.length) return null;
    if (current && ps.some(function (p) { return p.provider === current.provider; })) return current;
    var saved = store.get(STORE_KEY, '');
    var chosen = ps.filter(function (p) { return saved && p.info.rdns === saved; })[0] || ps[0];
    current = chosen;
    state.walletName = chosen.info.name || 'Wallet';
    attach(chosen);
    return chosen;
  }

  /** Select a wallet by its EIP-6963 uuid (or rdns) and remember the choice. */
  function use(id) {
    var found = list().filter(function (p) { return p.info.uuid === id || p.info.rdns === id; })[0];
    if (!found) return false;
    current = found;
    state.walletName = found.info.name || 'Wallet';
    state.account = null;
    state.chainId = null;
    store.set(STORE_KEY, found.info.rdns || '');
    attach(found);
    notify();
    return true;
  }

  /** uuid (or rdns) of the wallet in use, or '' before one was chosen. */
  function currentId() {
    return current ? current.info.uuid || current.info.rdns || '' : '';
  }

  function providerOrThrow() {
    var p = pick();
    if (!p) throw noWalletError();
    return p.provider;
  }

  /** Raw EIP-1193 request on the chosen wallet. */
  function request(method, params) {
    return providerOrThrow().request({ method: method, params: params || [] });
  }

  /** Ask the wallet for an account (shows the wallet's connect prompt). Resolves the account address. */
  async function connect() {
    var p = providerOrThrow();
    var accounts = await p.request({ method: 'eth_requestAccounts' });
    if (!accounts || !accounts.length) {
      var e = new Error('The wallet did not share an account.');
      e.code = 'NO_ACCOUNT';
      e.userMessage = 'The wallet did not share an account. Unlock it and try again.';
      throw e;
    }
    state.account = accounts[0];
    state.chainId = parseChainId(await p.request({ method: 'eth_chainId' }));
    notify();
    return state.account;
  }

  /** Re-read chain id and accounts without a prompt (eth_accounts). Safe to call on page load when a wallet exists. */
  async function refresh() {
    var entry = pick();
    if (!entry) return null;
    try {
      var accounts = await entry.provider.request({ method: 'eth_accounts' });
      state.account = accounts && accounts.length ? accounts[0] : null;
      state.chainId = parseChainId(await entry.provider.request({ method: 'eth_chainId' }));
      notify();
    } catch (e) { /* wallet locked or unavailable: stay disconnected */ }
    return Object.assign({}, state);
  }

  /** The network's primary RPC plus, when configured, the Blockdaemon endpoint as a second entry. */
  function rpcUrlsFor(network) {
    var urls = [network.rpc];
    var list = network.rpcs && network.rpcs.read ? network.rpcs.read : [];
    for (var i = 0; i < list.length; i++) {
      var u = typeof list[i] === 'string' ? list[i] : list[i].url;
      if (u && u !== network.rpc && /blockdaemon/.test(u)) {
        urls.push(u);
        break;
      }
    }
    return urls;
  }

  function chainParams(network) {
    return {
      chainId: '0x' + network.chainId.toString(16),
      chainName: network.name,
      nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
      rpcUrls: rpcUrlsFor(network),
      blockExplorerUrls: network.explorer ? [network.explorer] : []
    };
  }

  function isUnknownChain(e) {
    if (!e) return false;
    var code = e.code !== undefined ? e.code : e.data && e.data.originalError && e.data.originalError.code;
    return code === 4902 || /unrecogni[sz]ed chain|unknown chain|not been added|add.*chain/i.test(String(e.message || ''));
  }

  /** Make sure the wallet is on `network`: switch, adding the chain to the wallet first if it does not know it. */
  async function ensureChain(network) {
    var p = providerOrThrow();
    var id = parseChainId(await p.request({ method: 'eth_chainId' }));
    state.chainId = id;
    if (id === network.chainId) return true;
    var hex = '0x' + network.chainId.toString(16);
    try {
      await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
    } catch (e) {
      if (!isUnknownChain(e)) throw e;
      await p.request({ method: 'wallet_addEthereumChain', params: [chainParams(network)] });
    }
    state.chainId = parseChainId(await p.request({ method: 'eth_chainId' }));
    notify();
    if (state.chainId !== network.chainId) {
      var err = new Error('The wallet is still on a different network. Switch to ' + network.name + ' in your wallet and try again.');
      err.code = 'WRONG_CHAIN';
      throw err;
    }
    return true;
  }

  /** Read-only view of the wallet as an RPC client (only what waitForReceipt needs). */
  function asClient() {
    return {
      getTransactionReceipt: function (hash) {
        return request('eth_getTransactionReceipt', [hash]);
      }
    };
  }

  /**
   * Send a transaction through the wallet. tx: { from, to, data, value? (BigInt), gas (BigInt), maxFeePerGas (BigInt),
   * maxPriorityFeePerGas (BigInt) }. If the wallet refuses the priority fee, retries once with a zero priority fee.
   */
  async function sendTransaction(tx) {
    // The wallet may have been switched to another network after the page prepared the transaction: look again right now.
    if (tx.chainId !== undefined && tx.chainId !== null) {
      var live = parseChainId(await request('eth_chainId'));
      state.chainId = live;
      if (live !== Number(tx.chainId)) {
        var werr = new Error('Your wallet is no longer on ' + (tx.networkName || 'the right network') + ' (it reports chain ' + live + '). Nothing was sent. Switch the wallet back and try again.');
        werr.code = 'WRONG_CHAIN';
        werr.userMessage = werr.message;
        notify();
        throw werr;
      }
    }
    function wire(priority) {
      var o = {
        from: tx.from,
        to: tx.to,
        data: tx.data,
        gas: util.toHex(tx.gas),
        maxFeePerGas: util.toHex(tx.maxFeePerGas),
        maxPriorityFeePerGas: util.toHex(priority)
      };
      if (tx.chainId !== undefined && tx.chainId !== null) o.chainId = util.toHex(tx.chainId);
      if (tx.value !== undefined && tx.value !== null && BigInt(tx.value) !== 0n) o.value = util.toHex(tx.value);
      return o;
    }
    try {
      return await request('eth_sendTransaction', [wire(tx.maxPriorityFeePerGas)]);
    } catch (e) {
      if (e && e.code !== 4001 && /priority|tip|maxPriorityFeePerGas/i.test(String(e.message || ''))) {
        return request('eth_sendTransaction', [wire(0n)]);
      }
      throw e;
    }
  }

  function subscribe(fn) {
    subscribers.push(fn);
    return function () { subscribers = subscribers.filter(function (f) { return f !== fn; }); };
  }

  A.wallet = {
    state: state,
    list: list,
    available: available,
    use: use,
    currentId: currentId,
    request: request,
    connect: connect,
    refresh: refresh,
    ensureChain: ensureChain,
    sendTransaction: sendTransaction,
    asClient: asClient,
    subscribe: subscribe,
    chainParams: chainParams,
    rpcUrlsFor: rpcUrlsFor,
    forget: function () { state.account = null; notify(); }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
