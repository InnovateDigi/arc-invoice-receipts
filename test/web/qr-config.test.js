'use strict';
// QR matrix/SVG (web/js/qr.js over the vendored library), the shipped configuration files and the RPC URL check.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const qr = require('../../web/js/qr.js');
const util = require('../../web/js/util.js');
const abi = require('../../web/js/abi.js');
const config = require('../../web/js/config.js');

const SAMPLE = 'http://127.0.0.1:8080/pay.html#net=local&c=0x8A791620dd6260079BF849Dc5567aDC3F2FdC318&id=0x1b0471891c509ac808521553f0b6732085604aed51792b4968ceaf153f060652&memo=%7B%22v%22%3A1%2C%22no%22%3A%22INV-001%22%2C%22d%22%3A%22Website%20design%2C%20phase%201%22%2C%22s%22%3A%2288ff6b114b22a02302df6030d1947d2a%22%7D';
// deployments.js is rewritten by the deploy script: evaluate it like a classic script instead of requiring it.
function loadDeployments() {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'js', 'deployments.js'), 'utf8');
  const win = {};
  new Function('window', 'module', src)(win, undefined);
  return win.ArcInvoiceDeployments;
}
const deployments = loadDeployments();
const sha = (m) => crypto.createHash('sha256').update(m.modules.map((r) => r.map((x) => (x ? '1' : '0')).join('')).join('\n')).digest('hex');

describe('qr: matrix', () => {
  it('is non-empty, square, and its size follows the QR version formula', () => {
    const m = qr.create(SAMPLE, { ecc: 'M' });
    assert.ok(m.version >= 1 && m.version <= 40);
    assert.equal(m.size, 17 + 4 * m.version);
    assert.equal(m.modules.length, m.size);
    assert.ok(m.modules.every((row) => row.length === m.size));
    const dark = m.modules.reduce((n, row) => n + row.filter(Boolean).length, 0);
    assert.ok(dark > m.size * 4 && dark < m.size * m.size, 'a plausible number of dark modules: ' + dark);
    assert.equal(m.text, SAMPLE);
    assert.equal(m.ecc, 'M');
  });

  it('is stable: the same link always gives the same matrix (pinned hashes for levels M and L)', () => {
    assert.equal(sha(qr.create(SAMPLE, { ecc: 'M' })), '7198fc2a786fb6a2f64d090ec8c50e2ce4c583d93c882de2fdd44ce0c9d755d7');
    assert.equal(sha(qr.create(SAMPLE, { ecc: 'L' })), '7414f1582964e44f39e57690a1b5b7d6336ead5801af34cf52297eb161d6271e');
    assert.equal(sha(qr.create(SAMPLE)), sha(qr.create(SAMPLE, { ecc: 'M' })), 'M is the default level');
    assert.equal(qr.create(SAMPLE, { ecc: 'M' }).version, 13);
    assert.ok(qr.create(SAMPLE, { ecc: 'L' }).version < qr.create(SAMPLE, { ecc: 'M' }).version);
  });

  it('has the mandatory structure: three finder patterns, timing patterns and the dark module', () => {
    const m = qr.create(SAMPLE, { ecc: 'M' });
    const finder = (r0, c0) => {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
          const border = r === 0 || r === 6 || c === 0 || c === 6;
          const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          assert.equal(m.modules[r0 + r][c0 + c], border || core, `finder at ${r0},${c0} module ${r},${c}`);
        }
      }
    };
    finder(0, 0);
    finder(0, m.size - 7);
    finder(m.size - 7, 0);
    for (let i = 8; i < m.size - 8; i++) {
      assert.equal(m.modules[6][i], i % 2 === 0, 'row timing pattern at ' + i);
      assert.equal(m.modules[i][6], i % 2 === 0, 'column timing pattern at ' + i);
    }
    assert.equal(m.modules[m.size - 8][8], true, 'the always-dark module');
  });

  it('different links give different matrices', () => {
    assert.notEqual(sha(qr.create(SAMPLE)), sha(qr.create(SAMPLE.replace('INV-001', 'INV-002'))));
  });

  it('encodes UTF-8 bytes: non-ASCII text needs more room than the same number of ASCII characters', () => {
    const ascii = qr.create('e'.repeat(300), { ecc: 'M' });
    const accents = qr.create('é'.repeat(300), { ecc: 'M' });
    assert.ok(accents.version > ascii.version);
    assert.ok(qr.create('中文'.repeat(40)).size > 21);
  });

  it('a realistic longest invoice link (140 character description, 32 character number) still fits easily', () => {
    const memo = util.buildMemo({ number: 'N'.repeat(32), description: 'd'.repeat(140), salt: '0'.repeat(32) });
    const link = util.buildPayLink('https://merchant.github.io/invoices/', { net: 'arcTestnet', contract: '0x' + 'ab'.repeat(20), id: '0x' + 'cd'.repeat(32), memo });
    const m = qr.create(link, { ecc: 'M' });
    assert.ok(m.version <= 20, `version ${m.version} for a ${link.length} character link`);
  });

  it('a link that cannot fit fails with a plain-English error and code TOO_LONG', () => {
    assert.throws(() => qr.create('x'.repeat(5000), { ecc: 'M' }), (e) => e.code === 'TOO_LONG' && /too long/i.test(e.message) && /shorten/i.test(e.message));
    assert.throws(() => qr.create('x'.repeat(2400), { ecc: 'M' }), (e) => e.code === 'TOO_LONG');
    assert.doesNotThrow(() => qr.create('x'.repeat(2300), { ecc: 'M' }));
    assert.doesNotThrow(() => qr.create('x'.repeat(2900), { ecc: 'L' }));
  });
});

describe('qr: SVG', () => {
  // Rebuild the module matrix from the SVG path to prove the picture holds exactly the matrix.
  function matrixFromSvg(svg, size, margin) {
    const d = /<path fill="#000000" d="([^"]*)"/.exec(svg)[1];
    const rows = Array.from({ length: size }, () => Array(size).fill(false));
    const re = /M(\d+) (\d+)h(\d+)v1h-\3z/g;
    let m;
    let runs = 0;
    while ((m = re.exec(d))) {
      runs++;
      for (let i = 0; i < Number(m[3]); i++) rows[Number(m[2]) - margin][Number(m[1]) - margin + i] = true;
    }
    return { rows, runs, covered: d.replace(re, '').length === 0 };
  }

  it('renders black on white with a 4 module quiet zone and round-trips to the matrix', () => {
    const m = qr.create(SAMPLE);
    const svg = qr.toSvgString(m, { title: 'QR code of the pay link' });
    const dim = m.size + 8;
    assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
    assert.ok(svg.includes(`viewBox="0 0 ${dim} ${dim}"`));
    assert.ok(svg.includes(`<rect width="${dim}" height="${dim}" fill="#ffffff"/>`));
    assert.ok(svg.includes('shape-rendering="crispEdges"'));
    assert.ok(svg.includes('role="img"'));
    assert.ok(svg.includes('aria-label="QR code of the pay link"'));
    const back = matrixFromSvg(svg, m.size, 4);
    assert.ok(back.covered, 'the path holds nothing but run segments');
    assert.deepEqual(back.rows, m.modules);
    assert.ok(svg.length < 20000, 'compact: ' + svg.length);
    assert.equal(qr.QUIET_ZONE, 4);
  });

  it('margin and scale options', () => {
    const m = qr.create('hello');
    const svg0 = qr.toSvgString(m, { margin: 0, scale: 3 });
    assert.ok(svg0.includes(`viewBox="0 0 ${m.size} ${m.size}"`));
    assert.ok(svg0.includes(`width="${m.size * 3}"`));
    assert.deepEqual(matrixFromSvg(svg0, m.size, 0).rows, m.modules);
  });

  it('the title cannot break out of the attribute', () => {
    const svg = qr.toSvgString(qr.create('x'), { title: '"><script>alert(1)</script>' });
    assert.ok(!svg.includes('<script'));
    assert.equal((svg.match(/aria-label="/g) || []).length, 1);
  });
});

describe('config.js and deployments.js', () => {
  it('REPO_URL is an empty string by default', () => {
    assert.equal(config.REPO_URL, '');
  });

  it('networks: keys, chain ids, explorers, flags', () => {
    assert.deepEqual(Object.keys(config.networks).sort(), ['arcMainnet', 'arcTestnet', 'local']);
    for (const [k, n] of Object.entries(config.networks)) {
      assert.equal(n.key, k);
      assert.equal(typeof n.name, 'string');
      assert.ok(Number.isInteger(n.chainId) && n.chainId > 0);
      assert.match(n.rpc, /^https?:\/\//);
    }
    assert.equal(config.networks.arcTestnet.chainId, 5042002);
    assert.equal(config.networks.arcMainnet.chainId, 5042);
    assert.equal(config.networks.local.chainId, 31337);
    assert.equal(config.networks.arcTestnet.testnet, true);
    assert.ok(!config.networks.arcMainnet.testnet);
    assert.equal(config.networks.local.dev, true);
    assert.equal(config.networks.local.rpc, 'http://127.0.0.1:8545');
    assert.equal(config.networks.arcTestnet.explorer, 'https://explorer.testnet.arc.io');
    assert.equal(config.networks.arcMainnet.explorer, 'https://explorer.arc.io');
    assert.equal(config.networks.local.explorer, '');
    assert.ok(config.networks[config.defaultNetwork]);
    assert.equal(config.defaultNetwork, 'arcTestnet');
  });

  it('rpcs: read list starts with `rpc`, logs list starts with the endpoint that allows big ranges, all https and unique', () => {
    for (const k of ['arcTestnet', 'arcMainnet']) {
      const n = config.networks[k];
      assert.equal(n.rpcs.read[0].url, n.rpc);
      assert.ok(n.rpcs.logs[0].logRange >= 90000 && n.rpcs.logs[0].logRange < 100000);
      assert.ok(n.rpcs.logs[0].concurrency >= 2);
      for (const list of [n.rpcs.read, n.rpcs.logs]) {
        assert.ok(list.length >= 2);
        assert.equal(new Set(list.map((e) => e.url)).size, list.length);
        for (const e of list) {
          assert.match(e.url, /^https:\/\/[a-z0-9.-]+$/);
          assert.ok(e.logRange >= 1 && Number.isInteger(e.logRange));
          assert.ok(!e.spacingMs || e.spacingMs >= 0);
        }
      }
      // the same endpoints in both lists, only the order differs
      assert.deepEqual(n.rpcs.read.map((e) => e.url).sort(), n.rpcs.logs.map((e) => e.url).sort());
      assert.ok(n.rpcs.read.filter((e) => e.logRange === 9999).every((e) => e.spacingMs >= 250 && e.concurrency === 1));
    }
    assert.ok(config.networks.arcTestnet.rpcs.read.every((e) => e.url.includes('testnet') || e.url.includes('.arc.io')));
    assert.ok(config.networks.arcMainnet.rpcs.read.every((e) => !e.url.includes('testnet')));
    assert.equal(config.networks.local.rpcs, undefined, 'the local network keeps its single URL');
  });

  it('deployments.js has one entry per network with an address or empty string and a block number', () => {
    assert.deepEqual(Object.keys(deployments).sort(), ['arcMainnet', 'arcTestnet', 'local']);
    for (const d of Object.values(deployments)) {
      assert.ok(d.contract === '' || abi.isAddress(d.contract), 'contract: ' + d.contract);
      assert.ok(Number.isInteger(d.deployBlock) && d.deployBlock >= 0);
    }
  });

  it('deployments.js assigns window.ArcInvoiceDeployments', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'js', 'deployments.js'), 'utf8');
    assert.match(src, /window\.ArcInvoiceDeployments\s*=/);
    assert.deepEqual(Object.keys(loadDeployments()).sort(), ['arcMainnet', 'arcTestnet', 'local']);
  });
});

describe('util.validateRpcUrl', () => {
  it('empty means "use the defaults"', () => {
    assert.deepEqual(util.validateRpcUrl(''), { ok: true, url: '' });
    assert.deepEqual(util.validateRpcUrl('   '), { ok: true, url: '' });
    assert.deepEqual(util.validateRpcUrl(undefined), { ok: true, url: '' });
  });

  it('accepts https URLs (with path and key) and http only for this computer', () => {
    assert.equal(util.validateRpcUrl('https://rpc.example.org').url, 'https://rpc.example.org/');
    assert.equal(util.validateRpcUrl(' https://rpc.example.org/v1/abc?key=1 ').url, 'https://rpc.example.org/v1/abc?key=1');
    assert.equal(util.validateRpcUrl('http://127.0.0.1:8545').url, 'http://127.0.0.1:8545/');
    assert.equal(util.validateRpcUrl('http://localhost:9000/rpc').ok, true);
  });

  it('rejects other schemes, plain http to remote hosts, credentials and nonsense', () => {
    for (const bad of ['http://rpc.example.org', 'ftp://x.example', 'javascript:alert(1)', 'file:///etc/passwd', 'ws://127.0.0.1:8546', 'data:text/plain,hi', 'not a url', 'rpc.example.org', 'https://user:pass@rpc.example.org', 'http://127.0.0.1.evil.example']) {
      const r = util.validateRpcUrl(bad);
      assert.equal(r.ok, false, bad);
      assert.ok(typeof r.error === 'string' && r.error.length > 10);
    }
  });
});
