/*
 * Pure helpers shared by the pages: USDC amounts, memo and links, time formatting, CSV, event folding,
 * transaction parameters for Arc, plain-English error text, safe storage. No DOM access in here.
 * Depends on ArcInvoice.keccak and ArcInvoice.abi (browser) or ./keccak.js and ./abi.js (Node).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./keccak.js'), require('./abi.js'));
  } else {
    var A = root.ArcInvoice || {};
    if (!A.keccak || !A.abi) throw new Error('ArcInvoice.keccak and ArcInvoice.abi are missing: load js/keccak.js and js/abi.js before js/util.js');
    root.ArcInvoice = Object.assign(A, { util: factory(A.keccak, A.abi) });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (K, abi) {
  'use strict';

  var UNITS_PER_USDC = 1000000n; // 6 decimals
  var SCALE = abi.SCALE; // 1e12
  var GWEI = 1000000000n;
  var MEMO_LIMITS = { description: 140, number: 32 };
  var MAX_MEMO_IN_LINK = 4000;
  var MEMO_STORAGE_KEY = 'arcInvoice.memos';

  // ---------------------------------------------------------------- amounts

  function amountError(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  /** Parse a USDC amount typed by a person into 6-decimal units (BigInt). Throws Error with .code on bad input. */
  function parseUsdc(input) {
    if (typeof input !== 'string') throw amountError('FORMAT', 'Enter an amount such as 25 or 1.25.');
    var s = input.trim();
    if (s === '') throw amountError('EMPTY', 'Enter an amount.');
    if (s.charAt(0) === '-') throw amountError('NEGATIVE', 'The amount cannot be negative.');
    if (/[,_\s]/.test(s)) throw amountError('SEPARATOR', 'Use a dot for decimals and no thousands separators, for example 1250.50.');
    var m = /^(\d*)(?:\.(\d*))?$/.exec(s);
    if (!m || (m[1] || '').length + (m[2] || '').length === 0) throw amountError('FORMAT', 'Enter an amount such as 25 or 1.25.');
    var whole = m[1] || '';
    var frac = m[2] || '';
    if (frac.length > 6) throw amountError('DECIMALS', 'USDC amounts have at most 6 decimal places.');
    var units = BigInt(whole || '0') * UNITS_PER_USDC + BigInt((frac + '000000').slice(0, 6));
    if (units > abi.MAX_UINT96) throw amountError('TOO_LARGE', 'That amount is too large.');
    return units;
  }

  /** Same as parseUsdc but returns { ok, value } or { ok: false, error, code } instead of throwing. */
  function tryParseUsdc(input) {
    try {
      return { ok: true, value: parseUsdc(input) };
    } catch (e) {
      return { ok: false, error: e.message, code: e.code };
    }
  }

  /**
   * 6-decimal units -> decimal string. Default: trailing zeros trimmed but at least 2 decimals ("1.25", "3.00").
   * opts.fixed: always exactly 6 decimals ("1.250000"). opts.group: thousands separators for display only.
   */
  function formatUsdc(units, opts) {
    opts = opts || {};
    var v = BigInt(units);
    var neg = v < 0n;
    if (neg) v = -v;
    var whole = (v / UNITS_PER_USDC).toString();
    var frac = (v % UNITS_PER_USDC).toString().padStart(6, '0');
    if (!opts.fixed) {
      frac = frac.replace(/0+$/, '');
      if (frac.length < 2) frac = frac.padEnd(2, '0');
    }
    if (opts.group) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + whole + '.' + frac;
  }

  /** USDC units (6 decimals) -> transaction value in native units (18 decimals). */
  function usdcToNative(units) {
    return BigInt(units) * SCALE;
  }

  /** Native units (18 decimals) -> USDC units (6 decimals), rounded down. */
  function nativeToUsdc(native) {
    return BigInt(native) / SCALE;
  }

  /**
   * Native 18-decimal amount -> short USDC string for fees and balances, rounded UP at maxDecimals (default 6).
   * 0 -> "0.00"; 1500000000000000 -> "0.0015".
   */
  function formatNativeUsdc(wei, maxDecimals) {
    var d = maxDecimals === undefined ? 6 : maxDecimals;
    var v = BigInt(wei);
    if (v === 0n) return '0.00';
    var unit = 10n ** BigInt(18 - d);
    var scaled = (v + unit - 1n) / unit; // ceil
    var base = 10n ** BigInt(d);
    var whole = (scaled / base).toString();
    var frac = (scaled % base).toString().padStart(d, '0').replace(/0+$/, '');
    if (frac.length < 2) frac = frac.padEnd(2, '0');
    return whole + '.' + frac;
  }

  // ---------------------------------------------------------------- memo

  function codePointLength(s) {
    return Array.from(String(s)).length;
  }

  /** 16 random bytes as 32 lowercase hex characters. cryptoObj defaults to the global crypto. */
  function randomSalt(cryptoObj) {
    var c = cryptoObj || (typeof globalThis !== 'undefined' ? globalThis.crypto : undefined);
    if (!c || typeof c.getRandomValues !== 'function') throw new Error('No secure random source is available in this browser.');
    var bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    return K.bytesToHex(bytes).slice(2);
  }

  /**
   * Canonical memo text: JSON.stringify({v:1, no, d, s}) with exactly this key order.
   * fields: { number (optional), description (required, <=140 chars), salt (32 hex chars) }.
   */
  function buildMemo(fields) {
    var no = fields.number === undefined || fields.number === null ? '' : String(fields.number);
    var d = fields.description === undefined || fields.description === null ? '' : String(fields.description);
    var s = String(fields.salt || '');
    if (d.length === 0) throw new Error('A description is required.');
    if (codePointLength(d) > MEMO_LIMITS.description) throw new Error('The description can have at most ' + MEMO_LIMITS.description + ' characters.');
    if (codePointLength(no) > MEMO_LIMITS.number) throw new Error('The invoice number can have at most ' + MEMO_LIMITS.number + ' characters.');
    if (!/^[0-9a-f]{32}$/.test(s)) throw new Error('The salt must be 32 lowercase hex characters.');
    return JSON.stringify({ v: 1, no: no, d: d, s: s });
  }

  /** referenceHash = keccak256 of the UTF-8 bytes of the memo text. */
  function memoHash(memo) {
    return K.keccak256(String(memo));
  }

  /** True when the memo text hashes to the on-chain reference hash (case-insensitive hex compare). */
  function verifyMemo(memo, referenceHash) {
    if (typeof memo !== 'string' || !abi.isHash32(referenceHash)) return false;
    return memoHash(memo) === referenceHash.toLowerCase();
  }

  /** Parse a canonical memo into { v, no, d, s }; null if the text is not in that shape. */
  function parseMemo(memo) {
    if (typeof memo !== 'string') return null;
    var o;
    try {
      o = JSON.parse(memo);
    } catch (e) {
      return null;
    }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    if (o.v !== 1 || typeof o.no !== 'string' || typeof o.d !== 'string' || typeof o.s !== 'string') return null;
    return { v: o.v, no: o.no, d: o.d, s: o.s };
  }

  // ---------------------------------------------------------------- links

  /** 'https://h/p/index.html?x#y' -> 'https://h/p/'. Works for file:// URLs too. Returns '' if no usable base. */
  function pageDirectory(href) {
    var m = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\/?#]*)([^?#]*)/.exec(String(href));
    if (!m) return '';
    var path = m[2] || '/';
    return m[1] + path.slice(0, path.lastIndexOf('/') + 1);
  }

  function buildFragment(pairs) {
    return pairs
      .filter(function (p) { return p[1] !== undefined && p[1] !== null && p[1] !== ''; })
      .map(function (p) { return p[0] + '=' + encodeURIComponent(p[1]); })
      .join('&');
  }

  /** dir + 'pay.html#net=..&c=..&id=..&memo=..' (memo optional). */
  function buildPayLink(dir, p) {
    var frag = [['net', p.net], ['c', p.contract], ['id', p.id], ['memo', p.memo]]
      .filter(function (x) { return x[1] !== undefined && x[1] !== null && x[1] !== ''; })
      .map(function (x) { return x[0] + '=' + (x[0] === 'memo' ? encodeURIComponent(x[1]) : x[1]); })
      .join('&');
    return dir + 'pay.html#' + frag;
  }

  /** dir + 'receipts.html#net=..&merchant=..[&payer=..]'. */
  function buildReceiptsLink(dir, p) {
    return dir + 'receipts.html#' + buildFragment([['net', p.net], ['merchant', p.merchant], ['payer', p.payer]]);
  }

  /** Parse "#a=b&c=d" (leading # optional) with decodeURIComponent only (a '+' stays a '+'). */
  function parseFragment(hash) {
    var out = { params: Object.create(null), errors: [] };
    var s = String(hash || '');
    if (s.charAt(0) === '#') s = s.slice(1);
    if (!s) return out;
    s.split('&').forEach(function (part) {
      if (!part) return;
      var i = part.indexOf('=');
      var k = i === -1 ? part : part.slice(0, i);
      var v = i === -1 ? '' : part.slice(i + 1);
      try {
        out.params[decodeURIComponent(k)] = decodeURIComponent(v);
      } catch (e) {
        out.errors.push('The link contains a badly encoded value (' + k.slice(0, 12) + ').');
      }
    });
    return out;
  }

  var NET_KEY = /^[A-Za-z0-9_-]{1,32}$/;

  var AMP_MESSAGE = 'This link is malformed: it contains "&amp;" where a plain "&" should be. Ask the sender for a fresh link.';

  function hasHtmlEscapedSeparators(params) {
    return Object.keys(params).some(function (k) { return /^amp;/i.test(k); });
  }

  /** Parse and validate a pay-page fragment. errors is empty for a usable link. */
  function parsePayFragment(hash) {
    var f = parseFragment(hash);
    var p = f.params;
    var res = { net: null, contract: null, id: null, memo: null, errors: f.errors.slice() };
    if (hasHtmlEscapedSeparators(p)) res.errors.unshift(AMP_MESSAGE);
    if (p.net !== undefined) {
      if (NET_KEY.test(p.net)) res.net = p.net;
      else res.errors.push('The network in the link is not valid.');
    }
    if (p.c !== undefined && p.c !== '') {
      if (abi.isAddress(p.c)) res.contract = abi.toChecksumAddress(p.c);
      else res.errors.push('The contract address in the link is not valid.');
    }
    if (p.id === undefined || p.id === '') res.errors.push('The link has no invoice id.');
    else if (abi.isHash32(p.id)) res.id = p.id.toLowerCase();
    else res.errors.push('The invoice id in the link is not valid (expected 0x and 64 hex characters).');
    if (p.memo !== undefined && p.memo !== '') {
      if (p.memo.length > MAX_MEMO_IN_LINK) res.errors.push('The description in the link is too long.');
      else res.memo = p.memo;
    }
    return res;
  }

  /** Parse a receipts-page fragment: { net, merchant, payer, errors }. Addresses are returned checksummed. */
  function parseReceiptsFragment(hash) {
    var f = parseFragment(hash);
    var p = f.params;
    var res = { net: null, merchant: null, payer: null, errors: f.errors.slice() };
    if (hasHtmlEscapedSeparators(p)) res.errors.unshift(AMP_MESSAGE);
    if (p.net !== undefined) {
      if (NET_KEY.test(p.net)) res.net = p.net;
      else res.errors.push('The network in the link is not valid.');
    }
    ['merchant', 'payer'].forEach(function (k) {
      if (p[k] !== undefined && p[k] !== '') {
        if (abi.isAddress(p[k])) res[k] = abi.toChecksumAddress(p[k]);
        else res.errors.push('The ' + k + ' address in the link is not valid.');
      }
    });
    return res;
  }

  // ---------------------------------------------------------------- time

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /** Unix seconds -> '2026-10-04T21:30:05Z'. */
  function toIsoUtc(ts) {
    return new Date(Number(ts) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** Unix seconds -> '2026-10-04 21:30:05 UTC'. */
  function formatUtc(ts) {
    return toIsoUtc(ts).replace('T', ' ').replace('Z', ' UTC');
  }

  /** Unix seconds -> local date and time in the browser's locale (not deterministic, display only). */
  function formatLocal(ts, locale) {
    try {
      return new Date(Number(ts) * 1000).toLocaleString(locale || undefined, { dateStyle: 'medium', timeStyle: 'short' });
    } catch (e) {
      return formatUtc(ts);
    }
  }

  /** Date -> 'YYYY-MM-DD' in UTC (for file names). */
  function dateStamp(date) {
    var d = date instanceof Date ? date : new Date(date);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  /** "in 3 days", "2 hours ago", "just now". ts and nowSec are unix seconds. */
  function relativeTime(ts, nowSec) {
    var diff = Number(ts) - Number(nowSec);
    var abs = Math.abs(diff);
    if (abs < 45) return diff > 0 ? 'in a few seconds' : 'just now';
    var units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];
    for (var i = 0; i < units.length; i++) {
      var n = Math.floor(abs / units[i][1]);
      if (n >= 1) {
        var label = n + ' ' + units[i][0] + (n === 1 ? '' : 's');
        return diff > 0 ? 'in ' + label : label + ' ago';
      }
    }
    return diff > 0 ? 'in a few seconds' : 'just now';
  }

  /** datetime-local value 'YYYY-MM-DDTHH:MM' (local time) -> unix seconds, or null when invalid (no rolling over). */
  function parseLocalDateTime(value) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value || ''));
    if (!m) return null;
    var y = +m[1], mo = +m[2], day = +m[3], h = +m[4], mi = +m[5], sec = +(m[6] || 0);
    if (h > 23 || mi > 59 || sec > 59) return null;
    var d = new Date(2000, 0, 1, 0, 0, 0, 0);
    d.setFullYear(y, mo - 1, day); // setFullYear keeps years 0-99 as they are (the Date constructor would add 1900)
    d.setHours(h, mi, sec, 0);
    if (isNaN(d.getTime()) || d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== day || d.getHours() !== h || d.getMinutes() !== mi) return null;
    return Math.floor(d.getTime() / 1000);
  }

  /** Unix seconds -> 'YYYY-MM-DDTHH:MM' in local time, for a datetime-local input. */
  function toLocalDateTimeValue(ts) {
    var d = new Date(Number(ts) * 1000);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  // ---------------------------------------------------------------- CSV

  var CSV_BOM = '﻿';
  var CSV_COLUMNS = [
    'network', 'contract', 'invoice_id', 'reference_hash', 'invoice_number', 'description', 'amount_usdc', 'status',
    'created_utc', 'due_utc', 'paid_utc', 'merchant', 'payer', 'register_tx', 'payment_tx', 'cancel_tx'
  ];

  // Characters that render as nothing (zero-width, bidi controls, BOM): they must not hide a leading formula character.
  var INVISIBLE_CLASS = '\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff';
  var INVISIBLE_RE = new RegExp('[' + INVISIBLE_CLASS + ']', 'g');
  var CSV_LEAD_RE = new RegExp('^[ \\u00a0' + INVISIBLE_CLASS + ']*([=+\\-@])');

  /** True when a spreadsheet could read the text as a formula: it starts with = + - @ TAB or CR, or with = + - @ after spaces / invisible characters. */
  function csvNeedsGuard(s) {
    if (s.length === 0) return false;
    if ('=+-@\t\r'.indexOf(s.charAt(0)) !== -1) return true;
    return CSV_LEAD_RE.test(s);
  }

  /**
   * One CSV field per RFC 4180. Text cells that a spreadsheet could take for a formula (see csvNeedsGuard) get a leading
   * single quote; numbers and BigInts are written as they are.
   */
  function csvField(value) {
    if (value === null || value === undefined) return '';
    var isText = typeof value === 'string';
    var s = isText ? value : String(value);
    if (isText && csvNeedsGuard(s)) s = "'" + s;
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function csvRow(values) {
    return values.map(csvField).join(',');
  }

  /** BOM + header + rows, CRLF line endings, a CRLF after the last row. */
  function buildCsv(header, rows) {
    return CSV_BOM + [header].concat(rows).map(csvRow).join('\r\n') + '\r\n';
  }

  // ---------------------------------------------------------------- events -> invoices

  function compareEvents(a, b) {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
    return a.logIndex - b.logIndex;
  }

  function eventKey(e) {
    return e.blockNumber + ':' + e.logIndex + ':' + (e.txHash || '');
  }

  /** Merge two lists of decoded events: de-duplicated, sorted by (blockNumber, logIndex). */
  function mergeEvents(existing, incoming) {
    var seen = Object.create(null);
    var out = [];
    existing.concat(incoming).forEach(function (e) {
      var k = eventKey(e);
      if (seen[k]) return;
      seen[k] = true;
      out.push(e);
    });
    return out.sort(compareEvents);
  }

  /**
   * Fold decoded events (any order) into one record per invoice id, ordered by first appearance.
   * Records: { id, merchant, referenceHash, amount, due, createdAt, registered, state: 'open'|'paid'|'cancelled',
   *   payer, paidAt, cancelledAt, registerTx, paymentTx, cancelTx, registerBlock, paidBlock, cancelBlock }.
   * A record without a Registered event (scan range started later) has registered=false and null due/createdAt.
   */
  function foldEvents(events) {
    var sorted = mergeEvents([], events);
    var byId = Object.create(null);
    var order = [];
    function get(e) {
      var r = byId[e.id];
      if (!r) {
        r = byId[e.id] = {
          id: e.id, merchant: e.merchant, referenceHash: null, amount: null, due: null, createdAt: null, registered: false,
          state: 'open', payer: null, paidAt: null, cancelledAt: null,
          registerTx: null, paymentTx: null, cancelTx: null, registerBlock: null, paidBlock: null, cancelBlock: null
        };
        order.push(r);
      }
      return r;
    }
    sorted.forEach(function (e) {
      var r = get(e);
      if (e.type === 'InvoiceRegistered') {
        r.registered = true;
        r.referenceHash = e.referenceHash;
        r.amount = e.amount;
        r.due = e.due;
        r.createdAt = e.createdAt;
        r.registerTx = e.txHash;
        r.registerBlock = e.blockNumber;
      } else if (e.type === 'InvoicePaid') {
        r.state = 'paid';
        r.referenceHash = r.referenceHash || e.referenceHash;
        r.amount = r.amount === null ? e.amount : r.amount;
        r.payer = e.payer;
        r.paidAt = e.paidAt;
        r.paymentTx = e.txHash;
        r.paidBlock = e.blockNumber;
      } else if (e.type === 'InvoiceCancelled') {
        r.state = 'cancelled';
        r.cancelledAt = e.cancelledAt;
        r.cancelTx = e.txHash;
        r.cancelBlock = e.blockNumber;
      }
    });
    return order;
  }

  /** 'open' | 'expired' | 'paid' | 'cancelled'. An open invoice is expired when due < latest block timestamp. */
  function effectiveStatus(record, latestTimestamp) {
    if (record.state === 'open' && record.due !== null && latestTimestamp !== null && latestTimestamp !== undefined && record.due < latestTimestamp) return 'expired';
    return record.state;
  }

  /** Status of an invoice read straight from the contract (decodeGetInvoice result) given the latest block time. */
  function statusFromChain(invoice, latestTimestamp) {
    if (invoice.status === abi.STATUS.None) return 'notfound';
    if (invoice.status === abi.STATUS.Paid) return 'paid';
    if (invoice.status === abi.STATUS.Cancelled) return 'cancelled';
    return latestTimestamp !== null && latestTimestamp !== undefined && invoice.due < latestTimestamp ? 'expired' : 'open';
  }

  /** Totals: paid total, outstanding (open and not expired) total, counts per status. Amounts are BigInt units. */
  function summarize(records, latestTimestamp) {
    var s = { counts: { open: 0, expired: 0, paid: 0, cancelled: 0, total: 0 }, paidTotal: 0n, outstandingTotal: 0n };
    records.forEach(function (r) {
      var st = effectiveStatus(r, latestTimestamp);
      s.counts[st]++;
      s.counts.total++;
      if (st === 'paid' && r.amount !== null) s.paidTotal += r.amount;
      if (st === 'open' && r.amount !== null) s.outstandingTotal += r.amount;
    });
    return s;
  }

  /** Events <-> plain JSON (BigInt amounts as decimal strings) for the localStorage cache. */
  function serializeEvents(events) {
    return events.map(function (e) {
      var o = {};
      Object.keys(e).forEach(function (k) { o[k] = typeof e[k] === 'bigint' ? e[k].toString() : e[k]; });
      if (typeof e.amount === 'bigint') o.amountIsBigInt = true;
      return o;
    });
  }

  function deserializeEvents(list) {
    return list.map(function (o) {
      var e = Object.assign({}, o);
      if (e.amountIsBigInt) e.amount = BigInt(e.amount);
      delete e.amountIsBigInt;
      return e;
    });
  }

  /**
   * Compact form of decoded events for the localStorage cache: only what foldEvents needs, as short arrays
   * [type, id, merchant, referenceHash, amount, due, when, payer, txHash, blockNumber, logIndex].
   */
  function packEvents(events) {
    return events.map(function (e) {
      var t = e.type === 'InvoiceRegistered' ? 'r' : e.type === 'InvoicePaid' ? 'p' : 'c';
      var when = t === 'r' ? e.createdAt : t === 'p' ? e.paidAt : e.cancelledAt;
      return [t, e.id, e.merchant, t === 'c' ? '' : e.referenceHash, t === 'c' ? '' : e.amount.toString(), t === 'r' ? e.due : 0, when, t === 'p' ? e.payer : '', e.txHash || '', e.blockNumber, e.logIndex];
    });
  }

  /** Inverse of packEvents. Throws on a malformed row (a corrupt cache must be ignored by the caller). */
  function unpackEvents(rows) {
    if (!Array.isArray(rows)) throw new Error('bad event cache');
    return rows.map(function (r) {
      if (!Array.isArray(r) || r.length !== 11 || ['r', 'p', 'c'].indexOf(r[0]) === -1 || !abi.isHash32(r[1]) || !abi.isAddress(r[2])) throw new Error('bad event cache row');
      var e = { type: r[0] === 'r' ? 'InvoiceRegistered' : r[0] === 'p' ? 'InvoicePaid' : 'InvoiceCancelled', id: r[1], merchant: r[2], address: null, txHash: r[8] || null, blockHash: null, blockNumber: r[9], logIndex: r[10] };
      if (!Number.isSafeInteger(e.blockNumber) || !Number.isSafeInteger(e.logIndex)) throw new Error('bad event cache row');
      if (r[0] === 'r') { e.referenceHash = r[3]; e.amount = BigInt(r[4]); e.due = r[5]; e.createdAt = r[6]; }
      else if (r[0] === 'p') { e.referenceHash = r[3]; e.amount = BigInt(r[4]); e.payer = r[7]; e.paidAt = r[6]; }
      else e.cancelledAt = r[6];
      return e;
    });
  }

  /** Records -> CSV rows (arrays) in CSV_COLUMNS order. memos: { referenceHash: memoText }; only text matching the hash is used. */
  function recordsToCsvRows(records, ctx) {
    var memos = ctx.memos || {};
    return records.map(function (r) {
      var memoText = r.referenceHash ? memos[r.referenceHash.toLowerCase()] : null;
      var memo = memoText && verifyMemo(memoText, r.referenceHash) ? parseMemo(memoText) : null; // text that does not hash to the on-chain value is not trusted
      var st = effectiveStatus(r, ctx.latestTimestamp);
      return [
        ctx.network,
        ctx.contract,
        r.id,
        r.referenceHash || '',
        memo ? memo.no : '',
        memo ? memo.d : '',
        r.amount === null ? '' : formatUsdc(r.amount, { fixed: true }),
        st,
        r.createdAt === null ? '' : toIsoUtc(r.createdAt),
        r.due === null ? '' : toIsoUtc(r.due),
        r.paidAt === null ? '' : toIsoUtc(r.paidAt),
        r.merchant || '',
        r.payer || '',
        r.registerTx || '',
        r.paymentTx || '',
        r.cancelTx || ''
      ];
    });
  }

  function buildInvoiceCsv(records, ctx) {
    return buildCsv(CSV_COLUMNS, recordsToCsvRows(records, ctx));
  }

  /** 'arc-invoices-<network>-<merchant short>-<YYYY-MM-DD>.csv' (kind 'payments' for the payer view). */
  function csvFilename(networkKey, address, date, kind) {
    var short = abi.isAddress(address) ? (address.slice(0, 6) + address.slice(-4)).toLowerCase() : 'unknown';
    var safeNet = String(networkKey).replace(/[^A-Za-z0-9_-]/g, '');
    return 'arc-' + (kind || 'invoices') + '-' + safeNet + '-' + short + '-' + dateStamp(date) + '.csv';
  }

  // ---------------------------------------------------------------- invisible characters, local origin

  /** Remove zero-width characters, bidi controls and the BOM (U+200B-U+200F, U+202A-U+202E, U+2066-U+2069, U+FEFF). */
  function stripInvisible(text) {
    return String(text).replace(INVISIBLE_RE, '');
  }

  function hasInvisible(text) {
    return stripInvisible(text) !== String(text);
  }

  /** Show those characters as visible placeholders such as <U+202E> (for text we did not write ourselves). */
  function showInvisible(text) {
    return String(text).replace(INVISIBLE_RE, function (c) {
      return '<U+' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0') + '>';
    });
  }

  /** True for file: pages and for pages served from this computer (localhost, 127.x.x.x, [::1], 0.0.0.0). */
  function isLocalOrigin(href) {
    var h = String(href || '');
    if (/^file:/i.test(h)) return true;
    var m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^@\/?#]*@)?(\[[^\]]*\]|[^:\/?#]*)/.exec(h);
    if (!m) return false;
    var host = m[1].toLowerCase();
    return host === 'localhost' || /\.localhost$/.test(host) || /^127\./.test(host) || host === '[::1]' || host === '0.0.0.0';
  }

  // ---------------------------------------------------------------- local storage helpers

  /** Wrap a Storage-like object; every call is guarded because storage may be missing or full. */
  function createStore(storage) {
    var memory = Object.create(null); // values that could not be written to storage, kept for this page's lifetime
    return {
      get: function (key, fallback) {
        try {
          if (storage) {
            var raw = storage.getItem(key);
            if (raw !== null && raw !== undefined) return JSON.parse(raw);
          }
        } catch (e) { /* unreadable or corrupt: use memory or the fallback */ }
        return key in memory ? memory[key] : fallback;
      },
      set: function (key, value) {
        try {
          if (storage) {
            storage.setItem(key, JSON.stringify(value));
            delete memory[key];
            return true;
          }
        } catch (e) { /* storage unavailable or full */ }
        memory[key] = value;
        return false;
      },
      remove: function (key) {
        try {
          if (storage) storage.removeItem(key);
        } catch (e) { /* ignore */ }
        delete memory[key];
      }
    };
  }

  /** { referenceHash: memoText } as saved by the create page (localStorage['arcInvoice.memos']). */
  function loadMemos(store) {
    var m = store.get(MEMO_STORAGE_KEY, {});
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  }

  function saveMemo(store, referenceHash, memo) {
    var m = loadMemos(store);
    m[referenceHash.toLowerCase()] = memo;
    return store.set(MEMO_STORAGE_KEY, m);
  }

  // ---------------------------------------------------------------- transactions on Arc

  function toHex(n) {
    return '0x' + BigInt(n).toString(16);
  }

  function hexToBigInt(h) {
    return BigInt(h);
  }

  /**
   * Gas and fee fields for a transaction on Arc. Arc silently drops transactions with maxFeePerGas below 20 gwei, so
   * maxFeePerGas = max(20 gwei, 2 x gasPrice), priority fee 1 gwei, gas limit = estimate x 1.3 (rounded up).
   * Returns BigInts plus fee figures: expectedFee = estimate x gasPrice, maxFee = gas x maxFeePerGas.
   */
  function computeTxParams(gasEstimate, gasPrice) {
    var est = BigInt(gasEstimate);
    var price = BigInt(gasPrice);
    var floor = 20n * GWEI;
    var maxFeePerGas = price * 2n > floor ? price * 2n : floor;
    var gas = (est * 13n + 9n) / 10n;
    return {
      gas: gas,
      maxFeePerGas: maxFeePerGas,
      maxPriorityFeePerGas: GWEI,
      expectedFee: est * (price > 0n ? price : floor / 2n),
      maxFee: gas * maxFeePerGas
    };
  }

  // ---------------------------------------------------------------- plain-English errors

  /** decodeError result -> sentence for a person. */
  function explainContractError(decoded, opts) {
    if (!decoded) return null;
    switch (decoded.name) {
      case 'ZeroReferenceHash': return 'The invoice reference is empty.';
      case 'ZeroAmount': return 'The amount must be greater than zero.';
      case 'DueNotInFuture': return 'The due date must be in the future according to the blockchain clock. Pick a later due date.';
      case 'AlreadyRegistered': return 'This invoice already exists on-chain. Create a new invoice instead.';
      case 'UnknownInvoice': return 'This invoice does not exist on this contract and network. Check that the link is complete and that you are on the right network.';
      case 'AlreadyPaid': return 'This invoice has already been paid.';
      case 'AlreadyCancelled': return 'This invoice was cancelled by the merchant and can no longer be paid.';
      case 'InvoiceExpired': return 'This invoice expired on ' + formatUtc(decoded.args.due) + ' and can no longer be paid. Ask the merchant for a new invoice.';
      case 'WrongAmount': return 'The amount sent (' + formatNativeUsdc(decoded.args.sent) + ' USDC) does not match the invoice (' + formatNativeUsdc(decoded.args.expected) + ' USDC).';
      case 'NotMerchant': return 'Only the merchant account that created this invoice can cancel it.';
      case 'TransferFailed': return 'The merchant account cannot receive USDC right now (for example it is blocked by the USDC issuer, or it is a contract that rejects payments).' + (opts && opts.mined ? '' : ' Nothing was sent.');
      case 'Error': return 'The contract rejected the request: ' + decoded.args.message;
      case 'Panic': return 'The contract failed with an internal error (code ' + decoded.args.code + ').';
      default: return null;
    }
  }

  /** The first usable text inside whatever was thrown ('' when there is none). Never calls String() on an object. */
  function messageOf(err) {
    if (typeof err === 'string') return err.trim();
    if (!err || typeof err !== 'object') return '';
    var candidates = [err.message, err.reason, err.error && err.error.message, err.data && err.data.message];
    for (var i = 0; i < candidates.length; i++) {
      if (typeof candidates[i] === 'string' && candidates[i].trim()) return candidates[i].trim();
    }
    return '';
  }

  /**
   * On Arc a failing transaction is mined with status 0x0 and its receipt carries no revert data. Replay it with eth_call
   * at the receipt's block (then at the block before it) and decode the custom error.
   * client needs call(tx, blockTag); tx = { from, to, data, value? }. Resolves { sentence, decoded } or null.
   */
  async function replayFailedTx(client, tx, receipt) {
    var n = receipt && receipt.blockNumber !== undefined && receipt.blockNumber !== null ? Number(BigInt(receipt.blockNumber)) : null;
    if (n === null || !isFinite(n)) return null;
    var call = { from: tx.from, to: tx.to, data: tx.data };
    if (tx.value && BigInt(tx.value) !== 0n) call.value = toHex(tx.value);
    var tags = n > 0 ? [n, n - 1] : [n];
    for (var i = 0; i < tags.length; i++) {
      try {
        await client.call(call, '0x' + tags[i].toString(16));
      } catch (e) {
        var data = abi.findRevertData(e);
        var decoded = data ? abi.decodeError(data) : null;
        var sentence = decoded ? explainContractError(decoded, { mined: true }) : null;
        if (sentence) return { sentence: sentence, decoded: decoded };
      }
    }
    return null;
  }

  /** Message for a transaction that was mined but failed (receipt status 0x0). reason is replayFailedTx's result or null. */
  function failedOnChainMessage(reason) {
    return 'The transaction failed on chain' + (reason ? ': ' + reason.sentence : ' (reason unknown). Open it in the explorer to look closer.') + ' The payment itself did not move; only the network fee was spent.';
  }

  /** Turn anything thrown by an RPC client or a wallet into a sentence a person can act on. */
  function explainFailure(err) {
    if (err && typeof err.userMessage === 'string' && err.userMessage) return err.userMessage;
    var data = abi.findRevertData(err);
    if (data) {
      var text = explainContractError(abi.decodeError(data));
      if (text) return text;
    }
    var code = err && typeof err === 'object' ? (err.code !== undefined ? err.code : err.error && err.error.code) : undefined;
    var msg = messageOf(err);
    if (code === 4001 || code === 'ACTION_REJECTED' || /user (rejected|denied)/i.test(msg)) return 'You rejected the request in your wallet. Nothing was sent.';
    if (code === -32002) return 'Your wallet already has a pending request. Open the wallet and answer it first.';
    if (code === 4100) return 'The wallet has not authorised this site yet. Connect the wallet first.';
    if (code === 4902) return 'The wallet does not know this network yet.';
    if (/insufficient funds|exceeds (the )?balance|insufficient balance/i.test(msg)) return 'Not enough USDC in this account to cover the amount plus the network fee.';
    if (/execution reverted|revert/i.test(msg)) return 'The transaction would fail on-chain, so it was not sent. (' + msg.slice(0, 160) + ')';
    if (/failed to fetch|networkerror|network request failed|load failed|timed out|timeout|ECONN|ENOTFOUND/i.test(msg)) return 'Could not reach the Arc RPC. Check your connection and try again.';
    if (!msg) return 'Something went wrong' + (code !== undefined && code !== null ? ' (error code ' + code + ')' : '') + '. Please try again.';
    return msg.slice(0, 300);
  }

  /** Check a custom RPC URL typed by a person. Returns { ok, url } (url '' = none given) or { ok: false, error }. */
  function validateRpcUrl(text) {
    var t = String(text === undefined || text === null ? '' : text).trim();
    if (!t) return { ok: true, url: '' };
    var u;
    try {
      u = new URL(t);
    } catch (e) {
      return { ok: false, error: 'That is not a valid URL. Use https://... or http://127.0.0.1:8545.' };
    }
    if (u.username || u.password) return { ok: false, error: 'Do not put a user name or password in the URL.' };
    var local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
    if (u.protocol === 'https:' || (u.protocol === 'http:' && local)) return { ok: true, url: u.href };
    return { ok: false, error: 'Use an https:// URL (plain http:// is only accepted for 127.0.0.1 or localhost).' };
  }

  // ---------------------------------------------------------------- display helpers

  function shortAddress(address) {
    return typeof address === 'string' && address.length >= 12 ? address.slice(0, 6) + '…' + address.slice(-4) : String(address || '');
  }

  function shortHash(hash, hexChars) {
    var n = hexChars || 10;
    return typeof hash === 'string' && hash.length > n + 2 ? hash.slice(0, 2 + n) : String(hash || '');
  }

  /** 1234567 -> '1.2M', 12345 -> '12.3k', 9999 -> '9999' (abbreviates from 10,000 up; never prints '1000k'). */
  function formatCount(n) {
    var v = Number(n);
    if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (v >= 1e4) {
      var k = (v / 1e3).toFixed(1);
      if (parseFloat(k) >= 1000) return '1M';
      return k.replace(/\.0$/, '') + 'k';
    }
    return String(Math.round(v));
  }

  /** Explorer URL (Blockscout style) for kind 'tx' or 'address'; '' when the network has no explorer. */
  function explorerUrl(network, kind, value) {
    if (!network || !network.explorer) return '';
    return network.explorer.replace(/\/+$/, '') + '/' + kind + '/' + value;
  }

  return {
    UNITS_PER_USDC: UNITS_PER_USDC,
    MEMO_LIMITS: MEMO_LIMITS,
    CSV_COLUMNS: CSV_COLUMNS,
    CSV_BOM: CSV_BOM,
    parseUsdc: parseUsdc,
    tryParseUsdc: tryParseUsdc,
    formatUsdc: formatUsdc,
    usdcToNative: usdcToNative,
    nativeToUsdc: nativeToUsdc,
    formatNativeUsdc: formatNativeUsdc,
    codePointLength: codePointLength,
    randomSalt: randomSalt,
    buildMemo: buildMemo,
    memoHash: memoHash,
    verifyMemo: verifyMemo,
    parseMemo: parseMemo,
    pageDirectory: pageDirectory,
    buildPayLink: buildPayLink,
    buildReceiptsLink: buildReceiptsLink,
    parseFragment: parseFragment,
    parsePayFragment: parsePayFragment,
    parseReceiptsFragment: parseReceiptsFragment,
    addressTopic: abi.addressTopic,
    toIsoUtc: toIsoUtc,
    formatUtc: formatUtc,
    formatLocal: formatLocal,
    dateStamp: dateStamp,
    relativeTime: relativeTime,
    parseLocalDateTime: parseLocalDateTime,
    toLocalDateTimeValue: toLocalDateTimeValue,
    csvField: csvField,
    csvNeedsGuard: csvNeedsGuard,
    csvRow: csvRow,
    buildCsv: buildCsv,
    compareEvents: compareEvents,
    mergeEvents: mergeEvents,
    foldEvents: foldEvents,
    effectiveStatus: effectiveStatus,
    statusFromChain: statusFromChain,
    summarize: summarize,
    serializeEvents: serializeEvents,
    packEvents: packEvents,
    unpackEvents: unpackEvents,
    stripInvisible: stripInvisible,
    hasInvisible: hasInvisible,
    showInvisible: showInvisible,
    isLocalOrigin: isLocalOrigin,
    deserializeEvents: deserializeEvents,
    recordsToCsvRows: recordsToCsvRows,
    buildInvoiceCsv: buildInvoiceCsv,
    csvFilename: csvFilename,
    createStore: createStore,
    loadMemos: loadMemos,
    saveMemo: saveMemo,
    toHex: toHex,
    hexToBigInt: hexToBigInt,
    computeTxParams: computeTxParams,
    explainContractError: explainContractError,
    explainFailure: explainFailure,
    replayFailedTx: replayFailedTx,
    failedOnChainMessage: failedOnChainMessage,
    shortAddress: shortAddress,
    shortHash: shortHash,
    formatCount: formatCount,
    explorerUrl: explorerUrl,
    validateRpcUrl: validateRpcUrl
  };
});
