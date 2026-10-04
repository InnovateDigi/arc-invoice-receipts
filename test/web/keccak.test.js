'use strict';
// Unit tests for web/js/keccak.js: dependency-free Keccak-256 plus the UTF-8 and hex helpers.
// Independent references: ethers v6 (keccak256, id, hexlify), WHATWG TextEncoder/TextDecoder and Node's sha3-256.
// Random inputs come from a seeded PRNG, so every run checks exactly the same values.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ethers } = require('ethers');
const K = require('../../web/js/keccak.js');

const EMPTY_HASH = '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';
const RealTextDecoder = globalThis.TextDecoder;
const BOM = String.fromCodePoint(0xfeff);
const FFFD = String.fromCodePoint(0xfffd); // replacement character

// mulberry32: tiny deterministic PRNG
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(0x4b454343); // "KECC"
const randInt = (n) => Math.floor(rng() * n);
function randBytes(n) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = randInt(256);
  return b;
}
function randCodePoint() {
  // any Unicode scalar value (no surrogates); bias towards the 1/2/3/4 byte classes
  const cls = randInt(4);
  const ranges = [[0, 0x7f], [0x80, 0x7ff], [0x800, 0xffff], [0x10000, 0x10ffff]];
  for (;;) {
    const cp = ranges[cls][0] + randInt(ranges[cls][1] - ranges[cls][0] + 1);
    if (cp < 0xd800 || cp > 0xdfff) return cp;
  }
}
const toHex = (bytes) => ethers.hexlify(bytes);

// Runs fn with the global TextDecoder removed, so utf8Decode takes its hand written fallback loop.
function withoutTextDecoder(fn) {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'TextDecoder');
  delete globalThis.TextDecoder;
  try {
    assert.equal(typeof TextDecoder, 'undefined');
    return fn();
  } finally {
    Object.defineProperty(globalThis, 'TextDecoder', desc);
  }
}

describe('keccak.js', function () {
  describe('Keccak-256 known answers', function () {
    it("keccak256('') is the well known empty-input hash", function () {
      assert.equal(K.keccak256(''), EMPTY_HASH);
      assert.equal(K.keccak256(new Uint8Array(0)), EMPTY_HASH);
      assert.equal(K.keccak256([]), EMPTY_HASH);
      assert.equal(K.keccak256(new ArrayBuffer(0)), EMPTY_HASH);
      assert.equal(K.keccak256Hex('0x'), EMPTY_HASH);
      assert.equal(K.keccak256Hex(''), EMPTY_HASH);
      assert.equal(toHex(K.keccak256Bytes(new Uint8Array(0))), EMPTY_HASH);
    });

    it("keccak256('abc') equals ethers.id('abc') and the published value", function () {
      assert.equal(K.keccak256('abc'), '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
      assert.equal(K.keccak256('abc'), ethers.id('abc'));
    });

    it('matches published vectors (function signature, pangram)', function () {
      assert.equal(
        K.keccak256('transfer(address,uint256)'),
        '0xa9059cbb2ab09eb219583f4a59a5d0623ade346d962bcd4e46b11da047c9049b'
      );
      assert.equal(
        K.keccak256('The quick brown fox jumps over the lazy dog'),
        '0x4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15'
      );
    });

    it('returns a 66 character lowercase 0x string', function () {
      for (let i = 0; i < 50; i++) {
        const h = K.keccak256(randBytes(randInt(300)));
        assert.match(h, /^0x[0-9a-f]{64}$/);
      }
    });

    it('is stateless: interleaved calls give the same answer', function () {
      const a = randBytes(200);
      const b = randBytes(137);
      const ha1 = K.keccak256(a);
      const hb = K.keccak256(b);
      const ha2 = K.keccak256(a);
      assert.equal(ha1, ha2);
      assert.equal(hb, ethers.keccak256(b));
      assert.equal(ha1, ethers.keccak256(a));
    });
  });

  describe('is Keccak, not NIST SHA3-256', function () {
    const sha3 = (data) => '0x' + crypto.createHash('sha3-256').update(data).digest('hex');
    before(function () {
      if (!crypto.getHashes().includes('sha3-256')) this.skip();
    });

    it("Node's sha3-256('') is the NIST value, which keccak256('') is not", function () {
      assert.equal(sha3(''), '0xa7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a');
      assert.notEqual(K.keccak256(''), sha3(''));
    });

    it("keccak256('abc') differs from sha3-256('abc')", function () {
      assert.equal(sha3('abc'), '0x3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532');
      assert.notEqual(K.keccak256('abc'), sha3('abc'));
    });

    it('differs from sha3-256 for every input length 0..300 (padding byte 0x01 vs 0x06)', function () {
      for (let n = 0; n <= 300; n++) {
        const bytes = randBytes(n);
        assert.notEqual(K.keccak256(bytes), sha3(bytes), 'length ' + n);
      }
    });
  });

  describe('against ethers.keccak256', function () {
    it('agrees for random byte arrays of EVERY length 0..600', function () {
      for (let n = 0; n <= 600; n++) {
        const bytes = randBytes(n);
        assert.equal(K.keccak256(bytes), ethers.keccak256(bytes), 'length ' + n);
      }
    });

    it('agrees for every length 0..600 with an all-zero and an all-0xff input', function () {
      for (let n = 0; n <= 600; n++) {
        const zeros = new Uint8Array(n);
        const ones = new Uint8Array(n).fill(0xff);
        assert.equal(K.keccak256(zeros), ethers.keccak256(zeros), 'zeros, length ' + n);
        assert.equal(K.keccak256(ones), ethers.keccak256(ones), 'ones, length ' + n);
      }
    });

    // The sponge rate is 136 bytes: these lengths sit right on the block and padding boundaries.
    const boundaries = {
      135: 'rate - 1: the 0x01 padding bit and the final 0x80 share the last byte',
      136: 'exactly one full block: padding goes into a second, otherwise empty block',
      137: 'rate + 1: one byte spills into a second block',
      271: '2 * rate - 1 (padding bytes share the last byte of block 2)',
      272: '2 * rate (two full blocks, padding block follows)',
      273: '2 * rate + 1'
    };
    Object.keys(boundaries).forEach(function (len) {
      const n = Number(len);
      it('rate boundary: ' + n + ' bytes (' + boundaries[len] + ')', function () {
        const patterns = {
          zeros: new Uint8Array(n),
          ones: new Uint8Array(n).fill(0xff),
          ramp: Uint8Array.from({ length: n }, (_, i) => i & 255),
          random: randBytes(n)
        };
        Object.keys(patterns).forEach(function (name) {
          assert.equal(K.keccak256(patterns[name]), ethers.keccak256(patterns[name]), name);
        });
        assert.equal(K.keccak256Hex(toHex(patterns.random)), ethers.keccak256(patterns.random));
        const asString = 'x'.repeat(n);
        assert.equal(K.keccak256(asString), ethers.id(asString), 'ascii string');
      });
    });

    it('agrees for larger inputs (1 KiB, 4 KiB, 10001 bytes, 100003 bytes)', function () {
      this.timeout(20000);
      [1024, 4096, 10001, 100003].forEach(function (n) {
        const bytes = randBytes(n);
        assert.equal(K.keccak256(bytes), ethers.keccak256(bytes), 'length ' + n);
      });
    });

    it('agrees for one million repeated bytes', function () {
      this.timeout(30000);
      const bytes = new Uint8Array(1000000).fill(0x61);
      assert.equal(K.keccak256(bytes), ethers.keccak256(bytes));
    });
  });

  describe('strings are hashed as UTF-8', function () {
    const samples = {
      'empty string': '',
      'plain ascii': 'Invoice #2024-0001: 1250.00 USDC',
      'latin accents': 'café crème brûlée àéîõü ÿ Ñandú ß',
      'greek and cyrillic': 'Ελληνικά Привет мир',
      CJK: '你好，世界 日本語のテキスト 한국어 텍스트',
      'arabic and hebrew (right to left)': 'مرحبا بالعالم שלום עולם',
      'emoji (astral plane, surrogate pairs)': '\u{1F600} \u{1F680} \u{1F4B8} \u{1F9FE}',
      'emoji ZWJ family sequence': '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}',
      'regional indicator flags': '\u{1F1FA}\u{1F1F8}\u{1F1E9}\u{1F1EA}',
      'astral math letters': '\u{1D4B3}\u{1D4CE}\u{1D4CF} \u{1D518}\u{1D52B}\u{1D526}',
      'combining marks (NFD)': 'é ä ñ ộ',
      'precomposed (NFC)': 'é ä ñ ộ',
      'NUL inside': 'a\u0000b',
      'one code point per UTF-8 length class edge': '\u007f\u0080߿ࠀ￿\u{10000}\u{10FFFF}',
      'BOM and line separators': BOM + 'abc' + String.fromCodePoint(0x2028, 0x2029),
      'long mixed text over 1000 bytes': 'ab€\u{1D4B3}é'.repeat(100)
    };
    Object.keys(samples).forEach(function (name) {
      it(name + ': keccak256, utf8Encode and a round trip agree with ethers / TextEncoder', function () {
        const s = samples[name];
        assert.equal(K.keccak256(s), ethers.id(s));
        assert.equal(K.keccak256(s), ethers.keccak256(new TextEncoder().encode(s)));
        assert.deepEqual(Array.from(K.utf8Encode(s)), Array.from(new TextEncoder().encode(s)));
        assert.deepEqual(Array.from(K.utf8Encode(s)), Array.from(ethers.toUtf8Bytes(s)));
      });
    });

    it('NFC and NFD spellings of the same text hash differently (no normalisation), each equal to ethers', function () {
      const nfc = 'café';
      const nfd = 'café';
      assert.equal(nfc.normalize('NFD'), nfd);
      assert.notEqual(K.keccak256(nfc), K.keccak256(nfd));
      assert.equal(K.keccak256(nfc), ethers.id(nfc));
      assert.equal(K.keccak256(nfd), ethers.id(nfd));
    });

    it('300 random strings of valid code points agree with ethers.id and TextEncoder', function () {
      for (let i = 0; i < 300; i++) {
        let s = '';
        const len = randInt(60);
        for (let j = 0; j < len; j++) s += String.fromCodePoint(randCodePoint());
        assert.equal(K.keccak256(s), ethers.id(s), 'case ' + i);
        assert.deepEqual(Array.from(K.utf8Encode(s)), Array.from(new TextEncoder().encode(s)), 'case ' + i);
      }
    });

    it('a string and the same string as UTF-8 bytes hash identically', function () {
      const s = 'Héllo 世界 \u{1F680}';
      const bytes = new TextEncoder().encode(s);
      assert.equal(K.keccak256(s), K.keccak256(bytes));
      assert.equal(K.keccak256(s), K.keccak256(Array.from(bytes)));
      assert.equal(K.keccak256(s), K.keccak256(bytes.buffer));
    });
  });

  describe('lone surrogates behave like TextEncoder (U+FFFD)', function () {
    const cases = {
      'lone high surrogate': '\ud800',
      'lone low surrogate': '\udc00',
      'high surrogate at the end': 'abc\ud83d',
      'high surrogate at the start, then ascii': '\ud83dabc',
      'low surrogate in the middle': 'ab\ude00cd',
      'two high surrogates in a row': '\ud800\ud800',
      'reversed pair (low then high)': '\ude00\ud83d',
      'high surrogate then a high surrogate that starts a valid pair': '\ud800😀',
      'valid pair then a lone low surrogate': '😀\ude00',
      'high surrogate then BMP char': '\ud83dé',
      'lone surrogates around a valid pair': '\udbff\u{1F600}\udc00'
    };
    const te = new TextEncoder();
    Object.keys(cases).forEach(function (name) {
      it(name, function () {
        const s = cases[name];
        const want = te.encode(s);
        assert.ok(want.length > 0);
        assert.deepEqual(Array.from(K.utf8Encode(s)), Array.from(want));
        assert.equal(K.keccak256(s), ethers.keccak256(want));
      });
    });

    it('a lone surrogate encodes as EF BF BD and hashes like U+FFFD', function () {
      assert.deepEqual(Array.from(K.utf8Encode('\ud800')), [0xef, 0xbf, 0xbd]);
      assert.deepEqual(Array.from(K.utf8Encode('\udfff')), [0xef, 0xbf, 0xbd]);
      assert.equal(K.keccak256('\ud800'), K.keccak256(FFFD));
      assert.equal(K.keccak256('a\udc00b'), K.keccak256('a' + FFFD + 'b'));
    });

    it('400 random UTF-16 strings (any code unit, surrogates included) match TextEncoder', function () {
      for (let i = 0; i < 400; i++) {
        const units = [];
        const len = randInt(40);
        for (let j = 0; j < len; j++) {
          // 40% of the units come from the surrogate range so pairs and lone halves both occur
          units.push(randInt(10) < 4 ? 0xd800 + randInt(0x800) : randInt(0x10000));
        }
        const s = String.fromCharCode.apply(null, units);
        const want = new TextEncoder().encode(s);
        assert.deepEqual(Array.from(K.utf8Encode(s)), Array.from(want), 'case ' + i);
        assert.equal(K.keccak256(s), ethers.keccak256(want), 'case ' + i);
      }
    });
  });

  describe('accepted and rejected input types', function () {
    it('accepts a Uint8Array', function () {
      const b = randBytes(90);
      assert.equal(K.keccak256(b), ethers.keccak256(b));
    });

    it('accepts an ArrayBuffer', function () {
      const b = randBytes(300);
      const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      assert.ok(ab instanceof ArrayBuffer);
      assert.equal(K.keccak256(ab), ethers.keccak256(b));
    });

    it('accepts an array of numbers (also across several blocks)', function () {
      [0, 1, 135, 136, 137, 400].forEach(function (n) {
        const b = randBytes(n);
        assert.equal(K.keccak256(Array.from(b)), ethers.keccak256(b), 'length ' + n);
      });
    });

    it('accepts a subarray view with a non-zero byteOffset and ignores bytes outside the view', function () {
      const big = randBytes(500);
      [[13, 150], [1, 136], [5, 137], [100, 272], [0, 0], [7, 1]].forEach(function (spec) {
        const view = big.subarray(spec[0], spec[0] + spec[1]);
        assert.equal(view.byteOffset, spec[0]);
        const want = ethers.keccak256(Uint8Array.from(view));
        assert.equal(K.keccak256(view), want, 'offset ' + spec[0] + ' length ' + spec[1]);
        const copy = Uint8Array.from(big);
        // flip bytes just outside the view: the hash must not change
        if (spec[0] > 0) copy[spec[0] - 1] ^= 0xff;
        if (spec[0] + spec[1] < copy.length) copy[spec[0] + spec[1]] ^= 0xff;
        assert.equal(K.keccak256(copy.subarray(spec[0], spec[0] + spec[1])), want);
      });
    });

    it('accepts a Node Buffer that lives in the shared pool (non-zero byteOffset)', function () {
      const b = Buffer.from('hello pooled buffer');
      assert.equal(K.keccak256(b), ethers.id('hello pooled buffer'));
      const c = Buffer.concat([Buffer.alloc(3), Buffer.from(randBytes(140))]).subarray(3);
      assert.equal(K.keccak256(c), ethers.keccak256(Uint8Array.from(c)));
    });

    it('hashes other typed arrays and a DataView by their underlying bytes', function () {
      const u16 = new Uint16Array([1, 2, 3, 0xffff, 0x1234]);
      const f64 = new Float64Array([1.5, -2.25, 3e100]);
      const base = new Uint8Array(100);
      base.set(randBytes(100));
      const dv = new DataView(base.buffer, 10, 60);
      const viewBytes = (v) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      assert.equal(K.keccak256(u16), ethers.keccak256(viewBytes(u16)));
      assert.equal(K.keccak256(f64), ethers.keccak256(viewBytes(f64)));
      assert.equal(K.keccak256(dv), ethers.keccak256(base.subarray(10, 70)));
      const u16sub = new Uint16Array(new ArrayBuffer(40), 8, 6);
      assert.equal(K.keccak256(u16sub), ethers.keccak256(viewBytes(u16sub)));
    });

    it('does not modify its input', function () {
      const b = randBytes(260);
      const copy = Uint8Array.from(b);
      K.keccak256(b);
      K.keccak256Bytes(b);
      assert.deepEqual(Array.from(b), Array.from(copy));
      const arr = Array.from(copy);
      K.keccak256(arr);
      assert.deepEqual(arr, Array.from(copy));
    });

    const bad = {
      undefined: undefined,
      null: null,
      'a number': 123,
      zero: 0,
      'a bigint': 12n,
      'a boolean': true,
      'a plain object': {},
      'an array-like object': { length: 3, 0: 1, 1: 2, 2: 3 },
      'a Set': new Set([1, 2, 3]),
      'a Map': new Map(),
      'a function': function () {},
      'a symbol': Symbol('x'),
      'a boxed String': new String('abc'),
      'a Date': new Date(0),
      'a RegExp': /abc/
    };
    Object.keys(bad).forEach(function (name) {
      it('rejects ' + name + ' with a TypeError', function () {
        assert.throws(() => K.keccak256(bad[name]), TypeError);
      });
    });
  });

  describe('keccak256Hex', function () {
    it('equals ethers.keccak256 for random byte lengths 0..300 (with 0x prefix)', function () {
      for (let n = 0; n <= 300; n++) {
        const bytes = randBytes(n);
        assert.equal(K.keccak256Hex(toHex(bytes)), ethers.keccak256(bytes), 'length ' + n);
      }
    });

    it('accepts hex without prefix, with an upper case body and with a 0X prefix', function () {
      for (let i = 0; i < 40; i++) {
        const bytes = randBytes(1 + randInt(200));
        const h = toHex(bytes);
        const want = ethers.keccak256(bytes);
        assert.equal(K.keccak256Hex(h.slice(2)), want);
        assert.equal(K.keccak256Hex('0x' + h.slice(2).toUpperCase()), want);
        assert.equal(K.keccak256Hex('0X' + h.slice(2)), want);
      }
    });

    it('is not the hash of the hex text: keccak256Hex("0x00") != keccak256("0x00")', function () {
      assert.notEqual(K.keccak256Hex('0x00'), K.keccak256('0x00'));
      assert.equal(K.keccak256Hex('0x00'), ethers.keccak256('0x00'));
    });

    it('throws on odd length or non hex input', function () {
      ['0x1', '0x123', 'abc', '0xzz', 'xyz!', '0x12 34', ' 0x12'].forEach(function (bad) {
        assert.throws(() => K.keccak256Hex(bad), /invalid hex/, JSON.stringify(bad));
      });
    });
  });

  describe('keccak256Bytes', function () {
    it('returns a 32 byte Uint8Array equal to the ethers digest, for lengths 0..300', function () {
      for (let n = 0; n <= 300; n++) {
        const bytes = randBytes(n);
        const out = K.keccak256Bytes(bytes);
        assert.ok(out instanceof Uint8Array);
        assert.equal(out.length, 32);
        assert.equal(toHex(out), ethers.keccak256(bytes), 'length ' + n);
      }
    });

    it('works on subarray views and Buffers and returns a fresh array every call', function () {
      const big = randBytes(400);
      const view = big.subarray(21, 21 + 137);
      const a = K.keccak256Bytes(view);
      const b = K.keccak256Bytes(Uint8Array.from(view));
      assert.deepEqual(Array.from(a), Array.from(b));
      assert.notEqual(a, b);
      a.fill(0);
      assert.equal(toHex(K.keccak256Bytes(view)), ethers.keccak256(Uint8Array.from(view)));
      const buf = Buffer.from(big.subarray(0, 136));
      assert.equal(toHex(K.keccak256Bytes(buf)), ethers.keccak256(Uint8Array.from(buf)));
    });
  });

  describe('utf8Encode / utf8Decode', function () {
    it('utf8Encode returns a Uint8Array', function () {
      const out = K.utf8Encode('abcé');
      assert.ok(out instanceof Uint8Array);
      assert.deepEqual(Array.from(out), [0x61, 0x62, 0x63, 0xc3, 0xa9]);
      assert.equal(K.utf8Encode('').length, 0);
    });

    it('utf8Encode: 1, 2, 3 and 4 byte class edges are exact', function () {
      const expect = {
        '\u0000': [0x00],
        '\u007f': [0x7f],
        '\u0080': [0xc2, 0x80],
        '߿': [0xdf, 0xbf],
        'ࠀ': [0xe0, 0xa0, 0x80],
        '퟿': [0xed, 0x9f, 0xbf],
        '': [0xee, 0x80, 0x80],
        '￿': [0xef, 0xbf, 0xbf],
        '\u{10000}': [0xf0, 0x90, 0x80, 0x80],
        '\u{10FFFF}': [0xf4, 0x8f, 0xbf, 0xbf]
      };
      Object.keys(expect).forEach(function (s) {
        assert.deepEqual(Array.from(K.utf8Encode(s)), expect[s], 'U+' + s.codePointAt(0).toString(16));
      });
    });

    it('utf8Decode(utf8Encode(s)) === s for random valid strings, and equals TextDecoder', function () {
      for (let i = 0; i < 300; i++) {
        let s = '';
        const len = randInt(50);
        for (let j = 0; j < len; j++) {
          s += String.fromCodePoint(randCodePoint());
        }
        if (s.charCodeAt(0) === 0xfeff) s = 'x' + s; // a leading BOM is covered by its own test below
        const bytes = K.utf8Encode(s);
        assert.equal(K.utf8Decode(bytes), s, 'case ' + i);
        assert.equal(K.utf8Decode(bytes), new TextDecoder().decode(new TextEncoder().encode(s)), 'case ' + i);
      }
    });

    it('utf8Decode round trips the named samples (accents, CJK, emoji, combining marks)', function () {
      ['café', '你好，世界', '\u{1F600}\u{1F680}', 'é', 'a\u0000b', '\u{10FFFF}', ''].forEach(function (s) {
        assert.equal(K.utf8Decode(K.utf8Encode(s)), s);
      });
    });

    it('utf8Decode of a subarray view and of arbitrary (invalid) bytes equals TextDecoder', function () {
      for (let i = 0; i < 200; i++) {
        const bytes = randBytes(randInt(40));
        const view = new Uint8Array(bytes.length + 6);
        view.set(bytes, 3);
        assert.equal(K.utf8Decode(view.subarray(3, 3 + bytes.length)), new TextDecoder('utf-8').decode(bytes), 'case ' + i);
      }
    });

    it('utf8Decode maps invalid UTF-8 to U+FFFD (uses TextDecoder)', function () {
      assert.equal(K.utf8Decode(Uint8Array.from([0x61, 0xff, 0x62])), 'a' + FFFD + 'b');
      assert.equal(K.utf8Decode(Uint8Array.from([0xc3, 0x28])), FFFD + '(');
      assert.equal(K.utf8Decode(Uint8Array.from([0xed, 0xa0, 0x80])), FFFD.repeat(3));
    });

    // BUG (reported): TextDecoder('utf-8') strips a leading U+FEFF unless { ignoreBOM: true } is passed, so the
    // round trip is lossy for a string that starts with U+FEFF (and the fallback loop below keeps it: inconsistent).
    it('utf8Decode(utf8Encode(s)) keeps a leading U+FEFF (round trip is lossless)', function () {
      const s = BOM + 'abc';
      assert.deepEqual(Array.from(K.utf8Encode(s)), [0xef, 0xbb, 0xbf, 0x61, 0x62, 0x63]);
      assert.equal(K.utf8Decode(K.utf8Encode(s)), s);
    });
  });

  describe('utf8Decode fallback (no TextDecoder, the hand written loop)', function () {
    it('round trips valid text exactly (all UTF-8 length classes, 300 random strings)', function () {
      const fixed = ['', 'abc', 'café', '你好', '\u{1F600}', '\u007f\u0080߿ࠀ￿\u{10000}\u{10FFFF}', 'é'];
      withoutTextDecoder(function () {
        fixed.forEach((s) => assert.equal(K.utf8Decode(new TextEncoder().encode(s)), s));
        for (let i = 0; i < 300; i++) {
          let s = '';
          const len = randInt(50);
          for (let j = 0; j < len; j++) s += String.fromCodePoint(randCodePoint());
          assert.equal(K.utf8Decode(new TextEncoder().encode(s)), s, 'case ' + i);
        }
      });
    });

    it('decodes valid text from a subarray view', function () {
      const s = 'xé世\u{1F680}y';
      const enc = new TextEncoder().encode(s);
      const padded = new Uint8Array(enc.length + 8);
      padded.set(enc, 4);
      withoutTextDecoder(() => assert.equal(K.utf8Decode(padded.subarray(4, 4 + enc.length)), s));
    });

    it('maps bytes that can never occur in UTF-8 (80, C0, C1, F5..FF) to U+FFFD', function () {
      withoutTextDecoder(function () {
        [[0x80], [0xbf], [0xc0, 0x80], [0xc1, 0xbf], [0xf5], [0xf8], [0xfe], [0xff], [0x61, 0xff, 0x62]].forEach(function (b) {
          const want = new RealTextDecoder('utf-8').decode(Uint8Array.from(b));
          assert.equal(K.utf8Decode(Uint8Array.from(b)), want, JSON.stringify(b));
        });
      });
    });

    it('turns truncated multi-byte sequences into U+FFFD only (no garbage characters)', function () {
      withoutTextDecoder(function () {
        [[0xe2, 0x82], [0xf0, 0x9f, 0x98], [0xc3], [0xe2], [0xf0]].forEach(function (b) {
          const out = K.utf8Decode(Uint8Array.from(b));
          assert.ok(out.length >= 1, JSON.stringify(b));
          assert.equal(out, FFFD.repeat(out.length), JSON.stringify(b));
        });
      });
    });

    // Compares the fallback loop with the WHATWG decoder; returns one line per input that differs. Runs of U+FFFD are
    // collapsed first: how many replacement characters a bad sequence yields is a detail, WRONG characters are the bug.
    function fallbackMismatches(cases) {
      const collapse = (str) => str.replace(new RegExp(FFFD + '+', 'g'), FFFD);
      const cps = (str) => Array.from(str, (c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ');
      const out = [];
      cases.forEach(function (b) {
        const bytes = Uint8Array.from(b);
        const want = new RealTextDecoder('utf-8').decode(bytes);
        const got = withoutTextDecoder(() => K.utf8Decode(bytes));
        if (collapse(got) !== collapse(want)) {
          out.push(b.map((x) => x.toString(16).padStart(2, '0')).join(' ') + ' -> got [' + cps(got) + '], want [' + cps(want) + ']');
        }
      });
      return out;
    }

    // BUG (reported): the fallback never validates continuation bytes, so malformed input decodes to wrong
    // characters instead of U+FFFD ("invalid sequences become U+FFFD" says the doc comment).
    it('a lead byte followed by a non continuation byte gives U+FFFD (C3 28 -> U+FFFD "(")', function () {
      assert.deepEqual(
        fallbackMismatches([[0xc3, 0x28], [0xe2, 0x28, 0xa1], [0xe2, 0x82, 0x28], [0xf0, 0x9f, 0x98, 0x28], [0xdf, 0x41], [0xc2, 0xc2, 0xa9]]),
        []
      );
    });

    // BUG (reported): overlong forms, encoded surrogates and code points above U+10FFFF are accepted or mangled.
    it('overlong forms, encoded surrogates and values above U+10FFFF give U+FFFD (E0 80 80, ED A0 80, F4 90 80 80)', function () {
      assert.deepEqual(
        fallbackMismatches([
          [0xe0, 0x80, 0x80], [0xe0, 0x9f, 0xbf], [0xed, 0xa0, 0x80], [0xed, 0xbf, 0xbf],
          [0xf0, 0x80, 0x80, 0x80], [0xf0, 0x8f, 0xbf, 0xbf], [0xf4, 0x90, 0x80, 0x80]
        ]),
        []
      );
    });
  });

  describe('bytesToHex / hexToBytes', function () {
    it('bytesToHex is lowercase 0x hex and equals ethers.hexlify for lengths 0..200', function () {
      for (let n = 0; n <= 200; n++) {
        const bytes = randBytes(n);
        const h = K.bytesToHex(bytes);
        assert.equal(h, ethers.hexlify(bytes), 'length ' + n);
        assert.match(h, /^0x([0-9a-f]{2})*$/);
      }
    });

    it('bytesToHex of an empty array is "0x" and every single byte value is two digits', function () {
      assert.equal(K.bytesToHex(new Uint8Array(0)), '0x');
      for (let v = 0; v < 256; v++) {
        assert.equal(K.bytesToHex(Uint8Array.of(v)), '0x' + v.toString(16).padStart(2, '0'));
      }
      assert.equal(K.bytesToHex([0, 15, 16, 255]), '0x000f10ff');
      assert.equal(K.bytesToHex(Buffer.from('abc')), '0x616263');
    });

    it('hexToBytes(bytesToHex(b)) round trips, with and without the 0x prefix, for lengths 0..200', function () {
      for (let n = 0; n <= 200; n++) {
        const bytes = randBytes(n);
        const h = K.bytesToHex(bytes);
        const back = K.hexToBytes(h);
        assert.ok(back instanceof Uint8Array);
        assert.deepEqual(Array.from(back), Array.from(bytes), 'prefixed, length ' + n);
        assert.deepEqual(Array.from(K.hexToBytes(h.slice(2))), Array.from(bytes), 'bare, length ' + n);
        assert.deepEqual(Array.from(K.hexToBytes(h.toUpperCase().replace('0X', '0x'))), Array.from(bytes), 'upper case');
        assert.deepEqual(Array.from(K.hexToBytes('0X' + h.slice(2))), Array.from(bytes), '0X prefix');
      }
    });

    it('hexToBytes of "" and "0x" is an empty Uint8Array', function () {
      assert.equal(K.hexToBytes('').length, 0);
      assert.equal(K.hexToBytes('0x').length, 0);
      assert.ok(K.hexToBytes('0x') instanceof Uint8Array);
    });

    it('hexToBytes accepts mixed case digits', function () {
      assert.deepEqual(Array.from(K.hexToBytes('0xaBcDeF01')), [0xab, 0xcd, 0xef, 0x01]);
    });

    it('hexToBytes throws on odd length', function () {
      ['0x1', '0x123', '1', 'abc', '0xabcde', '0x' + 'a'.repeat(63)].forEach(function (h) {
        assert.throws(() => K.hexToBytes(h), /invalid hex/, JSON.stringify(h));
      });
    });

    it('hexToBytes throws on non hex input', function () {
      [
        '0xzz', '0x12g4', 'hello!', '0x 12', '0x12 ', ' 0x12', '0x12\n', '0x-1', '0x1_2', '0x0x12', 'xx', '0xg', '0x+1',
        '0x12.5', '١٢', '0xéé'
      ].forEach(function (h) {
        assert.throws(() => K.hexToBytes(h), /invalid hex/, JSON.stringify(h));
      });
    });

    it('hexToBytes throws for null and undefined (they stringify to non hex text)', function () {
      assert.throws(() => K.hexToBytes(null), /invalid hex/);
      assert.throws(() => K.hexToBytes(undefined), /invalid hex/);
      assert.throws(() => K.hexToBytes({}), /invalid hex/);
    });
  });

  describe('exports and classic <script> loading', function () {
    it('exports exactly the documented functions', function () {
      assert.deepEqual(Object.keys(K).sort(), ['bytesToHex', 'hexToBytes', 'keccak256', 'keccak256Bytes', 'keccak256Hex', 'utf8Decode', 'utf8Encode']);
      Object.keys(K).forEach((k) => assert.equal(typeof K[k], 'function', k));
    });

    it('without CommonJS it attaches itself to ArcInvoice.keccak on the global object', function () {
      const src = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'js', 'keccak.js'), 'utf8');
      const ctx = vm.createContext({});
      vm.runInContext(src, ctx, { filename: 'keccak.js' });
      assert.equal(typeof ctx.ArcInvoice, 'object');
      assert.deepEqual(Array.from(Object.keys(ctx.ArcInvoice.keccak)).sort(), Object.keys(K).sort());
      assert.equal(ctx.ArcInvoice.keccak.keccak256('abc'), ethers.id('abc'));
      assert.equal(ctx.ArcInvoice.keccak.keccak256(''), EMPTY_HASH);
      // this context has no TextDecoder, so this also runs the fallback decoder as a browser without it would
      assert.equal(typeof ctx.TextDecoder, 'undefined');
      assert.equal(ctx.ArcInvoice.keccak.utf8Decode(new TextEncoder().encode('café \u{1F680}')), 'café \u{1F680}');
    });

    it('keeps other members of an existing ArcInvoice global when it loads', function () {
      const src = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'js', 'keccak.js'), 'utf8');
      const ctx = vm.createContext({ ArcInvoice: { marker: 42 } });
      vm.runInContext(src, ctx, { filename: 'keccak.js' });
      assert.equal(ctx.ArcInvoice.marker, 42);
      assert.equal(typeof ctx.ArcInvoice.keccak.keccak256, 'function');
    });
  });
});
