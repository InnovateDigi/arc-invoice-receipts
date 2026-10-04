/* Receipts page controller: scans InvoiceReceipts events for a merchant or payer, folds them into a table, exports CSV. */
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
  var CACHE_PREFIX = 'arcInvoice.cache.v2.';
  var CACHE_MAX_CHARS = 2000000; // above this the scan is not cached (browser storage is small and shared)
  var ROWS_PER_PAGE = 300;
  var RPC_KEY_PREFIX = 'arcInvoice.rpcOverride.';
  var RANGE_SECONDS = { '30d': 30 * 86400, '7d': 7 * 86400, '24h': 86400 };

  var S = {
    network: null, contract: '', deployBlock: 0, client: null, mode: 'merchant', address: '',
    events: [], records: [], latest: null, scanning: false, controller: null, coverage: null,
    store: ui.localStore(), memos: {}, descCache: Object.create(null), shown: ROWS_PER_PAGE
  };

  function usdc(units) {
    return util.formatUsdc(units, { group: true }) + ' USDC';
  }

  function dash() {
    return el('span', { class: 'muted' }, '—');
  }

  // ------------------------------------------------------------ inputs

  function modeValue() {
    var checked = document.querySelector('input[name="mode"]:checked');
    return checked ? checked.value : 'merchant';
  }

  function updateModeLabels() {
    var merchant = modeValue() === 'merchant';
    ui.setText('addr-label', merchant ? 'Merchant address' : 'Payer address');
    ui.setText('addr-hint', merchant ? 'The account that registered the invoices (0x and 40 hex characters, any capitalisation).' : 'The account that paid the invoices (0x and 40 hex characters, any capitalisation).');
  }

  /** Validate the address field; returns the checksummed address or null. Shows messages. */
  function readAddress(showErrors) {
    var raw = $('addr-input').value.trim();
    var input = $('addr-input');
    ui.setText('addr-checksum', '');
    if (!raw) {
      if (showErrors) ui.setText('addr-error', 'Enter an address.');
      input.setAttribute('aria-invalid', 'true');
      return null;
    }
    if (!abi.isAddress(raw)) {
      ui.setText('addr-error', 'That is not an address: it must be 0x followed by 40 hex characters.');
      input.setAttribute('aria-invalid', 'true');
      return null;
    }
    var checksummed = abi.toChecksumAddress(raw);
    input.removeAttribute('aria-invalid');
    ui.setText('addr-checksum', 'Checksummed address: ' + checksummed);
    if (!abi.hasValidChecksum(raw)) {
      ui.setText('addr-error', 'Warning: the capitalisation does not match the address checksum, so there may be a typo. Checksummed form: ' + checksummed);
    } else {
      ui.setText('addr-error', '');
    }
    return checksummed;
  }

  /** Cache key of one scan: network, contract, mode, address and (for a custom RPC) a short tag of its URL. */
  function cacheKey(snap) {
    var tag = snap.rpcUrl ? '.rpc' + util.memoHash(snap.rpcUrl).slice(2, 12) : '';
    return CACHE_PREFIX + [snap.network.key, snap.contract.toLowerCase(), snap.mode, snap.address.toLowerCase()].join('.') + tag;
  }

  // ------------------------------------------------------------ scanning

  async function resolveFrom(snap, range, latest, signal) {
    if (range === 'deploy') return snap.deployBlock;
    if (range === 'custom') {
      var txt = $('from-block').value.trim();
      if (!/^\d{1,15}$/.test(txt)) throw new Error('Enter the block number to start from (digits only).');
      return Math.min(Number(txt), latest.number);
    }
    var ts = latest.timestamp - RANGE_SECONDS[range];
    var b = await rpc.findFirstBlockAtOrAfter(snap.client, ts, { lo: snap.deployBlock, hi: latest.number, signal: signal });
    return b === null ? latest.number : b;
  }

  // The controls whose values a running scan depends on stay locked until it ends (Cancel stays available).
  var LOCKED_WHILE_SCANNING = ['net-select', 'addr-input', 'range-select', 'from-block', 'rpc-input', 'use-wallet-btn'];

  function setScanning(on) {
    S.scanning = on;
    $('load-btn').disabled = on;
    $('rescan-btn').disabled = on;
    LOCKED_WHILE_SCANNING.forEach(function (id) { if ($(id)) $(id).disabled = on; });
    Array.prototype.forEach.call(document.querySelectorAll('input[name="mode"]'), function (r) { r.disabled = on; });
    ui.show('cancel-btn', on);
    ui.show('progress-wrap', on || $('progress-text').textContent !== '');
  }

  function onProgress(p) {
    var bar = $('progress');
    bar.max = Math.max(1, p.totalBlocks);
    bar.value = p.scannedBlocks;
    ui.setText('progress-text', 'Scanned ' + util.formatCount(p.scannedBlocks) + ' of ' + util.formatCount(p.totalBlocks) + ' blocks. Events found: ' + p.logsFound + '.' + (p.endpoint ? ' Reading from ' + p.endpoint + '.' : ''));
  }

  /** Save a scan in the browser: packed events only, skipped when too big or when storage refuses (the page keeps working). */
  function saveCache(key, first, last, events) {
    var packed = util.packEvents(events);
    if (JSON.stringify(packed).length > CACHE_MAX_CHARS) {
      S.store.remove(key);
      ui.setStatus('table-status', 'warn', 'This scan is too large to keep in the browser, so the next load will start from scratch.');
      return;
    }
    var ok = S.store.set(key, { v: 2, firstScannedBlock: first, lastScannedBlock: last, events: packed });
    if (!ok) ui.setStatus('table-status', 'warn', 'Could not save the scan to this browser (storage is unavailable or full). The next load will scan again.');
  }

  async function load(rescan) {
    if (S.scanning) return;
    var address = readAddress(true);
    if (!address) return;
    if (!S.contract) return;
    var rpcCheck = ui.validateRpcUrl($('rpc-input').value);
    if (!rpcCheck.ok) {
      ui.setText('rpc-error', rpcCheck.error);
      $('advanced').open = true;
      return;
    }
    ui.setText('rpc-error', '');
    if (rpcCheck.url) S.store.set(RPC_KEY_PREFIX + S.network.key, rpcCheck.url);
    else S.store.remove(RPC_KEY_PREFIX + S.network.key);
    // Everything the scan needs is copied here once. Nothing below reads S.network, S.contract or S.mode again, so
    // whatever happens to the page controls while the scan runs cannot send its results to the wrong place.
    var snap = {
      network: S.network, contract: S.contract, deployBlock: S.deployBlock, mode: modeValue(), address: address,
      rpcUrl: rpcCheck.url, client: ui.makeLogsClient(S.network, rpcCheck.url), range: $('range-select').value
    };
    S.client = snap.client;
    S.address = address;
    S.mode = snap.mode;
    S.memos = util.loadMemos(S.store);
    S.descCache = Object.create(null);
    var key = cacheKey(snap);
    var cached = rescan ? null : S.store.get(key, null);
    S.controller = new AbortController();
    var signal = S.controller.signal;
    ui.setStatus('scan-status', 'info', '');
    ui.setStatus('table-status', 'info', '');
    $('progress-text').textContent = '';
    setScanning(true);
    var scanFrom = 0;
    var firstCovered = 0;
    var events = [];
    try {
      ui.setStatus('scan-status', 'info', 'Reading the latest block...');
      var latest = await snap.client.getBlock('latest', { signal: signal });
      S.latest = latest;
      var from = await resolveFrom(snap, snap.range, latest, signal);
      var toBlock = latest.number;
      scanFrom = from;
      firstCovered = from;
      var usable = false;
      if (cached && cached.v === 2 && cached.firstScannedBlock <= from && cached.lastScannedBlock >= from - 1 && cached.lastScannedBlock <= toBlock) {
        try {
          events = util.unpackEvents(cached.events);
          usable = true;
        } catch (corrupt) {
          events = [];
        }
      }
      if (usable) {
        scanFrom = Math.max(from, cached.lastScannedBlock + 1);
        firstCovered = cached.firstScannedBlock;
        ui.setStatus('scan-status', 'info', 'Using the saved scan up to block ' + cached.lastScannedBlock + '; reading ' + Math.max(0, toBlock - scanFrom + 1) + ' new blocks.');
      } else {
        ui.setStatus('scan-status', 'info', 'Scanning blocks ' + from + ' to ' + toBlock + '...');
      }
      onProgress({ scannedBlocks: 0, totalBlocks: Math.max(0, toBlock - scanFrom + 1), logsFound: 0 });

      var merchantMode = snap.mode === 'merchant';
      var topics = merchantMode
        ? [[abi.TOPICS.InvoiceRegistered, abi.TOPICS.InvoicePaid, abi.TOPICS.InvoiceCancelled], null, abi.addressTopic(snap.address)]
        : [abi.TOPICS.InvoicePaid, null, null, abi.addressTopic(snap.address)];
      var result = await rpc.scanLogs({
        client: snap.client, address: snap.contract, topics: topics, fromBlock: scanFrom, toBlock: toBlock,
        signal: signal, onProgress: onProgress // concurrency and chunk size follow the endpoint that is serving
      });
      events = util.mergeEvents(events, abi.decodeLogs(result.logs, snap.contract));
      S.events = events;
      S.shown = ROWS_PER_PAGE;
      S.coverage = { first: firstCovered, last: toBlock };
      saveCache(key, firstCovered, toBlock, events);
      render();
      ui.setStatus('scan-status', 'ok', 'Done. ' + events.length + ' events up to block ' + toBlock + '.');
    } catch (e) {
      var partial = e && e.partial;
      if (partial && partial.scannedThrough >= scanFrom) {
        events = util.mergeEvents(events, abi.decodeLogs(partial.logs, snap.contract));
        S.events = events;
        S.shown = ROWS_PER_PAGE;
        S.coverage = { first: firstCovered, last: partial.scannedThrough };
        saveCache(key, firstCovered, partial.scannedThrough, events);
        render();
      }
      var resume = partial && partial.scannedThrough >= scanFrom ? ' Progress up to block ' + partial.scannedThrough + ' is saved: press Load to continue from there.' : '';
      if (e && e.name === 'AbortError') ui.setStatus('scan-status', 'warn', 'Scan cancelled.' + resume);
      else ui.setStatus('scan-status', 'error', 'The scan stopped: ' + util.explainFailure(e) + resume);
    } finally {
      setScanning(false);
      S.controller = null;
    }
  }

  // ------------------------------------------------------------ table

  /** Description for a record from the local memo store (verified against the hash), else null. */
  function describe(record) {
    var h = record.referenceHash;
    if (!h) return null;
    var k = h.toLowerCase();
    if (k in S.descCache) return S.descCache[k];
    var memo = S.memos[k];
    var parsed = memo && util.verifyMemo(memo, h) ? util.parseMemo(memo) : null;
    S.descCache[k] = parsed;
    return parsed;
  }

  function invoiceCell(r) {
    var d = describe(r);
    if (d) {
      var box = el('div');
      if (d.no) box.appendChild(el('div', null, el('strong', null, util.showInvisible(d.no))));
      box.appendChild(el('div', { class: 'memo-text' }, util.showInvisible(d.d)));
      return box;
    }
    if (!r.referenceHash) return dash();
    return el('code', { title: r.referenceHash }, util.shortHash(r.referenceHash, 10));
  }

  function txCell(hash) {
    if (!hash) return dash();
    return ui.explorerLink(S.network, 'tx', hash, util.shortHash(hash, 8) + '…');
  }

  function timeCell(ts) {
    return ts === null || ts === undefined ? dash() : el('span', { title: util.formatUtc(ts) }, util.formatLocal(ts));
  }

  function addressCell(a) {
    return a ? el('code', { title: a }, util.shortAddress(a)) : dash();
  }

  function visibleRecords() {
    var filter = $('status-filter').value;
    var ts = S.latest ? S.latest.timestamp : null;
    return S.records.filter(function (r) { return filter === 'all' || util.effectiveStatus(r, ts) === filter; });
  }

  function payLinkFor(r) {
    var memo = S.memos[(r.referenceHash || '').toLowerCase()];
    return util.buildPayLink(util.pageDirectory(root.location.href), { net: S.network.key, contract: S.contract, id: r.id, memo: memo && util.verifyMemo(memo, r.referenceHash) ? memo : '' });
  }

  /** Short name of an invoice for button labels: its number when known locally, else its id start. */
  function invoiceName(r) {
    var d = describe(r);
    return d && d.no ? util.showInvisible(d.no) : util.shortHash(r.id, 6);
  }

  /** True when the connected wallet is this invoice's merchant (the only account that can cancel it). */
  function walletIsMerchant(r) {
    return !!wallet.state.account && wallet.state.account.toLowerCase() === r.merchant.toLowerCase();
  }

  function actionsCell(r, st) {
    var cell = el('div', { class: 'row' });
    if (S.mode !== 'merchant' || st !== 'open') return cell;
    var copy = el('button', { type: 'button', class: 'btn-small', 'aria-label': 'Copy pay link for invoice ' + invoiceName(r) }, 'Copy pay link');
    ui.copyButton(copy, function () { return payLinkFor(r); });
    cell.appendChild(copy);
    // Cancel is offered only to the connected merchant account, for an invoice that is open and not expired.
    if (walletIsMerchant(r)) {
      cell.appendChild(el('button', { type: 'button', class: 'btn-small', 'aria-label': 'Cancel invoice ' + invoiceName(r), on: { click: function () { cancelInvoice(r); } } }, 'Cancel'));
    }
    return cell;
  }

  function renderHead() {
    var cols = S.mode === 'merchant'
      ? [['Invoice'], ['Amount', 'num'], ['Created'], ['Due'], ['Status'], ['Payer'], ['Paid'], ['Receipt'], ['']]
      : [['Invoice'], ['Amount', 'num'], ['Merchant'], ['Paid'], ['Receipt']];
    var tr = el('tr');
    cols.forEach(function (c) { tr.appendChild(el('th', { scope: 'col', class: c[1] || null }, c[0])); });
    ui.clear($('table-head')).appendChild(tr);
  }

  function render() {
    var ts = S.latest ? S.latest.timestamp : null;
    S.records = util.foldEvents(S.events);
    ui.show('results', true);
    renderHead();

    var sum = util.summarize(S.records, ts);
    var totals = ui.clear($('totals'));
    function stat(label, value) {
      totals.appendChild(el('div', { class: 'stat' }, [el('div', { class: 'muted small' }, label), el('div', { class: 'v' }, value)]));
    }
    if (S.mode === 'merchant') {
      stat('Paid total', usdc(sum.paidTotal) + ' (' + sum.counts.paid + ')');
      stat('Outstanding (open, not expired)', usdc(sum.outstandingTotal) + ' (' + sum.counts.open + ')');
      stat('Expired', String(sum.counts.expired));
      stat('Cancelled', String(sum.counts.cancelled));
      stat('Invoices', String(sum.counts.total));
    } else {
      stat('Total paid', usdc(sum.paidTotal));
      stat('Payments', String(sum.counts.paid));
    }

    renderRows();
    var partialCount = S.records.filter(function (r) { return !r.registered && S.mode === 'merchant'; }).length;
    ui.setText('coverage', (S.coverage ? 'Scanned blocks ' + S.coverage.first + ' to ' + S.coverage.last + ' on ' + S.network.name + ' (contract ' + S.contract + '). ' : '') +
      (ts !== null ? 'Chain time at the latest block: ' + util.formatUtc(ts) + '. ' : '') +
      (partialCount ? partialCount + ' invoice(s) were registered before the scanned range, so some of their details are missing; choose a longer range to see them.' : ''));
  }

  /** The table body: only the first S.shown rows are built (newest first); totals and the CSV always use the full list. */
  function renderRows() {
    var ts = S.latest ? S.latest.timestamp : null;
    var all = visibleRecords().slice().reverse();
    var rows = all.slice(0, S.shown);
    var body = ui.clear($('rows'));
    if (!all.length) {
      var colspan = S.mode === 'merchant' ? 9 : 5;
      body.appendChild(el('tr', null, el('td', { colspan: colspan, class: 'muted' }, S.records.length ? 'No rows match this filter.' : 'No events found for this address in the scanned range.')));
    }
    rows.forEach(function (r) {
      var st = util.effectiveStatus(r, ts);
      var tr = el('tr');
      if (S.mode === 'merchant') {
        tr.appendChild(el('td', { class: 'desc' }, invoiceCell(r)));
        tr.appendChild(el('td', { class: 'num' }, r.amount === null ? dash() : usdc(r.amount)));
        tr.appendChild(el('td', { class: 'nowrap' }, timeCell(r.createdAt)));
        tr.appendChild(el('td', { class: 'nowrap' }, timeCell(r.due)));
        tr.appendChild(el('td', { class: 'nowrap' }, ui.statusBadge(st)));
        tr.appendChild(el('td', { class: 'nowrap' }, addressCell(r.payer)));
        tr.appendChild(el('td', { class: 'nowrap' }, timeCell(r.paidAt)));
        tr.appendChild(el('td', { class: 'nowrap' }, txCell(r.paymentTx)));
        tr.appendChild(el('td', { class: 'nowrap' }, actionsCell(r, st)));
      } else {
        tr.appendChild(el('td', { class: 'desc' }, invoiceCell(r)));
        tr.appendChild(el('td', { class: 'num' }, r.amount === null ? dash() : usdc(r.amount)));
        tr.appendChild(el('td', { class: 'nowrap' }, addressCell(r.merchant)));
        tr.appendChild(el('td', { class: 'nowrap' }, timeCell(r.paidAt)));
        tr.appendChild(el('td', { class: 'nowrap' }, txCell(r.paymentTx)));
      }
      body.appendChild(tr);
    });
    var left = all.length - rows.length;
    var more = $('more-btn');
    more.hidden = left <= 0;
    more.textContent = 'Show more (' + left + ' left)';
    $('csv-btn').textContent = 'Export CSV (' + all.length + (all.length === 1 ? ' row)' : ' rows)');
    $('csv-btn').disabled = all.length === 0;
    var hint = $('cancel-hint');
    if (hint) hint.hidden = !(S.mode === 'merchant' && all.some(function (r) { return util.effectiveStatus(r, ts) === 'open'; }) && !all.some(function (r) { return walletIsMerchant(r); }));
  }

  // ------------------------------------------------------------ CSV

  function exportCsv() {
    var records = visibleRecords();
    var ts = S.latest ? S.latest.timestamp : null;
    var csv = util.buildInvoiceCsv(records, { network: S.network.key, contract: S.contract, memos: S.memos, latestTimestamp: ts });
    var name = util.csvFilename(S.network.key, S.address, new Date(), S.mode === 'merchant' ? 'invoices' : 'payments');
    ui.downloadText(name, csv, 'text/csv;charset=utf-8');
    ui.setStatus('table-status', 'ok', 'Saved ' + records.length + ' rows as ' + name + '.');
  }

  // ------------------------------------------------------------ cancelling an invoice

  async function cancelInvoice(r) {
    var status = 'table-status';
    if (!root.confirm('Cancel this invoice? A cancelled invoice can never be paid, and the same reference cannot be registered again. This sends a transaction from your wallet.')) return;
    var network = S.network;
    var contract = S.contract;
    var txClient = ui.makeClient(network); // the built-in endpoint list, never the custom RPC typed into the scan form
    try {
      ui.setStatus(status, 'info', 'Connecting to your wallet...');
      if (!wallet.state.account) await wallet.connect();
      if (wallet.state.chainId !== network.chainId) await wallet.ensureChain(network);
      var account = wallet.state.account;
      if (account.toLowerCase() !== r.merchant.toLowerCase()) {
        ui.setStatus(status, 'error', 'Connect the merchant account (' + r.merchant + ') to cancel this invoice. The wallet is using ' + abi.toChecksumAddress(account) + '.');
        return;
      }
      var tx = { from: account, to: contract, data: abi.encodeCancel(r.id), chainId: network.chainId };
      var prep = await ui.prepareTx(txClient, tx);
      ui.setStatus(status, 'info', 'Confirm the cancellation in your wallet...');
      var sent = await ui.sendAndWait(txClient, tx, prep.params, {
        onSent: function (hash) { ui.setStatus(status, 'info', 'Sent. Waiting for confirmation... ', ui.explorerLink(network, 'tx', hash, util.shortHash(hash, 8) + '…')); }
      });
      var evs = ui.eventsFromReceipt(sent.receipt, contract, { type: 'InvoiceCancelled', id: r.id });
      if (evs.length) {
        S.events = util.mergeEvents(S.events, evs);
        render();
      }
      ui.setStatus(status, 'ok', 'Invoice cancelled. ', ui.explorerLink(network, 'tx', sent.hash, util.shortHash(sent.hash, 8) + '…'));
    } catch (e) {
      ui.setStatus(status, 'error', util.explainFailure(e), e && e.txHash ? ui.explorerLink(network, 'tx', e.txHash, util.shortHash(e.txHash, 8) + '…') : null);
    }
  }

  // ------------------------------------------------------------ network and start

  function selectNetwork(key) {
    var net = ui.cfg.networks[key];
    var dep = ui.deploymentOf(key);
    S.network = net;
    S.contract = dep.contract ? abi.toChecksumAddress(dep.contract) : '';
    S.deployBlock = dep.deployBlock;
    S.client = ui.makeLogsClient(net);
    ui.updateBanner(net);
    $('nav-receipts').href = 'receipts.html#net=' + encodeURIComponent(key);
    S.events = [];
    S.records = [];
    ui.show('results', false);
  }

  function fillFromWallet() {
    var acct = wallet.state.account;
    if (!acct) return false;
    $('addr-input').value = abi.toChecksumAddress(acct);
    readAddress(false);
    return true;
  }

  function start() {
    ui.initChrome();
    var frag = util.parseReceiptsFragment(root.location.hash);
    var nets = ui.selectableNetworks(frag.net);
    var select = $('net-select');
    updateModeLabels();

    if (!nets.length) {
      ui.setStatus('no-contract', 'warn', 'No invoice contract is configured on this copy of the site yet (see js/deployments.js), so there is nothing to read.');
      select.disabled = true;
      ['load-btn', 'rescan-btn', 'use-wallet-btn'].forEach(function (id) { $(id).disabled = true; });
      var def = ui.cfg.networks[ui.cfg.defaultNetwork];
      if (def) ui.updateBanner(def);
      return;
    }
    nets.forEach(function (n) { select.appendChild(el('option', { value: n.key }, n.name + ' (chain ' + n.chainId + ')')); });
    var initial = nets.filter(function (n) { return n.key === frag.net; })[0] || nets.filter(function (n) { return n.key === ui.cfg.defaultNetwork; })[0] || nets[0];
    if (frag.net && frag.net !== initial.key) {
      ui.setStatus('no-contract', 'warn', 'No invoice contract is configured for the network named in the link ("' + frag.net + '") on this copy of the site, so ' + initial.name + ' is shown instead.');
    }
    select.value = initial.key;
    selectNetwork(initial.key);
    function prefillRpc() {
      var saved = S.store.get(RPC_KEY_PREFIX + S.network.key, '');
      $('rpc-input').value = typeof saved === 'string' ? saved : '';
      if ($('rpc-input').value) $('advanced').open = true;
    }
    prefillRpc();
    select.addEventListener('change', function () { selectNetwork(select.value); prefillRpc(); });

    var startAddress = frag.payer || frag.merchant || '';
    if (frag.payer) {
      document.querySelector('input[name="mode"][value="payer"]').checked = true;
      updateModeLabels();
    }
    if (startAddress) $('addr-input').value = startAddress;
    S.mode = modeValue();

    Array.prototype.forEach.call(document.querySelectorAll('input[name="mode"]'), function (r) {
      r.addEventListener('change', function () {
        updateModeLabels();
        S.mode = modeValue();
        S.events = [];
        ui.show('results', false);
      });
    });
    $('addr-input').addEventListener('input', function () { if ($('addr-input').value.trim()) readAddress(false); else ui.setText('addr-error', ''); });
    $('range-select').addEventListener('change', function () { ui.show('custom-wrap', $('range-select').value === 'custom'); });
    $('status-filter').addEventListener('change', function () { S.shown = ROWS_PER_PAGE; if (S.events.length || S.records.length) renderRows(); });
    $('more-btn').addEventListener('click', function () { S.shown += ROWS_PER_PAGE; renderRows(); });
    root.addEventListener('hashchange', function () { root.location.reload(); });
    wallet.subscribe(function () { if (S.records.length && !S.scanning) renderRows(); });
    $('scan-form').addEventListener('submit', function (ev) { ev.preventDefault(); load(false); });
    $('rescan-btn').addEventListener('click', function () { load(true); });
    $('cancel-btn').addEventListener('click', function () { if (S.controller) S.controller.abort(); });
    $('csv-btn').addEventListener('click', exportCsv);
    $('use-wallet-btn').addEventListener('click', async function () {
      ui.setText('wallet-status', 'Waiting for your wallet...');
      try {
        await wallet.connect();
        fillFromWallet();
        ui.setText('wallet-status', '');
      } catch (e) {
        ui.setText('wallet-status', util.explainFailure(e));
      }
    });

    root.addEventListener('load', function () {
      wallet.refresh().then(function () { if (!$('addr-input').value.trim()) fillFromWallet(); });
    });
    if (startAddress) {
      readAddress(false);
      load(false);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})(typeof globalThis !== 'undefined' ? globalThis : this);
