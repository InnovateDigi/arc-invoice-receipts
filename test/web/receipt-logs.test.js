'use strict';
// Receipt handling: which logs of a transaction receipt may be trusted, and what to tell the user when a
// transaction is mined but failed (Arc mines failing transactions with status 0x0 and no revert data).
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const abi = require('../../web/js/abi.js');
const util = require('../../web/js/util.js');

const iface = new ethers.Interface([
  'event InvoiceRegistered(bytes32 indexed id, address indexed merchant, bytes32 referenceHash, uint96 amount, uint40 due, uint40 createdAt)',
  'event InvoicePaid(bytes32 indexed id, address indexed merchant, address indexed payer, bytes32 referenceHash, uint96 amount, uint40 paidAt)',
  'event InvoiceCancelled(bytes32 indexed id, address indexed merchant, uint40 cancelledAt)'
]);

const CONTRACT = ethers.getAddress('0x5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c');
const OTHER = ethers.getAddress('0x0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d');
const SYSTEM = '0xfffffffffffffffffffffffffffffffffffffffe'; // EIP-7708 system address that emits native Transfer logs
const TRANSFER = ethers.id('Transfer(address,address,uint256)');
const MERCHANT = ethers.getAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
const PAYER = ethers.getAddress('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');
const REFERENCE = ethers.id('memo');
const ID = abi.invoiceId(MERCHANT, REFERENCE);
const TX = '0x' + 'ab'.repeat(32);

function rpcLog(address, topics, data, logIndex) {
  return { address: address.toLowerCase(), topics, data, blockNumber: '0x10', logIndex: '0x' + logIndex.toString(16), transactionHash: TX, blockHash: '0x' + 'cd'.repeat(32), removed: false };
}

function eventLog(name, args, address, logIndex) {
  const { topics, data } = iface.encodeEventLog(iface.getEvent(name), args);
  return rpcLog(address, topics, data, logIndex);
}

function transferLog(from, to, units, logIndex) {
  return rpcLog(SYSTEM, [TRANSFER, ethers.zeroPadValue(from, 32), ethers.zeroPadValue(to, 32)], ethers.zeroPadValue(ethers.toBeHex(units), 32), logIndex);
}

const AMOUNT = 1250000n;
const paid = (address, logIndex, payer = PAYER, amount = AMOUNT) => eventLog('InvoicePaid', [ID, MERCHANT, payer, REFERENCE, amount, 1790000000], address, logIndex);

describe('eventsFromReceipt: Arc payment receipts carry system Transfer logs around InvoicePaid', () => {
  const receipt = (logs) => ({ status: '0x1', blockNumber: '0x10', transactionHash: TX, logs });
  const native = AMOUNT * 10n ** 12n;

  it('InvoicePaid is logs[1] between the two system Transfer logs and is found exactly once', () => {
    const r = receipt([transferLog(PAYER, CONTRACT, native, 0), paid(CONTRACT, 1), transferLog(CONTRACT, MERCHANT, native, 2)]);
    const events = abi.eventsFromReceipt(r, CONTRACT);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'InvoicePaid');
    assert.equal(events[0].logIndex, 1);
    assert.equal(events[0].id, ID);
    assert.equal(events[0].payer, PAYER);
    assert.equal(events[0].merchant, MERCHANT);
    assert.equal(events[0].amount, AMOUNT);
    assert.equal(events[0].txHash, TX);
  });

  it('works when merchant == payer (both system Transfers name the same account)', () => {
    const r = receipt([transferLog(MERCHANT, CONTRACT, native, 0), paid(CONTRACT, 1, MERCHANT), transferLog(CONTRACT, MERCHANT, native, 2)]);
    const events = abi.eventsFromReceipt(r, CONTRACT, { type: 'InvoicePaid', id: ID });
    assert.equal(events.length, 1);
    assert.equal(events[0].payer, MERCHANT);
    assert.equal(events[0].merchant, MERCHANT);
  });

  it('a forged InvoicePaid emitted by another address is ignored', () => {
    const forged = paid(OTHER, 0, ethers.getAddress('0x1111111111111111111111111111111111111111'), 999999999n);
    assert.deepEqual(abi.eventsFromReceipt(receipt([forged]), CONTRACT), []);
    // forged first, real second: only the real one comes back
    const r = receipt([forged, transferLog(PAYER, CONTRACT, native, 1), paid(CONTRACT, 2), transferLog(CONTRACT, MERCHANT, native, 3)]);
    const events = abi.eventsFromReceipt(r, CONTRACT, { type: 'InvoicePaid', id: ID });
    assert.equal(events.length, 1);
    assert.equal(events[0].logIndex, 2);
    assert.equal(events[0].amount, AMOUNT);
    assert.equal(events[0].payer, PAYER);
  });

  it('a forged InvoiceRegistered or InvoiceCancelled from another address is ignored too', () => {
    const forgedReg = eventLog('InvoiceRegistered', [ID, MERCHANT, REFERENCE, 1n, 2000000000, 1790000000], OTHER, 0);
    const forgedCancel = eventLog('InvoiceCancelled', [ID, MERCHANT, 1790000000], OTHER, 1);
    assert.deepEqual(abi.eventsFromReceipt(receipt([forgedReg, forgedCancel]), CONTRACT), []);
  });

  it('the system Transfer logs are never returned as contract events', () => {
    const r = receipt([transferLog(PAYER, CONTRACT, native, 0), transferLog(CONTRACT, MERCHANT, native, 1)]);
    assert.deepEqual(abi.eventsFromReceipt(r, CONTRACT), []);
    assert.deepEqual(abi.eventsFromReceipt(r, SYSTEM), [], 'even asking for the system address finds no invoice events');
  });

  it('narrowing by type and by invoice id', () => {
    const otherId = abi.invoiceId(MERCHANT, ethers.id('another memo'));
    const r = receipt([paid(CONTRACT, 0), eventLog('InvoiceCancelled', [otherId, MERCHANT, 1790000001], CONTRACT, 1)]);
    assert.equal(abi.eventsFromReceipt(r, CONTRACT).length, 2);
    assert.equal(abi.eventsFromReceipt(r, CONTRACT, { type: 'InvoiceCancelled' }).length, 1);
    assert.equal(abi.eventsFromReceipt(r, CONTRACT, { type: 'InvoicePaid', id: otherId }).length, 0, 'right type, wrong invoice id');
    assert.equal(abi.eventsFromReceipt(r, CONTRACT, { id: ID.toUpperCase().replace('0X', '0x') }).length, 1, 'id compare ignores case');
    assert.equal(abi.eventsFromReceipt(r, CONTRACT, { type: 'InvoiceRegistered' }).length, 0);
  });

  it('contract address compare ignores case; missing or odd receipts give an empty list', () => {
    const r = receipt([paid(CONTRACT, 1)]);
    assert.equal(abi.eventsFromReceipt(r, CONTRACT.toLowerCase()).length, 1);
    assert.equal(abi.eventsFromReceipt(r, CONTRACT.toUpperCase().replace('0X', '0x')).length, 1);
    assert.deepEqual(abi.eventsFromReceipt(null, CONTRACT), []);
    assert.deepEqual(abi.eventsFromReceipt({}, CONTRACT), []);
    assert.deepEqual(abi.eventsFromReceipt({ logs: null }, CONTRACT), []);
    assert.deepEqual(abi.eventsFromReceipt({ logs: [null, undefined, {}] }, CONTRACT), []);
  });

  it('a malformed log of the contract is skipped instead of throwing', () => {
    const bad = paid(CONTRACT, 0);
    bad.topics = bad.topics.slice(0, 3); // InvoicePaid needs 4 topics
    const r = receipt([bad, paid(CONTRACT, 1)]);
    const events = abi.eventsFromReceipt(r, CONTRACT);
    assert.equal(events.length, 1);
    assert.equal(events[0].logIndex, 1);
  });

  it('decodeLogs with a contract address only keeps that contract; without one it keeps every Invoice* event', () => {
    const logs = [paid(OTHER, 0), paid(CONTRACT, 1), transferLog(PAYER, CONTRACT, native, 2)];
    assert.equal(abi.decodeLogs(logs).length, 2);
    const only = abi.decodeLogs(logs, CONTRACT);
    assert.equal(only.length, 1);
    assert.equal(only[0].logIndex, 1);
    assert.equal(abi.decodeLogs(logs, OTHER.toLowerCase()).length, 1);
  });
});

describe('replayFailedTx: reason for a mined transaction with status 0x0', () => {
  const tx = { from: PAYER, to: CONTRACT, data: abi.encodePay(ID), value: 1250000n * 10n ** 12n };
  const failing = (data) => Object.assign(new Error('execution reverted'), { code: 3, data });

  it('replays at the receipt block and decodes the custom error', async () => {
    const calls = [];
    const client = { call: async (t, tag) => { calls.push([t, tag]); throw failing(abi.SELECTORS && '0xd70a0e30'); } };
    const r = await util.replayFailedTx(client, tx, { blockNumber: '0x2a' });
    assert.equal(r.decoded.name, 'AlreadyPaid');
    assert.match(r.sentence, /already been paid/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], '0x2a');
    assert.deepEqual(calls[0][0], { from: PAYER, to: CONTRACT, data: tx.data, value: '0x' + tx.value.toString(16) });
  });

  it('falls back to the block before when the receipt block gives nothing', async () => {
    const tags = [];
    const client = {
      call: async (t, tag) => {
        tags.push(tag);
        if (tag === '0x2a') return '0x'; // ran fine on the post-state of that block
        throw failing('0x1f2a2005');
      }
    };
    const r = await util.replayFailedTx(client, tx, { blockNumber: '0x2a' });
    assert.deepEqual(tags, ['0x2a', '0x29']);
    assert.equal(r.decoded.name, 'ZeroAmount');
  });

  it('decodes WrongAmount and InvoiceExpired arguments into the sentence', async () => {
    const wrong = '0x312b0033' + ethers.zeroPadValue(ethers.toBeHex(1250000n * 10n ** 12n), 32).slice(2) + ethers.zeroPadValue(ethers.toBeHex(1n), 32).slice(2);
    let r = await util.replayFailedTx({ call: async () => { throw failing(wrong); } }, tx, { blockNumber: '0x5' });
    assert.match(r.sentence, /1\.25 USDC/);
    const expired = '0xc574c544' + ethers.zeroPadValue(ethers.toBeHex(1790000000), 32).slice(2);
    r = await util.replayFailedTx({ call: async () => { throw failing(expired); } }, tx, { blockNumber: '0x5' });
    assert.match(r.sentence, /expired on 2026-/);
  });

  it('finds revert data wherever the client puts it (nested data, message text)', async () => {
    let r = await util.replayFailedTx({ call: async () => { throw { code: -32603, message: 'x', data: { message: 'y', data: '0x54e37625' } }; } }, tx, { blockNumber: '0x5' });
    assert.equal(r.decoded.name, 'AlreadyCancelled');
    r = await util.replayFailedTx({ call: async () => { throw new Error('execution reverted: 0x3b6405f4'); } }, tx, { blockNumber: '0x5' });
    assert.equal(r.decoded.name, 'NotMerchant');
  });

  it('returns null when nothing can be recovered (succeeds, unknown error, no block number, client unreachable)', async () => {
    assert.equal(await util.replayFailedTx({ call: async () => '0x' }, tx, { blockNumber: '0x5' }), null);
    assert.equal(await util.replayFailedTx({ call: async () => { throw failing('0xdeadbeef'); } }, tx, { blockNumber: '0x5' }), null);
    assert.equal(await util.replayFailedTx({ call: async () => { throw new Error('Failed to fetch'); } }, tx, { blockNumber: '0x5' }), null);
    assert.equal(await util.replayFailedTx({ call: async () => { throw failing('0x1f2a2005'); } }, tx, {}), null);
    assert.equal(await util.replayFailedTx({ call: async () => { throw failing('0x1f2a2005'); } }, tx, null), null);
  });

  it('omits value for transactions that carry none and never asks for block -1', async () => {
    const calls = [];
    await util.replayFailedTx({ call: async (t, tag) => { calls.push([t, tag]); return '0x'; } }, { from: PAYER, to: CONTRACT, data: '0x1234' }, { blockNumber: '0x0' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], '0x0');
    assert.ok(!('value' in calls[0][0]));
  });

  it('a mined TransferFailed does not claim that nothing was sent', async () => {
    const r = await util.replayFailedTx({ call: async () => { throw failing('0x90b8ec18'); } }, tx, { blockNumber: '0x5' });
    assert.match(r.sentence, /cannot receive USDC right now/);
    assert.doesNotMatch(r.sentence, /Nothing was sent/);
    assert.doesNotMatch(util.failedOnChainMessage(r), /Nothing was sent/);
    assert.match(util.explainContractError(abi.decodeError('0x90b8ec18')), /Nothing was sent\.$/, 'the pre-send simulation still says so');
  });

  it('failedOnChainMessage says "failed on chain", gives the reason or "reason unknown", and mentions the fee', () => {
    const known = util.failedOnChainMessage({ sentence: 'This invoice has already been paid.' });
    assert.match(known, /^The transaction failed on chain: This invoice has already been paid\./);
    assert.match(known, /The payment itself did not move; only the network fee was spent\.$/);
    assert.doesNotMatch(known, /Nothing was sent/);
    const unknown = util.failedOnChainMessage(null);
    assert.match(unknown, /^The transaction failed on chain \(reason unknown\)/);
    assert.match(unknown, /explorer/);
    assert.match(unknown, /The payment itself did not move; only the network fee was spent\.$/);
    assert.doesNotMatch(unknown, /Nothing was sent/);
  });

  it('explainFailure shows userMessage first, so the on-chain failure text is not replaced by a generic revert text', () => {
    const e = Object.assign(new Error('The transaction failed on chain (reverted)'), { code: 'TX_REVERTED', userMessage: 'The transaction failed on chain: custom text.' });
    assert.equal(util.explainFailure(e), 'The transaction failed on chain: custom text.');
  });
});

describe('TransferFailed wording', () => {
  it('explains that the merchant cannot receive USDC and that nothing was sent', () => {
    const sentence = util.explainContractError(abi.decodeError('0x90b8ec18'));
    assert.equal(sentence, 'The merchant account cannot receive USDC right now (for example it is blocked by the USDC issuer, or it is a contract that rejects payments). Nothing was sent.');
  });

  it('explainFailure maps a TransferFailed revert from an estimateGas error to that sentence', () => {
    const err = { code: -32603, message: 'Error: VM Exception', data: { message: 'x', data: '0x90b8ec18' } };
    assert.match(util.explainFailure(err), /cannot receive USDC right now/);
  });
});
