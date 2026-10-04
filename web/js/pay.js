/* Pay page controller: reads the invoice from the chain, verifies the description, lets the payer settle it. */
(function (root) {
  'use strict';
  var A = root.ArcInvoice;
  var util = A.util;
  var abi = A.abi;
  var rpc = A.rpc;
  var wallet = A.wallet;
  var ui = A.ui;
  var $ = ui.$;
  var el = ui.el;

  var POLL_MS = 10000;
  var FAUCET_URL = 'https://faucet.circle.com';

  var S = {
    network: null, contract: '', deployBlock: 0, id: '', memo: null, client: null, logsClient: null,
    invoice: null, status: null, latest: null, paying: false, paid: false, timer: null,
    receipt: null, bar: null, feeToken: 0, firstLoad: true, keepPayStatus: false, needsTrust: false, pendingTx: null
  };

  function fail(message) {
    ui.show('invoice-card', false);
    ui.show('pay-section', false);
    ui.setStatus('load-status', 'info', '');
    ui.setText('link-error-text', message);
    ui.show('link-error-card', true);
  }

  function usdc(units) {
    return util.formatUsdc(units, { group: true }) + ' USDC';
  }

  /** Now in chain time (the latest block), the local clock only while the chain has not been read yet. */
  function nowSec() {
    return S.latest ? S.latest.timestamp : Math.floor(Date.now() / 1000);
  }

  function whenText(ts) {
    return util.formatLocal(ts) + ' (' + util.formatUtc(ts) + '), ' + util.relativeTime(ts, nowSec());
  }

  // ------------------------------------------------------------ reading the chain

  async function readChain(signal) {
    var res = await S.client.batch([
      { method: 'eth_call', params: [{ to: S.contract, data: abi.encodeGetInvoice(S.id) }, 'latest'] },
      { method: 'eth_getBlockByNumber', params: ['latest', false] },
      { method: 'eth_chainId', params: [] }
    ], { signal: signal });
    if (res[0].error) throw res[0].error;
    if (res[1].error) throw res[1].error;
    var invoice;
    try {
      invoice = abi.decodeGetInvoice(res[0].result);
    } catch (e) {
      var err = new Error('There is no invoice contract at ' + S.contract + ' on ' + S.network.name + '. Check that the link belongs to this network.');
      err.code = 'NO_CONTRACT';
      throw err;
    }
    var block = res[1].result;
    return {
      invoice: invoice,
      latest: { number: Number(BigInt(block.number)), timestamp: Number(BigInt(block.timestamp)) },
      chainId: res[2].error ? null : parseInt(res[2].result, 16)
    };
  }

  async function refresh() {
    try {
      var r = await readChain();
      if (S.paid) return;
      S.invoice = r.invoice;
      S.latest = r.latest;
      S.status = util.statusFromChain(r.invoice, r.latest.timestamp);
      if (S.firstLoad && r.chainId !== null && r.chainId !== S.network.chainId) {
        ui.setStatus('link-warning', 'warn', 'The RPC for ' + S.network.name + ' answered with chain id ' + r.chainId + ' instead of ' + S.network.chainId + '. Do not pay unless you trust this site.');
      }
      S.firstLoad = false;
      ui.setStatus('load-status', 'info', '');
      render();
      if (S.pendingTx && S.status === 'paid' && !S.receipt) findReceipt(); // the transaction we were waiting for (or another payment) settled it
    } catch (e) {
      if (S.invoice === null) {
        ui.setStatus('load-status', 'error', 'Could not read the invoice: ' + util.explainFailure(e) + ' Trying again every ' + POLL_MS / 1000 + ' seconds.');
      }
    }
  }

  function schedule() {
    if (S.timer) root.clearTimeout(S.timer);
    S.timer = root.setTimeout(async function () {
      if (S.paid) return;
      if (!S.paying && !document.hidden) await refresh();
      schedule();
    }, POLL_MS);
  }

  // ------------------------------------------------------------ rendering

  /** The pay button is usable only for an open invoice, not mid-payment, and (for an unofficial contract) once trusted. */
  function payAllowed() {
    return S.status === 'open' && !S.paying && !S.paid && !S.pendingTx && (!S.needsTrust || $('trust-check').checked);
  }

  function renderDescription() {
    var box = ui.clear($('v-desc'));
    var inv = S.invoice;
    if (!S.memo) {
      box.appendChild(el('span', { class: 'muted' }, 'This link carries no description. Ask the merchant what the invoice is for. Only the reference hash below is stored on-chain.'));
      return { verified: false, parsed: null };
    }
    if (inv.status === abi.STATUS.None) {
      box.appendChild(el('span', { class: 'muted' }, 'The description cannot be verified until the invoice exists on-chain.'));
      return { verified: false, parsed: null };
    }
    var verified = util.verifyMemo(S.memo, inv.referenceHash);
    if (!verified) {
      box.appendChild(el('div', { class: 'status status-error', role: 'alert' }, 'WARNING: the description in this link does NOT match the invoice on the blockchain. Do not trust it, and do not pay before you have checked with the merchant.'));
      box.appendChild(el('details', null, [el('summary', null, 'Show the unverified text'), el('pre', { class: 'memo-text mono' }, util.showInvisible(S.memo))]));
      return { verified: false, parsed: null };
    }
    var parsed = util.parseMemo(S.memo);
    if (parsed) {
      if (parsed.no) box.appendChild(el('div', null, el('strong', null, 'Invoice ' + util.showInvisible(parsed.no))));
      box.appendChild(el('div', { class: 'memo-text' }, util.showInvisible(parsed.d)));
    } else {
      box.appendChild(el('div', { class: 'memo-text' }, util.showInvisible(S.memo)));
    }
    if (S.needsTrust) {
      // A matching hash proves the text belongs to this invoice, not that the contract behind it can be trusted.
      box.appendChild(el('div', { class: 'muted small' }, 'The text matches the hash on this contract, but the contract is not this site\'s official deployment.'));
    } else {
      box.appendChild(el('div', { class: 'verified small' }, 'Description verified against the on-chain hash'));
    }
    return { verified: true, parsed: parsed };
  }

  function render() {
    var inv = S.invoice;
    var net = S.network;
    ui.show('invoice-card', true);
    var badge = ui.clear($('status-badge'));
    badge.appendChild(ui.statusBadge(S.status));
    ui.setText('v-network', net.name + ' (chain ' + net.chainId + ')');
    var contractBox = ui.clear($('v-contract'));
    contractBox.appendChild(ui.explorerLink(net, 'address', S.contract, util.shortAddress(S.contract)));
    contractBox.appendChild(el('div', { class: 'small muted mono' }, S.contract));
    ui.setText('v-id', S.id);

    if (S.status === 'notfound') {
      ui.setText('v-amount', '-');
      ui.setText('v-merchant', 'unknown');
      ui.clear($('v-merchant-link'));
      ui.setText('v-due', '-');
      ui.setText('v-hash', '-');
      renderDescription();
      ui.show('paid-info', false);
      ui.show('pay-section', false);
      ui.setStatus('load-status', 'warn', 'No invoice with this id exists on this contract and network. The link may be incomplete or for another network, or the registration may still be pending. This page keeps checking.');
      return;
    }

    ui.setText('v-amount', usdc(inv.amount));
    ui.setText('v-merchant', inv.merchant);
    var mlink = ui.clear($('v-merchant-link'));
    if (util.explorerUrl(net, 'address', inv.merchant)) mlink.appendChild(ui.explorerLink(net, 'address', inv.merchant, 'View merchant on the explorer'));
    ui.setText('v-due', whenText(inv.due));
    ui.setText('v-hash', inv.referenceHash);
    renderDescription();

    var paidBox = $('paid-info');
    if (S.status === 'paid') {
      ui.show(paidBox, true);
      ui.setText('v-payer', inv.payer);
      ui.setText('v-paid-at', whenText(inv.paidAt));
    } else {
      ui.show(paidBox, false);
    }

    ui.show('pay-section', true);
    var btn = $('pay-btn');
    var summary = $('pay-summary');
    if (S.status === 'open') {
      btn.textContent = 'Pay ' + usdc(inv.amount);
      summary.textContent = 'You will send exactly ' + usdc(inv.amount) + ' to ' + util.shortAddress(inv.merchant) + ' on ' + net.name + '. The network fee is paid in USDC as well.';
      ui.show('trust-wrap', S.needsTrust);
      btn.disabled = !payAllowed();
      if (!S.paying && !S.pendingTx) ui.setStatus('pay-status', S.needsTrust && !$('trust-check').checked ? 'warn' : 'info', S.needsTrust && !$('trust-check').checked ? 'This contract is not the official deployment of this site. Tick the box above only if you trust it and whoever sent you this link.' : '');
    } else {
      var reason = {
        paid: 'This invoice has already been paid.',
        cancelled: 'The merchant cancelled this invoice. It cannot be paid.',
        expired: 'This invoice has expired (it was due ' + util.formatUtc(inv.due) + '). It cannot be paid any more; ask the merchant for a new one.'
      }[S.status];
      ui.show('trust-wrap', false);
      btn.textContent = { paid: 'Already paid', cancelled: 'Cancelled', expired: 'Expired' }[S.status];
      btn.disabled = true;
      summary.textContent = '';
      if (!S.paying && !S.keepPayStatus && !S.pendingTx) ui.setStatus('pay-status', S.status === 'paid' ? 'ok' : 'warn', reason);
      ui.setText('fee-line', '');
    }
    if (S.status === 'open') updateFee();
  }

  // ------------------------------------------------------------ fee preview

  async function updateFee() {
    var token = ++S.feeToken;
    var account = wallet.state.account;
    var line = $('fee-line');
    if (!account || S.status !== 'open' || S.paying) {
      if (!S.paying) line.textContent = account ? '' : 'Connect a wallet to see the network fee.';
      return;
    }
    try {
      var tx = { from: account, to: S.contract, data: abi.encodePay(S.id), value: util.usdcToNative(S.invoice.amount) };
      var p = await ui.prepareTx(S.client, tx);
      if (token !== S.feeToken) return;
      line.textContent = 'Estimated network fee: about ' + util.formatNativeUsdc(p.params.expectedFee) + ' USDC (at most ' + util.formatNativeUsdc(p.params.maxFee) + ' USDC).';
    } catch (e) {
      if (token !== S.feeToken) return;
      line.textContent = 'This payment would currently fail: ' + util.explainFailure(e);
    }
  }

  // ------------------------------------------------------------ paying

  function txLink(hash) {
    return ui.explorerLink(S.network, 'tx', hash, hash);
  }

  async function onPay() {
    if (S.paying || S.paid) return;
    if (S.needsTrust && !$('trust-check').checked) return;
    var status = $('pay-status');
    var btn = $('pay-btn');
    S.paying = true;
    S.keepPayStatus = false;
    btn.disabled = true;
    try {
      ui.setStatus(status, 'info', 'Connecting to your wallet...');
      var account = await S.bar.requireReady(S.network);

      // Re-read the chain so the payer never signs for an invoice that changed meanwhile.
      ui.setStatus(status, 'info', 'Checking the invoice on-chain...');
      var r = await readChain();
      S.invoice = r.invoice;
      S.latest = r.latest;
      S.status = util.statusFromChain(r.invoice, r.latest.timestamp);
      if (S.status !== 'open') {
        S.paying = false;
        render();
        return;
      }
      var inv = S.invoice;
      var value = util.usdcToNative(inv.amount);
      var tx = { from: account, to: S.contract, data: abi.encodePay(S.id), value: value, chainId: S.network.chainId, networkName: S.network.name };

      ui.setStatus(status, 'info', 'Simulating the payment...');
      var prep = await ui.prepareTx(S.client, tx, { balanceOf: account });
      var balance = prep.balance;
      var needed = value + prep.params.maxFee;
      if (balance < needed) {
        var extra = S.network.testnet ? el('a', { href: FAUCET_URL, target: '_blank', rel: 'noopener noreferrer' }, 'Get test USDC from the Circle faucet') : null;
        ui.setStatus(status, 'error', 'Not enough USDC. This account has ' + util.formatNativeUsdc(balance) + ' USDC; the payment needs ' + usdc(inv.amount) + ' plus up to ' + util.formatNativeUsdc(prep.params.maxFee) + ' USDC in network fees.', extra);
        S.paying = false;
        btn.disabled = false;
        return;
      }
      ui.setText('fee-line', 'Estimated network fee: about ' + util.formatNativeUsdc(prep.params.expectedFee) + ' USDC (at most ' + util.formatNativeUsdc(prep.params.maxFee) + ' USDC).');

      ui.setStatus(status, 'info', 'Confirm the payment of ' + usdc(inv.amount) + ' in your wallet...');
      var sent = await ui.sendAndWait(S.client, tx, prep.params, {
        onSent: function (hash) { ui.setStatus(status, 'info', 'Payment sent. Waiting for confirmation... ', txLink(hash)); }
      });

      completePayment(sent.hash, sent.receipt);
    } catch (e) {
      S.paying = false;
      if (e && e.code === 'RECEIPT_TIMEOUT') {
        // It may still confirm: keep the link, keep Pay locked, and look at the invoice again before anything else.
        S.pendingTx = e.txHash;
        ui.setStatus(status, 'warn', e.userMessage, txLink(e.txHash));
        ui.show('recheck-btn', true);
        btn.disabled = true;
        refresh();
        return;
      }
      ui.setStatus(status, 'error', util.explainFailure(e), e && e.txHash ? txLink(e.txHash) : null);
      if (e && e.code === 'TX_REVERTED') {
        S.keepPayStatus = true; // keep the failure text visible while the page re-reads the chain
        refresh();
      }
      btn.disabled = !payAllowed();
    }
  }

  /** The payment transaction is confirmed: decode our InvoicePaid log (from this contract, this invoice) and show the receipt. */
  function completePayment(hash, receipt) {
    var status = $('pay-status');
    var events = ui.eventsFromReceipt(receipt, S.contract, { type: 'InvoicePaid', id: S.id });
    if (!events.length) {
      throw new Error('The transaction was confirmed but no payment receipt event was found in it. Check the transaction in the explorer: ' + hash);
    }
    var ev = events[0];
    S.paid = true;
    S.pendingTx = null;
    if (S.timer) root.clearTimeout(S.timer);
    S.status = 'paid';
    S.invoice = Object.assign({}, S.invoice, { status: abi.STATUS.Paid, payer: ev.payer, paidAt: ev.paidAt });
    S.paying = false;
    ui.show('recheck-btn', false);
    render();
    ui.setStatus(status, 'ok', 'Payment confirmed. The invoice is paid in full. ', txLink(hash));
    showReceipt({ txHash: hash, blockNumber: ev.blockNumber, payer: ev.payer, merchant: ev.merchant, amount: ev.amount, paidAt: ev.paidAt });
    $('pay-btn').disabled = true;
    $('pay-btn').textContent = 'Paid';
  }

  /** "Check again" after a confirmation timeout: look for the receipt of the pending transaction. */
  async function checkPending() {
    var hash = S.pendingTx;
    if (!hash) return;
    var status = $('pay-status');
    ui.setStatus(status, 'info', 'Checking the chain...');
    try {
      var receipt = await S.client.getTransactionReceipt(hash);
      if (!receipt) {
        await refresh();
        if (S.status === 'paid') return;
        ui.setStatus(status, 'warn', 'The transaction is still not confirmed. It may still confirm: check the transaction link and the invoice status before paying again.', txLink(hash));
        return;
      }
      if (receipt.status === '0x0' || receipt.status === 0) {
        var reason = null;
        try { reason = await util.replayFailedTx(S.client, { from: wallet.state.account, to: S.contract, data: abi.encodePay(S.id), value: util.usdcToNative(S.invoice.amount) }, receipt); } catch (re) { reason = null; }
        S.pendingTx = null;
        ui.show('recheck-btn', false);
        ui.setStatus(status, 'error', util.failedOnChainMessage(reason), txLink(hash));
        await refresh();
        $('pay-btn').disabled = !payAllowed();
        return;
      }
      completePayment(hash, receipt);
    } catch (e) {
      ui.setStatus(status, 'error', util.explainFailure(e), txLink(hash));
    }
  }

  // ------------------------------------------------------------ receipt

  function showReceipt(r) {
    S.receipt = r;
    var net = S.network;
    var verifiedMemo = S.memo && util.verifyMemo(S.memo, S.invoice.referenceHash) ? util.parseMemo(S.memo) : null;
    ui.setText('r-amount', usdc(r.amount));
    ui.setText('r-merchant', r.merchant);
    ui.setText('r-payer', r.payer);
    ui.setText('r-time', util.formatLocal(r.paidAt) + ' (' + util.formatUtc(r.paidAt) + ')');
    ui.clear($('r-tx')).appendChild(txLink(r.txHash));
    var desc = ui.clear($('r-desc'));
    if (verifiedMemo) desc.appendChild(document.createTextNode(util.showInvisible((verifiedMemo.no ? verifiedMemo.no + ': ' : '') + verifiedMemo.d)));
    else desc.appendChild(el('span', { class: 'muted' }, 'Reference hash ' + S.invoice.referenceHash));
    ui.setText('r-id', S.id);
    ui.setText('r-net', net.name + ', contract ' + S.contract);
    ui.show('receipt-card', true);
  }

  function receiptJson() {
    var r = S.receipt;
    var memo = S.memo && util.verifyMemo(S.memo, S.invoice.referenceHash) ? util.parseMemo(S.memo) : null;
    return JSON.stringify({
      type: 'arc-invoice-receipt',
      network: S.network.key,
      chainId: S.network.chainId,
      contract: S.contract,
      invoiceId: S.id,
      referenceHash: S.invoice.referenceHash,
      invoiceNumber: memo ? memo.no : null,
      description: memo ? memo.d : null,
      merchant: r.merchant,
      payer: r.payer,
      amountUsdc: util.formatUsdc(r.amount, { fixed: true }),
      amountUnits: r.amount.toString(),
      paidAtUnix: r.paidAt,
      paidAtUtc: util.toIsoUtc(r.paidAt),
      transactionHash: r.txHash,
      blockNumber: r.blockNumber,
      explorerUrl: util.explorerUrl(S.network, 'tx', r.txHash) || null
    }, null, 2) + '\n';
  }

  async function findReceipt() {
    var btn = $('find-receipt-btn');
    var status = $('find-status');
    btn.disabled = true;
    ui.setStatus(status, 'info', 'Searching the chain for the payment...');
    try {
      var latestNumber = await S.logsClient.blockNumber();
      var first = await rpc.findFirstBlockAtOrAfter(S.logsClient, S.invoice.paidAt, { lo: S.deployBlock, hi: latestNumber });
      if (first === null) throw new Error('The block of the payment could not be located.');
      var logs = [];
      var from = first;
      // Several blocks can share one timestamp: look at a window after the first matching block, widening once.
      var windows = [60, 2000];
      for (var i = 0; i < windows.length && !logs.length; i++) {
        var to = Math.min(first + windows[i], latestNumber);
        logs = await S.logsClient.getLogs({ address: S.contract, topics: [abi.TOPICS.InvoicePaid, S.id], fromBlock: from, toBlock: to });
      }
      var ev = abi.decodeLogs(logs, S.contract).filter(function (x) { return x.type === 'InvoicePaid' && x.id === S.id; })[0];
      if (!ev) throw new Error('The payment transaction was not found near that time. You can look the contract up in the explorer instead.');
      ui.setStatus(status, 'ok', 'Found it. ');
      showReceipt({ txHash: ev.txHash, blockNumber: ev.blockNumber, payer: ev.payer, merchant: ev.merchant, amount: ev.amount, paidAt: ev.paidAt });
      status.appendChild(txLink(ev.txHash));
    } catch (e) {
      ui.setStatus(status, 'error', util.explainFailure(e));
      btn.disabled = false;
    }
  }

  // ------------------------------------------------------------ start

  function start() {
    try {
      startPage();
    } catch (e) {
      fail('This link is malformed or cannot be used on this page. Ask the sender for a fresh link.');
    }
  }

  function startPage() {
    ui.initChrome();
    root.addEventListener('hashchange', function () { root.location.reload(); });
    var link = util.parsePayFragment(root.location.hash);
    if (link.errors.length) return fail(link.errors.join(' '));
    var key = link.net || ui.cfg.defaultNetwork;
    var network = Object.prototype.hasOwnProperty.call(ui.cfg.networks, key) ? ui.cfg.networks[key] : null; // 'constructor' and friends are not networks
    if (!network) return fail('The network "' + key + '" in this link is not known to this site.');
    ui.updateBanner(network);
    var dep = ui.deploymentOf(key);
    var contract = link.contract || dep.contract;
    if (!contract) return fail('No contract is configured for ' + network.name + ' on this site and the link does not name one, so there is nothing to read.');
    if (!abi.isAddress(contract)) return fail('The contract address configured for ' + network.name + ' is not valid.');
    contract = abi.toChecksumAddress(contract);

    S.network = network;
    S.contract = contract;
    S.deployBlock = dep.deployBlock;
    S.id = link.id;
    S.memo = link.memo;
    S.client = ui.makeClient(network);
    S.logsClient = ui.makeLogsClient(network);
    ui.updateBanner(network);
    $('nav-receipts').href = 'receipts.html#net=' + encodeURIComponent(key);

    S.needsTrust = !!link.contract && link.contract.toLowerCase() !== (dep.contract || '').toLowerCase();
    if (link.contract && dep.contract && link.contract.toLowerCase() !== dep.contract.toLowerCase()) {
      ui.setStatus('link-warning', 'warn', 'This link points to a contract that is not this site\'s official deployment (' + dep.contract + '). Only go on if you trust whoever sent you the link.');
    } else if (link.contract && !dep.contract) {
      ui.setStatus('link-warning', 'warn', 'This site has no official deployment configured for ' + network.name + ', so the contract named in the link could not be checked against it.');
    }

    S.bar = ui.bindWalletBar({ getNetwork: function () { return network; }, onChange: function () { if (S.invoice && S.status === 'open' && !S.paying) updateFee(); } });
    $('pay-btn').addEventListener('click', onPay);
    $('recheck-btn').addEventListener('click', checkPending);
    $('trust-check').addEventListener('change', function () { if (S.invoice) render(); });
    $('find-receipt-btn').addEventListener('click', findReceipt);
    $('download-receipt-btn').addEventListener('click', function () {
      ui.downloadText('arc-receipt-' + S.id.slice(2, 10) + '.json', receiptJson(), 'application/json');
    });
    $('print-receipt-btn').addEventListener('click', function () {
      document.body.classList.add('printing-receipt');
      root.addEventListener('afterprint', function done() {
        document.body.classList.remove('printing-receipt');
        root.removeEventListener('afterprint', done);
      });
      root.print();
    });

    refresh().then(schedule);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})(typeof globalThis !== 'undefined' ? globalThis : this);
