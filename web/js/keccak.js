/*
 * Keccak-256 (the original Keccak padding used by Ethereum, NOT NIST SHA3-256), dependency free.
 * Plus the small UTF-8 and hex helpers the other modules need.
 * Works as a classic <script> (adds ArcInvoice.keccak) and as a CommonJS module.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ArcInvoice = Object.assign(root.ArcInvoice || {}, { keccak: factory() });
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 24 round constants, each as (low 32 bits, high 32 bits).
  var RC = new Int32Array([
    0x00000001, 0x00000000, 0x00008082, 0x00000000, 0x0000808a, 0x80000000, 0x80008000, 0x80000000,
    0x0000808b, 0x00000000, 0x80000001, 0x00000000, 0x80008081, 0x80000000, 0x00008009, 0x80000000,
    0x0000008a, 0x00000000, 0x00000088, 0x00000000, 0x80008009, 0x00000000, 0x8000000a, 0x00000000,
    0x8000808b, 0x00000000, 0x0000008b, 0x80000000, 0x00008089, 0x80000000, 0x00008003, 0x80000000,
    0x00008002, 0x80000000, 0x00000080, 0x80000000, 0x0000800a, 0x00000000, 0x8000000a, 0x80000000,
    0x80008081, 0x80000000, 0x00008080, 0x80000000, 0x80000001, 0x00000000, 0x80008008, 0x80000000
  ]);
  var ROTC = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
  var PILN = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
  var RATE = 136; // bytes absorbed per block for a 256-bit output

  // Keccak-f[1600]. State: 25 lanes, lane i = (lo: s[2i], hi: s[2i+1]) as signed 32-bit ints.
  function keccakF(s) {
    var bcLo = new Int32Array(5);
    var bcHi = new Int32Array(5);
    var i, j, tl, th, bl, bh, rl, rh, n, m, l1, h1;
    for (var round = 0; round < 24; round++) {
      // theta
      for (i = 0; i < 5; i++) {
        bcLo[i] = s[2 * i] ^ s[2 * (i + 5)] ^ s[2 * (i + 10)] ^ s[2 * (i + 15)] ^ s[2 * (i + 20)];
        bcHi[i] = s[2 * i + 1] ^ s[2 * (i + 5) + 1] ^ s[2 * (i + 10) + 1] ^ s[2 * (i + 15) + 1] ^ s[2 * (i + 20) + 1];
      }
      for (i = 0; i < 5; i++) {
        l1 = bcLo[(i + 1) % 5];
        h1 = bcHi[(i + 1) % 5];
        tl = bcLo[(i + 4) % 5] ^ ((l1 << 1) | (h1 >>> 31));
        th = bcHi[(i + 4) % 5] ^ ((h1 << 1) | (l1 >>> 31));
        for (j = 0; j < 25; j += 5) {
          s[2 * (j + i)] ^= tl;
          s[2 * (j + i) + 1] ^= th;
        }
      }
      // rho and pi
      tl = s[2];
      th = s[3];
      for (i = 0; i < 24; i++) {
        j = PILN[i];
        bl = s[2 * j];
        bh = s[2 * j + 1];
        n = ROTC[i];
        if (n < 32) {
          rl = (tl << n) | (th >>> (32 - n));
          rh = (th << n) | (tl >>> (32 - n));
        } else if (n === 32) {
          rl = th;
          rh = tl;
        } else {
          m = n - 32;
          rl = (th << m) | (tl >>> (32 - m));
          rh = (tl << m) | (th >>> (32 - m));
        }
        s[2 * j] = rl;
        s[2 * j + 1] = rh;
        tl = bl;
        th = bh;
      }
      // chi
      for (j = 0; j < 25; j += 5) {
        for (i = 0; i < 5; i++) {
          bcLo[i] = s[2 * (j + i)];
          bcHi[i] = s[2 * (j + i) + 1];
        }
        for (i = 0; i < 5; i++) {
          s[2 * (j + i)] ^= ~bcLo[(i + 1) % 5] & bcLo[(i + 2) % 5];
          s[2 * (j + i) + 1] ^= ~bcHi[(i + 1) % 5] & bcHi[(i + 2) % 5];
        }
      }
      // iota
      s[0] ^= RC[2 * round];
      s[1] ^= RC[2 * round + 1];
    }
  }

  function absorb(state, bytes, offset) {
    for (var w = 0; w < RATE / 4; w++) {
      var o = offset + 4 * w;
      state[w] ^= bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24);
    }
  }

  /** Keccak-256 of a Uint8Array. Returns a 32-byte Uint8Array. */
  function keccak256Bytes(bytes) {
    var state = new Int32Array(50);
    var len = bytes.length;
    var offset = 0;
    while (len - offset >= RATE) {
      absorb(state, bytes, offset);
      keccakF(state);
      offset += RATE;
    }
    var block = new Uint8Array(RATE);
    block.set(bytes.subarray(offset));
    block[len - offset] ^= 0x01; // Keccak padding (SHA3 would use 0x06)
    block[RATE - 1] ^= 0x80;
    absorb(state, block, 0);
    keccakF(state);
    var out = new Uint8Array(32);
    for (var i = 0; i < 8; i++) {
      var word = state[i];
      out[4 * i] = word & 255;
      out[4 * i + 1] = (word >>> 8) & 255;
      out[4 * i + 2] = (word >>> 16) & 255;
      out[4 * i + 3] = (word >>> 24) & 255;
    }
    return out;
  }

  /** UTF-8 encode. Lone surrogates become U+FFFD (same as TextEncoder). */
  function utf8Encode(str) {
    str = String(str);
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var d = str.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
          i++;
        } else {
          c = 0xfffd;
        }
      } else if (c >= 0xd800 && c <= 0xdfff) {
        c = 0xfffd;
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return Uint8Array.from(out);
  }

  /** UTF-8 decode following the WHATWG rules: invalid, overlong and surrogate sequences become U+FFFD; a leading BOM is kept. */
  function utf8Decode(bytes) {
    if (typeof TextDecoder === 'function') return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
    var out = '';
    var i = 0;
    while (i < bytes.length) {
      var b = bytes[i];
      var cp;
      var need;
      var lower = 0x80;
      var upper = 0xbf;
      if (b <= 0x7f) {
        out += String.fromCharCode(b);
        i++;
        continue;
      }
      if (b >= 0xc2 && b <= 0xdf) {
        need = 1;
        cp = b & 0x1f;
      } else if (b >= 0xe0 && b <= 0xef) {
        need = 2;
        cp = b & 0x0f;
        if (b === 0xe0) lower = 0xa0;
        if (b === 0xed) upper = 0x9f;
      } else if (b >= 0xf0 && b <= 0xf4) {
        need = 3;
        cp = b & 0x07;
        if (b === 0xf0) lower = 0x90;
        if (b === 0xf4) upper = 0x8f;
      } else {
        out += '�';
        i++;
        continue;
      }
      i++;
      var ok = true;
      for (var k = 0; k < need; k++) {
        var c = bytes[i];
        if (c === undefined || c < lower || c > upper) {
          ok = false;
          break;
        }
        lower = 0x80;
        upper = 0xbf;
        cp = (cp << 6) | (c & 0x3f);
        i++;
      }
      out += ok ? String.fromCodePoint(cp) : '�';
    }
    return out;
  }

  var HEX = '0123456789abcdef';

  /** Uint8Array -> lowercase 0x-prefixed hex. */
  function bytesToHex(bytes) {
    var s = '0x';
    for (var i = 0; i < bytes.length; i++) s += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
    return s;
  }

  /** '0x...' or bare hex (even length) -> Uint8Array. Throws on anything else. */
  function hexToBytes(hex) {
    var h = String(hex);
    if (h.slice(0, 2) === '0x' || h.slice(0, 2) === '0X') h = h.slice(2);
    if (h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) throw new Error('invalid hex string');
    var out = new Uint8Array(h.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(h.substr(2 * i, 2), 16);
    return out;
  }

  function toBytes(input) {
    if (typeof input === 'string') return utf8Encode(input);
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (Array.isArray(input)) return Uint8Array.from(input);
    throw new TypeError('keccak256 expects a string (hashed as UTF-8), a Uint8Array or an ArrayBuffer');
  }

  /** Keccak-256 as a 0x-prefixed lowercase hex string (66 chars). Strings are hashed as UTF-8. */
  function keccak256(input) {
    return bytesToHex(keccak256Bytes(toBytes(input)));
  }

  /** Keccak-256 of the bytes given as a hex string. */
  function keccak256Hex(hex) {
    return bytesToHex(keccak256Bytes(hexToBytes(hex)));
  }

  return {
    keccak256: keccak256,
    keccak256Hex: keccak256Hex,
    keccak256Bytes: keccak256Bytes,
    utf8Encode: utf8Encode,
    utf8Decode: utf8Decode,
    bytesToHex: bytesToHex,
    hexToBytes: hexToBytes
  };
});
