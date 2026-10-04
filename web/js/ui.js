/*
 * Shared page helpers: safe DOM building (never innerHTML), network resolution, status lines, wallet bar,
 * copy / download helpers and the common transaction flow. Browser only. Adds ArcInvoice.ui.
 */
(function (root) {
  'use strict';
  var A = (root.ArcInvoice = root.ArcInvoice || {});
  var util = A.util;
  var abi = A.abi;
  var rpc = A.rpc;
  var wallet = A.wallet;
  var doc = root.document;
  var cfg = root.ArcInvoiceConfig || { networks: {}, defaultNetwork: '', REPO_URL: '' };
  var deployments = root.ArcInvoiceDeployments || {};

  // ------------------------------------------------------------ DOM helpers

  function append(node, children) {
    if (children === undefined || children === null) return node;
    (Array.isArray(children) ? children : [children]).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === 'string' || typeof c === 'number' || typeof c === 'bigint' ? doc.createTextNode(String(c)) : c);
    });
    return node;
  }

  /** el('a', { href, class, on: { click } }, children). Text is always inserted as text nodes. */
  function el(tag, attrs, children) {
    var n = doc.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') n.className = v;
        else if (k === 'on') Object.keys(v).forEach(function (ev) { n.addEventListener(ev, v[ev]); });
        else n.setAttribute(k, v === true ? '' : String(v));
      });
    }
    return append(n, children);
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function $(id) {
    return doc.getElementById(id);
  }

  function setText(id, text) {
    var n = typeof id === 'string' ? $(id) : id;
    if (n) n.textContent = text;
    return n;
  }

  function show(node, visible) {
    var n = typeof node === 'string' ? $(node) : node;
    if (n) n.hidden = !visible;
    return n;
  }

  /**
   * Put a message into a live region. kind: 'info' | 'ok' | 'warn' | 'error'. Empty text hides it.
   * The text is written first and the region is un-hidden afterwards, so screen readers announce it.
   */
  function setStatus(node, kind, text, extra) {
    var n = typeof node === 'string' ? $(node) : node;
    if (!n) return;
    if (!n.getAttribute('aria-live')) n.setAttribute('aria-live', 'polite');
    if (!n.getAttribute('role')) n.setAttribute('role', 'status');
    clear(n);
    if (!text) {
      n.className = 'status';
      n.hidden = true;
      return;
    }
    n.className = 'status status-' + kind;
    n.appendChild(doc.createTextNode(text));
    if (extra) append(n, [' ', extra]);
    n.hidden = false;
  }

  // ------------------------------------------------------------ networks

  /** Networks offered in selectors: contract configured; the dev network only when the link says net=local. */
  function selectableNetworks(fragmentNet) {
    return Object.keys(cfg.networks).filter(function (k) {
      var n = cfg.networks[k];
      if (n.dev && fragmentNet !== k) return false;
      return !!(deployments[k] && deployments[k].contract);
    }).map(function (k) { return cfg.networks[k]; });
  }

  function deploymentOf(key) {
    var d = deployments[key] || {};
    return { contract: d.contract || '', deployBlock: Number(d.deployBlock) || 0 };
  }

  function updateBanner(network) {
    var b = $('testnet-banner');
    if (!b) return;
    if (network && network.testnet) {
      b.textContent = 'Arc Testnet: test money only';
      b.className = 'banner banner-test';
      b.hidden = false;
    } else if (network && network.dev) {
      b.textContent = 'Local development network: not a public chain';
      b.className = 'banner banner-dev';
      b.hidden = false;
    } else {
      b.hidden = true;
    }
  }

  /** Footer "Source code" link only when REPO_URL is set. */
  function initChrome() {
    var link = $('repo-link');
    if (link && cfg.REPO_URL) {
      link.href = cfg.REPO_URL;
      link.rel = 'noopener noreferrer';
      show('repo-line', true);
    }
  }

  function explorerLink(network, kind, value, label) {
    var url = util.explorerUrl(network, kind, value);
    var text = label || value;
    if (!url) return el('span', { class: 'mono' }, text);
    return el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'mono' }, text);
  }

  /** Ordered endpoint list of a network for 'read' or 'logs' use; an optional override URL goes first. */
  function endpointList(network, kind, override) {
    var base = network.rpcs && network.rpcs[kind] && network.rpcs[kind].length ? network.rpcs[kind] : [network.rpc];
    var list = base.map(function (e) { return typeof e === 'string' ? { url: e } : e; });
    if (override) list = [{ url: override }].concat(list.filter(function (e) { return e.url !== override; }));
    return list;
  }

  /** Client for ordinary reads and transactions: rotates over the network's read endpoints on rate limits and errors. */
  function makeClient(network) {
    return rpc.createClient({ endpoints: endpointList(network, 'read') });
  }

  /** Client for log scans and block searches: endpoints that allow big eth_getLogs ranges come first. */
  function makeLogsClient(network, override) {
    return rpc.createClient({ endpoints: endpointList(network, 'logs', override) });
  }

  var validateRpcUrl = util.validateRpcUrl;

  // ------------------------------------------------------------ clipboard and downloads

  async function copyText(text) {
    try {
      if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
        await root.navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fall back below */ }
    var ta = el('textarea', { 'aria-hidden': 'true', tabindex: '-1', class: 'offscreen' });
    ta.value = text;
    doc.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = doc.execCommand('copy'); } catch (e) { ok = false; }
    doc.body.removeChild(ta);
    return ok;
  }

  /** Copy text and flash the button label. */
  function copyButton(button, getText) {
    var label = button.textContent;
    button.addEventListener('click', async function () {
      var ok = await copyText(getText());
      button.textContent = ok ? 'Copied' : 'Copy failed: select and copy manually';
      root.setTimeout(function () { button.textContent = label; }, 1800);
    });
  }

  function downloadBlob(filename, blob) {
    var url = root.URL.createObjectURL(blob);
    var a = el('a', { href: url, download: filename, class: 'offscreen' });
    doc.body.appendChild(a);
    a.click();
    doc.body.removeChild(a);
    root.setTimeout(function () { root.URL.revokeObjectURL(url); }, 4000);
  }

  function downloadText(filename, text, mime) {
    downloadBlob(filename, new root.Blob([text], { type: mime || 'text/plain;charset=utf-8' }));
  }

  // ------------------------------------------------------------ wallet bar

  /**
   * Wire the wallet bar (#connect-btn, #account-line, #chain-line, #switch-btn, #wallet-choice-wrap, #wallet-choice,
   * #wallet-status). opts: { getNetwork(), onChange() }. Returns { render, requireReady(network) }.
   */
  function bindWalletBar(opts) {
    var connectBtn = $('connect-btn');
    var accountLine = $('account-line');
    var chainLine = $('chain-line');
    var switchBtn = $('switch-btn');
    var choiceWrap = $('wallet-choice-wrap');
    var choice = $('wallet-choice');
    var status = $('wallet-status');

    function render() {
      var net = opts.getNetwork();
      var s = wallet.state;
      var list = wallet.list();
      if (choiceWrap && choice) {
        show(choiceWrap, list.length > 1);
        if (list.length > 1 && choice.options.length !== list.length) {
          clear(choice);
          list.forEach(function (p) { choice.appendChild(el('option', { value: p.info.uuid || p.info.rdns }, p.info.name || 'Wallet')); });
        }
        if (list.length > 1 && wallet.currentId()) choice.value = wallet.currentId();
      }
      if (s.account) {
        setText(accountLine, 'Connected: ' + abi.toChecksumAddress(s.account));
        accountLine.className = 'account-line connected';
        connectBtn.textContent = 'Reconnect';
      } else {
        setText(accountLine, 'No wallet connected. Reading works without a wallet; connect to send transactions.');
        accountLine.className = 'account-line';
        connectBtn.textContent = 'Connect wallet';
      }
      if (net && s.account) {
        var ok = s.chainId === net.chainId;
        setText(chainLine, ok ? 'Wallet network: ' + net.name : 'Your wallet is on chain ' + s.chainId + ', not ' + net.name + ' (chain ' + net.chainId + ').');
        chainLine.className = 'chain-line ' + (ok ? 'ok' : 'warn');
        show(chainLine, true);
        show(switchBtn, !ok);
        switchBtn.textContent = 'Switch wallet to ' + net.name;
      } else {
        show(chainLine, false);
        show(switchBtn, false);
      }
      if (opts.onChange) opts.onChange(s);
    }

    async function connect() {
      setStatus(status, 'info', 'Waiting for your wallet...');
      try {
        await wallet.connect();
        var net = opts.getNetwork();
        if (net && wallet.state.chainId !== net.chainId) await wallet.ensureChain(net);
        setStatus(status, 'info', '');
      } catch (e) {
        setStatus(status, 'error', util.explainFailure(e));
      }
      render();
    }

    /** Connect if needed and switch to the network; resolves the account. Throws a plain-English Error otherwise. */
    async function requireReady(net) {
      if (!wallet.state.account) await wallet.connect();
      if (wallet.state.chainId !== net.chainId) await wallet.ensureChain(net);
      render();
      return wallet.state.account;
    }

    connectBtn.addEventListener('click', connect);
    switchBtn.addEventListener('click', async function () {
      try {
        await wallet.ensureChain(opts.getNetwork());
        setStatus(status, 'info', '');
      } catch (e) {
        setStatus(status, 'error', util.explainFailure(e));
      }
      render();
    });
    if (choice) {
      choice.addEventListener('change', function () {
        wallet.use(choice.value);
        render();
      });
    }
    wallet.subscribe(render);
    // Wallets may inject late: look again when the page finishes loading and on first user interaction.
    root.addEventListener('load', function () { wallet.refresh().then(render); });
    render();
    return { render: render, requireReady: requireReady };
  }

  // ------------------------------------------------------------ transactions

  /**
   * Estimate gas first (so reverts surface before the wallet prompt) and compute Arc-safe fee fields, in one batched
   * request. opts.balanceOf: also read that account's balance. Resolves { gasEstimate, gasPrice, balance, params }
   * or rejects with the node's error (revert data intact).
   */
  async function prepareTx(client, tx, opts) {
    var call = { from: tx.from, to: tx.to, data: tx.data };
    if (tx.value && BigInt(tx.value) !== 0n) call.value = util.toHex(tx.value);
    var calls = [{ method: 'eth_gasPrice', params: [] }, { method: 'eth_estimateGas', params: [call] }];
    if (opts && opts.balanceOf) calls.push({ method: 'eth_getBalance', params: [opts.balanceOf, 'latest'] });
    var r = await client.batch(calls);
    if (r[1].error) throw r[1].error;
    if (r[0].error) throw r[0].error;
    if (r[2] && r[2].error) throw r[2].error;
    var gasEstimate = BigInt(r[1].result);
    var gasPrice = BigInt(r[0].result);
    return { gasEstimate: gasEstimate, gasPrice: gasPrice, balance: r[2] ? BigInt(r[2].result) : null, params: util.computeTxParams(gasEstimate, gasPrice) };
  }

  /**
   * Send through the wallet, then poll for the receipt (700 ms, up to 120 s). Calls cb.onSent(hash) once sent.
   * tx.chainId makes the wallet layer re-check the network right before sending. If no receipt shows up in time the
   * error has code 'RECEIPT_TIMEOUT', .txHash and a .userMessage (cb.timeoutMessage overrides the wording): the
   * transaction may still confirm, so callers must not simply allow a second attempt.
   */
  async function sendAndWait(client, tx, params, cb) {
    var hash = await wallet.sendTransaction({
      from: tx.from, to: tx.to, data: tx.data, value: tx.value, chainId: tx.chainId, networkName: tx.networkName,
      gas: params.gas, maxFeePerGas: params.maxFeePerGas, maxPriorityFeePerGas: params.maxPriorityFeePerGas
    });
    if (cb && cb.onSent) cb.onSent(hash);
    var receipt;
    try {
      receipt = await rpc.waitForReceipt({ clients: [client, wallet.asClient()], hash: hash, intervalMs: 700, timeoutMs: cfg.receiptTimeoutMs || 120000, onTick: cb && cb.onTick });
    } catch (we) {
      if (we && we.code === 'RECEIPT_TIMEOUT') {
        we.txHash = hash;
        we.userMessage = (cb && cb.timeoutMessage) || 'The transaction was sent but is not confirmed yet. It may still confirm, so check the transaction link and the invoice status before paying again.';
      }
      throw we;
    }
    if (receipt.status === '0x0' || receipt.status === 0) {
      // Arc mines a failing transaction: find out why by replaying it (the receipt has no revert data).
      var reason = null;
      try { reason = await util.replayFailedTx(client, tx, receipt); } catch (re) { reason = null; }
      var e = new Error(util.failedOnChainMessage(reason));
      e.code = 'TX_REVERTED';
      e.txHash = hash;
      e.userMessage = e.message;
      throw e;
    }
    return { hash: hash, receipt: receipt };
  }

  /** The contract's events in a receipt (only logs emitted by `contract`; want = { type, id } narrows them). */
  function eventsFromReceipt(receipt, contract, want) {
    return abi.eventsFromReceipt(receipt, contract, want);
  }

  function statusBadge(status) {
    var labels = { open: 'Open', paid: 'Paid', cancelled: 'Cancelled', expired: 'Expired', notfound: 'Not found' };
    return el('span', { class: 'badge badge-' + status }, labels[status] || status);
  }

  function loadMemos() {
    var store = util.createStore((function () { try { return root.localStorage; } catch (e) { return null; } })());
    return { store: store, memos: util.loadMemos(store) };
  }

  function localStore() {
    return util.createStore((function () { try { return root.localStorage; } catch (e) { return null; } })());
  }

  A.ui = {
    cfg: cfg,
    deployments: deployments,
    el: el,
    append: append,
    clear: clear,
    $: $,
    setText: setText,
    show: show,
    setStatus: setStatus,
    selectableNetworks: selectableNetworks,
    deploymentOf: deploymentOf,
    updateBanner: updateBanner,
    initChrome: initChrome,
    explorerLink: explorerLink,
    makeClient: makeClient,
    makeLogsClient: makeLogsClient,
    validateRpcUrl: validateRpcUrl,
    copyText: copyText,
    copyButton: copyButton,
    downloadBlob: downloadBlob,
    downloadText: downloadText,
    bindWalletBar: bindWalletBar,
    prepareTx: prepareTx,
    sendAndWait: sendAndWait,
    eventsFromReceipt: eventsFromReceipt,
    statusBadge: statusBadge,
    loadMemos: loadMemos,
    localStore: localStore
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
