'use strict';
/*
 * Unit tests for web/js/util.js (pure helpers of the Arc Invoice Receipts static web app).
 *
 * Run only this file with:  npx mocha test/web/util.test.js
 *
 * No network, no DOM, no chain. ethers v6 is used as an independent oracle (ids, ABI encodings, unit parsing).
 * Tests whose name starts with "BUG:" encode the behaviour the module should have; they currently FAIL because of a
 * real defect in util.js (the module is deliberately not touched here).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ethers } = require('ethers');

const util = require('../../web/js/util.js');
const abi = require('../../web/js/abi.js');
const keccak = require('../../web/js/keccak.js');

// ====================================================================================================== helpers

const WEB_JS = path.join(__dirname, '..', '..', 'web', 'js');
const CONTRACT_SOL = path.join(__dirname, '..', '..', 'contracts', 'InvoiceReceipts.sol');

const MAX_UINT96 = 2n ** 96n - 1n;
const SCALE = 10n ** 12n;
const GWEI = 10n ** 9n;

// Well known checksummed addresses (hardhat accounts 0, 1, 2 and the first deployed contract).
const MERCHANT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const PAYER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const PAYER2 = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

const hex32 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const ID = (n) => hex32(0x1000n + BigInt(n));
const REF = (n) => hex32(0x2000n + BigInt(n));
const TX = (n) => hex32(0x3000n + BigInt(n));

/** Small deterministic PRNG (mulberry32) so that "random" tests are reproducible. */
function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randBigInt(rng, bits) {
  let v = 0n;
  for (let i = 0; i < bits; i += 32) v = (v << 32n) | BigInt(Math.floor(rng() * 4294967296));
  return v & ((1n << BigInt(bits)) - 1n);
}
function randInt(rng, n) {
  return Math.floor(rng() * n);
}
function pick(rng, list) {
  return list[randInt(rng, list.length)];
}
function shuffle(rng, list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function permutations(list) {
  if (list.length <= 1) return [list.slice()];
  const out = [];
  list.forEach((x, i) => {
    permutations(list.slice(0, i).concat(list.slice(i + 1))).forEach((p) => out.push([x].concat(p)));
  });
  return out;
}

/** assert that fn throws an Error carrying .code === code and a non-empty message. */
function assertThrowsCode(fn, code, label) {
  assert.throws(fn, (e) => {
    assert.ok(e instanceof Error, (label || '') + ' should throw an Error');
    assert.equal(e.code, code, (label || '') + ' wrong code, message: ' + e.message);
    assert.equal(typeof e.message, 'string');
    assert.ok(e.message.length > 0);
    return true;
  });
}

/** Strict RFC 4180 parser (throws on a bare CR/LF or a stray quote outside quotes). Strips a leading BOM. */
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let atFieldStart = true;
  let closedQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
          closedQuote = true;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      atFieldStart = true;
      closedQuote = false;
      continue;
    }
    if (ch === '\r' && text[i + 1] === '\n') {
      i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      atFieldStart = true;
      closedQuote = false;
      continue;
    }
    if (closedQuote) throw new Error('garbage after a closing quote at index ' + i);
    if (ch === '\n' || ch === '\r') throw new Error('bare line break outside quotes at index ' + i);
    if (ch === '"') {
      if (!atFieldStart) throw new Error('stray quote inside an unquoted field at index ' + i);
      inQuotes = true;
      atFieldStart = false;
      continue;
    }
    field += ch;
    atFieldStart = false;
  }
  if (inQuotes) throw new Error('unterminated quoted field');
  if (field !== '' || row.length > 0 || closedQuote) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** What a text cell looks like after csvField + parseCsv. */
function expectedCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return String(value);
  // a leading = + - @ TAB CR, or = + - @ after spaces / zero-width / bidi characters, gets a quote
  return value.length > 0 && ('=+-@\t\r'.indexOf(value.charAt(0)) !== -1 || /^[ \u00a0\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]*[=+\-@]/.test(value)) ? "'" + value : value;
}

// Decoded events, in the shape produced by abi.decodeLog.
function registered(o) {
  return Object.assign({
    type: 'InvoiceRegistered', id: ID(1), merchant: MERCHANT, referenceHash: REF(1), amount: 1250000n,
    due: 1790086400, createdAt: 1790000000,
    address: CONTRACT.toLowerCase(), blockNumber: 10, logIndex: 0, txHash: TX(1), blockHash: hex32(0xb10c)
  }, o);
}
function paid(o) {
  return Object.assign({
    type: 'InvoicePaid', id: ID(1), merchant: MERCHANT, payer: PAYER, referenceHash: REF(1), amount: 1250000n,
    paidAt: 1790003600,
    address: CONTRACT.toLowerCase(), blockNumber: 12, logIndex: 0, txHash: TX(2), blockHash: hex32(0xb10d)
  }, o);
}
function cancelled(o) {
  return Object.assign({
    type: 'InvoiceCancelled', id: ID(1), merchant: MERCHANT, cancelledAt: 1790007200,
    address: CONTRACT.toLowerCase(), blockNumber: 13, logIndex: 0, txHash: TX(3), blockHash: hex32(0xb10e)
  }, o);
}

/** Run fn with process.env.TZ switched (restored afterwards). Returns false when the runtime ignores the switch. */
function withTimezone(zone, expectedJuneOffsetMinutes, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'TZ');
  const prev = process.env.TZ;
  process.env.TZ = zone;
  try {
    if (new Date(Date.UTC(2026, 5, 15, 12)).getTimezoneOffset() !== expectedJuneOffsetMinutes) return false;
    fn();
    return true;
  } finally {
    if (had) process.env.TZ = prev;
    else delete process.env.TZ;
  }
}

/** Run fn with globalThis.crypto replaced (value may be undefined), then restore the original property. */
function withGlobalCrypto(value, fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true, writable: true, enumerable: false });
  try {
    return fn();
  } finally {
    if (saved) Object.defineProperty(globalThis, 'crypto', saved);
    else delete globalThis.crypto;
  }
}

// ======================================================================================================== tests

describe('web/js/util.js', function () {
  // ------------------------------------------------------------------------------------------------- module
  describe('module shape', function () {
    it('exports every documented helper', function () {
      const fns = [
        'parseUsdc', 'tryParseUsdc', 'formatUsdc', 'usdcToNative', 'nativeToUsdc', 'formatNativeUsdc', 'codePointLength',
        'randomSalt', 'buildMemo', 'memoHash', 'verifyMemo', 'parseMemo', 'pageDirectory', 'buildPayLink',
        'buildReceiptsLink', 'parseFragment', 'parsePayFragment', 'parseReceiptsFragment', 'addressTopic', 'toIsoUtc',
        'formatUtc', 'formatLocal', 'dateStamp', 'relativeTime', 'parseLocalDateTime', 'toLocalDateTimeValue',
        'csvField', 'csvRow', 'buildCsv', 'compareEvents', 'mergeEvents', 'foldEvents', 'effectiveStatus',
        'statusFromChain', 'summarize', 'serializeEvents', 'deserializeEvents', 'recordsToCsvRows', 'buildInvoiceCsv',
        'csvFilename', 'createStore', 'loadMemos', 'saveMemo', 'toHex', 'hexToBigInt', 'computeTxParams',
        'explainContractError', 'explainFailure', 'replayFailedTx', 'failedOnChainMessage', 'validateRpcUrl',
        'shortAddress', 'shortHash', 'formatCount', 'explorerUrl'
      ];
      fns.forEach((n) => assert.equal(typeof util[n], 'function', n));
    });

    it('exports the constants', function () {
      assert.equal(util.UNITS_PER_USDC, 1000000n);
      assert.deepEqual(util.MEMO_LIMITS, { description: 140, number: 32 });
      assert.equal(util.CSV_BOM, '\uFEFF');
      assert.equal(util.CSV_BOM.length, 1);
      assert.equal(util.addressTopic, abi.addressTopic);
    });

    it('works as classic <script> files (browser style) and registers ArcInvoice.util', function () {
      const read = (f) => fs.readFileSync(path.join(WEB_JS, f), 'utf8');
      const ctx = vm.createContext({});
      vm.runInContext(read('keccak.js'), ctx, { filename: 'keccak.js' });
      vm.runInContext(read('abi.js'), ctx, { filename: 'abi.js' });
      vm.runInContext(read('util.js'), ctx, { filename: 'util.js' });
      const U = vm.runInContext('ArcInvoice.util', ctx);
      assert.equal(U.parseUsdc('1.25'), 1250000n);
      assert.equal(U.formatUsdc(1250000n), '1.25');
      assert.equal(U.CSV_COLUMNS.join(','), util.CSV_COLUMNS.join(','));
      assert.equal(Object.keys(U).sort().join(','), Object.keys(util).sort().join(','));
      assert.equal(U.memoHash('abc'), util.memoHash('abc'));
    });

    it('refuses to load as a classic script without keccak.js and abi.js', function () {
      const ctx = vm.createContext({});
      assert.throws(
        () => vm.runInContext(fs.readFileSync(path.join(WEB_JS, 'util.js'), 'utf8'), ctx, { filename: 'util.js' }),
        /load js\/keccak\.js and js\/abi\.js before js\/util\.js/
      );
    });
  });

  // ------------------------------------------------------------------------------------------------- amounts
  describe('amounts', function () {
    describe('parseUsdc', function () {
      const valid = [
        ['1', 1000000n],
        ['1.', 1000000n],
        ['.5', 500000n],
        ['0.000001', 1n],
        ['001.50', 1500000n],
        ['  12.5  ', 12500000n],
        ['\t12.5\n', 12500000n],
        ['\u00a07\u00a0', 7000000n],
        ['\ufeff7', 7000000n],
        ['0', 0n],
        ['0.', 0n],
        ['.0', 0n],
        ['00', 0n],
        ['0.000000', 0n],
        ['0.1', 100000n],
        ['0.01', 10000n],
        ['0.999999', 999999n],
        ['1.5', 1500000n],
        ['1.50', 1500000n],
        ['1.500000', 1500000n],
        ['25', 25000000n],
        ['1250.50', 1250500000n],
        ['123456789.123456', 123456789123456n],
        ['0'.repeat(40) + '1', 1000000n],
        // uint96 boundary: MAX_UINT96 units = 79228162514264337593543.950335 USDC
        ['79228162514264337593543.950335', MAX_UINT96],
        ['79228162514264337593543.95033', MAX_UINT96 - 5n],
        ['79228162514264337593543', 79228162514264337593543n * 1000000n]
      ];
      valid.forEach(([input, expected]) => {
        it('accepts ' + JSON.stringify(input) + ' as ' + expected + ' units', function () {
          assert.equal(util.parseUsdc(input), expected);
          assert.equal(typeof util.parseUsdc(input), 'bigint');
        });
      });

      const invalid = [
        ['', 'EMPTY'], [' ', 'EMPTY'], ['\t\n', 'EMPTY'],
        ['.', 'FORMAT'],
        ['-', 'NEGATIVE'], ['-1', 'NEGATIVE'], ['-0', 'NEGATIVE'], ['-0.5', 'NEGATIVE'], [' -1', 'NEGATIVE'],
        ['--1', 'NEGATIVE'], ['-.5', 'NEGATIVE'],
        ['+1', 'FORMAT'], ['+', 'FORMAT'], ['1e6', 'FORMAT'], ['1E6', 'FORMAT'], ['1e-6', 'FORMAT'],
        ['1,000', 'SEPARATOR'], ['1,5', 'SEPARATOR'], ['1 000', 'SEPARATOR'], ['1_000', 'SEPARATOR'],
        ['1\u00a0000', 'SEPARATOR'], [',', 'SEPARATOR'], ['1,000.50', 'SEPARATOR'], ['1\n2', 'SEPARATOR'],
        ['1.2.3', 'FORMAT'], ['1..2', 'FORMAT'], ['..', 'FORMAT'], ['1.5.', 'FORMAT'],
        ['0x10', 'FORMAT'], ['0x', 'FORMAT'], ['abc', 'FORMAT'], ['1a', 'FORMAT'], ['$5', 'FORMAT'],
        ['Infinity', 'FORMAT'], ['NaN', 'FORMAT'],
        ['\u0967\u0968', 'FORMAT'], // Devanagari digits
        ['\u0661\u0662\u0663', 'FORMAT'], // Arabic-Indic digits
        ['\uff11\uff12', 'FORMAT'], // full-width digits
        ['\u22121', 'FORMAT'], // unicode minus sign
        ['1.\u0665', 'FORMAT'],
        ['1.1234567', 'DECIMALS'], ['0.0000001', 'DECIMALS'], ['1.0000000', 'DECIMALS'], ['.1234567', 'DECIMALS'],
        ['79228162514264337593543.950336', 'TOO_LARGE'], // one unit above uint96 max
        ['79228162514264337593544', 'TOO_LARGE'],
        ['9'.repeat(40), 'TOO_LARGE'],
        ['1' + '0'.repeat(30), 'TOO_LARGE']
      ];
      invalid.forEach(([input, code]) => {
        it('rejects ' + JSON.stringify(input) + ' with code ' + code, function () {
          assertThrowsCode(() => util.parseUsdc(input), code, JSON.stringify(input));
        });
      });

      [NaN, null, undefined, 5, 1.5, 5n, true, false, {}, [], ['1'], () => 1, new String('1')].forEach((input) => {
        it('rejects the non-string ' + (typeof input) + ' ' + String(typeof input === 'function' ? 'fn' : input) + ' with code FORMAT', function () {
          assertThrowsCode(() => util.parseUsdc(input), 'FORMAT');
        });
      });

      it('the exact uint96 boundary: max is accepted and equals abi.MAX_UINT96, one unit more is TOO_LARGE', function () {
        assert.equal(util.parseUsdc('79228162514264337593543.950335'), abi.MAX_UINT96);
        assert.equal(abi.MAX_UINT96, 79228162514264337593543950335n);
        assertThrowsCode(() => util.parseUsdc('79228162514264337593543.950336'), 'TOO_LARGE');
        assert.equal(util.formatUsdc(abi.MAX_UINT96, { fixed: true }), '79228162514264337593543.950335');
      });

      it('accepts zero (the contract, not the parser, rejects a zero amount)', function () {
        assert.equal(util.parseUsdc('0'), 0n);
      });

      it('error objects carry a human readable message', function () {
        ['', '-1', '1,5', 'abc', '1.1234567', '9'.repeat(40)].forEach((input) => {
          try {
            util.parseUsdc(input);
            assert.fail('should have thrown for ' + JSON.stringify(input));
          } catch (e) {
            assert.match(e.message, /^[A-Z].*[.]$/s);
          }
        });
      });

      it('agrees with ethers.parseUnits(x, 6) on random valid decimal strings', function () {
        const rng = makeRng(1);
        const digits = (n) => Array.from({ length: n }, () => String(randInt(rng, 10))).join('');
        for (let i = 0; i < 400; i++) {
          let whole = digits(randInt(rng, 31));
          const frac = digits(randInt(rng, 7));
          const withDot = frac !== '' || rng() < 0.3;
          if (whole === '' && frac === '') whole = digits(1);
          const s = whole + (withDot ? '.' + frac : '');
          const expected = ethers.parseUnits(BigInt(whole || '0').toString() + '.' + (frac || '0'), 6);
          if (expected > MAX_UINT96) assertThrowsCode(() => util.parseUsdc(s), 'TOO_LARGE', s);
          else assert.equal(util.parseUsdc(s), expected, s);
        }
      });
    });

    describe('tryParseUsdc', function () {
      it('returns { ok: true, value } for valid input', function () {
        assert.deepEqual(util.tryParseUsdc('1.25'), { ok: true, value: 1250000n });
        assert.deepEqual(util.tryParseUsdc(' .5 '), { ok: true, value: 500000n });
        assert.deepEqual(util.tryParseUsdc('0'), { ok: true, value: 0n });
      });

      it('returns { ok: false, error, code } instead of throwing', function () {
        const table = [
          ['', 'EMPTY'], ['-1', 'NEGATIVE'], ['1,000', 'SEPARATOR'], ['1.1234567', 'DECIMALS'], ['abc', 'FORMAT'],
          ['79228162514264337593543.950336', 'TOO_LARGE'], [null, 'FORMAT'], [undefined, 'FORMAT'], [NaN, 'FORMAT'], [12, 'FORMAT']
        ];
        table.forEach(([input, code]) => {
          const r = util.tryParseUsdc(input);
          assert.equal(r.ok, false, String(input));
          assert.equal(r.code, code, String(input));
          assert.equal(typeof r.error, 'string');
          assert.ok(r.error.length > 0);
          assert.equal('value' in r, false);
        });
      });

      it('its message equals the one parseUsdc throws', function () {
        ['', '-1', '1_0', '1.5555555', 'x'].forEach((input) => {
          let thrown;
          try { util.parseUsdc(input); } catch (e) { thrown = e; }
          assert.equal(util.tryParseUsdc(input).error, thrown.message);
        });
      });
    });

    describe('formatUsdc', function () {
      const table = [
        [1250000n, undefined, '1.25'],
        [1000000n, undefined, '1.00'],
        [1n, undefined, '0.000001'],
        [0n, undefined, '0.00'],
        [1234567890000n, undefined, '1234567.89'],
        [999999n, undefined, '0.999999'],
        [10n, undefined, '0.00001'],
        [100000n, undefined, '0.10'],
        [10000n, undefined, '0.01'],
        [1000n, undefined, '0.001'],
        [120n, undefined, '0.00012'],
        [1250000n, { fixed: true }, '1.250000'],
        [1000000n, { fixed: true }, '1.000000'],
        [0n, { fixed: true }, '0.000000'],
        [1n, { fixed: true }, '0.000001'],
        [1234567890000n, { group: true }, '1,234,567.89'],
        [1000000000n, { group: true }, '1,000.00'],
        [100000000n, { group: true }, '100.00'],
        [999999000000n, { group: true }, '999,999.00'],
        [0n, { group: true }, '0.00'],
        [1234567890123n, { group: true, fixed: true }, '1,234,567.890123'],
        [MAX_UINT96, undefined, '79228162514264337593543.950335'],
        [MAX_UINT96, { group: true }, '79,228,162,514,264,337,593,543.950335'],
        [-1250000n, undefined, '-1.25'],
        [-1n, { fixed: true }, '-0.000001'],
        [-1234567890000n, { group: true }, '-1,234,567.89']
      ];
      table.forEach(([input, opts, expected]) => {
        it(input + ' ' + JSON.stringify(opts || {}) + ' -> ' + expected, function () {
          assert.equal(util.formatUsdc(input, opts), expected);
        });
      });

      it('accepts Number and decimal-string units as well as BigInt', function () {
        assert.equal(util.formatUsdc(1250000), '1.25');
        assert.equal(util.formatUsdc('1250000'), '1.25');
      });

      it('grouping only touches the integer part and puts a comma every 3 digits', function () {
        const expected = { 1: '1', 12: '12', 123: '123', 1234: '1,234', 12345: '12,345', 123456: '123,456', 1234567: '1,234,567', 12345678: '12,345,678' };
        Object.keys(expected).forEach((k) => {
          assert.equal(util.formatUsdc(BigInt(k) * 1000000n + 123456n, { group: true, fixed: true }), expected[k] + '.123456');
        });
      });

      it('round trips: parseUsdc(formatUsdc(x)) === x, also with fixed:true, for random x of every magnitude', function () {
        const rng = makeRng(2);
        const samples = [0n, 1n, 999999n, 1000000n, 1000001n, MAX_UINT96, MAX_UINT96 - 1n, 10n ** 24n];
        for (let i = 0; i < 500; i++) samples.push(randBigInt(rng, 1 + randInt(rng, 96)));
        samples.forEach((x) => {
          assert.equal(util.parseUsdc(util.formatUsdc(x)), x, String(x));
          assert.equal(util.parseUsdc(util.formatUsdc(x, { fixed: true })), x, String(x));
          assert.match(util.formatUsdc(x, { fixed: true }), /^\d+\.\d{6}$/);
          assert.match(util.formatUsdc(x), /^\d+\.\d{2,6}$/);
        });
      });

      it('agrees with ethers.formatUnits(x, 6) numerically', function () {
        const rng = makeRng(3);
        for (let i = 0; i < 300; i++) {
          const x = randBigInt(rng, 1 + randInt(rng, 96));
          assert.equal(ethers.parseUnits(util.formatUsdc(x), 6), x);
          assert.equal(util.parseUsdc(ethers.formatUnits(x, 6)), x);
        }
      });
    });

    describe('native <-> USDC units', function () {
      it('usdcToNative(1250000n) === 1250000n * 10n ** 12n', function () {
        assert.equal(util.usdcToNative(1250000n), 1250000n * 10n ** 12n);
        assert.equal(util.usdcToNative(0n), 0n);
        assert.equal(util.usdcToNative(1n), 10n ** 12n);
        assert.equal(util.usdcToNative(5), 5n * 10n ** 12n);
        assert.equal(util.usdcToNative('7'), 7n * 10n ** 12n);
      });

      it('matches the contract rule msg.value == amount * 1e12 and abi.SCALE', function () {
        assert.equal(abi.SCALE, SCALE);
        assert.equal(util.usdcToNative(MAX_UINT96), MAX_UINT96 * SCALE);
        assert.equal(util.usdcToNative(util.parseUsdc('1.25')), ethers.parseUnits('1.25', 18));
        assert.equal(util.usdcToNative(util.parseUsdc('0.000001')), 10n ** 12n);
      });

      it('nativeToUsdc rounds down', function () {
        assert.equal(util.nativeToUsdc(1250000n * SCALE), 1250000n);
        assert.equal(util.nativeToUsdc(SCALE - 1n), 0n);
        assert.equal(util.nativeToUsdc(SCALE), 1n);
        assert.equal(util.nativeToUsdc(2n * SCALE + 999999999999n), 2n);
        assert.equal(util.nativeToUsdc(0n), 0n);
        assert.equal(util.nativeToUsdc('0x' + (3n * SCALE).toString(16)), 3n);
      });

      it('nativeToUsdc(usdcToNative(x)) === x for random x', function () {
        const rng = makeRng(4);
        for (let i = 0; i < 200; i++) {
          const x = randBigInt(rng, 1 + randInt(rng, 96));
          assert.equal(util.nativeToUsdc(util.usdcToNative(x)), x);
          assert.equal(util.nativeToUsdc(util.usdcToNative(x) + (SCALE - 1n)), x);
        }
      });
    });

    describe('formatNativeUsdc', function () {
      const table = [
        [0, undefined, '0.00'],
        [0n, undefined, '0.00'],
        [1500000000000000n, undefined, '0.0015'],
        [1n, undefined, '0.000001'], // rounds UP
        [10n ** 18n, undefined, '1.00'],
        [10n ** 12n, undefined, '0.000001'],
        [10n ** 12n + 1n, undefined, '0.000002'],
        [999999999999n, undefined, '0.000001'],
        [999999999999999999n, undefined, '1.00'], // round-up carries into the integer part
        [1234567890123456789n, undefined, '1.234568'],
        [1250000000000000000n, undefined, '1.25'],
        [10n ** 17n, undefined, '0.10'],
        [1n, 2, '0.01'],
        [10n ** 16n, 2, '0.01'],
        [10n ** 16n + 1n, 2, '0.02'],
        [1234567890123456789n, 2, '1.24'],
        [1n, 18, '0.000000000000000001'],
        [1n, 0, '1.00'],
        [10n ** 18n, 0, '1.00'],
        [10n ** 18n + 1n, 0, '2.00'],
        ['0xde0b6b3a7640000', undefined, '1.00'], // hex string as returned by eth_getBalance
        ['1500000000000000', undefined, '0.0015']
      ];
      table.forEach(([input, d, expected]) => {
        it(String(input) + (d === undefined ? '' : ' @' + d + ' decimals') + ' -> ' + expected, function () {
          assert.equal(util.formatNativeUsdc(input, d), expected);
        });
      });

      it('never rounds down: the shown value is >= the real value and within one display unit', function () {
        const rng = makeRng(5);
        for (let i = 0; i < 300; i++) {
          const wei = randBigInt(rng, 1 + randInt(rng, 80));
          const shown = ethers.parseUnits(util.formatNativeUsdc(wei), 18);
          assert.ok(shown >= wei, String(wei));
          assert.ok(shown - wei < 10n ** 12n || wei === 0n, String(wei));
        }
      });
    });
  });

  // ------------------------------------------------------------------------------------------------- memo
  describe('memo', function () {
    const SALT0 = '0'.repeat(32);
    const SALT = '0123456789abcdef0123456789abcdef';

    describe('buildMemo', function () {
      it('produces exactly JSON.stringify({v,no,d,s}) with that key order and no whitespace', function () {
        const memo = util.buildMemo({ number: 'INV-1', description: 'Logo', salt: SALT0 });
        assert.equal(memo, '{"v":1,"no":"INV-1","d":"Logo","s":"00000000000000000000000000000000"}');
        assert.equal(memo, JSON.stringify({ v: 1, no: 'INV-1', d: 'Logo', s: SALT0 }));
        assert.doesNotMatch(memo, /\s/);
      });

      it('allows an empty / missing invoice number', function () {
        const expected = '{"v":1,"no":"","d":"Logo","s":"' + SALT + '"}';
        assert.equal(util.buildMemo({ number: '', description: 'Logo', salt: SALT }), expected);
        assert.equal(util.buildMemo({ description: 'Logo', salt: SALT }), expected);
        assert.equal(util.buildMemo({ number: null, description: 'Logo', salt: SALT }), expected);
        assert.equal(util.buildMemo({ number: undefined, description: 'Logo', salt: SALT }), expected);
      });

      it('converts a numeric invoice number to text', function () {
        assert.equal(JSON.parse(util.buildMemo({ number: 42, description: 'x', salt: SALT })).no, '42');
      });

      it('requires a description', function () {
        [undefined, null, ''].forEach((d) => {
          assert.throws(() => util.buildMemo({ number: 'A', description: d, salt: SALT }), /description is required/i);
        });
        assert.throws(() => util.buildMemo({ salt: SALT }), /description is required/i);
      });

      it('allows 140 code points in the description and rejects 141', function () {
        assert.doesNotThrow(() => util.buildMemo({ description: 'a'.repeat(140), salt: SALT }));
        assert.throws(() => util.buildMemo({ description: 'a'.repeat(141), salt: SALT }), /at most 140 characters/);
      });

      it('counts an emoji as one character (140 emoji ok, 141 rejected)', function () {
        const e = '\u{1F600}';
        assert.equal(e.length, 2);
        assert.doesNotThrow(() => util.buildMemo({ description: e.repeat(140), salt: SALT }));
        assert.throws(() => util.buildMemo({ description: e.repeat(141), salt: SALT }), /at most 140 characters/);
        // astral characters mixed with BMP ones
        assert.doesNotThrow(() => util.buildMemo({ description: ('a' + e).repeat(70), salt: SALT }));
        assert.throws(() => util.buildMemo({ description: ('a' + e).repeat(70) + 'b', salt: SALT }), /at most 140/);
      });

      it('allows 32 code points in the invoice number and rejects 33', function () {
        assert.doesNotThrow(() => util.buildMemo({ number: 'N'.repeat(32), description: 'x', salt: SALT }));
        assert.throws(() => util.buildMemo({ number: 'N'.repeat(33), description: 'x', salt: SALT }), /at most 32 characters/);
        assert.doesNotThrow(() => util.buildMemo({ number: '\u{1F600}'.repeat(32), description: 'x', salt: SALT }));
        assert.throws(() => util.buildMemo({ number: '\u{1F600}'.repeat(33), description: 'x', salt: SALT }), /at most 32/);
      });

      it('requires a salt of exactly 32 lowercase hex characters', function () {
        const bad = [undefined, null, '', '0'.repeat(31), '0'.repeat(33), 'A'.repeat(32), '0123456789ABCDEF0123456789abcdef', 'g'.repeat(32), '0x' + '0'.repeat(30), ' ' + '0'.repeat(31), 0, 5];
        bad.forEach((salt) => {
          assert.throws(() => util.buildMemo({ description: 'x', salt }), /salt must be 32 lowercase hex/, String(salt));
        });
        assert.doesNotThrow(() => util.buildMemo({ description: 'x', salt: 'abcdef0123456789abcdef0123456789' }));
      });

      it('escapes quotes, backslashes, control characters and keeps unicode; the result parses back losslessly', function () {
        const descriptions = [
          'He said "hi"', 'back\\slash', 'line1\nline2', 'tab\there', 'ctrl\u0001\u001f', 'caf\u00e9 \u65e5\u672c\u8a9e', '\u{1F600}\u{1F468}\u200d\u{1F469}', '</script><b>', "it's", '{"v":1}',
          'lone surrogate \ud800 here'
        ];
        descriptions.forEach((d) => {
          const memo = util.buildMemo({ number: 'N"1', description: d, salt: SALT });
          assert.equal(memo, JSON.stringify({ v: 1, no: 'N"1', d, s: SALT }));
          assert.deepEqual(util.parseMemo(memo), { v: 1, no: 'N"1', d, s: SALT });
        });
      });

      it('ignores unknown fields', function () {
        assert.equal(
          util.buildMemo({ number: 'A', description: 'x', salt: SALT, amount: '5', extra: true }),
          '{"v":1,"no":"A","d":"x","s":"' + SALT + '"}'
        );
      });
    });

    describe('randomSalt', function () {
      it('returns 32 lowercase hex characters built from the 16 bytes of an injected crypto', function () {
        const seen = [];
        const stub = {
          getRandomValues(arr) {
            seen.push(arr);
            for (let i = 0; i < arr.length; i++) arr[i] = (i * 17 + 0xa) & 255;
            // returns undefined on purpose: the module must read the filled array, not the return value
          }
        };
        const expected = Buffer.from(Array.from({ length: 16 }, (_, i) => (i * 17 + 0xa) & 255)).toString('hex');
        const salt = util.randomSalt(stub);
        assert.equal(salt, expected);
        assert.match(salt, /^[0-9a-f]{32}$/);
        assert.equal(seen.length, 1);
        assert.ok(seen[0] instanceof Uint8Array);
        assert.equal(seen[0].length, 16);
      });

      it('zero-pads every byte and lower-cases (0x00, 0x0a, 0xab, 0xff)', function () {
        const bytes = [0x00, 0x0a, 0xab, 0xff, 0x01, 0x10, 0xcd, 0xef, 0x00, 0x00, 0xff, 0xff, 0x7f, 0x80, 0x0f, 0xf0];
        const salt = util.randomSalt({ getRandomValues(arr) { bytes.forEach((b, i) => { arr[i] = b; }); } });
        assert.equal(salt, '000aabff0110cdef0000ffff7f800ff0');
      });

      it('an all-zero source still yields a valid salt', function () {
        assert.equal(util.randomSalt({ getRandomValues() {} }), '0'.repeat(32));
        assert.doesNotThrow(() => util.buildMemo({ description: 'x', salt: util.randomSalt({ getRandomValues() {} }) }));
      });

      it('uses the real globalThis.crypto by default; two calls differ', function () {
        const a = util.randomSalt();
        const b = util.randomSalt();
        assert.match(a, /^[0-9a-f]{32}$/);
        assert.match(b, /^[0-9a-f]{32}$/);
        assert.notEqual(a, b);
        const many = new Set(Array.from({ length: 50 }, () => util.randomSalt()));
        assert.equal(many.size, 50);
      });

      it('uses globalThis.crypto when none is injected, and prefers an injected one', function () {
        let globalCalls = 0;
        const globalStub = { getRandomValues(arr) { globalCalls++; arr.fill(0xab); } };
        withGlobalCrypto(globalStub, () => {
          assert.equal(util.randomSalt(), 'ab'.repeat(16));
          assert.equal(globalCalls, 1);
          assert.equal(util.randomSalt({ getRandomValues(arr) { arr.fill(0x01); } }), '01'.repeat(16));
          assert.equal(globalCalls, 1);
        });
      });

      it('throws a clear error when no secure random source exists', function () {
        withGlobalCrypto(undefined, () => {
          assert.throws(() => util.randomSalt(), /No secure random source is available/);
        });
        assert.throws(() => util.randomSalt({}), /No secure random source is available/);
        assert.throws(() => util.randomSalt({ getRandomValues: 'nope' }), /No secure random source is available/);
      });
    });

    describe('memoHash', function () {
      it('equals ethers.id(memo) (keccak-256 of the UTF-8 bytes)', function () {
        const memos = [
          util.buildMemo({ number: 'INV-1', description: 'Logo', salt: SALT0 }),
          util.buildMemo({ description: 'caf\u00e9 \u65e5\u672c\u8a9e \u{1F600}', salt: SALT }),
          '', 'a', 'abc', 'x'.repeat(135), 'x'.repeat(136), 'x'.repeat(137), 'x'.repeat(272), 'x'.repeat(1000)
        ];
        memos.forEach((m) => assert.equal(util.memoHash(m), ethers.id(m)));
        assert.equal(util.memoHash(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
        assert.equal(util.memoHash('abc'), keccak.keccak256('abc'));
      });

      it('is lowercase 0x + 64 hex and never the zero hash (the contract rejects a zero reference hash)', function () {
        const rng = makeRng(6);
        const zero = '0x' + '00'.repeat(32);
        for (let i = 0; i < 200; i++) {
          const memo = util.buildMemo({ number: 'N' + i, description: 'd' + randInt(rng, 1e9), salt: util.randomSalt({ getRandomValues(a) { for (let k = 0; k < 16; k++) a[k] = randInt(rng, 256); } }) });
          const h = util.memoHash(memo);
          assert.match(h, /^0x[0-9a-f]{64}$/);
          assert.notEqual(h, zero);
          assert.ok(abi.isHash32(h));
        }
        assert.notEqual(util.memoHash(''), zero);
      });

      it('different salts give different hashes for the same description (unguessable references)', function () {
        const a = util.buildMemo({ number: 'A', description: 'Same', salt: '1'.repeat(32) });
        const b = util.buildMemo({ number: 'A', description: 'Same', salt: '2'.repeat(32) });
        assert.notEqual(util.memoHash(a), util.memoHash(b));
      });
    });

    describe('verifyMemo', function () {
      const memo = util.buildMemo({ number: 'INV-9', description: 'Consulting', salt: SALT });
      const hash = util.memoHash(memo);

      it('is true for the matching memo and hash', function () {
        assert.equal(util.verifyMemo(memo, hash), true);
        assert.equal(util.verifyMemo(memo, ethers.id(memo)), true);
      });

      it('accepts the hash in any hex digit case', function () {
        assert.equal(util.verifyMemo(memo, '0x' + hash.slice(2).toUpperCase()), true);
        const mixed = '0x' + hash.slice(2).split('').map((c, i) => (i % 2 ? c.toUpperCase() : c)).join('');
        assert.equal(util.verifyMemo(memo, mixed), true);
      });

      it('is false for a tampered memo', function () {
        assert.equal(util.verifyMemo(memo.replace('Consulting', 'Consultinh'), hash), false);
        assert.equal(util.verifyMemo(memo + ' ', hash), false);
        assert.equal(util.verifyMemo(' ' + memo, hash), false);
        assert.equal(util.verifyMemo(memo.replace('INV-9', 'INV-8'), hash), false);
        assert.equal(util.verifyMemo('', hash), false);
        // same text, different unicode normalisation = different bytes
        const nfc = util.buildMemo({ description: 'caf\u00e9', salt: SALT });
        const nfd = util.buildMemo({ description: 'cafe\u0301', salt: SALT });
        assert.equal(util.verifyMemo(nfc, util.memoHash(nfd)), false);
      });

      it('is false for a different or invalid hash', function () {
        const bad = [
          '0x' + '00'.repeat(32), ethers.id('other'), '0x123', '', hash.slice(2), hash + '00', hash.slice(0, -1),
          '0x' + 'zz'.repeat(32), null, undefined, 123, {}, [hash]
        ];
        bad.forEach((h) => assert.equal(util.verifyMemo(memo, h), false, String(h)));
      });

      it('is false when the memo is not a string, even if the hash is that of its text', function () {
        [null, undefined, 123, {}, ['x'], true].forEach((m) => {
          assert.equal(util.verifyMemo(m, util.memoHash(String(m))), false, String(m));
        });
      });
    });

    describe('parseMemo', function () {
      it('round trips buildMemo output', function () {
        const f = { number: 'INV-1', description: 'Logo "v2" \u{1F600}', salt: SALT };
        assert.deepEqual(util.parseMemo(util.buildMemo(f)), { v: 1, no: 'INV-1', d: 'Logo "v2" \u{1F600}', s: SALT });
        assert.deepEqual(util.parseMemo(util.buildMemo({ description: 'x', salt: SALT })), { v: 1, no: '', d: 'x', s: SALT });
      });

      it('keeps only v, no, d, s', function () {
        const r = util.parseMemo('{"v":1,"no":"a","d":"b","s":"c","extra":1,"__proto__":{"x":1}}');
        assert.deepEqual(Object.keys(r), ['v', 'no', 'd', 's']);
        assert.deepEqual(r, { v: 1, no: 'a', d: 'b', s: 'c' });
      });

      it('returns null for garbage', function () {
        ['', ' ', 'not json', '{', '{"v":1', 'null', '123', '"text"', 'true', 'undefined', 'NaN', "{'v':1}"].forEach((t) => {
          assert.equal(util.parseMemo(t), null, JSON.stringify(t));
        });
      });

      it('returns null for arrays and other wrong shapes', function () {
        const bad = [
          '[]', '[1,2]', '["v",1]', '{}',
          '{"v":1}', '{"v":1,"no":"","d":"x"}', '{"v":1,"no":"","s":"y"}', '{"v":1,"d":"x","s":"y"}', '{"no":"","d":"x","s":"y"}',
          '{"v":2,"no":"","d":"x","s":"y"}', '{"v":"1","no":"","d":"x","s":"y"}', '{"v":0,"no":"","d":"x","s":"y"}', '{"v":null,"no":"","d":"x","s":"y"}', '{"v":1.5,"no":"","d":"x","s":"y"}',
          '{"v":1,"no":1,"d":"x","s":"y"}', '{"v":1,"no":"","d":null,"s":"y"}', '{"v":1,"no":"","d":"x","s":7}', '{"v":1,"no":[],"d":"x","s":"y"}'
        ];
        bad.forEach((t) => assert.equal(util.parseMemo(t), null, t));
      });

      it('returns null for non-strings', function () {
        [undefined, null, 5, {}, [], true, { v: 1, no: '', d: 'x', s: 'y' }].forEach((v) => assert.equal(util.parseMemo(v), null));
      });
    });

    describe('codePointLength', function () {
      it('counts Unicode code points, not UTF-16 units', function () {
        assert.equal(util.codePointLength(''), 0);
        assert.equal(util.codePointLength('abc'), 3);
        assert.equal(util.codePointLength('\u{1F600}'), 1);
        assert.equal(util.codePointLength('a\u{1F600}b'), 3);
        assert.equal(util.codePointLength('\u00e9'), 1);
        assert.equal(util.codePointLength('e\u0301'), 2);
        assert.equal(util.codePointLength(123), 3);
      });
    });
  });

  // ------------------------------------------------------------------------------------------------- links
  describe('links', function () {
    const DIR = 'https://example.org/app/';

    describe('pageDirectory', function () {
      const table = [
        ['https://host/a/b/c.html#x', 'https://host/a/b/'],
        ['https://host/a/b/c.html?x=1#y', 'https://host/a/b/'],
        ['https://host/a/b/c.html?next=/x/y', 'https://host/a/b/'],
        ['https://host/a/b/c.html#/x/y', 'https://host/a/b/'],
        ['http://localhost:8080', 'http://localhost:8080/'],
        ['http://localhost:8080/', 'http://localhost:8080/'],
        ['http://localhost:8080/index.html', 'http://localhost:8080/'],
        ['http://localhost:8080?x=1', 'http://localhost:8080/'],
        ['http://localhost:8080#frag', 'http://localhost:8080/'],
        ['file:///tmp/x/index.html', 'file:///tmp/x/'],
        ['file:///tmp/x/index.html?x=1#y', 'file:///tmp/x/'],
        ['file:///index.html', 'file:///'],
        ['file:///C:/Users/me/index.html', 'file:///C:/Users/me/'],
        ['https://user.github.io/repo/pay.html?z=1#frag', 'https://user.github.io/repo/'],
        ['https://host/dir/', 'https://host/dir/'],
        ['https://host/dir', 'https://host/'],
        ['https://host', 'https://host/'],
        ['https://user:pw@host:8443/a/b.html', 'https://user:pw@host:8443/a/'],
        ['HTTPS://Host/a/b.html', 'HTTPS://Host/a/'],
        ['http://[::1]:8080/a/b.html', 'http://[::1]:8080/a/'],
        ['about:blank', ''],
        ['data:text/html,hi', ''],
        ['javascript:alert(1)', ''],
        ['blob:https://example.com/uuid', ''],
        ['/a/b.html', ''],
        ['host/a/b.html', ''],
        ['', ''],
        [undefined, ''],
        [null, '']
      ];
      table.forEach(([input, expected]) => {
        it(JSON.stringify(input) + ' -> ' + JSON.stringify(expected), function () {
          assert.equal(util.pageDirectory(input), expected);
        });
      });
    });

    describe('buildPayLink', function () {
      const p = { net: 'arcTestnet', contract: CONTRACT, id: ID(1) };

      it('produces exactly <dir>pay.html#net=<net>&c=<contract>&id=<id>&memo=<encoded memo>', function () {
        const memo = util.buildMemo({ number: 'INV-1', description: 'Logo', salt: '0'.repeat(32) });
        const link = util.buildPayLink(DIR, Object.assign({ memo }, p));
        assert.equal(link, DIR + 'pay.html#net=arcTestnet&c=' + CONTRACT + '&id=' + ID(1) + '&memo=' + encodeURIComponent(memo));
        assert.equal(
          link,
          'https://example.org/app/pay.html#net=arcTestnet&c=' + CONTRACT + '&id=' + ID(1) +
          '&memo=%7B%22v%22%3A1%2C%22no%22%3A%22INV-1%22%2C%22d%22%3A%22Logo%22%2C%22s%22%3A%2200000000000000000000000000000000%22%7D'
        );
      });

      it('omits the memo when it is empty, null or undefined', function () {
        const base = DIR + 'pay.html#net=arcTestnet&c=' + CONTRACT + '&id=' + ID(1);
        assert.equal(util.buildPayLink(DIR, p), base);
        assert.equal(util.buildPayLink(DIR, Object.assign({ memo: '' }, p)), base);
        assert.equal(util.buildPayLink(DIR, Object.assign({ memo: null }, p)), base);
        assert.equal(util.buildPayLink(DIR, Object.assign({ memo: undefined }, p)), base);
      });

      it('omits other empty parts', function () {
        assert.equal(util.buildPayLink(DIR, { id: ID(2) }), DIR + 'pay.html#id=' + ID(2));
        assert.equal(util.buildPayLink(DIR, { net: '', contract: '', id: ID(2), memo: '' }), DIR + 'pay.html#id=' + ID(2));
      });

      it('uses the directory as given (file:// and localhost bases too)', function () {
        assert.equal(util.buildPayLink('file:///tmp/x/', p).startsWith('file:///tmp/x/pay.html#net='), true);
        assert.equal(util.buildPayLink('http://localhost:8080/', p).startsWith('http://localhost:8080/pay.html#net='), true);
        assert.equal(util.buildPayLink(util.pageDirectory('http://localhost:8080'), p).startsWith('http://localhost:8080/pay.html#'), true);
      });

      it('keeps the link on one line of printable ASCII even for hostile memo text', function () {
        const link = util.buildPayLink(DIR, Object.assign({ memo: 'a b\nc\r\n"d" <e> \u65e5\u672c \u{1F600} 100% & #1 = 2 + 3' }, p));
        assert.match(link, /^[\x21-\x7e]+$/);
        assert.equal((link.match(/#/g) || []).length, 1);
        assert.equal((link.match(/&/g) || []).length, 3);
      });
    });

    describe('parsePayFragment', function () {
      const goodFrag = (extra) => '#net=local&c=' + CONTRACT.toLowerCase() + '&id=' + ID(1) + (extra || '');

      it('parses a complete link and returns the contract checksummed and the id lowercased', function () {
        const upperId = '0x' + 'AB'.repeat(32);
        const r = util.parsePayFragment('#net=local&c=' + CONTRACT.toLowerCase() + '&id=' + upperId + '&memo=hello');
        assert.deepEqual(r, { net: 'local', contract: CONTRACT, id: '0x' + 'ab'.repeat(32), memo: 'hello', errors: [] });
        assert.equal(r.contract, ethers.getAddress(CONTRACT.toLowerCase()));
      });

      it('checksums an all-uppercase-digit address too', function () {
        const r = util.parsePayFragment('#id=' + ID(1) + '&c=0x' + CONTRACT.slice(2).toUpperCase());
        assert.equal(r.contract, CONTRACT);
        assert.deepEqual(r.errors, []);
      });

      it('works without the leading # and treats a missing net / contract / memo as null without error', function () {
        const r = util.parsePayFragment('id=' + ID(7));
        assert.deepEqual(r, { net: null, contract: null, id: ID(7), memo: null, errors: [] });
        const r2 = util.parsePayFragment('#id=' + ID(7) + '&c=&memo=');
        assert.deepEqual(r2, { net: null, contract: null, id: ID(7), memo: null, errors: [] });
      });

      it('round trips buildPayLink for memos with unicode, quotes, braces, + % & # = spaces, newlines and emoji', function () {
        const memos = [
          util.buildMemo({ number: 'INV-1', description: 'Logo', salt: '0'.repeat(32) }),
          util.buildMemo({ number: 'N"1', description: 'q"uote \'s\' {b} [r] + % & # = ? / : \\ \n \u{1F600}', salt: '0123456789abcdef0123456789abcdef' }),
          util.buildMemo({ description: 'lone \ud800 surrogate', salt: 'f'.repeat(32) }),
          'Za\u017c\u00f3\u0142\u0107 g\u0119\u015bl\u0105 \u2014 \u65e5\u672c\u8a9e \u0627\u0644\u0639\u0631\u0628\u064a\u0629',
          'quote " apostrophe \' backslash \\ braces { } brackets [ ]',
          'plus + percent % ampersand & hash # equals = question ? slash / colon :',
          'spaces   and\ttabs and\nnewlines\r\nand CRLF',
          '\u{1F600}\u{1F469}\u200d\u{1F469}\u200d\u{1F467}\u{1F1E8}\u{1F1ED} emoji',
          '%E0%A4%A literal percent sequence',
          '%41%42 looks already encoded',
          '+ + +',
          '=&=&#',
          '&memo=injected&id=0x00',
          '#fragment',
          'a'.repeat(4000)
        ];
        memos.forEach((memo) => {
          const link = util.buildPayLink(DIR, { net: 'arcTestnet', contract: CONTRACT, id: ID(3), memo });
          const r = util.parsePayFragment(link.slice(link.indexOf('#')));
          assert.deepEqual(r, { net: 'arcTestnet', contract: CONTRACT, id: ID(3), memo, errors: [] }, memo.slice(0, 40));
        });
      });

      it('keeps a literal + as + (percent-decoding only, no form decoding)', function () {
        assert.equal(util.parsePayFragment(goodFrag('&memo=a+b')).memo, 'a+b');
        assert.equal(util.parsePayFragment(goodFrag('&memo=a%2Bb')).memo, 'a+b');
        assert.equal(util.parsePayFragment(goodFrag('&memo=a%20b')).memo, 'a b');
      });

      it('largest memo that buildMemo can make (140 and 32 control characters) still fits in a link', function () {
        const memo = util.buildMemo({ number: '\u0001'.repeat(32), description: '\u0001'.repeat(140), salt: 'a'.repeat(32) });
        assert.ok(memo.length < 4000, 'memo length ' + memo.length);
        const link = util.buildPayLink(DIR, { net: 'arcTestnet', contract: CONTRACT, id: ID(1), memo });
        const r = util.parsePayFragment(link.slice(link.indexOf('#')));
        assert.deepEqual(r.errors, []);
        assert.equal(r.memo, memo);
      });

      it('accepts a 4000 character memo and rejects 4001', function () {
        const ok = util.parsePayFragment(goodFrag('&memo=' + 'a'.repeat(4000)));
        assert.equal(ok.memo.length, 4000);
        assert.deepEqual(ok.errors, []);
        const tooLong = util.parsePayFragment(goodFrag('&memo=' + 'a'.repeat(4001)));
        assert.equal(tooLong.memo, null);
        assert.equal(tooLong.errors.length, 1);
        assert.match(tooLong.errors[0], /description in the link is too long/);
      });

      it('reports a missing invoice id', function () {
        ['#net=local', '#net=local&id=', '#net=local&c=' + CONTRACT].forEach((frag) => {
          const r = util.parsePayFragment(frag);
          assert.equal(r.id, null);
          assert.deepEqual(r.errors, ['The link has no invoice id.']);
        });
      });

      it('reports a badly formed invoice id', function () {
        const bad = ['0x1234', '0x' + 'a'.repeat(63), '0x' + 'a'.repeat(65), 'ab'.repeat(32), '0x' + 'g'.repeat(64), '0X' + 'a'.repeat(64), '0x' + 'a'.repeat(32) + ' ' + 'a'.repeat(31), '12345'];
        bad.forEach((id) => {
          const r = util.parsePayFragment('#id=' + encodeURIComponent(id));
          assert.equal(r.id, null, id);
          assert.equal(r.errors.length, 1, id);
          assert.match(r.errors[0], /invoice id in the link is not valid/);
        });
      });

      it('reports a bad contract address', function () {
        const bad = ['0x123', '0x' + 'z'.repeat(40), CONTRACT.slice(2), CONTRACT + '0', '0x' + 'a'.repeat(39), 'null'];
        bad.forEach((c) => {
          const r = util.parsePayFragment('#id=' + ID(1) + '&c=' + encodeURIComponent(c));
          assert.equal(r.contract, null, c);
          assert.equal(r.id, ID(1));
          assert.deepEqual(r.errors, ['The contract address in the link is not valid.'], c);
        });
      });

      it('reports a bad network key (and accepts 1-32 chars of [A-Za-z0-9_-])', function () {
        ['local', 'arcTestnet', 'arc-testnet', 'arc_mainnet', 'x', 'A'.repeat(32), '0123'].forEach((net) => {
          const r = util.parsePayFragment('#net=' + net + '&id=' + ID(1));
          assert.equal(r.net, net);
          assert.deepEqual(r.errors, []);
        });
        ['a'.repeat(33), 'a b', 'a.b', 'a/b', 'a&b', '<script>', 'caf\u00e9', 'a=b', 'a#b'].forEach((net) => {
          const r = util.parsePayFragment('#net=' + encodeURIComponent(net) + '&id=' + ID(1));
          assert.equal(r.net, null, net);
          assert.deepEqual(r.errors, ['The network in the link is not valid.'], net);
        });
      });

      it('reports a badly encoded value (%E0%A4%A) and still reads the other parameters', function () {
        const r = util.parsePayFragment('#net=local&id=' + ID(1) + '&memo=%E0%A4%A');
        assert.equal(r.memo, null);
        assert.equal(r.id, ID(1));
        assert.equal(r.net, 'local');
        assert.equal(r.errors.length, 1);
        assert.match(r.errors[0], /badly encoded value \(memo\)/);
      });

      it('reports a badly encoded key, truncating long keys in the message', function () {
        const r = util.parsePayFragment('#%E0%A4%A=1&id=' + ID(1));
        assert.equal(r.errors.length, 1);
        assert.match(r.errors[0], /badly encoded value \(%E0%A4%A\)/);
        const long = util.parsePayFragment('#%E0%A4%A' + 'x'.repeat(50) + '=1&id=' + ID(1));
        assert.equal(long.errors.length, 1);
        assert.equal(long.errors[0], 'The link contains a badly encoded value (%E0%A4%Axxxx).'); // first 12 characters of the key
      });

      it('collects several errors at once', function () {
        const r = util.parsePayFragment('#net=bad%20net&c=0x12&id=0xzz&memo=%E0%A4%A');
        assert.equal(r.errors.length, 4);
        assert.deepEqual([r.net, r.contract, r.id, r.memo], [null, null, null, null]);
      });

      it('returns only an error for an empty fragment', function () {
        ['', '#', undefined, null].forEach((frag) => {
          assert.deepEqual(util.parsePayFragment(frag), { net: null, contract: null, id: null, memo: null, errors: ['The link has no invoice id.'] });
        });
      });

      it('ignores unknown parameters, empty parts and a repeated key (last wins)', function () {
        const r = util.parsePayFragment('#&&foo=bar&&id=' + ID(1) + '&id=' + ID(2) + '&');
        assert.equal(r.id, ID(2));
        assert.deepEqual(r.errors, []);
      });

      it('is prototype-pollution safe', function () {
        const before = Object.getOwnPropertyNames(Object.prototype).sort();
        const frags = [
          '#__proto__=x&constructor=y&id=' + ID(1),
          '#__proto__[polluted]=1&constructor[prototype][polluted]=1&id=' + ID(1),
          '#toString=1&hasOwnProperty=2&valueOf=3&id=' + ID(1) + '&net=local'
        ];
        frags.forEach((frag) => {
          const r = util.parsePayFragment(frag);
          assert.equal(r.id, ID(1));
          assert.deepEqual(r.errors, []);
        });
        assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), before);
        assert.equal({}.polluted, undefined);
        assert.equal({}.x, undefined);
        assert.equal({}.y, undefined);
        assert.equal(Object.prototype.polluted, undefined);
      });
    });

    describe('parseFragment', function () {
      it('splits on & and the first =, decodes with decodeURIComponent only', function () {
        const f = util.parseFragment('#a=b&c=d%20e&f=g=h&i&j=&%6B=v+w');
        assert.deepEqual(Object.entries(f.params), [['a', 'b'], ['c', 'd e'], ['f', 'g=h'], ['i', ''], ['j', ''], ['k', 'v+w']]);
        assert.deepEqual(f.errors, []);
      });

      it('the params object has no prototype, so inherited names are not keys', function () {
        const f = util.parseFragment('#__proto__=x&constructor=y');
        assert.equal(Object.getPrototypeOf(f.params), null);
        assert.deepEqual(Object.entries(f.params), [['__proto__', 'x'], ['constructor', 'y']]);
        assert.equal('toString' in f.params, false);
        assert.equal('hasOwnProperty' in f.params, false);
        assert.equal({}.x, undefined);
        assert.equal(Object.getPrototypeOf({}), Object.prototype);
        const empty = util.parseFragment('');
        assert.equal(Object.getPrototypeOf(empty.params), null);
        assert.equal('constructor' in empty.params, false);
      });

      it('handles missing input', function () {
        [undefined, null, '', '#', '#&&&'].forEach((h) => {
          const f = util.parseFragment(h);
          assert.deepEqual(Object.entries(f.params), []);
          assert.deepEqual(f.errors, []);
        });
      });

      it('a # inside a value is kept as data', function () {
        assert.deepEqual(Object.entries(util.parseFragment('#a=1#b=2').params), [['a', '1#b=2']]);
      });
    });

    describe('buildReceiptsLink / parseReceiptsFragment', function () {
      it('buildReceiptsLink with a payer', function () {
        assert.equal(
          util.buildReceiptsLink(DIR, { net: 'local', merchant: MERCHANT, payer: PAYER }),
          DIR + 'receipts.html#net=local&merchant=' + MERCHANT + '&payer=' + PAYER
        );
      });

      it('buildReceiptsLink without a payer (undefined, null or empty)', function () {
        const expected = DIR + 'receipts.html#net=local&merchant=' + MERCHANT;
        assert.equal(util.buildReceiptsLink(DIR, { net: 'local', merchant: MERCHANT }), expected);
        assert.equal(util.buildReceiptsLink(DIR, { net: 'local', merchant: MERCHANT, payer: null }), expected);
        assert.equal(util.buildReceiptsLink(DIR, { net: 'local', merchant: MERCHANT, payer: '' }), expected);
      });

      it('buildReceiptsLink percent-encodes its values', function () {
        assert.equal(util.buildReceiptsLink(DIR, { net: 'a b&c', merchant: MERCHANT }), DIR + 'receipts.html#net=a%20b%26c&merchant=' + MERCHANT);
      });

      it('parseReceiptsFragment returns checksummed addresses', function () {
        const r = util.parseReceiptsFragment('#net=local&merchant=' + MERCHANT.toLowerCase() + '&payer=' + PAYER.toLowerCase());
        assert.deepEqual(r, { net: 'local', merchant: MERCHANT, payer: PAYER, errors: [] });
      });

      it('parseReceiptsFragment without a payer / without anything', function () {
        assert.deepEqual(util.parseReceiptsFragment('#net=local&merchant=' + MERCHANT), { net: 'local', merchant: MERCHANT, payer: null, errors: [] });
        assert.deepEqual(util.parseReceiptsFragment('#merchant=' + MERCHANT + '&payer='), { net: null, merchant: MERCHANT, payer: null, errors: [] });
        assert.deepEqual(util.parseReceiptsFragment(''), { net: null, merchant: null, payer: null, errors: [] });
        assert.deepEqual(util.parseReceiptsFragment(undefined), { net: null, merchant: null, payer: null, errors: [] });
      });

      it('parseReceiptsFragment reports invalid values', function () {
        const r = util.parseReceiptsFragment('#net=bad%20net&merchant=0x12&payer=nope');
        assert.deepEqual(r.errors, [
          'The network in the link is not valid.',
          'The merchant address in the link is not valid.',
          'The payer address in the link is not valid.'
        ]);
        assert.deepEqual([r.net, r.merchant, r.payer], [null, null, null]);
        assert.deepEqual(util.parseReceiptsFragment('#merchant=%E0%A4%A').errors.length, 1);
      });

      it('round trips buildReceiptsLink', function () {
        [{ net: 'arcTestnet', merchant: MERCHANT, payer: PAYER }, { net: 'local', merchant: PAYER2 }].forEach((p) => {
          const link = util.buildReceiptsLink(DIR, p);
          const r = util.parseReceiptsFragment(link.slice(link.indexOf('#')));
          assert.deepEqual(r, { net: p.net, merchant: p.merchant, payer: p.payer || null, errors: [] });
        });
      });

      it('is prototype-pollution safe', function () {
        const before = Object.getOwnPropertyNames(Object.prototype).sort();
        const r = util.parseReceiptsFragment('#__proto__=x&constructor=y&merchant=' + MERCHANT);
        assert.equal(r.merchant, MERCHANT);
        assert.deepEqual(r.errors, []);
        assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), before);
        assert.equal({}.x, undefined);
      });
    });

    describe('addressTopic', function () {
      it('left-pads the address to 32 bytes in lowercase', function () {
        assert.equal(util.addressTopic(MERCHANT), '0x000000000000000000000000' + MERCHANT.slice(2).toLowerCase());
        assert.equal(util.addressTopic(MERCHANT), ethers.zeroPadValue(MERCHANT.toLowerCase(), 32));
      });
    });
  });

  // ------------------------------------------------------------------------------------------------- time
  describe('time', function () {
    describe('toIsoUtc / formatUtc', function () {
      const table = [
        [0, '1970-01-01T00:00:00Z', '1970-01-01 00:00:00 UTC'],
        [1790000000, '2026-09-21T14:13:20Z', '2026-09-21 14:13:20 UTC'],
        [951782400, '2000-02-29T00:00:00Z', '2000-02-29 00:00:00 UTC'],
        [86399, '1970-01-01T23:59:59Z', '1970-01-01 23:59:59 UTC'],
        [-1, '1969-12-31T23:59:59Z', '1969-12-31 23:59:59 UTC'],
        [1790086400, '2026-09-22T14:13:20Z', '2026-09-22 14:13:20 UTC'],
        [1767225599, '2025-12-31T23:59:59Z', '2025-12-31 23:59:59 UTC'],
        [1767225600, '2026-01-01T00:00:00Z', '2026-01-01 00:00:00 UTC']
      ];
      table.forEach(([ts, iso, human]) => {
        it(ts + ' -> ' + iso, function () {
          assert.equal(util.toIsoUtc(ts), iso);
          assert.equal(util.formatUtc(ts), human);
        });
      });

      it('accepts numeric strings and BigInt seconds, and has no fractional part or offset', function () {
        assert.equal(util.toIsoUtc('1790000000'), '2026-09-21T14:13:20Z');
        assert.equal(util.toIsoUtc(1790000000n), '2026-09-21T14:13:20Z');
        assert.equal(util.toIsoUtc(1790000000.9), '2026-09-21T14:13:20Z');
        assert.match(util.toIsoUtc(1790000000), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      });

      it('agrees with an independent getUTC*-based formatter for random timestamps', function () {
        const rng = makeRng(7);
        for (let i = 0; i < 200; i++) {
          const ts = randInt(rng, 4102444800);
          const d = new Date(ts * 1000);
          const pad = (n, w) => String(n).padStart(w || 2, '0');
          const expected = pad(d.getUTCFullYear(), 4) + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + 'Z';
          assert.equal(util.toIsoUtc(ts), expected);
        }
      });

      it('is independent of the process time zone', function () {
        ['UTC', 'America/New_York', 'Asia/Kolkata', 'Pacific/Auckland'].forEach((zone) => {
          const prev = process.env.TZ;
          const had = Object.prototype.hasOwnProperty.call(process.env, 'TZ');
          process.env.TZ = zone;
          try {
            assert.equal(util.toIsoUtc(1790000000), '2026-09-21T14:13:20Z');
            assert.equal(util.formatUtc(1790000000), '2026-09-21 14:13:20 UTC');
            assert.equal(util.dateStamp(new Date(Date.UTC(2026, 9, 4, 23, 59, 59))), '2026-10-04');
          } finally {
            if (had) process.env.TZ = prev; else delete process.env.TZ;
          }
        });
      });
    });

    describe('formatLocal', function () {
      it('renders in the given locale and contains the year', function () {
        const us = util.formatLocal(1790000000, 'en-US');
        const de = util.formatLocal(1790000000, 'de-DE');
        assert.equal(typeof us, 'string');
        assert.match(us, /2026/);
        assert.match(de, /2026/);
        assert.notEqual(us, de);
      });

      it('falls back to the UTC text when the locale is malformed', function () {
        assert.equal(util.formatLocal(1790000000, 'not a locale!!'), '2026-09-21 14:13:20 UTC');
      });

      it('works without a locale argument', function () {
        assert.match(util.formatLocal(1790000000), /2026/);
      });
    });

    describe('dateStamp', function () {
      it('formats YYYY-MM-DD from the UTC date, zero padded', function () {
        assert.equal(util.dateStamp(new Date(Date.UTC(2026, 0, 5, 23, 59, 59))), '2026-01-05');
        assert.equal(util.dateStamp(new Date(Date.UTC(2026, 11, 31, 23, 59, 59))), '2026-12-31');
        assert.equal(util.dateStamp(new Date(Date.UTC(2026, 11, 31, 23, 59, 59) + 1000)), '2027-01-01');
        assert.equal(util.dateStamp(new Date(Date.UTC(2024, 1, 29))), '2024-02-29');
        assert.equal(util.dateStamp(new Date(Date.UTC(2026, 9, 4, 12))), '2026-10-04');
      });

      it('accepts a ms number or an ISO string as well', function () {
        assert.equal(util.dateStamp(0), '1970-01-01');
        assert.equal(util.dateStamp(Date.UTC(2026, 11, 31, 23, 59, 59) + 1000), '2027-01-01');
        assert.equal(util.dateStamp('2024-02-29T00:00:00Z'), '2024-02-29');
        assert.equal(util.dateStamp('2026-10-05T04:30:00Z'), '2026-10-05');
      });

      it('uses UTC whatever the local zone is (an instant that is still 4 Oct in New York is 5 Oct UTC)', function () {
        const ok = withTimezone('America/New_York', 240, () => {
          assert.equal(util.dateStamp(new Date('2026-10-04T23:30:00-04:00')), '2026-10-05');
          assert.equal(util.dateStamp(new Date('2026-10-05T00:30:00+14:00')), '2026-10-04');
        });
        if (!ok) this.skip();
      });
    });

    describe('relativeTime', function () {
      const NOW = 1000000000;
      const D = 86400;
      const table = [
        [0, 'just now'],
        [1, 'in a few seconds'],
        [-1, 'just now'],
        [44, 'in a few seconds'],
        [-44, 'just now'],
        [59, 'in a few seconds'],
        [-59, 'just now'],
        [60, 'in 1 minute'],
        [-60, '1 minute ago'],
        [119, 'in 1 minute'],
        [-119, '1 minute ago'],
        [120, 'in 2 minutes'],
        [-300, '5 minutes ago'],
        [3599, 'in 59 minutes'],
        [-3599, '59 minutes ago'],
        [3600, 'in 1 hour'],
        [-3600, '1 hour ago'],
        [7200, 'in 2 hours'],
        [-7200, '2 hours ago'],
        [86399, 'in 23 hours'],
        [-86399, '23 hours ago'],
        [D, 'in 1 day'],
        [-D, '1 day ago'],
        [3 * D, 'in 3 days'],
        [-2 * D, '2 days ago'],
        [29 * D, 'in 29 days'],
        [-29 * D, '29 days ago'],
        [30 * D, 'in 1 month'],
        [-30 * D, '1 month ago'],
        [59 * D, 'in 1 month'],
        [60 * D, 'in 2 months'],
        [-90 * D, '3 months ago'],
        [364 * D, 'in 12 months'],
        [365 * D, 'in 1 year'],
        [-365 * D, '1 year ago'],
        [729 * D, 'in 1 year'],
        [730 * D, 'in 2 years'],
        [-1095 * D, '3 years ago']
      ];
      table.forEach(([delta, expected]) => {
        it('now ' + (delta >= 0 ? '+' : '') + delta + 's -> ' + expected, function () {
          assert.equal(util.relativeTime(NOW + delta, NOW), expected);
        });
      });

      it('accepts numeric strings', function () {
        assert.equal(util.relativeTime('1000000100', '1000000000'), 'in 1 minute');
      });

      it('uses singular for exactly 1 and plural otherwise', function () {
        assert.match(util.relativeTime(NOW + 3600, NOW), /\b1 hour$/);
        assert.match(util.relativeTime(NOW + 7200, NOW), /\b2 hours$/);
        assert.match(util.relativeTime(NOW - D, NOW), /^1 day ago$/);
        assert.match(util.relativeTime(NOW - 2 * D, NOW), /^2 days ago$/);
      });
    });

    describe('parseLocalDateTime / toLocalDateTimeValue (process-local time zone)', function () {
      it('round trips for the local zone, whatever it is', function () {
        const values = ['2026-06-15T12:34', '2026-01-15T00:00', '2026-12-31T23:59', '2027-02-28T08:05', '2026-07-04T23:59'];
        values.forEach((v) => {
          const ts = util.parseLocalDateTime(v);
          assert.equal(typeof ts, 'number');
          assert.ok(Number.isInteger(ts));
          assert.equal(util.toLocalDateTimeValue(ts), v);
        });
        const rng = makeRng(8);
        for (let i = 0; i < 100; i++) {
          // multiples of 60 s between May and September 2026: no DST change in the zones tested elsewhere
          const ts = 1777593600 + 60 * randInt(rng, 60 * 24 * 120);
          assert.equal(util.parseLocalDateTime(util.toLocalDateTimeValue(ts)), ts);
        }
      });

      it('toLocalDateTimeValue has the datetime-local shape and drops seconds', function () {
        const ts = util.parseLocalDateTime('2026-06-15T12:34');
        assert.match(util.toLocalDateTimeValue(ts), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
        assert.equal(util.toLocalDateTimeValue(ts + 59), '2026-06-15T12:34');
        assert.equal(util.toLocalDateTimeValue(ts + 60), '2026-06-15T12:35');
        assert.equal(util.toLocalDateTimeValue(String(ts)), '2026-06-15T12:34');
      });

      it('seconds are optional in the input and honoured when given', function () {
        const base = util.parseLocalDateTime('2026-06-15T12:34');
        assert.equal(util.parseLocalDateTime('2026-06-15T12:34:00'), base);
        assert.equal(util.parseLocalDateTime('2026-06-15T12:34:56'), base + 56);
      });

      it('accepts the boundaries of a day and a leap day', function () {
        ['2026-06-15T00:00', '2026-06-15T23:59', '2026-06-15T23:59:59', '2028-02-29T10:00', '2000-02-29T00:00', '2026-12-31T23:59', '2026-01-01T00:00'].forEach((v) => {
          assert.equal(typeof util.parseLocalDateTime(v), 'number', v);
        });
      });

      it('returns null for strings that are not in the datetime-local format', function () {
        const bad = [
          '', null, undefined, 0, 'abc', '2026-06-15', '2026-06-15T12', '2026-06-15 12:34', '2026-06-15T12:34:5', '26-06-15T12:34',
          '2026-6-15T12:34', '2026-06-15T1:34', '2026-06-15T12:34Z', '2026-06-15T12:34+02:00', '2026-06-15T12:34:56.789', ' 2026-06-15T12:34',
          '2026-06-15T12:34 ', 'T12:34', '2026-06-15T12:34:56:78', '2026/06/15T12:34', '\uff12026-06-15T12:34'
        ];
        bad.forEach((v) => assert.equal(util.parseLocalDateTime(v), null, String(v)));
      });

      it('returns null for dates that do not exist (2026-02-30, month 13, day 00, Feb 29 in a non-leap year...)', function () {
        ['2026-02-30T10:00', '2026-02-29T10:00', '2100-02-29T10:00', '2026-04-31T10:00', '2026-13-01T10:00', '2026-00-10T10:00', '2026-06-00T10:00', '2026-06-31T10:00', '2026-02-31T10:00', '2026-12-32T10:00'].forEach((v) => {
          assert.equal(util.parseLocalDateTime(v), null, v);
        });
      });

      it('BUG: returns null for an hour, minute or second out of range instead of rolling over to another time', function () {
        // new Date(2026, 5, 15, 25, 61) is silently normalised to 16 June 02:01; the module only compares the month,
        // so the overflow is accepted unless it happens to cross a month boundary.
        const accepted = ['2026-06-15T24:00', '2026-06-15T25:00', '2026-06-15T12:60', '2026-06-15T12:34:60', '2026-06-15T99:99', '2026-06-15T23:59:99']
          .filter((v) => util.parseLocalDateTime(v) !== null);
        assert.deepEqual(accepted, []);
      });

      const zones = [
        // zone, June 2026 getTimezoneOffset(), expected UTC instant of local 2026-06-15T12:34 and 2026-01-15T12:34
        ['UTC', 0, Date.UTC(2026, 5, 15, 12, 34), Date.UTC(2026, 0, 15, 12, 34)],
        ['America/New_York', 240, Date.UTC(2026, 5, 15, 16, 34), Date.UTC(2026, 0, 15, 17, 34)],
        ['Europe/Berlin', -120, Date.UTC(2026, 5, 15, 10, 34), Date.UTC(2026, 0, 15, 11, 34)],
        ['Asia/Kolkata', -330, Date.UTC(2026, 5, 15, 7, 4), Date.UTC(2026, 0, 15, 7, 4)],
        ['Pacific/Auckland', -720, Date.UTC(2026, 5, 15, 0, 34), Date.UTC(2026, 0, 14, 23, 34)]
      ];
      zones.forEach(([zone, offset, june, jan]) => {
        it('is correct in ' + zone + ' (literal UTC instants, round trip, seconds)', function () {
          const ran = withTimezone(zone, offset, () => {
            assert.equal(util.parseLocalDateTime('2026-06-15T12:34'), june / 1000);
            assert.equal(util.parseLocalDateTime('2026-01-15T12:34'), jan / 1000);
            assert.equal(util.parseLocalDateTime('2026-06-15T12:34:56'), june / 1000 + 56);
            assert.equal(util.toLocalDateTimeValue(june / 1000), '2026-06-15T12:34');
            assert.equal(util.toLocalDateTimeValue(jan / 1000 + 59), '2026-01-15T12:34');
            assert.equal(util.parseLocalDateTime('2026-02-30T10:00'), null);
            assert.equal(util.parseLocalDateTime('2026-13-01T10:00'), null);
            const rng = makeRng(9);
            for (let i = 0; i < 60; i++) {
              const ts = 1777593600 + 60 * randInt(rng, 60 * 24 * 120);
              assert.equal(util.parseLocalDateTime(util.toLocalDateTimeValue(ts)), ts);
            }
          });
          if (!ran) this.skip();
        });
      });

      it('local conversions differ between zones while UTC formatting does not', function () {
        const ts = 1790000000;
        const seen = {};
        const ok = [['UTC', 0], ['Asia/Kolkata', -330]].every(([zone, offset]) => withTimezone(zone, offset, () => {
          seen[zone] = util.toLocalDateTimeValue(ts);
        }));
        if (!ok) return this.skip();
        assert.equal(seen.UTC, '2026-09-21T14:13');
        assert.equal(seen['Asia/Kolkata'], '2026-09-21T19:43');
      });
    });
  });

  // ------------------------------------------------------------------------------------------------- CSV
  describe('CSV', function () {
    describe('csvField', function () {
      const table = [
        ['plain', 'abc', 'abc'],
        ['comma', 'a,b', '"a,b"'],
        ['quote', 'say "hi"', '"say ""hi"""'],
        ['only a quote', '"', '""""'],
        ['CR', 'a\rb', '"a\rb"'],
        ['LF', 'a\nb', '"a\nb"'],
        ['CRLF', 'a\r\nb', '"a\r\nb"'],
        ['leading LF is quoted but not prefixed', '\nx', '"\nx"'],
        ['empty string', '', ''],
        ['null', null, ''],
        ['undefined', undefined, ''],
        ['space only', ' ', ' '],
        ['unicode', 'caf\u00e9 \u65e5\u672c\u8a9e \u{1F600}', 'caf\u00e9 \u65e5\u672c\u8a9e \u{1F600}'],
        ['leading apostrophe stays', "'abc", "'abc"],
        ['number', 5, '5'],
        ['zero', 0, '0'],
        ['float', 1.5, '1.5'],
        ['negative number is NOT prefixed', -5, '-5'],
        ['negative float is NOT prefixed', -0.25, '-0.25'],
        ['BigInt', 1250000n, '1250000'],
        ['negative BigInt is NOT prefixed', -1250000n, '-1250000'],
        ['huge BigInt', 2n ** 96n, String(2n ** 96n)],
        ['boolean', true, 'true'],
        ['= is neutralised', '=1+1', "'=1+1"],
        ['+ is neutralised', '+1', "'+1"],
        ['- is neutralised (a text cell, unlike a number)', '-1', "'-1"],
        ['@ is neutralised', '@SUM(A1)', "'@SUM(A1)"],
        ['TAB is neutralised', '\tx', "'\tx"],
        ['CR is neutralised AND quoted', '\rx', '"\'\rx"'],
        ['lone =', '=', "'="],
        ['formula with comma and quotes: prefixed then quoted', '=HYPERLINK("x","y"),z', '"\'=HYPERLINK(""x"",""y""),z"'],
        ['leading + with comma', '+1,5', '"\'+1,5"'],
        ['dangerous char later in the text is untouched', 'a=1', 'a=1'],
        ['plus later', 'a+b', 'a+b'],
        ['minus later', 'a-b', 'a-b'],
        ['at later', 'a@b.c', 'a@b.c'],
        ['tab later', 'x\ty', 'x\ty'],
        ['space then = is guarded too', ' =1+1', "' =1+1"],
        ['zero-width space then = is guarded', '\u200b=1+1', "'\u200b=1+1"],
        ['right-to-left override then + is guarded', '\u202e+1', "'\u202e+1"],
        ['BOM then @ is guarded', '\ufeff@SUM(A1)', "'\ufeff@SUM(A1)"],
        ['spaces then text is untouched', '  hello =', '  hello ='],
        ['zero-width space then text is untouched', '\u200bhello', '\u200bhello'],
        ['digits', '0123', '0123']
      ];
      table.forEach(([name, input, expected]) => {
        it(name + ': ' + JSON.stringify(typeof input === 'bigint' ? String(input) : input) + ' -> ' + JSON.stringify(expected), function () {
          assert.equal(util.csvField(input), expected);
        });
      });

      it('the quoted-and-prefixed CR case is exactly "\\"\'\\rx\\""', function () {
        assert.equal(util.csvField('\rx'), '"\'' + '\r' + 'x"');
      });
    });

    describe('csvRow', function () {
      it('joins escaped fields with commas', function () {
        assert.equal(util.csvRow(['a', 'b,c', 1, null, undefined, 2n, '=x', 'say "hi"']), 'a,"b,c",1,,,2,\'=x,"say ""hi"""');
        assert.equal(util.csvRow([]), '');
        assert.equal(util.csvRow(['']), '');
        assert.equal(util.csvRow(['', '']), ',');
      });
    });

    describe('buildCsv', function () {
      it('starts with the U+FEFF BOM, then the header, rows separated by CRLF and a CRLF after the last row', function () {
        const csv = util.buildCsv(['a', 'b'], [['1', '2'], ['3', '4']]);
        assert.equal(csv, '\uFEFFa,b\r\n1,2\r\n3,4\r\n');
        assert.equal(csv.charCodeAt(0), 0xfeff);
        assert.equal(csv.slice(1, 4), 'a,b');
      });

      it('with no rows it is the BOM, the header and one CRLF', function () {
        assert.equal(util.buildCsv(['a', 'b'], []), '\uFEFFa,b\r\n');
      });

      it('uses CRLF only: no bare LF outside quoted fields, only one BOM', function () {
        const csv = util.buildCsv(['h1', 'h2'], [['x', 'y'], ['z', 'w']]);
        assert.equal(/(^|[^\r])\n/.test(csv), false);
        assert.equal(csv.split('\r\n').length, 4);
        assert.equal(csv.split('\uFEFF').length, 2);
      });

      it('its UTF-8 bytes start with EF BB BF and unicode is preserved byte for byte', function () {
        const text = 'caf\u00e9 \u65e5\u672c\u8a9e \u{1F600}';
        const csv = util.buildCsv(['name'], [[text]]);
        const bytes = Buffer.from(csv, 'utf8');
        assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
        assert.equal(bytes.toString('utf8').slice(1), 'name\r\n' + text + '\r\n');
        assert.equal(parseCsv(bytes.toString('utf8'))[1][0], text);
      });

      it('round trips through a strict RFC 4180 parser (embedded newlines, quotes, commas, formula guards)', function () {
        const header = ['id', 'text', 'n', 'note'];
        const rows = [
          ['1', 'plain', 5, 'x'],
          ['2', 'with, comma', -7, 'say "hi"'],
          ['3', 'line1\nline2', 0n, 'cr\rlf\r\ncrlf'],
          ['4', '=1+1', 12345678901234567890n, '@cmd'],
          ['5', '\tTAB', null, undefined],
          ['6', '\rCR first', '', '+1,000'],
          ['7', '-5', -5, "'quoted"],
          ['8', '"', '""', ',,,'],
          ['9', 'caf\u00e9 \u{1F600}', 1.5, '\u65e5\u672c\u8a9e'],
          ['10', ' ', ' =x', '\n']
        ];
        const parsed = parseCsv(util.buildCsv(header, rows));
        assert.equal(parsed.length, rows.length + 1);
        assert.deepEqual(parsed[0], header);
        rows.forEach((row, i) => {
          assert.deepEqual(parsed[i + 1], row.map(expectedCell), 'row ' + (i + 1));
        });
        assert.equal(parsed[2][2], '-7'); // numbers keep their sign
        assert.equal(parsed[7][1], "'-5"); // a text cell does not
        assert.equal(parsed[7][2], '-5');
      });

      it('fuzz: any mix of hostile strings survives a strict parse and no text cell can start a formula', function () {
        const rng = makeRng(10);
        const alphabet = ['a', 'Z', '0', ' ', ',', '"', '\r', '\n', '\t', '=', '+', '-', '@', "'", '\u00e9', '\u65e5', '\u{1F600}', ';', '\\', '|', '\r\n'];
        const cell = () => {
          const t = rng();
          if (t < 0.05) return null;
          if (t < 0.1) return undefined;
          if (t < 0.15) return '';
          let s = '';
          for (let i = 1 + randInt(rng, 8); i > 0; i--) s += pick(rng, alphabet);
          return s;
        };
        const rows = Array.from({ length: 300 }, () => [cell(), cell(), cell(), cell(), cell()]);
        const csv = util.buildCsv(['c1', 'c2', 'c3', 'c4', 'c5'], rows);
        const parsed = parseCsv(csv);
        assert.equal(parsed.length, rows.length + 1);
        rows.forEach((row, i) => {
          assert.deepEqual(parsed[i + 1], row.map(expectedCell));
          parsed[i + 1].forEach((c) => assert.doesNotMatch(c, /^[=+\-@\t\r]/));
        });
      });

      it('the strict test parser itself rejects malformed CSV (sanity check of the helper)', function () {
        assert.throws(() => parseCsv('a,b\nc,d\r\n'), /bare line break/);
        assert.throws(() => parseCsv('a,"b\r\n'), /unterminated/);
        assert.throws(() => parseCsv('a,b"c\r\n'), /stray quote/);
        assert.deepEqual(parseCsv('\uFEFFa,"b\r\nc",""""\r\n'), [['a', 'b\r\nc', '"']]);
      });
    });

    describe('CSV_COLUMNS', function () {
      it('is exactly the 16 documented columns in order', function () {
        assert.deepEqual(util.CSV_COLUMNS, [
          'network', 'contract', 'invoice_id', 'reference_hash', 'invoice_number', 'description', 'amount_usdc', 'status',
          'created_utc', 'due_utc', 'paid_utc', 'merchant', 'payer', 'register_tx', 'payment_tx', 'cancel_tx'
        ]);
      });
    });
  });

  // ------------------------------------------------------------------------------------------------- events
  describe('events', function () {
    describe('compareEvents', function () {
      it('orders by blockNumber, then logIndex', function () {
        const sign = (a, b) => Math.sign(util.compareEvents(a, b));
        assert.equal(sign({ blockNumber: 1, logIndex: 5 }, { blockNumber: 2, logIndex: 0 }), -1);
        assert.equal(sign({ blockNumber: 2, logIndex: 0 }, { blockNumber: 1, logIndex: 5 }), 1);
        assert.equal(sign({ blockNumber: 2, logIndex: 1 }, { blockNumber: 2, logIndex: 3 }), -1);
        assert.equal(sign({ blockNumber: 2, logIndex: 3 }, { blockNumber: 2, logIndex: 1 }), 1);
        assert.equal(sign({ blockNumber: 2, logIndex: 3 }, { blockNumber: 2, logIndex: 3 }), 0);
        assert.equal(sign({ blockNumber: 1000000, logIndex: 0 }, { blockNumber: 999999, logIndex: 999 }), 1);
      });

      it('ignores timestamps entirely (equal and decreasing timestamps do not change the order)', function () {
        const a = registered({ id: ID(1), blockNumber: 10, logIndex: 0, createdAt: 5000 });
        const b = registered({ id: ID(2), blockNumber: 11, logIndex: 0, createdAt: 4000, txHash: TX(9) }); // later block, EARLIER time
        assert.ok(util.compareEvents(a, b) < 0);
        assert.deepEqual(util.mergeEvents([b], [a]), [a, b]);
        const c = registered({ id: ID(3), blockNumber: 11, logIndex: 1, createdAt: 4000, txHash: TX(10) }); // same time as b
        const d = registered({ id: ID(4), blockNumber: 11, logIndex: 2, createdAt: 4000, txHash: TX(11) });
        assert.deepEqual(util.mergeEvents([d, c, b, a], []), [a, b, c, d]);
      });

      it('can be used directly with Array.prototype.sort', function () {
        const rng = makeRng(11);
        const events = Array.from({ length: 40 }, (_, i) => registered({ id: ID(i), blockNumber: randInt(rng, 5), logIndex: randInt(rng, 5), txHash: TX(i) }));
        const sorted = events.slice().sort(util.compareEvents);
        for (let i = 1; i < sorted.length; i++) assert.ok(util.compareEvents(sorted[i - 1], sorted[i]) <= 0);
      });
    });

    describe('mergeEvents', function () {
      const e1 = registered({ blockNumber: 10, logIndex: 2, txHash: TX(1) });
      const e2 = paid({ blockNumber: 12, logIndex: 0, txHash: TX(2) });
      const e3 = cancelled({ id: ID(2), blockNumber: 11, logIndex: 5, txHash: TX(3) });

      it('sorts by (blockNumber, logIndex)', function () {
        assert.deepEqual(util.mergeEvents([e2], [e3, e1]), [e1, e3, e2]);
        assert.deepEqual(util.mergeEvents([], []), []);
        assert.deepEqual(util.mergeEvents([e1], []), [e1]);
        assert.deepEqual(util.mergeEvents([], [e1]), [e1]);
      });

      it('de-duplicates identical events within and across the two lists (first one wins)', function () {
        const copy = Object.assign({}, e1);
        const merged = util.mergeEvents([e2, e1], [e3, copy, e1, e2]);
        assert.deepEqual(merged, [e1, e3, e2]);
        assert.equal(merged[0], e1);
        assert.equal(merged.length, 3);
      });

      it('de-duplicates across two successive merges (cache + fresh scan)', function () {
        const first = util.mergeEvents([e1], [e2]);
        const second = util.mergeEvents(first, [e2, e3]);
        assert.deepEqual(second, [e1, e3, e2]);
        assert.deepEqual(util.mergeEvents(second, second), second);
        assert.deepEqual(util.mergeEvents(util.mergeEvents(second, [e1]), [e3]), second);
      });

      it('keeps events that share (block, logIndex) but come from different transactions, in insertion order', function () {
        const x = registered({ id: ID(5), blockNumber: 20, logIndex: 0, txHash: TX(20) });
        const y = registered({ id: ID(6), blockNumber: 20, logIndex: 0, txHash: TX(21) });
        assert.deepEqual(util.mergeEvents([x], [y]), [x, y]);
        assert.deepEqual(util.mergeEvents([y], [x]), [y, x]);
      });

      it('treats different logIndex or block with the same tx hash as different events', function () {
        const a = registered({ blockNumber: 10, logIndex: 0, txHash: TX(1) });
        const b = registered({ blockNumber: 10, logIndex: 1, txHash: TX(1) });
        const c = registered({ blockNumber: 11, logIndex: 0, txHash: TX(1) });
        assert.equal(util.mergeEvents([a, b], [c]).length, 3);
      });

      it('does not mutate its inputs', function () {
        const a = [e2, e1];
        const b = [e3, e1];
        util.mergeEvents(a, b);
        assert.deepEqual(a, [e2, e1]);
        assert.deepEqual(b, [e3, e1]);
      });
    });

    describe('foldEvents', function () {
      const R = () => registered();
      const P = () => paid();
      const C = () => cancelled();

      it('Registered -> open', function () {
        assert.deepEqual(util.foldEvents([R()]), [{
          id: ID(1), merchant: MERCHANT, referenceHash: REF(1), amount: 1250000n, due: 1790086400, createdAt: 1790000000, registered: true,
          state: 'open', payer: null, paidAt: null, cancelledAt: null, registerTx: TX(1), paymentTx: null, cancelTx: null,
          registerBlock: 10, paidBlock: null, cancelBlock: null
        }]);
      });

      it('Registered + Paid -> paid (payer, paidAt, paymentTx, paidBlock)', function () {
        assert.deepEqual(util.foldEvents([R(), P()]), [{
          id: ID(1), merchant: MERCHANT, referenceHash: REF(1), amount: 1250000n, due: 1790086400, createdAt: 1790000000, registered: true,
          state: 'paid', payer: PAYER, paidAt: 1790003600, cancelledAt: null, registerTx: TX(1), paymentTx: TX(2), cancelTx: null,
          registerBlock: 10, paidBlock: 12, cancelBlock: null
        }]);
      });

      it('Registered + Cancelled -> cancelled (cancelledAt, cancelTx, cancelBlock)', function () {
        assert.deepEqual(util.foldEvents([R(), C()]), [{
          id: ID(1), merchant: MERCHANT, referenceHash: REF(1), amount: 1250000n, due: 1790086400, createdAt: 1790000000, registered: true,
          state: 'cancelled', payer: null, paidAt: null, cancelledAt: 1790007200, registerTx: TX(1), paymentTx: null, cancelTx: TX(3),
          registerBlock: 10, paidBlock: null, cancelBlock: 13
        }]);
      });

      it('Registered, Paid, then an (impossible) Cancelled keeps the last state by chain order and all facts', function () {
        const [r] = util.foldEvents([R(), P(), C()]);
        assert.equal(r.state, 'cancelled');
        assert.equal(r.payer, PAYER);
        assert.equal(r.paidAt, 1790003600);
        assert.equal(r.paymentTx, TX(2));
        assert.equal(r.cancelledAt, 1790007200);
        assert.equal(r.cancelTx, TX(3));
      });

      it('Registered, Cancelled, then an (impossible) Paid ends as paid', function () {
        const [r] = util.foldEvents([R(), cancelled({ blockNumber: 11 }), P()]);
        assert.equal(r.state, 'paid');
        assert.equal(r.cancelledAt, 1790007200);
        assert.equal(r.paymentTx, TX(2));
      });

      it('"last" is decided by (blockNumber, logIndex), not by timestamp or by input order', function () {
        // Paid is at a later block than Cancelled but carries an EARLIER timestamp
        const c = cancelled({ blockNumber: 11, cancelledAt: 9000 });
        const p = paid({ blockNumber: 12, paidAt: 100 });
        assert.equal(util.foldEvents([R(), p, c])[0].state, 'paid');
        assert.equal(util.foldEvents([c, p, R()])[0].state, 'paid');
        // same block: logIndex decides
        const c2 = cancelled({ blockNumber: 12, logIndex: 5 });
        const p2 = paid({ blockNumber: 12, logIndex: 4 });
        assert.equal(util.foldEvents([R(), c2, p2])[0].state, 'cancelled');
        assert.equal(util.foldEvents([R(), p2, c2])[0].state, 'cancelled');
      });

      it('input in any order gives the same records as sorted input (all 6 permutations of R, P, C)', function () {
        const expected = util.foldEvents([R(), P(), C()]);
        permutations([R(), P(), C()]).forEach((perm) => assert.deepEqual(util.foldEvents(perm), expected));
        const expectedPaid = util.foldEvents([R(), P()]);
        permutations([R(), P()]).forEach((perm) => assert.deepEqual(util.foldEvents(perm), expectedPaid));
      });

      it('shuffled multi-invoice input gives the same records, in the same order, as sorted input', function () {
        const events = [];
        let n = 0;
        for (let i = 1; i <= 12; i++) {
          events.push(registered({ id: ID(i), referenceHash: REF(i), blockNumber: 100 + i * 3, logIndex: i % 4, txHash: TX(1000 + n++), amount: BigInt(i) * 1000000n }));
          if (i % 2 === 0) events.push(paid({ id: ID(i), referenceHash: REF(i), blockNumber: 101 + i * 3 + 40, logIndex: 1, txHash: TX(1000 + n++), amount: BigInt(i) * 1000000n, payer: i % 4 === 0 ? PAYER : PAYER2 }));
          if (i % 3 === 0) events.push(cancelled({ id: ID(i), blockNumber: 102 + i * 3 + 40, logIndex: 2, txHash: TX(1000 + n++) }));
        }
        const expected = util.foldEvents(events.slice().sort(util.compareEvents));
        const rng = makeRng(12);
        for (let k = 0; k < 25; k++) assert.deepEqual(util.foldEvents(shuffle(rng, events)), expected);
        assert.equal(expected.length, 12);
      });

      it('a Paid-only record (payer view / scan started later) is registered=false with null due and createdAt', function () {
        assert.deepEqual(util.foldEvents([P()]), [{
          id: ID(1), merchant: MERCHANT, referenceHash: REF(1), amount: 1250000n, due: null, createdAt: null, registered: false,
          state: 'paid', payer: PAYER, paidAt: 1790003600, cancelledAt: null, registerTx: null, paymentTx: TX(2), cancelTx: null,
          registerBlock: null, paidBlock: 12, cancelBlock: null
        }]);
      });

      it('a Cancelled-only record has no amount or reference hash', function () {
        const [r] = util.foldEvents([C()]);
        assert.equal(r.state, 'cancelled');
        assert.equal(r.registered, false);
        assert.equal(r.amount, null);
        assert.equal(r.referenceHash, null);
        assert.equal(r.due, null);
        assert.equal(r.cancelTx, TX(3));
      });

      it('the amount and reference hash come from Registered when both events exist', function () {
        const [r] = util.foldEvents([registered({ amount: 5n, referenceHash: REF(5) }), paid({ amount: 5n, referenceHash: REF(5) })]);
        assert.equal(r.amount, 5n);
        assert.equal(r.referenceHash, REF(5));
        // precedence: if the two events ever disagreed, the registered values stay
        const [d] = util.foldEvents([registered({ amount: 5n, referenceHash: REF(5) }), paid({ amount: 6n, referenceHash: REF(6) })]);
        assert.equal(d.amount, 5n);
        assert.equal(d.referenceHash, REF(5));
      });

      it('one record per id, ordered by first appearance in chain order', function () {
        const events = [
          registered({ id: ID(2), blockNumber: 5, txHash: TX(50) }),
          registered({ id: ID(1), blockNumber: 6, txHash: TX(51) }),
          paid({ id: ID(2), blockNumber: 7, txHash: TX(52) }),
          registered({ id: ID(3), blockNumber: 8, txHash: TX(53) }),
          cancelled({ id: ID(1), blockNumber: 9, txHash: TX(54) })
        ];
        const recs = util.foldEvents(events);
        assert.deepEqual(recs.map((r) => r.id), [ID(2), ID(1), ID(3)]);
        assert.deepEqual(recs.map((r) => r.state), ['paid', 'cancelled', 'open']);
        assert.deepEqual(util.foldEvents(events.slice().reverse()).map((r) => r.id), [ID(2), ID(1), ID(3)]);
      });

      it('ignores duplicated events and does not mutate its input', function () {
        const events = [R(), P(), R(), P()];
        const copy = events.slice();
        assert.deepEqual(util.foldEvents(events), util.foldEvents([R(), P()]));
        assert.deepEqual(events, copy);
        assert.deepEqual(util.foldEvents([]), []);
      });

      it('works on events produced by abi.decodeLog from real ABI-encoded logs', function () {
        const iface = new ethers.Interface([
          'event InvoiceRegistered(bytes32 indexed id, address indexed merchant, bytes32 referenceHash, uint96 amount, uint40 due, uint40 createdAt)',
          'event InvoicePaid(bytes32 indexed id, address indexed merchant, address indexed payer, bytes32 referenceHash, uint96 amount, uint40 paidAt)',
          'event InvoiceCancelled(bytes32 indexed id, address indexed merchant, uint40 cancelledAt)'
        ]);
        const log = (name, args, block, idx, tx) => {
          const enc = iface.encodeEventLog(name, args);
          return abi.decodeLog({ address: CONTRACT, topics: enc.topics, data: enc.data, blockNumber: '0x' + block.toString(16), logIndex: '0x' + idx.toString(16), transactionHash: tx, blockHash: hex32(block) });
        };
        const ref = ethers.id('memo');
        const id = abi.invoiceId(MERCHANT, ref);
        const events = [
          log('InvoicePaid', [id, MERCHANT, PAYER, ref, 2500000n, 1790003600], 12, 3, TX(2)),
          log('InvoiceRegistered', [id, MERCHANT, ref, 2500000n, 1790086400, 1790000000], 10, 1, TX(1))
        ];
        const [r] = util.foldEvents(events);
        assert.equal(r.id, id);
        assert.equal(r.state, 'paid');
        assert.equal(r.amount, 2500000n);
        assert.equal(r.payer, PAYER);
        assert.equal(r.merchant, MERCHANT);
        assert.equal(r.referenceHash, ref);
        assert.equal(r.due, 1790086400);
        assert.equal(r.paymentTx, TX(2));
        assert.equal(r.registerBlock, 10);
        assert.equal(r.paidBlock, 12);
      });
    });

    describe('effectiveStatus', function () {
      const open = { state: 'open', due: 2000 };

      it('open with due == latest is still open (the contract accepts payment while timestamp <= due)', function () {
        assert.equal(util.effectiveStatus(open, 2000), 'open');
      });

      it('open with due == latest - 1 is expired', function () {
        assert.equal(util.effectiveStatus(open, 2001), 'expired');
      });

      it('open with due > latest is open', function () {
        assert.equal(util.effectiveStatus(open, 1999), 'open');
        assert.equal(util.effectiveStatus(open, 0), 'open');
      });

      it('matches the contract rule `block.timestamp > due => InvoiceExpired` on a sweep around the boundary', function () {
        for (let t = 1990; t <= 2010; t++) {
          const payable = t <= open.due;
          assert.equal(util.effectiveStatus(open, t), payable ? 'open' : 'expired', 't=' + t);
        }
      });

      it('an unknown latest block time (null / undefined) never expires anything', function () {
        assert.equal(util.effectiveStatus(open, null), 'open');
        assert.equal(util.effectiveStatus(open, undefined), 'open');
        assert.equal(util.effectiveStatus({ state: 'open', due: 5 }, null), 'open');
      });

      it('an open record with an unknown due (paid-only scan artefacts) stays open', function () {
        assert.equal(util.effectiveStatus({ state: 'open', due: null }, 10 ** 10), 'open');
      });

      it('paid and cancelled never become expired', function () {
        assert.equal(util.effectiveStatus({ state: 'paid', due: 1 }, 10 ** 10), 'paid');
        assert.equal(util.effectiveStatus({ state: 'cancelled', due: 1 }, 10 ** 10), 'cancelled');
        assert.equal(util.effectiveStatus({ state: 'paid', due: null }, 5), 'paid');
      });

      it('works on folded records', function () {
        const [r] = util.foldEvents([registered({ due: 2000 })]);
        assert.equal(util.effectiveStatus(r, 2000), 'open');
        assert.equal(util.effectiveStatus(r, 2001), 'expired');
      });
    });

    describe('statusFromChain', function () {
      it('status None -> notfound', function () {
        assert.equal(util.statusFromChain({ status: 0, due: 0 }, 1000), 'notfound');
        assert.equal(util.statusFromChain({ status: abi.STATUS.None, due: 0 }, null), 'notfound');
      });

      it('status Open -> open or expired by due vs the latest block time', function () {
        assert.equal(util.statusFromChain({ status: 1, due: 2000 }, 1999), 'open');
        assert.equal(util.statusFromChain({ status: 1, due: 2000 }, 2000), 'open');
        assert.equal(util.statusFromChain({ status: 1, due: 2000 }, 2001), 'expired');
        assert.equal(util.statusFromChain({ status: 1, due: 2000 }, null), 'open');
        assert.equal(util.statusFromChain({ status: 1, due: 2000 }, undefined), 'open');
      });

      it('status Paid -> paid and Cancelled -> cancelled regardless of due', function () {
        assert.equal(util.statusFromChain({ status: 2, due: 1 }, 10 ** 10), 'paid');
        assert.equal(util.statusFromChain({ status: 3, due: 1 }, 10 ** 10), 'cancelled');
        assert.equal(util.statusFromChain({ status: abi.STATUS.Paid, due: 1 }, null), 'paid');
        assert.equal(util.statusFromChain({ status: abi.STATUS.Cancelled, due: 1 }, null), 'cancelled');
      });

      it('works end to end on abi.decodeGetInvoice output built with ethers', function () {
        const coder = ethers.AbiCoder.defaultAbiCoder();
        const encode = (status, due) => coder.encode(
          ['address', 'uint40', 'uint40', 'uint8', 'bytes32', 'address', 'uint96'],
          [MERCHANT, due, 0, status, REF(1), ethers.ZeroAddress, 1250000n]
        );
        assert.equal(util.statusFromChain(abi.decodeGetInvoice(encode(0, 0)), 100), 'notfound');
        assert.equal(util.statusFromChain(abi.decodeGetInvoice(encode(1, 2000)), 2000), 'open');
        assert.equal(util.statusFromChain(abi.decodeGetInvoice(encode(1, 2000)), 2001), 'expired');
        assert.equal(util.statusFromChain(abi.decodeGetInvoice(encode(2, 2000)), 9999), 'paid');
        assert.equal(util.statusFromChain(abi.decodeGetInvoice(encode(3, 2000)), 9999), 'cancelled');
      });
    });

    describe('summarize', function () {
      const rec = (state, amount, due) => ({ state, amount, due: due === undefined ? 5000 : due });
      const LATEST = 3000;

      it('sums only paid for paidTotal and only open-and-not-expired for outstandingTotal; counts every status', function () {
        const records = [
          rec('paid', 10n),
          rec('paid', 5n, 1), // paid long after due is still paid
          rec('open', 20n, 5000), // outstanding
          rec('open', 40n, 2999), // expired
          rec('open', 80n, 3000), // due == latest: still open
          rec('cancelled', 160n)
        ];
        assert.deepEqual(util.summarize(records, LATEST), {
          counts: { open: 2, expired: 1, paid: 2, cancelled: 1, total: 6 },
          paidTotal: 15n,
          outstandingTotal: 100n
        });
      });

      it('with an unknown latest time nothing expires', function () {
        const records = [rec('open', 20n, 1), rec('open', 40n, 2), rec('paid', 1n)];
        assert.deepEqual(util.summarize(records, null), {
          counts: { open: 2, expired: 0, paid: 1, cancelled: 0, total: 3 }, paidTotal: 1n, outstandingTotal: 60n
        });
      });

      it('an empty list gives zero BigInt totals', function () {
        assert.deepEqual(util.summarize([], 1), { counts: { open: 0, expired: 0, paid: 0, cancelled: 0, total: 0 }, paidTotal: 0n, outstandingTotal: 0n });
      });

      it('keeps exact BigInt sums beyond 2^53', function () {
        const records = [rec('paid', MAX_UINT96), rec('paid', MAX_UINT96), rec('open', MAX_UINT96, 9999)];
        const s = util.summarize(records, 1);
        assert.equal(s.paidTotal, 2n * MAX_UINT96);
        assert.equal(s.outstandingTotal, MAX_UINT96);
      });

      it('counts records without an amount (cancelled-only) without adding to the totals', function () {
        const s = util.summarize([rec('cancelled', null), rec('paid', null), rec('open', null)], 1);
        assert.deepEqual(s.counts, { open: 1, expired: 0, paid: 1, cancelled: 1, total: 3 });
        assert.equal(s.paidTotal, 0n);
        assert.equal(s.outstandingTotal, 0n);
      });

      it('works on folded records', function () {
        const events = [
          registered({ id: ID(1), amount: 100n, blockNumber: 1, txHash: TX(61) }),
          paid({ id: ID(1), amount: 100n, blockNumber: 2, txHash: TX(62) }),
          registered({ id: ID(2), amount: 30n, due: 2000, blockNumber: 3, txHash: TX(63) }),
          registered({ id: ID(3), amount: 7n, due: 9000, blockNumber: 4, txHash: TX(64) })
        ];
        const s = util.summarize(util.foldEvents(events), 2500);
        assert.deepEqual(s, { counts: { open: 1, expired: 1, paid: 1, cancelled: 0, total: 3 }, paidTotal: 100n, outstandingTotal: 7n });
      });
    });

    describe('serializeEvents / deserializeEvents', function () {
      const events = [registered(), paid({ amount: 79228162514264337593543950335n }), cancelled()];

      it('survives JSON.stringify / JSON.parse with BigInt amounts restored and every other field equal', function () {
        const json = JSON.stringify(util.serializeEvents(events));
        const back = util.deserializeEvents(JSON.parse(json));
        assert.deepEqual(back, events);
        assert.equal(typeof back[0].amount, 'bigint');
        assert.equal(back[1].amount, MAX_UINT96);
        assert.equal(back[2].amount, undefined);
        assert.equal('amountIsBigInt' in back[0], false);
        assert.equal('amountIsBigInt' in back[2], false);
      });

      it('plain JSON.stringify of raw events would throw, the serialised form does not', function () {
        assert.throws(() => JSON.stringify(events), TypeError);
        assert.doesNotThrow(() => JSON.stringify(util.serializeEvents(events)));
      });

      it('serialised shape: amount as decimal string plus a flag, Numbers untouched', function () {
        const [s] = util.serializeEvents([registered()]);
        assert.equal(s.amount, '1250000');
        assert.equal(s.amountIsBigInt, true);
        assert.equal(s.due, 1790086400);
        assert.equal(s.blockNumber, 10);
        assert.equal(s.type, 'InvoiceRegistered');
        const [c] = util.serializeEvents([cancelled()]);
        assert.equal('amountIsBigInt' in c, false);
      });

      it('does not mutate its inputs', function () {
        const original = [registered()];
        util.serializeEvents(original);
        assert.equal(typeof original[0].amount, 'bigint');
        assert.equal('amountIsBigInt' in original[0], false);
        const serialised = util.serializeEvents(original);
        const snapshot = JSON.stringify(serialised);
        util.deserializeEvents(serialised);
        assert.equal(JSON.stringify(serialised), snapshot);
      });

      it('round trips random events (many amounts) and folds identically afterwards', function () {
        const rng = makeRng(13);
        const evs = [];
        for (let i = 0; i < 50; i++) {
          evs.push(registered({ id: ID(i), amount: randBigInt(rng, 1 + randInt(rng, 96)) + 1n, blockNumber: i + 1, txHash: TX(100 + i) }));
        }
        const back = util.deserializeEvents(JSON.parse(JSON.stringify(util.serializeEvents(evs))));
        assert.deepEqual(back, evs);
        assert.deepEqual(util.foldEvents(back), util.foldEvents(evs));
      });

      it('handles empty lists', function () {
        assert.deepEqual(util.serializeEvents([]), []);
        assert.deepEqual(util.deserializeEvents([]), []);
      });
    });
  });

  // ------------------------------------------------------------------------------------------------- CSV export
  describe('invoice CSV export', function () {
    const NOW = 1790090000;
    const memo1 = util.buildMemo({ number: 'INV-1', description: 'Logo design', salt: '1'.repeat(32) });
    const memo2 = util.buildMemo({ number: '+7', description: '=HYPERLINK("x","y"),z', salt: '2'.repeat(32) });
    const memo4 = util.buildMemo({ number: '', description: 'Payer side, "quoted"\nsecond line', salt: '4'.repeat(32) });
    const ref1 = util.memoHash(memo1);
    const ref2 = util.memoHash(memo2);
    const ref4 = util.memoHash(memo4);

    const events = [
      // 1: registered + paid
      registered({ id: ID(1), referenceHash: ref1, amount: 1250000n, due: 1790086400, createdAt: 1790000000, blockNumber: 10, txHash: TX(11) }),
      paid({ id: ID(1), referenceHash: ref1, amount: 1250000n, paidAt: 1790003600, payer: PAYER, blockNumber: 12, txHash: TX(12) }),
      // 2: registered, past due, never paid -> expired; its memo is a formula
      registered({ id: ID(2), referenceHash: ref2, amount: 1n, due: 1790000500, createdAt: 1790000100, blockNumber: 14, txHash: TX(21) }),
      // 3: registered then cancelled; memo unknown
      registered({ id: ID(3), referenceHash: REF(3), amount: 3000000n, due: 1790200000, createdAt: 1790000200, blockNumber: 15, txHash: TX(31) }),
      cancelled({ id: ID(3), cancelledAt: 1790001000, blockNumber: 16, txHash: TX(32) }),
      // 4: payer view, only the Paid event is known
      paid({ id: ID(4), referenceHash: ref4, amount: 79228162514264337593543950335n, paidAt: 1790005000, payer: PAYER2, blockNumber: 17, txHash: TX(41) }),
      // 5: cancelled-only
      cancelled({ id: ID(5), cancelledAt: 1790006000, blockNumber: 18, txHash: TX(51) }),
      // 6: open, due in the future
      registered({ id: ID(6), referenceHash: REF(6), amount: 5000000n, due: 1790100000, createdAt: 1790007000, blockNumber: 19, txHash: TX(61) })
    ];
    const records = util.foldEvents(events);
    const ctx = { network: 'arcTestnet', contract: CONTRACT, latestTimestamp: NOW, memos: { [ref1]: memo1, [ref2]: memo2, [ref4]: memo4 } };

    it('recordsToCsvRows gives one 16-cell row per record in CSV_COLUMNS order', function () {
      const rows = util.recordsToCsvRows(records, ctx);
      assert.equal(rows.length, 6);
      rows.forEach((r) => assert.equal(r.length, util.CSV_COLUMNS.length));
      const col = (name) => util.CSV_COLUMNS.indexOf(name);
      assert.deepEqual(rows[0], [
        'arcTestnet', CONTRACT, ID(1), ref1, 'INV-1', 'Logo design', '1.250000', 'paid',
        '2026-09-21T14:13:20Z', '2026-09-22T14:13:20Z', '2026-09-21T15:13:20Z', MERCHANT, PAYER, TX(11), TX(12), ''
      ]);
      assert.equal(rows[0][col('network')], 'arcTestnet');
      assert.equal(rows[0][col('payment_tx')], TX(12));
    });

    it('amount_usdc is fixed 6 decimals, including tiny and uint96-max amounts', function () {
      const rows = util.recordsToCsvRows(records, ctx);
      const amount = util.CSV_COLUMNS.indexOf('amount_usdc');
      assert.deepEqual(rows.map((r) => r[amount]), ['1.250000', '0.000001', '3.000000', '79228162514264337593543.950335', '', '5.000000']);
    });

    it('timestamps are ISO 8601 UTC with a Z suffix', function () {
      const rows = util.recordsToCsvRows(records, ctx);
      const idx = ['created_utc', 'due_utc', 'paid_utc'].map((c) => util.CSV_COLUMNS.indexOf(c));
      rows.forEach((r) => idx.forEach((i) => assert.match(r[i], /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)?$/)));
      assert.equal(rows[1][idx[1]], '2026-09-21T14:21:40Z'); // invoice 2, due 1790000500
    });

    it('status uses effectiveStatus: an open invoice past due shows "expired"', function () {
      const status = util.CSV_COLUMNS.indexOf('status');
      assert.deepEqual(util.recordsToCsvRows(records, ctx).map((r) => r[status]), ['paid', 'expired', 'cancelled', 'paid', 'cancelled', 'open']);
      assert.deepEqual(
        util.recordsToCsvRows(records, Object.assign({}, ctx, { latestTimestamp: null })).map((r) => r[status]),
        ['paid', 'open', 'cancelled', 'paid', 'cancelled', 'open']
      );
      assert.deepEqual(
        util.recordsToCsvRows(records, Object.assign({}, ctx, { latestTimestamp: 1790100000 })).map((r) => r[status]),
        ['paid', 'expired', 'cancelled', 'paid', 'cancelled', 'open'] // due == latest is still open
      );
      assert.equal(util.recordsToCsvRows(records, Object.assign({}, ctx, { latestTimestamp: 1790100001 }))[5][status], 'expired');
    });

    it('invoice number and description come from ctx.memos via parseMemo; empty when unknown', function () {
      const rows = util.recordsToCsvRows(records, ctx);
      const no = util.CSV_COLUMNS.indexOf('invoice_number');
      const d = util.CSV_COLUMNS.indexOf('description');
      assert.deepEqual(rows.map((r) => r[no]), ['INV-1', '+7', '', '', '', '']);
      assert.deepEqual(rows.map((r) => r[d]), ['Logo design', '=HYPERLINK("x","y"),z', '', 'Payer side, "quoted"\nsecond line', '', '']);
    });

    it('memo lookup is by the lower-case reference hash and tolerates mixed-case record hashes', function () {
      const upperRecord = Object.assign({}, records[0], { referenceHash: '0x' + ref1.slice(2).toUpperCase() });
      const [row] = util.recordsToCsvRows([upperRecord], ctx);
      assert.equal(row[util.CSV_COLUMNS.indexOf('description')], 'Logo design');
    });

    it('missing or unparsable memos and a missing ctx.memos give empty description cells', function () {
      const noMemos = util.recordsToCsvRows(records, { network: 'n', contract: CONTRACT, latestTimestamp: NOW });
      noMemos.forEach((r) => {
        assert.equal(r[util.CSV_COLUMNS.indexOf('invoice_number')], '');
        assert.equal(r[util.CSV_COLUMNS.indexOf('description')], '');
      });
      const garbage = util.recordsToCsvRows(records, { network: 'n', contract: CONTRACT, latestTimestamp: NOW, memos: { [ref1]: 'not json', [ref2]: '{"v":2}' } });
      assert.equal(garbage[0][util.CSV_COLUMNS.indexOf('description')], '');
      assert.equal(garbage[1][util.CSV_COLUMNS.indexOf('description')], '');
    });

    it('a payer-only record leaves created, due and register_tx empty but keeps what the Paid event says', function () {
      const row = util.recordsToCsvRows(records, ctx)[3];
      const c = (name) => row[util.CSV_COLUMNS.indexOf(name)];
      assert.equal(c('created_utc'), '');
      assert.equal(c('due_utc'), '');
      assert.equal(c('register_tx'), '');
      assert.equal(c('cancel_tx'), '');
      assert.equal(c('reference_hash'), ref4);
      assert.equal(c('status'), 'paid');
      assert.equal(c('paid_utc'), '2026-09-21T15:36:40Z'); // 1790005000
      assert.equal(c('payer'), PAYER2);
      assert.equal(c('merchant'), MERCHANT);
      assert.equal(c('payment_tx'), TX(41));
    });

    it('a cancelled-only record has no amount, reference hash, created or due', function () {
      const row = util.recordsToCsvRows(records, ctx)[4];
      const c = (name) => row[util.CSV_COLUMNS.indexOf(name)];
      assert.equal(c('amount_usdc'), '');
      assert.equal(c('reference_hash'), '');
      assert.equal(c('created_utc'), '');
      assert.equal(c('status'), 'cancelled');
      assert.equal(c('cancel_tx'), TX(51));
      assert.equal(c('payer'), '');
      assert.equal(c('paid_utc'), '');
    });

    it('an open record shows empty paid_utc, payer, payment_tx and cancel_tx', function () {
      const row = util.recordsToCsvRows(records, ctx)[5];
      const c = (name) => row[util.CSV_COLUMNS.indexOf(name)];
      assert.equal(c('paid_utc'), '');
      assert.equal(c('payer'), '');
      assert.equal(c('payment_tx'), '');
      assert.equal(c('cancel_tx'), '');
      assert.equal(c('register_tx'), TX(61));
      assert.equal(c('due_utc'), '2026-09-22T18:00:00Z'); // 1790100000
    });

    it('buildInvoiceCsv = BOM + header + rows, and parses back with a strict CSV parser', function () {
      const csv = util.buildInvoiceCsv(records, ctx);
      assert.equal(csv, util.buildCsv(util.CSV_COLUMNS, util.recordsToCsvRows(records, ctx)));
      assert.equal(csv.charCodeAt(0), 0xfeff);
      assert.ok(csv.endsWith('\r\n'));
      const parsed = parseCsv(csv);
      assert.deepEqual(parsed[0], util.CSV_COLUMNS);
      assert.equal(parsed.length, records.length + 1);
      parsed.forEach((r) => assert.equal(r.length, 16));
      const expectedRows = util.recordsToCsvRows(records, ctx).map((r) => r.map(expectedCell));
      assert.deepEqual(parsed.slice(1), expectedRows);
    });

    it('a formula description is neutralised and the cell is properly quoted', function () {
      const csv = util.buildInvoiceCsv(records, ctx);
      assert.ok(csv.includes('"\'=HYPERLINK(""x"",""y""),z"'), 'raw CSV should hold the prefixed, quoted, doubled-quote cell');
      const parsed = parseCsv(csv);
      const d = util.CSV_COLUMNS.indexOf('description');
      const no = util.CSV_COLUMNS.indexOf('invoice_number');
      assert.equal(parsed[2][d], '\'=HYPERLINK("x","y"),z');
      assert.equal(parsed[2][no], "'+7");
      assert.equal(parsed[4][d], 'Payer side, "quoted"\nsecond line');
      // no data cell in the whole file starts a formula
      parsed.slice(1).forEach((row) => row.forEach((cell) => assert.doesNotMatch(cell, /^[=+\-@\t\r]/)));
    });

    it('an empty record list gives just the header', function () {
      assert.equal(util.buildInvoiceCsv([], ctx), '\uFEFF' + util.CSV_COLUMNS.join(',') + '\r\n');
      assert.deepEqual(util.recordsToCsvRows([], ctx), []);
    });

    describe('csvFilename', function () {
      const addr = '0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
      const date = new Date(Date.UTC(2026, 9, 4, 12));

      it('arc-invoices-<network>-<short address>-<date>.csv', function () {
        assert.equal(util.csvFilename('arcTestnet', addr, date), 'arc-invoices-arcTestnet-0xf39f2266-2026-10-04.csv');
        assert.equal(util.csvFilename('arcTestnet', addr, date, undefined), 'arc-invoices-arcTestnet-0xf39f2266-2026-10-04.csv');
        assert.equal(util.csvFilename('arcTestnet', addr, date, 'invoices'), 'arc-invoices-arcTestnet-0xf39f2266-2026-10-04.csv');
      });

      it('the payments variant', function () {
        assert.equal(util.csvFilename('arcTestnet', addr, date, 'payments'), 'arc-payments-arcTestnet-0xf39f2266-2026-10-04.csv');
      });

      it('lower-cases the short address whatever the input case', function () {
        assert.equal(util.csvFilename('local', addr.toLowerCase(), date), 'arc-invoices-local-0xf39f2266-2026-10-04.csv');
        assert.equal(util.csvFilename('local', '0x' + addr.slice(2).toUpperCase(), date), 'arc-invoices-local-0xf39f2266-2026-10-04.csv');
      });

      it('unknown or invalid addresses give "unknown"', function () {
        [undefined, null, '', '0x1234', 'not an address', '0x' + 'z'.repeat(40), addr + '0', addr.slice(2), 5].forEach((a) => {
          assert.equal(util.csvFilename('arcTestnet', a, date), 'arc-invoices-arcTestnet-unknown-2026-10-04.csv', String(a));
        });
      });

      it('strips hostile characters from the network key', function () {
        assert.equal(util.csvFilename('../../etc/passwd', addr, date), 'arc-invoices-etcpasswd-0xf39f2266-2026-10-04.csv');
        assert.equal(util.csvFilename('arc testnet', addr, date), 'arc-invoices-arctestnet-0xf39f2266-2026-10-04.csv');
        assert.equal(util.csvFilename('a\\b:c*d?e"f<g>h|i', addr, date), 'arc-invoices-abcdefghi-0xf39f2266-2026-10-04.csv');
        assert.equal(util.csvFilename('arc\u00e9\u65e5\n', addr, date), 'arc-invoices-arc-0xf39f2266-2026-10-04.csv');
        assert.equal(util.csvFilename('arc-test_net1', addr, date), 'arc-invoices-arc-test_net1-0xf39f2266-2026-10-04.csv');
        ['../x', 'a/b', 'a\\b', 'x\u0000y', '..', 'con.'].forEach((net) => {
          const name = util.csvFilename(net, addr, date);
          assert.match(name, /^arc-invoices-[A-Za-z0-9_-]*-0xf39f2266-2026-10-04\.csv$/, net);
        });
      });

      it('the date stamp is the UTC day, also for numbers and strings', function () {
        assert.equal(util.csvFilename('n', addr, new Date('2026-10-05T04:30:00Z')), 'arc-invoices-n-0xf39f2266-2026-10-05.csv');
        assert.equal(util.csvFilename('n', addr, new Date('2026-10-04T23:30:00-05:00')), 'arc-invoices-n-0xf39f2266-2026-10-05.csv');
        assert.equal(util.csvFilename('n', addr, Date.UTC(2026, 0, 2)), 'arc-invoices-n-0xf39f2266-2026-01-02.csv');
      });
    });
  });

  // ------------------------------------------------------------------------------------------------- storage
  describe('storage', function () {
    class FakeStorage {
      constructor(initial) {
        this.map = new Map(Object.entries(initial || {}));
        this.removed = [];
      }
      getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
      setItem(k, v) { this.map.set(k, String(v)); }
      removeItem(k) { this.removed.push(k); this.map.delete(k); }
    }
    const throwing = () => ({
      getItem() { throw new Error('SecurityError'); },
      setItem() { throw new Error('QuotaExceededError'); },
      removeItem() { throw new Error('SecurityError'); }
    });

    describe('createStore', function () {
      it('get returns the fallback for a missing key and the parsed JSON for a present one', function () {
        const fake = new FakeStorage({ obj: '{"a":[1,2,{"b":null}]}', str: '"text"', num: '42', nul: 'null', bool: 'false' });
        const store = util.createStore(fake);
        assert.equal(store.get('missing', 'fallback'), 'fallback');
        assert.equal(store.get('missing'), undefined);
        assert.deepEqual(store.get('obj', null), { a: [1, 2, { b: null }] });
        assert.equal(store.get('str', null), 'text');
        assert.equal(store.get('num', null), 42);
        assert.equal(store.get('nul', 'fallback'), null);
        assert.equal(store.get('bool', true), false);
      });

      it('set writes JSON to the storage and returns true', function () {
        const fake = new FakeStorage();
        const store = util.createStore(fake);
        assert.equal(store.set('k', { a: 1, b: [true, 'x'] }), true);
        assert.equal(fake.getItem('k'), '{"a":1,"b":[true,"x"]}');
        assert.deepEqual(store.get('k', null), { a: 1, b: [true, 'x'] });
        assert.equal(store.set('k', 'now a string'), true);
        assert.equal(store.get('k', null), 'now a string');
      });

      it('remove deletes from the storage and get falls back again', function () {
        const fake = new FakeStorage({ k: '1' });
        const store = util.createStore(fake);
        store.remove('k');
        assert.deepEqual(fake.removed, ['k']);
        assert.equal(store.get('k', 'gone'), 'gone');
        assert.doesNotThrow(() => store.remove('never-existed'));
      });

      it('returns the fallback for corrupt JSON instead of throwing', function () {
        const store = util.createStore(new FakeStorage({ bad: '{not json', empty: '', undef: 'undefined' }));
        assert.deepEqual(store.get('bad', { fallback: true }), { fallback: true });
        assert.equal(store.get('empty', 'fb'), 'fb');
        assert.equal(store.get('undef', 'fb'), 'fb');
      });

      it('falls back to an in-memory map when getItem and setItem throw; set returns false', function () {
        const store = util.createStore(throwing());
        assert.equal(store.get('k', 'fb'), 'fb');
        assert.equal(store.set('k', { a: 1 }), false);
        assert.deepEqual(store.get('k', 'fb'), { a: 1 });
        assert.equal(store.set('k', [1, 2]), false);
        assert.deepEqual(store.get('k', 'fb'), [1, 2]);
        assert.doesNotThrow(() => store.remove('k'));
        assert.equal(store.get('k', 'fb'), 'fb');
      });

      it('works with a null / undefined storage (in memory only); set returns false', function () {
        [null, undefined].forEach((s) => {
          const store = util.createStore(s);
          assert.equal(store.get('k', 'fb'), 'fb');
          assert.equal(store.set('k', { x: 1 }), false);
          assert.deepEqual(store.get('k', 'fb'), { x: 1 });
          store.remove('k');
          assert.equal(store.get('k', 'fb'), 'fb');
        });
      });

      it('in-memory stores are independent and have no inherited keys', function () {
        const a = util.createStore(null);
        const b = util.createStore(null);
        a.set('k', 1);
        assert.equal(b.get('k', 'none'), 'none');
        assert.equal(a.get('toString', 'fb'), 'fb');
        assert.equal(a.get('constructor', 'fb'), 'fb');
        assert.equal(a.get('__proto__', 'fb'), 'fb');
      });

      it('survives a storage whose removeItem throws', function () {
        const s = { getItem() { return null; }, setItem() {}, removeItem() { throw new Error('nope'); } };
        assert.doesNotThrow(() => util.createStore(s).remove('k'));
      });

      it('BUG: a failed write (quota exceeded, reads still work) stays readable from the in-memory fallback', function () {
        // Safari private mode / a full localStorage: getItem works and returns null, setItem throws.
        // set() stores the value in `memory` and returns false, but get() only consults `memory` when getItem
        // itself throws, so the value that set() just kept is never returned.
        const store = util.createStore({ getItem() { return null; }, setItem() { throw new Error('QuotaExceededError'); }, removeItem() {} });
        assert.equal(store.set('k', { a: 1 }), false);
        assert.deepEqual(store.get('k', null), { a: 1 });
      });
    });

    describe('loadMemos / saveMemo', function () {
      const KEY = 'arcInvoice.memos';
      const h1 = '0x' + 'ab'.repeat(32);
      const h2 = '0x' + 'cd'.repeat(32);

      it('loadMemos returns {} when nothing is stored', function () {
        assert.deepEqual(util.loadMemos(util.createStore(new FakeStorage())), {});
        assert.deepEqual(util.loadMemos(util.createStore(null)), {});
      });

      it('loadMemos returns the stored object', function () {
        const fake = new FakeStorage({ [KEY]: JSON.stringify({ [h1]: 'memo one' }) });
        assert.deepEqual(util.loadMemos(util.createStore(fake)), { [h1]: 'memo one' });
      });

      it('loadMemos ignores a stored value that is not a plain object', function () {
        ['"text"', '42', 'null', 'true', '[]', '[1,2]', '{broken'].forEach((raw) => {
          assert.deepEqual(util.loadMemos(util.createStore(new FakeStorage({ [KEY]: raw }))), {}, raw);
        });
      });

      it('saveMemo uses the localStorage key "arcInvoice.memos"', function () {
        const fake = new FakeStorage();
        const store = util.createStore(fake);
        assert.equal(util.saveMemo(store, h1, 'memo one'), true);
        assert.deepEqual([...fake.map.keys()], [KEY]);
        assert.deepEqual(JSON.parse(fake.getItem(KEY)), { [h1]: 'memo one' });
      });

      it('saveMemo lower-cases the hash key', function () {
        const fake = new FakeStorage();
        const store = util.createStore(fake);
        util.saveMemo(store, '0x' + 'AB'.repeat(32), 'memo');
        assert.deepEqual(Object.keys(JSON.parse(fake.getItem(KEY))), [h1]);
        assert.deepEqual(util.loadMemos(store), { [h1]: 'memo' });
      });

      it('saveMemo preserves the other keys and overwrites the same hash', function () {
        const fake = new FakeStorage({ [KEY]: JSON.stringify({ [h2]: 'other' }) });
        const store = util.createStore(fake);
        util.saveMemo(store, h1, 'first');
        assert.deepEqual(util.loadMemos(store), { [h2]: 'other', [h1]: 'first' });
        util.saveMemo(store, h1.toUpperCase().replace('0X', '0x'), 'second');
        assert.deepEqual(util.loadMemos(store), { [h2]: 'other', [h1]: 'second' });
      });

      it('saveMemo replaces a stored value that is not an object', function () {
        const fake = new FakeStorage({ [KEY]: '"garbage"' });
        const store = util.createStore(fake);
        assert.equal(util.saveMemo(store, h1, 'memo'), true);
        assert.deepEqual(JSON.parse(fake.getItem(KEY)), { [h1]: 'memo' });
      });

      it('saveMemo returns false when the storage cannot persist, and the memo is still readable in this page', function () {
        const store = util.createStore(throwing());
        assert.equal(util.saveMemo(store, h1, 'memo'), false);
        assert.deepEqual(util.loadMemos(store), { [h1]: 'memo' });
        const memoryOnly = util.createStore(null);
        assert.equal(util.saveMemo(memoryOnly, h1, 'memo'), false);
        assert.deepEqual(util.loadMemos(memoryOnly), { [h1]: 'memo' });
      });

      it('saved memos feed the CSV export (hash -> text)', function () {
        const memo = util.buildMemo({ number: 'A-1', description: 'Stored memo', salt: '9'.repeat(32) });
        const store = util.createStore(new FakeStorage());
        util.saveMemo(store, util.memoHash(memo), memo);
        const recs = util.foldEvents([registered({ referenceHash: util.memoHash(memo) })]);
        const [row] = util.recordsToCsvRows(recs, { network: 'local', contract: CONTRACT, latestTimestamp: null, memos: util.loadMemos(store) });
        assert.equal(row[util.CSV_COLUMNS.indexOf('description')], 'Stored memo');
        assert.equal(row[util.CSV_COLUMNS.indexOf('invoice_number')], 'A-1');
      });
    });
  });

  // ------------------------------------------------------------------------------------------------- tx params
  describe('transactions on Arc', function () {
    const ceilDiv = (a, b) => (a + b - 1n) / b;

    describe('computeTxParams', function () {
      it('gasPrice 1 gwei -> maxFeePerGas floors at 20 gwei', function () {
        const p = util.computeTxParams(100000n, 1n * GWEI);
        assert.deepEqual(p, {
          gas: 130000n, maxFeePerGas: 20n * GWEI, maxPriorityFeePerGas: GWEI, expectedFee: 100000n * GWEI, maxFee: 130000n * 20n * GWEI
        });
      });

      it('gasPrice 15 gwei -> maxFeePerGas 30 gwei (2x)', function () {
        const p = util.computeTxParams(100001n, 15n * GWEI);
        assert.equal(p.maxFeePerGas, 30n * GWEI);
        assert.equal(p.gas, 130002n);
        assert.equal(p.maxPriorityFeePerGas, GWEI);
        assert.equal(p.expectedFee, 100001n * 15n * GWEI);
        assert.equal(p.maxFee, 130002n * 30n * GWEI);
      });

      it('the 20 gwei floor and the 2x rule meet at 10 gwei', function () {
        assert.equal(util.computeTxParams(1n, 9n * GWEI).maxFeePerGas, 20n * GWEI);
        assert.equal(util.computeTxParams(1n, 10n * GWEI).maxFeePerGas, 20n * GWEI);
        assert.equal(util.computeTxParams(1n, 10n * GWEI + 1n).maxFeePerGas, 20n * GWEI + 2n);
        assert.equal(util.computeTxParams(1n, 1000n * GWEI).maxFeePerGas, 2000n * GWEI);
      });

      it('maxFeePerGas is never below 20 gwei and never below 2x the gas price', function () {
        [0n, 1n, GWEI, 9999999999n, 10n * GWEI, 10n * GWEI + 1n, 25n * GWEI, 10n ** 12n].forEach((price) => {
          const p = util.computeTxParams(21000n, price);
          assert.ok(p.maxFeePerGas >= 20n * GWEI, String(price));
          assert.ok(p.maxFeePerGas >= 2n * price, String(price));
          assert.ok(p.maxFeePerGas === 20n * GWEI || p.maxFeePerGas === 2n * price, String(price));
        });
      });

      it('the gas limit is ceil(estimate * 1.3)', function () {
        assert.equal(util.computeTxParams(100001n, GWEI).gas, 130002n); // 130001.3 -> 130002
        assert.equal(util.computeTxParams(100000n, GWEI).gas, 130000n); // exact
        assert.equal(util.computeTxParams(21000n, GWEI).gas, 27300n);
        assert.equal(util.computeTxParams(10n, GWEI).gas, 13n);
        assert.equal(util.computeTxParams(1n, GWEI).gas, 2n);
        assert.equal(util.computeTxParams(3n, GWEI).gas, 4n);
        assert.equal(util.computeTxParams(7n, GWEI).gas, 10n);
        assert.equal(util.computeTxParams(0n, GWEI).gas, 0n);
      });

      it('gas === ceil(est * 13 / 10) for every estimate up to 2000 and for huge ones', function () {
        for (let est = 0n; est <= 2000n; est++) assert.equal(util.computeTxParams(est, GWEI).gas, ceilDiv(est * 13n, 10n), String(est));
        [2n ** 64n + 1n, 2n ** 70n + 3n, 10n ** 20n, 9007199254740993n].forEach((est) => {
          const gas = util.computeTxParams(est, GWEI).gas;
          assert.equal(gas, ceilDiv(est * 13n, 10n));
          assert.ok(gas * 10n >= est * 13n);
          assert.ok((gas - 1n) * 10n < est * 13n);
        });
      });

      it('maxPriorityFeePerGas is always 1 gwei', function () {
        [0n, 1n, 50n * GWEI].forEach((price) => assert.equal(util.computeTxParams(21000n, price).maxPriorityFeePerGas, GWEI));
      });

      it('expectedFee = estimate x gasPrice and maxFee = gas x maxFeePerGas', function () {
        const rng = makeRng(14);
        for (let i = 0; i < 100; i++) {
          const est = 21000n + randBigInt(rng, 20);
          const price = 1n + randBigInt(rng, 38);
          const p = util.computeTxParams(est, price);
          assert.equal(p.expectedFee, est * price);
          assert.equal(p.maxFee, p.gas * p.maxFeePerGas);
          assert.ok(p.maxFee >= p.expectedFee);
        }
      });

      it('a zero gas price (node without a quote) uses 10 gwei for the expected fee but still the 20 gwei floor for the cap', function () {
        const p = util.computeTxParams(100000n, 0n);
        assert.equal(p.maxFeePerGas, 20n * GWEI);
        assert.equal(p.expectedFee, 100000n * 10n * GWEI);
      });

      it('accepts Number and hex-string inputs as returned by JSON-RPC, and returns BigInts', function () {
        const fromHex = util.computeTxParams('0x5208', '0x3b9aca00'); // 21000, 1 gwei
        assert.deepEqual(fromHex, util.computeTxParams(21000n, GWEI));
        assert.deepEqual(util.computeTxParams(21000, 1000000000), util.computeTxParams(21000n, GWEI));
        Object.values(fromHex).forEach((v) => assert.equal(typeof v, 'bigint'));
      });
    });

    describe('toHex / hexToBigInt', function () {
      it('toHex writes JSON-RPC quantities (0x0 for zero, no leading zeros)', function () {
        assert.equal(util.toHex(0), '0x0');
        assert.equal(util.toHex(0n), '0x0');
        assert.equal(util.toHex(255n), '0xff');
        assert.equal(util.toHex(256), '0x100');
        assert.equal(util.toHex(GWEI), '0x3b9aca00');
        assert.equal(util.toHex(2n ** 64n), '0x10000000000000000');
        assert.equal(util.toHex('1000'), '0x3e8');
        assert.equal(util.toHex(MAX_UINT96), '0x' + 'f'.repeat(24));
      });

      it('toHex agrees with ethers.toQuantity', function () {
        const rng = makeRng(15);
        for (let i = 0; i < 200; i++) {
          const v = randBigInt(rng, 1 + randInt(rng, 200));
          assert.equal(util.toHex(v), ethers.toQuantity(v));
        }
      });

      it('hexToBigInt parses 0x quantities', function () {
        assert.equal(util.hexToBigInt('0x0'), 0n);
        assert.equal(util.hexToBigInt('0xff'), 255n);
        assert.equal(util.hexToBigInt('0xFF'), 255n);
        assert.equal(util.hexToBigInt('0x3b9aca00'), GWEI);
        assert.equal(util.hexToBigInt('0x' + 'f'.repeat(24)), MAX_UINT96);
        assert.equal(typeof util.hexToBigInt('0x1'), 'bigint');
      });

      it('hexToBigInt rejects text that is not hex', function () {
        ['0xzz', 'ff', 'hello', '0x', '1.5'].forEach((h) => assert.throws(() => util.hexToBigInt(h), SyntaxError, h));
      });

      it('toHex and hexToBigInt round trip', function () {
        const rng = makeRng(16);
        [0n, 1n, 255n, 256n, MAX_UINT96, 2n ** 256n - 1n].concat(Array.from({ length: 100 }, () => randBigInt(rng, 1 + randInt(rng, 256)))).forEach((v) => {
          assert.equal(util.hexToBigInt(util.toHex(v)), v);
        });
      });
    });
  });

  // ------------------------------------------------------------------------------------------------- errors
  describe('plain-English errors', function () {
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const dataFor = (name, types, values) => abi.ERROR_SELECTORS[name] + coder.encode(types || [], values || []).slice(2);
    const errorArgs = { InvoiceExpired: [['uint40'], [1790000000]], WrongAmount: [['uint256', 'uint256'], [1250000n * SCALE, 1000000n * SCALE]] };
    const decoded = (name) => {
      const a = errorArgs[name] || [[], []];
      return abi.decodeError(dataFor(name, a[0], a[1]));
    };
    const solidityError = (message) => '0x08c379a0' + coder.encode(['string'], [message]).slice(2);
    const solidityPanic = (code) => '0x4e487b71' + coder.encode(['uint256'], [code]).slice(2);

    function assertPlainSentence(text, label) {
      assert.equal(typeof text, 'string', label);
      assert.ok(text.length >= 15, label + ': too short: ' + text);
      assert.ok(text.length <= 400, label + ': too long');
      assert.match(text, /^[A-Z]/, label + ': should start with a capital: ' + text);
      assert.doesNotMatch(text, /undefined|\bnull\b|NaN|\[object|0x[0-9a-fA-F]{6,}/, label + ': leaks internals: ' + text);
    }

    describe('explainContractError', function () {
      it('the ABI selectors used here match ethers for every contract error', function () {
        const iface = new ethers.Interface([
          'error ZeroReferenceHash()', 'error ZeroAmount()', 'error DueNotInFuture()', 'error AlreadyRegistered()', 'error UnknownInvoice()',
          'error AlreadyPaid()', 'error AlreadyCancelled()', 'error InvoiceExpired(uint40 due)', 'error WrongAmount(uint256 expected, uint256 sent)',
          'error NotMerchant()', 'error TransferFailed()'
        ]);
        Object.keys(abi.ERROR_SELECTORS).forEach((name) => assert.equal(abi.ERROR_SELECTORS[name], iface.getError(name).selector, name));
      });

      Object.keys(abi.ERROR_SELECTORS).forEach((name) => {
        it('explains ' + name + ' with a plain sentence', function () {
          const d = decoded(name);
          assert.equal(d.name, name);
          assertPlainSentence(util.explainContractError(d), name);
        });
      });

      it('has an explanation for every error declared in contracts/InvoiceReceipts.sol', function () {
        if (!fs.existsSync(CONTRACT_SOL)) return this.skip();
        const src = fs.readFileSync(CONTRACT_SOL, 'utf8');
        const names = [...src.matchAll(/^\s*error\s+(\w+)\s*\(/gm)].map((m) => m[1]).sort();
        assert.ok(names.length >= 11, 'found ' + names.join(','));
        assert.deepEqual(Object.keys(abi.ERROR_SELECTORS).sort(), names);
        names.forEach((name) => assertPlainSentence(util.explainContractError(decoded(name)), name));
      });

      it('exact texts for the simple errors', function () {
        assert.equal(util.explainContractError(decoded('ZeroReferenceHash')), 'The invoice reference is empty.');
        assert.equal(util.explainContractError(decoded('ZeroAmount')), 'The amount must be greater than zero.');
        assert.equal(util.explainContractError(decoded('AlreadyPaid')), 'This invoice has already been paid.');
        assert.match(util.explainContractError(decoded('DueNotInFuture')), /due date must be in the future/);
        assert.match(util.explainContractError(decoded('AlreadyRegistered')), /already exists on-chain/);
        assert.match(util.explainContractError(decoded('UnknownInvoice')), /does not exist on this contract and network/);
        assert.match(util.explainContractError(decoded('AlreadyCancelled')), /cancelled by the merchant/);
        assert.match(util.explainContractError(decoded('NotMerchant')), /Only the merchant account/);
        assert.match(util.explainContractError(decoded('TransferFailed')), /merchant account cannot receive USDC/);
      });

      it('InvoiceExpired mentions the due time in UTC', function () {
        const text = util.explainContractError(decoded('InvoiceExpired'));
        assert.ok(text.includes('2026-09-21 14:13:20 UTC'), text);
        assert.match(text, /expired/);
        const other = util.explainContractError(abi.decodeError(dataFor('InvoiceExpired', ['uint40'], [0])));
        assert.ok(other.includes('1970-01-01 00:00:00 UTC'), other);
      });

      it('WrongAmount mentions both amounts in USDC', function () {
        const text = util.explainContractError(decoded('WrongAmount'));
        assert.equal(text, 'The amount sent (1.00 USDC) does not match the invoice (1.25 USDC).');
        const small = util.explainContractError(abi.decodeError(dataFor('WrongAmount', ['uint256', 'uint256'], [1n * SCALE, 2000000000005n * SCALE])));
        assert.equal(small, 'The amount sent (2000000.000005 USDC) does not match the invoice (0.000001 USDC).');
      });

      it('Error(string) shows the revert message', function () {
        const d = abi.decodeError(solidityError('Pausable: paused'));
        assert.equal(d.name, 'Error');
        assert.equal(util.explainContractError(d), 'The contract rejected the request: Pausable: paused');
        assert.equal(util.explainContractError(abi.decodeError(solidityError('caf\u00e9 \u{1F600}'))), 'The contract rejected the request: caf\u00e9 \u{1F600}');
      });

      it('Panic(uint256) shows the code in decimal', function () {
        assert.equal(util.explainContractError(abi.decodeError(solidityPanic(0x11n))), 'The contract failed with an internal error (code 17).');
        assert.equal(util.explainContractError(abi.decodeError(solidityPanic(0x32n))), 'The contract failed with an internal error (code 50).');
        assertPlainSentence(util.explainContractError(abi.decodeError(solidityPanic(1n))), 'Panic');
      });

      it('returns null for unknown names, null and undefined', function () {
        assert.equal(util.explainContractError(null), null);
        assert.equal(util.explainContractError(undefined), null);
        assert.equal(util.explainContractError({ name: 'SomethingElse', args: {} }), null);
        assert.equal(util.explainContractError({ name: '', args: {} }), null);
        assert.equal(util.explainContractError(abi.decodeError('0xdeadbeef')), null);
        assert.equal(util.explainContractError(abi.decodeError('0x')), null);
      });
    });

    describe('explainFailure', function () {
      const already = 'This invoice has already been paid.';

      it('uses revert data carried by a hardhat-shaped RPC error (error.data as hex)', function () {
        const e = Object.assign(new Error("VM Exception while processing transaction: reverted with custom error 'AlreadyPaid()'"), { code: -32603, data: dataFor('AlreadyPaid') });
        assert.equal(util.explainFailure(e), already);
      });

      it('uses revert data nested in error.data.data (older hardhat / geth proxies)', function () {
        const e = Object.assign(new Error('Error: VM Exception while processing transaction'), { code: -32603, data: { message: 'reverted', data: dataFor('NotMerchant') } });
        assert.match(util.explainFailure(e), /Only the merchant account/);
      });

      it('uses revert data in an ethers-v6-shaped CALL_EXCEPTION (info.error.data)', function () {
        const e = { code: 'CALL_EXCEPTION', message: 'execution reverted (unknown custom error)', info: { error: { code: 3, message: 'execution reverted', data: dataFor('AlreadyCancelled') } } };
        assert.match(util.explainFailure(e), /cancelled by the merchant/);
      });

      it('uses revert data found in error.error.data and error.cause', function () {
        assert.match(util.explainFailure({ message: 'x', error: { data: dataFor('UnknownInvoice') } }), /does not exist/);
        assert.match(util.explainFailure({ message: 'x', cause: { data: dataFor('ZeroAmount') } }), /greater than zero/);
      });

      it('uses revert data embedded in the message text', function () {
        const e = new Error('execution reverted (return data: ' + dataFor('UnknownInvoice') + ')');
        assert.match(util.explainFailure(e), /does not exist on this contract and network/);
        assert.equal(util.explainFailure(new Error('call failed: ' + dataFor('AlreadyPaid') + ' (rpc)')), already);
      });

      it('explains InvoiceExpired and WrongAmount from raw revert data', function () {
        const exp = util.explainFailure({ message: 'reverted', data: dataFor('InvoiceExpired', ['uint40'], [1790000000]) });
        assert.ok(exp.includes('2026-09-21 14:13:20 UTC'), exp);
        const wrong = util.explainFailure({ message: 'reverted', data: dataFor('WrongAmount', ['uint256', 'uint256'], [1250000n * SCALE, 1000000n * SCALE]) });
        assert.equal(wrong, 'The amount sent (1.00 USDC) does not match the invoice (1.25 USDC).');
      });

      it('explains Error(string) and Panic revert data', function () {
        assert.equal(util.explainFailure({ message: 'reverted', data: solidityError('nope') }), 'The contract rejected the request: nope');
        assert.equal(util.explainFailure({ message: 'reverted', data: solidityPanic(0x11n) }), 'The contract failed with an internal error (code 17).');
      });

      it('unknown revert data falls back to the generic "would fail on-chain" text, keeping the message', function () {
        const t = util.explainFailure({ message: 'execution reverted', data: '0xdeadbeef' });
        assert.match(t, /^The transaction would fail on-chain, so it was not sent\. \(execution reverted\)$/);
        const long = util.explainFailure(new Error('execution reverted: ' + 'z'.repeat(400)));
        assert.ok(long.includes('z'.repeat(100)));
        assert.ok(long.length < 260, 'message part is cut to 160 chars: ' + long.length);
      });

      it('wallet rejection (code 4001, ACTION_REJECTED, "User rejected/denied") says it was rejected', function () {
        const sentence = 'You rejected the request in your wallet. Nothing was sent.';
        assert.equal(util.explainFailure(Object.assign(new Error('User rejected the request.'), { code: 4001 })), sentence);
        assert.equal(util.explainFailure({ code: 4001 }), sentence);
        assert.equal(util.explainFailure({ code: 'ACTION_REJECTED', message: 'user rejected action' }), sentence);
        assert.equal(util.explainFailure({ code: 'ACTION_REJECTED', message: 'the signer said no' }), sentence); // the code alone is enough
        assert.equal(util.explainFailure({ error: { code: 4001 }, message: 'wrapped' }), sentence);
        assert.equal(util.explainFailure(new Error('MetaMask Tx Signature: User denied transaction signature.')), sentence);
        assert.equal(util.explainFailure(new Error('user rejected transaction')), sentence);
        assert.match(util.explainFailure({ code: 4001 }), /rejected/);
      });

      it('wallet errors: -32002 pending request, 4100 unauthorised, 4902 unknown network', function () {
        assert.match(util.explainFailure({ code: -32002, message: 'Request of type wallet_x already pending' }), /already has a pending request/);
        assert.match(util.explainFailure({ code: 4100 }), /has not authorised this site/);
        assert.match(util.explainFailure({ code: 4902 }), /does not know this network/);
      });

      it('insufficient funds messages', function () {
        const sentence = 'Not enough USDC in this account to cover the amount plus the network fee.';
        assert.equal(util.explainFailure(new Error('insufficient funds for gas * price + value')), sentence);
        assert.equal(util.explainFailure({ code: -32000, message: 'insufficient funds for gas * price + value: address 0xabc have 1 want 2' }), sentence);
        assert.equal(util.explainFailure(new Error('Transfer amount exceeds balance')), sentence);
        assert.equal(util.explainFailure(new Error('Insufficient balance for transfer')), sentence);
      });

      it('network failures: TypeError("Failed to fetch") and friends', function () {
        const sentence = 'Could not reach the Arc RPC. Check your connection and try again.';
        assert.equal(util.explainFailure(new TypeError('Failed to fetch')), sentence);
        assert.equal(util.explainFailure(new TypeError('NetworkError when attempting to fetch resource.')), sentence);
        assert.equal(util.explainFailure(new TypeError('Load failed')), sentence);
        assert.equal(util.explainFailure(new Error('Network request failed')), sentence);
        assert.equal(util.explainFailure(new Error('request timed out')), sentence);
        assert.equal(util.explainFailure(new Error('Request timeout')), sentence);
        assert.equal(util.explainFailure({ code: 'TIMEOUT', message: 'timeout while reading eth_getLogs' }), sentence);
        assert.equal(util.explainFailure(new Error('connect ECONNREFUSED 127.0.0.1:8545')), sentence);
        assert.equal(util.explainFailure(new Error('getaddrinfo ENOTFOUND rpc.example')), sentence);
      });

      it('an unknown message passes through, truncated to 300 characters', function () {
        assert.equal(util.explainFailure(new Error('Something odd happened')), 'Something odd happened');
        assert.equal(util.explainFailure(new Error('x'.repeat(300))), 'x'.repeat(300));
        assert.equal(util.explainFailure(new Error('x'.repeat(301))), 'x'.repeat(300));
        assert.equal(util.explainFailure(new Error('y'.repeat(400))).length, 300);
        assert.equal(util.explainFailure({ message: 'plain object message' }), 'plain object message');
        assert.equal(util.explainFailure({ reason: 'only a reason' }), 'only a reason');
      });

      it('handles a thrown string, null, undefined and empty values', function () {
        assert.equal(util.explainFailure('boom'), 'boom');
        const generic = 'Something went wrong. Please try again.';
        assert.equal(util.explainFailure(null), generic);
        assert.equal(util.explainFailure(undefined), generic);
        assert.equal(util.explainFailure(''), generic);
        assert.equal(util.explainFailure(0), generic);
        assert.equal(util.explainFailure({ code: -32603 }), 'Something went wrong (error code -32603). Please try again.');
        assert.equal(util.explainFailure(Object.create(null)), generic);
        assert.equal(util.explainFailure([]), generic);
      });

      it('revert data wins over the wallet-code and message heuristics', function () {
        const e = { code: 4001, message: 'User rejected', data: dataFor('AlreadyPaid') };
        assert.equal(util.explainFailure(e), already);
      });

      it('always returns a non-empty string', function () {
        const odd = [new Error(''), new Error('0x'), {}, 5, true, () => 1, { message: '' }, { message: 42 }, Object.create(null, { message: { value: 'no prototype' } })];
        odd.forEach((v) => {
          const out = util.explainFailure(v);
          assert.equal(typeof out, 'string');
          assert.ok(out.length > 0);
        });
      });

      it('BUG: an object without message or reason must not be shown as "[object Object]"', function () {
        // String(err) is used as the last resort, so a plain { code } object (for example a wallet rejection without
        // a message) reaches the user as "[object Object]".
        assert.notEqual(util.explainFailure({}), '[object Object]');
        assert.notEqual(util.explainFailure({ code: -32603 }), '[object Object]');
        assert.notEqual(util.explainFailure({ error: { message: 'nested only' } }), '[object Object]');
      });
    });
  });

  // ------------------------------------------------------------------------------------------------- failed tx / rpc url
  describe('failed transactions and custom RPC URLs', function () {
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const dataFor = (name, types, values) => abi.ERROR_SELECTORS[name] + coder.encode(types || [], values || []).slice(2);
    const revertError = (data) => Object.assign(new Error('execution reverted'), { code: 3, data });

    describe('explainFailure: err.userMessage', function () {
      it('a non-empty string userMessage is returned as is, before anything else is looked at', function () {
        assert.equal(util.explainFailure({ userMessage: 'Please pick another network.', code: 4001 }), 'Please pick another network.');
        assert.equal(util.explainFailure({ userMessage: 'Custom text', message: 'x', data: dataFor('AlreadyPaid') }), 'Custom text');
      });

      it('an empty or non-string userMessage is ignored', function () {
        assert.equal(util.explainFailure({ userMessage: '', message: 'plain' }), 'plain');
        assert.equal(util.explainFailure({ userMessage: 5, message: 'plain' }), 'plain');
        assert.equal(util.explainFailure({ userMessage: null, code: 4001 }), 'You rejected the request in your wallet. Nothing was sent.');
      });
    });

    describe('failedOnChainMessage', function () {
      it('without a reason', function () {
        assert.equal(
          util.failedOnChainMessage(null),
          'The transaction failed on chain (reason unknown). Open it in the explorer to look closer. The payment itself did not move; only the network fee was spent.'
        );
        assert.equal(util.failedOnChainMessage(undefined), util.failedOnChainMessage(null));
      });

      it('with a replayFailedTx result', function () {
        assert.equal(
          util.failedOnChainMessage({ sentence: 'This invoice has already been paid.' }),
          'The transaction failed on chain: This invoice has already been paid. The payment itself did not move; only the network fee was spent.'
        );
      });
    });

    describe('replayFailedTx', function () {
      const tx = { from: PAYER, to: CONTRACT, data: abi.encodePay(ID(1)) };
      function fakeClient(script) {
        const calls = [];
        return {
          calls,
          async call(params, blockTag) {
            calls.push({ params, blockTag });
            return script(params, blockTag, calls.length - 1);
          }
        };
      }

      it('replays at the receipt block and decodes the custom error', async function () {
        const client = fakeClient(() => { throw revertError(dataFor('AlreadyPaid')); });
        const r = await util.replayFailedTx(client, tx, { blockNumber: '0x10' });
        assert.equal(r.sentence, 'This invoice has already been paid.');
        assert.equal(r.decoded.name, 'AlreadyPaid');
        assert.equal(client.calls.length, 1);
        assert.equal(client.calls[0].blockTag, '0x10');
        assert.deepEqual(client.calls[0].params, { from: PAYER, to: CONTRACT, data: abi.encodePay(ID(1)) });
      });

      it('passes the value as a hex quantity only when it is not zero', async function () {
        const withValue = fakeClient(() => { throw revertError(dataFor('AlreadyPaid')); });
        await util.replayFailedTx(withValue, Object.assign({ value: 1250000n * SCALE }, tx), { blockNumber: 5 });
        assert.equal(withValue.calls[0].params.value, util.toHex(1250000n * SCALE));
        for (const zero of [0, 0n, '0x0', undefined, null, '']) {
          const c = fakeClient(() => { throw revertError(dataFor('AlreadyPaid')); });
          await util.replayFailedTx(c, Object.assign({ value: zero }, tx), { blockNumber: 5 });
          assert.equal('value' in c.calls[0].params, false, String(zero));
        }
      });

      it('falls back to the block before when the replay at the receipt block shows no decodable error', async function () {
        const client = fakeClient((p, tag, i) => {
          if (i === 0) return '0x'; // the call succeeds at the receipt block (state already changed)
          throw revertError(dataFor('InvoiceExpired', ['uint40'], [1790000000]));
        });
        const r = await util.replayFailedTx(client, tx, { blockNumber: '0x10' });
        assert.deepEqual(client.calls.map((c) => c.blockTag), ['0x10', '0xf']);
        assert.equal(r.decoded.name, 'InvoiceExpired');
        assert.ok(r.sentence.includes('2026-09-21 14:13:20 UTC'));
      });

      it('skips errors that carry no known revert data and keeps trying', async function () {
        const client = fakeClient((p, tag, i) => {
          if (i === 0) throw revertError('0xdeadbeef'); // unknown selector
          if (i === 1) throw new Error('rpc exploded');
          return '0x';
        });
        assert.equal(await util.replayFailedTx(client, tx, { blockNumber: 16 }), null);
        assert.equal(client.calls.length, 2);
      });

      it('returns null when the replay succeeds everywhere', async function () {
        const client = fakeClient(() => '0x');
        assert.equal(await util.replayFailedTx(client, tx, { blockNumber: '0x1' }), null);
        assert.deepEqual(client.calls.map((c) => c.blockTag), ['0x1', '0x0']);
      });

      it('replays only once for block 0', async function () {
        const client = fakeClient(() => '0x');
        assert.equal(await util.replayFailedTx(client, tx, { blockNumber: 0 }), null);
        assert.deepEqual(client.calls.map((c) => c.blockTag), ['0x0']);
      });

      it('accepts hex string, Number and BigInt block numbers', async function () {
        for (const bn of ['0xff', 255, 255n]) {
          const client = fakeClient(() => { throw revertError(dataFor('NotMerchant')); });
          const r = await util.replayFailedTx(client, tx, { blockNumber: bn });
          assert.equal(r.decoded.name, 'NotMerchant');
          assert.equal(client.calls[0].blockTag, '0xff', String(bn));
        }
      });

      it('returns null without calling the client when there is no usable receipt block', async function () {
        for (const receipt of [null, undefined, {}, { blockNumber: null }, { blockNumber: undefined }]) {
          const client = fakeClient(() => { throw new Error('must not be called'); });
          assert.equal(await util.replayFailedTx(client, tx, receipt), null);
          assert.equal(client.calls.length, 0);
        }
      });
    });

    describe('validateRpcUrl', function () {
      it('treats empty input as "no custom URL"', function () {
        [undefined, null, '', '   ', '\t\n'].forEach((v) => assert.deepEqual(util.validateRpcUrl(v), { ok: true, url: '' }));
      });

      it('accepts https URLs and returns the normalised href', function () {
        assert.deepEqual(util.validateRpcUrl('https://rpc.example.org'), { ok: true, url: 'https://rpc.example.org/' });
        assert.deepEqual(util.validateRpcUrl('  https://rpc.example.org/v1/key?x=1  '), { ok: true, url: 'https://rpc.example.org/v1/key?x=1' });
        assert.deepEqual(util.validateRpcUrl('HTTPS://RPC.EXAMPLE.ORG:8443/path'), { ok: true, url: 'https://rpc.example.org:8443/path' });
      });

      it('accepts plain http only for 127.0.0.1 and localhost', function () {
        assert.deepEqual(util.validateRpcUrl('http://127.0.0.1:8545'), { ok: true, url: 'http://127.0.0.1:8545/' });
        assert.deepEqual(util.validateRpcUrl('http://localhost:8545/rpc'), { ok: true, url: 'http://localhost:8545/rpc' });
        ['http://example.com', 'http://127.0.0.1.evil.com:8545', 'http://localhost.evil.com', 'http://192.168.1.5:8545', 'http://evil.com/127.0.0.1'].forEach((u) => {
          const r = util.validateRpcUrl(u);
          assert.equal(r.ok, false, u);
          assert.match(r.error, /https:\/\//);
          assert.equal('url' in r, false);
        });
      });

      it('rejects other schemes', function () {
        ['ftp://example.com', 'ws://localhost:8546', 'wss://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/plain,hi'].forEach((u) => {
          const r = util.validateRpcUrl(u);
          assert.equal(r.ok, false, u);
          assert.equal(typeof r.error, 'string');
        });
      });

      it('rejects text that is not a URL', function () {
        ['not a url', 'example.com', '//example.com', 'https://', 'http//x'].forEach((u) => {
          const r = util.validateRpcUrl(u);
          assert.equal(r.ok, false, u);
          assert.match(r.error, /not a valid URL/);
        });
      });

      it('rejects credentials in the URL', function () {
        ['https://user:pw@rpc.example.org', 'https://user@rpc.example.org', 'http://user:pw@127.0.0.1:8545', 'https://:pw@rpc.example.org'].forEach((u) => {
          const r = util.validateRpcUrl(u);
          assert.equal(r.ok, false, u);
          assert.match(r.error, /user name or password/);
        });
      });
    });
  });

  // ------------------------------------------------------------------------------------------------- display
  describe('display helpers', function () {
    describe('shortAddress', function () {
      it('keeps 6 characters, an ellipsis and the last 4', function () {
        assert.equal(util.shortAddress(MERCHANT), '0xf39F\u20262266');
        assert.equal(util.shortAddress(MERCHANT.toLowerCase()), '0xf39f\u20262266');
        assert.equal(util.shortAddress('0x1234567890'), '0x1234\u20267890'); // 12 chars is the shortest that is shortened
      });

      it('returns short strings and non-strings unchanged / as text', function () {
        assert.equal(util.shortAddress('0x123456789'), '0x123456789'); // 11 chars
        assert.equal(util.shortAddress('0x1234'), '0x1234');
        assert.equal(util.shortAddress(''), '');
        assert.equal(util.shortAddress(null), '');
        assert.equal(util.shortAddress(undefined), '');
        assert.equal(util.shortAddress(5), '5');
      });
    });

    describe('shortHash', function () {
      const h = '0x' + '0123456789abcdef'.repeat(4);

      it('keeps 0x plus 10 hex characters by default', function () {
        assert.equal(util.shortHash(h), '0x0123456789');
        assert.equal(util.shortHash(h).length, 12);
      });

      it('honours the hexChars argument', function () {
        assert.equal(util.shortHash(h, 4), '0x0123');
        assert.equal(util.shortHash(h, 20), '0x0123456789abcdef0123');
        assert.equal(util.shortHash(h, 64), h);
      });

      it('leaves short values alone', function () {
        assert.equal(util.shortHash('0x12'), '0x12');
        assert.equal(util.shortHash('0x0123456789'), '0x0123456789');
        assert.equal(util.shortHash('0x0123456789a'), '0x0123456789'); // one character over the limit is cut
        assert.equal(util.shortHash(''), '');
        assert.equal(util.shortHash(null), '');
        assert.equal(util.shortHash(undefined), '');
        assert.equal(util.shortHash(7), '7');
      });
    });

    describe('formatCount', function () {
      const table = [
        [0, '0'], [7, '7'], [999, '999'], [1500, '1500'], [9999, '9999'],
        [10000, '10k'], [10500, '10.5k'], [12345, '12.3k'], [99999, '100k'], [123456, '123.5k'], [999000, '999k'],
        [1000000, '1M'], [1234567, '1.2M'], [2500000, '2.5M'], [15000000, '15M'], [1e9, '1000M'],
        ['1234567', '1.2M'], [1.4, '1'], [-5, '-5']
      ];
      table.forEach(([input, expected]) => {
        it(JSON.stringify(input) + ' -> ' + expected, function () {
          assert.equal(util.formatCount(input), expected);
        });
      });

      it('below 10,000 the exact number is kept (the comment in util.js says so)', function () {
        assert.equal(util.formatCount(9500), '9500');
      });

      it('values that round up to 1000.0k read 1M, not "1000k"', function () {
        assert.equal(util.formatCount(999999), '1M');
        assert.equal(util.formatCount(999950), '1M');
      });
    });

    describe('explorerUrl', function () {
      const tx = '0x' + 'ab'.repeat(32);

      it('builds Blockscout-style tx and address URLs', function () {
        const net = { explorer: 'https://testnet.arcscan.app' };
        assert.equal(util.explorerUrl(net, 'tx', tx), 'https://testnet.arcscan.app/tx/' + tx);
        assert.equal(util.explorerUrl(net, 'address', MERCHANT), 'https://testnet.arcscan.app/address/' + MERCHANT);
      });

      it('handles one or several trailing slashes', function () {
        assert.equal(util.explorerUrl({ explorer: 'https://x.example/' }, 'tx', 'h'), 'https://x.example/tx/h');
        assert.equal(util.explorerUrl({ explorer: 'https://x.example///' }, 'tx', 'h'), 'https://x.example/tx/h');
        assert.equal(util.explorerUrl({ explorer: 'https://x.example/base/' }, 'address', 'a'), 'https://x.example/base/address/a');
        assert.equal(util.explorerUrl({ explorer: 'https://x.example/base' }, 'address', 'a'), 'https://x.example/base/address/a');
      });

      it('returns "" when the network has no explorer', function () {
        [null, undefined, {}, { explorer: '' }, { explorer: null }, { explorer: undefined }, { name: 'local' }].forEach((n) => {
          assert.equal(util.explorerUrl(n, 'tx', tx), '', JSON.stringify(n));
        });
      });
    });
  });
});
