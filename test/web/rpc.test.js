'use strict';
/*
 * Unit tests for web/js/rpc.js (JSON-RPC client, paged eth_getLogs scanner, block search, receipt polling).
 *
 * No sockets and no real network: FakeRpcServer (below) is an in-memory JSON-RPC node whose fetch(url, init) is injected into
 * createClient. It answers single requests and batches, models a synthetic chain (block n has timestamp base + floor(n / 2)),
 * synthetic logs, Arc's eth_getLogs range limit (-32012 above maxRange blocks), and injects failures: -32014, -32005, HTTP
 * 429/500/503/400, thrown TypeError('Failed to fetch'), hanging requests that only end when init.signal aborts, non-JSON
 * bodies and EVM reverts (code 3 + data). Latency is measured in event-loop turns (setImmediate hops), so completion order
 * can be shuffled deterministically without real waiting. Backoff sleeps are injected (no-op) in every test except the few
 * that deliberately exercise the real default sleep / timeoutMs with tiny values.
 *
 * Tests marked "Known module bug" below are red on purpose: they pin a real defect of web/js/rpc.js (do not weaken them):
 *   - findFirstBlockAtOrAfter does not forward { signal } to the initial client.blockNumber() call
 *   - waitForReceipt does not guard opts.onTick (a throwing UI callback rejects the wait)
 *   - scanLogs/client.setLogRange can raise the remembered log range again after a smaller one was learned
 */
const assert = require('node:assert/strict');
const rpc = require('../../web/js/rpc.js');

const {
  MAX_LOG_RANGE, RpcError, abortError, normalizeError, isRetryable, isRangeTooLarge,
  createClient, compareLogs, scanLogs, findFirstBlockAtOrAfter, waitForReceipt, hexNumber, parseHexNumber
} = rpc;

// ------------------------------------------------------------------------------------------------ test helpers

const RPC_URL = 'https://rpc.arc-testnet.example/';
const CONTRACT = '0x' + 'ab'.repeat(20);
const OTHER_CONTRACT = '0x' + 'cd'.repeat(20);
const TOPIC0 = '0x' + '11'.repeat(32);
// Error(string) revert payload for "boom"
const REVERT_DATA = '0x08c379a0' + '00'.repeat(31) + '20' + '00'.repeat(31) + '04' + Buffer.from('boom').toString('hex').padEnd(64, '0');

const hex = (n) => '0x' + n.toString(16);
const pad64 = (n) => n.toString(16).padStart(64, '0');
const blockHash = (n) => '0x' + pad64(Math.max(n, 0));
const tick = () => new Promise((resolve) => setImmediate(resolve)); // one event-loop turn
const sleepNoop = async () => {};
const random05 = () => 0.5; // jitter factor exactly 1.0

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What a real fetch rejects with when init.signal aborts. */
function domAbort() {
  return new DOMException('This operation was aborted', 'AbortError');
}

function respond(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(JSON.stringify(body)),
    text: async () => JSON.stringify(body)
  };
}

function rpcErr(code, message, data) {
  const e = new Error(message);
  e.rpc = data === undefined ? { code, message } : { code, message, data };
  return e;
}

function toNum(v, head) {
  if (typeof v === 'number') return v;
  if (v === 'latest' || v === 'pending' || v === 'safe' || v === 'finalized') return head;
  if (v === 'earliest') return 0;
  return Number(BigInt(v));
}

const RPC_FAILURES = {
  '-32014': { code: -32014, message: 'block is not yet imported' },
  '-32005': { code: -32005, message: 'rate limit exceeded' },
  '-32012': { code: -32012, message: 'block range too large' },
  '-32000': { code: -32000, message: 'header not found' },
  revert: { code: 3, message: 'execution reverted: boom', data: REVERT_DATA }
};
const HTTP_FAILURES = new Set(['http400', 'http429', 'http500', 'http503', 'network', 'hang', 'badjson']);

function matchesAddress(log, address) {
  if (address === undefined || address === null) return true;
  return (Array.isArray(address) ? address : [address]).some((a) => String(a).toLowerCase() === log.address.toLowerCase());
}

function matchesTopics(log, topics) {
  if (!topics) return true;
  return topics.every((t, i) => t === null || t === undefined ||
    (Array.isArray(t) ? t : [t]).some((x) => String(x).toLowerCase() === String(log.topics[i]).toLowerCase()));
}

/** Numeric (blockNumber, logIndex) order, implemented independently of rpc.compareLogs. */
function numericLogCompare(a, b) {
  const byBlock = BigInt(a.blockNumber) - BigInt(b.blockNumber);
  if (byBlock !== 0n) return byBlock < 0n ? -1 : 1;
  const byIndex = BigInt(a.logIndex) - BigInt(b.logIndex);
  return byIndex < 0n ? -1 : byIndex > 0n ? 1 : 0;
}

class FakeRpcServer {
  /**
   * opts: chainId, head (latest block), baseTimestamp, maxRange (max blocks per eth_getLogs; Arc: 10,000), rangeError,
   * latency(callRecord) -> event-loop turns to wait before answering, batchMode ('ok' | 'reverse' | 'shuffle' | 'drop-last' |
   * 'object' (answer batches with one non-array object) | 'http400'), logOrder ('asc' | 'desc' | 'shuffle'), omitBaseFee.
   */
  constructor(opts = {}) {
    this.chainId = opts.chainId === undefined ? 5042002 : opts.chainId;
    this.head = opts.head === undefined ? 1000000 : opts.head;
    this.baseTimestamp = opts.baseTimestamp === undefined ? 1700000000 : opts.baseTimestamp;
    this.maxRange = opts.maxRange === undefined ? 10000 : opts.maxRange;
    this.rangeError = opts.rangeError || { code: -32012, message: 'block range too large' };
    this.latency = opts.latency || (() => 0);
    this.batchMode = opts.batchMode || 'ok';
    this.logOrder = opts.logOrder || 'asc';
    this.omitBaseFee = !!opts.omitBaseFee;
    this.logs = [];
    this.balances = new Map();
    this.receipts = new Map();
    this.calls = []; // one record per JSON-RPC call (single request or batch element)
    this.http = []; // one record per HTTP POST
    this.inFlight = 0;
    this.maxInFlight = 0;
    this.onCall = null; // hook(callRecord, httpRecord), invoked when a call is received
    this._endCounter = 0;
    this._injections = [];
    this._nextLogIndex = new Map();
    this.fetch = this.fetch.bind(this);
  }

  // ---- chain data
  timestampOf(n) { return this.baseTimestamp + Math.floor(n / 2); }

  blockAt(n) {
    const b = {
      number: hex(n), hash: blockHash(n), parentHash: blockHash(n - 1), timestamp: hex(this.timestampOf(n)),
      gasUsed: '0x0', gasLimit: '0x1c9c380', transactions: []
    };
    if (!this.omitBaseFee) b.baseFeePerGas = '0x' + (160000000000n + BigInt(n)).toString(16);
    return b;
  }

  /** specs: block numbers or { block, logIndex?, address?, topics? }. logIndex defaults to the next free index in that block. */
  addLogs(specs) {
    for (const s of specs) {
      const o = typeof s === 'number' ? { block: s } : s;
      const next = this._nextLogIndex.get(o.block) || 0;
      const logIndex = o.logIndex !== undefined ? o.logIndex : next;
      this._nextLogIndex.set(o.block, Math.max(next, logIndex + 1));
      const serial = this.logs.length + 1;
      this.logs.push({
        address: o.address || CONTRACT,
        topics: o.topics || [TOPIC0, '0x' + pad64(serial)],
        data: '0x' + pad64(serial),
        blockNumber: hex(o.block),
        blockHash: blockHash(o.block),
        transactionHash: '0x' + pad64(serial + 1000000),
        transactionIndex: '0x0',
        logIndex: hex(logIndex),
        removed: false
      });
    }
    return this;
  }

  /** Logs in [from, to] sorted numerically by (blockNumber, logIndex). */
  expectedLogs(from, to) {
    return this.logs.filter((l) => { const n = Number(BigInt(l.blockNumber)); return n >= from && n <= to; }).sort(numericLogCompare);
  }

  setReceipt(hash, receipt, afterPolls = 0) {
    this.receipts.set(hash, { receipt, afterPolls, polls: 0 });
    return this;
  }

  // ---- failure injection
  /**
   * fail(kind, { times = 1, when }): the next `times` matching requests fail. `when(callRecord)` filters (default: all).
   * HTTP-level kinds: http400 http429 http500 http503 network (throws TypeError('Failed to fetch')) hang (ends only on
   * init.signal abort) badjson (HTTP 200, body is not JSON). JSON-RPC kinds (per call, HTTP 200): '-32014' '-32005' '-32012'
   * '-32000' revert (code 3 + data) and 'rpc' (custom { error }).
   */
  fail(kind, { times = 1, when = null, error = null } = {}) {
    this._injections.push({ kind, remaining: times, when, error });
    return this;
  }

  clearFailures() { this._injections = []; }

  // ---- request log helpers
  getLogsCalls() { return this.calls.filter((c) => c.method === 'eth_getLogs'); }

  /** Ranges of the eth_getLogs calls that were answered successfully, sorted by from. */
  okRanges() {
    return this.getLogsCalls().filter((c) => c.outcome === 'ok').map((c) => ({ from: c.from, to: c.to })).sort((a, b) => a.from - b.from);
  }

  // ---- internals
  _record(req, httpRec, isBatch) {
    const rec = {
      seq: this.calls.length, http: httpRec.seq, batch: isBatch, id: req && req.id, method: req && req.method,
      params: req && req.params, outcome: 'pending', errorCode: null, endSeq: null, from: null, to: null, size: null
    };
    if (rec.method === 'eth_getLogs' && rec.params && rec.params[0]) {
      const f = rec.params[0];
      rec.from = toNum(f.fromBlock === undefined ? 'latest' : f.fromBlock, this.head);
      rec.to = toNum(f.toBlock === undefined ? 'latest' : f.toBlock, this.head);
      rec.size = rec.to - rec.from + 1;
    }
    this.calls.push(rec);
    return rec;
  }

  _finish(rec, outcome, errorCode = null) {
    rec.outcome = outcome;
    rec.errorCode = errorCode;
    rec.endSeq = this._endCounter++;
  }

  _finishAll(recs, outcome, errorCode = null) {
    recs.forEach((r) => this._finish(r, outcome, errorCode));
  }

  _takeHttpInjection(recs) {
    for (const inj of this._injections) {
      if (inj.remaining <= 0 || !HTTP_FAILURES.has(inj.kind)) continue;
      if (inj.when && !recs.some((r) => inj.when(r))) continue;
      inj.remaining--;
      return inj;
    }
    return null;
  }

  _takeRpcInjection(rec) {
    for (const inj of this._injections) {
      if (inj.remaining <= 0 || HTTP_FAILURES.has(inj.kind)) continue;
      if (inj.when && !inj.when(rec)) continue;
      inj.remaining--;
      return inj.error || RPC_FAILURES[inj.kind];
    }
    return null;
  }

  /** Waits `ticks` event-loop turns; rejects like fetch does as soon as the signal aborts. */
  _wait(ticks, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(domAbort());
      if (ticks <= 0) return resolve();
      let left = ticks;
      let finished = false;
      const onAbort = () => { finished = true; reject(domAbort()); };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const step = () => {
        if (finished) return;
        left--;
        if (left > 0) return setImmediate(step);
        finished = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      };
      setImmediate(step);
    });
  }

  _delayOf(recs) {
    return Math.max(0, ...recs.map((r) => this.latency(r)));
  }

  _dispatch(rec) {
    const p = rec.params || [];
    switch (rec.method) {
      case 'eth_chainId': return hex(this.chainId);
      case 'eth_blockNumber': return hex(this.head);
      case 'eth_getBlockByNumber': {
        const n = toNum(p[0], this.head);
        return n < 0 || n > this.head ? null : this.blockAt(n);
      }
      case 'eth_getLogs': return this._getLogs(p[0] || {});
      case 'eth_call': return '0x' + '0'.repeat(63) + '1';
      case 'eth_estimateGas': return '0x5208';
      case 'eth_gasPrice': return '0x' + (160n * 10n ** 9n).toString(16);
      case 'eth_getBalance': {
        const b = this.balances.get(String(p[0]).toLowerCase());
        return '0x' + (b === undefined ? 5n * 10n ** 18n : b).toString(16);
      }
      case 'eth_getTransactionReceipt': {
        const r = this.receipts.get(p[0]);
        if (!r) return null;
        r.polls++;
        return r.polls > r.afterPolls ? r.receipt : null;
      }
      default: throw rpcErr(-32601, 'Method not found: ' + rec.method);
    }
  }

  _getLogs(f) {
    const from = toNum(f.fromBlock === undefined ? 'latest' : f.fromBlock, this.head);
    const to = toNum(f.toBlock === undefined ? 'latest' : f.toBlock, this.head);
    if (to - from + 1 > this.maxRange) throw rpcErr(this.rangeError.code, this.rangeError.message);
    let out = this.logs.filter((l) => {
      const n = Number(BigInt(l.blockNumber));
      return n >= from && n <= to && matchesAddress(l, f.address) && matchesTopics(l, f.topics);
    });
    if (this.logOrder === 'desc') out = out.slice().reverse();
    else if (this.logOrder === 'shuffle') {
      const rng = mulberry32(from * 31 + to);
      out = out.map((l) => [rng(), l]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
    }
    return out;
  }

  _answer(rec) {
    const injected = this._takeRpcInjection(rec);
    let el;
    if (injected) el = { jsonrpc: '2.0', id: rec.id, error: injected };
    else {
      try {
        el = { jsonrpc: '2.0', id: rec.id, result: this._dispatch(rec) };
      } catch (e) {
        if (!e.rpc) throw e;
        el = { jsonrpc: '2.0', id: rec.id, error: e.rpc };
      }
    }
    if (el.error) this._finish(rec, 'error', el.error.code);
    else this._finish(rec, 'ok');
    return el;
  }

  _arrange(answers) {
    switch (this.batchMode) {
      case 'reverse': return answers.slice().reverse();
      case 'shuffle': {
        const rng = mulberry32(5);
        return answers.map((a) => [rng(), a]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
      }
      case 'drop-last': return answers.slice(0, -1);
      default: return answers;
    }
  }

  async _failHttp(inj, recs, signal) {
    switch (inj.kind) {
      case 'network':
        await this._wait(this._delayOf(recs), signal);
        this._finishAll(recs, 'network');
        throw new TypeError('Failed to fetch');
      case 'hang':
        recs.forEach((r) => { r.outcome = 'hanging'; });
        return new Promise((resolve, reject) => {
          if (signal.aborted) return reject(domAbort());
          signal.addEventListener('abort', () => reject(domAbort()), { once: true });
        });
      case 'badjson':
        await this._wait(this._delayOf(recs), signal);
        this._finishAll(recs, 'badjson');
        return {
          ok: true,
          status: 200,
          json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); },
          text: async () => '<html><body>502 Bad Gateway</body></html>'
        };
      default: {
        const status = Number(inj.kind.slice(4));
        await this._wait(this._delayOf(recs), signal);
        this._finishAll(recs, 'http', status);
        return respond(status, { error: 'HTTP ' + status });
      }
    }
  }

  /** The injectable fetch(url, init). */
  async fetch(url, init) {
    const signal = init && init.signal;
    const httpRec = { seq: this.http.length, url, init, body: init && init.body, calls: [], responseIds: null };
    this.http.push(httpRec);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    let recs = [];
    try {
      let payload;
      try {
        payload = JSON.parse(init.body);
      } catch (e) {
        return respond(400, { error: 'invalid JSON' });
      }
      const isBatch = Array.isArray(payload);
      recs = (isBatch ? payload : [payload]).map((r) => this._record(r, httpRec, isBatch));
      httpRec.calls = recs;
      if (this.onCall) recs.forEach((r) => this.onCall(r, httpRec));
      const inj = this._takeHttpInjection(recs);
      if (inj) return await this._failHttp(inj, recs, signal);
      await this._wait(this._delayOf(recs), signal);
      if (isBatch && this.batchMode === 'http400') {
        this._finishAll(recs, 'http', 400);
        return respond(400, { error: 'batch requests are not supported' });
      }
      if (isBatch && this.batchMode === 'object') {
        this._finishAll(recs, 'rejected');
        return respond(200, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      }
      const answers = recs.map((rec) => this._answer(rec));
      if (!isBatch) return respond(200, answers[0]);
      const arranged = this._arrange(answers);
      httpRec.responseIds = arranged.map((a) => a.id);
      return respond(200, arranged);
    } catch (e) {
      if (e && e.name === 'AbortError') {
        recs.forEach((r) => { if (r.outcome === 'pending' || r.outcome === 'hanging') this._finish(r, 'aborted'); });
      }
      throw e;
    } finally {
      this.inFlight--;
    }
  }
}

function makeClient(server, opts = {}) {
  return createClient(Object.assign({
    url: RPC_URL, fetch: server.fetch, retries: 4, baseDelayMs: 10, maxDelayMs: 100, timeoutMs: 0, sleep: sleepNoop, random: random05
  }, opts));
}

function recordingSleep() {
  const calls = [];
  const sleep = async (ms, signal) => { calls.push({ ms, signal }); };
  sleep.calls = calls;
  sleep.delays = () => calls.map((c) => c.ms);
  return sleep;
}

/** Awaits a promise that must reject and returns the rejection value. */
async function rejection(promise) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  return assert.fail('expected the promise to reject');
}

/** Deterministic seeded latency (event-loop turns) memoised per call, so shuffled completion order is reproducible. */
function seededLatency(seed, min = 1, max = 6) {
  const rng = mulberry32(seed);
  const memo = new Map();
  return (rec) => {
    if (!memo.has(rec.seq)) memo.set(rec.seq, min + Math.floor(rng() * (max - min + 1)));
    return memo.get(rec.seq);
  };
}

/** Adds logs at both sides of every default chunk boundary, at the edges, and at random blocks (several per block sometimes). */
function seedLogs(server, from, to, { count = 40, seed = 1, chunk = MAX_LOG_RANGE } = {}) {
  const rng = mulberry32(seed);
  const blocks = [from, to];
  for (let b = from + chunk; b <= to; b += chunk) blocks.push(b - 1, b);
  let prev = from;
  for (let i = 0; i < count; i++) {
    const b = rng() < 0.3 ? prev : from + Math.floor(rng() * (to - from + 1));
    blocks.push(b);
    prev = b;
  }
  return server.addLogs(blocks.filter((b) => b >= from && b <= to));
}

/** Asserts the (sorted) ranges tile [from, to] exactly: no gaps, no overlaps. */
function assertTiles(ranges, from, to) {
  assert.ok(ranges.length > 0, 'at least one successful range');
  assert.equal(ranges[0].from, from, 'first successful range starts at fromBlock');
  for (let i = 1; i < ranges.length; i++) {
    assert.equal(ranges[i].from, ranges[i - 1].to + 1,
      'gap or overlap between ' + JSON.stringify(ranges[i - 1]) + ' and ' + JSON.stringify(ranges[i]));
  }
  assert.equal(ranges[ranges.length - 1].to, to, 'last successful range ends at toBlock');
}

/** End of the contiguous prefix [from, through] covered by the sorted ranges (from - 1 when block `from` is not covered). */
function prefixThrough(ranges, from) {
  let through = from - 1;
  for (const r of ranges) {
    if (r.from !== through + 1) break;
    through = r.to;
  }
  return through;
}

/** For scans without -32012 halving: error.partial must equal the contiguous prefix recomputed from the server's request log. */
function verifyPartial(server, err, from) {
  assert.ok(err.partial, 'error.partial is present');
  const through = prefixThrough(server.okRanges(), from);
  assert.equal(err.partial.scannedThrough, through, 'scannedThrough is the contiguous successfully scanned prefix');
  assert.deepEqual(err.partial.logs, server.expectedLogs(from, through), 'partial.logs are exactly the logs of the scanned prefix');
  return through;
}

// ------------------------------------------------------------------------------------------------ pure helpers

describe('rpc.js: constants and pure helpers', () => {
  it('MAX_LOG_RANGE is 9,999 blocks (one below Arc\'s 10,000-block eth_getLogs limit)', () => {
    assert.equal(MAX_LOG_RANGE, 9999);
  });

  it('hexNumber produces 0x-prefixed lowercase hex without padding', () => {
    assert.equal(hexNumber(0), '0x0');
    assert.equal(hexNumber(9), '0x9');
    assert.equal(hexNumber(255), '0xff');
    assert.equal(hexNumber(10000), '0x2710');
    assert.equal(hexNumber(5042002), '0x4cef52');
    assert.equal(hexNumber(2 ** 40), '0x10000000000');
  });

  it('parseHexNumber returns a Number and round-trips with hexNumber', () => {
    assert.equal(parseHexNumber('0x0'), 0);
    assert.equal(parseHexNumber('0x2710'), 10000);
    assert.equal(parseHexNumber('0xFF'), 255);
    assert.equal(typeof parseHexNumber('0x10'), 'number');
    for (const n of [0, 1, 9, 10, 15, 16, 255, 256, 4095, 4096, 65535, 65536, 1048576, 123456789, 2 ** 40, Number.MAX_SAFE_INTEGER]) {
      assert.equal(parseHexNumber(hexNumber(n)), n);
    }
  });

  it('RpcError builds an Error named RpcError with code, data (null by default) and optional status', () => {
    const plain = RpcError('boom', 'NETWORK');
    assert.ok(plain instanceof Error);
    assert.equal(plain.name, 'RpcError');
    assert.equal(plain.message, 'boom');
    assert.equal(plain.code, 'NETWORK');
    assert.equal(plain.data, null);
    assert.equal('status' in plain, false);
    const full = new RpcError('HTTP', 'HTTP', { a: 1 }, 503); // also usable with new
    assert.ok(full instanceof Error);
    assert.equal(full.name, 'RpcError');
    assert.deepEqual(full.data, { a: 1 });
    assert.equal(full.status, 503);
    assert.equal(RpcError('x', 3, '0x08c379a0').data, '0x08c379a0');
  });

  it('abortError builds an Error named AbortError with a default message', () => {
    const e = abortError();
    assert.ok(e instanceof Error);
    assert.equal(e.name, 'AbortError');
    assert.equal(e.message, 'The operation was aborted.');
    assert.equal(abortError('stop it').message, 'stop it');
  });

  it('compareLogs orders numerically by blockNumber then logIndex, never as strings', () => {
    const L = (b, i) => ({ blockNumber: hex(b), logIndex: hex(i) });
    assert.equal(compareLogs(L(5, 0), L(5, 0)), 0);
    assert.ok(compareLogs(L(9, 0), L(16, 0)) < 0, '0x9 < 0x10 although "0x9" > "0x10" as strings');
    assert.ok(compareLogs(L(16, 0), L(9, 0)) > 0);
    assert.ok(compareLogs(L(256, 0), L(255, 0)) > 0);
    assert.ok(compareLogs(L(7, 9), L(7, 16)) < 0);
    assert.ok(compareLogs(L(7, 256), L(7, 16)) > 0);
    assert.ok(compareLogs(L(7, 256), L(8, 0)) < 0, 'block number dominates logIndex');
    const shuffled = [L(16, 0), L(9, 256), L(9, 9), L(256, 1), L(9, 16), L(255, 5), L(16, 0)];
    const sorted = shuffled.slice().sort(compareLogs).map((l) => [parseHexNumber(l.blockNumber), parseHexNumber(l.logIndex)]);
    assert.deepEqual(sorted, [[9, 9], [9, 16], [9, 256], [16, 0], [16, 0], [255, 5], [256, 1]]);
  });
});

// ------------------------------------------------------------------------------------------------ normalizeError

describe('normalizeError', () => {
  it('turns a JSON-RPC error object into an RpcError with code, message and data', () => {
    const e = normalizeError({ code: -32014, message: 'block is not yet imported', data: { block: '0x10' } });
    assert.ok(e instanceof Error);
    assert.equal(e.name, 'RpcError');
    assert.equal(e.code, -32014);
    assert.equal(e.message, 'block is not yet imported');
    assert.deepEqual(e.data, { block: '0x10' });
  });

  it('fills data with null and a missing message with "RPC error"', () => {
    const e = normalizeError({ code: -32000 });
    assert.equal(e.code, -32000);
    assert.equal(e.message, 'RPC error');
    assert.equal(e.data, null);
    const m = normalizeError({ message: 'only a message' });
    assert.equal(m.message, 'only a message');
    assert.equal(m.code, undefined);
  });

  it('keeps revert data (code 3 + data) on the normalised error', () => {
    const e = normalizeError({ code: 3, message: 'execution reverted: boom', data: REVERT_DATA });
    assert.equal(e.code, 3);
    assert.equal(e.data, REVERT_DATA);
  });

  it('maps a TypeError (failed fetch) to code NETWORK and keeps its message', () => {
    const e = normalizeError(new TypeError('Failed to fetch'));
    assert.equal(e.name, 'RpcError');
    assert.equal(e.code, 'NETWORK');
    assert.equal(e.message, 'Failed to fetch');
    assert.equal(e.data, null);
  });

  it('maps other thrown values (plain Error, string, null, undefined) to NETWORK', () => {
    assert.equal(normalizeError(new Error('socket hang up')).code, 'NETWORK');
    assert.equal(normalizeError(new Error('socket hang up')).message, 'socket hang up');
    const s = normalizeError('kaput');
    assert.equal(s.code, 'NETWORK');
    assert.equal(s.message, 'kaput');
    assert.equal(normalizeError(null).code, 'NETWORK');
    assert.equal(normalizeError(undefined).code, 'NETWORK');
  });

  it('passes AbortError through unchanged (same object), including a DOMException AbortError', () => {
    const a = abortError();
    assert.equal(normalizeError(a), a);
    const d = domAbort();
    assert.equal(normalizeError(d), d);
    assert.equal(normalizeError(d).name, 'AbortError');
  });

  it('returns an existing RpcError unchanged (same object, code, message, data)', () => {
    const r = RpcError('nope', 'TIMEOUT', { x: 1 });
    r.attempts = 3;
    const n = normalizeError(r);
    assert.equal(n, r);
    assert.equal(n.code, 'TIMEOUT');
    assert.equal(n.attempts, 3);
    assert.deepEqual(n.data, { x: 1 });
  });

  it('returns an Error that already carries a code unchanged', () => {
    const e = Object.assign(new Error('call exception'), { code: 'CALL_EXCEPTION' });
    assert.equal(normalizeError(e), e);
  });
});

// ------------------------------------------------------------------------------------------------ isRetryable / isRangeTooLarge

describe('isRetryable', () => {
  const cases = [
    ['NETWORK', RpcError('x', 'NETWORK'), true],
    ['TIMEOUT', RpcError('x', 'TIMEOUT'), true],
    ['HTTP 429', RpcError('x', 'HTTP', null, 429), true],
    ['HTTP 500', RpcError('x', 'HTTP', null, 500), true],
    ['HTTP 503', RpcError('x', 'HTTP', null, 503), true],
    ['HTTP 599', RpcError('x', 'HTTP', null, 599), true],
    ['-32014 block is not yet imported', RpcError('x', -32014), true],
    ['-32005 rate limited', RpcError('x', -32005), true],
    ['HTTP 400', RpcError('x', 'HTTP', null, 400), false],
    ['HTTP 404', RpcError('x', 'HTTP', null, 404), false],
    ['-32000', RpcError('x', -32000), false],
    ['-32012 range too large', RpcError('x', -32012), false],
    ['-32602 invalid params', RpcError('x', -32602), false],
    ['3 revert with data', RpcError('execution reverted', 3, REVERT_DATA), false],
    ['BAD_RESPONSE', RpcError('x', 'BAD_RESPONSE'), false],
    ['RECEIPT_TIMEOUT', RpcError('x', 'RECEIPT_TIMEOUT'), false],
    ['AbortError', abortError(), false],
    ['DOMException AbortError', domAbort(), false],
    ['AbortError even when it carries code NETWORK', Object.assign(abortError(), { code: 'NETWORK' }), false],
    ['null', null, false],
    ['undefined', undefined, false]
  ];
  for (const [label, err, expected] of cases) {
    it(label + ' -> ' + expected, () => {
      assert.equal(isRetryable(err), expected);
    });
  }
});

describe('isRangeTooLarge', () => {
  it('is true for code -32012 whatever the message', () => {
    assert.equal(isRangeTooLarge(RpcError('anything', -32012)), true);
    assert.equal(isRangeTooLarge({ code: -32012 }), true);
  });

  it('recognises the usual "range too large" messages', () => {
    for (const message of [
      'block range too large', 'Block Range is too large', 'too many blocks requested', 'query range is too large',
      'range too wide', 'query exceeds max block range 1000', 'request exceeds the limit', 'exceed max results'
    ]) {
      assert.equal(isRangeTooLarge({ code: -32000, message }), true, message);
    }
  });

  it('is false for unrelated errors and empty values', () => {
    assert.equal(isRangeTooLarge(RpcError('block is not yet imported', -32014)), false);
    assert.equal(isRangeTooLarge(RpcError('execution reverted: boom', 3, REVERT_DATA)), false);
    assert.equal(isRangeTooLarge(RpcError('invalid params', -32602)), false);
    assert.equal(isRangeTooLarge(RpcError('RPC HTTP error 500', 'HTTP', null, 500)), false);
    assert.equal(isRangeTooLarge(abortError()), false);
    assert.equal(isRangeTooLarge(null), false);
    assert.equal(isRangeTooLarge(undefined), false);
    assert.equal(isRangeTooLarge({}), false);
  });
});

// ------------------------------------------------------------------------------------------------ createClient: requests

describe('createClient: request', () => {
  it('resolves with the JSON-RPC result', async () => {
    const server = new FakeRpcServer({ chainId: 5042002 });
    const client = makeClient(server);
    assert.equal(await client.request('eth_chainId'), hex(5042002));
    assert.equal(server.http.length, 1);
    assert.equal(client.url, RPC_URL);
  });

  it('resolves a null result (e.g. unknown receipt) instead of treating it as malformed', async () => {
    const server = new FakeRpcServer();
    const client = makeClient(server);
    assert.equal(await client.request('eth_getTransactionReceipt', ['0x' + '00'.repeat(32)]), null);
  });

  it('numbers JSON-RPC ids 1, 2, 3, ... per client and keeps the id across retries', async () => {
    const server = new FakeRpcServer();
    const client = makeClient(server);
    await client.request('eth_chainId');
    await client.request('eth_blockNumber');
    server.fail('-32014', { times: 2 });
    await client.request('eth_gasPrice');
    assert.deepEqual(server.calls.map((c) => c.id), [1, 2, 3, 3, 3], 'the retried call reuses its id');
    const other = makeClient(new FakeRpcServer());
    await other.request('eth_chainId');
    assert.equal(other.stats.requests, 1);
    const second = new FakeRpcServer();
    await makeClient(second).request('eth_chainId');
    assert.equal(second.calls[0].id, 1, 'every client starts counting at 1');
  });

  it('sends a JSON-RPC 2.0 body with method and params (default [])', async () => {
    const server = new FakeRpcServer();
    const client = makeClient(server);
    await client.request('eth_blockNumber');
    await client.request('eth_getBalance', [CONTRACT, 'latest']);
    const first = JSON.parse(server.http[0].body);
    assert.deepEqual(first, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
    const second = JSON.parse(server.http[1].body);
    assert.deepEqual(second, { jsonrpc: '2.0', id: 2, method: 'eth_getBalance', params: [CONTRACT, 'latest'] });
  });

  it('POSTs JSON to the configured url without credentials or cookies', async () => {
    const server = new FakeRpcServer();
    const client = makeClient(server);
    await client.request('eth_chainId');
    const { url, init } = server.http[0];
    assert.equal(url, RPC_URL);
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.equal(init.headers['content-type'], 'application/json');
    const headerNames = Object.keys(init.headers).map((h) => h.toLowerCase());
    assert.ok(!headerNames.includes('cookie'), 'no cookie header');
    assert.ok(!headerNames.includes('authorization'), 'no authorization header');
    assert.equal(typeof init.body, 'string');
    assert.ok(init.signal && typeof init.signal.aborted === 'boolean', 'an AbortSignal is passed to fetch');
  });

  it('normalises a JSON-RPC error: code, message, data (null when absent); non-retryable codes are tried once', async () => {
    const server = new FakeRpcServer();
    server.fail('-32000', { times: 1 });
    const client = makeClient(server);
    const err = await rejection(client.request('eth_getBlockByNumber', ['0x1', false]));
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'RpcError');
    assert.equal(err.code, -32000);
    assert.equal(err.message, 'header not found');
    assert.equal(err.data, null);
    assert.equal(err.attempts, 1);
    assert.equal(server.http.length, 1);
  });

  it('answers an unknown method with its own -32601 error (not retried)', async () => {
    const client = makeClient(new FakeRpcServer());
    const err = await rejection(client.request('eth_nope'));
    assert.equal(err.code, -32601);
    assert.equal(err.attempts, 1);
  });

  it('rejects a JSON body that is not a JSON-RPC response with BAD_RESPONSE (not retried)', async () => {
    for (const body of [42, null, 'text', {}, { jsonrpc: '2.0', id: 1 }]) {
      const calls = [];
      const client = createClient({
        url: RPC_URL, retries: 3, sleep: sleepNoop, random: random05, timeoutMs: 0,
        fetch: async () => { calls.push(1); return { ok: true, status: 200, json: async () => body }; }
      });
      const err = await rejection(client.request('eth_chainId'));
      assert.equal(err.code, 'BAD_RESPONSE', JSON.stringify(body));
      assert.equal(err.attempts, 1);
      assert.equal(calls.length, 1);
    }
  });

  it('falls back to res.text() + JSON.parse when the response has no json()', async () => {
    const client = createClient({
      url: RPC_URL, sleep: sleepNoop, random: random05, timeoutMs: 0,
      fetch: async () => ({ ok: true, status: 200, text: async () => '{"jsonrpc":"2.0","id":1,"result":"0x2a"}' })
    });
    assert.equal(await client.request('eth_blockNumber'), '0x2a');
    const bad = createClient({ url: RPC_URL, sleep: sleepNoop, random: random05, timeoutMs: 0, fetch: async () => ({ ok: true, status: 200, text: async () => 'oops' }) });
    assert.equal((await rejection(bad.request('eth_blockNumber'))).code, 'BAD_RESPONSE');
  });

  it('a non-JSON body gives BAD_RESPONSE and is not retried', async () => {
    const server = new FakeRpcServer();
    server.fail('badjson', { times: 5 });
    const sleep = recordingSleep();
    const client = makeClient(server, { sleep });
    const err = await rejection(client.request('eth_blockNumber'));
    assert.equal(err.code, 'BAD_RESPONSE');
    assert.equal(err.attempts, 1);
    assert.equal(server.http.length, 1);
    assert.equal(sleep.calls.length, 0);
    assert.equal(isRetryable(err), false);
  });
});

// ------------------------------------------------------------------------------------------------ createClient: retry / backoff

describe('createClient: retry and backoff', () => {
  it('makes exactly retries + 1 attempts for a persistent -32014, then throws it with .attempts', async () => {
    for (const retries of [0, 1, 3]) {
      const server = new FakeRpcServer();
      server.fail('-32014', { times: Infinity });
      const sleep = recordingSleep();
      const client = makeClient(server, { retries, sleep });
      const err = await rejection(client.request('eth_blockNumber'));
      assert.equal(err.code, -32014);
      assert.equal(err.message, 'block is not yet imported');
      assert.equal(err.attempts, retries + 1);
      assert.equal(server.http.length, retries + 1);
      assert.equal(client.stats.requests, retries + 1);
      assert.equal(client.stats.retries, retries);
      assert.equal(sleep.calls.length, retries);
    }
  });

  it('defaults to 4 retries (5 attempts)', async () => {
    const server = new FakeRpcServer();
    server.fail('-32014', { times: Infinity });
    const client = createClient({ url: RPC_URL, fetch: server.fetch, sleep: sleepNoop, random: random05, timeoutMs: 0 });
    const err = await rejection(client.request('eth_blockNumber'));
    assert.equal(err.attempts, 5);
    assert.equal(server.http.length, 5);
  });

  it('succeeds after 2 transient failures and counts the retries in stats', async () => {
    const server = new FakeRpcServer({ head: 777 });
    server.fail('-32014', { times: 2 });
    const sleep = recordingSleep();
    const client = makeClient(server, { sleep });
    assert.equal(await client.request('eth_blockNumber'), hex(777));
    assert.equal(server.http.length, 3);
    assert.equal(client.stats.requests, 3);
    assert.equal(client.stats.retries, 2);
    assert.equal(sleep.calls.length, 2);
    assert.deepEqual(server.calls.map((c) => c.outcome), ['error', 'error', 'ok']);
  });

  it('retries -32005 (rate limit) too', async () => {
    const server = new FakeRpcServer();
    server.fail('-32005', { times: 1 });
    const client = makeClient(server);
    assert.equal(await client.request('eth_chainId'), hex(5042002));
    assert.equal(client.stats.retries, 1);
  });

  it('backs off exponentially from baseDelayMs, never decreasing, capped at maxDelayMs (jitter factor 1.0)', async () => {
    const server = new FakeRpcServer();
    server.fail('-32014', { times: Infinity });
    const sleep = recordingSleep();
    const client = makeClient(server, { retries: 7, baseDelayMs: 100, maxDelayMs: 1000, sleep, random: () => 0.5 });
    await rejection(client.request('eth_blockNumber'));
    const delays = sleep.delays();
    assert.deepEqual(delays, [100, 200, 400, 800, 1000, 1000, 1000]);
    for (let i = 1; i < delays.length; i++) assert.ok(delays[i] >= delays[i - 1], 'non-decreasing');
    assert.ok(delays.every((d) => d <= 1000), 'capped at maxDelayMs');
  });

  it('applies jitter in the 0.75x .. 1.25x band to the exponential schedule', async () => {
    const run = async (random) => {
      const server = new FakeRpcServer();
      server.fail('-32014', { times: Infinity });
      const sleep = recordingSleep();
      await rejection(makeClient(server, { retries: 3, baseDelayMs: 100, maxDelayMs: 100000, sleep, random }).request('eth_chainId'));
      return sleep.delays();
    };
    assert.deepEqual(await run(() => 0), [75, 150, 300]);
    assert.deepEqual(await run(() => 1), [125, 250, 500]);
  });

  // Regression guard: an earlier version of backoff() applied the jitter AFTER the cap, so with random() close to 1 a retry
  // slept up to 1.25 x maxDelayMs, i.e. longer than the documented maximum delay.
  it('never sleeps longer than maxDelayMs, even with maximal jitter', async () => {
    const server = new FakeRpcServer();
    server.fail('-32014', { times: Infinity });
    const sleep = recordingSleep();
    const client = makeClient(server, { retries: 7, baseDelayMs: 100, maxDelayMs: 1000, sleep, random: () => 0.999999 });
    await rejection(client.request('eth_blockNumber'));
    const delays = sleep.delays();
    assert.ok(delays.every((d) => d <= 1000), 'delays exceed maxDelayMs: ' + JSON.stringify(delays));
  });

  it('passes the abort signal on to sleep()', async () => {
    const server = new FakeRpcServer();
    server.fail('-32014', { times: 1 });
    const sleep = recordingSleep();
    const ac = new AbortController();
    await makeClient(server, { sleep }).request('eth_chainId', [], { signal: ac.signal });
    assert.equal(sleep.calls.length, 1);
    assert.equal(sleep.calls[0].signal, ac.signal);
  });

  it('does not retry an EVM revert (code 3 with data) and keeps the data', async () => {
    const server = new FakeRpcServer();
    server.fail('revert', { times: 5 });
    const sleep = recordingSleep();
    const client = makeClient(server, { sleep });
    const err = await rejection(client.request('eth_call', [{ to: CONTRACT, data: '0x' }, 'latest']));
    assert.equal(err.name, 'RpcError');
    assert.equal(err.code, 3);
    assert.equal(err.message, 'execution reverted: boom');
    assert.equal(err.data, REVERT_DATA);
    assert.equal(err.attempts, 1);
    assert.equal(server.http.length, 1);
    assert.equal(sleep.calls.length, 0);
    assert.equal(client.stats.retries, 0);
  });

  it('retries HTTP 429 and succeeds', async () => {
    const server = new FakeRpcServer();
    server.fail('http429', { times: 2 });
    const client = makeClient(server);
    assert.equal(await client.request('eth_chainId'), hex(5042002));
    assert.equal(client.stats.retries, 2);
  });

  it('retries HTTP 500 and 503, then gives up with code HTTP and the status', async () => {
    for (const [kind, status] of [['http500', 500], ['http503', 503]]) {
      const server = new FakeRpcServer();
      server.fail(kind, { times: Infinity });
      const client = makeClient(server, { retries: 2 });
      const err = await rejection(client.request('eth_chainId'));
      assert.equal(err.code, 'HTTP');
      assert.equal(err.status, status);
      assert.equal(err.attempts, 3);
      assert.equal(server.http.length, 3);
      assert.equal(isRetryable(err), true);
    }
  });

  it('does not retry HTTP 400', async () => {
    const server = new FakeRpcServer();
    server.fail('http400', { times: Infinity });
    const client = makeClient(server);
    const err = await rejection(client.request('eth_chainId'));
    assert.equal(err.code, 'HTTP');
    assert.equal(err.status, 400);
    assert.equal(err.attempts, 1);
    assert.equal(server.http.length, 1);
  });

  it('retries a thrown network error (TypeError: Failed to fetch) and succeeds', async () => {
    const server = new FakeRpcServer();
    server.fail('network', { times: 2 });
    const client = makeClient(server);
    assert.equal(await client.request('eth_chainId'), hex(5042002));
    assert.equal(client.stats.retries, 2);
  });

  it('a persistent network error ends as code NETWORK with the original message after retries + 1 attempts', async () => {
    const server = new FakeRpcServer();
    server.fail('network', { times: Infinity });
    const client = makeClient(server, { retries: 3 });
    const err = await rejection(client.request('eth_chainId'));
    assert.equal(err.code, 'NETWORK');
    assert.equal(err.message, 'Failed to fetch');
    assert.equal(err.attempts, 4);
    assert.equal(server.http.length, 4);
  });

  it('works with the real default sleep (tiny delays) when no sleep is injected', async () => {
    const server = new FakeRpcServer({ head: 4242 });
    server.fail('-32014', { times: 2 });
    const client = createClient({ url: RPC_URL, fetch: server.fetch, retries: 3, baseDelayMs: 4, maxDelayMs: 8, timeoutMs: 0, random: random05 });
    const t0 = Date.now();
    assert.equal(await client.request('eth_blockNumber'), hex(4242));
    assert.ok(Date.now() - t0 >= 8, 'actually waited about 4 + 8 ms');
    assert.equal(client.stats.retries, 2);
  });
});

// ------------------------------------------------------------------------------------------------ createClient: timeout and abort

describe('createClient: timeout and abort', () => {
  it('turns a request that never answers into code TIMEOUT (retryable), retries it and exhausts', async () => {
    const server = new FakeRpcServer();
    server.fail('hang', { times: Infinity });
    const sleep = recordingSleep();
    const client = makeClient(server, { timeoutMs: 20, retries: 2, sleep });
    const t0 = Date.now();
    const err = await rejection(client.request('eth_blockNumber'));
    assert.equal(err.name, 'RpcError');
    assert.equal(err.code, 'TIMEOUT');
    assert.equal(isRetryable(err), true);
    assert.equal(err.attempts, 3);
    assert.equal(server.http.length, 3);
    assert.equal(sleep.calls.length, 2);
    assert.ok(Date.now() - t0 >= 40, 'each attempt waited for its own timeout');
    assert.deepEqual(server.calls.map((c) => c.outcome), ['aborted', 'aborted', 'aborted']);
  });

  it('recovers when only the first attempt hangs', async () => {
    const server = new FakeRpcServer({ head: 99 });
    server.fail('hang', { times: 1 });
    const client = makeClient(server, { timeoutMs: 20 });
    assert.equal(await client.request('eth_blockNumber'), hex(99));
    assert.equal(client.stats.retries, 1);
  });

  it('timeoutMs: 0 disables the timeout (a slow answer is still accepted)', async () => {
    const server = new FakeRpcServer({ latency: () => 30 });
    const client = makeClient(server, { timeoutMs: 0 });
    assert.equal(await client.request('eth_chainId'), hex(5042002));
  });

  it('times out with the real default sleep too', async () => {
    const server = new FakeRpcServer();
    server.fail('hang', { times: Infinity });
    const client = createClient({ url: RPC_URL, fetch: server.fetch, retries: 1, baseDelayMs: 1, maxDelayMs: 2, timeoutMs: 20, random: random05 });
    const err = await rejection(client.request('eth_blockNumber'));
    assert.equal(err.code, 'TIMEOUT');
    assert.equal(err.attempts, 2);
  });

  it('an already-aborted signal rejects with AbortError and sends no request at all', async () => {
    const server = new FakeRpcServer();
    const client = makeClient(server);
    const ac = new AbortController();
    ac.abort();
    const err = await rejection(client.request('eth_chainId', [], { signal: ac.signal }));
    assert.equal(err.name, 'AbortError');
    assert.equal(server.http.length, 0);
    assert.equal(client.stats.requests, 0);
  });

  it('aborting an in-flight request rejects with AbortError right away and is not retried', async () => {
    const server = new FakeRpcServer();
    server.fail('hang', { times: Infinity });
    const sleep = recordingSleep();
    const client = makeClient(server, { sleep });
    const ac = new AbortController();
    const p = client.request('eth_blockNumber', [], { signal: ac.signal });
    await tick();
    assert.equal(server.inFlight, 1);
    ac.abort();
    const err = await rejection(p);
    assert.equal(err.name, 'AbortError');
    assert.equal(isRetryable(err), false);
    assert.equal(server.http.length, 1, 'no second attempt');
    assert.equal(sleep.calls.length, 0);
    assert.equal(client.stats.retries, 0);
    assert.equal(server.calls[0].outcome, 'aborted');
    assert.equal(server.inFlight, 0);
  });

  it('aborting during the backoff sleep (real default sleep) rejects promptly with AbortError', async () => {
    const server = new FakeRpcServer();
    server.fail('-32014', { times: Infinity });
    const client = createClient({ url: RPC_URL, fetch: server.fetch, retries: 4, baseDelayMs: 60000, maxDelayMs: 60000, timeoutMs: 0, random: random05 });
    const ac = new AbortController();
    const t0 = Date.now();
    const p = client.request('eth_blockNumber', [], { signal: ac.signal });
    await tick();
    await tick();
    assert.equal(server.http.length, 1, 'the client is now sleeping before its first retry');
    ac.abort();
    const err = await rejection(p);
    assert.equal(err.name, 'AbortError');
    assert.ok(Date.now() - t0 < 2000, 'did not wait for the 60 s backoff');
    assert.equal(server.http.length, 1);
  });

  it('abort during an injected sleep that ignores the signal: no further request is sent', async () => {
    const server = new FakeRpcServer();
    server.fail('-32014', { times: Infinity });
    const ac = new AbortController();
    const sleep = async () => { ac.abort(); };
    const client = makeClient(server, { sleep });
    const err = await rejection(client.request('eth_blockNumber', [], { signal: ac.signal }));
    assert.equal(err.name, 'AbortError');
    assert.equal(server.http.length, 1);
  });
});

// ------------------------------------------------------------------------------------------------ createClient: batch

describe('createClient: batch', () => {
  const BALANCE = 1234567890123456789n;
  const CALLS = [
    { method: 'eth_chainId' },
    { method: 'eth_blockNumber', params: [] },
    { method: 'eth_getBalance', params: [CONTRACT, 'latest'] },
    { method: 'eth_gasPrice' },
    { method: 'eth_estimateGas', params: [{ to: CONTRACT }] }
  ];
  const expected = (server) => [hex(server.chainId), hex(server.head), '0x' + BALANCE.toString(16), '0x' + (160n * 10n ** 9n).toString(16), '0x5208'];

  for (const batchMode of ['ok', 'reverse', 'shuffle']) {
    it('returns results in input order when the server answers in "' + batchMode + '" order, in one HTTP request', async () => {
      const server = new FakeRpcServer({ batchMode, head: 31337 });
      server.balances.set(CONTRACT, BALANCE);
      const client = makeClient(server);
      const out = await client.batch(CALLS);
      assert.deepEqual(out, expected(server).map((result) => ({ result, error: null })));
      assert.equal(server.http.length, 1);
      const sent = JSON.parse(server.http[0].body);
      assert.ok(Array.isArray(sent));
      assert.equal(sent.length, CALLS.length);
      assert.ok(sent.every((c) => c.jsonrpc === '2.0'));
      assert.deepEqual(sent.map((c) => c.method), CALLS.map((c) => c.method));
      assert.deepEqual(sent.map((c) => c.params), [[], [], [CONTRACT, 'latest'], [], [{ to: CONTRACT }]], 'params default to []');
      const ids = sent.map((c) => c.id);
      assert.equal(new Set(ids).size, ids.length, 'ids are unique');
      assert.deepEqual(ids, ids.slice().sort((a, b) => a - b), 'ids are increasing');
      if (batchMode !== 'ok') {
        assert.notDeepEqual(server.http[0].responseIds, ids, 'the fake really answered out of order');
        assert.deepEqual(server.http[0].responseIds.slice().sort((a, b) => a - b), ids);
      }
    });
  }

  it('per-call errors (revert, unknown method) do not reject the batch', async () => {
    const server = new FakeRpcServer();
    server.fail('revert', { times: 1, when: (c) => c.method === 'eth_call' });
    const client = makeClient(server);
    const out = await client.batch([
      { method: 'eth_chainId' },
      { method: 'eth_call', params: [{ to: CONTRACT, data: '0x' }, 'latest'] },
      { method: 'eth_nope' },
      { method: 'eth_blockNumber' }
    ]);
    assert.equal(out.length, 4);
    assert.deepEqual(out[0], { result: hex(5042002), error: null });
    assert.equal(out[1].result, undefined);
    assert.equal(out[1].error.name, 'RpcError');
    assert.equal(out[1].error.code, 3);
    assert.equal(out[1].error.data, REVERT_DATA);
    assert.equal(out[2].result, undefined);
    assert.equal(out[2].error.code, -32601);
    assert.deepEqual(out[3], { result: hex(server.head), error: null });
    assert.equal(server.http.length, 1, 'no fallback to single requests');
  });

  it('an empty batch resolves to [] without any request', async () => {
    const server = new FakeRpcServer();
    const client = makeClient(server);
    assert.deepEqual(await client.batch([]), []);
    assert.equal(server.http.length, 0);
  });

  for (const batchMode of ['object', 'http400']) {
    it('falls back to individual requests when the node answers a batch with ' + (batchMode === 'object' ? 'a non-array object' : 'HTTP 400'), async () => {
      const server = new FakeRpcServer({ batchMode, head: 555 });
      server.balances.set(CONTRACT, BALANCE);
      const client = makeClient(server);
      const out = await client.batch(CALLS);
      assert.deepEqual(out, expected(server).map((result) => ({ result, error: null })));
      assert.equal(server.http.length, 1 + CALLS.length, 'one failed batch POST + one POST per call');
      assert.ok(Array.isArray(JSON.parse(server.http[0].body)));
      for (const h of server.http.slice(1)) assert.ok(!Array.isArray(JSON.parse(h.body)), 'single request');
      assert.equal(client.stats.retries, 0, 'a non-retryable batch failure is not retried before falling back');
    });
  }

  it('fallback keeps per-call errors per call and results in input order', async () => {
    const server = new FakeRpcServer({ batchMode: 'object' });
    server.fail('revert', { times: 1, when: (c) => c.method === 'eth_call' });
    const client = makeClient(server);
    const out = await client.batch([{ method: 'eth_call', params: [{ to: CONTRACT }, 'latest'] }, { method: 'eth_chainId' }]);
    assert.equal(out[0].error.code, 3);
    assert.equal(out[0].error.data, REVERT_DATA);
    assert.deepEqual(out[1], { result: hex(5042002), error: null });
  });

  it('retries a transient HTTP failure of the whole batch and reuses the ids', async () => {
    const server = new FakeRpcServer();
    server.fail('http429', { times: 1 });
    const client = makeClient(server);
    const out = await client.batch([{ method: 'eth_chainId' }, { method: 'eth_blockNumber' }]);
    assert.deepEqual(out.map((o) => o.error), [null, null]);
    assert.equal(server.http.length, 2);
    assert.deepEqual(JSON.parse(server.http[0].body).map((c) => c.id), JSON.parse(server.http[1].body).map((c) => c.id));
    assert.equal(client.stats.retries, 1);
  });

  it('a response that misses one element gives that element a BAD_RESPONSE error only', async () => {
    const server = new FakeRpcServer({ batchMode: 'drop-last' });
    const client = makeClient(server);
    const out = await client.batch([{ method: 'eth_chainId' }, { method: 'eth_blockNumber' }, { method: 'eth_gasPrice' }]);
    assert.equal(out[0].error, null);
    assert.equal(out[1].error, null);
    assert.equal(out[2].error.code, 'BAD_RESPONSE');
    assert.equal(out[2].result, undefined);
  });

  it('batch and single requests share one id counter (no id is reused)', async () => {
    const server = new FakeRpcServer();
    const client = makeClient(server);
    await client.request('eth_chainId');
    await client.batch([{ method: 'eth_chainId' }, { method: 'eth_blockNumber' }]);
    await client.request('eth_chainId');
    assert.deepEqual(server.calls.map((c) => c.id), [1, 2, 3, 4]);
  });

  it('aborting a batch rejects with AbortError', async () => {
    const server = new FakeRpcServer();
    server.fail('hang', { times: Infinity });
    const client = makeClient(server);
    const ac = new AbortController();
    const p = client.batch([{ method: 'eth_chainId' }, { method: 'eth_blockNumber' }], { signal: ac.signal });
    await tick();
    ac.abort();
    const err = await rejection(p);
    assert.equal(err.name, 'AbortError');
    assert.equal(server.http.length, 1, 'no fallback to single requests after an abort');
  });
});

// ------------------------------------------------------------------------------------------------ createClient: convenience methods

describe('createClient: convenience methods', () => {
  it('exposes url and stats (requests / retries start at 0)', () => {
    const client = makeClient(new FakeRpcServer());
    assert.equal(client.url, RPC_URL);
    assert.deepEqual(client.stats, { requests: 0, retries: 0 });
  });

  it('chainId() and blockNumber() return Numbers', async () => {
    const server = new FakeRpcServer({ chainId: 5042002, head: 123456 });
    const client = makeClient(server);
    assert.equal(await client.chainId(), 5042002);
    assert.equal(await client.blockNumber(), 123456);
    assert.deepEqual(server.calls.map((c) => c.method), ['eth_chainId', 'eth_blockNumber']);
    assert.deepEqual(server.calls.map((c) => c.params), [[], []]);
  });

  it('getBlock("latest") returns { number, timestamp, hash, parentHash, baseFeePerGas } and sends [tag, false]', async () => {
    const server = new FakeRpcServer({ head: 1001, baseTimestamp: 1700000000 });
    const client = makeClient(server);
    const b = await client.getBlock('latest');
    assert.deepEqual(b, {
      number: 1001,
      timestamp: 1700000000 + 500,
      hash: blockHash(1001),
      parentHash: blockHash(1000),
      baseFeePerGas: 160000000000n + 1001n
    });
    assert.equal(typeof b.number, 'number');
    assert.equal(typeof b.timestamp, 'number');
    assert.equal(typeof b.baseFeePerGas, 'bigint');
    assert.deepEqual(server.calls[0].params, ['latest', false]);
  });

  it('getBlock(number) sends the number as hex; a hex tag is passed through', async () => {
    const server = new FakeRpcServer({ head: 5000 });
    const client = makeClient(server);
    assert.equal((await client.getBlock(0)).number, 0);
    assert.equal((await client.getBlock(255)).number, 255);
    assert.equal((await client.getBlock('0x10')).number, 16);
    assert.deepEqual(server.calls.map((c) => c.params), [['0x0', false], ['0xff', false], ['0x10', false]]);
  });

  it('getBlock returns null for a block that does not exist and baseFeePerGas null when absent', async () => {
    const server = new FakeRpcServer({ head: 10, omitBaseFee: true });
    const client = makeClient(server);
    assert.equal(await client.getBlock(11), null);
    assert.equal((await client.getBlock(10)).baseFeePerGas, null);
  });

  it('getBalance, gasPrice and estimateGas return BigInt', async () => {
    const server = new FakeRpcServer();
    server.balances.set(CONTRACT, 123456789012345678901234n);
    const client = makeClient(server);
    assert.equal(await client.getBalance(CONTRACT), 123456789012345678901234n);
    assert.deepEqual(server.calls[0].params, [CONTRACT, 'latest'], 'tag defaults to latest');
    assert.equal(await client.getBalance(CONTRACT, 'earliest'), 123456789012345678901234n);
    assert.deepEqual(server.calls[1].params, [CONTRACT, 'earliest']);
    const gp = await client.gasPrice();
    assert.equal(typeof gp, 'bigint');
    assert.equal(gp, 160n * 10n ** 9n);
    const gas = await client.estimateGas({ to: CONTRACT, data: '0x' });
    assert.equal(typeof gas, 'bigint');
    assert.equal(gas, 21000n);
    assert.deepEqual(server.calls[3].params, [{ to: CONTRACT, data: '0x' }]);
  });

  it('call(tx) defaults the block tag to latest; getTransactionReceipt passes the hash', async () => {
    const server = new FakeRpcServer();
    const client = makeClient(server);
    const tx = { to: CONTRACT, data: '0x12345678' };
    assert.equal(await client.call(tx), '0x' + '0'.repeat(63) + '1');
    assert.deepEqual(server.calls[0].params, [tx, 'latest']);
    const hash = '0x' + 'ee'.repeat(32);
    assert.equal(await client.getTransactionReceipt(hash), null);
    assert.deepEqual(server.calls[1].params, [hash]);
  });

  it('getLogs converts Number fromBlock/toBlock to hex, leaves hex strings and tags alone, and does not mutate the filter', async () => {
    const server = new FakeRpcServer({ head: 300 });
    server.addLogs([10, 11, 255]);
    const client = makeClient(server);
    const filter = { address: CONTRACT, topics: [TOPIC0], fromBlock: 10, toBlock: 255 };
    const logs = await client.getLogs(filter);
    assert.equal(logs.length, 3);
    assert.deepEqual(server.calls[0].params, [{ address: CONTRACT, topics: [TOPIC0], fromBlock: '0xa', toBlock: '0xff' }]);
    assert.deepEqual(filter, { address: CONTRACT, topics: [TOPIC0], fromBlock: 10, toBlock: 255 });
    await client.getLogs({ fromBlock: '0x0', toBlock: 'latest' });
    assert.deepEqual(server.calls[1].params, [{ fromBlock: '0x0', toBlock: 'latest' }]);
  });

  // Regression guard: an earlier version forwarded a Number tag of call()/getBalance() verbatim ({"params":[addr, 123]}), which
  // JSON-RPC nodes reject; getBlock() and getLogs() always converted Numbers to hex.
  it('getBalance and call convert a Number block tag to hex, like getBlock and getLogs do', async () => {
    const server = new FakeRpcServer();
    const client = makeClient(server);
    await client.getBalance(CONTRACT, 255);
    await client.call({ to: CONTRACT }, 4096);
    assert.deepEqual(server.calls[0].params, [CONTRACT, '0xff']);
    assert.deepEqual(server.calls[1].params, [{ to: CONTRACT }, '0x1000']);
  });
});

// ------------------------------------------------------------------------------------------------ scanLogs: chunking

describe('scanLogs: chunk boundaries', () => {
  const cases = [
    { name: 'a single block [100, 100]', from: 100, to: 100 },
    { name: 'two blocks [7, 8]', from: 7, to: 8 },
    { name: 'exactly 9,999 blocks [0, 9998]', from: 0, to: 9998 },
    { name: 'exactly 10,000 blocks [0, 9999]', from: 0, to: 9999 },
    { name: '10,001 blocks [0, 10000]', from: 0, to: 10000 },
    { name: '[5, 9999 + 5] (10,000 blocks, offset start)', from: 5, to: 9999 + 5 },
    { name: '[0, 25000]', from: 0, to: 25000 },
    { name: 'two full chunks exactly (19,998 blocks) [3, 20000]', from: 3, to: 3 + 2 * 9999 - 1 },
    { name: 'three full chunks and one block', from: 1, to: 1 + 3 * 9999 },
    { name: 'high block numbers [12345678, 12375678]', from: 12345678, to: 12375678 }
  ];
  for (const c of cases) {
    it('scans ' + c.name + ' in chunks of at most 9,999 blocks: no gaps, no overlaps, all logs once', async () => {
      const server = new FakeRpcServer({ latency: () => 1 });
      seedLogs(server, c.from, c.to, { count: 25, seed: c.from + 7 });
      const client = makeClient(server);
      const result = await scanLogs({ client, address: CONTRACT, topics: [TOPIC0], fromBlock: c.from, toBlock: c.to });
      const total = c.to - c.from + 1;
      const chunks = Math.ceil(total / 9999);
      const calls = server.getLogsCalls();
      for (const call of calls) {
        assert.ok(call.size >= 1 && call.size <= 9999, 'request [' + call.from + ', ' + call.to + '] covers ' + call.size + ' blocks');
      }
      assert.ok(calls.every((call) => call.outcome === 'ok'), 'the node never rejected a request');
      assert.equal(calls.length, chunks);
      const ranges = server.okRanges();
      assertTiles(ranges, c.from, c.to);
      ranges.slice(0, -1).forEach((r) => assert.equal(r.to - r.from + 1, 9999, 'every chunk but the last is full'));
      assert.deepEqual(result.logs, server.expectedLogs(c.from, c.to));
      assert.equal(result.requests, chunks);
      assert.equal(result.fromBlock, c.from);
      assert.equal(result.toBlock, c.to);
      assert.equal(result.scannedThrough, c.to);
    });
  }

  it('honours a smaller chunkSize: every chunk but the last has exactly chunkSize blocks', async () => {
    const server = new FakeRpcServer();
    seedLogs(server, 10, 3009 + 500, { count: 30, seed: 4, chunk: 1000 });
    const result = await scanLogs({ client: makeClient(server), fromBlock: 10, toBlock: 3509, chunkSize: 1000 });
    const ranges = server.okRanges();
    assertTiles(ranges, 10, 3509);
    assert.deepEqual(ranges.map((r) => r.to - r.from + 1), [1000, 1000, 1000, 500]);
    assert.deepEqual(result.logs, server.expectedLogs(10, 3509));
  });

  it('chunkSize 1 requests one block at a time', async () => {
    const server = new FakeRpcServer();
    server.addLogs([10, 12, 12, 24]);
    const result = await scanLogs({ client: makeClient(server), fromBlock: 10, toBlock: 24, chunkSize: 1 });
    assert.equal(server.getLogsCalls().length, 15);
    assert.ok(server.getLogsCalls().every((c) => c.size === 1));
    assertTiles(server.okRanges(), 10, 24);
    assert.deepEqual(result.logs, server.expectedLogs(10, 24));
    assert.equal(result.logs.length, 4);
  });

  it('clamps a chunkSize above 9,999 to 9,999 and treats chunkSize 0 / undefined as the default', async () => {
    for (const chunkSize of [50000, 10000, 0, undefined]) {
      const server = new FakeRpcServer();
      const result = await scanLogs({ client: makeClient(server), fromBlock: 0, toBlock: 30000, chunkSize });
      assert.ok(server.getLogsCalls().every((c) => c.size <= 9999), 'chunkSize ' + chunkSize);
      assert.equal(server.getLogsCalls().length, 4, 'chunkSize ' + chunkSize);
      assertTiles(server.okRanges(), 0, 30000);
      assert.equal(result.scannedThrough, 30000);
    }
  });
});

// ------------------------------------------------------------------------------------------------ scanLogs: concurrency

describe('scanLogs: concurrency', () => {
  const from = 0;
  const to = 26 * 9999 - 1; // 26 full chunks

  it('defaults to 5 requests in flight and actually reaches 5 on a big range', async () => {
    const server = new FakeRpcServer({ latency: seededLatency(11, 2, 5) });
    seedLogs(server, from, to, { count: 60, seed: 11 });
    const result = await scanLogs({ client: makeClient(server), fromBlock: from, toBlock: to });
    assert.equal(server.getLogsCalls().length, 26);
    assert.equal(server.maxInFlight, 5);
    assert.deepEqual(result.logs, server.expectedLogs(from, to));
  });

  it('concurrency 1 is strictly sequential: one request in flight, ranges requested in ascending order', async () => {
    const server = new FakeRpcServer({ latency: seededLatency(12, 1, 4) });
    seedLogs(server, from, to, { count: 60, seed: 12 });
    const result = await scanLogs({ client: makeClient(server), fromBlock: from, toBlock: to, concurrency: 1 });
    assert.equal(server.maxInFlight, 1);
    const starts = server.getLogsCalls().map((c) => c.from);
    assert.deepEqual(starts, starts.slice().sort((a, b) => a - b));
    assert.equal(starts.length, 26);
    const ends = server.getLogsCalls().map((c) => c.endSeq);
    assert.deepEqual(ends, ends.slice().sort((a, b) => a - b), 'each request finished before the next one started');
    assert.deepEqual(result.logs, server.expectedLogs(from, to));
  });

  for (const limit of [2, 3, 8]) {
    it('concurrency ' + limit + ' is reached and never exceeded', async () => {
      const server = new FakeRpcServer({ latency: seededLatency(13 + limit, 2, 5) });
      seedLogs(server, from, to, { count: 40, seed: 13 });
      const result = await scanLogs({ client: makeClient(server), fromBlock: from, toBlock: to, concurrency: limit });
      assert.equal(server.maxInFlight, limit);
      assert.deepEqual(result.logs, server.expectedLogs(from, to));
    });
  }

  it('uses no more workers than there are chunks (2 chunks, concurrency 5 -> 2 in flight)', async () => {
    const server = new FakeRpcServer({ latency: () => 3 });
    await scanLogs({ client: makeClient(server), fromBlock: 0, toBlock: 15000 });
    assert.equal(server.getLogsCalls().length, 2);
    assert.equal(server.maxInFlight, 2);
  });

  it('never exceeds the limit while transient errors are being retried', async () => {
    const server = new FakeRpcServer({ latency: seededLatency(17, 1, 4) });
    seedLogs(server, from, to, { count: 40, seed: 17 });
    server.fail('-32014', { times: 12 });
    server.fail('http429', { times: 3 });
    const result = await scanLogs({ client: makeClient(server, { retries: 8 }), fromBlock: from, toBlock: to, concurrency: 3 });
    assert.equal(server.maxInFlight, 3);
    assert.deepEqual(result.logs, server.expectedLogs(from, to));
  });
});

// ------------------------------------------------------------------------------------------------ scanLogs: ordering

describe('scanLogs: result order', () => {
  it('sorts by (blockNumber, logIndex) numerically even when chunks complete out of order and nodes return shuffled logs', async () => {
    const to = 300000;
    const server = new FakeRpcServer({ latency: seededLatency(21, 1, 9), logOrder: 'shuffle' });
    // hex lengths differ (0x9 / 0x10 / 0x100 / 0x1000 ...): a string sort would put 0x10 before 0x9 and 0x100 before 0x9
    const logIndexes = [256, 9, 4096, 16, 10, 255, 17, 15, 1];
    for (const b of [0, 9, 10, 15, 16, 17, 255, 256, 4095, 4096, 65535, 65536, 262143, 262144]) {
      server.addLogs(logIndexes.map((i) => ({ block: b, logIndex: i })));
    }
    seedLogs(server, 0, to, { count: 400, seed: 21 });
    const result = await scanLogs({ client: makeClient(server), fromBlock: 0, toBlock: to });
    const expected = server.expectedLogs(0, to);
    assert.equal(expected.length, server.logs.length);
    assert.ok(expected.length >= 14 * 9 + 300, 'plenty of logs: ' + expected.length);
    assert.deepEqual(result.logs, expected);
    assert.equal(new Set(result.logs.map((l) => l.blockNumber + ':' + l.logIndex)).size, result.logs.length, 'no duplicates');
    // the data set is meaningful: lexicographic hex order differs from numeric order ...
    const asStrings = expected.slice().sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 :
      a.logIndex < b.logIndex ? -1 : a.logIndex > b.logIndex ? 1 : 0));
    assert.notDeepEqual(asStrings, expected);
    // ... and the chunks really completed out of start order
    const calls = server.getLogsCalls();
    const byEnd = calls.slice().sort((a, b) => a.endSeq - b.endSeq).map((c) => c.seq);
    assert.notDeepEqual(byEnd, calls.map((c) => c.seq), 'completion order differs from start order');
    assert.ok(calls.length >= 30);
  });

  it('orders several logs of one block by numeric logIndex across hex lengths (0x9 < 0x10 < 0x100)', async () => {
    const server = new FakeRpcServer({ logOrder: 'desc' });
    server.addLogs([256, 16, 9, 255, 10, 4096, 1, 0].map((i) => ({ block: 20, logIndex: i })));
    const result = await scanLogs({ client: makeClient(server), fromBlock: 0, toBlock: 100 });
    assert.deepEqual(result.logs.map((l) => parseHexNumber(l.logIndex)), [0, 1, 9, 10, 16, 255, 256, 4096]);
  });

  it('returns logs in ascending block order across chunk boundaries with concurrency 1 and 5', async () => {
    for (const concurrency of [1, 5]) {
      const server = new FakeRpcServer({ latency: seededLatency(23, 1, 5), logOrder: 'desc' });
      seedLogs(server, 0, 80000, { count: 100, seed: 23 });
      const result = await scanLogs({ client: makeClient(server), fromBlock: 0, toBlock: 80000, concurrency });
      assert.deepEqual(result.logs, server.expectedLogs(0, 80000), 'concurrency ' + concurrency);
    }
  });
});

// ------------------------------------------------------------------------------------------------ scanLogs: transient errors

describe('scanLogs: transient errors', () => {
  it('retries -32014 on several chunks and still returns every log exactly once', async () => {
    const from = 0;
    const to = 100000; // 11 chunks
    const server = new FakeRpcServer({ latency: seededLatency(5, 1, 4) });
    seedLogs(server, from, to, { count: 120, seed: 5 });
    server.fail('-32014', { times: 7 });
    server.fail('-32014', { times: 2, when: (c) => c.from === 3 * 9999 });
    const client = makeClient(server, { retries: 8 });
    const result = await scanLogs({ client, fromBlock: from, toBlock: to });
    assert.deepEqual(result.logs, server.expectedLogs(from, to));
    assertTiles(server.okRanges(), from, to);
    const failed = server.getLogsCalls().filter((c) => c.outcome === 'error');
    assert.equal(failed.length, 9);
    assert.ok(failed.every((c) => c.errorCode === -32014));
    assert.equal(client.stats.retries, 9);
    assert.equal(result.requests, 11, 'requests counts logical chunk requests; client retries are not included');
    assert.equal(server.http.length, 11 + 9);
  });

  it('survives HTTP 429, HTTP 500 and thrown network errors in the middle of a scan', async () => {
    const from = 0;
    const to = 70000;
    const server = new FakeRpcServer({ latency: seededLatency(6, 1, 4) });
    seedLogs(server, from, to, { count: 80, seed: 6 });
    server.fail('http429', { times: 2 });
    server.fail('http500', { times: 2 });
    server.fail('network', { times: 2 });
    const client = makeClient(server, { retries: 6 });
    const result = await scanLogs({ client, fromBlock: from, toBlock: to });
    assert.deepEqual(result.logs, server.expectedLogs(from, to));
    assertTiles(server.okRanges(), from, to);
    assert.equal(client.stats.retries, 6);
    assert.equal(server.getLogsCalls().filter((c) => c.outcome !== 'ok').length, 6);
  });

  it('gives up on a chunk that keeps failing with -32014: rejects with that error (.attempts) and the prefix before it', async () => {
    const from = 0;
    const to = 59999;
    const failFrom = 2 * 9999;
    const server = new FakeRpcServer({ latency: () => 1 });
    seedLogs(server, from, to, { count: 60, seed: 9 });
    server.fail('-32014', { times: Infinity, when: (c) => c.from === failFrom });
    const client = makeClient(server, { retries: 2 });
    const err = await rejection(scanLogs({ client, fromBlock: from, toBlock: to, concurrency: 1 }));
    assert.equal(err.code, -32014);
    assert.equal(err.attempts, 3);
    assert.equal(server.http.length, 2 + 3, 'two good chunks, then three attempts at the failing one');
    assert.equal(verifyPartial(server, err, from), failFrom - 1);
  });
});

// ------------------------------------------------------------------------------------------------ scanLogs: -32012 halving

describe('scanLogs: -32012 range halving', () => {
  it('halves chunks when the node limit (1,000) is below the client chunkSize (9,999); the reduced size is remembered', async () => {
    const from = 0;
    const to = 199999;
    const server = new FakeRpcServer({ maxRange: 1000, latency: seededLatency(3, 1, 3) });
    seedLogs(server, from, to, { count: 250, seed: 3, chunk: 625 });
    const client = makeClient(server);
    const result = await scanLogs({ client, fromBlock: from, toBlock: to });
    const calls = server.getLogsCalls();
    const failing = calls.filter((c) => c.outcome === 'error');
    const good = calls.filter((c) => c.outcome === 'ok');
    assert.ok(failing.length > 0, 'the node did reject the first, too large, chunks');
    assert.ok(failing.every((c) => c.errorCode === -32012 && c.size > 1000));
    assert.ok(good.every((c) => c.size <= 1000));
    assertTiles(server.okRanges(), from, to);
    assert.deepEqual(result.logs, server.expectedLogs(from, to));
    assert.ok(failing.length <= 5 * 15, 'at most the 5 first-wave chunks are split (' + failing.length + ' rejected requests)');
    assert.ok(failing.every((c) => c.from < 5 * 9999), 'no request after the first wave is rejected: later chunks use the reduced size');
    assert.ok(calls.filter((c) => c.from >= 5 * 9999).every((c) => c.size <= 625));
    assert.equal(client.stats.retries, 0, '-32012 is handled by the scanner, not retried by the client');
    assert.equal(result.requests, calls.length);
  });

  it('with concurrency 1 only the very first chunk is split (<= 15 rejected requests) and the rest uses the reduced size', async () => {
    const from = 100;
    const to = 100 + 120000;
    const server = new FakeRpcServer({ maxRange: 1000 });
    seedLogs(server, from, to, { count: 150, seed: 33, chunk: 625 });
    const result = await scanLogs({ client: makeClient(server), fromBlock: from, toBlock: to, concurrency: 1 });
    const calls = server.getLogsCalls();
    const failing = calls.filter((c) => c.outcome === 'error');
    assert.ok(failing.length >= 1 && failing.length <= 15, 'rejected requests: ' + failing.length);
    assert.ok(failing.every((c) => c.from < from + 9999));
    assert.ok(calls.filter((c) => c.from >= from + 9999).every((c) => c.outcome === 'ok' && c.size <= 625));
    assertTiles(server.okRanges(), from, to);
    assert.deepEqual(result.logs, server.expectedLogs(from, to));
  });

  it('copes with odd limits and offsets (maxRange 7, chunkSize 100, range [3, 1002])', async () => {
    const server = new FakeRpcServer({ maxRange: 7, latency: seededLatency(8, 1, 3) });
    seedLogs(server, 3, 1002, { count: 150, seed: 8, chunk: 7 });
    const result = await scanLogs({ client: makeClient(server), fromBlock: 3, toBlock: 1002, chunkSize: 100 });
    assert.ok(server.okRanges().every((r) => r.to - r.from + 1 <= 7));
    assertTiles(server.okRanges(), 3, 1002);
    assert.deepEqual(result.logs, server.expectedLogs(3, 1002));
  });

  it('maxRange 1 ends up requesting single blocks and still covers [10, 40] exactly once', async () => {
    const server = new FakeRpcServer({ maxRange: 1 });
    server.addLogs([10, 10, 25, 40, 40, 40]);
    const result = await scanLogs({ client: makeClient(server), fromBlock: 10, toBlock: 40, chunkSize: 8 });
    const ranges = server.okRanges();
    assert.equal(ranges.length, 31);
    assert.ok(ranges.every((r) => r.from === r.to));
    assertTiles(ranges, 10, 40);
    assert.deepEqual(result.logs, server.expectedLogs(10, 40));
    assert.equal(result.logs.length, 6);
  });

  it('recognises a range-limit error by its message when the code is not -32012', async () => {
    const server = new FakeRpcServer({ maxRange: 500, rangeError: { code: -32000, message: 'query exceeds max block range 500' } });
    seedLogs(server, 0, 20000, { count: 50, seed: 2, chunk: 500 });
    const result = await scanLogs({ client: makeClient(server), fromBlock: 0, toBlock: 20000 });
    assertTiles(server.okRanges(), 0, 20000);
    assert.deepEqual(result.logs, server.expectedLogs(0, 20000));
  });

  it('a single block that keeps failing with -32012 throws it (no endless halving)', async () => {
    const server = new FakeRpcServer({ maxRange: 0 });
    const err = await rejection(scanLogs({ client: makeClient(server), fromBlock: 50, toBlock: 50 }));
    assert.equal(err.code, -32012);
    assert.equal(server.getLogsCalls().length, 1);
    assert.deepEqual(err.partial, { logs: [], scannedThrough: 49 });
  });

  it('a node that rejects every range halves down to single blocks, then throws -32012 after bounded work', async () => {
    const server = new FakeRpcServer({ maxRange: 0 });
    const err = await rejection(scanLogs({ client: makeClient(server), fromBlock: 0, toBlock: 20, chunkSize: 8 }));
    assert.equal(err.code, -32012);
    assert.ok(server.getLogsCalls().every((c) => c.outcome === 'error'));
    assert.ok(server.getLogsCalls().length < 100, 'requests: ' + server.getLogsCalls().length);
    assert.ok(server.getLogsCalls().some((c) => c.size === 1), 'got down to a single block');
    assert.deepEqual(err.partial, { logs: [], scannedThrough: -1 });
  });

  it('one poisoned block (always -32012): throws after splitting down to it; partial covers only whole completed chunks', async () => {
    const server = new FakeRpcServer();
    seedLogs(server, 0, 300, { count: 40, seed: 14, chunk: 100 });
    server.fail('-32012', { times: Infinity, when: (c) => c.from <= 123 && c.to >= 123 });
    const err = await rejection(scanLogs({ client: makeClient(server), fromBlock: 0, toBlock: 300, chunkSize: 100, concurrency: 1 }));
    assert.equal(err.code, -32012);
    const last = server.getLogsCalls().filter((c) => c.outcome === 'error').pop();
    assert.equal(last.size, 1);
    assert.equal(last.from, 123);
    assert.equal(err.partial.scannedThrough, 99, 'chunk [0, 99] completed; chunk [100, 199] did not');
    assert.deepEqual(err.partial.logs, server.expectedLogs(0, 99));
  });
});

// ------------------------------------------------------------------------------------------------ scanLogs: filter passthrough

describe('scanLogs: filter passthrough', () => {
  const T1 = '0x' + 'aa'.repeat(32);
  const T2 = '0x' + 'bb'.repeat(32);

  it('sends address and topics (nested arrays and null wildcards) unchanged in every request, with hex block bounds', async () => {
    const topics = [TOPIC0, null, [T1, T2], null];
    const server = new FakeRpcServer();
    await scanLogs({ client: makeClient(server), address: [CONTRACT, OTHER_CONTRACT], topics, fromBlock: 0, toBlock: 25000 });
    assert.equal(server.getLogsCalls().length, 3);
    for (const c of server.getLogsCalls()) {
      const f = c.params[0];
      assert.deepEqual(Object.keys(f).sort(), ['address', 'fromBlock', 'toBlock', 'topics']);
      assert.deepEqual(f.address, [CONTRACT, OTHER_CONTRACT]);
      assert.deepEqual(f.topics, topics);
      assert.equal(f.topics[1], null, 'null wildcard survives');
      assert.equal(f.topics[3], null);
      assert.equal(f.fromBlock, hex(c.from));
      assert.equal(f.toBlock, hex(c.to));
    }
  });

  it('sends a single address string as is; without address/topics those keys are absent', async () => {
    const server = new FakeRpcServer();
    await scanLogs({ client: makeClient(server), address: CONTRACT, fromBlock: 5, toBlock: 9 });
    assert.deepEqual(server.getLogsCalls()[0].params[0], { address: CONTRACT, fromBlock: '0x5', toBlock: '0x9' });
    const bare = new FakeRpcServer();
    await scanLogs({ client: makeClient(bare), fromBlock: 5, toBlock: 9 });
    assert.deepEqual(bare.getLogsCalls()[0].params[0], { fromBlock: '0x5', toBlock: '0x9' });
  });

  it('the node-side filter applies: other contracts and other topics are not returned', async () => {
    const server = new FakeRpcServer();
    server.addLogs([
      { block: 5 },
      { block: 6, address: OTHER_CONTRACT },
      { block: 7, topics: [TOPIC0, T1] },
      { block: 8, topics: [TOPIC0, T2] },
      { block: 9, topics: ['0x' + '22'.repeat(32), T1] }
    ]);
    const result = await scanLogs({ client: makeClient(server), address: CONTRACT, topics: [TOPIC0, [T1, T2]], fromBlock: 0, toBlock: 20 });
    assert.deepEqual(result.logs.map((l) => parseHexNumber(l.blockNumber)), [7, 8]);
  });

  it('hands numeric block bounds and the abort signal to client.getLogs (the client does the hex conversion)', async () => {
    const seen = [];
    const stub = { getLogs: async (filter, o) => { seen.push({ filter, o }); return []; } };
    const ac = new AbortController();
    await scanLogs({ client: stub, address: CONTRACT, topics: [TOPIC0], fromBlock: 5, toBlock: 20000, chunkSize: 9999, signal: ac.signal });
    const filters = seen.map((s) => s.filter).sort((a, b) => a.fromBlock - b.fromBlock);
    assert.deepEqual(filters.map((f) => [f.fromBlock, f.toBlock]), [[5, 10003], [10004, 20000]]);
    assert.ok(filters.every((f) => f.address === CONTRACT && f.topics[0] === TOPIC0));
    assert.ok(seen.every((s) => s.o && s.o.signal === ac.signal));
  });
});

// ------------------------------------------------------------------------------------------------ scanLogs: progress

describe('scanLogs: onProgress', () => {
  it('reports monotonically growing progress that ends at totalBlocks with the right logsFound', async () => {
    const from = 1000;
    const to = 1000 + 60000 - 1;
    const server = new FakeRpcServer({ latency: seededLatency(31, 1, 6) });
    seedLogs(server, from, to, { count: 90, seed: 31 });
    const events = [];
    const result = await scanLogs({ client: makeClient(server), fromBlock: from, toBlock: to, onProgress: (p) => events.push(p) });
    const total = to - from + 1;
    assert.ok(events.length >= 2);
    assert.equal(events[0].scannedBlocks, 0);
    events.forEach((e, i) => {
      assert.equal(e.totalBlocks, total);
      assert.equal(e.fromBlock, from);
      assert.equal(e.toBlock, to);
      assert.ok(e.scannedBlocks >= 0 && e.scannedBlocks <= total);
      if (i > 0) {
        assert.ok(e.scannedBlocks >= events[i - 1].scannedBlocks, 'scannedBlocks never decreases');
        assert.ok(e.logsFound >= events[i - 1].logsFound, 'logsFound never decreases');
        assert.ok(e.requests >= events[i - 1].requests);
      }
    });
    const last = events[events.length - 1];
    assert.equal(last.scannedBlocks, total);
    assert.equal(last.totalBlocks, total);
    assert.equal(last.logsFound, result.logs.length);
    assert.equal(last.requests, result.requests);
    assert.equal(new Set(events).size, events.length, 'every event is a fresh object');
  });

  it('single chunk: reports 0 scanned first and everything scanned last', async () => {
    const server = new FakeRpcServer();
    server.addLogs([3, 4, 4]);
    const events = [];
    await scanLogs({ client: makeClient(server), fromBlock: 0, toBlock: 99, onProgress: (p) => events.push(Object.assign({}, p)) });
    assert.deepEqual(events.map((e) => e.scannedBlocks), [0, 100]);
    assert.deepEqual(events.map((e) => e.logsFound), [0, 3]);
    assert.ok(events.every((e) => e.totalBlocks === 100));
  });

  it('progress is also reported while -32012 halving is going on and never exceeds totalBlocks', async () => {
    const server = new FakeRpcServer({ maxRange: 300, latency: seededLatency(32, 1, 3) });
    seedLogs(server, 0, 30000, { count: 30, seed: 32, chunk: 300 });
    const events = [];
    await scanLogs({ client: makeClient(server), fromBlock: 0, toBlock: 30000, onProgress: (p) => events.push(p) });
    assert.ok(events.every((e) => e.scannedBlocks <= 30001));
    assert.equal(events[events.length - 1].scannedBlocks, 30001);
    for (let i = 1; i < events.length; i++) assert.ok(events[i].scannedBlocks >= events[i - 1].scannedBlocks);
  });

  it('an onProgress that throws does not break the scan', async () => {
    const server = new FakeRpcServer({ latency: seededLatency(34, 1, 3) });
    seedLogs(server, 0, 50000, { count: 40, seed: 34 });
    let calls = 0;
    const result = await scanLogs({
      client: makeClient(server), fromBlock: 0, toBlock: 50000,
      onProgress: () => { calls++; throw new Error('the UI exploded'); }
    });
    assert.ok(calls >= 2, 'it was called, and kept being called after throwing');
    assert.deepEqual(result.logs, server.expectedLogs(0, 50000));
    assert.equal(result.scannedThrough, 50000);
  });

  it('a non-function onProgress is ignored', async () => {
    const server = new FakeRpcServer();
    server.addLogs([1]);
    const result = await scanLogs({ client: makeClient(server), fromBlock: 0, toBlock: 10, onProgress: 'not a function' });
    assert.equal(result.logs.length, 1);
  });
});

// ------------------------------------------------------------------------------------------------ scanLogs: abort

describe('scanLogs: abort', () => {
  const from = 500;
  const CHUNK = 1000;
  const to = from + 12 * CHUNK - 1; // 12 chunks of 1,000 blocks

  it('abort after the first 3 requests (sequential): AbortError, partial = chunks 0-2, nothing requested afterwards', async () => {
    const server = new FakeRpcServer({ latency: () => 2 });
    seedLogs(server, from, to, { count: 80, seed: 3, chunk: CHUNK });
    const ac = new AbortController();
    server.onCall = (rec) => { if (rec.seq === 3) ac.abort(); };
    const err = await rejection(scanLogs({ client: makeClient(server), fromBlock: from, toBlock: to, chunkSize: CHUNK, concurrency: 1, signal: ac.signal }));
    assert.equal(err.name, 'AbortError');
    assert.deepEqual(server.getLogsCalls().map((c) => c.outcome), ['ok', 'ok', 'ok', 'aborted']);
    assert.equal(server.http.length, 4, 'no request after the abort');
    const through = verifyPartial(server, err, from);
    assert.equal(through, from + 3 * CHUNK - 1);
    assert.ok(err.partial.logs.length > 0);
    assert.equal(server.inFlight, 0, 'the in-flight request was cancelled');
  });

  it('partial is the contiguous prefix: chunk 0 still in flight at abort time -> empty, although later chunks completed', async () => {
    const server = new FakeRpcServer({ latency: (rec) => (rec.from === from ? 12 : 1) });
    seedLogs(server, from, to, { count: 80, seed: 4, chunk: CHUNK });
    const ac = new AbortController();
    server.onCall = (rec) => { if (rec.seq === 8) ac.abort(); };
    const err = await rejection(scanLogs({ client: makeClient(server), fromBlock: from, toBlock: to, chunkSize: CHUNK, concurrency: 4, signal: ac.signal }));
    assert.equal(err.name, 'AbortError');
    const ok = server.okRanges();
    assert.ok(ok.length >= 3, 'later chunks did complete: ' + JSON.stringify(ok));
    assert.ok(ok.every((r) => r.from > from));
    assert.equal(err.partial.scannedThrough, from - 1);
    assert.deepEqual(err.partial.logs, []);
    verifyPartial(server, err, from);
  });

  it('partial stops at the first hole: chunk 2 slow, chunks 3+ completed -> prefix is chunks 0-1', async () => {
    const hole = from + 2 * CHUNK;
    const server = new FakeRpcServer({ latency: (rec) => (rec.from === hole ? 12 : 1) });
    seedLogs(server, from, to, { count: 80, seed: 5, chunk: CHUNK });
    const ac = new AbortController();
    server.onCall = (rec) => { if (rec.seq === 9) ac.abort(); };
    const err = await rejection(scanLogs({ client: makeClient(server), fromBlock: from, toBlock: to, chunkSize: CHUNK, concurrency: 3, signal: ac.signal }));
    assert.equal(err.name, 'AbortError');
    assert.ok(server.okRanges().some((r) => r.from > hole), 'chunks after the hole completed');
    const through = verifyPartial(server, err, from);
    assert.equal(through, hole - 1);
    assert.deepEqual(err.partial.logs, server.expectedLogs(from, hole - 1));
  });

  it('abort in the middle of a default 5-way scan with shuffled latencies: partial matches the server log exactly', async () => {
    const bigTo = from + 40 * CHUNK - 1;
    const server = new FakeRpcServer({ latency: seededLatency(41, 1, 8), logOrder: 'shuffle' });
    seedLogs(server, from, bigTo, { count: 300, seed: 41, chunk: CHUNK });
    const ac = new AbortController();
    server.onCall = (rec) => { if (rec.seq === 17) ac.abort(); };
    const err = await rejection(scanLogs({ client: makeClient(server), fromBlock: from, toBlock: bigTo, chunkSize: CHUNK, signal: ac.signal }));
    assert.equal(err.name, 'AbortError');
    const through = verifyPartial(server, err, from);
    assert.ok(through < bigTo);
    assert.ok(server.http.length <= 17 + 1, 'no new request after the abort: ' + server.http.length);
    assert.equal(server.inFlight, 0);
    // sorted
    assert.deepEqual(err.partial.logs, err.partial.logs.slice().sort(compareLogs));
  });

  it('an already-aborted signal rejects with AbortError before any request', async () => {
    const server = new FakeRpcServer();
    const ac = new AbortController();
    ac.abort();
    const err = await rejection(scanLogs({ client: makeClient(server), fromBlock: 0, toBlock: 50000, signal: ac.signal }));
    assert.equal(err.name, 'AbortError');
    assert.equal(server.http.length, 0);
    assert.deepEqual(err.partial, { logs: [], scannedThrough: -1 });
  });

  it('after an abort, resuming at partial.scannedThrough + 1 and concatenating equals a full scan', async () => {
    const server = new FakeRpcServer({ latency: seededLatency(43, 1, 5) });
    seedLogs(server, from, to, { count: 120, seed: 43, chunk: CHUNK });
    const client = makeClient(server);
    const ac = new AbortController();
    server.onCall = (rec) => { if (rec.seq === 7) ac.abort(); };
    const err = await rejection(scanLogs({ client, fromBlock: from, toBlock: to, chunkSize: CHUNK, concurrency: 3, signal: ac.signal }));
    assert.equal(err.name, 'AbortError');
    server.onCall = null;
    const resumed = await scanLogs({ client, fromBlock: err.partial.scannedThrough + 1, toBlock: to, chunkSize: CHUNK, concurrency: 3 });
    const full = await scanLogs({ client, fromBlock: from, toBlock: to, chunkSize: CHUNK });
    assert.deepEqual(err.partial.logs.concat(resumed.logs), full.logs);
    assert.deepEqual(full.logs, server.expectedLogs(from, to));
  });

  it('aborting during -32012 halving also yields AbortError with a consistent partial', async () => {
    const server = new FakeRpcServer({ maxRange: 1000, latency: () => 1 });
    seedLogs(server, 0, 60000, { count: 60, seed: 44, chunk: 625 });
    const ac = new AbortController();
    server.onCall = (rec) => { if (rec.seq === 12) ac.abort(); };
    const err = await rejection(scanLogs({ client: makeClient(server), fromBlock: 0, toBlock: 60000, signal: ac.signal }));
    assert.equal(err.name, 'AbortError');
    assert.ok(err.partial && typeof err.partial.scannedThrough === 'number');
    assert.deepEqual(err.partial.logs, server.expectedLogs(0, err.partial.scannedThrough));
  });
});

// ------------------------------------------------------------------------------------------------ scanLogs: failures and resume

describe('scanLogs: failures and resume', () => {
  const from = 2000;
  const CHUNK = 1000;
  const to = from + 12 * CHUNK - 1;
  const failFrom = from + 4 * CHUNK; // the 5th chunk

  it('a non-retryable error (revert, code 3) on one chunk rejects with that error and the contiguous prefix; no new chunks start', async () => {
    const server = new FakeRpcServer({ latency: (rec) => (rec.from === failFrom ? 1 : 3) });
    seedLogs(server, from, to, { count: 100, seed: 12, chunk: CHUNK });
    server.fail('revert', { times: 1, when: (c) => c.from === failFrom });
    const client = makeClient(server);
    const err = await rejection(scanLogs({ client, fromBlock: from, toBlock: to, chunkSize: CHUNK, concurrency: 3 }));
    assert.equal(err.name, 'RpcError');
    assert.equal(err.code, 3);
    assert.equal(err.message, 'execution reverted: boom');
    assert.equal(err.data, REVERT_DATA);
    assert.equal(err.attempts, 1);
    const calls = server.getLogsCalls();
    assert.equal(calls.filter((c) => c.from === failFrom).length, 1, 'the failing chunk was not retried');
    assert.ok(calls.length >= 5 && calls.length <= 4 + 3, 'bounded extra requests: ' + calls.length);
    assert.ok(Math.max(...calls.map((c) => c.from)) < from + (4 + 3) * CHUNK, 'no chunk beyond the in-flight window was started');
    assert.ok(calls.length < 12, 'the scan stopped early');
    const through = verifyPartial(server, err, from);
    assert.equal(through, failFrom - 1, 'chunks 0-3 are kept (chunk 3 finished after the failure), chunk 5 is not contiguous');
    assert.equal(server.inFlight, 0);
  });

  it('sequential scan: exactly the chunks up to and including the failing one are requested', async () => {
    const server = new FakeRpcServer({ latency: () => 1 });
    seedLogs(server, from, to, { count: 100, seed: 13, chunk: CHUNK });
    server.fail('revert', { times: 1, when: (c) => c.from === failFrom });
    const err = await rejection(scanLogs({ client: makeClient(server), fromBlock: from, toBlock: to, chunkSize: CHUNK, concurrency: 1 }));
    assert.equal(err.code, 3);
    assert.equal(server.getLogsCalls().length, 5);
    assert.equal(verifyPartial(server, err, from), failFrom - 1);
  });

  it('failure on the very first chunk: empty partial before fromBlock', async () => {
    const server = new FakeRpcServer();
    server.addLogs([from + 5]);
    server.fail('revert', { times: 1, when: (c) => c.from === from });
    const err = await rejection(scanLogs({ client: makeClient(server), fromBlock: from, toBlock: to, chunkSize: CHUNK, concurrency: 1 }));
    assert.equal(err.code, 3);
    assert.deepEqual(err.partial, { logs: [], scannedThrough: from - 1 });
  });

  it('a non-JSON answer (BAD_RESPONSE) mid-scan also rejects with partial', async () => {
    const server = new FakeRpcServer({ latency: () => 1 });
    seedLogs(server, from, to, { count: 60, seed: 14, chunk: CHUNK });
    server.fail('badjson', { times: 1, when: (c) => c.from === failFrom });
    const err = await rejection(scanLogs({ client: makeClient(server), fromBlock: from, toBlock: to, chunkSize: CHUNK, concurrency: 1 }));
    assert.equal(err.code, 'BAD_RESPONSE');
    assert.equal(verifyPartial(server, err, from), failFrom - 1);
  });

  it('resume works: scanning [scannedThrough + 1, to] and concatenating equals a full scan', async () => {
    const server = new FakeRpcServer({ latency: (rec) => (rec.from === failFrom ? 1 : 3) });
    seedLogs(server, from, to, { count: 150, seed: 15, chunk: CHUNK });
    server.fail('revert', { times: 1, when: (c) => c.from === failFrom });
    const client = makeClient(server);
    const err = await rejection(scanLogs({ client, fromBlock: from, toBlock: to, chunkSize: CHUNK, concurrency: 3 }));
    assert.equal(err.code, 3);
    const through = err.partial.scannedThrough;
    assert.equal(through, failFrom - 1);
    const resumed = await scanLogs({ client, fromBlock: through + 1, toBlock: to, chunkSize: CHUNK, concurrency: 3 });
    assert.equal(resumed.scannedThrough, to);
    const combined = err.partial.logs.concat(resumed.logs);
    const full = await scanLogs({ client, fromBlock: from, toBlock: to, chunkSize: CHUNK, concurrency: 3 });
    assert.deepEqual(combined, full.logs);
    assert.deepEqual(full.logs, server.expectedLogs(from, to));
    assert.equal(new Set(combined.map((l) => l.blockNumber + ':' + l.logIndex)).size, combined.length, 'no log twice');
  });

  it('a plain Error thrown by the client is normalised (NETWORK) and still carries partial', async () => {
    let n = 0;
    const stub = { getLogs: async () => { if (++n === 3) throw new TypeError('boom'); return []; } };
    const err = await rejection(scanLogs({ client: stub, fromBlock: 0, toBlock: 99999, chunkSize: 1000, concurrency: 1 }));
    assert.equal(err.name, 'RpcError');
    assert.equal(err.code, 'NETWORK');
    assert.equal(err.message, 'boom');
    assert.deepEqual(err.partial, { logs: [], scannedThrough: 1999 });
  });

  it('first failure wins: a later failure of another in-flight chunk does not replace it', async () => {
    // chunk 1 fails at tick 1 (revert), chunk 2 fails at tick 5 (-32000), chunk 0 completes at tick 3
    const server = new FakeRpcServer({ latency: (rec) => (rec.from === from + CHUNK ? 1 : rec.from === from + 2 * CHUNK ? 5 : 3) });
    seedLogs(server, from, to, { count: 40, seed: 16, chunk: CHUNK });
    server.fail('revert', { times: 1, when: (c) => c.from === from + CHUNK });
    server.fail('-32000', { times: Infinity, when: (c) => c.from === from + 2 * CHUNK });
    const err = await rejection(scanLogs({ client: makeClient(server), fromBlock: from, toBlock: to, chunkSize: CHUNK, concurrency: 3 }));
    assert.equal(err.code, 3, 'the earlier failure (chunk 1) is the one reported');
    assert.equal(server.getLogsCalls().length, 3, 'nothing was started after the first failure');
    assert.equal(server.getLogsCalls().find((c) => c.from === from + 2 * CHUNK).errorCode, -32000, 'the second failure really happened');
    assert.equal(err.partial.scannedThrough, from + CHUNK - 1);
    assert.deepEqual(err.partial.logs, server.expectedLogs(from, from + CHUNK - 1));
  });
});

// ------------------------------------------------------------------------------------------------ scanLogs: empty ranges

describe('scanLogs: empty ranges', () => {
  it('toBlock < fromBlock returns an empty result without any request', async () => {
    const server = new FakeRpcServer();
    server.addLogs([1, 2, 3, 4, 5]);
    const result = await scanLogs({ client: makeClient(server), fromBlock: 6, toBlock: 5 });
    assert.deepEqual(result.logs, []);
    assert.equal(result.requests, 0);
    assert.equal(result.fromBlock, 6);
    assert.equal(result.toBlock, 5);
    assert.equal(result.scannedThrough, 5);
    assert.equal(server.http.length, 0);
  });

  it('a clearly inverted range is empty too', async () => {
    const server = new FakeRpcServer();
    const result = await scanLogs({ client: makeClient(server), fromBlock: 100, toBlock: 50 });
    assert.deepEqual(result.logs, []);
    assert.equal(result.requests, 0);
    assert.equal(server.http.length, 0);
  });

  it('a single-block range [7, 7] is one request', async () => {
    const server = new FakeRpcServer();
    server.addLogs([7, 7, 8]);
    const result = await scanLogs({ client: makeClient(server), fromBlock: 7, toBlock: 7 });
    assert.equal(result.logs.length, 2);
    assert.equal(server.getLogsCalls().length, 1);
    assert.deepEqual(server.getLogsCalls().map((c) => [c.from, c.to]), [[7, 7]]);
  });
});

// ------------------------------------------------------------------------------------------------ findFirstBlockAtOrAfter

describe('findFirstBlockAtOrAfter', () => {
  const BASE = 1700000000;
  const HEAD = 1000; // block n has timestamp BASE + floor(n / 2): blocks 2k and 2k + 1 share a timestamp
  const newChain = (head = HEAD) => {
    const server = new FakeRpcServer({ head, baseTimestamp: BASE });
    return { server, client: makeClient(server) };
  };
  const brute = (server, ts, lo, hi) => {
    for (let n = lo; n <= hi; n++) if (server.timestampOf(n) >= ts) return n;
    return null;
  };
  const blockCalls = (server) => server.calls.filter((c) => c.method === 'eth_getBlockByNumber');
  const budget = (range) => Math.ceil(Math.log2(range)) + 2;

  it('returns 0 for the genesis timestamp (start of the chain)', async () => {
    const { client } = newChain();
    assert.equal(await findFirstBlockAtOrAfter(client, BASE), 0);
  });

  it('a timestamp shared by two blocks resolves to the first of them', async () => {
    const { client } = newChain();
    assert.equal(await findFirstBlockAtOrAfter(client, BASE + 1), 2);
    assert.equal(await findFirstBlockAtOrAfter(client, BASE + 250), 500, 'not 501');
    assert.equal(await findFirstBlockAtOrAfter(client, BASE + 499), 998);
  });

  it('finds a mid-chain timestamp exactly; a timestamp between block timestamps lands on the next block', async () => {
    const { client } = newChain();
    assert.equal(await findFirstBlockAtOrAfter(client, BASE + 123), 246);
    assert.equal(await findFirstBlockAtOrAfter(client, BASE + 250.5), 502);
    assert.equal(await findFirstBlockAtOrAfter(client, BASE + 0.25), 2);
  });

  it('a timestamp equal to the latest block returns the head (or the first block sharing that timestamp)', async () => {
    const even = newChain(1000); // head 1000 is alone at BASE + 500
    assert.equal(await findFirstBlockAtOrAfter(even.client, BASE + 500), 1000);
    const odd = newChain(1001); // blocks 1000 and 1001 share BASE + 500
    assert.equal(await findFirstBlockAtOrAfter(odd.client, BASE + 500), 1000);
    const one = newChain(1);
    assert.equal(await findFirstBlockAtOrAfter(one.client, BASE), 0);
  });

  it('a timestamp beyond the latest block returns null after only two requests', async () => {
    const { client, server } = newChain();
    assert.equal(await findFirstBlockAtOrAfter(client, BASE + 501), null);
    assert.deepEqual(server.calls.map((c) => c.method), ['eth_blockNumber', 'eth_getBlockByNumber']);
    assert.deepEqual(server.calls[1].params, [hexNumber(HEAD), false]);
  });

  it('a timestamp before the genesis timestamp returns lo (0 by default, lo when given)', async () => {
    const { client } = newChain();
    assert.equal(await findFirstBlockAtOrAfter(client, BASE - 1000), 0);
    assert.equal(await findFirstBlockAtOrAfter(client, BASE - 1000, { lo: 300 }), 300);
  });

  it('matches a brute-force search for every timestamp, in at most ceil(log2(range)) + 2 eth_getBlockByNumber calls', async () => {
    const { client, server } = newChain();
    let worst = 0;
    for (let ts = BASE - 2; ts <= BASE + HEAD / 2 + 3; ts++) {
      const before = blockCalls(server).length;
      const got = await findFirstBlockAtOrAfter(client, ts);
      const used = blockCalls(server).length - before;
      assert.equal(got, brute(server, ts, 0, HEAD), 'ts = BASE + ' + (ts - BASE));
      assert.ok(used <= budget(HEAD + 1), 'ts = BASE + ' + (ts - BASE) + ' took ' + used + ' calls');
      worst = Math.max(worst, used);
    }
    assert.ok(worst >= 9, 'the search really is a binary search over ~1000 blocks (worst case ' + worst + ' calls)');
  });

  it('also matches brute force on a larger chain (head 1,000,000) with a logarithmic number of calls', async () => {
    const { client, server } = newChain(1000000);
    for (const offset of [0, 1, 2, 77777, 250000, 499999, 500000]) {
      const before = blockCalls(server).length;
      assert.equal(await findFirstBlockAtOrAfter(client, BASE + offset), Math.min(2 * offset, 1000000), 'offset ' + offset);
      assert.ok(blockCalls(server).length - before <= budget(1000001));
    }
  });

  it('works with lo > 0 and an explicit hi, without asking for eth_blockNumber', async () => {
    const { client, server } = newChain();
    const opts = { lo: 300, hi: 700 };
    for (const ts of [BASE + 10, BASE + 150, BASE + 151, BASE + 200, BASE + 349, BASE + 350]) {
      const before = blockCalls(server).length;
      assert.equal(await findFirstBlockAtOrAfter(client, ts, opts), brute(server, ts, 300, 700), 'ts = BASE + ' + (ts - BASE));
      assert.ok(blockCalls(server).length - before <= budget(401));
    }
    assert.equal(await findFirstBlockAtOrAfter(client, BASE + 200, opts), 400);
    assert.equal(await findFirstBlockAtOrAfter(client, BASE + 10, opts), 300, 'older than block lo -> lo');
    assert.equal(await findFirstBlockAtOrAfter(client, BASE + 351, opts), null, 'newer than block hi -> null, even though the chain goes on');
    assert.ok(!server.calls.some((c) => c.method === 'eth_blockNumber'));
    assert.ok(blockCalls(server).every((c) => parseHexNumber(c.params[0]) >= 300 && parseHexNumber(c.params[0]) <= 700), 'only blocks inside [lo, hi] are read');
  });

  it('without hi it asks for the head exactly once', async () => {
    const { client, server } = newChain();
    await findFirstBlockAtOrAfter(client, BASE + 321);
    assert.equal(server.calls.filter((c) => c.method === 'eth_blockNumber').length, 1);
  });

  it('forwards the abort signal to the block lookups: aborting a hanging eth_getBlockByNumber rejects with AbortError', async () => {
    const { client, server } = newChain();
    server.fail('hang', { times: Infinity, when: (c) => c.method === 'eth_getBlockByNumber' });
    const ac = new AbortController();
    const p = findFirstBlockAtOrAfter(client, BASE + 5, { hi: 900, signal: ac.signal });
    await tick();
    ac.abort();
    const err = await rejection(p);
    assert.equal(err.name, 'AbortError');
    assert.equal(server.http.length, 1);
  });

  it('an already-aborted signal rejects with AbortError and sends no request when hi is given', async () => {
    const { client, server } = newChain();
    const ac = new AbortController();
    ac.abort();
    const err = await rejection(findFirstBlockAtOrAfter(client, BASE + 5, { hi: 900, signal: ac.signal }));
    assert.equal(err.name, 'AbortError');
    assert.equal(server.http.length, 0);
  });

  // Known module bug: findFirstBlockAtOrAfter calls client.blockNumber() WITHOUT { signal }, so the abort signal is not
  // forwarded to the very first request; aborting while eth_blockNumber is in flight does not cancel it.
  it('forwards the abort signal to the initial eth_blockNumber lookup (hi omitted)', async () => {
    const { server } = newChain();
    server.fail('hang', { times: Infinity, when: (c) => c.method === 'eth_blockNumber' });
    const slowClient = makeClient(server, { timeoutMs: 300, retries: 0 }); // bounds the damage when the signal is ignored
    const ac = new AbortController();
    const t0 = Date.now();
    const p = findFirstBlockAtOrAfter(slowClient, BASE + 5, { signal: ac.signal });
    await tick();
    ac.abort();
    const err = await rejection(p);
    assert.equal(err.name, 'AbortError', 'got ' + err.name + '/' + err.code + ' after ' + (Date.now() - t0) + ' ms instead of an immediate AbortError');
  });
});

// ------------------------------------------------------------------------------------------------ waitForReceipt

describe('waitForReceipt', () => {
  const HASH = '0x' + 'ee'.repeat(32);
  const RECEIPT = { transactionHash: HASH, status: '0x1', blockNumber: '0x10', gasUsed: '0x5208' };

  /** Fake clock: sleep() advances now() by the requested time, so nothing really waits. */
  function fakeClock(start = 1000000) {
    const clock = { t: start, sleeps: [] };
    clock.now = () => clock.t;
    clock.sleep = async (ms) => { clock.sleeps.push(ms); clock.t += ms; };
    return clock;
  }

  /** A stub client whose receipt appears after `afterPolls` empty polls. */
  function stubClient(name, log, afterPolls, receipt = RECEIPT) {
    let polls = 0;
    return {
      name,
      getTransactionReceipt: async (hash, o) => {
        log.push({ name, hash, signal: o && o.signal });
        return ++polls > afterPolls ? receipt : null;
      }
    };
  }

  it('resolves immediately when the receipt is already there: no sleep, no tick', async () => {
    const server = new FakeRpcServer();
    server.setReceipt(HASH, RECEIPT, 0);
    const clock = fakeClock();
    const ticks = [];
    const out = await waitForReceipt({ clients: [makeClient(server)], hash: HASH, sleep: clock.sleep, now: clock.now, onTick: (...a) => ticks.push(a) });
    assert.deepEqual(out, RECEIPT);
    assert.equal(clock.sleeps.length, 0);
    assert.equal(ticks.length, 0);
    assert.equal(server.calls.length, 1);
    assert.deepEqual(server.calls[0].params, [HASH]);
  });

  it('resolves when the receipt appears after 3 empty polls; sleeps intervalMs between polls and calls onTick(n, elapsed)', async () => {
    const server = new FakeRpcServer();
    server.setReceipt(HASH, RECEIPT, 3);
    const clock = fakeClock();
    const ticks = [];
    const out = await waitForReceipt({
      clients: [makeClient(server)], hash: HASH, intervalMs: 500, timeoutMs: 60000,
      sleep: clock.sleep, now: clock.now, onTick: (n, elapsed) => ticks.push([n, elapsed])
    });
    assert.deepEqual(out, RECEIPT);
    assert.equal(server.calls.length, 4);
    assert.ok(server.calls.every((c) => c.method === 'eth_getTransactionReceipt'));
    assert.deepEqual(clock.sleeps, [500, 500, 500]);
    assert.deepEqual(ticks, [[1, 0], [2, 500], [3, 1000]]);
  });

  it('passes the abort signal and the hash to getTransactionReceipt', async () => {
    const log = [];
    const ac = new AbortController();
    await waitForReceipt({ clients: [stubClient('A', log, 0)], hash: HASH, signal: ac.signal, sleep: fakeClock().sleep, now: fakeClock().now });
    assert.equal(log.length, 1);
    assert.equal(log[0].hash, HASH);
    assert.equal(log[0].signal, ac.signal);
  });

  it('polls round-robin across clients (A, B, A, B, A)', async () => {
    const log = [];
    // A and B each answer "no receipt" until the 5th overall poll, which lands on A
    let total = 0;
    const mk = (name) => ({ getTransactionReceipt: async (hash) => { log.push(name); return ++total >= 5 ? RECEIPT : null; } });
    const clock = fakeClock();
    const out = await waitForReceipt({ clients: [mk('A'), mk('B')], hash: HASH, sleep: clock.sleep, now: clock.now });
    assert.deepEqual(out, RECEIPT);
    assert.deepEqual(log, ['A', 'B', 'A', 'B', 'A']);
    assert.equal(clock.sleeps.length, 4);
  });

  it('round-robins across three clients too', async () => {
    const log = [];
    const clients = ['A', 'B', 'C'].map((name) => ({ getTransactionReceipt: async () => { log.push(name); return log.length >= 7 ? RECEIPT : null; } }));
    const clock = fakeClock();
    await waitForReceipt({ clients, hash: HASH, sleep: clock.sleep, now: clock.now });
    assert.deepEqual(log, ['A', 'B', 'C', 'A', 'B', 'C', 'A']);
  });

  it('tolerates a client that always errors: the healthy one still delivers the receipt', async () => {
    const bad = new FakeRpcServer();
    bad.fail('network', { times: Infinity });
    const good = new FakeRpcServer();
    good.setReceipt(HASH, RECEIPT, 1);
    const clock = fakeClock();
    const out = await waitForReceipt({
      clients: [makeClient(bad, { retries: 0 }), makeClient(good, { retries: 0 })], hash: HASH, sleep: clock.sleep, now: clock.now
    });
    assert.deepEqual(out, RECEIPT);
    assert.equal(bad.http.length, 2, 'the broken node was polled on every second tick');
    assert.equal(good.calls.length, 2);
  });

  it('tolerates a client that throws synchronously or rejects with a non-Error', async () => {
    const syncThrower = { getTransactionReceipt() { throw new Error('sync boom'); } };
    const rejecter = { getTransactionReceipt: () => Promise.reject('plain string') };
    const log = [];
    const good = stubClient('good', log, 0);
    const clock = fakeClock();
    const out = await waitForReceipt({ clients: [syncThrower, rejecter, good], hash: HASH, sleep: clock.sleep, now: clock.now });
    assert.deepEqual(out, RECEIPT);
    assert.equal(log.length, 1);
    assert.equal(clock.sleeps.length, 2);
  });

  it('times out with code RECEIPT_TIMEOUT using the injected clock (no real waiting)', async () => {
    const log = [];
    const clock = fakeClock();
    const ticks = [];
    const err = await rejection(waitForReceipt({
      clients: [stubClient('A', log, Infinity)], hash: HASH, intervalMs: 700, timeoutMs: 5000,
      sleep: clock.sleep, now: clock.now, onTick: (n, elapsed) => ticks.push([n, elapsed])
    }));
    assert.equal(err.name, 'RpcError');
    assert.equal(err.code, 'RECEIPT_TIMEOUT');
    assert.match(err.message, /5 seconds/);
    assert.equal(isRetryable(err), false);
    assert.equal(log.length, 9, 'polls at 0, 700, ..., 5600 ms');
    assert.equal(clock.sleeps.length, 8, 'no sleep after the last poll');
    assert.ok(clock.sleeps.every((ms) => ms === 700));
    assert.equal(clock.t - 1000000, 5600);
    assert.equal(ticks.length, 8);
    assert.deepEqual(ticks[0], [1, 0]);
    assert.deepEqual(ticks[7], [8, 4900]);
  });

  it('uses 700 ms / 120 s defaults', async () => {
    const log = [];
    const clock = fakeClock();
    const err = await rejection(waitForReceipt({ clients: [stubClient('A', log, Infinity)], hash: HASH, sleep: clock.sleep, now: clock.now }));
    assert.equal(err.code, 'RECEIPT_TIMEOUT');
    assert.match(err.message, /120 seconds/);
    assert.ok(clock.sleeps.every((ms) => ms === 700));
    assert.equal(log.length, Math.ceil(120000 / 700) + 1);
  });

  it('a receipt that arrives on the last allowed poll still wins over the timeout', async () => {
    const log = [];
    const clock = fakeClock();
    // timeout 1000 / interval 250: polls at 0, 250, 500, 750, 1000; the 5th poll (elapsed == timeout) finds the receipt
    const out = await waitForReceipt({ clients: [stubClient('A', log, 4)], hash: HASH, intervalMs: 250, timeoutMs: 1000, sleep: clock.sleep, now: clock.now });
    assert.deepEqual(out, RECEIPT);
    assert.equal(log.length, 5);
  });

  it('times out on the real clock too (tiny timeout, real default sleep)', async () => {
    const log = [];
    const t0 = Date.now();
    const err = await rejection(waitForReceipt({ clients: [stubClient('A', log, Infinity)], hash: HASH, intervalMs: 5, timeoutMs: 40 }));
    assert.equal(err.code, 'RECEIPT_TIMEOUT');
    assert.ok(Date.now() - t0 >= 35);
    assert.ok(log.length >= 3 && log.length <= 12, 'polls: ' + log.length);
  });

  it('an already-aborted signal rejects with AbortError before polling', async () => {
    const log = [];
    const ac = new AbortController();
    ac.abort();
    const err = await rejection(waitForReceipt({ clients: [stubClient('A', log, 0)], hash: HASH, signal: ac.signal, sleep: fakeClock().sleep }));
    assert.equal(err.name, 'AbortError');
    assert.equal(log.length, 0);
  });

  it('aborting during the (real default) sleep rejects promptly with AbortError', async () => {
    const log = [];
    const ac = new AbortController();
    const t0 = Date.now();
    const p = waitForReceipt({ clients: [stubClient('A', log, Infinity)], hash: HASH, intervalMs: 60000, signal: ac.signal });
    await tick();
    await tick();
    assert.equal(log.length, 1, 'first poll done, now sleeping');
    ac.abort();
    const err = await rejection(p);
    assert.equal(err.name, 'AbortError');
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(log.length, 1, 'no further poll');
  });

  it('abort during an injected sleep that ignores the signal: no further poll', async () => {
    const log = [];
    const ac = new AbortController();
    const err = await rejection(waitForReceipt({
      clients: [stubClient('A', log, Infinity)], hash: HASH, signal: ac.signal, sleep: async () => { ac.abort(); }, now: fakeClock().now
    }));
    assert.equal(err.name, 'AbortError');
    assert.equal(log.length, 1);
  });

  it('an AbortError raised by a client propagates immediately instead of being swallowed as a flaky node', async () => {
    const clock = fakeClock();
    const aborting = { getTransactionReceipt: async () => { throw abortError(); } };
    const err = await rejection(waitForReceipt({ clients: [aborting], hash: HASH, sleep: clock.sleep, now: clock.now }));
    assert.equal(err.name, 'AbortError');
    assert.equal(clock.sleeps.length, 0);
  });

  it('works when onTick is missing or not a function', async () => {
    const log = [];
    const clock = fakeClock();
    const out = await waitForReceipt({ clients: [stubClient('A', log, 2)], hash: HASH, onTick: 'nope', sleep: clock.sleep, now: clock.now });
    assert.deepEqual(out, RECEIPT);
  });

  // Known module gap: unlike scanLogs (whose onProgress is wrapped in try/catch), waitForReceipt calls opts.onTick without
  // protection, so a UI callback that throws makes the wait reject with the callback's error even though the transaction
  // may confirm a moment later.
  it('an onTick callback that throws does not abort the wait', async () => {
    const log = [];
    const clock = fakeClock();
    const out = await waitForReceipt({
      clients: [stubClient('A', log, 3)], hash: HASH, sleep: clock.sleep, now: clock.now,
      onTick: () => { throw new Error('the UI exploded'); }
    });
    assert.deepEqual(out, RECEIPT);
  });

  it('works end to end over a createClient and the fake node (receipt after 2 polls, real default sleep with tiny interval)', async () => {
    const server = new FakeRpcServer();
    server.setReceipt(HASH, RECEIPT, 2);
    const out = await waitForReceipt({ clients: [makeClient(server)], hash: HASH, intervalMs: 3, timeoutMs: 5000 });
    assert.deepEqual(out, RECEIPT);
    assert.equal(server.calls.length, 3);
  });
});

// ------------------------------------------------------------------------------------------------ parseRetryAfter

describe('parseRetryAfter', () => {
  it('converts seconds to milliseconds, capped at 30 s', () => {
    assert.equal(rpc.parseRetryAfter('2'), 2000);
    assert.equal(rpc.parseRetryAfter(2), 2000);
    assert.equal(rpc.parseRetryAfter('0'), 0);
    assert.equal(rpc.parseRetryAfter('1.5'), 1500);
    assert.equal(rpc.parseRetryAfter('120'), 30000);
    assert.equal(rpc.parseRetryAfter('-5'), 0);
  });

  it('returns null for absent or unusable values', () => {
    for (const v of [null, undefined, '', 'soon', 'not a date']) assert.equal(rpc.parseRetryAfter(v), null, String(v));
  });

  it('understands an HTTP date (future -> remaining time, past -> 0, far future -> capped)', () => {
    const inFive = rpc.parseRetryAfter(new Date(Date.now() + 5000).toUTCString());
    assert.ok(inFive >= 3000 && inFive <= 5000, 'got ' + inFive);
    assert.equal(rpc.parseRetryAfter(new Date(Date.now() - 60000).toUTCString()), 0);
    assert.equal(rpc.parseRetryAfter(new Date(Date.now() + 3600 * 1000).toUTCString()), 30000);
  });
});

// ------------------------------------------------------------------------------------------------ createClient: endpoints

describe('createClient: several endpoints, rate limits and hints', () => {
  const A = 'https://rpc-a.example/';
  const B = 'https://rpc-b.example:8545/v1';
  const C = 'https://rpc-c.example/';

  function multi(opts = {}) {
    const servers = { [A]: new FakeRpcServer({ head: 111 }), [B]: new FakeRpcServer({ head: 222 }), [C]: new FakeRpcServer({ head: 333 }) };
    const sleep = recordingSleep();
    const clock = { t: 5000000 };
    const client = createClient(Object.assign({
      endpoints: [A, B, C], fetch: (url, init) => servers[url].fetch(url, init), retries: 4, baseDelayMs: 100, maxDelayMs: 1000,
      timeoutMs: 0, sleep, random: random05, now: () => clock.t
    }, opts));
    return { servers, sleep, clock, client };
  }

  const retryAfterResponse = (value) => ({
    ok: false, status: 429, headers: { get: (h) => (String(h).toLowerCase() === 'retry-after' ? value : null) },
    json: async () => ({}), text: async () => '{}'
  });

  it('createClient without any URL throws', () => {
    assert.throws(() => createClient({}), /at least one RPC URL/);
    assert.throws(() => createClient({ endpoints: [] }), /at least one RPC URL/);
  });

  it('accepts url, urls and endpoints (strings or objects), drops duplicates and reports the endpoints', () => {
    const single = createClient({ url: A, fetch: async () => {} });
    assert.equal(single.url, A);
    assert.deepEqual(single.endpoints(), [{ url: A, host: 'rpc-a.example', logRange: 9999, spacingMs: 0, concurrency: 0 }]);
    const many = createClient({ urls: [A, B, A], fetch: async () => {} });
    assert.deepEqual(many.endpoints().map((e) => e.url), [A, B]);
    assert.equal(many.endpoints()[1].host, 'rpc-b.example:8545');
    const objects = createClient({ endpoints: [{ url: C, logRange: 90000, concurrency: 3, spacingMs: 120 }, B], fetch: async () => {} });
    assert.deepEqual(objects.currentEndpoint(), { url: C, host: 'rpc-c.example', logRange: 90000, spacingMs: 120, concurrency: 3 });
    assert.equal(objects.logRange(), 90000);
    assert.equal(objects.concurrency(), 3);
    assert.equal(objects.rotationCount(), 0);
  });

  for (const [kind, label] of [['http429', 'HTTP 429'], ['http500', 'HTTP 500'], ['http503', 'HTTP 503'], ['network', 'a network error'], ['-32005', '-32005 rate limit'], ['-32014', '-32014 block not yet imported']]) {
    it('moves on to the next endpoint at once (no sleep) after ' + label, async () => {
      const { servers, sleep, client } = multi();
      servers[A].fail(kind, { times: Infinity });
      assert.equal(await client.request('eth_blockNumber'), hex(222), 'answered by endpoint B');
      assert.equal(servers[A].http.length, 1);
      assert.equal(servers[B].http.length, 1);
      assert.equal(servers[C].http.length, 0);
      assert.equal(sleep.calls.length, 0, 'no waiting while another endpoint is free');
      assert.equal(client.rotationCount(), 1);
      assert.equal(client.url, B);
      assert.equal(client.stats.retries, 1);
    });
  }

  it('moves on to the next endpoint after a timeout', async () => {
    const { servers, sleep, client } = multi({ timeoutMs: 20 });
    servers[A].fail('hang', { times: Infinity });
    assert.equal(await client.request('eth_blockNumber'), hex(222));
    assert.equal(sleep.calls.length, 0);
    assert.equal(client.rotationCount(), 1);
  });

  it('keeps using the endpoint that works (the failed one is not asked again)', async () => {
    const { servers, client } = multi();
    servers[A].fail('http429', { times: 1 });
    for (let i = 0; i < 4; i++) assert.equal(await client.request('eth_blockNumber'), hex(222));
    assert.equal(servers[A].http.length, 1);
    assert.equal(servers[B].http.length, 4);
  });

  it('a non-retryable error (revert) is reported as is: no rotation, no other endpoint is asked', async () => {
    const { servers, sleep, client } = multi();
    servers[A].fail('revert', { times: Infinity });
    const err = await rejection(client.request('eth_call', [{ to: CONTRACT }, 'latest']));
    assert.equal(err.code, 3);
    assert.equal(err.data, REVERT_DATA);
    assert.equal(err.endpoint, A);
    assert.equal(servers[B].http.length + servers[C].http.length, 0);
    assert.equal(client.rotationCount(), 0);
    assert.equal(sleep.calls.length, 0);
  });

  it('when every endpoint is on hold it waits for the first one to recover; the error names the last endpoint tried', async () => {
    const { servers, sleep, client } = multi({ retries: 3 });
    for (const url of [A, B, C]) servers[url].fail('http429', { times: Infinity });
    const err = await rejection(client.request('eth_blockNumber'));
    assert.equal(err.code, 'HTTP');
    assert.equal(err.status, 429);
    assert.equal(err.attempts, 4);
    assert.deepEqual([A, B, C].map((u) => servers[u].http.length), [2, 1, 1], 'A, B, C, then (after waiting) A again');
    assert.deepEqual(sleep.delays(), [100], 'one wait: the 100 ms hold of the first endpoint that failed');
    assert.equal(err.endpoint, A);
    assert.equal(client.stats.retries, 3);
  });

  it('single endpoint: honours Retry-After (seconds) when it is longer than the backoff, capped at 30 s', async () => {
    for (const [header, expectedMs] of [['2', 2000], ['120', 30000], ['0', 10]]) {
      const sleep = recordingSleep();
      let n = 0;
      const client = createClient({
        url: A, sleep, random: random05, timeoutMs: 0, baseDelayMs: 10, maxDelayMs: 100,
        fetch: async () => (++n === 1 ? retryAfterResponse(header) : respond(200, { jsonrpc: '2.0', id: 1, result: '0x1' }))
      });
      assert.equal(await client.request('eth_blockNumber'), '0x1');
      assert.deepEqual(sleep.delays(), [expectedMs], 'Retry-After: ' + header);
    }
  });

  it('with several endpoints, Retry-After holds only the endpoint that sent it: the next one takes over at once', async () => {
    const sleep = recordingSleep();
    const seen = [];
    const client = createClient({
      endpoints: [A, B], sleep, random: random05, timeoutMs: 0, baseDelayMs: 10, maxDelayMs: 100, now: () => 1000,
      fetch: async (url) => { seen.push(url); return url === A ? retryAfterResponse('5') : respond(200, { jsonrpc: '2.0', id: 1, result: '0x2' }); }
    });
    assert.equal(await client.request('eth_blockNumber'), '0x2');
    assert.deepEqual(seen, [A, B]);
    assert.equal(sleep.calls.length, 0);
  });

  it('errors carry the URL of the endpoint that produced them (single endpoint too)', async () => {
    const server = new FakeRpcServer();
    server.fail('-32014', { times: Infinity });
    const err = await rejection(makeClient(server, { retries: 1 }).request('eth_blockNumber'));
    assert.equal(err.endpoint, RPC_URL);
  });

  it('spacingMs spaces requests to one endpoint apart (using the injected sleep and clock)', async () => {
    const server = new FakeRpcServer();
    const sleep = recordingSleep();
    const client = createClient({ endpoints: [{ url: RPC_URL, spacingMs: 250 }], fetch: server.fetch, sleep, now: () => 1000000, timeoutMs: 0, random: random05 });
    await Promise.all([client.request('eth_chainId'), client.request('eth_chainId'), client.request('eth_chainId')]);
    assert.deepEqual(sleep.delays(), [250, 500]);
    assert.equal(server.http.length, 3);
    const plain = recordingSleep();
    const free = createClient({ endpoints: [RPC_URL], fetch: server.fetch, sleep: plain, now: () => 1000000, timeoutMs: 0, random: random05 });
    await Promise.all([free.request('eth_chainId'), free.request('eth_chainId')]);
    assert.equal(plain.calls.length, 0, 'no spacing configured -> no waiting');
  });

  it('batch rotates endpoints too when a whole batch is rate limited', async () => {
    const { servers, sleep, client } = multi();
    servers[A].fail('http429', { times: Infinity });
    const out = await client.batch([{ method: 'eth_blockNumber' }, { method: 'eth_chainId' }]);
    assert.deepEqual(out.map((o) => o.result), [hex(222), hex(5042002)]);
    assert.equal(sleep.calls.length, 0);
    assert.equal(client.rotationCount(), 1);
  });

  it('scanLogs keeps going on the healthy endpoint when the first one is rate limited all the time', async () => {
    const { servers, client } = multi({ endpoints: [A, B] });
    servers[A].fail('http429', { times: Infinity });
    seedLogs(servers[B], 0, 60000, { count: 50, seed: 51 });
    const result = await scanLogs({ client, fromBlock: 0, toBlock: 60000 });
    assert.deepEqual(result.logs, servers[B].expectedLogs(0, 60000));
    assertTiles(servers[B].okRanges(), 0, 60000);
    assert.ok(client.rotationCount() >= 1);
    assert.equal(client.url, B);
  });
});

// ------------------------------------------------------------------------------------------------ scanLogs: endpoint hints

describe('scanLogs: endpoint hints (logRange, concurrency)', () => {
  const hinted = (server, hint, opts = {}) => createClient(Object.assign({
    endpoints: [Object.assign({ url: RPC_URL }, hint)], fetch: server.fetch, retries: 4, baseDelayMs: 10, maxDelayMs: 100,
    timeoutMs: 0, sleep: sleepNoop, random: random05
  }, opts));

  it('follows a logRange hint (90,000 blocks per call) and a concurrency hint', async () => {
    const server = new FakeRpcServer({ maxRange: 100000, latency: () => 2 });
    seedLogs(server, 0, 349999, { count: 60, seed: 61, chunk: 90000 });
    const client = hinted(server, { logRange: 90000, concurrency: 2 });
    const result = await scanLogs({ client, fromBlock: 0, toBlock: 349999 });
    assert.deepEqual(server.okRanges().map((r) => r.to - r.from + 1), [90000, 90000, 90000, 80000]);
    assertTiles(server.okRanges(), 0, 349999);
    assert.equal(server.maxInFlight, 2, 'the concurrency hint is used');
    assert.deepEqual(result.logs, server.expectedLogs(0, 349999));
  });

  it('an explicit concurrency overrides the hint, and chunkSize caps the endpoint logRange', async () => {
    const server = new FakeRpcServer({ maxRange: 100000, latency: () => 2 });
    seedLogs(server, 0, 299999, { count: 40, seed: 62, chunk: 30000 });
    const client = hinted(server, { logRange: 90000, concurrency: 2 });
    const result = await scanLogs({ client, fromBlock: 0, toBlock: 299999, concurrency: 4, chunkSize: 30000 });
    assert.ok(server.getLogsCalls().every((c) => c.size === 30000));
    assert.equal(server.maxInFlight, 4);
    assert.deepEqual(result.logs, server.expectedLogs(0, 299999));
  });

  it('a hint that is too optimistic is corrected: the client falls back to 9,999 and remembers it', async () => {
    const server = new FakeRpcServer({ maxRange: 10000, rangeError: { code: -32602, message: 'query exceeds max block range 10000' }, latency: () => 1 });
    seedLogs(server, 0, 149999, { count: 80, seed: 63, chunk: 9999 });
    const client = hinted(server, { logRange: 50000 });
    assert.equal(client.logRange(), 50000);
    const result = await scanLogs({ client, fromBlock: 0, toBlock: 149999 });
    const failing = server.getLogsCalls().filter((c) => c.outcome === 'error');
    assert.ok(failing.length >= 1 && failing.every((c) => c.size === 50000 && c.errorCode === -32602), 'only the first 50,000-block requests were rejected');
    assert.ok(failing.length <= 5);
    assertTiles(server.okRanges(), 0, 149999);
    assert.ok(server.okRanges().every((r) => r.to - r.from + 1 <= 9999));
    assert.equal(client.logRange(), 9999);
    assert.deepEqual(result.logs, server.expectedLogs(0, 149999));
  });

  it('what the client learned about the range limit is kept for the next scan (setLogRange / logRange)', async () => {
    const server = new FakeRpcServer({ maxRange: 1000, latency: () => 1 });
    seedLogs(server, 0, 60000, { count: 40, seed: 64, chunk: 600 });
    const client = makeClient(server);
    await scanLogs({ client, fromBlock: 0, toBlock: 30000, concurrency: 1 });
    assert.ok(client.logRange() <= 1000, 'learned ' + client.logRange());
    const before = server.getLogsCalls().length;
    const second = await scanLogs({ client, fromBlock: 30001, toBlock: 60000, concurrency: 1 });
    const later = server.getLogsCalls().slice(before);
    assert.ok(later.every((c) => c.outcome === 'ok'), 'the second scan starts with the learned size: no rejected request');
    assert.deepEqual(second.logs, server.expectedLogs(30001, 60000));
    client.setLogRange(RPC_URL, 123.9);
    assert.equal(client.logRange(), 123);
    client.setLogRange(RPC_URL, 0);
    assert.equal(client.logRange(), 1);
  });

  it('a rate-limit error that mentions a limit is never mistaken for a range error', async () => {
    assert.equal(isRangeTooLarge(RpcError('daily request limit exceeded', -32005)), false);
    assert.equal(isRangeTooLarge(RpcError('exceeds the max rate', 'HTTP', null, 429)), false);
    assert.equal(isRangeTooLarge(RpcError('query exceeds max block range 10000', -32602)), true);
    assert.equal(isRangeTooLarge(RpcError('maximum block range is 5000', -32000)), true);
    assert.equal(isRangeTooLarge(RpcError('range too big', -32000)), true);
  });

  it('onProgress reports the host of the endpoint that is serving', async () => {
    const server = new FakeRpcServer();
    const events = [];
    await scanLogs({ client: makeClient(server), fromBlock: 0, toBlock: 20, onProgress: (p) => events.push(p) });
    assert.ok(events.length >= 2);
    assert.ok(events.every((e) => e.endpoint === 'rpc.arc-testnet.example'));
    const stubEvents = [];
    await scanLogs({ client: { getLogs: async () => [] }, fromBlock: 0, toBlock: 5, onProgress: (p) => stubEvents.push(p) });
    assert.ok(stubEvents.every((e) => e.endpoint === null), 'a bare client without endpoints reports null');
  });

  // Known module bug: client.setLogRange() is documented as remembering a SMALLER range, but scanLogs calls it with a value derived
  // from every failing chunk, so a late failure of a big first-wave chunk (slow response) overwrites the smaller limit that another
  // worker already learned. The remembered range jumps back up and perfectly sized later chunks are cut too large again.
  it('a late failure of a large chunk does not raise the remembered log range again', async () => {
    const server = new FakeRpcServer({ maxRange: 1000, latency: (rec) => (rec.from === 9999 && rec.size === 9999 ? 200 : 1) });
    seedLogs(server, 0, 300000, { count: 80, seed: 71, chunk: 624 });
    const client = makeClient(server);
    const result = await scanLogs({ client, fromBlock: 0, toBlock: 300000, concurrency: 2 });
    assert.deepEqual(result.logs, server.expectedLogs(0, 300000), 'the scan itself is still correct');
    const late = server.getLogsCalls().filter((c) => c.outcome === 'error' && c.from >= 2 * 9999);
    assert.equal(late.length, 0, 'requests rejected after the limit was already known: ' + JSON.stringify(late.map((c) => [c.from, c.size])));
  });
});
