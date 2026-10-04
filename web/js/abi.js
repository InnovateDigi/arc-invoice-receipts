/*
 * Minimal ABI layer for the InvoiceReceipts contract: calldata encoding, result/event/error decoding,
 * EIP-55 checksum addresses and the invoice id. Depends on ArcInvoice.keccak (browser) or ./keccak.js (Node).
 * Types: addresses are checksummed strings, hashes/ids are lowercase 0x hex, amounts are BigInt (6-decimal USDC),
 * timestamps / block numbers / status are Numbers.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./keccak.js'));
  } else {
    var K = root.ArcInvoice && root.ArcInvoice.keccak;
    if (!K) throw new Error('ArcInvoice.keccak is missing: load js/keccak.js before js/abi.js');
    root.ArcInvoice = Object.assign(root.ArcInvoice || {}, { abi: factory(K) });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (K) {
  'use strict';

  var STATUS = { None: 0, Open: 1, Paid: 2, Cancelled: 3 };
  var STATUS_NAMES = ['None', 'Open', 'Paid', 'Cancelled'];
  var SCALE = 1000000000000n; // 1e12: native (18 decimals) units per 6-decimal USDC unit
  var MAX_UINT40 = (1n << 40n) - 1n;
  var MAX_UINT96 = (1n << 96n) - 1n;
  var MAX_UINT256 = (1n << 256n) - 1n;
  var ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

  function selectorOf(signature) {
    return K.keccak256(signature).slice(0, 10);
  }

  var SIGNATURES = {
    register: 'register(bytes32,uint96,uint40)',
    pay: 'pay(bytes32)',
    cancel: 'cancel(bytes32)',
    getInvoice: 'getInvoice(bytes32)',
    invoiceId: 'invoiceId(address,bytes32)',
    SCALE: 'SCALE()'
  };
  var EVENT_SIGNATURES = {
    InvoiceRegistered: 'InvoiceRegistered(bytes32,address,bytes32,uint96,uint40,uint40)',
    InvoicePaid: 'InvoicePaid(bytes32,address,address,bytes32,uint96,uint40)',
    InvoiceCancelled: 'InvoiceCancelled(bytes32,address,uint40)'
  };
  var ERROR_SIGNATURES = {
    ZeroReferenceHash: 'ZeroReferenceHash()',
    ZeroAmount: 'ZeroAmount()',
    DueNotInFuture: 'DueNotInFuture()',
    AlreadyRegistered: 'AlreadyRegistered()',
    UnknownInvoice: 'UnknownInvoice()',
    AlreadyPaid: 'AlreadyPaid()',
    AlreadyCancelled: 'AlreadyCancelled()',
    InvoiceExpired: 'InvoiceExpired(uint40)',
    WrongAmount: 'WrongAmount(uint256,uint256)',
    NotMerchant: 'NotMerchant()',
    TransferFailed: 'TransferFailed()'
  };

  var SELECTORS = {};
  Object.keys(SIGNATURES).forEach(function (n) { SELECTORS[n] = selectorOf(SIGNATURES[n]); });
  var TOPICS = {};
  Object.keys(EVENT_SIGNATURES).forEach(function (n) { TOPICS[n] = K.keccak256(EVENT_SIGNATURES[n]); });
  var ERROR_SELECTORS = {};
  var ERROR_BY_SELECTOR = {};
  Object.keys(ERROR_SIGNATURES).forEach(function (n) {
    var sel = selectorOf(ERROR_SIGNATURES[n]);
    ERROR_SELECTORS[n] = sel;
    ERROR_BY_SELECTOR[sel] = n;
  });
  [SELECTORS, TOPICS, ERROR_SELECTORS, ERROR_BY_SELECTOR, STATUS, STATUS_NAMES].forEach(Object.freeze);
  var SOLIDITY_ERROR_SELECTOR = selectorOf('Error(string)'); // 0x08c379a0
  var SOLIDITY_PANIC_SELECTOR = selectorOf('Panic(uint256)'); // 0x4e487b71

  // ---------- low level helpers ----------

  function strip0x(h) {
    return h.slice(0, 2) === '0x' || h.slice(0, 2) === '0X' ? h.slice(2) : h;
  }

  function isHexBytes(value, bytes) {
    return typeof value === 'string' && new RegExp('^0x[0-9a-fA-F]{' + bytes * 2 + '}$').test(value);
  }

  /** True for a 0x-prefixed 32-byte hex string (any case). */
  function isHash32(value) {
    return isHexBytes(value, 32);
  }

  /** True for 0x + 40 hex characters (any case, checksum not checked). */
  function isAddress(value) {
    return isHexBytes(value, 20);
  }

  function toChecksumAddress(address) {
    if (!isAddress(address)) throw new Error('invalid address: ' + String(address));
    var lower = address.slice(2).toLowerCase();
    var hash = K.keccak256(lower).slice(2);
    var out = '0x';
    for (var i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
    return out;
  }

  /** True when the address has no checksum claim (all lower or all upper case) or its EIP-55 checksum is right. */
  function hasValidChecksum(address) {
    if (!isAddress(address)) return false;
    var body = address.slice(2);
    if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
    return toChecksumAddress(address) === address;
  }

  function toBigInt(value, label) {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) throw new Error(label + ' must be a safe integer');
      return BigInt(value);
    }
    if (typeof value === 'string' && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) return BigInt(value);
    throw new Error(label + ' must be an integer');
  }

  function encodeUint(value, max, label) {
    var v = toBigInt(value, label);
    if (v < 0n || v > max) throw new Error(label + ' is out of range');
    var h = v.toString(16);
    return '0'.repeat(64 - h.length) + h;
  }

  function encodeBytes32(value, label) {
    if (!isHash32(value)) throw new Error(label + ' must be 32 bytes of hex (0x + 64 hex characters)');
    return value.slice(2).toLowerCase();
  }

  function encodeAddress(value, label) {
    if (!isAddress(value)) throw new Error(label + ' must be an address (0x + 40 hex characters)');
    return '000000000000000000000000' + value.slice(2).toLowerCase();
  }

  /** The 32-byte topic of an indexed address: left padded, lowercase. */
  function addressTopic(address) {
    return '0x' + encodeAddress(address, 'address');
  }

  // ---------- encoding ----------

  function encodeRegister(referenceHash, amount, due) {
    return (
      SELECTORS.register +
      encodeBytes32(referenceHash, 'referenceHash') +
      encodeUint(amount, MAX_UINT96, 'amount') +
      encodeUint(due, MAX_UINT40, 'due')
    );
  }

  function encodePay(id) {
    return SELECTORS.pay + encodeBytes32(id, 'id');
  }

  function encodeCancel(id) {
    return SELECTORS.cancel + encodeBytes32(id, 'id');
  }

  function encodeGetInvoice(id) {
    return SELECTORS.getInvoice + encodeBytes32(id, 'id');
  }

  function encodeInvoiceIdCall(merchant, referenceHash) {
    return SELECTORS.invoiceId + encodeAddress(merchant, 'merchant') + encodeBytes32(referenceHash, 'referenceHash');
  }

  function encodeScale() {
    return SELECTORS.SCALE;
  }

  /** id = keccak256(abi.encode(merchant, referenceHash)) = keccak256(32-byte padded address ++ hash). */
  function invoiceId(merchant, referenceHash) {
    return K.keccak256Hex('0x' + encodeAddress(merchant, 'merchant') + encodeBytes32(referenceHash, 'referenceHash'));
  }

  // ---------- decoding ----------

  function wordsOf(hex, count, label) {
    if (typeof hex !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(hex)) throw new Error(label + ': result is not hex');
    var d = hex.slice(2);
    if (d.length < count * 64) throw new Error(label + ': result is too short (' + (d.length / 2) + ' bytes)');
    var out = [];
    for (var i = 0; i < count; i++) out.push(d.slice(i * 64, (i + 1) * 64).toLowerCase());
    return out;
  }

  function wordToAddress(word, label) {
    if (word.slice(0, 24) !== '000000000000000000000000') throw new Error(label + ' is not a valid address word');
    return toChecksumAddress('0x' + word.slice(24));
  }

  function wordToUint(word, max, label) {
    var v = BigInt('0x' + word);
    if (v > max) throw new Error(label + ' is out of range');
    return v;
  }

  /** Decode the return data of getInvoice(bytes32): a static tuple of 7 consecutive words. */
  function decodeGetInvoice(hex) {
    var w = wordsOf(hex, 7, 'getInvoice');
    var status = Number(wordToUint(w[3], 255n, 'status'));
    if (status > 3) throw new Error('getInvoice: unknown status ' + status);
    return {
      merchant: wordToAddress(w[0], 'merchant'),
      due: Number(wordToUint(w[1], MAX_UINT40, 'due')),
      paidAt: Number(wordToUint(w[2], MAX_UINT40, 'paidAt')),
      status: status,
      statusName: STATUS_NAMES[status],
      referenceHash: '0x' + w[4],
      payer: wordToAddress(w[5], 'payer'),
      amount: wordToUint(w[6], MAX_UINT96, 'amount')
    };
  }

  function decodeUint256(hex) {
    return wordToUint(wordsOf(hex, 1, 'uint256')[0], MAX_UINT256, 'value');
  }

  function hexToNumber(value, label) {
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
    if (typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value)) {
      var n = Number(BigInt(value));
      if (Number.isSafeInteger(n)) return n;
    }
    throw new Error('log has an invalid ' + label);
  }

  /**
   * Decode one raw JSON-RPC log (eth_getLogs entry or a receipt log) of the contract.
   * Returns null when topic0 is not one of the three events; throws on a malformed log of a known event.
   */
  function decodeLog(log) {
    if (!log || !Array.isArray(log.topics) || log.topics.length === 0 || typeof log.topics[0] !== 'string') return null;
    var topic0 = log.topics[0].toLowerCase();
    if (topic0 !== TOPICS.InvoiceRegistered && topic0 !== TOPICS.InvoicePaid && topic0 !== TOPICS.InvoiceCancelled) return null;
    var base = {
      address: typeof log.address === 'string' ? log.address.toLowerCase() : null,
      blockNumber: log.blockNumber === undefined || log.blockNumber === null ? null : hexToNumber(log.blockNumber, 'blockNumber'),
      logIndex: log.logIndex === undefined || log.logIndex === null ? null : hexToNumber(log.logIndex, 'logIndex'),
      txHash: typeof log.transactionHash === 'string' ? log.transactionHash.toLowerCase() : null,
      blockHash: typeof log.blockHash === 'string' ? log.blockHash.toLowerCase() : null
    };
    var t = log.topics;
    var topicWord = function (i) {
      if (!isHash32(t[i])) throw new Error('log has a malformed topic ' + i);
      return t[i].slice(2).toLowerCase();
    };
    var w;
    if (topic0 === TOPICS.InvoiceRegistered) {
      if (t.length !== 3) throw new Error('InvoiceRegistered: expected 3 topics');
      w = wordsOf(log.data, 4, 'InvoiceRegistered');
      return Object.assign({
        type: 'InvoiceRegistered',
        id: '0x' + topicWord(1),
        merchant: wordToAddress(topicWord(2), 'merchant'),
        referenceHash: '0x' + w[0],
        amount: wordToUint(w[1], MAX_UINT96, 'amount'),
        due: Number(wordToUint(w[2], MAX_UINT40, 'due')),
        createdAt: Number(wordToUint(w[3], MAX_UINT40, 'createdAt'))
      }, base);
    }
    if (topic0 === TOPICS.InvoicePaid) {
      if (t.length !== 4) throw new Error('InvoicePaid: expected 4 topics');
      w = wordsOf(log.data, 3, 'InvoicePaid');
      return Object.assign({
        type: 'InvoicePaid',
        id: '0x' + topicWord(1),
        merchant: wordToAddress(topicWord(2), 'merchant'),
        payer: wordToAddress(topicWord(3), 'payer'),
        referenceHash: '0x' + w[0],
        amount: wordToUint(w[1], MAX_UINT96, 'amount'),
        paidAt: Number(wordToUint(w[2], MAX_UINT40, 'paidAt'))
      }, base);
    }
    if (topic0 === TOPICS.InvoiceCancelled) {
      if (t.length !== 3) throw new Error('InvoiceCancelled: expected 3 topics');
      w = wordsOf(log.data, 1, 'InvoiceCancelled');
      return Object.assign({
        type: 'InvoiceCancelled',
        id: '0x' + topicWord(1),
        merchant: wordToAddress(topicWord(2), 'merchant'),
        cancelledAt: Number(wordToUint(w[0], MAX_UINT40, 'cancelledAt'))
      }, base);
    }
    return null;
  }

  function sameAddress(a, b) {
    return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  }

  /**
   * Decode many logs, dropping the ones that are not our events. With `contract` given, only logs emitted BY that
   * address are decoded: the same topics from any other address are ignored (a forged event cannot pass).
   */
  function decodeLogs(logs, contract) {
    var out = [];
    for (var i = 0; i < logs.length; i++) {
      if (contract && !sameAddress(logs[i] && logs[i].address, contract)) continue;
      var e = decodeLog(logs[i]);
      if (e) out.push(e);
    }
    return out;
  }

  /**
   * The contract's events inside a transaction receipt. Only logs whose address is `contract` count; on Arc a payment
   * receipt also holds system Transfer logs (from 0xffff...fffe) before and after InvoicePaid, which are skipped.
   * want = { type?: 'InvoicePaid' | 'InvoiceRegistered' | 'InvoiceCancelled', id?: invoice id } narrows the result.
   */
  function eventsFromReceipt(receipt, contract, want) {
    var out = [];
    var logs = receipt && Array.isArray(receipt.logs) ? receipt.logs : [];
    var wantId = want && want.id ? String(want.id).toLowerCase() : null;
    for (var i = 0; i < logs.length; i++) {
      var l = logs[i];
      if (!l || !sameAddress(l.address, contract)) continue;
      var e;
      try {
        e = decodeLog(l);
      } catch (err) {
        continue;
      }
      if (!e) continue;
      if (want && want.type && e.type !== want.type) continue;
      if (wantId && e.id !== wantId) continue;
      out.push(e);
    }
    return out;
  }

  /**
   * Decode revert data into { name, signature, selector, args }. Known: the contract's custom errors,
   * Error(string) and Panic(uint256). Returns null for empty or unknown data.
   */
  function decodeError(data) {
    if (typeof data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(data) || data.length < 10) return null;
    var selector = data.slice(0, 10).toLowerCase();
    var body = '0x' + data.slice(10);
    var name = ERROR_BY_SELECTOR[selector];
    try {
      if (name === 'InvoiceExpired') {
        return { name: name, signature: ERROR_SIGNATURES[name], selector: selector, args: { due: Number(wordToUint(wordsOf(body, 1, name)[0], MAX_UINT40, 'due')) } };
      }
      if (name === 'WrongAmount') {
        var w = wordsOf(body, 2, name);
        return { name: name, signature: ERROR_SIGNATURES[name], selector: selector, args: { expected: BigInt('0x' + w[0]), sent: BigInt('0x' + w[1]) } };
      }
      if (name) return { name: name, signature: ERROR_SIGNATURES[name], selector: selector, args: {} };
      if (selector === SOLIDITY_PANIC_SELECTOR) {
        return { name: 'Panic', signature: 'Panic(uint256)', selector: selector, args: { code: BigInt('0x' + wordsOf(body, 1, 'Panic')[0]) } };
      }
      if (selector === SOLIDITY_ERROR_SELECTOR) {
        var ww = wordsOf(body, 2, 'Error');
        var offset = Number(BigInt('0x' + ww[0]));
        var d = body.slice(2);
        var len = Number(BigInt('0x' + d.slice(offset * 2, offset * 2 + 64)));
        var strHex = d.slice(offset * 2 + 64, offset * 2 + 64 + len * 2);
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(len) || strHex.length !== len * 2) return null;
        return { name: 'Error', signature: 'Error(string)', selector: selector, args: { message: K.utf8Decode(K.hexToBytes('0x' + strHex)) } };
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  function isKnownErrorData(hex) {
    if (typeof hex !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(hex) || hex.length < 10) return false;
    var sel = hex.slice(0, 10).toLowerCase();
    return !!ERROR_BY_SELECTOR[sel] || sel === SOLIDITY_ERROR_SELECTOR || sel === SOLIDITY_PANIC_SELECTOR;
  }

  /**
   * Find revert data inside whatever a JSON-RPC client or wallet threw: error.data (hex), error.data.data,
   * error.error.data, error.info.error.data, error.cause ... or a 0x blob inside the message text.
   * Only returns data that starts with a selector this module can decode. Returns null if none.
   */
  function findRevertData(err) {
    var seen = [];
    var queue = [err];
    var depth = 0;
    while (queue.length && depth < 6) {
      var next = [];
      for (var i = 0; i < queue.length; i++) {
        var o = queue[i];
        if (o === null || o === undefined || seen.indexOf(o) !== -1) continue;
        if (typeof o === 'string') {
          if (isKnownErrorData(o)) return o.toLowerCase();
          var m = o.match(/0x[0-9a-fA-F]{8,}/g);
          if (m) {
            for (var k = 0; k < m.length; k++) {
              if (isKnownErrorData(m[k].length % 2 === 0 ? m[k] : m[k].slice(0, -1))) return (m[k].length % 2 === 0 ? m[k] : m[k].slice(0, -1)).toLowerCase();
            }
          }
          continue;
        }
        if (typeof o !== 'object') continue;
        seen.push(o);
        ['data', 'error', 'info', 'cause', 'originalError', 'result', 'message', 'reason', 'body'].forEach(function (key) {
          try {
            if (o[key] !== undefined) next.push(o[key]);
          } catch (e) { /* getter threw: ignore */ }
        });
      }
      queue = next;
      depth++;
    }
    return null;
  }

  return {
    STATUS: STATUS,
    STATUS_NAMES: STATUS_NAMES,
    SCALE: SCALE,
    MAX_UINT40: MAX_UINT40,
    MAX_UINT96: MAX_UINT96,
    ZERO_ADDRESS: ZERO_ADDRESS,
    SIGNATURES: SIGNATURES,
    EVENT_SIGNATURES: EVENT_SIGNATURES,
    ERROR_SIGNATURES: ERROR_SIGNATURES,
    SELECTORS: SELECTORS,
    TOPICS: TOPICS,
    ERROR_SELECTORS: ERROR_SELECTORS,
    isAddress: isAddress,
    isHash32: isHash32,
    toChecksumAddress: toChecksumAddress,
    hasValidChecksum: hasValidChecksum,
    addressTopic: addressTopic,
    invoiceId: invoiceId,
    encodeRegister: encodeRegister,
    encodePay: encodePay,
    encodeCancel: encodeCancel,
    encodeGetInvoice: encodeGetInvoice,
    encodeInvoiceIdCall: encodeInvoiceIdCall,
    encodeScale: encodeScale,
    decodeGetInvoice: decodeGetInvoice,
    decodeUint256: decodeUint256,
    decodeLog: decodeLog,
    decodeLogs: decodeLogs,
    eventsFromReceipt: eventsFromReceipt,
    decodeError: decodeError,
    findRevertData: findRevertData
  };
});
