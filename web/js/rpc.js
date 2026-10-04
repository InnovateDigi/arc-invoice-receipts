/*
 * JSON-RPC 2.0 client over fetch (fetch is injectable for tests) with retry/backoff, batching, normalised errors,
 * several endpoints with rotation on rate limits (HTTP 429 / -32005), network errors and 5xx, and a paged eth_getLogs
 * scanner that adapts its chunk size to each endpoint (Arc's public RPCs allow 9,999 blocks per call, some providers
 * allow 100,000; -32014 "block not yet imported" comes from a load balanced node). No DOM access.
 * Classic script (ArcInvoice.rpc) and CommonJS module.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ArcInvoice = Object.assign(root.ArcInvoice || {}, { rpc: factory() });
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_LOG_RANGE = 9999; // blocks per eth_getLogs call; Arc rejects ranges above 10,000 blocks with -32012

  // ---------------------------------------------------------------- errors

  /** Normalised RPC failure: .code (JSON-RPC number or 'NETWORK' | 'TIMEOUT' | 'HTTP' | 'BAD_RESPONSE'), .message, .data, .status. */
  function RpcError(message, code, data, status) {
    var e = new Error(message);
    e.name = 'RpcError';
    e.code = code;
    e.data = data === undefined ? null : data;
    if (status !== undefined) e.status = status;
    return e;
  }

  function abortError(message) {
    var e = new Error(message || 'The operation was aborted.');
    e.name = 'AbortError';
    return e;
  }

  /** Any thrown value or JSON-RPC error object -> Error with .code/.message/.data. */
  function normalizeError(e) {
    if (e && e.name === 'AbortError') return e;
    if (e instanceof Error && (e.name === 'RpcError' || e.code !== undefined)) return e;
    if (e && typeof e === 'object' && !(e instanceof Error) && (e.code !== undefined || e.message !== undefined)) {
      return RpcError(String(e.message || 'RPC error'), e.code, e.data);
    }
    var msg = e && e.message ? e.message : String(e);
    return RpcError(msg, 'NETWORK', null);
  }

  /** Worth retrying: network trouble, timeouts, HTTP 429/5xx, -32014 (block not yet imported), -32005 (rate limit). */
  function isRetryable(e) {
    if (!e || e.name === 'AbortError') return false;
    if (e.code === 'NETWORK' || e.code === 'TIMEOUT') return true;
    if (e.status === 429 || (typeof e.status === 'number' && e.status >= 500)) return true;
    return e.code === -32014 || e.code === -32005;
  }

  /** eth_getLogs range limit exceeded (-32012 on Arc's RPC, -32602 "query exceeds max block range" elsewhere). Never a rate limit. */
  function isRangeTooLarge(e) {
    if (!e || e.status === 429 || e.code === -32005) return false;
    if (e.code === -32012) return true;
    return /block range|too many blocks|range (is )?too (large|wide|big)|query exceeds|exceeds? (the )?(max|limit)|max(imum)? (block )?range/i.test(String(e.message || ''));
  }

  // ---------------------------------------------------------------- client

  function defaultSleep(ms, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) return reject(abortError());
      var onAbort;
      var t = setTimeout(function () {
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      if (signal) {
        onAbort = function () {
          clearTimeout(t);
          reject(abortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  function hexNumber(n) {
    return '0x' + Number(n).toString(16);
  }

  function parseHexNumber(h) {
    return Number(BigInt(h));
  }

  /** Block tag for a request: a Number becomes hex, a tag such as 'latest' stays, nothing means 'latest'. */
  function blockTag(tag) {
    return typeof tag === 'number' ? hexNumber(tag) : tag || 'latest';
  }

  /** Retry-After header value (seconds or an HTTP date) -> milliseconds, capped at 30 s; null when absent or unusable. */
  function parseRetryAfter(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    if (isFinite(n)) return Math.min(Math.max(0, n * 1000), 30000);
    var t = Date.parse(v);
    return isNaN(t) ? null : Math.min(Math.max(0, t - Date.now()), 30000);
  }

  function hostOf(url) {
    var m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^\/?#]+)/.exec(String(url));
    return m ? m[1] : String(url);
  }

  /** An endpoint is a URL or { url, logRange?, spacingMs?, concurrency? }; the numbers are hints that the client corrects. */
  function normalizeEndpoint(e) {
    var o = typeof e === 'string' ? { url: e } : e;
    return {
      url: o.url,
      host: hostOf(o.url),
      logRange: Math.max(1, Math.floor(o.logRange || MAX_LOG_RANGE)),
      spacingMs: Math.max(0, o.spacingMs || 0),
      concurrency: Math.max(0, Math.floor(o.concurrency || 0)),
      penaltyUntil: 0,
      nextSlot: 0
    };
  }

  /**
   * createClient({ url | endpoints | urls, fetch?, retries?, baseDelayMs?, maxDelayMs?, timeoutMs?, sleep?, random?, now? })
   * endpoints: ordered list of URLs or { url, logRange, spacingMs, concurrency } hints. A request goes to the current
   * endpoint; on a retryable failure (HTTP 429/5xx, -32005, -32014, network error, timeout) that endpoint is put on
   * hold (500 ms x 2^n, at most 8 s, or its Retry-After) and the next endpoint that is not on hold takes over at once.
   * When every endpoint is on hold the client waits for the first one to recover. With one endpoint this is plain
   * retry with backoff. retries = extra attempts after the first (default 4). timeoutMs 0 disables the timeout.
   * spacingMs spaces requests to one endpoint apart (for providers that rate-limit hard).
   */
  function createClient(opts) {
    opts = opts || {};
    var given = opts.endpoints || opts.urls || (opts.url ? [opts.url] : []);
    var eps = [];
    given.forEach(function (e) {
      var n = normalizeEndpoint(e);
      if (!eps.some(function (x) { return x.url === n.url; })) eps.push(n);
    });
    if (!eps.length) throw new Error('createClient needs at least one RPC URL.');
    var cur = 0;
    var fetchImpl = opts.fetch || function () { return globalThis.fetch.apply(globalThis, arguments); };
    var retries = opts.retries === undefined ? 4 : opts.retries;
    var baseDelay = opts.baseDelayMs === undefined ? 500 : opts.baseDelayMs;
    var maxDelay = opts.maxDelayMs === undefined ? 8000 : opts.maxDelayMs;
    var timeoutMs = opts.timeoutMs === undefined ? 20000 : opts.timeoutMs;
    var sleep = opts.sleep || defaultSleep;
    var random = opts.random || Math.random;
    var clock = opts.now || Date.now;
    var nextId = 1;
    var stats = { requests: 0, retries: 0 };
    var rotations = 0;

    function backoff(attempt) {
      var d = baseDelay * Math.pow(2, attempt) * (0.75 + random() * 0.5); // +-25% jitter, then the cap
      return Math.round(Math.min(maxDelay, d));
    }

    // Reserve the next send slot of an endpoint that must be spaced out.
    async function reserve(ep, signal) {
      if (!ep.spacingMs) return;
      var t = clock();
      var slot = Math.max(t, ep.nextSlot);
      ep.nextSlot = slot + ep.spacingMs;
      if (slot > t) await sleep(slot - t, signal);
    }

    // One HTTP POST to endpoint ep. Throws a normalised error. Resolves with the parsed JSON body.
    async function post(body, signal, ep) {
      if (signal && signal.aborted) throw abortError();
      await reserve(ep, signal);
      if (signal && signal.aborted) throw abortError();
      var payload;
      try {
        payload = JSON.stringify(body);
      } catch (se) {
        throw RpcError('The request parameters cannot be sent as JSON: ' + (se && se.message), 'BAD_REQUEST');
      }
      stats.requests++;
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var timedOut = false;
      var timer = null;
      var onAbort = function () { if (controller) controller.abort(); };
      if (signal && controller) signal.addEventListener('abort', onAbort, { once: true });
      if (timeoutMs > 0 && controller) {
        timer = setTimeout(function () {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
      }
      try {
        var res;
        try {
          res = await fetchImpl(ep.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: payload,
            signal: controller ? controller.signal : undefined,
            credentials: 'omit',
            cache: 'no-store',
            referrerPolicy: 'no-referrer'
          });
        } catch (e) {
          if (signal && signal.aborted) throw abortError();
          if (timedOut) throw RpcError('The RPC did not answer within ' + timeoutMs / 1000 + ' s.', 'TIMEOUT');
          throw RpcError(e && e.message ? e.message : 'Network error', 'NETWORK');
        }
        if (!res || res.ok === false) {
          var httpErr = RpcError('RPC HTTP error ' + (res ? res.status : '?'), 'HTTP', null, res ? res.status : undefined);
          var ra = res && res.headers && typeof res.headers.get === 'function' ? parseRetryAfter(res.headers.get('retry-after')) : null;
          if (ra !== null) httpErr.retryAfterMs = ra;
          throw httpErr;
        }
        try {
          return typeof res.json === 'function' ? await res.json() : JSON.parse(await res.text());
        } catch (e) {
          if (signal && signal.aborted) throw abortError();
          if (timedOut) throw RpcError('The RPC did not answer within ' + timeoutMs / 1000 + ' s.', 'TIMEOUT');
          throw RpcError('The RPC returned something that is not JSON.', 'BAD_RESPONSE');
        }
      } finally {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    }

    // First endpoint after the current one that is not on hold, or -1.
    function freshEndpoint() {
      var t = clock();
      for (var i = 1; i < eps.length; i++) {
        var idx = (cur + i) % eps.length;
        if (eps[idx].penaltyUntil <= t) return idx;
      }
      return -1;
    }

    function soonestEndpoint() {
      var best = 0;
      for (var i = 1; i < eps.length; i++) if (eps[i].penaltyUntil < eps[best].penaltyUntil) best = i;
      return best;
    }

    // Put an endpoint on hold after a failure of attempt number `attempt` of one request; returns the hold time in ms.
    // The hold grows with the request's own attempts (so concurrent requests do not inflate each other's wait),
    // honours Retry-After, and never shortens a hold that is already running.
    function penalise(ep, e, attempt) {
      var ms = backoff(attempt);
      if (typeof e.retryAfterMs === 'number' && e.retryAfterMs > ms) ms = Math.min(e.retryAfterMs, 30000);
      ep.penaltyUntil = Math.max(ep.penaltyUntil, clock() + ms);
      return ms;
    }

    async function withRetry(fn, signal) {
      for (var attempt = 0; ; attempt++) {
        var ep = eps[cur];
        try {
          var out = await fn(ep);
          ep.penaltyUntil = 0;
          return out;
        } catch (raw) {
          var e = normalizeError(raw);
          e.attempts = attempt + 1;
          if (!e.endpoint) e.endpoint = ep.url;
          if (!isRetryable(e)) {
            if (typeof e.code === 'number') ep.penaltyUntil = 0; // the endpoint answered; the error is about the request
            throw e;
          }
          if (attempt >= retries) throw e;
          stats.retries++;
          var hold = penalise(ep, e, attempt);
          if (eps.length === 1) {
            await sleep(hold, signal);
            continue;
          }
          var next = freshEndpoint();
          if (next >= 0) {
            cur = next;
            rotations++;
            continue;
          }
          var best = soonestEndpoint();
          if (best !== cur) {
            cur = best;
            rotations++;
          }
          await sleep(Math.max(0, eps[best].penaltyUntil - clock()), signal);
        }
      }
    }

    function unwrap(r) {
      if (!r || typeof r !== 'object') throw RpcError('Malformed JSON-RPC response.', 'BAD_RESPONSE');
      if (r.error) throw RpcError(String(r.error.message || 'RPC error'), r.error.code, r.error.data);
      if (!('result' in r)) throw RpcError('Malformed JSON-RPC response.', 'BAD_RESPONSE');
      return r.result;
    }

    /** One JSON-RPC call with retry/backoff/rotation. o = { signal }. Rejects with a normalised error (error.endpoint = URL). */
    function request(method, params, o) {
      var signal = o && o.signal;
      var id = nextId++;
      var body = { jsonrpc: '2.0', id: id, method: method, params: params || [] };
      return withRetry(async function (ep) { return unwrap(await post(body, signal, ep)); }, signal);
    }

    /**
     * Several calls in one HTTP request: calls = [{ method, params }]. Resolves with an array (same order) of
     * { result, error } where error is null on success. Falls back to individual requests if the node
     * does not understand JSON-RPC batches. Individual failures never reject the whole batch.
     */
    async function batch(calls, o) {
      var signal = o && o.signal;
      if (calls.length === 0) return [];
      var ids = calls.map(function () { return nextId++; });
      var body = calls.map(function (c, i) {
        return { jsonrpc: '2.0', id: ids[i], method: c.method, params: c.params || [] };
      });
      var responses;
      try {
        responses = await withRetry(async function (ep) {
          var r = await post(body, signal, ep);
          if (!Array.isArray(r)) throw RpcError('Batch not supported.', 'BAD_RESPONSE');
          return r;
        }, signal);
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        return Promise.all(calls.map(function (c) {
          return request(c.method, c.params, o).then(
            function (result) { return { result: result, error: null }; },
            function (error) { return { result: undefined, error: normalizeError(error) }; }
          );
        }));
      }
      var byId = Object.create(null);
      responses.forEach(function (r) { if (r && r.id !== undefined) byId[r.id] = r; });
      var results = ids.map(function (id) {
        try {
          return { result: unwrap(byId[id]), error: null };
        } catch (e) {
          return { result: undefined, error: normalizeError(e) };
        }
      });
      // A transient error inside one element (block not yet imported, rate limit) is retried on its own, with rotation.
      await Promise.all(results.map(function (r, i) {
        if (!r.error || !isRetryable(r.error)) return null;
        return request(calls[i].method, calls[i].params, o).then(
          function (result) { results[i] = { result: result, error: null }; },
          function (error) { if (error && error.name === 'AbortError') throw error; results[i] = { result: undefined, error: normalizeError(error) }; }
        );
      }));
      return results;
    }

    function parseBlock(b) {
      if (!b) return null;
      return {
        number: parseHexNumber(b.number),
        timestamp: parseHexNumber(b.timestamp),
        hash: b.hash,
        parentHash: b.parentHash,
        baseFeePerGas: b.baseFeePerGas ? BigInt(b.baseFeePerGas) : null
      };
    }

    function info(e) {
      return { url: e.url, host: e.host, logRange: e.logRange, spacingMs: e.spacingMs, concurrency: e.concurrency };
    }

    var client = {
      get url() { return eps[cur].url; },
      stats: stats,
      /** How many times a failing endpoint was replaced by another one. */
      rotationCount: function () { return rotations; },
      request: request,
      batch: batch,
      /** The endpoint that will serve the next request: { url, host, logRange, spacingMs, concurrency }. */
      currentEndpoint: function () { return info(eps[cur]); },
      endpoints: function () { return eps.map(info); },
      /** Largest eth_getLogs block range believed to work on the current endpoint (default 9,999). */
      logRange: function () { return eps[cur].logRange; },
      /** Remember a smaller range for an endpoint after it rejected a range (by URL; the current one if unknown). */
      setLogRange: function (url, blocks) {
        var e = eps.filter(function (x) { return x.url === url; })[0] || eps[cur];
        e.logRange = Math.max(1, Math.min(e.logRange, Math.floor(blocks))); // only ever lowered: a late failure must not undo a smaller limit
      },
      /** Suggested parallelism for the current endpoint (0 = no hint). */
      concurrency: function () { return eps[cur].concurrency; },
      async chainId(o) { return parseHexNumber(await request('eth_chainId', [], o)); },
      async blockNumber(o) { return parseHexNumber(await request('eth_blockNumber', [], o)); },
      /** tag: 'latest' or a block number. Resolves { number, timestamp, hash, parentHash, baseFeePerGas } or null. */
      async getBlock(tag, o) {
        return parseBlock(await request('eth_getBlockByNumber', [typeof tag === 'number' ? hexNumber(tag) : tag, false], o));
      },
      call(tx, tag, o) { return request('eth_call', [tx, blockTag(tag)], o); },
      async estimateGas(tx, o) { return BigInt(await request('eth_estimateGas', [tx], o)); },
      async gasPrice(o) { return BigInt(await request('eth_gasPrice', [], o)); },
      async getBalance(address, tag, o) { return BigInt(await request('eth_getBalance', [address, blockTag(tag)], o)); },
      getTransactionReceipt(hash, o) { return request('eth_getTransactionReceipt', [hash], o); },
      /** filter.fromBlock/toBlock may be Numbers (converted to hex) or hex strings / tags. */
      getLogs(filter, o) {
        var f = Object.assign({}, filter);
        if (typeof f.fromBlock === 'number') f.fromBlock = hexNumber(f.fromBlock);
        if (typeof f.toBlock === 'number') f.toBlock = hexNumber(f.toBlock);
        return request('eth_getLogs', [f], o);
      }
    };
    return client;
  }

  // ---------------------------------------------------------------- log scanning

  function compareLogs(a, b) {
    var ba = parseHexNumber(a.blockNumber);
    var bb = parseHexNumber(b.blockNumber);
    if (ba !== bb) return ba - bb;
    return parseHexNumber(a.logIndex) - parseHexNumber(b.logIndex);
  }

  /**
   * Scan eth_getLogs over [fromBlock, toBlock] (inclusive) in chunks with limited concurrency. The chunk size follows the
   * endpoint that is serving: client.logRange() (default 9,999; hints such as 90,000 for providers that allow it),
   * never above opts.chunkSize. A range error (-32012, -32602 "max block range", ...) makes the client remember a smaller
   * range for that endpoint (9,999 first, then half of the failing size) and the failed chunk is re-cut. Transient errors
   * and rate limits are retried and rotated by the client. concurrency defaults to the endpoint hint, else 5.
   * Returns { logs (sorted by blockNumber, logIndex), fromBlock, toBlock, scannedThrough, requests }.
   * On abort or failure it throws, and error.partial = { logs, scannedThrough } covers the contiguous scanned prefix,
   * so a later scan can resume at scannedThrough + 1.
   *
   * opts: { client, address, topics, fromBlock, toBlock, chunkSize?, concurrency?, signal?, onProgress? }
   * onProgress({ fromBlock, toBlock, scannedBlocks, totalBlocks, logsFound, requests, endpoint })
   */
  async function scanLogs(opts) {
    var client = opts.client;
    var from = opts.fromBlock;
    var to = opts.toBlock;
    var signal = opts.signal;
    var hint = typeof client.concurrency === 'function' ? client.concurrency() : 0;
    var concurrency = Math.max(1, opts.concurrency || hint || 5);
    var cap = opts.chunkSize ? Math.max(1, opts.chunkSize) : Infinity;
    var state = { cursor: from, stop: false };
    var total = to - from + 1;
    var done = [];
    var scanned = 0;
    var logsFound = 0;
    var requests = 0;
    var failure = null;

    function chunkSize() {
      var r = typeof client.logRange === 'function' ? client.logRange() : MAX_LOG_RANGE;
      return Math.max(1, Math.min(cap, r));
    }

    function emit() {
      if (typeof opts.onProgress !== 'function') return;
      try {
        opts.onProgress({
          fromBlock: from, toBlock: to, scannedBlocks: scanned, totalBlocks: Math.max(total, 0), logsFound: logsFound, requests: requests,
          endpoint: typeof client.currentEndpoint === 'function' ? client.currentEndpoint().host : null
        });
      } catch (e) { /* a broken progress callback must not break the scan */ }
    }

    function partial() {
      var ranges = done.slice().sort(function (a, b) { return a.from - b.from; });
      var through = from - 1;
      var logs = [];
      for (var i = 0; i < ranges.length; i++) {
        if (ranges[i].from !== through + 1) break;
        through = ranges[i].to;
        logs = logs.concat(ranges[i].logs);
      }
      logs.sort(compareLogs);
      return { logs: logs, scannedThrough: through };
    }

    if (total <= 0) return { logs: [], fromBlock: from, toBlock: to, scannedThrough: to, requests: 0 };

    async function fetchRange(a, b) {
      if (signal && signal.aborted) throw abortError();
      requests++;
      try {
        return await client.getLogs({ address: opts.address, topics: opts.topics, fromBlock: a, toBlock: b }, { signal: signal });
      } catch (raw) {
        var e = normalizeError(raw);
        if (isRangeTooLarge(e) && b > a) {
          var size = b - a + 1;
          // Above 9,999 blocks: fall back to Arc's standard limit. At or below it: the endpoint is stricter, so halve.
          var limit = size > MAX_LOG_RANGE ? MAX_LOG_RANGE : Math.max(1, Math.floor(size / 2));
          if (typeof client.setLogRange === 'function') client.setLogRange(e.endpoint, limit);
          var out = [];
          for (var s = a; s <= b; s += limit) out = out.concat(await fetchRange(s, Math.min(s + limit - 1, b)));
          return out;
        }
        throw e;
      }
    }

    async function worker() {
      while (!state.stop && state.cursor <= to) {
        if (signal && signal.aborted) throw abortError();
        var a = state.cursor;
        var b = Math.min(a + chunkSize() - 1, to);
        state.cursor = b + 1;
        var logs = await fetchRange(a, b);
        done.push({ from: a, to: b, logs: logs });
        scanned += b - a + 1;
        logsFound += logs.length;
        emit();
      }
    }

    emit();
    var workers = [];
    for (var i = 0; i < concurrency; i++) {
      workers.push(
        worker().catch(function (e) {
          if (!failure) failure = normalizeError(e);
          state.stop = true;
        })
      );
    }
    await Promise.all(workers);
    if (!failure && signal && signal.aborted) failure = abortError();
    if (failure) {
      failure.partial = partial();
      throw failure;
    }
    var all = [];
    done.forEach(function (d) { all = all.concat(d.logs); });
    all.sort(compareLogs);
    return { logs: all, fromBlock: from, toBlock: to, scannedThrough: to, requests: requests };
  }

  /**
   * Smallest block number in [lo, hi] whose timestamp is >= ts (block timestamps never decrease), or null when even
   * block hi is older than ts. Costs about log2(hi - lo) eth_getBlockByNumber calls.
   */
  async function findFirstBlockAtOrAfter(client, ts, o) {
    var lo = (o && o.lo) || 0;
    var signal = o && o.signal;
    var hi = o && o.hi !== undefined ? o.hi : await client.blockNumber({ signal: signal });
    var top = await client.getBlock(hi, { signal: signal });
    if (!top || top.timestamp < ts) return null;
    while (lo < hi) {
      var mid = lo + Math.floor((hi - lo) / 2);
      var b = await client.getBlock(mid, { signal: signal });
      if (b && b.timestamp >= ts) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  /**
   * Poll eth_getTransactionReceipt on one or more clients (round robin) until a receipt appears.
   * opts: { clients, hash, intervalMs (700), timeoutMs (120000), signal, onTick, sleep, now }
   * Resolves with the receipt; rejects with code 'RECEIPT_TIMEOUT' after the timeout.
   */
  async function waitForReceipt(opts) {
    var interval = opts.intervalMs === undefined ? 700 : opts.intervalMs;
    var timeout = opts.timeoutMs === undefined ? 120000 : opts.timeoutMs;
    var sleep = opts.sleep || defaultSleep;
    var now = opts.now || Date.now;
    var start = now();
    var clients = opts.clients;
    for (var n = 0; ; n++) {
      if (opts.signal && opts.signal.aborted) throw abortError();
      var c = clients[n % clients.length];
      try {
        var receipt = await c.getTransactionReceipt(opts.hash, { signal: opts.signal });
        if (receipt) return receipt;
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        /* a flaky node must not end the wait: try again on the next tick */
      }
      if (now() - start >= timeout) {
        var err = RpcError('The transaction was not confirmed within ' + Math.round(timeout / 1000) + ' seconds.', 'RECEIPT_TIMEOUT');
        throw err;
      }
      if (typeof opts.onTick === 'function') {
        try {
          opts.onTick(n + 1, now() - start);
        } catch (tickError) { /* a broken UI callback must not abandon a pending transaction */ }
      }
      await sleep(interval, opts.signal);
    }
  }

  return {
    MAX_LOG_RANGE: MAX_LOG_RANGE,
    RpcError: RpcError,
    abortError: abortError,
    normalizeError: normalizeError,
    isRetryable: isRetryable,
    isRangeTooLarge: isRangeTooLarge,
    createClient: createClient,
    parseRetryAfter: parseRetryAfter,
    compareLogs: compareLogs,
    scanLogs: scanLogs,
    findFirstBlockAtOrAfter: findFirstBlockAtOrAfter,
    waitForReceipt: waitForReceipt,
    hexNumber: hexNumber,
    parseHexNumber: parseHexNumber
  };
});
