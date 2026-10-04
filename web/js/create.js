/* Create page controller: validates the form, registers the invoice on-chain, then shows link, QR code and receipts link. */
(function (root) {
  'use strict';
  var A = root.ArcInvoice;
  var util = A.util;
  var abi = A.abi;
  var wallet = A.wallet;
  var qrlib = A.qr;
  var ui = A.ui;
  var $ = ui.$;
  var el = ui.el;
  var FAUCET_URL = 'https://faucet.circle.com';
  var MAX_DUE = Number(abi.MAX_UINT40);

  var S = {
    network: null, contract: '', client: null, bar: null, busy: false, presetDays: 14, feeToken: 0, feeTimer: null,
    store: ui.localStore(), lastQr: null, chainOffset: 0, pending: null
  };

  function usdc(units) {
    return util.formatUsdc(units, { group: true }) + ' USDC';
  }

  /** Now in chain time: the local clock corrected by the offset to the latest block (0 until the chain has been read). */
  function nowSec() {
    return Math.floor(Date.now() / 1000) + S.chainOffset;
  }

  /** Read the latest block and remember how far the chain clock is from this computer's clock. */
  async function syncChainTime() {
    if (!S.client) return;
    try {
      var b = await S.client.getBlock('latest');
      if (b) S.chainOffset = b.timestamp - Math.floor(Date.now() / 1000);
    } catch (e) { /* keep the previous offset: the local clock is the fallback */ }
    if (S.presetDays) setPreset(S.presetDays);
    else updateDueSummary();
  }

  // ------------------------------------------------------------ form

  function fieldError(id, message) {
    ui.setText(id + '-error', message || '');
    var input = $(id) || $(id === 'due' ? 'due-local' : id);
    if (input) {
      if (message) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
  }

  function currentDue() {
    if (S.presetDays) return nowSec() + S.presetDays * 86400;
    return util.parseLocalDateTime($('due-local').value);
  }

  function updateDueSummary() {
    var due = currentDue();
    var box = $('due-summary');
    if (due === null) {
      box.textContent = 'Pick a date and time.';
      return;
    }
    box.textContent = 'Due ' + util.formatLocal(due) + ' (' + util.formatUtc(due) + '), ' + util.relativeTime(due, nowSec()) + '.';
  }

  function setPreset(days) {
    S.presetDays = days;
    var buttons = $('due-presets').querySelectorAll('button');
    Array.prototype.forEach.call(buttons, function (b) { b.setAttribute('aria-pressed', String(Number(b.getAttribute('data-days')) === days)); });
    if (days) $('due-local').value = util.toLocalDateTimeValue(nowSec() + days * 86400);
    fieldError('due', '');
    updateDueSummary();
    scheduleFee();
  }

  /** Validate the form. Returns { amount, number, description, due } or null (errors are shown next to the fields). */
  function readForm() {
    var ok = true;
    var amount = null;
    var r = util.tryParseUsdc($('amount').value);
    if (!r.ok) {
      fieldError('amount', r.error);
      ok = false;
    } else if (r.value === 0n) {
      fieldError('amount', 'The amount must be greater than zero.');
      ok = false;
    } else {
      amount = r.value;
      fieldError('amount', '');
    }
    var cleaned = false;
    ['number', 'description'].forEach(function (id) {
      var raw = $(id).value;
      if (util.hasInvisible(raw)) {
        $(id).value = util.stripInvisible(raw);
        cleaned = true;
      }
    });
    ui.setStatus('invisible-note', 'warn', cleaned ? 'Hidden formatting characters (zero-width and text-direction marks) were removed from the text you entered, so what you see is what the customer sees.' : '');
    var number = $('number').value.trim();
    if (util.codePointLength(number) > util.MEMO_LIMITS.number) {
      fieldError('number', 'At most ' + util.MEMO_LIMITS.number + ' characters.');
      ok = false;
    } else {
      fieldError('number', '');
    }
    var description = $('description').value.trim();
    if (!description) {
      fieldError('description', 'Describe what the invoice is for.');
      ok = false;
    } else if (util.codePointLength(description) > util.MEMO_LIMITS.description) {
      fieldError('description', 'At most ' + util.MEMO_LIMITS.description + ' characters.');
      ok = false;
    } else {
      fieldError('description', '');
    }
    var due = currentDue();
    if (due === null) {
      fieldError('due', 'Pick a valid date and time.');
      ok = false;
    } else if (due <= nowSec() + 60) {
      fieldError('due', 'The due date must be in the future.');
      ok = false;
    } else if (due > MAX_DUE) {
      fieldError('due', 'That date is too far in the future.');
      ok = false;
    } else {
      fieldError('due', '');
    }
    return ok ? { amount: amount, number: number, description: description, due: due } : null;
  }

  // ------------------------------------------------------------ fee preview

  function scheduleFee() {
    if (S.feeTimer) root.clearTimeout(S.feeTimer);
    S.feeTimer = root.setTimeout(updateFee, 400);
  }

  async function updateFee() {
    var token = ++S.feeToken;
    var line = $('fee-line');
    if (S.busy) return;
    var account = wallet.state.account;
    if (!account || !S.network || wallet.state.chainId !== S.network.chainId) {
      line.textContent = 'Connect a wallet on ' + (S.network ? S.network.name : 'the network') + ' and fill in the form to see the estimated network fee.';
      return;
    }
    var amount = util.tryParseUsdc($('amount').value);
    var due = currentDue();
    if (!amount.ok || amount.value === 0n || due === null || due <= nowSec() + 60 || due > MAX_DUE) {
      line.textContent = 'Fill in a valid amount and due date to see the estimated network fee.';
      return;
    }
    try {
      var dummyHash = util.memoHash('fee preview ' + util.randomSalt());
      var p = await ui.prepareTx(S.client, { from: account, to: S.contract, data: abi.encodeRegister(dummyHash, amount.value, due) });
      if (token !== S.feeToken) return;
      line.textContent = 'Estimated network fee: about ' + util.formatNativeUsdc(p.params.expectedFee) + ' USDC (at most ' + util.formatNativeUsdc(p.params.maxFee) + ' USDC). Paid by you, in USDC, when you create the invoice.';
    } catch (e) {
      if (token !== S.feeToken) return;
      line.textContent = 'The network fee could not be estimated: ' + util.explainFailure(e);
    }
  }

  // ------------------------------------------------------------ creating

  function txLink(hash) {
    return ui.explorerLink(S.network, 'tx', hash, util.shortHash(hash, 12) + '...');
  }

  async function readBack(id) {
    for (var i = 0; i < 10; i++) {
      try {
        var out = await S.client.call({ to: S.contract, data: abi.encodeGetInvoice(id) });
        var inv = abi.decodeGetInvoice(out);
        if (inv.status !== abi.STATUS.None) return inv;
      } catch (e) { /* the RPC may lag behind the wallet's node: try again */ }
      await new Promise(function (r) { root.setTimeout(r, 700); });
    }
    return null;
  }

  /** Everything the result needs, kept so a transaction that confirms late can still be completed. */
  function finishCreate(p, hash, receipt) {
    var registered = receipt ? ui.eventsFromReceipt(receipt, S.contract, { type: 'InvoiceRegistered', id: p.id })[0] : null;
    return readBack(p.id).then(function (onchain) {
      if (receipt && !registered) {
        throw new Error('The transaction was confirmed, but the contract did not report this invoice, so no link was created. Look at the transaction in the explorer.');
      }
      var owner = registered ? registered.merchant : onchain ? onchain.merchant : null;
      if (owner !== null && owner !== p.merchant) {
        throw new Error('The invoice was registered under a different account than the one the link was computed for. No link was created.');
      }
      if (!receipt && !onchain) return false;
      showResult({ id: p.id, link: p.link, memo: p.memo, merchant: p.merchant, referenceHash: p.referenceHash, amount: p.amount, due: p.due, qr: p.qr, txHash: hash, registered: registered, onchain: onchain, number: p.number, description: p.description });
      return true;
    });
  }

  function lockCreate(locked) {
    $('create-btn').disabled = locked;
    ui.show('recheck-btn', !!S.pending);
  }

  async function onCreate(ev) {
    ev.preventDefault();
    if (S.busy || S.pending) return;
    var form = readForm();
    if (!form) {
      ui.setStatus('form-status', 'error', 'Please fix the highlighted fields.');
      return;
    }
    if (!S.contract) return;
    var status = $('form-status');
    var btn = $('create-btn');
    S.busy = true;
    btn.disabled = true;
    var keepLocked = false;
    try {
      ui.setStatus(status, 'info', 'Connecting to your wallet...');
      var account = await S.bar.requireReady(S.network);
      var merchant = abi.toChecksumAddress(account);
      await syncChainTime();
      var due = S.presetDays ? nowSec() + S.presetDays * 86400 : form.due;
      var memo = util.buildMemo({ number: form.number, description: form.description, salt: util.randomSalt() });
      var referenceHash = util.memoHash(memo);
      var id = abi.invoiceId(merchant, referenceHash);
      var link = util.buildPayLink(util.pageDirectory(root.location.href), { net: S.network.key, contract: S.contract, id: id, memo: memo });

      // Make sure the QR code can hold the link before any gas is spent.
      var qr = qrlib.create(link, { ecc: 'M' }); // throws a plain-English error when the link is too long

      var tx = { from: account, to: S.contract, data: abi.encodeRegister(referenceHash, form.amount, due), chainId: S.network.chainId, networkName: S.network.name };
      ui.setStatus(status, 'info', 'Simulating the transaction...');
      var prep = await ui.prepareTx(S.client, tx, { balanceOf: account });
      ui.setText('fee-line', 'Estimated network fee: about ' + util.formatNativeUsdc(prep.params.expectedFee) + ' USDC (at most ' + util.formatNativeUsdc(prep.params.maxFee) + ' USDC).');
      var balance = prep.balance;
      if (balance < prep.params.maxFee) {
        var extra = S.network.testnet ? el('a', { href: FAUCET_URL, target: '_blank', rel: 'noopener noreferrer' }, 'Get test USDC from the Circle faucet') : null;
        ui.setStatus(status, 'error', 'This account has ' + util.formatNativeUsdc(balance) + ' USDC, which does not cover the network fee (up to ' + util.formatNativeUsdc(prep.params.maxFee) + ' USDC).', extra);
        return;
      }

      // The invoice id depends on the merchant account: make sure the wallet still uses the account it was computed for.
      var live = await wallet.request('eth_accounts');
      if (!live || !live.length || live[0].toLowerCase() !== account.toLowerCase()) {
        throw Object.assign(new Error('The wallet account changed while the invoice was being prepared. Nothing was sent. Please try again.'), { userMessage: 'The wallet account changed while the invoice was being prepared. Nothing was sent. Please try again.' });
      }

      util.saveMemo(S.store, referenceHash, memo);
      ui.setStatus(status, 'info', 'Confirm the transaction in your wallet...');
      var pending = { id: id, link: link, memo: memo, merchant: merchant, referenceHash: referenceHash, amount: form.amount, due: due, qr: qr, number: form.number, description: form.description, hash: null };
      var sent;
      try {
        sent = await ui.sendAndWait(S.client, tx, prep.params, {
          onSent: function (hash) { pending.hash = hash; ui.setStatus(status, 'info', 'Transaction sent. Waiting for confirmation... ', txLink(hash)); },
          timeoutMessage: 'The transaction was sent but is not confirmed yet. It may still confirm, so check the transaction link and the receipts page before creating this invoice again.'
        });
      } catch (se) {
        if (se && se.code === 'RECEIPT_TIMEOUT') {
          S.pending = pending;
          keepLocked = true; // do not allow a second Create while the first may still confirm
          ui.setStatus(status, 'warn', se.userMessage + ' Press "Check again" to look at the chain. If you are sure it will never confirm, reload the page to start over.', txLink(se.txHash));
          return;
        }
        throw se;
      }

      ui.setStatus(status, 'info', 'Confirmed. Reading the invoice back from the chain...');
      await finishCreate(pending, sent.hash, sent.receipt);
      ui.setStatus(status, 'ok', 'Invoice created. ', txLink(sent.hash));
    } catch (e) {
      ui.setStatus(status, 'error', util.explainFailure(e), e && e.txHash ? txLink(e.txHash) : null);
    } finally {
      S.busy = false;
      lockCreate(keepLocked || !!S.pending);
      scheduleFee();
    }
  }

  /** After a confirmation timeout: look for the receipt or the invoice again, and only then free the form. */
  async function recheckPending() {
    var p = S.pending;
    if (!p) return;
    var status = $('form-status');
    ui.setStatus(status, 'info', 'Checking the chain...');
    try {
      var receipt = p.hash ? await S.client.getTransactionReceipt(p.hash) : null;
      if (receipt && (receipt.status === '0x0' || receipt.status === 0)) {
        var reason = null;
        try { reason = await util.replayFailedTx(S.client, { from: p.merchant, to: S.contract, data: abi.encodeRegister(p.referenceHash, p.amount, p.due) }, receipt); } catch (re) { reason = null; }
        S.pending = null;
        lockCreate(false);
        ui.setStatus(status, 'error', util.failedOnChainMessage(reason), p.hash ? txLink(p.hash) : null);
        return;
      }
      var done = await finishCreate(p, p.hash, receipt);
      if (done) {
        S.pending = null;
        lockCreate(false);
        ui.setStatus(status, 'ok', 'Invoice created. ', p.hash ? txLink(p.hash) : null);
      } else {
        ui.setStatus(status, 'warn', 'The transaction is still not confirmed. Check the transaction link and try again in a minute.', p.hash ? txLink(p.hash) : null);
      }
    } catch (e) {
      ui.setStatus(status, 'error', util.explainFailure(e), p.hash ? txLink(p.hash) : null);
    }
  }

  // ------------------------------------------------------------ result

  function kvRow(dl, label, value) {
    dl.appendChild(el('dt', null, label));
    dl.appendChild(el('dd', null, value));
  }

  function showResult(r) {
    S.lastQr = r.qr;
    var net = S.network;
    ui.show('result', true);
    ui.setStatus('host-warning', 'warn', util.isLocalOrigin(root.location.href) ? 'This link points to your own computer. Customers cannot open it. Host the web/ folder (for example with GitHub Pages) and create the invoice from the hosted page.' : '');
    $('res-link').value = r.link;
    var open = $('open-pay-btn');
    open.href = r.link;
    $('receipts-btn').href = util.buildReceiptsLink(util.pageDirectory(root.location.href), { net: net.key, merchant: r.merchant });

    var qrBox = ui.clear($('qr-box'));
    var qrErr = $('qr-error');
    if (r.qr) {
      qrBox.appendChild(qrlib.toSvgElement(r.qr, { title: 'QR code of the pay link' }));
      ui.show(qrErr, false);
    } else {
      ui.show(qrErr, true);
    }
    $('qr-svg-btn').disabled = !r.qr;
    $('qr-png-btn').disabled = !r.qr;

    var warn = $('result-warning');
    var dl = ui.clear($('onchain'));
    var inv = r.onchain;
    if (inv) {
      var matches = inv.merchant === r.merchant && inv.amount === r.amount && inv.due === r.due && inv.referenceHash === r.referenceHash && inv.status === abi.STATUS.Open;
      ui.setStatus(warn, matches ? 'ok' : 'warn', matches ? 'The on-chain invoice matches what you entered.' : 'Warning: the invoice on-chain differs from what you entered. Check it before sharing the link.');
      kvRow(dl, 'Status (on-chain)', ui.statusBadge('open'));
      kvRow(dl, 'Amount (on-chain)', usdc(inv.amount));
      kvRow(dl, 'Merchant (on-chain)', el('code', null, inv.merchant));
      kvRow(dl, 'Due (on-chain)', util.formatLocal(inv.due) + ' (' + util.formatUtc(inv.due) + ')');
      kvRow(dl, 'Reference hash', el('code', null, inv.referenceHash));
    } else {
      ui.setStatus(warn, 'warn', 'The transaction is confirmed, but the invoice could not be read back yet (the RPC may be lagging). The link is computed locally and should work in a moment.');
      kvRow(dl, 'Amount', usdc(r.amount));
      kvRow(dl, 'Merchant', el('code', null, r.merchant));
      kvRow(dl, 'Due', util.formatLocal(r.due) + ' (' + util.formatUtc(r.due) + ')');
      kvRow(dl, 'Reference hash', el('code', null, r.referenceHash));
    }
    kvRow(dl, 'Invoice id', el('code', null, r.id));
    kvRow(dl, 'Transaction', ui.explorerLink(net, 'tx', r.txHash, r.txHash));

    // Printable sheet.
    var pk = ui.clear($('print-kv'));
    if (r.number) kvRow(pk, 'Invoice number', util.showInvisible(r.number));
    kvRow(pk, 'Description', el('span', { class: 'memo-text' }, util.showInvisible(r.description)));
    kvRow(pk, 'Amount', usdc(r.amount));
    kvRow(pk, 'Due', util.formatLocal(r.due) + ' (' + util.formatUtc(r.due) + ')');
    kvRow(pk, 'Pay to (merchant)', el('code', null, r.merchant));
    kvRow(pk, 'Network', net.name + (net.testnet ? ' (test money only)' : ''));
    var pq = ui.clear($('print-qr'));
    if (r.qr) pq.appendChild(qrlib.toSvgElement(r.qr, { title: 'QR code of the pay link' }));
    ui.setText('print-link', 'Pay online: ' + r.link);

    ui.show('result', true);
    $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('res-h').setAttribute('tabindex', '-1');
    $('res-h').focus();
  }

  // ------------------------------------------------------------ network selection

  function selectNetwork(key) {
    var net = ui.cfg.networks[key];
    var dep = ui.deploymentOf(key);
    S.network = net;
    S.contract = dep.contract ? abi.toChecksumAddress(dep.contract) : '';
    S.client = ui.makeClient(net);
    S.chainOffset = 0;
    syncChainTime();
    ui.updateBanner(net);
    $('nav-receipts').href = 'receipts.html#net=' + encodeURIComponent(key);
    try { root.history.replaceState(null, '', '#net=' + encodeURIComponent(key)); } catch (e) { /* file:// or sandbox */ }
    if (S.bar) S.bar.render();
    ui.show('result', false);
    scheduleFee();
  }

  function start() {
    ui.initChrome();
    var frag = util.parseFragment(root.location.hash).params;
    var nets = ui.selectableNetworks(frag.net);
    var select = $('net-select');
    S.bar = ui.bindWalletBar({ getNetwork: function () { return S.network; }, onChange: scheduleFee });

    if (!nets.length) {
      ui.setStatus('no-contract', 'warn', 'No invoice contract is configured on this copy of the site yet (see js/deployments.js), so invoices cannot be created here.');
      select.disabled = true;
      $('create-btn').disabled = true;
      S.network = ui.cfg.networks[ui.cfg.defaultNetwork] || null;
      if (S.network) ui.updateBanner(S.network);
      S.bar.render();
      return;
    }
    nets.forEach(function (n) { select.appendChild(el('option', { value: n.key }, n.name + ' (chain ' + n.chainId + ')')); });
    var initial = nets.filter(function (n) { return n.key === frag.net; })[0] || nets.filter(function (n) { return n.key === ui.cfg.defaultNetwork; })[0] || nets[0];
    select.value = initial.key;
    select.addEventListener('change', function () { selectNetwork(select.value); });
    selectNetwork(initial.key);

    $('desc-count').textContent = '0';
    $('description').addEventListener('input', function () {
      $('desc-count').textContent = String(util.codePointLength($('description').value));
      scheduleFee();
    });
    $('amount').addEventListener('input', function () {
      var v = $('amount').value;
      if (v.trim() === '') fieldError('amount', '');
      else {
        var r = util.tryParseUsdc(v);
        fieldError('amount', r.ok ? (r.value === 0n ? 'The amount must be greater than zero.' : '') : r.error);
      }
      scheduleFee();
    });
    $('due-local').addEventListener('input', function () {
      setPreset(null);
    });
    Array.prototype.forEach.call($('due-presets').querySelectorAll('button'), function (b) {
      b.addEventListener('click', function () { setPreset(Number(b.getAttribute('data-days'))); });
    });
    setPreset(14);

    $('invoice-form').addEventListener('submit', onCreate);
    $('recheck-btn').addEventListener('click', recheckPending);
    ui.copyButton($('copy-link-btn'), function () { return $('res-link').value; });
    $('qr-svg-btn').addEventListener('click', function () {
      if (S.lastQr) ui.downloadText('invoice-qr.svg', qrlib.toSvgString(S.lastQr, { title: 'QR code of the pay link' }), 'image/svg+xml');
    });
    $('qr-png-btn').addEventListener('click', async function () {
      if (!S.lastQr) return;
      try {
        ui.downloadBlob('invoice-qr.png', await qrlib.toPngBlob(S.lastQr));
      } catch (e) {
        ui.setStatus('form-status', 'error', util.explainFailure(e));
      }
    });
    $('print-btn').addEventListener('click', function () {
      document.body.classList.add('printing-invoice');
      root.addEventListener('afterprint', function done() {
        document.body.classList.remove('printing-invoice');
        root.removeEventListener('afterprint', done);
      });
      root.print();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})(typeof globalThis !== 'undefined' ? globalThis : this);
