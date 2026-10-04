"use strict";
// Integration: the static web app's own modules (web/js) driven against the real contract on Hardhat's EVM.
// Calldata the pages build is accepted by the contract, logs the receipts page scans decode, and the folded
// records, totals and CSV match what is on the chain. No browser needed; the JSON-RPC client talks to the
// in-process node through an injected fetch.
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers, network } = hre;
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const abi = require("../web/js/abi.js");
const util = require("../web/js/util.js");
const rpc = require("../web/js/rpc.js");

const USDC = 1_000_000n;
const DAY = 86400;

/** A fetch() that answers JSON-RPC (single or batch) from Hardhat's in-process node. */
function hardhatFetch() {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const run = async (req) => {
      try {
        return { jsonrpc: "2.0", id: req.id, result: await network.provider.send(req.method, req.params || []) };
      } catch (e) {
        return { jsonrpc: "2.0", id: req.id, error: { code: e.code || -32000, message: e.message, data: e.data } };
      }
    };
    const out = Array.isArray(body) ? await Promise.all(body.map(run)) : await run(body);
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
}

async function fixture() {
  const [, merchant, payer, payer2, other] = await ethers.getSigners();
  const inv = await (await ethers.getContractFactory("InvoiceReceipts")).deploy();
  const deployReceipt = await inv.deploymentTransaction().wait();
  const client = rpc.createClient({ url: "http://hardhat.test", fetch: hardhatFetch(), retries: 0 });
  return { inv, merchant, payer, payer2, other, client, address: await inv.getAddress(), deployBlock: deployReceipt.blockNumber };
}

describe("web modules against the real contract", function () {
  it("builds calldata the contract accepts, scans and folds events, and exports a faithful CSV", async function () {
    const { inv, merchant, payer, payer2, client, address, deployBlock } = await loadFixture(fixture);
    const send = async (signer, data, value = 0n) => (await (await signer.sendTransaction({ to: address, data, value, gasLimit: 400000 })).wait());

    // four invoices made the way the create page makes them (memo text -> hash -> id -> register)
    const now = await time.latest();
    const specs = [
      { number: "INV-1", description: 'Logo design, "final" round', amount: 25n * USDC, due: now + 7 * DAY },
      { number: "INV-2", description: "=1+1 hosting", amount: 1_250_000n, due: now + 7 * DAY },
      { number: "", description: "Quick fix\nsecond line", amount: 100_000n, due: now + 600 },
      { number: "INV-4", description: "Retainer, 😀 emoji", amount: 3_000_000n, due: now + 30 * DAY },
    ];
    const memos = {};
    const ids = [];
    for (const spec of specs) {
      const memo = util.buildMemo({ number: spec.number, description: spec.description, salt: util.randomSalt() });
      const referenceHash = util.memoHash(memo);
      expect(util.verifyMemo(memo, referenceHash)).to.equal(true);
      const id = abi.invoiceId(merchant.address, referenceHash);
      expect(id).to.equal(await inv.invoiceId(merchant.address, referenceHash));
      memos[referenceHash] = memo;
      ids.push(id);
      await send(merchant, abi.encodeRegister(referenceHash, spec.amount, spec.due));
    }

    // pay 1, cancel 2, let 3 expire, leave 4 open; pay with the exact native value the page computes
    const paid = await send(payer, abi.encodePay(ids[0]), util.usdcToNative(specs[0].amount));
    await send(merchant, abi.encodeCancel(ids[1]));
    await time.increaseTo(specs[2].due + 5);

    // the pay page's read: eth_call getInvoice through the web client matches ethers
    for (let i = 0; i < ids.length; i++) {
      const raw = await client.request("eth_call", [{ to: address, data: abi.encodeGetInvoice(ids[i]) }, "latest"]);
      const decoded = abi.decodeGetInvoice(raw);
      const viaEthers = await inv.getInvoice(ids[i]);
      expect(decoded.merchant.toLowerCase()).to.equal(merchant.address.toLowerCase());
      expect(BigInt(decoded.amount)).to.equal(viaEthers.amount);
      expect(Number(decoded.status)).to.equal(Number(viaEthers.status));
      expect(decoded.referenceHash.toLowerCase()).to.equal(viaEthers.referenceHash.toLowerCase());
    }

    // the receipts page's scan: tiny chunks force many windows; topics = [events], any id, this merchant
    const head = await ethers.provider.getBlockNumber();
    const scan = await rpc.scanLogs({
      client,
      address,
      topics: [[abi.TOPICS.InvoiceRegistered, abi.TOPICS.InvoicePaid, abi.TOPICS.InvoiceCancelled], null, abi.addressTopic(merchant.address)],
      fromBlock: deployBlock,
      toBlock: head,
      chunkSize: 3,
      concurrency: 2,
    });
    const logs = Array.isArray(scan) ? scan : scan.logs;
    expect(logs).to.have.length(4 + 1 + 1); // 4 registered, 1 paid, 1 cancelled
    const events = abi.decodeLogs(logs, address);
    expect(events.map((e) => e.type).sort()).to.deep.equal(["InvoiceCancelled", "InvoicePaid", "InvoiceRegistered", "InvoiceRegistered", "InvoiceRegistered", "InvoiceRegistered"]);

    const records = util.foldEvents(events);
    const latest = (await ethers.provider.getBlock("latest")).timestamp;
    const status = Object.fromEntries(records.map((r) => [r.id, util.effectiveStatus(r, latest)]));
    expect(status[ids[0]]).to.equal("paid");
    expect(status[ids[1]]).to.equal("cancelled");
    expect(status[ids[2]]).to.equal("expired");
    expect(status[ids[3]]).to.equal("open");
    const totals = util.summarize(records, latest);
    expect(totals.paidTotal).to.equal(25n * USDC);
    expect(totals.outstandingTotal).to.equal(3_000_000n);
    expect(totals.counts).to.deep.equal({ open: 1, expired: 1, paid: 1, cancelled: 1, total: 4 });
    const paidRecord = records.find((r) => r.id === ids[0]);
    expect(paidRecord.payer.toLowerCase()).to.equal(payer.address.toLowerCase());
    expect(paidRecord.paymentTx).to.equal(paid.hash.toLowerCase());

    // CSV: one row per invoice, quotes/commas/newlines escaped, formula injection neutralised, BOM + CRLF
    const csv = util.buildInvoiceCsv(records, { network: "local", contract: address, memos, latestTimestamp: latest });
    expect(csv.startsWith(util.CSV_BOM)).to.equal(true);
    expect(csv).to.include("\r\n");
    expect(csv).to.include('"Logo design, ""final"" round"');
    expect(csv).to.include("'=1+1 hosting"); // a leading = is neutralised with a single quote
    expect(csv).to.not.include(",=1+1 hosting");
    expect(csv).to.include('"Quick fix\nsecond line"');
    expect(csv).to.include("25.000000");
    expect(csv).to.include("1.250000");
    expect(csv.split("\r\n").filter((l) => l.length).length).to.be.greaterThan(4);

    // payer mode: only receipts where this account paid
    const payerScan = await rpc.scanLogs({
      client,
      address,
      topics: [abi.TOPICS.InvoicePaid, null, null, abi.addressTopic(payer.address)],
      fromBlock: deployBlock,
      toBlock: head,
      chunkSize: 4,
    });
    const payerLogs = Array.isArray(payerScan) ? payerScan : payerScan.logs;
    expect(abi.decodeLogs(payerLogs, address)).to.have.length(1);
    const otherScan = await rpc.scanLogs({ client, address, topics: [abi.TOPICS.InvoicePaid, null, null, abi.addressTopic(payer2.address)], fromBlock: deployBlock, toBlock: head });
    expect(Array.isArray(otherScan) ? otherScan : otherScan.logs).to.have.length(0);

    // the pay page's receipt card: events found in the transaction receipt, only from our contract
    const rawReceipt = await client.request("eth_getTransactionReceipt", [paid.hash]);
    const found = abi.eventsFromReceipt(rawReceipt, address, { type: "InvoicePaid", id: ids[0] });
    expect(found).to.have.length(1);
    expect(found[0].amount).to.equal(25n * USDC);
    expect(found[0].payer.toLowerCase()).to.equal(payer.address.toLowerCase());
  });

  it("ignores a forged InvoicePaid emitted by a different contract", async function () {
    const { inv, merchant, payer, client, address } = await loadFixture(fixture);
    const impostor = await (await ethers.getContractFactory("InvoiceReceipts")).deploy();
    const impostorAddress = await impostor.getAddress();
    const referenceHash = ethers.id("forged");
    const due = BigInt((await time.latest()) + DAY);
    for (const c of [inv, impostor]) await (await c.connect(merchant).register(referenceHash, USDC, due)).wait();
    const id = abi.invoiceId(merchant.address, referenceHash);
    // the same invoice id exists on both contracts; only the impostor is paid
    const receipt = await (await payer.sendTransaction({ to: impostorAddress, data: abi.encodePay(id), value: util.usdcToNative(USDC), gasLimit: 300000 })).wait();
    const raw = await client.request("eth_getTransactionReceipt", [receipt.hash]);
    expect(abi.eventsFromReceipt(raw, impostorAddress, { type: "InvoicePaid", id })).to.have.length(1);
    expect(abi.eventsFromReceipt(raw, address, { type: "InvoicePaid", id })).to.have.length(0); // wrong contract: not trusted
    expect(abi.decodeLogs(raw.logs, address)).to.have.length(0);
  });

  it("explains every contract error in plain English and decodes revert data", async function () {
    const { inv, merchant, payer, client, address } = await loadFixture(fixture);
    const referenceHash = ethers.id("errors");
    const due = BigInt((await time.latest()) + DAY);
    await (await inv.connect(merchant).register(referenceHash, USDC, due)).wait();
    const id = abi.invoiceId(merchant.address, referenceHash);
    const reasonFor = async (from, data, value) => {
      try {
        await client.request("eth_call", [{ from, to: address, data, value: "0x" + value.toString(16) }, "latest"]);
        return null;
      } catch (e) {
        const decoded = abi.decodeError(abi.findRevertData(e));
        return decoded ? { decoded, text: util.explainContractError(decoded) } : null;
      }
    };
    const wrong = await reasonFor(payer.address, abi.encodePay(id), util.usdcToNative(USDC) - 1n);
    expect(wrong.decoded.name).to.equal("WrongAmount");
    expect(wrong.text).to.be.a("string").and.not.equal("");
    const unknown = await reasonFor(payer.address, abi.encodePay(ethers.id("nothing")), 1n);
    expect(unknown.decoded.name).to.equal("UnknownInvoice");
    const notMerchant = await reasonFor(payer.address, abi.encodeCancel(id), 0n);
    expect(notMerchant.decoded.name).to.equal("NotMerchant");
    for (const r of [wrong, unknown, notMerchant]) expect(r.text.length).to.be.greaterThan(10);
  });
});
