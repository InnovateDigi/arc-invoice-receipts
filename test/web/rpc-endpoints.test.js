'use strict';
// Multi-endpoint behaviour of web/js/rpc.js: rotation on rate limits, per-endpoint log ranges, spacing, abort.
// Everything runs against a fake network object (no sockets, no real waiting).
const assert = require('node:assert/strict');
const rpc = require('../../web/js/rpc.js');

const A = 'https://a.example/rpc';
const B = 'https://b.example/rpc';
const C = 'https://c.example/rpc';
const hex = (n) => '0x' + n.toString(16);

/**
 * Fake JSON-RPC network. spec[url] = { maxRange, rangeCode, rangeMessage, queue: ['http429', ...], delayTicks }.
 * Failure kinds consumed one per HTTP request: http429, http429-ra:<seconds>, http500, rate32005, network, revert.
 */
class FakeNet {
  constructor(spec, opts) {
    this.eps = {};
    for (const [url, o] of Object.entries(spec)) {
      this.eps[url] = Object.assign({ maxRange: 9999, rangeCode: -32012, rangeMessage: 'requested range too large', queue: [], delayTicks: 0, always: null }, o);
      Object.assign(this.eps[url], { http: 0, logCalls: [], inflight: 0, maxInflight: 0 });
    }
    this.logs = (opts && opts.logs) || []; // [{ blockNumber, logIndex }]
    this.latest = (opts && opts.latest) || 1000;
    this.startTimes = [];
    this.clock = opts && opts.clock;
    this.fetch = this.fetch.bind(this);
  }

  respond(status, body, headers) {
    return { ok: status >= 200 && status < 300, status, headers: { get: (k) => (headers && headers[k.toLowerCase()]) || null }, json: async () => body };
  }

  async fetch(url, init) {
    const ep = this.eps[url];
    if (!ep) throw new TypeError('no such endpoint ' + url);
    ep.http++;
    if (this.clock) this.startTimes.push([url, this.clock()]);
    const kind = ep.always || ep.queue.shift();
    if (kind === 'network') throw new TypeError('Failed to fetch');
    if (kind === 'http500') return this.respond(500, {});
    if (kind === 'http429') return this.respond(429, { error: { code: -32005, message: 'rate limit exceeded' } });
    if (kind && kind.startsWith('http429-ra:')) return this.respond(429, {}, { 'retry-after': kind.split(':')[1] });
    const body = JSON.parse(init.body);
    const calls = Array.isArray(body) ? body : [body];
    ep.inflight++;
    ep.maxInflight = Math.max(ep.maxInflight, ep.inflight);
    try {
      for (let i = 0; i < ep.delayTicks; i++) await Promise.resolve();
      if (ep.delayTicks) await new Promise((r) => setTimeout(r, 1));
      const out = calls.map((c) => this.handle(ep, c, kind));
      return this.respond(200, Array.isArray(body) ? out : out[0]);
    } finally {
      ep.inflight--;
    }
  }

  handle(ep, c, kind) {
    const ok = (result) => ({ jsonrpc: '2.0', id: c.id, result });
    const err = (code, message, data) => ({ jsonrpc: '2.0', id: c.id, error: { code, message, data } });
    if (kind === 'rate32005') return err(-32005, 'rate limit exceeded');
    if (kind === 'revert') return err(3, 'execution reverted', '0x1f2a2005');
    switch (c.method) {
      case 'eth_chainId': return ok('0x7a69');
      case 'eth_blockNumber': return ok(hex(this.latest));
      case 'eth_getLogs': {
        const f = c.params[0];
        const from = parseInt(f.fromBlock, 16);
        const to = parseInt(f.toBlock, 16);
        if (to - from + 1 > ep.maxRange) {
          ep.logCalls.push({ from, to, ok: false });
          return err(ep.rangeCode, ep.rangeMessage);
        }
        ep.logCalls.push({ from, to, ok: true });
        return ok(this.logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to).map((l) => ({
          address: f.address, topics: ['0x' + '11'.repeat(32)], data: '0x', blockNumber: hex(l.blockNumber), logIndex: hex(l.logIndex), transactionHash: '0x' + 'ab'.repeat(32)
        })));
      }
      default: return err(-32601, 'method not found');
    }
  }

  okCalls() {
    return [].concat(...Object.values(this.eps).map((e) => e.logCalls.filter((c) => c.ok))).sort((a, b) => a.from - b.from);
  }
}

function assertExactCover(calls, from, to) {
  let next = from;
  for (const c of calls) {
    assert.equal(c.from, next, `gap or overlap at block ${next}: next successful request starts at ${c.from}`);
    next = c.to + 1;
  }
  assert.equal(next, to + 1, 'successful requests must end exactly at the last block');
}

function mkClient(net, endpoints, extra) {
  const sleeps = [];
  const client = rpc.createClient(Object.assign({
    endpoints, fetch: net.fetch, sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5, timeoutMs: 0, now: () => 1000000
  }, extra));
  return { client, sleeps };
}

describe('multi-endpoint client: rotation', () => {
  for (const kind of ['http429', 'http500', 'rate32005', 'network']) {
    it(`${kind} on the first endpoint: the next endpoint answers at once, no waiting`, async () => {
      const net = new FakeNet({ [A]: { queue: [kind] }, [B]: {} });
      const { client, sleeps } = mkClient(net, [A, B]);
      assert.equal(client.url, A);
      assert.equal(await client.request('eth_chainId'), '0x7a69');
      assert.equal(client.url, B);
      assert.equal(client.rotationCount(), 1);
      assert.deepEqual(sleeps, []);
      assert.equal(net.eps[A].http, 1);
      assert.equal(net.eps[B].http, 1);
    });
  }

  it('stays on the endpoint that works and leaves the one on hold alone', async () => {
    const net = new FakeNet({ [A]: { queue: ['http429'] }, [B]: {} });
    const { client } = mkClient(net, [A, B]);
    for (let i = 0; i < 6; i++) await client.request('eth_chainId');
    assert.equal(net.eps[A].http, 1);
    assert.equal(net.eps[B].http, 6);
  });

  it('rotates through all endpoints in order and wraps around', async () => {
    const net = new FakeNet({ [A]: { queue: ['http429'] }, [B]: { queue: ['http500'] }, [C]: {} });
    const { client } = mkClient(net, [A, B, C]);
    await client.request('eth_chainId');
    assert.equal(client.url, C);
    assert.equal(client.rotationCount(), 2);
  });

  it('when every endpoint is on hold it waits for the one that recovers first (Retry-After honoured)', async () => {
    const net = new FakeNet({ [A]: { queue: ['http429-ra:4'] }, [B]: { queue: ['http429-ra:2'] }, [C]: { queue: ['http429-ra:3'] } });
    const { client, sleeps } = mkClient(net, [A, B, C]);
    assert.equal(await client.request('eth_chainId'), '0x7a69');
    assert.deepEqual(sleeps, [2000], 'waits exactly until B (Retry-After 2 s) is back');
    assert.equal(client.url, B);
  });

  it('Retry-After is capped at 30 seconds and a single endpoint simply sleeps', async () => {
    const net = new FakeNet({ [A]: { queue: ['http429-ra:120'] } });
    const { client, sleeps } = mkClient(net, [A]);
    await client.request('eth_chainId');
    assert.deepEqual(sleeps, [30000]);
  });

  it('a single endpoint backs off 500 ms x 2^n (cap 8 s) by default', async () => {
    const net = new FakeNet({ [A]: { queue: ['http500', 'http500', 'http500', 'http500'] } });
    const sleeps = [];
    const client = rpc.createClient({ url: A, fetch: net.fetch, sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5, timeoutMs: 0, retries: 6 });
    await client.request('eth_chainId');
    assert.deepEqual(sleeps, [500, 1000, 2000, 4000]);
    const net2 = new FakeNet({ [A]: { queue: Array(6).fill('http500') } });
    const sleeps2 = [];
    const c2 = rpc.createClient({ url: A, fetch: net2.fetch, sleep: async (ms) => { sleeps2.push(ms); }, random: () => 1, timeoutMs: 0, retries: 6 });
    await c2.request('eth_chainId');
    assert.ok(Math.max(...sleeps2) <= 8000, 'never above 8 s: ' + sleeps2);
    assert.equal(sleeps2[sleeps2.length - 1], 8000);
  });

  it('gives up after retries + 1 attempts over all endpoints and reports the failing endpoint', async () => {
    const net = new FakeNet({ [A]: { always: 'http429' }, [B]: { always: 'http429' } });
    const { client } = mkClient(net, [A, B], { retries: 4 });
    await assert.rejects(client.request('eth_chainId'), (e) => {
      assert.equal(e.status, 429);
      assert.equal(e.attempts, 5);
      assert.ok([A, B].includes(e.endpoint));
      return true;
    });
    assert.equal(net.eps[A].http + net.eps[B].http, 5);
  });

  it('errors about the request (a revert) are returned as they are: no rotation, no retry', async () => {
    const net = new FakeNet({ [A]: { queue: ['revert'] }, [B]: {} });
    const { client, sleeps } = mkClient(net, [A, B]);
    await assert.rejects(client.request('eth_call', [{}, 'latest']), (e) => e.code === 3 && e.data === '0x1f2a2005' && e.endpoint === A);
    assert.equal(net.eps[B].http, 0);
    assert.deepEqual(sleeps, []);
    assert.equal(client.url, A);
  });

  it('batch rotates too', async () => {
    const net = new FakeNet({ [A]: { queue: ['http429'] }, [B]: {} });
    const { client } = mkClient(net, [A, B]);
    const res = await client.batch([{ method: 'eth_chainId' }, { method: 'eth_blockNumber' }]);
    assert.deepEqual(res.map((r) => r.result), ['0x7a69', hex(1000)]);
    assert.equal(client.url, B);
  });

  it('duplicate URLs are collapsed and an empty list is refused', () => {
    const net = new FakeNet({ [A]: {} });
    const { client } = mkClient(net, [A, { url: A }, A]);
    assert.equal(client.endpoints().length, 1);
    assert.throws(() => rpc.createClient({ endpoints: [] }), /at least one/);
  });

  it('isRangeTooLarge recognises range errors but never a rate limit', () => {
    const range = (code, message, extra) => Object.assign(new Error(message), { code }, extra);
    assert.ok(rpc.isRangeTooLarge(range(-32012, 'requested range too large')));
    assert.ok(rpc.isRangeTooLarge(range(-32602, 'query exceeds max block range 100000')));
    assert.ok(rpc.isRangeTooLarge(range(-32000, 'block range too wide')));
    assert.ok(!rpc.isRangeTooLarge(range(-32005, 'rate limit exceeded')));
    assert.ok(!rpc.isRangeTooLarge(range('HTTP', 'RPC HTTP error 429', { status: 429 })));
    assert.ok(!rpc.isRangeTooLarge(range(-32602, 'invalid argument 0: hex string without 0x prefix')));
  });

  it('parseRetryAfter reads seconds and dates, caps at 30 s, ignores junk', () => {
    assert.equal(rpc.parseRetryAfter('2'), 2000);
    assert.equal(rpc.parseRetryAfter('0'), 0);
    assert.equal(rpc.parseRetryAfter('999'), 30000);
    assert.equal(rpc.parseRetryAfter(null), null);
    assert.equal(rpc.parseRetryAfter('soon'), null);
    const inTen = new Date(Date.now() + 10000).toUTCString();
    const v = rpc.parseRetryAfter(inTen);
    assert.ok(v > 7000 && v <= 10000, String(v));
  });
});

describe('multi-endpoint client: request spacing', () => {
  it('spaces concurrent requests to a rate-limited endpoint at least spacingMs apart (real timers, small spacing)', async () => {
    const net = new FakeNet({ [A]: {} }, { clock: () => performance.now() });
    const client = rpc.createClient({ endpoints: [{ url: A, spacingMs: 25 }], fetch: net.fetch, timeoutMs: 0 });
    await Promise.all([1, 2, 3, 4].map(() => client.request('eth_chainId')));
    const times = net.startTimes.map((x) => x[1]).sort((a, b) => a - b);
    assert.equal(times.length, 4);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 22, `gap ${times[i] - times[i - 1]} ms at ${i}`);
  });

  it('endpoints without spacing are not delayed', async () => {
    const net = new FakeNet({ [A]: {} }, { clock: () => performance.now() });
    const client = rpc.createClient({ endpoints: [A], fetch: net.fetch, timeoutMs: 0 });
    const t0 = performance.now();
    await Promise.all([1, 2, 3, 4].map(() => client.request('eth_chainId')));
    assert.ok(performance.now() - t0 < 50);
  });
});

describe('scanLogs over endpoints with different log ranges', () => {
  const logsAt = (blocks) => blocks.map((b, i) => ({ blockNumber: b, logIndex: i % 3 }));

  it('starts at the endpoint hint (90,000 blocks), uses its concurrency hint (4), covers every block exactly once', async () => {
    const net = new FakeNet({ [A]: { maxRange: 100000, delayTicks: 3 }, [B]: {} }, { logs: logsAt([5, 89999, 90000, 123456, 399999, 400000]) });
    const { client } = mkClient(net, [{ url: A, logRange: 90000, concurrency: 4 }, { url: B, logRange: 9999 }]);
    const res = await rpc.scanLogs({ client, address: '0x' + 'cc'.repeat(20), topics: [null], fromBlock: 0, toBlock: 400000 });
    const ok = net.okCalls();
    assertExactCover(ok, 0, 400000);
    assert.equal(ok.length, 5);
    assert.ok(ok.slice(0, 4).every((c) => c.to - c.from + 1 === 90000), JSON.stringify(ok));
    assert.equal(net.eps[A].maxInflight, 4, 'default concurrency comes from the endpoint hint');
    assert.equal(net.eps[B].http, 0);
    assert.deepEqual(res.logs.map((l) => parseInt(l.blockNumber, 16)), [5, 89999, 90000, 123456, 399999, 400000]);
    assert.equal(res.scannedThrough, 400000);
  });

  it('an explicit concurrency option wins over the hint', async () => {
    const net = new FakeNet({ [A]: { maxRange: 100000, delayTicks: 3 } });
    const { client } = mkClient(net, [{ url: A, logRange: 90000, concurrency: 4 }]);
    await rpc.scanLogs({ client, address: '0x' + 'cc'.repeat(20), topics: [], fromBlock: 0, toBlock: 400000, concurrency: 2 });
    assert.equal(net.eps[A].maxInflight, 2);
  });

  it('a wrong hint is corrected: -32602 "query exceeds max block range" -> 9,999 and remembered, no gaps, no overlaps', async () => {
    const net = new FakeNet({ [A]: { maxRange: 9999, rangeCode: -32602, rangeMessage: 'query exceeds max block range 100000', delayTicks: 2 } },
      { logs: logsAt([0, 10000, 10001, 55555, 199999, 200000]) });
    const { client } = mkClient(net, [{ url: A, logRange: 90000, concurrency: 4 }]);
    const res = await rpc.scanLogs({ client, address: '0x' + 'cc'.repeat(20), topics: [], fromBlock: 0, toBlock: 200000 });
    const ok = net.okCalls();
    assertExactCover(ok, 0, 200000);
    assert.ok(ok.every((c) => c.to - c.from + 1 <= 9999), 'successful chunks never above 9,999 blocks');
    assert.equal(client.logRange(), 9999, 'the endpoint now remembers 9,999');
    const failed = net.eps[A].logCalls.filter((c) => !c.ok).length;
    assert.ok(failed <= 6, `only the first in-flight chunks fail (got ${failed})`);
    assert.equal(res.logs.length, 6);
    // a second scan on the same client starts at 9,999 straight away: no failures at all
    const before = net.eps[A].logCalls.length;
    await rpc.scanLogs({ client, address: '0x' + 'cc'.repeat(20), topics: [], fromBlock: 0, toBlock: 30000 });
    assert.ok(net.eps[A].logCalls.slice(before).every((c) => c.ok));
  });

  it('an endpoint that is stricter than 9,999 shrinks further by halving and still covers everything', async () => {
    const net = new FakeNet({ [A]: { maxRange: 1000 } });
    const { client } = mkClient(net, [A]);
    await rpc.scanLogs({ client, address: '0x' + 'cc'.repeat(20), topics: [], fromBlock: 7, toBlock: 30007 });
    const ok = net.okCalls();
    assertExactCover(ok, 7, 30007);
    assert.ok(ok.every((c) => c.to - c.from + 1 <= 1000));
    assert.ok(client.logRange() <= 1000);
  });

  it('429 in the middle of a scan rotates to a stricter endpoint; chunks are re-cut to its range; every log once', async () => {
    const net = new FakeNet(
      { [A]: { maxRange: 100000, delayTicks: 2 }, [B]: { maxRange: 9999, delayTicks: 2 } },
      { logs: logsAt([1, 50000, 90001, 150000, 250000, 299999]) }
    );
    const { client } = mkClient(net, [{ url: A, logRange: 90000, concurrency: 1 }, { url: B, logRange: 9999, concurrency: 1 }]);
    let served = 0;
    const original = net.eps[A];
    // after A has answered twice it rate-limits for good
    const origFetch = net.fetch;
    const wrapped = async (url, init) => {
      if (url === A && served >= 2) { original.http++; return net.respond(429, {}); }
      if (url === A) served++;
      return origFetch(url, init);
    };
    const c2 = rpc.createClient({ endpoints: [{ url: A, logRange: 90000, concurrency: 1 }, { url: B, logRange: 9999, concurrency: 1 }], fetch: wrapped, sleep: async () => {}, random: () => 0.5, timeoutMs: 0, now: () => 1 });
    const res = await rpc.scanLogs({ client: c2, address: '0x' + 'cc'.repeat(20), topics: [], fromBlock: 0, toBlock: 300000, concurrency: 1 });
    void client;
    const ok = net.okCalls();
    assertExactCover(ok, 0, 300000);
    assert.ok(net.eps[B].logCalls.filter((c) => c.ok).every((c) => c.to - c.from + 1 <= 9999), 'the stricter endpoint only ever served <= 9,999 blocks');
    assert.ok(net.eps[B].logCalls.some((c) => c.ok), 'B took over');
    assert.deepEqual(res.logs.map((l) => parseInt(l.blockNumber, 16)), [1, 50000, 90001, 150000, 250000, 299999]);
    assert.equal(c2.url, B);
  });

  it('progress reports the serving endpoint host', async () => {
    const net = new FakeNet({ [A]: { maxRange: 100000 } });
    const { client } = mkClient(net, [{ url: A, logRange: 90000 }]);
    const seen = [];
    await rpc.scanLogs({ client, address: '0x' + 'cc'.repeat(20), topics: [], fromBlock: 0, toBlock: 200000, onProgress: (p) => seen.push(p) });
    assert.ok(seen.length >= 2);
    assert.ok(seen.every((p) => p.endpoint === 'a.example'));
    assert.equal(seen[seen.length - 1].scannedBlocks, 200001);
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i].scannedBlocks >= seen[i - 1].scannedBlocks);
  });

  it('abort between big chunks: partial is the contiguous scanned prefix', async () => {
    const net = new FakeNet({ [A]: { maxRange: 100000, delayTicks: 2 } }, { logs: logsAt([10, 95000, 185000, 300000]) });
    const { client } = mkClient(net, [{ url: A, logRange: 90000, concurrency: 2 }]);
    const ctl = new AbortController();
    let n = 0;
    const p = rpc.scanLogs({ client, address: '0x' + 'cc'.repeat(20), topics: [], fromBlock: 0, toBlock: 600000, signal: ctl.signal, onProgress: () => { if (++n === 3) ctl.abort(); } });
    await assert.rejects(p, (e) => {
      assert.equal(e.name, 'AbortError');
      assert.ok(e.partial.scannedThrough >= 89999, 'at least the first chunk is kept');
      const ok = net.okCalls().filter((c) => c.to <= e.partial.scannedThrough);
      assertExactCover(ok, 0, e.partial.scannedThrough);
      for (const l of e.partial.logs) assert.ok(parseInt(l.blockNumber, 16) <= e.partial.scannedThrough);
      return true;
    });
    assert.ok(net.eps[A].logCalls.length < 7, 'no new chunks after the abort');
  });
});
