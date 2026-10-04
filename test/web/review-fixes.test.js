'use strict';
// Behaviour added after the independent review: hidden characters, local origins, packed cache, verified memos in CSV,
// malformed links, wallet checks (chain id, no account, extra RPC URL). Pure helpers and wallet.js with a stub provider.
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const abi = require('../../web/js/abi.js');
const util = require('../../web/js/util.js');
const config = require('../../web/js/config.js');

describe('hidden characters: stripInvisible / hasInvisible / showInvisible', () => {
  const ALL = ['\u200b', '\u200c', '\u200d', '\u200e', '\u200f', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069', '\ufeff'];

  it('removes every zero-width and bidi control and the BOM, keeps everything else', () => {
    for (const c of ALL) {
      assert.equal(util.stripInvisible('a' + c + 'b'), 'ab', 'U+' + c.charCodeAt(0).toString(16));
      assert.equal(util.hasInvisible('a' + c + 'b'), true);
    }
    assert.equal(util.stripInvisible(ALL.join('') + 'Invoice \u00e9\u4e2d\ud83d\ude00 =1'), 'Invoice \u00e9\u4e2d\ud83d\ude00 =1');
    assert.equal(util.hasInvisible('plain text, accents \u00e9, emoji \ud83d\ude00, spaces  and\ttabs'), false);
    assert.equal(util.stripInvisible(''), '');
  });

  it('shows what remains as visible placeholders such as <U+202E>', () => {
    assert.equal(util.showInvisible('pay\u202eevil'), 'pay<U+202E>evil');
    assert.equal(util.showInvisible('\u200bx\ufeff'), '<U+200B>x<U+FEFF>');
    assert.equal(util.showInvisible('\u2066a\u2069'), '<U+2066>a<U+2069>');
    assert.equal(util.showInvisible('nothing special'), 'nothing special');
    assert.ok(!/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(util.showInvisible(ALL.join(''))));
  });

  it('a description cleaned this way builds the same memo as the clean text', () => {
    const salt = '0'.repeat(32);
    const dirty = util.buildMemo({ number: 'N\u200b1', description: 'Logo\u202e design', salt });
    const clean = util.buildMemo({ number: util.stripInvisible('N\u200b1'), description: util.stripInvisible('Logo\u202e design'), salt });
    assert.equal(clean, '{"v":1,"no":"N1","d":"Logo design","s":"00000000000000000000000000000000"}');
    assert.notEqual(dirty, clean);
  });
});

describe('csvField: formula characters hidden behind spaces or invisible characters', () => {
  const cases = [
    [' =1+1', "' =1+1"], ['   +SUM(A1)', "'   +SUM(A1)"], ['\u00a0@x', "'\u00a0@x"], [' -2', "' -2"],
    ['\u200b=1', "'\u200b=1"], ['\ufeff+1', "'\ufeff+1"], ['\u202e-1', "'\u202e-1"], [' \u200b @A1', "' \u200b @A1"],
    ['=1', "'=1"], ['\tx', "'\tx"],
    ['hello =', 'hello ='], ['  text', '  text'], ['\u200bplain', '\u200bplain'], ['a=1', 'a=1'], ['', ''], ['   ', '   ']
  ];
  for (const [input, expected] of cases) {
    it(JSON.stringify(input) + ' -> ' + JSON.stringify(expected), () => assert.equal(util.csvField(input), expected));
  }

  it('csvNeedsGuard agrees and numbers are never guarded', () => {
    assert.equal(util.csvNeedsGuard(' =1'), true);
    assert.equal(util.csvNeedsGuard('abc'), false);
    assert.equal(util.csvField(-5), '-5');
    assert.equal(util.csvField(10n), '10');
  });
});

describe('recordsToCsvRows only trusts memo text that hashes to the reference hash', () => {
  const merchant = ethers.getAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
  const goodMemo = util.buildMemo({ number: 'INV-7', description: 'Real work', salt: '1'.repeat(32) });
  const goodHash = util.memoHash(goodMemo);
  const rec = (referenceHash) => ({
    id: abi.invoiceId(merchant, referenceHash), merchant, referenceHash, amount: 1250000n, due: 2000000000, createdAt: 1790000000, registered: true,
    state: 'open', payer: null, paidAt: null, cancelledAt: null, registerTx: '0x' + 'ab'.repeat(32), paymentTx: null, cancelTx: null
  });
  const ctx = (memos) => ({ network: 'local', contract: '0x' + 'cc'.repeat(20), memos, latestTimestamp: 1790000100 });
  const NO = util.CSV_COLUMNS.indexOf('invoice_number');
  const DESC = util.CSV_COLUMNS.indexOf('description');

  it('a memo that matches is used', () => {
    const row = util.recordsToCsvRows([rec(goodHash)], ctx({ [goodHash]: goodMemo }))[0];
    assert.equal(row[NO], 'INV-7');
    assert.equal(row[DESC], 'Real work');
  });

  it('text stored under a hash it does not hash to (edited or planted in localStorage) is ignored', () => {
    const forged = util.buildMemo({ number: 'FAKE', description: '=HYPERLINK("http://evil.example")', salt: '2'.repeat(32) });
    const row = util.recordsToCsvRows([rec(goodHash)], ctx({ [goodHash]: forged }))[0];
    assert.equal(row[NO], '');
    assert.equal(row[DESC], '');
    const row2 = util.recordsToCsvRows([rec(goodHash)], ctx({ [goodHash]: 'not even json' }))[0];
    assert.equal(row2[DESC], '');
  });

  it('the hash key is matched case-insensitively', () => {
    const row = util.recordsToCsvRows([rec(goodHash)], ctx({ [goodHash.toLowerCase()]: goodMemo }))[0];
    assert.equal(row[DESC], 'Real work');
  });
});

describe('isLocalOrigin', () => {
  const yes = ['file:///home/me/web/index.html', 'FILE:///C:/web/index.html', 'http://localhost:8080/index.html', 'http://127.0.0.1:8080/', 'http://127.1.2.3/x', 'http://[::1]:3000/', 'http://0.0.0.0:8000/', 'http://app.localhost/', 'https://user:pw@localhost/x'];
  const no = ['https://merchant.github.io/invoices/index.html', 'https://example.org/', 'http://192.168.1.20:8080/', 'https://localhost.example.org/', 'https://notlocalhost/', 'ipfs://bafy/index.html', '', undefined, 'about:blank'];
  for (const u of yes) it('true: ' + u, () => assert.equal(util.isLocalOrigin(u), true));
  for (const u of no) it('false: ' + u, () => assert.equal(util.isLocalOrigin(u), false));
});

describe('packEvents / unpackEvents (compact localStorage cache)', () => {
  const merchant = ethers.getAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
  const payer = ethers.getAddress('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');
  const tx = (n) => '0x' + n.toString(16).padStart(64, '0');
  const events = [];
  for (let i = 0; i < 30; i++) {
    const hash = ethers.id('memo' + i);
    const id = abi.invoiceId(merchant, hash);
    events.push({ type: 'InvoiceRegistered', id, merchant, referenceHash: hash, amount: BigInt(1000000 + i), due: 1792000000 + i, createdAt: 1790000000 + i, address: '0x' + 'cc'.repeat(20), blockNumber: 100 + i, logIndex: 0, txHash: tx(i), blockHash: tx(1000 + i) });
    if (i % 3 === 0) events.push({ type: 'InvoicePaid', id, merchant, payer, referenceHash: hash, amount: BigInt(1000000 + i), paidAt: 1790000500 + i, address: '0x' + 'cc'.repeat(20), blockNumber: 200 + i, logIndex: 1, txHash: tx(2000 + i), blockHash: tx(3000 + i) });
    if (i % 5 === 0) events.push({ type: 'InvoiceCancelled', id, merchant, cancelledAt: 1790000900 + i, address: '0x' + 'cc'.repeat(20), blockNumber: 300 + i, logIndex: 2, txHash: tx(4000 + i), blockHash: tx(5000 + i) });
  }

  it('folding the unpacked events gives exactly the same invoices as folding the originals', () => {
    const back = util.unpackEvents(JSON.parse(JSON.stringify(util.packEvents(events))));
    assert.deepEqual(util.foldEvents(back), util.foldEvents(events));
    assert.equal(back.length, events.length);
  });

  it('keeps ordering fields, amounts as BigInt and drops what folding never uses', () => {
    const back = util.unpackEvents(util.packEvents(events));
    assert.ok(back.every((e, i) => e.blockNumber === events[i].blockNumber && e.logIndex === events[i].logIndex && e.txHash === events[i].txHash && e.type === events[i].type));
    assert.ok(back.filter((e) => e.type !== 'InvoiceCancelled').every((e) => typeof e.amount === 'bigint'));
    assert.ok(back.every((e) => e.blockHash === null && e.address === null));
  });

  it('is much smaller than the full serialisation', () => {
    const packed = JSON.stringify(util.packEvents(events)).length;
    const full = JSON.stringify(util.serializeEvents(events)).length;
    assert.ok(packed < full * 0.6, `${packed} vs ${full}`);
  });

  it('a corrupt cache is rejected instead of being half used', () => {
    const rows = util.packEvents(events);
    assert.throws(() => util.unpackEvents('nope'));
    assert.throws(() => util.unpackEvents([['x', 1]]));
    assert.throws(() => util.unpackEvents([rows[0].slice(0, 10)]));
    assert.throws(() => util.unpackEvents([['q'].concat(rows[0].slice(1))]));
    const badId = rows[0].slice();
    badId[1] = '0x12';
    assert.throws(() => util.unpackEvents([badId]));
    const badBlock = rows[0].slice();
    badBlock[9] = 'seven';
    assert.throws(() => util.unpackEvents([badBlock]));
    assert.deepEqual(util.unpackEvents([]), []);
  });
});

describe('malformed links', () => {
  const id = '0x' + '22'.repeat(32);
  const c = '0x' + '11'.repeat(20);

  it('"&amp;" instead of "&" is reported first, in plain words', () => {
    const r = util.parsePayFragment(`#net=local&amp;c=${c}&amp;id=${id}`);
    assert.ok(r.errors.length >= 1);
    assert.match(r.errors[0], /malformed/);
    assert.match(r.errors[0], /&amp;/);
    assert.equal(r.id, null);
    const r2 = util.parseReceiptsFragment('#net=local&amp;merchant=' + c);
    assert.match(r2.errors[0], /malformed/);
  });

  it('a proper link has no such error; a literal "amp" value does not trigger it', () => {
    assert.deepEqual(util.parsePayFragment(`#net=local&c=${c}&id=${id}`).errors, []);
    assert.deepEqual(util.parsePayFragment(`#net=local&id=${id}&memo=amp%3Bx`).errors, []);
  });

  it('prototype keys never leak into the parsed link', () => {
    const r = util.parsePayFragment(`#__proto__=x&constructor=y&id=${id}`);
    assert.equal(r.id, id);
    assert.equal(({}).x, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(config.networks, 'constructor'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(config.networks, '__proto__'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(config.networks, 'arcTestnet'), true);
  });
});

describe('wallet.js with a stub provider', () => {
  // wallet.js is a browser script: give it the few globals it touches, then load it once.
  const listeners = {};
  globalThis.ArcInvoice = Object.assign(globalThis.ArcInvoice || {}, { util });
  globalThis.addEventListener = (n, f) => { (listeners[n] = listeners[n] || []).push(f); };
  globalThis.removeEventListener = () => {};
  globalThis.dispatchEvent = () => true;
  require('../../web/js/wallet.js');
  const wallet = globalThis.ArcInvoice.wallet;

  function fakeProvider(opts) {
    const o = Object.assign({ accounts: ['0x70997970c51812dc3a010c7d01b50e0d17dc79c8'], chainId: '0x7a69', sendError: null }, opts);
    const calls = [];
    const provider = {
      calls,
      state: o,
      request: async ({ method, params }) => {
        calls.push({ method, params });
        switch (method) {
          case 'eth_requestAccounts':
          case 'eth_accounts': return o.accounts;
          case 'eth_chainId': return o.chainId;
          case 'eth_sendTransaction':
            if (o.sendError && o.sendError.length) throw o.sendError.shift();
            return '0x' + 'ab'.repeat(32);
          case 'wallet_switchEthereumChain':
            if (o.unknownChain) throw Object.assign(new Error('Unrecognized chain ID'), { code: 4902 });
            o.chainId = params[0].chainId;
            return null;
          case 'wallet_addEthereumChain':
            o.added = params[0];
            o.chainId = params[0].chainId;
            return null;
          default: throw new Error('unexpected ' + method);
        }
      },
      on() {},
      removeListener() {}
    };
    globalThis.ethereum = provider;
    return provider;
  }

  const tx = (extra) => Object.assign({ from: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8', to: '0x' + 'cc'.repeat(20), data: '0x8609cad1' + '11'.repeat(32), gas: 90000n, maxFeePerGas: 20000000000n, maxPriorityFeePerGas: 1000000000n }, extra);

  it('sendTransaction puts chainId (hex) into the transaction and reads the chain right before sending', async () => {
    const p = fakeProvider();
    const hash = await wallet.sendTransaction(tx({ chainId: 31337, networkName: 'Local dev', value: 1250000n * 10n ** 12n }));
    assert.equal(hash, '0x' + 'ab'.repeat(32));
    const methods = p.calls.map((c) => c.method);
    assert.deepEqual(methods.slice(-2), ['eth_chainId', 'eth_sendTransaction']);
    const sent = p.calls[p.calls.length - 1].params[0];
    assert.equal(sent.chainId, '0x7a69');
    assert.equal(sent.value, '0x' + (1250000n * 10n ** 12n).toString(16));
    assert.equal(sent.gas, '0x15f90');
    assert.equal(sent.maxFeePerGas, '0x' + (20000000000n).toString(16));
    assert.equal(sent.maxPriorityFeePerGas, '0x3b9aca00');
  });

  it('sendTransaction refuses (and sends nothing) when the wallet is on another chain', async () => {
    const p = fakeProvider({ chainId: '0x1' });
    await assert.rejects(wallet.sendTransaction(tx({ chainId: 31337, networkName: 'Local dev' })), (e) => {
      assert.equal(e.code, 'WRONG_CHAIN');
      assert.match(e.userMessage, /no longer on Local dev/);
      assert.match(e.userMessage, /Nothing was sent/);
      assert.equal(util.explainFailure(e), e.userMessage);
      return true;
    });
    assert.ok(!p.calls.some((c) => c.method === 'eth_sendTransaction'));
  });

  it('without a chainId the old behaviour stays: no chain check, no chainId field', async () => {
    const p = fakeProvider({ chainId: '0x1' });
    await wallet.sendTransaction(tx());
    assert.deepEqual(p.calls.map((c) => c.method).filter((m) => m !== 'eth_accounts'), ['eth_sendTransaction']);
    assert.ok(!('chainId' in p.calls[p.calls.length - 1].params[0]));
  });

  it('a wallet that refuses the priority fee is retried with zero priority and still carries chainId', async () => {
    const p = fakeProvider({ sendError: [Object.assign(new Error('maxPriorityFeePerGas too low'), { code: -32602 })] });
    await wallet.sendTransaction(tx({ chainId: 31337 }));
    const sends = p.calls.filter((c) => c.method === 'eth_sendTransaction');
    assert.equal(sends.length, 2);
    assert.equal(sends[1].params[0].maxPriorityFeePerGas, '0x0');
    assert.equal(sends[1].params[0].chainId, '0x7a69');
  });

  it('a user rejection is not retried', async () => {
    const p = fakeProvider({ sendError: [Object.assign(new Error('User rejected the request.'), { code: 4001 })] });
    await assert.rejects(wallet.sendTransaction(tx({ chainId: 31337 })), (e) => e.code === 4001);
    assert.equal(p.calls.filter((c) => c.method === 'eth_sendTransaction').length, 1);
  });

  it('connect: a wallet that shares no account gets its own message, not "you rejected"', async () => {
    fakeProvider({ accounts: [] });
    await assert.rejects(wallet.connect(), (e) => {
      assert.equal(e.code, 'NO_ACCOUNT');
      assert.equal(util.explainFailure(e), 'The wallet did not share an account. Unlock it and try again.');
      assert.ok(!/rejected/i.test(util.explainFailure(e)));
      return true;
    });
    fakeProvider();
    assert.equal(await wallet.connect(), '0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
  });

  it('chainParams: USDC with 18 decimals, primary RPC first and the Blockdaemon endpoint as the second rpcUrls entry', () => {
    for (const k of ['arcTestnet', 'arcMainnet']) {
      const params = wallet.chainParams(config.networks[k]);
      assert.equal(params.chainId, '0x' + config.networks[k].chainId.toString(16));
      assert.deepEqual(params.nativeCurrency, { name: 'USDC', symbol: 'USDC', decimals: 18 });
      assert.equal(params.rpcUrls.length, 2);
      assert.equal(params.rpcUrls[0], config.networks[k].rpc);
      assert.match(params.rpcUrls[1], /^https:\/\/rpc\.blockdaemon\.(testnet|mainnet)\.arc\.io$/);
      assert.ok(params.rpcUrls[1].includes(k === 'arcTestnet' ? 'testnet' : 'mainnet'));
      assert.deepEqual(params.blockExplorerUrls, [config.networks[k].explorer]);
    }
    const local = wallet.chainParams(config.networks.local);
    assert.deepEqual(local.rpcUrls, ['http://127.0.0.1:8545']);
    assert.deepEqual(local.blockExplorerUrls, []);
  });

  it('ensureChain: an unknown chain (4902) is added with those params, then the wallet is on it', async () => {
    const p = fakeProvider({ chainId: '0x1', unknownChain: true });
    await wallet.ensureChain(config.networks.arcTestnet);
    assert.equal(p.state.added.chainId, '0x4cef52');
    assert.equal(p.state.added.rpcUrls.length, 2);
    assert.equal(wallet.state.chainId, 5042002);
  });
});
