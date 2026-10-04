'use strict';
// Unit tests for web/js/abi.js: the minimal ABI layer of the Arc Invoice Receipts web app.
// Independent references: ethers v6 Interface (human readable ABI and, when present, the compiled artifact),
// ethers AbiCoder / getAddress / zeroPadValue and the frozen constants of the contract.
// Random inputs come from a seeded PRNG, so every run checks exactly the same values.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ethers } = require('ethers');
const abi = require('../../web/js/abi.js');

let artifact = null;
try {
  artifact = require('../../artifacts/contracts/InvoiceReceipts.sol/InvoiceReceipts.json');
} catch (e) {
  artifact = null; // artifacts/ is git-ignored; the human readable ABI below is always available
}

const HUMAN_ABI = [
  'function register(bytes32 referenceHash, uint96 amount, uint40 due) returns (bytes32 id)',
  'function pay(bytes32 id) payable',
  'function cancel(bytes32 id)',
  'function getInvoice(bytes32 id) view returns ((address merchant, uint40 due, uint40 paidAt, uint8 status, bytes32 referenceHash, address payer, uint96 amount))',
  'function invoiceId(address merchant, bytes32 referenceHash) pure returns (bytes32)',
  'function SCALE() view returns (uint256)',
  'event InvoiceRegistered(bytes32 indexed id, address indexed merchant, bytes32 referenceHash, uint96 amount, uint40 due, uint40 createdAt)',
  'event InvoicePaid(bytes32 indexed id, address indexed merchant, address indexed payer, bytes32 referenceHash, uint96 amount, uint40 paidAt)',
  'event InvoiceCancelled(bytes32 indexed id, address indexed merchant, uint40 cancelledAt)',
  'error ZeroReferenceHash()',
  'error ZeroAmount()',
  'error DueNotInFuture()',
  'error AlreadyRegistered()',
  'error UnknownInvoice()',
  'error AlreadyPaid()',
  'error AlreadyCancelled()',
  'error InvoiceExpired(uint40 due)',
  'error WrongAmount(uint256 expected, uint256 sent)',
  'error NotMerchant()',
  'error TransferFailed()'
];

const IFACES = [{ name: 'human readable ABI', iface: new ethers.Interface(HUMAN_ABI) }];
if (artifact) IFACES.push({ name: 'compiled artifact ABI', iface: new ethers.Interface(artifact.abi) });
const IFACE = IFACES[0].iface;

const FROZEN_SELECTORS = {
  register: '0xcb4bf506',
  pay: '0x8609cad1',
  cancel: '0xc4d252f5',
  getInvoice: '0xcb802c8b',
  invoiceId: '0x55c75ddb',
  SCALE: '0xeced5526'
};
const FROZEN_TOPICS = {
  InvoiceRegistered: '0x6f21741846e8e723ce8fe41c97fa9a52a54c7bf27289d7005360b1ce650259ad',
  InvoicePaid: '0x475b64aed9d995ab76b150199e42b2fea5d216aa8a3f9b794d304935ab5ebe06',
  InvoiceCancelled: '0x594fb41ca05a48cdbf5828618f7effe625d8a8ca8af86121b06e5e2e62f73600'
};
const FROZEN_ERRORS = {
  ZeroReferenceHash: '0x329ba352',
  ZeroAmount: '0x1f2a2005',
  DueNotInFuture: '0x23253c74',
  AlreadyRegistered: '0x3a81d6fc',
  UnknownInvoice: '0xdec3891d',
  AlreadyPaid: '0xd70a0e30',
  AlreadyCancelled: '0x54e37625',
  InvoiceExpired: '0xc574c544',
  WrongAmount: '0x312b0033',
  NotMerchant: '0x3b6405f4',
  TransferFailed: '0x90b8ec18'
};
const NO_ARG_ERRORS = Object.keys(FROZEN_ERRORS).filter((n) => n !== 'InvoiceExpired' && n !== 'WrongAmount');

const N = 60; // random cases per cross-check (the brief asks for at least 40)
const MAX40 = (1n << 40n) - 1n;
const MAX96 = (1n << 96n) - 1n;
const MAX256 = (1n << 256n) - 1n;
const coder = ethers.AbiCoder.defaultAbiCoder();
const STATUS_NAMES = ['None', 'Open', 'Paid', 'Cancelled'];

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
const rng = mulberry32(0x41524331); // "ARC1"
const randInt = (n) => Math.floor(rng() * n);
function randBytes(n) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = randInt(256);
  return b;
}
const randHex = (n) => ethers.hexlify(randBytes(n)); // lowercase 0x hex
const randAddr = () => ethers.getAddress(randHex(20)); // checksummed
function randBig(bits) {
  // uniform value below 2^bits
  let v = 0n;
  for (let i = 0; i < Math.ceil(bits / 8); i++) v = (v << 8n) | BigInt(randInt(256));
  return v & ((1n << BigInt(bits)) - 1n);
}
function randBigVar(maxBits) {
  // random magnitude: a value whose bit length is itself random, so small and huge values both occur
  const bits = randInt(maxBits + 1);
  return bits === 0 ? 0n : randBig(bits) | (1n << BigInt(bits - 1));
}
const upperBody = (a) => '0x' + a.slice(2).toUpperCase();
function forms(v) {
  const out = [['BigInt', v], ['decimal string', v.toString(10)], ['hex string', '0x' + v.toString(16)]];
  if (v <= BigInt(Number.MAX_SAFE_INTEGER)) out.push(['Number', Number(v)]);
  return out;
}
function setWord(hex, index, value) {
  const start = 2 + 64 * index;
  return hex.slice(0, start) + value.toString(16).padStart(64, '0') + hex.slice(start + 64);
}
function setChar(hex, position, ch) {
  return hex.slice(0, position) + ch + hex.slice(position + 1);
}
const errorStringData = (msg) => ethers.concat(['0x08c379a0', coder.encode(['string'], [msg])]);
const panicData = (code) => ethers.concat(['0x4e487b71', coder.encode(['uint256'], [code])]);

describe('abi.js', function () {
  describe('constants: selectors, topics and error selectors', function () {
    it('SELECTORS equal the frozen values and contain nothing else', function () {
      assert.deepEqual(abi.SELECTORS, FROZEN_SELECTORS);
    });

    it('TOPICS equal the frozen values and contain nothing else', function () {
      assert.deepEqual(abi.TOPICS, FROZEN_TOPICS);
    });

    it('ERROR_SELECTORS equal the frozen values and contain nothing else', function () {
      assert.deepEqual(abi.ERROR_SELECTORS, FROZEN_ERRORS);
    });

    IFACES.forEach(function (entry) {
      it('SELECTORS, TOPICS, ERROR_SELECTORS and signatures equal the ethers values (' + entry.name + ')', function () {
        Object.keys(FROZEN_SELECTORS).forEach(function (n) {
          assert.equal(abi.SELECTORS[n], entry.iface.getFunction(n).selector, 'selector ' + n);
          assert.equal(abi.SIGNATURES[n], entry.iface.getFunction(n).format('sighash'), 'signature ' + n);
          assert.equal(abi.SELECTORS[n], ethers.id(abi.SIGNATURES[n]).slice(0, 10), 'keccak of signature ' + n);
        });
        Object.keys(FROZEN_TOPICS).forEach(function (n) {
          assert.equal(abi.TOPICS[n], entry.iface.getEvent(n).topicHash, 'topic ' + n);
          assert.equal(abi.EVENT_SIGNATURES[n], entry.iface.getEvent(n).format('sighash'), 'event signature ' + n);
          assert.equal(abi.TOPICS[n], ethers.id(abi.EVENT_SIGNATURES[n]), 'keccak of event signature ' + n);
        });
        Object.keys(FROZEN_ERRORS).forEach(function (n) {
          assert.equal(abi.ERROR_SELECTORS[n], entry.iface.getError(n).selector, 'error ' + n);
          assert.equal(abi.ERROR_SIGNATURES[n], entry.iface.getError(n).format('sighash'), 'error signature ' + n);
          assert.equal(abi.ERROR_SELECTORS[n], ethers.id(abi.ERROR_SIGNATURES[n]).slice(0, 10), 'keccak of error signature ' + n);
        });
        assert.equal(Object.keys(abi.SIGNATURES).length, entry.iface.fragments.filter((f) => f.type === 'function').length);
        assert.equal(Object.keys(abi.EVENT_SIGNATURES).length, entry.iface.fragments.filter((f) => f.type === 'event').length);
        assert.equal(Object.keys(abi.ERROR_SIGNATURES).length, entry.iface.fragments.filter((f) => f.type === 'error').length);
      });
    });

    it('the human readable ABI used here agrees with the compiled artifact', function () {
      if (!artifact) return this.skip();
      const a = IFACES[0].iface;
      const b = IFACES[1].iface;
      Object.keys(FROZEN_SELECTORS).forEach((n) => assert.equal(a.getFunction(n).selector, b.getFunction(n).selector));
      Object.keys(FROZEN_TOPICS).forEach((n) => assert.equal(a.getEvent(n).topicHash, b.getEvent(n).topicHash));
      Object.keys(FROZEN_ERRORS).forEach((n) => assert.equal(a.getError(n).selector, b.getError(n).selector));
    });

    it('numeric and enum constants', function () {
      assert.equal(abi.SCALE, 10n ** 12n);
      assert.equal(abi.MAX_UINT40, 2n ** 40n - 1n);
      assert.equal(abi.MAX_UINT96, 2n ** 96n - 1n);
      assert.equal(abi.ZERO_ADDRESS, ethers.ZeroAddress);
      assert.deepEqual(abi.STATUS, { None: 0, Open: 1, Paid: 2, Cancelled: 3 });
      assert.deepEqual(abi.STATUS_NAMES, STATUS_NAMES);
    });

    it('exposes the documented API as functions', function () {
      [
        'isAddress', 'isHash32', 'toChecksumAddress', 'hasValidChecksum', 'addressTopic', 'invoiceId', 'encodeRegister', 'encodePay',
        'encodeCancel', 'encodeGetInvoice', 'encodeInvoiceIdCall', 'encodeScale', 'decodeGetInvoice', 'decodeUint256', 'decodeLog',
        'decodeLogs', 'decodeError', 'findRevertData'
      ].forEach((n) => assert.equal(typeof abi[n], 'function', n));
    });
  });

  describe('calldata encoders vs Interface.encodeFunctionData', function () {
    IFACES.forEach(function (entry) {
      const iface = entry.iface;
      const tag = ' (' + entry.name + ')';

      it('encodeRegister: ' + N + ' random inputs, each given as BigInt, decimal string, hex string and Number' + tag, function () {
        let cases = 0;
        for (let i = 0; i < N; i++) {
          const hash = randHex(32);
          const amount = randBigVar(96);
          const due = randBigVar(40);
          const want = iface.encodeFunctionData('register', [hash, amount, due]);
          forms(amount).forEach(function (fa) {
            forms(due).forEach(function (fd) {
              assert.equal(abi.encodeRegister(hash, fa[1], fd[1]), want, fa[0] + ' amount ' + amount + ', ' + fd[0] + ' due ' + due);
            });
          });
          cases++;
        }
        assert.equal(cases, N);
      });

      it('encodeRegister: edge values (amount 0, 1, 1e12, MAX_UINT96; due 0, 1, MAX_UINT40)' + tag, function () {
        const hash = '0x' + 'ff'.repeat(32);
        [0n, 1n, 1250000n, 10n ** 12n, MAX96 - 1n, MAX96].forEach(function (amount) {
          [0n, 1n, 1893456000n, MAX40 - 1n, MAX40].forEach(function (due) {
            const want = iface.encodeFunctionData('register', [hash, amount, due]);
            assert.equal(abi.encodeRegister(hash, amount, due), want, amount + '/' + due);
            assert.equal(abi.encodeRegister(hash, amount.toString(), Number(due)), want, amount + '/' + due + ' string/Number');
          });
        });
      });

      it('encodeRegister: upper case hash hex is accepted and the output is all lower case' + tag, function () {
        for (let i = 0; i < 40; i++) {
          const hash = randHex(32);
          const out = abi.encodeRegister(upperBody(hash), 5, 6);
          assert.equal(out, iface.encodeFunctionData('register', [hash, 5n, 6n]));
          assert.match(out, /^0x[0-9a-f]+$/);
        }
      });

      it('encodePay, encodeCancel and encodeGetInvoice: ' + N + ' random ids each' + tag, function () {
        let cases = 0;
        for (let i = 0; i < N; i++) {
          const id = randHex(32);
          assert.equal(abi.encodePay(id), iface.encodeFunctionData('pay', [id]));
          assert.equal(abi.encodeCancel(id), iface.encodeFunctionData('cancel', [id]));
          assert.equal(abi.encodeGetInvoice(id), iface.encodeFunctionData('getInvoice', [id]));
          assert.equal(abi.encodePay(upperBody(id)), iface.encodeFunctionData('pay', [id]));
          cases++;
        }
        assert.equal(cases, N);
        const zero = '0x' + '00'.repeat(32);
        assert.equal(abi.encodePay(zero), iface.encodeFunctionData('pay', [zero]));
        const ones = '0x' + 'ff'.repeat(32);
        assert.equal(abi.encodeCancel(ones), iface.encodeFunctionData('cancel', [ones]));
      });

      it('encodeInvoiceIdCall: ' + N + ' random inputs with checksummed, lower case and upper case merchants' + tag, function () {
        let cases = 0;
        for (let i = 0; i < N; i++) {
          const merchant = randAddr();
          const hash = randHex(32);
          const want = iface.encodeFunctionData('invoiceId', [merchant, hash]);
          assert.equal(abi.encodeInvoiceIdCall(merchant, hash), want);
          assert.equal(abi.encodeInvoiceIdCall(merchant.toLowerCase(), hash), want);
          assert.equal(abi.encodeInvoiceIdCall(upperBody(merchant), hash), want);
          assert.equal(abi.encodeInvoiceIdCall(merchant, upperBody(hash)), want);
          cases++;
        }
        assert.equal(cases, N);
      });

      it('encodeScale equals the ethers calldata for SCALE()' + tag, function () {
        assert.equal(abi.encodeScale(), iface.encodeFunctionData('SCALE'));
        assert.equal(abi.encodeScale(), '0xeced5526');
      });
    });
  });

  describe('encoder input validation', function () {
    const HASH = '0x' + 'ab'.repeat(32);
    const ADDR = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
    const BAD_UINTS = [
      ['negative BigInt', -1n],
      ['negative Number', -1],
      ['negative decimal string', '-1'],
      ['negative zero string', '-0'],
      ['non-integer Number', 1.5],
      ['0.1 + 0.2', 0.1 + 0.2],
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['-Infinity', -Infinity],
      ['unsafe integer Number 2^53', 2 ** 53],
      ['1e21 Number', 1e21],
      ['decimal fraction string', '1.5'],
      ['exponent string', '1e3'],
      ['empty string', ''],
      ['leading space', ' 1'],
      ['trailing space', '1 '],
      ['plus sign', '+1'],
      ['0x only', '0x'],
      ['bad hex digits', '0xzz'],
      ['words', 'one'],
      ['null', null],
      ['undefined', undefined],
      ['boolean', true],
      ['object', {}],
      ['array', [1]]
    ];
    const BAD_AMOUNTS = BAD_UINTS.concat([
      ['2^96 BigInt', 2n ** 96n],
      ['2^96 decimal string', (2n ** 96n).toString()],
      ['2^96 hex string', '0x1' + '0'.repeat(24)],
      ['2^96 + 1', 2n ** 96n + 1n],
      ['2^128', 2n ** 128n],
      ['MAX_UINT256', MAX256]
    ]);
    const BAD_DUES = BAD_UINTS.concat([
      ['2^40 BigInt', 2n ** 40n],
      ['2^40 Number', 2 ** 40],
      ['2^40 decimal string', (2n ** 40n).toString()],
      ['2^40 hex string', '0x10000000000'],
      ['2^41', 2n ** 41n],
      ['MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
      ['2^96 - 1 (a valid amount is not a valid due)', MAX96]
    ]);
    const BAD_HASHES = [
      ['empty string', ''],
      ['0x only', '0x'],
      ['too short', '0x12'],
      ['31 bytes', '0x' + 'ab'.repeat(31)],
      ['33 bytes', '0x' + 'ab'.repeat(33)],
      ['no 0x prefix', 'ab'.repeat(32)],
      ['upper case 0X prefix', '0X' + 'ab'.repeat(32)],
      ['non-hex digits', '0x' + 'zz'.repeat(32)],
      ['one bad digit', '0x' + 'ab'.repeat(31) + 'ag'],
      ['leading space', ' 0x' + 'ab'.repeat(32)],
      ['trailing newline', '0x' + 'ab'.repeat(32) + '\n'],
      ['an address (20 bytes)', ADDR],
      ['a number', 123],
      ['a bigint', 1n],
      ['null', null],
      ['undefined', undefined],
      ['a Uint8Array', new Uint8Array(32)],
      ['an object', {}]
    ];
    const BAD_ADDRESSES = [
      ['empty string', ''],
      ['0x only', '0x'],
      ['too short (39 digits)', '0x' + 'ab'.repeat(19) + 'a'],
      ['too long (41 digits)', '0x' + 'ab'.repeat(20) + 'a'],
      ['a 32 byte hash', HASH],
      ['no 0x prefix', 'ab'.repeat(20)],
      ['upper case 0X prefix', '0X' + 'ab'.repeat(20)],
      ['non-hex digits', '0x' + 'gg'.repeat(20)],
      ['leading space', ' ' + ADDR],
      ['trailing newline', ADDR + '\n'],
      ['a number', 123],
      ['null', null],
      ['undefined', undefined],
      ['a Uint8Array', new Uint8Array(20)],
      ['an object', {}]
    ];

    it('encodeRegister throws for every invalid or out of range amount', function () {
      BAD_AMOUNTS.forEach((c) => assert.throws(() => abi.encodeRegister(HASH, c[1], 1000), /amount/, c[0]));
    });

    it('encodeRegister throws for every invalid or out of range due', function () {
      BAD_DUES.forEach((c) => assert.throws(() => abi.encodeRegister(HASH, 1000, c[1]), /due/, c[0]));
    });

    it('encodeRegister throws for every invalid referenceHash', function () {
      BAD_HASHES.forEach((c) => assert.throws(() => abi.encodeRegister(c[1], 1, 1), /referenceHash/, c[0]));
    });

    it('the exact boundaries are accepted: amount MAX_UINT96, due MAX_UINT40, amount 0, due 0', function () {
      assert.doesNotThrow(() => abi.encodeRegister(HASH, MAX96, MAX40));
      assert.doesNotThrow(() => abi.encodeRegister(HASH, 0, 0));
      assert.doesNotThrow(() => abi.encodeRegister(HASH, Number.MAX_SAFE_INTEGER, 2 ** 40 - 1));
    });

    it('encodePay, encodeCancel and encodeGetInvoice throw for every invalid id', function () {
      BAD_HASHES.forEach(function (c) {
        assert.throws(() => abi.encodePay(c[1]), /id/, 'pay ' + c[0]);
        assert.throws(() => abi.encodeCancel(c[1]), /id/, 'cancel ' + c[0]);
        assert.throws(() => abi.encodeGetInvoice(c[1]), /id/, 'getInvoice ' + c[0]);
      });
    });

    it('encodeInvoiceIdCall and invoiceId throw for invalid merchants and hashes', function () {
      BAD_ADDRESSES.forEach(function (c) {
        assert.throws(() => abi.encodeInvoiceIdCall(c[1], HASH), /merchant/, 'call ' + c[0]);
        assert.throws(() => abi.invoiceId(c[1], HASH), /merchant/, 'id ' + c[0]);
      });
      BAD_HASHES.forEach(function (c) {
        assert.throws(() => abi.encodeInvoiceIdCall(ADDR, c[1]), /referenceHash/, 'call ' + c[0]);
        assert.throws(() => abi.invoiceId(ADDR, c[1]), /referenceHash/, 'id ' + c[0]);
      });
    });

    it('addressTopic throws for invalid addresses', function () {
      BAD_ADDRESSES.forEach((c) => assert.throws(() => abi.addressTopic(c[1]), /address/, c[0]));
    });
  });

  describe('invoiceId', function () {
    it('equals keccak256(abi.encode(address, bytes32)) for ' + N + ' random inputs', function () {
      let cases = 0;
      for (let i = 0; i < N; i++) {
        const merchant = randAddr();
        const hash = randHex(32);
        const want = ethers.keccak256(coder.encode(['address', 'bytes32'], [merchant, hash]));
        assert.equal(abi.invoiceId(merchant, hash), want);
        assert.equal(abi.invoiceId(merchant.toLowerCase(), hash), want, 'lower case merchant');
        assert.equal(abi.invoiceId(upperBody(merchant), hash), want, 'upper case merchant');
        assert.equal(abi.invoiceId(merchant, upperBody(hash)), want, 'upper case hash');
        assert.equal(want, ethers.keccak256(ethers.concat([ethers.zeroPadValue(merchant, 32), hash])), 'padded concatenation');
        assert.match(abi.invoiceId(merchant, hash), /^0x[0-9a-f]{64}$/);
        cases++;
      }
      assert.equal(cases, N);
    });

    it('mixed-case, lower-case and upper-case spellings of one merchant give the same id', function () {
      const checksummed = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
      const hash = ethers.id('invoice #1');
      const want = ethers.keccak256(coder.encode(['address', 'bytes32'], [checksummed, hash]));
      assert.equal(abi.invoiceId(checksummed, hash), want);
      assert.equal(abi.invoiceId(checksummed.toLowerCase(), hash), want);
      assert.equal(abi.invoiceId(upperBody(checksummed), hash), want);
    });

    it('depends on both arguments and on their order', function () {
      const a = randAddr();
      const b = randAddr();
      const h1 = randHex(32);
      const h2 = randHex(32);
      assert.notEqual(abi.invoiceId(a, h1), abi.invoiceId(b, h1));
      assert.notEqual(abi.invoiceId(a, h1), abi.invoiceId(a, h2));
    });

    it('agrees with the contract function through the calldata encoder (same address word and hash word)', function () {
      const merchant = randAddr();
      const hash = randHex(32);
      const call = abi.encodeInvoiceIdCall(merchant, hash);
      assert.equal(ethers.keccak256('0x' + call.slice(10)), abi.invoiceId(merchant, hash));
    });
  });

  describe('decodeGetInvoice vs ethers', function () {
    function randomInvoice(status) {
      return {
        merchant: randAddr(),
        due: randBigVar(40),
        paidAt: randBigVar(40),
        status: BigInt(status === undefined ? randInt(4) : status),
        referenceHash: randHex(32),
        payer: randAddr(),
        amount: randBigVar(96)
      };
    }
    const tuple = (inv) => [inv.merchant, inv.due, inv.paidAt, inv.status, inv.referenceHash, inv.payer, inv.amount];
    const encodeResult = (iface, inv) => iface.encodeFunctionResult('getInvoice', [tuple(inv)]);
    function expected(inv) {
      const status = Number(inv.status);
      return {
        merchant: ethers.getAddress(inv.merchant),
        due: Number(inv.due),
        paidAt: Number(inv.paidAt),
        status: status,
        statusName: STATUS_NAMES[status],
        referenceHash: inv.referenceHash.toLowerCase(),
        payer: ethers.getAddress(inv.payer),
        amount: inv.amount
      };
    }

    IFACES.forEach(function (entry) {
      const iface = entry.iface;
      it('decodes ' + N + ' random tuples (status 0..3) field by field (' + entry.name + ')', function () {
        let cases = 0;
        for (let i = 0; i < N; i++) {
          const inv = randomInvoice(i % 4);
          const data = encodeResult(iface, inv);
          const got = abi.decodeGetInvoice(data);
          assert.deepEqual(got, expected(inv), 'case ' + i);
          // types
          assert.equal(typeof got.due, 'number');
          assert.equal(typeof got.paidAt, 'number');
          assert.equal(typeof got.status, 'number');
          assert.equal(typeof got.amount, 'bigint');
          assert.equal(got.statusName, STATUS_NAMES[got.status]);
          assert.match(got.referenceHash, /^0x[0-9a-f]{64}$/);
          // an independent decode by ethers sees the same values
          const ref = iface.decodeFunctionResult('getInvoice', data)[0];
          assert.equal(got.merchant, ref.merchant);
          assert.equal(got.payer, ref.payer);
          assert.equal(BigInt(got.due), ref.due);
          assert.equal(BigInt(got.paidAt), ref.paidAt);
          assert.equal(BigInt(got.status), ref.status);
          assert.equal(got.amount, ref.amount);
          assert.equal(got.referenceHash, ref.referenceHash);
          // upper case return data decodes the same
          assert.deepEqual(abi.decodeGetInvoice('0x' + data.slice(2).toUpperCase()), got, 'upper case data');
          cases++;
        }
        assert.equal(cases, N);
      });

      it('decodes the edge tuples: all zero, all max, zero addresses, every status (' + entry.name + ')', function () {
        const zeros = { merchant: ethers.ZeroAddress, due: 0n, paidAt: 0n, status: 0n, referenceHash: '0x' + '00'.repeat(32), payer: ethers.ZeroAddress, amount: 0n };
        const maxed = {
          merchant: '0x' + 'ff'.repeat(20), due: MAX40, paidAt: MAX40, status: 3n, referenceHash: '0x' + 'ff'.repeat(32),
          payer: '0x' + 'ff'.repeat(20), amount: MAX96
        };
        const odd = { merchant: ethers.ZeroAddress, due: 1n, paidAt: 0n, status: 1n, referenceHash: randHex(32), payer: '0x' + '00'.repeat(19) + '01', amount: 1n };
        [zeros, maxed, odd].forEach(function (inv) {
          assert.deepEqual(abi.decodeGetInvoice(encodeResult(iface, inv)), expected(inv));
        });
        const none = abi.decodeGetInvoice(encodeResult(iface, zeros));
        assert.equal(none.status, abi.STATUS.None);
        assert.equal(none.statusName, 'None');
        assert.equal(none.merchant, '0x0000000000000000000000000000000000000000');
        assert.equal(none.payer, '0x0000000000000000000000000000000000000000');
        assert.equal(none.amount, 0n);
        for (let s = 0; s <= 3; s++) {
          const got = abi.decodeGetInvoice(encodeResult(iface, Object.assign({}, odd, { status: BigInt(s) })));
          assert.equal(got.status, s);
          assert.equal(got.statusName, STATUS_NAMES[s]);
        }
        const big = abi.decodeGetInvoice(encodeResult(iface, maxed));
        assert.equal(big.due, 1099511627775);
        assert.equal(big.amount, 79228162514264337593543950335n);
        assert.equal(big.referenceHash, '0x' + 'ff'.repeat(32));
      });
    });

    describe('rejects malformed return data', function () {
      const good = encodeResult(IFACE, randomInvoice(1));
      assert.equal(good.length, 2 + 7 * 64);

      it('short data: fewer than 7 words, one byte short, and "0x"', function () {
        assert.throws(() => abi.decodeGetInvoice(good.slice(0, good.length - 2)), /short/);
        assert.throws(() => abi.decodeGetInvoice(good.slice(0, 2 + 64 * 6)), /short/);
        assert.throws(() => abi.decodeGetInvoice(good.slice(0, 2 + 64)), /short/);
        assert.throws(() => abi.decodeGetInvoice('0x'), /short/);
      });

      it('non-hex input: bad digits, no prefix, odd length, wrong types', function () {
        assert.throws(() => abi.decodeGetInvoice('0x' + 'zz'.repeat(7 * 32)), /hex/);
        assert.throws(() => abi.decodeGetInvoice(good.slice(2)), /hex/);
        assert.throws(() => abi.decodeGetInvoice(good + '0'), /hex/);
        assert.throws(() => abi.decodeGetInvoice('hello'), /hex/);
        assert.throws(() => abi.decodeGetInvoice(''), /hex/);
        [undefined, null, 123, {}, [], new Uint8Array(224)].forEach((v) => assert.throws(() => abi.decodeGetInvoice(v), /hex/));
      });

      it('a dirty address word (non-zero upper 12 bytes) for merchant or payer', function () {
        [0, 23].forEach(function (offset) {
          assert.throws(() => abi.decodeGetInvoice(setChar(good, 2 + 64 * 0 + offset, '1')), /merchant/, 'merchant at char ' + offset);
          assert.throws(() => abi.decodeGetInvoice(setChar(good, 2 + 64 * 5 + offset, 'f')), /payer/, 'payer at char ' + offset);
        });
        assert.throws(() => abi.decodeGetInvoice(setWord(good, 0, 1n << 160n)), /merchant/);
        assert.throws(() => abi.decodeGetInvoice(setWord(good, 5, MAX256)), /payer/);
      });

      it('status above 3 (4, 5, 255, 256, max word)', function () {
        [4n, 5n, 255n, 256n, MAX256].forEach(function (s) {
          assert.throws(() => abi.decodeGetInvoice(setWord(good, 3, s)), /status/, 'status ' + s);
        });
        for (let s = 0n; s <= 3n; s++) assert.doesNotThrow(() => abi.decodeGetInvoice(setWord(good, 3, s)));
      });

      it('due, paidAt or amount words that do not fit uint40 / uint40 / uint96', function () {
        assert.throws(() => abi.decodeGetInvoice(setWord(good, 1, 1n << 40n)), /due/);
        assert.throws(() => abi.decodeGetInvoice(setWord(good, 2, 1n << 40n)), /paidAt/);
        assert.throws(() => abi.decodeGetInvoice(setWord(good, 6, 1n << 96n)), /amount/);
        assert.doesNotThrow(() => abi.decodeGetInvoice(setWord(good, 1, MAX40)));
        assert.doesNotThrow(() => abi.decodeGetInvoice(setWord(good, 2, MAX40)));
        assert.doesNotThrow(() => abi.decodeGetInvoice(setWord(good, 6, MAX96)));
      });
    });
  });

  describe('decodeUint256', function () {
    it('decodes the SCALE() return value to 10^12', function () {
      IFACES.forEach(function (entry) {
        const data = entry.iface.encodeFunctionResult('SCALE', [10n ** 12n]);
        assert.equal(abi.decodeUint256(data), 10n ** 12n);
        assert.equal(abi.decodeUint256(data), abi.SCALE);
        assert.equal(abi.decodeUint256(data), entry.iface.decodeFunctionResult('SCALE', data)[0]);
      });
    });

    it('matches ethers for ' + N + ' random uint256 values and the edges', function () {
      let cases = 0;
      for (let i = 0; i < N; i++) {
        const v = randBigVar(256);
        assert.equal(abi.decodeUint256(coder.encode(['uint256'], [v])), v);
        cases++;
      }
      assert.equal(cases, N);
      [0n, 1n, MAX256, 1n << 255n].forEach((v) => assert.equal(abi.decodeUint256(coder.encode(['uint256'], [v])), v));
    });

    it('throws on short or non-hex data', function () {
      assert.throws(() => abi.decodeUint256('0x'), /short/);
      assert.throws(() => abi.decodeUint256('0x' + '00'.repeat(31)), /short/);
      assert.throws(() => abi.decodeUint256('0x' + 'zz'.repeat(32)), /hex/);
      assert.throws(() => abi.decodeUint256(undefined), /hex/);
      assert.throws(() => abi.decodeUint256(5), /hex/);
    });
  });

  describe('decodeLog and decodeLogs', function () {
    const CONTRACT = randAddr();
    function rpcLog(iface, name, args, extra) {
      const enc = iface.encodeEventLog(name, args);
      return Object.assign(
        {
          address: CONTRACT,
          topics: enc.topics,
          data: enc.data,
          blockNumber: '0x10',
          logIndex: '0x2',
          transactionHash: randHex(32),
          blockHash: randHex(32),
          removed: false
        },
        extra || {}
      );
    }
    function baseOf(log) {
      return {
        address: log.address.toLowerCase(),
        blockNumber: Number(BigInt(log.blockNumber)),
        logIndex: Number(BigInt(log.logIndex)),
        txHash: log.transactionHash.toLowerCase(),
        blockHash: log.blockHash.toLowerCase()
      };
    }
    const randRegistered = () => ({ id: randHex(32), merchant: randAddr(), referenceHash: randHex(32), amount: randBigVar(96), due: randBigVar(40), createdAt: randBigVar(40) });
    const randPaid = () => ({ id: randHex(32), merchant: randAddr(), payer: randAddr(), referenceHash: randHex(32), amount: randBigVar(96), paidAt: randBigVar(40) });
    const randCancelled = () => ({ id: randHex(32), merchant: randAddr(), cancelledAt: randBigVar(40) });
    const regArgs = (e) => [e.id, e.merchant, e.referenceHash, e.amount, e.due, e.createdAt];
    const paidArgs = (e) => [e.id, e.merchant, e.payer, e.referenceHash, e.amount, e.paidAt];
    const cancelArgs = (e) => [e.id, e.merchant, e.cancelledAt];
    const wantRegistered = (e, log) =>
      Object.assign({ type: 'InvoiceRegistered', id: e.id, merchant: ethers.getAddress(e.merchant), referenceHash: e.referenceHash, amount: e.amount, due: Number(e.due), createdAt: Number(e.createdAt) }, baseOf(log));
    const wantPaid = (e, log) =>
      Object.assign({ type: 'InvoicePaid', id: e.id, merchant: ethers.getAddress(e.merchant), payer: ethers.getAddress(e.payer), referenceHash: e.referenceHash, amount: e.amount, paidAt: Number(e.paidAt) }, baseOf(log));
    const wantCancelled = (e, log) =>
      Object.assign({ type: 'InvoiceCancelled', id: e.id, merchant: ethers.getAddress(e.merchant), cancelledAt: Number(e.cancelledAt) }, baseOf(log));
    const randomBase = () => ({
      blockNumber: '0x' + randBig(40).toString(16),
      logIndex: '0x' + randInt(65536).toString(16)
    });
    const UNRELATED_TOPIC = ethers.id('Transfer(address,address,uint256)');

    IFACES.forEach(function (entry) {
      const iface = entry.iface;
      const tag = ' (' + entry.name + ')';

      it('InvoiceRegistered: ' + N + ' random logs, every field, base fields (blockNumber 0x10 -> 16, logIndex 0x2 -> 2)' + tag, function () {
        let cases = 0;
        for (let i = 0; i < N; i++) {
          const e = randRegistered();
          const log = rpcLog(iface, 'InvoiceRegistered', regArgs(e), i === 0 ? {} : randomBase());
          const got = abi.decodeLog(log);
          assert.deepEqual(got, wantRegistered(e, log), 'case ' + i);
          const parsed = iface.parseLog({ topics: log.topics, data: log.data });
          assert.equal(parsed.name, 'InvoiceRegistered');
          assert.equal(got.id, parsed.args.id);
          assert.equal(got.merchant, parsed.args.merchant);
          assert.equal(got.referenceHash, parsed.args.referenceHash);
          assert.equal(got.amount, parsed.args.amount);
          assert.equal(BigInt(got.due), parsed.args.due);
          assert.equal(BigInt(got.createdAt), parsed.args.createdAt);
          cases++;
        }
        assert.equal(cases, N);
      });

      it('InvoicePaid: ' + N + ' random logs, every field' + tag, function () {
        let cases = 0;
        for (let i = 0; i < N; i++) {
          const e = randPaid();
          const log = rpcLog(iface, 'InvoicePaid', paidArgs(e), i === 0 ? {} : randomBase());
          const got = abi.decodeLog(log);
          assert.deepEqual(got, wantPaid(e, log), 'case ' + i);
          const parsed = iface.parseLog({ topics: log.topics, data: log.data });
          assert.equal(parsed.name, 'InvoicePaid');
          assert.equal(got.id, parsed.args.id);
          assert.equal(got.merchant, parsed.args.merchant);
          assert.equal(got.payer, parsed.args.payer);
          assert.equal(got.referenceHash, parsed.args.referenceHash);
          assert.equal(got.amount, parsed.args.amount);
          assert.equal(BigInt(got.paidAt), parsed.args.paidAt);
          cases++;
        }
        assert.equal(cases, N);
      });

      it('InvoiceCancelled: ' + N + ' random logs, every field' + tag, function () {
        let cases = 0;
        for (let i = 0; i < N; i++) {
          const e = randCancelled();
          const log = rpcLog(iface, 'InvoiceCancelled', cancelArgs(e), i === 0 ? {} : randomBase());
          const got = abi.decodeLog(log);
          assert.deepEqual(got, wantCancelled(e, log), 'case ' + i);
          const parsed = iface.parseLog({ topics: log.topics, data: log.data });
          assert.equal(parsed.name, 'InvoiceCancelled');
          assert.equal(got.id, parsed.args.id);
          assert.equal(got.merchant, parsed.args.merchant);
          assert.equal(BigInt(got.cancelledAt), parsed.args.cancelledAt);
          cases++;
        }
        assert.equal(cases, N);
      });

      it('edge values: zero hash and addresses, max uint96 / uint40' + tag, function () {
        const reg = { id: '0x' + '00'.repeat(32), merchant: ethers.ZeroAddress, referenceHash: '0x' + 'ff'.repeat(32), amount: MAX96, due: MAX40, createdAt: 0n };
        const logR = rpcLog(iface, 'InvoiceRegistered', regArgs(reg));
        assert.deepEqual(abi.decodeLog(logR), wantRegistered(reg, logR));
        const paid = { id: '0x' + 'ff'.repeat(32), merchant: '0x' + 'ff'.repeat(20), payer: ethers.ZeroAddress, referenceHash: '0x' + '00'.repeat(32), amount: 1n, paidAt: MAX40 };
        const logP = rpcLog(iface, 'InvoicePaid', paidArgs(paid));
        assert.deepEqual(abi.decodeLog(logP), wantPaid(paid, logP));
        const canc = { id: randHex(32), merchant: randAddr(), cancelledAt: 0n };
        const logC = rpcLog(iface, 'InvoiceCancelled', cancelArgs(canc));
        assert.deepEqual(abi.decodeLog(logC), wantCancelled(canc, logC));
      });
    });

    it('base fields: blockNumber 0x10 -> 16, logIndex 0x2 -> 2 (Numbers), hashes and address lower-cased', function () {
      const e = randRegistered();
      const log = rpcLog(IFACE, 'InvoiceRegistered', regArgs(e), {
        transactionHash: upperBody(randHex(32)),
        blockHash: upperBody(randHex(32))
      });
      const got = abi.decodeLog(log);
      assert.equal(got.blockNumber, 16);
      assert.equal(got.logIndex, 2);
      assert.equal(typeof got.blockNumber, 'number');
      assert.equal(typeof got.logIndex, 'number');
      assert.equal(got.txHash, log.transactionHash.toLowerCase());
      assert.equal(got.blockHash, log.blockHash.toLowerCase());
      assert.equal(got.address, CONTRACT.toLowerCase());
      assert.match(got.txHash, /^0x[0-9a-f]{64}$/);
    });

    it('base fields: numbers are accepted, missing or null fields become null', function () {
      const e = randCancelled();
      const num = abi.decodeLog(rpcLog(IFACE, 'InvoiceCancelled', cancelArgs(e), { blockNumber: 16, logIndex: 2 }));
      assert.equal(num.blockNumber, 16);
      assert.equal(num.logIndex, 2);
      const log = rpcLog(IFACE, 'InvoiceCancelled', cancelArgs(e));
      ['address', 'blockNumber', 'logIndex', 'transactionHash', 'blockHash'].forEach(function (k) {
        delete log[k];
      });
      const bare = abi.decodeLog(log);
      assert.equal(bare.address, null);
      assert.equal(bare.blockNumber, null);
      assert.equal(bare.logIndex, null);
      assert.equal(bare.txHash, null);
      assert.equal(bare.blockHash, null);
      assert.equal(bare.id, e.id);
      const nulls = abi.decodeLog(Object.assign({}, log, { blockNumber: null, logIndex: null }));
      assert.equal(nulls.blockNumber, null);
      assert.equal(nulls.logIndex, null);
    });

    it('base fields: a malformed blockNumber or logIndex of one of our events throws', function () {
      const log = rpcLog(IFACE, 'InvoiceCancelled', cancelArgs(randCancelled()));
      ['0xzz', '16', '0x', 'abc', 1.5, {}, [], true].forEach(function (bad) {
        assert.throws(() => abi.decodeLog(Object.assign({}, log, { blockNumber: bad })), /blockNumber/, 'blockNumber ' + String(bad));
        assert.throws(() => abi.decodeLog(Object.assign({}, log, { logIndex: bad })), /logIndex/, 'logIndex ' + String(bad));
      });
    });

    it('topic0 and data may be upper case; the result is the same', function () {
      const e = randPaid();
      const log = rpcLog(IFACE, 'InvoicePaid', paidArgs(e));
      const upper = Object.assign({}, log, { topics: [upperBody(log.topics[0])].concat(log.topics.slice(1).map(upperBody)), data: upperBody(log.data) });
      assert.deepEqual(abi.decodeLog(upper), abi.decodeLog(log));
    });

    it('returns null for an unrelated topic0 (ERC-20 Transfer, random topics, a fake event)', function () {
      const transfer = { address: randAddr(), topics: [UNRELATED_TOPIC, ethers.zeroPadValue(randAddr(), 32), ethers.zeroPadValue(randAddr(), 32)], data: coder.encode(['uint256'], [5n]), blockNumber: '0x10', logIndex: '0x2', transactionHash: randHex(32), blockHash: randHex(32) };
      assert.equal(abi.decodeLog(transfer), null);
      for (let i = 0; i < 40; i++) {
        const log = { address: randAddr(), topics: [randHex(32)].concat(Array.from({ length: randInt(4) }, () => randHex(32))), data: randHex(randInt(200)), blockNumber: '0x1', logIndex: '0x0' };
        assert.equal(abi.decodeLog(log), null, 'case ' + i);
      }
      assert.equal(abi.decodeLog({ topics: [ethers.id('InvoiceRegistered(bytes32,address)')] }), null);
    });

    it('returns null for logs without topics and for non-objects', function () {
      assert.equal(abi.decodeLog({ address: CONTRACT, topics: [], data: '0x' }), null);
      assert.equal(abi.decodeLog({ address: CONTRACT, data: '0x' }), null);
      assert.equal(abi.decodeLog({ topics: null }), null);
      assert.equal(abi.decodeLog({ topics: 'nope' }), null);
      assert.equal(abi.decodeLog({ topics: [123] }), null);
      assert.equal(abi.decodeLog({}), null);
      assert.equal(abi.decodeLog(null), null);
      assert.equal(abi.decodeLog(undefined), null);
    });

    // BUG (reported): decodeLog parses blockNumber/logIndex BEFORE it looks at topic0, so a log that is not one of
    // our events but has a non-hex-quantity blockNumber throws instead of returning null as documented
    // ("Returns null when topic0 is not one of the three events"). decodeLogs then throws for the whole batch.
    it('returns null (does not throw) for an unrelated log whose blockNumber is not a hex quantity', function () {
      const log = { address: randAddr(), topics: [UNRELATED_TOPIC], data: '0x', blockNumber: '16', logIndex: '0x0' };
      assert.equal(abi.decodeLog(log), null);
    });

    it('throws for a known event with the wrong topic count', function () {
      const reg = rpcLog(IFACE, 'InvoiceRegistered', regArgs(randRegistered()));
      const paid = rpcLog(IFACE, 'InvoicePaid', paidArgs(randPaid()));
      const canc = rpcLog(IFACE, 'InvoiceCancelled', cancelArgs(randCancelled()));
      const extra = randHex(32);
      [reg, canc].forEach(function (log) {
        assert.throws(() => abi.decodeLog(Object.assign({}, log, { topics: log.topics.slice(0, 2) })), /3 topics/);
        assert.throws(() => abi.decodeLog(Object.assign({}, log, { topics: log.topics.slice(0, 1) })), /3 topics/);
        assert.throws(() => abi.decodeLog(Object.assign({}, log, { topics: log.topics.concat([extra]) })), /3 topics/);
      });
      assert.throws(() => abi.decodeLog(Object.assign({}, paid, { topics: paid.topics.slice(0, 3) })), /4 topics/);
      assert.throws(() => abi.decodeLog(Object.assign({}, paid, { topics: paid.topics.slice(0, 1) })), /4 topics/);
      assert.throws(() => abi.decodeLog(Object.assign({}, paid, { topics: paid.topics.concat([extra]) })), /4 topics/);
      // an event whose indexed fields were not indexed looks like this: all values in data, only topic0
      assert.throws(() => abi.decodeLog({ topics: [FROZEN_TOPICS.InvoicePaid], data: '0x' + '00'.repeat(32 * 6) }), /4 topics/);
    });

    it('throws for a known event with short data', function () {
      const reg = rpcLog(IFACE, 'InvoiceRegistered', regArgs(randRegistered()));
      const paid = rpcLog(IFACE, 'InvoicePaid', paidArgs(randPaid()));
      const canc = rpcLog(IFACE, 'InvoiceCancelled', cancelArgs(randCancelled()));
      assert.equal(reg.data.length, 2 + 4 * 64);
      assert.equal(paid.data.length, 2 + 3 * 64);
      assert.equal(canc.data.length, 2 + 64);
      [reg, paid, canc].forEach(function (log) {
        assert.throws(() => abi.decodeLog(Object.assign({}, log, { data: log.data.slice(0, log.data.length - 2) })), /short/, 'one byte short');
        assert.throws(() => abi.decodeLog(Object.assign({}, log, { data: log.data.slice(0, log.data.length - 64) })), /short/, 'one word short');
        assert.throws(() => abi.decodeLog(Object.assign({}, log, { data: '0x' })), /short/, 'empty data');
        assert.throws(() => abi.decodeLog(Object.assign({}, log, { data: undefined })), /hex/, 'no data');
        assert.throws(() => abi.decodeLog(Object.assign({}, log, { data: 'zz' + log.data.slice(2) })), /hex/, 'not hex');
      });
    });

    it('throws for malformed topics: wrong length, not hex, dirty address bits, out of range data words', function () {
      const reg = rpcLog(IFACE, 'InvoiceRegistered', regArgs(randRegistered()));
      const paid = rpcLog(IFACE, 'InvoicePaid', paidArgs(randPaid()));
      const canc = rpcLog(IFACE, 'InvoiceCancelled', cancelArgs(randCancelled()));
      assert.throws(() => abi.decodeLog(Object.assign({}, reg, { topics: [reg.topics[0], '0x1234', reg.topics[2]] })), /topic 1/);
      assert.throws(() => abi.decodeLog(Object.assign({}, reg, { topics: [reg.topics[0], reg.topics[1], 'zz'.repeat(33)] })), /topic 2/);
      // dirty upper bytes of an indexed address
      assert.throws(() => abi.decodeLog(Object.assign({}, reg, { topics: [reg.topics[0], reg.topics[1], '0xff' + reg.topics[2].slice(4)] })), /merchant/);
      assert.throws(() => abi.decodeLog(Object.assign({}, canc, { topics: [canc.topics[0], canc.topics[1], '0x' + '00'.repeat(11) + '01' + canc.topics[2].slice(26)] })), /merchant/);
      assert.throws(() => abi.decodeLog(Object.assign({}, paid, { topics: paid.topics.slice(0, 3).concat(['0x01' + paid.topics[3].slice(4)]) })), /payer/);
      // data words that do not fit their type
      assert.throws(() => abi.decodeLog(Object.assign({}, reg, { data: setWord(reg.data, 1, 1n << 96n) })), /amount/);
      assert.throws(() => abi.decodeLog(Object.assign({}, reg, { data: setWord(reg.data, 2, 1n << 40n) })), /due/);
      assert.throws(() => abi.decodeLog(Object.assign({}, reg, { data: setWord(reg.data, 3, 1n << 40n) })), /createdAt/);
      assert.throws(() => abi.decodeLog(Object.assign({}, paid, { data: setWord(paid.data, 1, 1n << 96n) })), /amount/);
      assert.throws(() => abi.decodeLog(Object.assign({}, paid, { data: setWord(paid.data, 2, 1n << 40n) })), /paidAt/);
      assert.throws(() => abi.decodeLog(Object.assign({}, canc, { data: setWord(canc.data, 0, 1n << 40n) })), /cancelledAt/);
    });

    it('base fields: blockNumber 0x0 and logIndex 0x0 decode to the Number 0 (not null)', function () {
      const log = rpcLog(IFACE, 'InvoiceCancelled', cancelArgs(randCancelled()), { blockNumber: '0x0', logIndex: '0x0' });
      const got = abi.decodeLog(log);
      assert.equal(got.blockNumber, 0);
      assert.equal(got.logIndex, 0);
    });

    it('decodeLogs on ' + (3 * N) + ' shuffled random logs (' + N + ' unrelated) returns exactly the decodable ones, in order', function () {
      const logs = [];
      for (let i = 0; i < N; i++) {
        const a = randRegistered();
        const b = randPaid();
        const c = randCancelled();
        logs.push(rpcLog(IFACE, 'InvoiceRegistered', regArgs(a), randomBase()));
        logs.push(rpcLog(IFACE, 'InvoicePaid', paidArgs(b), randomBase()));
        logs.push(rpcLog(IFACE, 'InvoiceCancelled', cancelArgs(c), randomBase()));
        logs.push({ address: randAddr(), topics: [randHex(32), randHex(32)], data: randHex(randInt(100)), blockNumber: '0x1', logIndex: '0x0' });
      }
      for (let i = logs.length - 1; i > 0; i--) {
        const j = randInt(i + 1);
        const t = logs[i];
        logs[i] = logs[j];
        logs[j] = t;
      }
      const want = logs.filter((l) => [FROZEN_TOPICS.InvoiceRegistered, FROZEN_TOPICS.InvoicePaid, FROZEN_TOPICS.InvoiceCancelled].includes(l.topics[0])).map((l) => abi.decodeLog(l));
      const got = abi.decodeLogs(logs);
      assert.equal(got.length, 3 * N);
      assert.deepEqual(got, want);
      got.forEach((e) => assert.ok(['InvoiceRegistered', 'InvoicePaid', 'InvoiceCancelled'].includes(e.type)));
    });

    it('decodeLogs keeps our events in order and drops everything else', function () {
      const reg = rpcLog(IFACE, 'InvoiceRegistered', regArgs(randRegistered()));
      const paid = rpcLog(IFACE, 'InvoicePaid', paidArgs(randPaid()));
      const canc = rpcLog(IFACE, 'InvoiceCancelled', cancelArgs(randCancelled()));
      const transfer = { address: randAddr(), topics: [UNRELATED_TOPIC, randHex(32), randHex(32)], data: coder.encode(['uint256'], [1n]), blockNumber: '0x10', logIndex: '0x1' };
      const out = abi.decodeLogs([transfer, reg, null, { topics: [] }, paid, undefined, { topics: [randHex(32)], data: '0x' }, canc, {}]);
      assert.equal(out.length, 3);
      assert.deepEqual(out.map((e) => e.type), ['InvoiceRegistered', 'InvoicePaid', 'InvoiceCancelled']);
      assert.deepEqual(out[0], abi.decodeLog(reg));
      assert.deepEqual(out[1], abi.decodeLog(paid));
      assert.deepEqual(out[2], abi.decodeLog(canc));
      assert.deepEqual(abi.decodeLogs([]), []);
      assert.deepEqual(abi.decodeLogs([transfer, transfer]), []);
    });
  });

  describe('decodeError', function () {
    IFACES.forEach(function (entry) {
      const iface = entry.iface;
      const tag = ' (' + entry.name + ')';

      it('every custom error without arguments decodes to name, signature, selector and empty args' + tag, function () {
        NO_ARG_ERRORS.forEach(function (name) {
          const data = iface.encodeErrorResult(name);
          assert.deepEqual(abi.decodeError(data), { name: name, signature: name + '()', selector: FROZEN_ERRORS[name], args: {} }, name);
          assert.equal(data, FROZEN_ERRORS[name]);
          assert.equal(abi.decodeError(data.toUpperCase().replace('0X', '0x')).name, name, 'upper case ' + name);
        });
      });

      it('InvoiceExpired: ' + N + ' random due values, args.due is a Number' + tag, function () {
        let cases = 0;
        for (let i = 0; i < N; i++) {
          const due = randBigVar(40);
          const got = abi.decodeError(iface.encodeErrorResult('InvoiceExpired', [due]));
          assert.deepEqual(got, { name: 'InvoiceExpired', signature: 'InvoiceExpired(uint40)', selector: '0xc574c544', args: { due: Number(due) } });
          assert.equal(typeof got.args.due, 'number');
          cases++;
        }
        assert.equal(cases, N);
        assert.equal(abi.decodeError(iface.encodeErrorResult('InvoiceExpired', [MAX40])).args.due, 1099511627775);
        assert.equal(abi.decodeError(iface.encodeErrorResult('InvoiceExpired', [0n])).args.due, 0);
      });

      it('WrongAmount: ' + N + ' random uint256 pairs, args.expected / args.sent are BigInt' + tag, function () {
        let cases = 0;
        for (let i = 0; i < N; i++) {
          const expected = randBigVar(256);
          const sent = randBigVar(256);
          const got = abi.decodeError(iface.encodeErrorResult('WrongAmount', [expected, sent]));
          assert.deepEqual(got, { name: 'WrongAmount', signature: 'WrongAmount(uint256,uint256)', selector: '0x312b0033', args: { expected: expected, sent: sent } });
          assert.equal(typeof got.args.expected, 'bigint');
          assert.equal(typeof got.args.sent, 'bigint');
          cases++;
        }
        assert.equal(cases, N);
        const edge = abi.decodeError(iface.encodeErrorResult('WrongAmount', [MAX256, 0n]));
        assert.equal(edge.args.expected, MAX256);
        assert.equal(edge.args.sent, 0n);
        const real = abi.decodeError(iface.encodeErrorResult('WrongAmount', [1250000n * 10n ** 12n, 1250000n]));
        assert.equal(real.args.expected, 1250000000000000000n);
      });
    });

    it('Error(string): ascii, empty, multi-word and unicode messages', function () {
      const messages = [
        'insufficient funds',
        '',
        'x',
        'a'.repeat(31),
        'a'.repeat(32),
        'a'.repeat(33),
        'b'.repeat(64),
        'c'.repeat(65),
        'ERC20: transfer amount exceeds balance, and a much longer text that spans several 32 byte words of ABI data',
        'Überweisung fehlgeschlagen — 支付失败 💸 ✓ naïve café',
        'é',
        '😀'.repeat(20)
      ];
      messages.forEach(function (message) {
        const got = abi.decodeError(errorStringData(message));
        assert.deepEqual(got, { name: 'Error', signature: 'Error(string)', selector: '0x08c379a0', args: { message: message } }, message);
      });
      for (let i = 0; i < 40; i++) {
        let message = '';
        for (let j = randInt(80); j > 0; j--) message += String.fromCodePoint(32 + randInt(0x2f00));
        assert.equal(abi.decodeError(errorStringData(message)).args.message, message, 'random message ' + i);
      }
      assert.equal(ethers.id('Error(string)').slice(0, 10), '0x08c379a0');
    });

    it('Panic(uint256): known codes and random uint256 codes', function () {
      assert.equal(ethers.id('Panic(uint256)').slice(0, 10), '0x4e487b71');
      [0n, 1n, 0x11n, 0x12n, 0x21n, 0x22n, 0x31n, 0x32n, 0x41n, 0x51n, MAX256].forEach(function (code) {
        assert.deepEqual(abi.decodeError(panicData(code)), { name: 'Panic', signature: 'Panic(uint256)', selector: '0x4e487b71', args: { code: code } });
      });
      for (let i = 0; i < N; i++) {
        const code = randBigVar(256);
        assert.equal(abi.decodeError(panicData(code)).args.code, code);
      }
    });

    it('returns null for "0x", undefined, null, non-strings, non-hex and odd length input', function () {
      [
        '0x', '', 'abc', '0xzz', undefined, null, 5, 5n, {}, [], true, new Uint8Array([1, 2, 3, 4]), '0x1234', '0x12345678 ', ' 0x12345678',
        FROZEN_ERRORS.AlreadyPaid.slice(0, -1), FROZEN_ERRORS.AlreadyPaid.slice(2), '0X' + FROZEN_ERRORS.AlreadyPaid.slice(2)
      ].forEach((v) => assert.equal(abi.decodeError(v), null, String(v)));
    });

    it('returns null for an unknown selector (with and without argument data)', function () {
      ['0xdeadbeef', '0xdeadbeef' + '00'.repeat(32), '0x00000000', '0xffffffff' + 'ff'.repeat(64), ethers.id('Unknown()').slice(0, 10)].forEach(function (d) {
        assert.equal(abi.decodeError(d), null, d);
      });
      for (let i = 0; i < 40; i++) {
        const sel = randHex(4);
        if (Object.values(FROZEN_ERRORS).includes(sel) || sel === '0x08c379a0' || sel === '0x4e487b71') continue;
        assert.equal(abi.decodeError(sel + randHex(64).slice(2)), null, sel);
      }
    });

    it('returns null for truncated arguments', function () {
      const expired = IFACE.encodeErrorResult('InvoiceExpired', [123456n]);
      const wrong = IFACE.encodeErrorResult('WrongAmount', [5n, 6n]);
      assert.equal(abi.decodeError(FROZEN_ERRORS.InvoiceExpired), null, 'InvoiceExpired without args');
      assert.equal(abi.decodeError(expired.slice(0, expired.length - 2)), null, 'InvoiceExpired one byte short');
      assert.equal(abi.decodeError(FROZEN_ERRORS.WrongAmount), null, 'WrongAmount without args');
      assert.equal(abi.decodeError(wrong.slice(0, 10 + 64)), null, 'WrongAmount with one word');
      assert.equal(abi.decodeError(wrong.slice(0, wrong.length - 2)), null, 'WrongAmount one byte short');
      const panic = panicData(0x11n);
      assert.equal(abi.decodeError('0x4e487b71'), null, 'Panic without args');
      assert.equal(abi.decodeError(panic.slice(0, panic.length - 2)), null, 'Panic one byte short');
      const err = errorStringData('hello world');
      assert.equal(abi.decodeError('0x08c379a0'), null, 'Error(string) without args');
      assert.equal(abi.decodeError(err.slice(0, 10 + 64)), null, 'Error(string) with the offset word only');
      const farOffset = ethers.concat(['0x08c379a0', coder.encode(['uint256'], [1n << 200n]), coder.encode(['uint256'], [5n]), ethers.toUtf8Bytes('hello')]);
      assert.equal(abi.decodeError(farOffset), null, 'Error(string) offset far beyond the data');
    });

    it('returns null when InvoiceExpired carries a value that does not fit uint40', function () {
      assert.equal(abi.decodeError(FROZEN_ERRORS.InvoiceExpired + (1n << 40n).toString(16).padStart(64, '0')), null);
      assert.notEqual(abi.decodeError(FROZEN_ERRORS.InvoiceExpired + MAX40.toString(16).padStart(64, '0')), null);
    });

    // BUG (reported, lenient decoder): an Error(string) whose declared length is larger than the bytes that are
    // actually present is decoded to a shortened message instead of being rejected like every other truncated
    // payload (InvoiceExpired, WrongAmount, Panic all return null when their data is cut off).
    it('returns null when the Error(string) payload is cut off (declared length > available bytes)', function () {
      const full = errorStringData('this revert reason will be cut in the middle of the string');
      const cut = full.slice(0, full.length - 40); // drop 20 bytes of the string body
      assert.equal(abi.decodeError(cut), null);
      // declared length 1000 but only 5 bytes present
      const lying = ethers.concat(['0x08c379a0', coder.encode(['uint256'], [32n]), coder.encode(['uint256'], [1000n]), ethers.toUtf8Bytes('hello')]);
      assert.equal(abi.decodeError(lying), null);
    });
  });

  describe('findRevertData', function () {
    const DATA = {
      InvoiceExpired: IFACE.encodeErrorResult('InvoiceExpired', [1893456000n]),
      WrongAmount: IFACE.encodeErrorResult('WrongAmount', [1250000n * 10n ** 12n, 5n]),
      AlreadyPaid: IFACE.encodeErrorResult('AlreadyPaid'),
      'Error(string)': errorStringData('insufficient funds for transfer'),
      'Panic(uint256)': panicData(0x11n)
    };
    const UNKNOWN = '0xdeadbeef' + '00'.repeat(32);
    const TX_HASH = '0x' + 'ab'.repeat(32);

    const SHAPES = {
      'hex string directly': (d) => d,
      '{data: "0x..."}': (d) => ({ data: d }),
      'hardhat: {code, message, data: {message, data}}': (d) => ({
        code: -32603,
        message: 'Error: VM Exception while processing transaction: reverted with an unrecognized custom error',
        data: { message: 'Error: VM Exception while processing transaction: reverted with an unrecognized custom error', data: d }
      }),
      'geth / reth: {code: 3, message: "execution reverted", data}': (d) => ({ code: 3, message: 'execution reverted', data: d }),
      'ethers v6: {info: {error: {data}}}': (d) => ({
        code: 'CALL_EXCEPTION',
        shortMessage: 'execution reverted (unknown custom error)',
        info: { error: { code: 3, message: 'execution reverted', data: d } }
      }),
      'wallet: {data: {originalError: {data}}}': (d) => ({ code: -32603, message: 'Internal JSON-RPC error.', data: { originalError: { code: 3, data: d } } }),
      '{error: {data}}': (d) => ({ error: { code: 3, message: 'execution reverted', data: d } }),
      'Error with a cause chain': (d) => Object.assign(new Error('outer failure'), { cause: Object.assign(new Error('inner failure'), { data: d }) }),
      'message text with the blob': (d) => ({ message: 'execution reverted (unknown custom error) (action="estimateGas", data="' + d + '", reason=null, code=CALL_EXCEPTION)' }),
      'Error whose message has the blob after a tx hash': (d) => new Error('transaction ' + TX_HASH + ' reverted with data ' + d + ' (see explorer)'),
      'a bare string with the blob inside': (d) => 'revert: ' + d + '.'
    };

    Object.keys(DATA).forEach(function (dataName) {
      Object.keys(SHAPES).forEach(function (shapeName) {
        it(dataName + ' found in: ' + shapeName, function () {
          const d = DATA[dataName];
          assert.equal(abi.findRevertData(SHAPES[shapeName](d)), d.toLowerCase());
        });
      });
    });

    it('returns the data lower-cased, whatever the case of the input', function () {
      const d = DATA.WrongAmount;
      const upper = '0x' + d.slice(2).toUpperCase();
      assert.equal(abi.findRevertData(upper), d);
      assert.equal(abi.findRevertData({ data: upper }), d);
      assert.equal(abi.findRevertData({ message: 'reverted ' + upper }), d);
    });

    it('result is decodable by decodeError (round trip through a wallet shape)', function () {
      const d = IFACE.encodeErrorResult('InvoiceExpired', [1700000000n]);
      const found = abi.findRevertData(SHAPES['wallet: {data: {originalError: {data}}}'](d));
      assert.deepEqual(abi.decodeError(found).args, { due: 1700000000 });
    });

    it('finds the data inside a raw JSON-RPC response body kept as a string', function () {
      const d = DATA.WrongAmount;
      const body = JSON.stringify({ jsonrpc: '2.0', id: 7, error: { code: 3, message: 'execution reverted', data: d } });
      assert.equal(abi.findRevertData({ body: body }), d);
      assert.equal(abi.findRevertData({ code: 'SERVER_ERROR', body: body, info: { requestUrl: 'https://rpc.example' } }), d);
    });

    it('returns null when there is no revert data', function () {
      [
        {}, null, undefined, '', 'execution reverted', 42, 7n, true, [], {}, { data: '0x' }, { data: null }, { message: 'insufficient funds for gas * price + value' },
        new Error('network error'), { error: { message: 'nonce too low' } }, { data: { data: '0x', message: 'x' } }, { message: 'short blob 0x1234' }
      ].forEach((v, i) => assert.equal(abi.findRevertData(v), null, 'case ' + i));
    });

    it('returns null when the hex has an unknown selector', function () {
      Object.keys(SHAPES).forEach(function (shapeName) {
        assert.equal(abi.findRevertData(SHAPES[shapeName](UNKNOWN)), null, shapeName);
      });
      assert.equal(abi.findRevertData({ message: 'long blob 0x' + 'ab'.repeat(40) }), null);
    });

    it('skips an unknown blob and still finds a known one elsewhere in the same error', function () {
      const d = DATA.AlreadyPaid;
      assert.equal(abi.findRevertData({ data: UNKNOWN, error: { data: d } }), d);
      assert.equal(abi.findRevertData({ message: 'tx ' + TX_HASH + ' and ' + UNKNOWN + ' then ' + d }), d);
    });

    it('does not hang on circular references and still finds data reachable around the cycle', function () {
      const a = { message: 'boom' };
      a.self = a;
      a.data = a;
      a.error = a;
      a.cause = { cause: a, info: a, error: { error: a } };
      assert.equal(abi.findRevertData(a), null);

      const b = {};
      b.error = b;
      b.cause = { data: DATA.AlreadyPaid, cause: b };
      assert.equal(abi.findRevertData(b), DATA.AlreadyPaid);

      const x = { data: UNKNOWN };
      const y = { cause: x };
      x.error = y;
      assert.equal(abi.findRevertData(x), null);
      y.info = { data: DATA.WrongAmount };
      assert.equal(abi.findRevertData(x), DATA.WrongAmount);
    });

    it('terminates on a very deep chain', function () {
      let deep = { data: DATA.AlreadyPaid };
      for (let i = 0; i < 10000; i++) deep = { cause: deep };
      const out = abi.findRevertData(deep);
      assert.ok(out === null || out === DATA.AlreadyPaid);
    });

    it('ignores getters that throw', function () {
      const o = { error: { data: DATA.AlreadyPaid } };
      Object.defineProperty(o, 'data', {
        enumerable: true,
        get() {
          throw new Error('boom');
        }
      });
      assert.equal(abi.findRevertData(o), DATA.AlreadyPaid);
      const trap = new Proxy({}, { get() { throw new Error('trap'); } });
      assert.equal(abi.findRevertData(trap), null);
      assert.equal(abi.findRevertData({ error: trap, data: DATA.AlreadyPaid }), DATA.AlreadyPaid);
    });
  });

  describe('EIP-55 checksum addresses', function () {
    const NORMAL = [
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
      '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
      '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
      '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb'
    ];
    const ALL_CAPS = ['0x52908400098527886E0F7030069857D2E4169EE7', '0x8617E340B3D01FA5F11F306F4090FD50E238070D'];
    const ALL_LOWER = ['0xde709f2102306220921060314715629080e2fb77', '0x27b1fdb04752bbc536007a920d24acb045561c26'];
    function randMixed() {
      for (;;) {
        const a = randAddr();
        const body = a.slice(2);
        if ((body.match(/[A-F]/g) || []).length >= 2 && (body.match(/[a-f]/g) || []).length >= 2) return a;
      }
    }
    function flipLetter(addr, which) {
      const body = addr.slice(2).split('');
      const letters = [];
      body.forEach((c, i) => {
        if (/[a-fA-F]/.test(c)) letters.push(i);
      });
      const i = letters[which % letters.length];
      body[i] = body[i] === body[i].toLowerCase() ? body[i].toUpperCase() : body[i].toLowerCase();
      return '0x' + body.join('');
    }

    it('the official EIP-55 test vectors (normal): from lower case, upper case body and unchanged', function () {
      NORMAL.forEach(function (v) {
        assert.equal(abi.toChecksumAddress(v.toLowerCase()), v);
        assert.equal(abi.toChecksumAddress(upperBody(v)), v);
        assert.equal(abi.toChecksumAddress(v), v);
        assert.equal(abi.toChecksumAddress(v), ethers.getAddress(v));
        assert.equal(abi.hasValidChecksum(v), true);
      });
    });

    it('the official EIP-55 all-caps vectors', function () {
      ALL_CAPS.forEach(function (v) {
        assert.equal(abi.toChecksumAddress(v), v);
        assert.equal(abi.toChecksumAddress(v.toLowerCase()), v);
        assert.equal(abi.toChecksumAddress(v), ethers.getAddress(v.toLowerCase()));
        assert.equal(abi.hasValidChecksum(v), true);
        assert.equal(abi.hasValidChecksum(v.toLowerCase()), true);
      });
    });

    it('the official EIP-55 all-lowercase vectors', function () {
      ALL_LOWER.forEach(function (v) {
        assert.equal(abi.toChecksumAddress(v), v);
        assert.equal(abi.toChecksumAddress(upperBody(v)), v);
        assert.equal(abi.toChecksumAddress(v), ethers.getAddress(v));
        assert.equal(abi.hasValidChecksum(v), true);
        assert.equal(abi.hasValidChecksum(upperBody(v)), true);
      });
    });

    it('200 random addresses equal ethers.getAddress (from lower case, upper case body, and idempotent)', function () {
      let cases = 0;
      for (let i = 0; i < 200; i++) {
        const lower = randHex(20);
        const want = ethers.getAddress(lower);
        assert.equal(abi.toChecksumAddress(lower), want, lower);
        assert.equal(abi.toChecksumAddress(upperBody(lower)), want, 'upper ' + lower);
        assert.equal(abi.toChecksumAddress(want), want, 'idempotent ' + lower);
        assert.match(abi.toChecksumAddress(lower), /^0x[0-9a-fA-F]{40}$/);
        cases++;
      }
      assert.equal(cases, 200);
    });

    it('special addresses: zero, all ff, only digits', function () {
      [ethers.ZeroAddress, '0x' + 'ff'.repeat(20), '0x' + '1'.repeat(40), '0x' + '0123456789'.repeat(4), '0x' + 'ab'.repeat(20)].forEach(function (a) {
        assert.equal(abi.toChecksumAddress(a), ethers.getAddress(a), a);
        assert.equal(abi.hasValidChecksum(a), true);
      });
      assert.equal(abi.toChecksumAddress(ethers.ZeroAddress), '0x0000000000000000000000000000000000000000');
    });

    it('toChecksumAddress throws for invalid input (short, long, no 0x, 0X, non-hex, non-string)', function () {
      [
        '', '0x', '0x12', '0x' + 'ab'.repeat(19), '0x' + 'ab'.repeat(20) + 'a', 'ab'.repeat(20), '0X' + 'ab'.repeat(20), '0x' + 'zz'.repeat(20),
        ' 0x' + 'ab'.repeat(20), '0x' + 'ab'.repeat(20) + '\n', '0x' + 'ab'.repeat(32), 123, null, undefined, {}, [], true, 5n, new Uint8Array(20)
      ].forEach(function (v, i) {
        assert.throws(() => abi.toChecksumAddress(v), /invalid address/, 'case ' + i);
      });
    });

    it('hasValidChecksum: lower case true, upper case body true, correct mixed case true (100 random)', function () {
      for (let i = 0; i < 100; i++) {
        const a = randMixed();
        assert.equal(abi.hasValidChecksum(a), true, a);
        assert.equal(abi.hasValidChecksum(a.toLowerCase()), true, 'lower ' + a);
        assert.equal(abi.hasValidChecksum(upperBody(a)), true, 'upper ' + a);
      }
    });

    it('hasValidChecksum: one flipped letter in a mixed-case address is false, and ethers agrees (100 random)', function () {
      let cases = 0;
      for (let i = 0; i < 100; i++) {
        const a = randMixed();
        const bad = flipLetter(a, randInt(1000));
        assert.notEqual(bad, a);
        assert.equal(abi.hasValidChecksum(bad), false, bad);
        assert.throws(() => ethers.getAddress(bad), /checksum/, 'ethers must reject ' + bad);
        cases++;
      }
      assert.equal(cases, 100);
    });

    it('hasValidChecksum: wrong checksum on the official vectors', function () {
      NORMAL.forEach(function (v) {
        for (let k = 0; k < 4; k++) assert.equal(abi.hasValidChecksum(flipLetter(v, k)), false, flipLetter(v, k));
      });
    });

    it('hasValidChecksum: invalid addresses are false', function () {
      ['', '0x', '0x12', '0x' + 'ab'.repeat(19), '0x' + 'ab'.repeat(21), 'ab'.repeat(20), '0X' + 'ab'.repeat(20), '0x' + 'zz'.repeat(20), 123, null, undefined, {}, '0x' + 'ab'.repeat(32)].forEach(function (v, i) {
        assert.equal(abi.hasValidChecksum(v), false, 'case ' + i);
      });
    });
  });

  describe('isAddress and isHash32', function () {
    const ADDR = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

    it('isAddress: true for lower case, checksummed, upper case body, wrong-checksum mixed case, zero and all-digit addresses', function () {
      [ADDR, ADDR.toLowerCase(), upperBody(ADDR), ADDR.replace('Aed', 'aEd'), ethers.ZeroAddress, '0x' + '1'.repeat(40), '0x' + 'f'.repeat(40), '0x' + 'F'.repeat(40)].forEach(function (a) {
        assert.equal(abi.isAddress(a), true, a);
      });
      for (let i = 0; i < N; i++) {
        const a = randAddr();
        assert.equal(abi.isAddress(a), true);
        assert.equal(abi.isAddress(a.toLowerCase()), true);
        assert.equal(abi.isAddress(upperBody(a)), true);
        assert.equal(ethers.isAddress(a), true);
      }
    });

    it('isAddress: false for wrong length, bad characters, missing prefix, the upper case 0X prefix (not accepted), whitespace and non-strings', function () {
      [
        '', '0x', '0x1', '0x' + 'ab'.repeat(19) + 'a', '0x' + 'ab'.repeat(20) + 'a', '0x' + 'ab'.repeat(21), '0x' + 'ab'.repeat(32), 'ab'.repeat(20),
        '0X' + 'ab'.repeat(20), '0X' + 'AB'.repeat(20), '0x' + 'ab'.repeat(19) + 'zz', '0x' + 'ab'.repeat(19) + 'a ', ' 0x' + 'ab'.repeat(20), '0x' + 'ab'.repeat(20) + '\n',
        '0x 1234567890123456789012345678901234567890', 123, 5n, null, undefined, true, {}, [], new Uint8Array(20), new String(ADDR)
      ].forEach(function (v, i) {
        assert.equal(abi.isAddress(v), false, 'case ' + i);
      });
    });

    it('isHash32: true for 0x + 64 hex digits in any case (including the zero hash)', function () {
      const h = randHex(32);
      [h, upperBody(h), '0x' + '00'.repeat(32), '0x' + 'ff'.repeat(32), '0x' + 'aB'.repeat(32)].forEach((v) => assert.equal(abi.isHash32(v), true, v));
      for (let i = 0; i < N; i++) {
        const v = randHex(32);
        assert.equal(abi.isHash32(v), true);
        assert.equal(abi.isHash32(upperBody(v)), true);
        assert.equal(ethers.isHexString(v, 32), true);
      }
    });

    it('isHash32: false for wrong length, bad characters, missing prefix, the upper case 0X prefix and non-strings', function () {
      [
        '', '0x', '0x12', '0x' + 'ab'.repeat(31), '0x' + 'ab'.repeat(33), '0x' + 'ab'.repeat(31) + 'a', 'ab'.repeat(32), '0X' + 'ab'.repeat(32),
        '0x' + 'zz'.repeat(32), '0x' + 'ab'.repeat(32) + '\n', ' 0x' + 'ab'.repeat(32), ADDR, 123, 5n, null, undefined, true, {}, [], new Uint8Array(32)
      ].forEach(function (v, i) {
        assert.equal(abi.isHash32(v), false, 'case ' + i);
      });
    });

    it('an address is not a hash and a hash is not an address', function () {
      const a = randAddr();
      const h = randHex(32);
      assert.equal(abi.isHash32(a), false);
      assert.equal(abi.isAddress(h), false);
    });
  });

  describe('addressTopic', function () {
    it('is the 66 character lower case left padded topic and equals ethers.zeroPadValue (' + N + ' random)', function () {
      let cases = 0;
      for (let i = 0; i < N; i++) {
        const a = randAddr();
        const want = ethers.zeroPadValue(a, 32).toLowerCase();
        [a, a.toLowerCase(), upperBody(a)].forEach(function (form) {
          const got = abi.addressTopic(form);
          assert.equal(got, want, form);
          assert.equal(got.length, 66);
          assert.match(got, /^0x0{24}[0-9a-f]{40}$/);
        });
        assert.equal(abi.addressTopic(a), IFACE.encodeEventLog('InvoiceCancelled', [randHex(32), a, 1n]).topics[2]);
        cases++;
      }
      assert.equal(cases, N);
    });

    it('edge addresses: zero and all ff', function () {
      assert.equal(abi.addressTopic(ethers.ZeroAddress), '0x' + '00'.repeat(32));
      assert.equal(abi.addressTopic('0x' + 'ff'.repeat(20)), '0x' + '00'.repeat(12) + 'ff'.repeat(20));
    });

    it('can be used as a topic filter for the indexed merchant of InvoiceRegistered logs', function () {
      const merchant = randAddr();
      const log = IFACE.encodeEventLog('InvoiceRegistered', [randHex(32), merchant, randHex(32), 1n, 2n, 3n]);
      assert.equal(log.topics[2], abi.addressTopic(merchant));
    });
  });

  describe('classic <script> loading (no CommonJS)', function () {
    const read = (name) => fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'js', name), 'utf8');

    it('abi.js attaches ArcInvoice.abi when keccak.js was loaded first', function () {
      const ctx = vm.createContext({});
      vm.runInContext(read('keccak.js'), ctx, { filename: 'keccak.js' });
      vm.runInContext(read('abi.js'), ctx, { filename: 'abi.js' });
      const A = ctx.ArcInvoice.abi;
      assert.equal(typeof ctx.ArcInvoice.keccak.keccak256, 'function');
      assert.equal(A.SELECTORS.register, FROZEN_SELECTORS.register);
      assert.equal(A.TOPICS.InvoicePaid, FROZEN_TOPICS.InvoicePaid);
      assert.equal(A.ERROR_SELECTORS.WrongAmount, FROZEN_ERRORS.WrongAmount);
      assert.equal(A.encodePay('0x' + 'ab'.repeat(32)), abi.encodePay('0x' + 'ab'.repeat(32)));
      assert.equal(A.toChecksumAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'), '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
      // no TextDecoder in this context: decodeError uses the fallback decoder and still reads a plain reason
      const err = A.decodeError(errorStringData('boom'));
      assert.equal(err.name, 'Error');
      assert.equal(err.args.message, 'boom');
    });

    it('abi.js throws a helpful error when keccak.js was not loaded first', function () {
      const ctx = vm.createContext({});
      assert.throws(() => vm.runInContext(read('abi.js'), ctx, { filename: 'abi.js' }), /ArcInvoice\.keccak is missing/);
    });
  });
});
