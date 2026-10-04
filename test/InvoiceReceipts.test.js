"use strict";
// Full test suite for contracts/InvoiceReceipts.sol: every rule, every revert, every event.
// Runs on Hardhat's in-process EVM. Arc-specific behaviour is covered by scripts/scenario.js on Arc Testnet.
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { loadFixture, time, setBalance } = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const SCALE = 10n ** 12n; // native units (18 decimals) per 6-decimal USDC unit
const USDC = 1_000_000n; // one USDC in 6-decimal units
const MAX_UINT96 = 2n ** 96n - 1n;
const MAX_UINT40 = 2n ** 40n - 1n;
const DAY = 24 * 3600;
const Status = { None: 0n, Open: 1n, Paid: 2n, Cancelled: 3n };
const ZERO_ADDRESS = ethers.ZeroAddress;

const refOf = (text) => ethers.id(text); // keccak256 of the UTF-8 text
const valueOf = (units) => units * SCALE; // native value that pays `units` (6-decimal) USDC

async function deployFixture() {
  const [deployer, merchant, payer, payer2, stranger] = await ethers.getSigners();
  const inv = await (await ethers.getContractFactory("InvoiceReceipts")).deploy();
  await inv.waitForDeployment();
  return { inv, deployer, merchant, payer, payer2, stranger };
}

/** Registers an invoice for `merchant` and returns everything a test needs. */
async function openInvoice(inv, merchant, opts = {}) {
  const { text = "INV-1", amount = 25n * USDC, ttl = 7 * DAY } = opts;
  const referenceHash = refOf(text);
  const due = BigInt((await time.latest()) + ttl);
  const id = await inv.invoiceId(merchant.address, referenceHash);
  await (await inv.connect(merchant).register(referenceHash, amount, due)).wait();
  return { id, referenceHash, amount, due, value: valueOf(amount) };
}

async function stateOf(inv, id) {
  const r = await inv.getInvoice(id);
  return {
    merchant: r.merchant,
    due: r.due,
    paidAt: r.paidAt,
    status: r.status,
    referenceHash: r.referenceHash,
    payer: r.payer,
    amount: r.amount,
  };
}

/** Resolves once the transaction is mined (a real chain or arc-anvil needs a moment; Hardhat's node does not). */
async function mined(promise) {
  const tx = await promise;
  await tx.wait();
  return tx;
}

/** Pulls revert data out of whatever shape an error has (Hardhat in-process, Anvil, a real node). */
function revertDataOf(e) {
  for (const candidate of [e && e.data, e && e.error && e.error.data, e && e.info && e.info.error && e.info.error.data, e && e.info && e.info.error && e.info.error.data && e.info.error.data.data]) {
    if (typeof candidate === "string" && candidate.startsWith("0x") && candidate.length >= 10) return candidate;
    if (candidate && typeof candidate === "object" && typeof candidate.data === "string") return candidate.data;
  }
  return null;
}

/**
 * Sends a transaction with an explicit gas limit and reports how it ended, identically on every kind of node:
 * Hardhat's in-process node throws at send time with the revert data; a real chain (and Arc Foundry's arc-anvil)
 * mines the failed transaction with status 0 and no data, so the reason is recovered by replaying the same call
 * at the block it was mined in. Returns { error: "CustomErrorName" | null, receipt }.
 */
async function attempt(inv, signer, fn, args, { value = 0n, gasLimit = 500000n } = {}) {
  const request = { to: await inv.getAddress(), data: inv.interface.encodeFunctionData(fn, args), value, gasLimit };
  try {
    const tx = await signer.sendTransaction(request);
    const receipt = await tx.wait();
    return { error: null, receipt };
  } catch (e) {
    let data = revertDataOf(e);
    if (!data && e.receipt) {
      try {
        await ethers.provider.call({ from: e.receipt.from, ...request }, e.receipt.blockNumber);
      } catch (replayError) {
        data = revertDataOf(replayError);
      }
    }
    const parsed = data ? inv.interface.parseError(data) : null;
    return { error: parsed ? parsed.name : `unrecognised: ${e.message.slice(0, 120)}`, args: parsed ? parsed.args : null, receipt: e.receipt || null };
  }
}

/**
 * A transaction that must never execute successfully: rejected, dropped by the node, or mined with status 0.
 * (Treating "not mined within 3 s" as a pass assumes an instant-mining test node such as Hardhat's or arc-anvil;
 * every call site also asserts that no state changed.)
 */
async function expectNotExecuted(signer, tx) {
  let sent;
  try {
    sent = await signer.sendTransaction(tx);
  } catch (e) {
    return;
  }
  const outcome = await Promise.race([
    sent.wait().then(() => "executed", () => "failed"),
    new Promise((resolve) => setTimeout(() => resolve("not mined"), 3000)),
  ]);
  expect(outcome).to.not.equal("executed");
}

describe("InvoiceReceipts", function () {
  // ---------------------------------------------------------------------------------------------------------
  describe("register", function () {
    it("stores the invoice and emits InvoiceRegistered", async function () {
      const { inv, merchant } = await loadFixture(deployFixture);
      const referenceHash = refOf("INV-2026-001");
      const amount = 1_250_000n; // 1.25 USDC
      const due = BigInt((await time.latest()) + 14 * DAY);
      const id = await inv.invoiceId(merchant.address, referenceHash);

      const createdAt = (await time.latest()) + 10;
      await time.setNextBlockTimestamp(createdAt);
      await expect(mined(inv.connect(merchant).register(referenceHash, amount, due)))
        .to.emit(inv, "InvoiceRegistered")
        .withArgs(id, merchant.address, referenceHash, amount, due, createdAt);

      expect(await stateOf(inv, id)).to.deep.equal({
        merchant: merchant.address,
        due,
        paidAt: 0n,
        status: Status.Open,
        referenceHash,
        payer: ZERO_ADDRESS,
        amount,
      });
    });

    it("returns the id from a call and the id equals keccak256(abi.encode(merchant, referenceHash))", async function () {
      const { inv, merchant } = await loadFixture(deployFixture);
      const referenceHash = refOf("anything");
      const due = BigInt((await time.latest()) + DAY);
      const returned = await inv.connect(merchant).register.staticCall(referenceHash, 5n, due);
      const independent = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["address", "bytes32"], [merchant.address, referenceHash])
      );
      expect(returned).to.equal(independent);
      expect(await inv.invoiceId(merchant.address, referenceHash)).to.equal(independent);
      // and the same as hashing the two padded words by hand, which is what the web page does
      expect(independent).to.equal(ethers.keccak256(ethers.concat([ethers.zeroPadValue(merchant.address, 32), referenceHash])));
    });

    it("lets two merchants use the same reference hash without a clash", async function () {
      const { inv, merchant, stranger } = await loadFixture(deployFixture);
      const a = await openInvoice(inv, merchant, { text: "same" });
      const b = await openInvoice(inv, stranger, { text: "same" });
      expect(a.id).to.not.equal(b.id);
      expect((await stateOf(inv, a.id)).merchant).to.equal(merchant.address);
      expect((await stateOf(inv, b.id)).merchant).to.equal(stranger.address);
    });

    it("accepts the largest amount and the latest due time the types allow", async function () {
      const { inv, merchant } = await loadFixture(deployFixture);
      const referenceHash = refOf("extremes");
      const id = await inv.invoiceId(merchant.address, referenceHash);
      await (await inv.connect(merchant).register(referenceHash, MAX_UINT96, MAX_UINT40)).wait();
      const s = await stateOf(inv, id);
      expect(s.amount).to.equal(MAX_UINT96);
      expect(s.due).to.equal(MAX_UINT40);
    });

    it("reverts with ZeroReferenceHash on a zero hash", async function () {
      const { inv, merchant } = await loadFixture(deployFixture);
      const due = BigInt((await time.latest()) + DAY);
      await expect(inv.connect(merchant).register(ethers.ZeroHash, 1n, due)).to.be.revertedWithCustomError(
        inv,
        "ZeroReferenceHash"
      );
    });

    it("reverts with ZeroAmount on a zero amount", async function () {
      const { inv, merchant } = await loadFixture(deployFixture);
      const due = BigInt((await time.latest()) + DAY);
      await expect(inv.connect(merchant).register(refOf("x"), 0n, due)).to.be.revertedWithCustomError(inv, "ZeroAmount");
    });

    it("reverts with DueNotInFuture when due is in the past, equal to now, or zero", async function () {
      const { inv, merchant } = await loadFixture(deployFixture);
      const now = await time.latest();
      // a due time equal to the block timestamp of the registration is not in the future
      await time.setNextBlockTimestamp(now + 100);
      const equal = await attempt(inv, merchant, "register", [refOf("equal"), 1n, now + 100], { gasLimit: 300000n });
      expect(equal.error).to.equal("DueNotInFuture");
      const later = (await time.latest()) + 10;
      await expect(inv.connect(merchant).register(refOf("past"), 1n, later - 20)).to.be.revertedWithCustomError(inv, "DueNotInFuture");
      await expect(inv.connect(merchant).register(refOf("zero"), 1n, 0n)).to.be.revertedWithCustomError(inv, "DueNotInFuture");
    });

    it("accepts a due time exactly one second after the block timestamp", async function () {
      const { inv, merchant } = await loadFixture(deployFixture);
      const now = await time.latest();
      await time.setNextBlockTimestamp(now + 100);
      await (await inv.connect(merchant).register(refOf("one second"), 1n, now + 101, { gasLimit: 300000 })).wait();
      const id = await inv.invoiceId(merchant.address, refOf("one second"));
      expect((await stateOf(inv, id)).status).to.equal(Status.Open);
    });

    it("reverts with AlreadyRegistered when the same merchant reuses a reference hash (open, paid and cancelled)", async function () {
      const { inv, merchant, payer } = await loadFixture(deployFixture);
      const due = BigInt((await time.latest()) + DAY);

      const open = await openInvoice(inv, merchant, { text: "open" });
      await expect(inv.connect(merchant).register(open.referenceHash, 7n, due)).to.be.revertedWithCustomError(inv, "AlreadyRegistered");

      const paid = await openInvoice(inv, merchant, { text: "paid" });
      await (await inv.connect(payer).pay(paid.id, { value: paid.value })).wait();
      await expect(inv.connect(merchant).register(paid.referenceHash, 7n, due)).to.be.revertedWithCustomError(inv, "AlreadyRegistered");

      const cancelled = await openInvoice(inv, merchant, { text: "cancelled" });
      await (await inv.connect(merchant).cancel(cancelled.id)).wait();
      await expect(inv.connect(merchant).register(cancelled.referenceHash, 7n, due)).to.be.revertedWithCustomError(
        inv,
        "AlreadyRegistered"
      );
      // the invoice that was refused did not overwrite the stored one
      expect((await stateOf(inv, cancelled.id)).amount).to.equal(cancelled.amount);
      expect((await stateOf(inv, cancelled.id)).status).to.equal(Status.Cancelled);
    });

    it("allows a fresh reference hash after a cancellation (the replacement invoice)", async function () {
      const { inv, merchant } = await loadFixture(deployFixture);
      const first = await openInvoice(inv, merchant, { text: "INV-9" });
      await (await inv.connect(merchant).cancel(first.id)).wait();
      const second = await openInvoice(inv, merchant, { text: "INV-9 (reissued)" });
      expect((await stateOf(inv, second.id)).status).to.equal(Status.Open);
    });

    it("rejects a due value that does not fit in uint40 at the ABI level (no silent truncation)", async function () {
      const { inv, merchant } = await loadFixture(deployFixture);
      const word = (n) => ethers.toBeHex(n, 32);
      const selector = inv.interface.getFunction("register").selector;
      const data = ethers.concat([selector, refOf("big"), word(1n), word(2n ** 40n)]);
      await expectNotExecuted(merchant, { to: await inv.getAddress(), data, gasLimit: 300000 });
      // same for an amount that does not fit in uint96
      const data2 = ethers.concat([selector, refOf("big2"), word(2n ** 96n), word(MAX_UINT40)]);
      await expectNotExecuted(merchant, { to: await inv.getAddress(), data: data2, gasLimit: 300000 });
      expect((await stateOf(inv, await inv.invoiceId(merchant.address, refOf("big")))).status).to.equal(Status.None);
      expect((await stateOf(inv, await inv.invoiceId(merchant.address, refOf("big2")))).status).to.equal(Status.None);
    });

    it("lets a smart-contract wallet register and be paid as merchant", async function () {
      const { inv, payer } = await loadFixture(deployFixture);
      const wallet = await (await ethers.getContractFactory("TestMerchant")).deploy(await inv.getAddress());
      const referenceHash = refOf("from a contract");
      const id = await inv.invoiceId(await wallet.getAddress(), referenceHash);
      const due = BigInt((await time.latest()) + DAY);
      await (await wallet.register(referenceHash, 3n * USDC, due)).wait();
      expect((await stateOf(inv, id)).merchant).to.equal(await wallet.getAddress());

      await expect(mined(inv.connect(payer).pay(id, { value: valueOf(3n * USDC) }))).to.changeEtherBalance(
        wallet,
        valueOf(3n * USDC)
      );
      expect(await wallet.received()).to.equal(valueOf(3n * USDC));
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  describe("pay", function () {
    it("sends the USDC straight to the merchant, keeps nothing, records the payment and emits the receipt", async function () {
      const { inv, merchant, payer } = await loadFixture(deployFixture);
      const { id, referenceHash, amount, value } = await openInvoice(inv, merchant, { amount: 1_250_000n });

      const paidAt = (await time.latest()) + 60;
      await time.setNextBlockTimestamp(paidAt);
      const tx = mined(inv.connect(payer).pay(id, { value }));
      await expect(tx).to.changeEtherBalances([payer, merchant, inv], [-value, value, 0n]);
      // (the matcher above already sent the transaction; read the state it produced)
      expect(await ethers.provider.getBalance(await inv.getAddress())).to.equal(0n);

      const s = await stateOf(inv, id);
      expect(s.status).to.equal(Status.Paid);
      expect(s.payer).to.equal(payer.address);
      expect(s.paidAt).to.equal(BigInt(paidAt));
      expect(s.amount).to.equal(1_250_000n); // the stored price is unchanged
    });

    it("emits InvoicePaid with every field of the receipt", async function () {
      const { inv, merchant, payer } = await loadFixture(deployFixture);
      const { id, referenceHash, amount, value } = await openInvoice(inv, merchant);
      const paidAt = (await time.latest()) + 5;
      await time.setNextBlockTimestamp(paidAt);
      await expect(mined(inv.connect(payer).pay(id, { value })))
        .to.emit(inv, "InvoicePaid")
        .withArgs(id, merchant.address, payer.address, referenceHash, amount, paidAt);
    });

    it("moves exactly amount * 1e12 native units: 1.25 USDC is 1.25e18", async function () {
      const { inv, merchant, payer } = await loadFixture(deployFixture);
      const { id, value } = await openInvoice(inv, merchant, { amount: 1_250_000n });
      expect(value).to.equal(1_250_000_000_000_000_000n);
      expect(await inv.SCALE()).to.equal(SCALE);
      await expect(mined(inv.connect(payer).pay(id, { value }))).to.changeEtherBalance(merchant, 1_250_000_000_000_000_000n);
    });

    it("lets anyone pay, and records whoever actually paid", async function () {
      const { inv, merchant, payer2 } = await loadFixture(deployFixture);
      const { id, value } = await openInvoice(inv, merchant);
      await (await inv.connect(payer2).pay(id, { value })).wait();
      expect((await stateOf(inv, id)).payer).to.equal(payer2.address);
    });

    it("lets the merchant pay their own invoice (recorded as such, nothing is created or lost)", async function () {
      const { inv, merchant } = await loadFixture(deployFixture);
      const { id, value } = await openInvoice(inv, merchant);
      await expect(mined(inv.connect(merchant).pay(id, { value }))).to.changeEtherBalance(inv, 0n);
      expect((await stateOf(inv, id)).payer).to.equal(merchant.address);
    });

    it("accepts payment in the due second and rejects it one second later", async function () {
      const { inv, merchant, payer, payer2 } = await loadFixture(deployFixture);
      const a = await openInvoice(inv, merchant, { text: "on time", ttl: 1000 });
      const b = await openInvoice(inv, merchant, { text: "late", ttl: 1000 });

      await time.setNextBlockTimestamp(a.due);
      await (await inv.connect(payer).pay(a.id, { value: a.value, gasLimit: 300000 })).wait();
      expect((await stateOf(inv, a.id)).status).to.equal(Status.Paid);

      await time.increaseTo(b.due + 1n); // the latest block is now past the due time
      await expect(inv.connect(payer2).pay(b.id, { value: b.value }))
        .to.be.revertedWithCustomError(inv, "InvoiceExpired")
        .withArgs(b.due);
      expect((await stateOf(inv, b.id)).status).to.equal(Status.Open); // stored status is untouched
    });

    it("reverts with WrongAmount on partial payment, overpayment and zero value (to the exact unit)", async function () {
      const { inv, merchant, payer } = await loadFixture(deployFixture);
      const { id, value } = await openInvoice(inv, merchant, { amount: 10n * USDC });
      for (const sent of [0n, 1n, value / 2n, value - SCALE, value - 1n, value + 1n, value + SCALE, value * 2n]) {
        await expect(inv.connect(payer).pay(id, { value: sent }))
          .to.be.revertedWithCustomError(inv, "WrongAmount")
          .withArgs(value, sent);
      }
      // nothing moved, and the right amount still works afterwards
      expect((await stateOf(inv, id)).status).to.equal(Status.Open);
      await (await inv.connect(payer).pay(id, { value })).wait();
      expect((await stateOf(inv, id)).status).to.equal(Status.Paid);
    });

    it("reverts with AlreadyPaid on a second payment, from the same payer or another, and moves no money", async function () {
      const { inv, merchant, payer, payer2 } = await loadFixture(deployFixture);
      const { id, value } = await openInvoice(inv, merchant);
      await (await inv.connect(payer).pay(id, { value })).wait();
      const before = await stateOf(inv, id);

      await expect(inv.connect(payer).pay(id, { value })).to.be.revertedWithCustomError(inv, "AlreadyPaid");
      await expect(inv.connect(payer2).pay(id, { value })).to.be.revertedWithCustomError(inv, "AlreadyPaid");
      // the failed attempts are rejected before any value check, whatever was attached
      await expect(inv.connect(payer2).pay(id, { value: 1n })).to.be.revertedWithCustomError(inv, "AlreadyPaid");

      expect(await stateOf(inv, id)).to.deep.equal(before);
      expect(await ethers.provider.getBalance(await inv.getAddress())).to.equal(0n);
    });

    it("reverts with AlreadyCancelled when paying a cancelled invoice", async function () {
      const { inv, merchant, payer } = await loadFixture(deployFixture);
      const { id, value } = await openInvoice(inv, merchant);
      await (await inv.connect(merchant).cancel(id)).wait();
      await expect(inv.connect(payer).pay(id, { value })).to.be.revertedWithCustomError(inv, "AlreadyCancelled");
      expect((await stateOf(inv, id)).status).to.equal(Status.Cancelled);
      expect((await stateOf(inv, id)).payer).to.equal(ZERO_ADDRESS);
    });

    it("reverts with UnknownInvoice for an id nobody registered", async function () {
      const { inv, payer } = await loadFixture(deployFixture);
      await expect(inv.connect(payer).pay(refOf("nope"), { value: 1n })).to.be.revertedWithCustomError(inv, "UnknownInvoice");
      await expect(inv.connect(payer).pay(ethers.ZeroHash)).to.be.revertedWithCustomError(inv, "UnknownInvoice");
    });

    it("cannot pay an invoice registered by somebody else under your own id (ids are bound to the merchant)", async function () {
      const { inv, merchant, stranger, payer } = await loadFixture(deployFixture);
      const mine = await openInvoice(inv, merchant, { text: "same text" });
      // the stranger never registered 'same text', so the id derived from the stranger is unknown
      const strangerId = await inv.invoiceId(stranger.address, mine.referenceHash);
      await expect(inv.connect(payer).pay(strangerId, { value: mine.value })).to.be.revertedWithCustomError(inv, "UnknownInvoice");
    });

    it("pays the registered merchant even when many invoices and merchants exist", async function () {
      const { inv, merchant, stranger, payer } = await loadFixture(deployFixture);
      const a = await openInvoice(inv, merchant, { text: "a", amount: 3n * USDC });
      const b = await openInvoice(inv, stranger, { text: "b", amount: 4n * USDC });
      await expect(mined(inv.connect(payer).pay(b.id, { value: b.value }))).to.changeEtherBalances([stranger, merchant], [b.value, 0n]);
      await expect(mined(inv.connect(payer).pay(a.id, { value: a.value }))).to.changeEtherBalances([merchant, stranger], [a.value, 0n]);
    });

    it("reverts with TransferFailed and changes nothing when the merchant contract rejects the USDC", async function () {
      const { inv, payer } = await loadFixture(deployFixture);
      const m = await (await ethers.getContractFactory("TestMerchant")).deploy(await inv.getAddress());
      const referenceHash = refOf("picky merchant");
      const id = await inv.invoiceId(await m.getAddress(), referenceHash);
      const due = BigInt((await time.latest()) + DAY);
      await (await m.register(referenceHash, 2n * USDC, due)).wait();
      await m.setMode(1, ethers.ZeroHash); // Reject

      const value = valueOf(2n * USDC);
      const payerBefore = await ethers.provider.getBalance(payer.address);
      await expect(inv.connect(payer).pay(id, { value })).to.be.revertedWithCustomError(inv, "TransferFailed");
      // the revert is mined, so the payer loses the gas fee, never the payment
      const payerAfter = await ethers.provider.getBalance(payer.address);
      expect(payerBefore - payerAfter).to.be.lessThan(value);
      expect(await ethers.provider.getBalance(await m.getAddress())).to.equal(0n);
      expect(await ethers.provider.getBalance(await inv.getAddress())).to.equal(0n);
      expect((await stateOf(inv, id)).status).to.equal(Status.Open);
      expect((await stateOf(inv, id)).payer).to.equal(ZERO_ADDRESS);
      expect((await stateOf(inv, id)).paidAt).to.equal(0n);

      // once the merchant accepts again the same invoice can be paid
      await m.setMode(0, ethers.ZeroHash); // Accept
      await expect(mined(inv.connect(payer).pay(id, { value }))).to.changeEtherBalance(m, value);
      expect((await stateOf(inv, id)).status).to.equal(Status.Paid);
    });

    it("reverts with TransferFailed and changes nothing when the merchant contract burns all gas", async function () {
      const { inv, payer } = await loadFixture(deployFixture);
      const m = await (await ethers.getContractFactory("TestMerchant")).deploy(await inv.getAddress());
      const referenceHash = refOf("gas burner");
      const id = await inv.invoiceId(await m.getAddress(), referenceHash);
      await (await m.register(referenceHash, USDC, BigInt((await time.latest()) + DAY))).wait();
      await m.setMode(3, ethers.ZeroHash); // BurnGas

      const burned = await attempt(inv, payer, "pay", [id], { value: valueOf(USDC), gasLimit: 600000n });
      expect(burned.error).to.equal("TransferFailed");
      expect((await stateOf(inv, id)).status).to.equal(Status.Open);
      expect(await ethers.provider.getBalance(await m.getAddress())).to.equal(0n);
    });

    it("is not made more expensive by a merchant that answers with a large return payload", async function () {
      const { inv, payer } = await loadFixture(deployFixture);
      const factory = await ethers.getContractFactory("TestMerchant");
      const calm = await factory.deploy(await inv.getAddress());
      const bomb = await factory.deploy(await inv.getAddress());
      const due = BigInt((await time.latest()) + DAY);
      const gasFor = async (m, text) => {
        const referenceHash = refOf(text);
        const id = await inv.invoiceId(await m.getAddress(), referenceHash);
        await (await m.register(referenceHash, USDC, due)).wait();
        const receipt = await (await inv.connect(payer).pay(id, { value: valueOf(USDC), gasLimit: 1_000_000 })).wait();
        expect(await m.received()).to.equal(valueOf(USDC));
        return receipt.gasUsed;
      };
      await (await calm.setMode(0, ethers.ZeroHash)).wait();
      await (await bomb.setMode(4, ethers.ZeroHash)).wait(); // ReturnBomb: returns 100,000 bytes from its hook
      const calmGas = await gasFor(calm, "calm");
      const bombGas = await gasFor(bomb, "bomb");
      // the merchant pays for its own 100 kB of memory (about 30k gas); the contract adds nothing for copying it
      expect(bombGas - calmGas).to.be.lessThan(40_000n);
    });

    it("survives a merchant that re-enters pay, cancel and register from its receive hook", async function () {
      const { inv, payer } = await loadFixture(deployFixture);
      const m = await (await ethers.getContractFactory("TestMerchant")).deploy(await inv.getAddress());
      const referenceHash = refOf("re-entrant merchant");
      const id = await inv.invoiceId(await m.getAddress(), referenceHash);
      await (await m.register(referenceHash, 5n * USDC, BigInt((await time.latest()) + DAY))).wait();
      await m.setMode(2, id); // Reenter

      const value = valueOf(5n * USDC);
      // explicit gas: the hook swallows failures with try/catch, which would make a gas estimate too tight
      await expect(mined(inv.connect(payer).pay(id, { value, gasLimit: 1_500_000 })))
        .to.emit(inv, "InvoicePaid")
        .withArgs(id, await m.getAddress(), payer.address, referenceHash, 5n * USDC, anyValue);

      expect(await m.hookRan()).to.equal(true);
      // the nested second payment and the nested cancellation were both refused
      expect(await m.reenterPayOk()).to.equal(false);
      expect(await m.reenterPaySelector()).to.equal(inv.interface.getError("AlreadyPaid").selector);
      expect(await m.reenterCancelOk()).to.equal(false);
      expect(await m.reenterCancelSelector()).to.equal(inv.interface.getError("AlreadyPaid").selector);
      // an unrelated registration from inside the hook is allowed and harmless
      expect(await m.reenterRegisterOk()).to.equal(true);
      // the merchant holds exactly the one payment; the contract holds nothing
      expect(await ethers.provider.getBalance(await m.getAddress())).to.equal(value);
      expect(await ethers.provider.getBalance(await inv.getAddress())).to.equal(0n);
      expect((await stateOf(inv, id)).status).to.equal(Status.Paid);
    });

    it("keeps no balance: plain transfers and unknown calls revert", async function () {
      const { inv, deployer } = await loadFixture(deployFixture);
      const to = await inv.getAddress();
      await expectNotExecuted(deployer, { to, value: 1n, gasLimit: 100000 });
      await expectNotExecuted(deployer, { to, value: 0n, gasLimit: 100000 });
      await expectNotExecuted(deployer, { to, data: "0xdeadbeef", gasLimit: 100000 });
      await expectNotExecuted(deployer, { to, data: "0xdeadbeef", value: 5n, gasLimit: 100000 });
      expect(await ethers.provider.getBalance(to)).to.equal(0n);
    });

    it("sending value to register, cancel or the views reverts (they are not payable)", async function () {
      const { inv, merchant } = await loadFixture(deployFixture);
      const due = BigInt((await time.latest()) + DAY);
      await expect(inv.connect(merchant).register(refOf("v"), 1n, due, { value: 1n })).to.be.revertedWithoutReason(ethers);
      await expect(inv.connect(merchant).cancel(refOf("v"), { value: 1n })).to.be.revertedWithoutReason(ethers);
    });

    it("is not confused by USDC force-sent to the contract: payment accounting uses msg.value only", async function () {
      const { inv, merchant, payer } = await loadFixture(deployFixture);
      const forced = 7_777_777_777n;
      const forceSender = await (await ethers.getContractFactory("ForceSend")).deploy(await inv.getAddress(), { value: forced });
      await forceSender.deploymentTransaction().wait(); // the contract destroys itself, so wait for the transaction, not the code
      expect(await ethers.provider.getBalance(await inv.getAddress())).to.equal(forced); // stuck there by design

      const { id, value } = await openInvoice(inv, merchant, { amount: 2n * USDC });
      // the extra balance is not available to underpay with
      await expect(inv.connect(payer).pay(id, { value: value - 1n })).to.be.revertedWithCustomError(inv, "WrongAmount");
      await expect(mined(inv.connect(payer).pay(id, { value }))).to.changeEtherBalances([merchant, inv], [value, 0n]);
      expect(await ethers.provider.getBalance(await inv.getAddress())).to.equal(forced); // untouched: no way to take it
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  describe("cancel", function () {
    it("lets the merchant cancel an unpaid invoice and emits InvoiceCancelled", async function () {
      const { inv, merchant } = await loadFixture(deployFixture);
      const { id } = await openInvoice(inv, merchant);
      const at = (await time.latest()) + 33;
      await time.setNextBlockTimestamp(at);
      await expect(mined(inv.connect(merchant).cancel(id))).to.emit(inv, "InvoiceCancelled").withArgs(id, merchant.address, at);
      expect((await stateOf(inv, id)).status).to.equal(Status.Cancelled);
    });

    it("reverts with NotMerchant for anybody else, including the payer and the deployer", async function () {
      const { inv, deployer, merchant, payer, stranger } = await loadFixture(deployFixture);
      const { id } = await openInvoice(inv, merchant);
      for (const who of [payer, stranger, deployer]) {
        await expect(inv.connect(who).cancel(id)).to.be.revertedWithCustomError(inv, "NotMerchant");
      }
      expect((await stateOf(inv, id)).status).to.equal(Status.Open);
    });

    it("reverts with AlreadyPaid after payment and the invoice stays paid", async function () {
      const { inv, merchant, payer } = await loadFixture(deployFixture);
      const { id, value } = await openInvoice(inv, merchant);
      await (await inv.connect(payer).pay(id, { value })).wait();
      await expect(inv.connect(merchant).cancel(id)).to.be.revertedWithCustomError(inv, "AlreadyPaid");
      expect((await stateOf(inv, id)).status).to.equal(Status.Paid);
    });

    it("reverts with AlreadyCancelled on a second cancellation", async function () {
      const { inv, merchant } = await loadFixture(deployFixture);
      const { id } = await openInvoice(inv, merchant);
      await (await inv.connect(merchant).cancel(id)).wait();
      await expect(inv.connect(merchant).cancel(id)).to.be.revertedWithCustomError(inv, "AlreadyCancelled");
    });

    it("reverts with UnknownInvoice for an unknown id", async function () {
      const { inv, merchant } = await loadFixture(deployFixture);
      await expect(inv.connect(merchant).cancel(refOf("unknown"))).to.be.revertedWithCustomError(inv, "UnknownInvoice");
    });

    it("checks the caller before the status, so a stranger learns nothing more than the public state", async function () {
      const { inv, merchant, payer, stranger } = await loadFixture(deployFixture);
      const { id, value } = await openInvoice(inv, merchant);
      await (await inv.connect(payer).pay(id, { value })).wait();
      await expect(inv.connect(stranger).cancel(id)).to.be.revertedWithCustomError(inv, "NotMerchant");
    });

    it("allows cancelling an invoice whose due time has passed (it can no longer be paid either way)", async function () {
      const { inv, merchant, payer } = await loadFixture(deployFixture);
      const { id, due, value } = await openInvoice(inv, merchant, { ttl: 100 });
      await time.increaseTo(due + 10n);
      await expect(inv.connect(payer).pay(id, { value })).to.be.revertedWithCustomError(inv, "InvoiceExpired");
      await (await inv.connect(merchant).cancel(id)).wait();
      expect((await stateOf(inv, id)).status).to.equal(Status.Cancelled);
      await expect(inv.connect(payer).pay(id, { value })).to.be.revertedWithCustomError(inv, "AlreadyCancelled");
    });

    it("a smart-contract merchant can cancel through its own code", async function () {
      const { inv } = await loadFixture(deployFixture);
      const m = await (await ethers.getContractFactory("TestMerchant")).deploy(await inv.getAddress());
      const referenceHash = refOf("cancel me");
      const id = await inv.invoiceId(await m.getAddress(), referenceHash);
      await (await m.register(referenceHash, USDC, BigInt((await time.latest()) + DAY))).wait();
      await (await m.cancel(id)).wait();
      expect((await stateOf(inv, id)).status).to.equal(Status.Cancelled);
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  describe("views", function () {
    it("getInvoice returns all zeros for an id that was never registered", async function () {
      const { inv } = await loadFixture(deployFixture);
      const s = await stateOf(inv, refOf("never"));
      expect(s.status).to.equal(Status.None);
      expect(s.merchant).to.equal(ZERO_ADDRESS);
      expect(s.amount).to.equal(0n);
      expect(s.due).to.equal(0n);
      expect(s.paidAt).to.equal(0n);
      expect(s.payer).to.equal(ZERO_ADDRESS);
      expect(s.referenceHash).to.equal(ethers.ZeroHash);
    });

    it("exposes SCALE = 1e12 (18-decimal native units per 6-decimal unit)", async function () {
      const { inv } = await loadFixture(deployFixture);
      expect(await inv.SCALE()).to.equal(1_000_000_000_000n);
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  describe("no owner, no fee, no upgrade", function () {
    it("exposes exactly the documented functions, events and errors", async function () {
      const { inv } = await loadFixture(deployFixture);
      const names = (type) => inv.interface.fragments.filter((f) => f.type === type).map((f) => f.name).sort();
      expect(names("function")).to.deep.equal(["SCALE", "cancel", "getInvoice", "invoiceId", "pay", "register"]);
      expect(names("event")).to.deep.equal(["InvoiceCancelled", "InvoicePaid", "InvoiceRegistered"]);
      expect(names("error")).to.deep.equal(
        [
          "AlreadyCancelled",
          "AlreadyPaid",
          "AlreadyRegistered",
          "DueNotInFuture",
          "InvoiceExpired",
          "NotMerchant",
          "TransferFailed",
          "UnknownInvoice",
          "WrongAmount",
          "ZeroAmount",
          "ZeroReferenceHash",
        ].sort()
      );
      expect(inv.interface.fragments.some((f) => f.type === "constructor" && f.inputs.length > 0)).to.equal(false);
      for (const forbidden of ["owner", "transferOwnership", "renounceOwnership", "upgradeTo", "upgradeToAndCall", "setFee", "fee", "withdraw", "sweep", "pause", "initialize", "implementation"]) {
        expect(inv.interface.getFunction(forbidden), forbidden).to.equal(null);
      }
    });

    it("has no receive or fallback, and only `pay` is payable", async function () {
      const { inv } = await loadFixture(deployFixture);
      const payable = inv.interface.fragments.filter((f) => f.type === "function" && f.payable).map((f) => f.name);
      expect(payable).to.deep.equal(["pay"]);
      expect(inv.interface.fragments.some((f) => f.type === "receive" || f.type === "fallback")).to.equal(false);
    });

    it("runtime bytecode has no DELEGATECALL, CALLCODE, SELFDESTRUCT, CREATE, CREATE2 or STATICCALL, and exactly one CALL (the payout)", async function () {
      const { inv } = await loadFixture(deployFixture);
      const code = ethers.getBytes(await ethers.provider.getCode(await inv.getAddress()));
      const metaLen = (code[code.length - 2] << 8) | code[code.length - 1]; // trailing CBOR metadata, not code
      const end = code.length - 2 - metaLen;
      const ops = [];
      for (let i = 0; i < end; ) {
        const op = code[i];
        ops.push(op);
        i += 1 + (op >= 0x60 && op <= 0x7f ? op - 0x5f : 0); // skip PUSH data
      }
      const count = (op) => ops.filter((o) => o === op).length;
      expect(count(0xf4), "DELEGATECALL").to.equal(0);
      expect(count(0xf2), "CALLCODE").to.equal(0);
      expect(count(0xff), "SELFDESTRUCT").to.equal(0);
      expect(count(0xf0), "CREATE").to.equal(0);
      expect(count(0xf5), "CREATE2").to.equal(0);
      expect(count(0xfa), "STATICCALL").to.equal(0);
      expect(count(0xf1), "CALL").to.equal(1);
      expect(count(0x3e), "RETURNDATACOPY: the payout never copies return data").to.equal(0);
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  describe("randomised sequences against a reference model", function () {
    // Deterministic PRNG so a failure can be replayed.
    function mulberry32(seed) {
      return function () {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    for (const seed of [1, 2, 3]) {
      it(`300 random register / pay / cancel / time steps agree with the model (seed ${seed})`, async function () {
        const { inv } = await loadFixture(deployFixture);
        const signers = await ethers.getSigners();
        const merchants = signers.slice(1, 4);
        const payers = signers.slice(4, 7);
        const rand = mulberry32(seed);
        const pick = (arr) => arr[Math.floor(rand() * arr.length)];
        const refs = Array.from({ length: 10 }, (_, i) => refOf(`ref-${seed}-${i}`));
        const model = new Map(); // id -> invoice
        const known = [];
        let stepsOk = 0;
        let stepsReverted = 0;

        for (let step = 0; step < 300; step++) {
          const now = await time.latest();
          const ts = now + 1 + Math.floor(rand() * 40); // the timestamp the next block will carry
          await time.setNextBlockTimestamp(ts);
          const action = rand();
          let expectedError = null;
          let touched;
          let result;

          if (action < 0.35) {
            // register
            const m = pick(merchants);
            const referenceHash = pick(refs);
            const amount = BigInt(Math.floor(rand() * 20)) * 250_000n; // sometimes zero
            const due = Math.max(0, ts + Math.floor((rand() - 0.15) * 600)); // sometimes not in the future
            const id = await inv.invoiceId(m.address, referenceHash);
            if (amount === 0n) expectedError = "ZeroAmount";
            else if (BigInt(due) <= BigInt(ts)) expectedError = "DueNotInFuture";
            else if (model.has(id)) expectedError = "AlreadyRegistered";
            result = await attempt(inv, m, "register", [referenceHash, amount, BigInt(due)], { gasLimit: 400000n });
            if (!expectedError) {
              model.set(id, { merchant: m.address, due: BigInt(due), paidAt: 0n, status: Status.Open, referenceHash, payer: ZERO_ADDRESS, amount });
              known.push(id);
            }
            touched = id;
          } else if (action < 0.75) {
            // pay, sometimes with a wrong amount
            const id = rand() < 0.08 || known.length === 0 ? refOf(`unknown-${step}`) : pick(known);
            const p = pick(payers);
            const entry = model.get(id);
            let value = entry ? valueOf(entry.amount) : valueOf(USDC);
            if (rand() > 0.7) value = pick([0n, value - SCALE, value + SCALE, value - 1n, value + 1n, value * 2n]);
            if (value < 0n) value = 0n;
            if (!entry) expectedError = "UnknownInvoice";
            else if (entry.status === Status.Paid) expectedError = "AlreadyPaid";
            else if (entry.status === Status.Cancelled) expectedError = "AlreadyCancelled";
            else if (BigInt(ts) > entry.due) expectedError = "InvoiceExpired";
            else if (value !== valueOf(entry.amount)) expectedError = "WrongAmount";
            const before = {
              payer: await ethers.provider.getBalance(p.address),
              merchant: entry ? await ethers.provider.getBalance(entry.merchant) : 0n,
            };
            result = await attempt(inv, p, "pay", [id], { value, gasLimit: 400000n });
            if (!expectedError) {
              // the payment moved exactly `value` from the payer (plus gas) to the merchant, in that one transaction
              const fee = result.receipt.gasUsed * result.receipt.gasPrice;
              expect(await ethers.provider.getBalance(p.address), `step ${step} payer`).to.equal(before.payer - value - fee);
              expect(await ethers.provider.getBalance(entry.merchant), `step ${step} merchant`).to.equal(before.merchant + value);
              entry.status = Status.Paid;
              entry.payer = p.address;
              entry.paidAt = BigInt(ts);
            } else if (entry) {
              // a refused payment must not have reached the merchant
              expect(await ethers.provider.getBalance(entry.merchant), `step ${step} merchant (refused)`).to.equal(before.merchant);
            }
            touched = id;
          } else {
            // cancel, usually by the merchant, sometimes by somebody else
            const id = rand() < 0.08 || known.length === 0 ? refOf(`unknown-${step}`) : pick(known);
            const entry = model.get(id);
            const caller = entry && rand() < 0.75 ? signers.find((x) => x.address === entry.merchant) : pick([...payers, ...merchants]);
            if (!entry) expectedError = "UnknownInvoice";
            else if (caller.address !== entry.merchant) expectedError = "NotMerchant";
            else if (entry.status === Status.Paid) expectedError = "AlreadyPaid";
            else if (entry.status === Status.Cancelled) expectedError = "AlreadyCancelled";
            result = await attempt(inv, caller, "cancel", [id], { gasLimit: 200000n });
            if (!expectedError) entry.status = Status.Cancelled;
            touched = id;
          }

          expect(result.error, `step ${step}`).to.equal(expectedError);
          if (expectedError) stepsReverted++;
          else stepsOk++;

          // the chain agrees with the model for the invoice just touched, and the contract holds nothing
          const m = model.get(touched);
          const state = await stateOf(inv, touched);
          if (m) expect(state, `step ${step} state`).to.deep.equal(m);
          else expect(state.status).to.equal(Status.None);
          expect(await ethers.provider.getBalance(await inv.getAddress())).to.equal(0n);
        }

        // every invoice the model knows is identical on chain at the end
        for (const [id, m] of model) expect(await stateOf(inv, id)).to.deep.equal(m);
        expect(stepsOk).to.be.greaterThan(40);
        expect(stepsReverted).to.be.greaterThan(40);
      });
    }
  });

  // ---------------------------------------------------------------------------------------------------------
  describe("hardening (cases added after an independent review)", function () {
    const addressTopic = (a) => ethers.zeroPadValue(a, 32).toLowerCase();
    const ownLogs = async (inv, receipt) => {
      const own = (await inv.getAddress()).toLowerCase();
      return receipt.logs.filter((l) => l.address.toLowerCase() === own); // Arc adds system Transfer logs; ignore them
    };

    it("records a smart-contract payer as msg.sender, not tx.origin, in storage and in the receipt", async function () {
      const { inv, deployer, merchant } = await loadFixture(deployFixture);
      const payerContract = await (await ethers.getContractFactory("PayerContract")).deploy();
      const { id, referenceHash, amount, value } = await openInvoice(inv, merchant, { amount: 5n * USDC });
      await expect(mined(payerContract.connect(deployer).payInvoice(await inv.getAddress(), id, { value })))
        .to.emit(inv, "InvoicePaid")
        .withArgs(id, merchant.address, await payerContract.getAddress(), referenceHash, amount, anyValue);
      expect((await stateOf(inv, id)).payer).to.equal(await payerContract.getAddress());
    });

    it("has no grace period: due is the last payable second and due + 1 is refused", async function () {
      const { inv, merchant, payer } = await loadFixture(deployFixture);
      const a = await openInvoice(inv, merchant, { text: "edge-a", ttl: 1000 });
      const b = await openInvoice(inv, merchant, { text: "edge-b", ttl: 3000 });
      await time.setNextBlockTimestamp(a.due + 1n);
      const late = await attempt(inv, payer, "pay", [a.id], { value: a.value, gasLimit: 300000n });
      expect(late.error).to.equal("InvoiceExpired");
      expect(late.args[0]).to.equal(a.due);
      await time.setNextBlockTimestamp(b.due);
      const onTime = await attempt(inv, payer, "pay", [b.id], { value: b.value, gasLimit: 300000n });
      expect(onTime.error).to.equal(null);
    });

    it("keeps the indexed fields the web pages filter on: Registered 3 topics, Paid 4, Cancelled 3", async function () {
      const { inv, merchant, payer } = await loadFixture(deployFixture);
      const { id, value } = await openInvoice(inv, merchant, { text: "topics-1" });
      const registered = (await ownLogs(inv, await (await inv.connect(merchant).register(refOf("topics-0"), 1n, BigInt((await time.latest()) + DAY))).wait()))[0];
      const regId = await inv.invoiceId(merchant.address, refOf("topics-0"));
      expect(registered.topics).to.have.length(3);
      expect(registered.topics[0]).to.equal(inv.interface.getEvent("InvoiceRegistered").topicHash);
      expect(registered.topics[1]).to.equal(regId);
      expect(registered.topics[2].toLowerCase()).to.equal(addressTopic(merchant.address));

      const paid = (await ownLogs(inv, await (await inv.connect(payer).pay(id, { value })).wait()))[0];
      expect(paid.topics).to.have.length(4);
      expect(paid.topics[0]).to.equal(inv.interface.getEvent("InvoicePaid").topicHash);
      expect(paid.topics[1]).to.equal(id);
      expect(paid.topics[2].toLowerCase()).to.equal(addressTopic(merchant.address));
      expect(paid.topics[3].toLowerCase()).to.equal(addressTopic(payer.address));

      const cancelled = (await ownLogs(inv, await (await inv.connect(merchant).cancel(regId)).wait()))[0];
      expect(cancelled.topics).to.have.length(3);
      expect(cancelled.topics[0]).to.equal(inv.interface.getEvent("InvoiceCancelled").topicHash);
      expect(cancelled.topics[1]).to.equal(regId);
      expect(cancelled.topics[2].toLowerCase()).to.equal(addressTopic(merchant.address));
    });

    it("emits the receipt before the payout: a registration made from the merchant's hook is logged after it", async function () {
      const { inv, payer } = await loadFixture(deployFixture);
      const m = await (await ethers.getContractFactory("TestMerchant")).deploy(await inv.getAddress());
      const referenceHash = refOf("log order");
      const id = await inv.invoiceId(await m.getAddress(), referenceHash);
      await (await m.register(referenceHash, USDC, BigInt((await time.latest()) + DAY))).wait();
      await (await m.setMode(2, id)).wait(); // Reenter
      const receipt = await (await inv.connect(payer).pay(id, { value: valueOf(USDC), gasLimit: 1_500_000 })).wait();
      const names = (await ownLogs(inv, receipt)).map((l) => inv.interface.parseLog(l).name);
      expect(names).to.deep.equal(["InvoicePaid", "InvoiceRegistered"]);
    });

    it("forwards all remaining gas: a merchant hook that needs about 66k gas succeeds under a 130k limit", async function () {
      const { inv, payer } = await loadFixture(deployFixture);
      const m = await (await ethers.getContractFactory("SstoreMerchant")).deploy();
      const referenceHash = refOf("sstore merchant");
      const id = await inv.invoiceId(await m.getAddress(), referenceHash);
      await (await m.register(await inv.getAddress(), referenceHash, USDC, BigInt((await time.latest()) + DAY))).wait();
      const result = await attempt(inv, payer, "pay", [id], { value: valueOf(USDC), gasLimit: 130000n });
      expect(result.error).to.equal(null);
      expect((await stateOf(inv, id)).status).to.equal(Status.Paid);
      expect(await m.a()).to.not.equal(0n);
    });

    it("settles a chain of nested payments: each merchant hook pays the next invoice with what it received", async function () {
      const { inv, merchant, payer } = await loadFixture(deployFixture);
      const factory = await ethers.getContractFactory("ChainMerchant");
      const m1 = await factory.deploy(await inv.getAddress());
      const m2 = await factory.deploy(await inv.getAddress());
      const due = BigInt((await time.latest()) + DAY);
      const amount = 4n * USDC;
      const value = valueOf(amount);
      const ids = [];
      for (const [name, owner] of [["n1", m1], ["n2", m2]]) {
        const referenceHash = refOf(name);
        ids.push(await inv.invoiceId(await owner.getAddress(), referenceHash));
        await (await owner.register(referenceHash, amount, due)).wait();
      }
      const last = await openInvoice(inv, merchant, { text: "n3", amount }); // paid to an ordinary account at the end
      ids.push(last.id);
      // m1 pays n2 and tries to replay and cancel itself; m2 pays n3 and tries the same
      await (await m1.set(ids[1], ids[0], ids[0])).wait();
      await (await m2.set(ids[2], ids[1], ids[1])).wait();

      await expect(mined(inv.connect(payer).pay(ids[0], { value, gasLimit: 3_000_000 }))).to.changeEtherBalances(
        [merchant, m1, m2, inv],
        [value, 0n, 0n, 0n]
      );
      for (const id of ids) expect((await stateOf(inv, id)).status).to.equal(Status.Paid);
      expect((await stateOf(inv, ids[0])).payer).to.equal(payer.address);
      expect((await stateOf(inv, ids[1])).payer).to.equal(await m1.getAddress());
      expect((await stateOf(inv, ids[2])).payer).to.equal(await m2.getAddress());
      expect(await m1.got()).to.equal(value);
      expect(await m2.got()).to.equal(value);
      expect(await m1.replayOk()).to.equal(false);
      expect(await m1.cancelOk()).to.equal(false);
      expect(await m2.replayOk()).to.equal(false);
      expect(await m2.cancelOk()).to.equal(false);
    });

    it("answers only TransferFailed, with no bubbled data, when the merchant reverts with a 100 kB payload", async function () {
      const { inv, payer } = await loadFixture(deployFixture);
      const m = await (await ethers.getContractFactory("TestMerchant")).deploy(await inv.getAddress());
      const referenceHash = refOf("revert bomb");
      const id = await inv.invoiceId(await m.getAddress(), referenceHash);
      await (await m.register(referenceHash, USDC, BigInt((await time.latest()) + DAY))).wait();
      await (await m.setMode(5, ethers.ZeroHash)).wait(); // RevertBomb
      const request = { from: payer.address, to: await inv.getAddress(), data: inv.interface.encodeFunctionData("pay", [id]), value: valueOf(USDC), gas: 1_000_000 };
      let data = null;
      try {
        await ethers.provider.call(request);
      } catch (e) {
        data = revertDataOf(e);
      }
      expect(data, "revert data").to.equal(inv.interface.getError("TransferFailed").selector); // exactly 4 bytes
      const result = await attempt(inv, payer, "pay", [id], { value: valueOf(USDC), gasLimit: 1_000_000n });
      expect(result.error).to.equal("TransferFailed");
    });

    it("pays the largest possible amount exactly: amount * 1e12 is never truncated", async function () {
      // Needs a balance of about 7.9e40 native units, far above any real USDC supply, so only Hardhat's node allows it.
      if (hre.network.name !== "hardhat") return this.skip();
      const { inv, merchant, payer } = await loadFixture(deployFixture);
      const value = MAX_UINT96 * SCALE; // about 7.9e40, wider than 128 bits
      await setBalance(payer.address, value + 10n ** 20n);
      const referenceHash = refOf("max amount");
      const id = await inv.invoiceId(merchant.address, referenceHash);
      await (await inv.connect(merchant).register(referenceHash, MAX_UINT96, MAX_UINT40)).wait();
      await expect(inv.connect(payer).pay(id, { value: value - 1n, gasLimit: 300000 })).to.be.reverted;
      const before = await ethers.provider.getBalance(merchant.address);
      const result = await attempt(inv, payer, "pay", [id], { value, gasLimit: 300000n });
      expect(result.error).to.equal(null);
      expect(await ethers.provider.getBalance(merchant.address)).to.equal(before + value);
      expect((await stateOf(inv, id)).status).to.equal(Status.Paid);
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  describe("gas", function () {
    it("stays small (informational numbers are printed; ceilings guard against regressions)", async function () {
      if (hre.__SOLIDITY_COVERAGE_RUNNING) return this.skip(); // instrumented code uses more gas
      const { inv, merchant, payer } = await loadFixture(deployFixture);
      const referenceHash = refOf("gas");
      const due = BigInt((await time.latest()) + DAY);
      const id = await inv.invoiceId(merchant.address, referenceHash);
      const reg = await (await inv.connect(merchant).register(referenceHash, 25n * USDC, due)).wait();
      const pay = await (await inv.connect(payer).pay(id, { value: valueOf(25n * USDC) })).wait();
      const ref2 = refOf("gas2");
      await (await inv.connect(merchant).register(ref2, 5n * USDC, due)).wait();
      const cancel = await (await inv.connect(merchant).cancel(await inv.invoiceId(merchant.address, ref2))).wait();
      const deployTx = inv.deploymentTransaction();
      const deploy = await deployTx.wait();
      console.log(
        `      gas: deploy ${deploy.gasUsed}, register ${reg.gasUsed}, pay ${pay.gasUsed}, cancel ${cancel.gasUsed}`
      );
      expect(deploy.gasUsed).to.be.lessThan(650_000n);
      expect(reg.gasUsed).to.be.lessThan(110_000n);
      expect(pay.gasUsed).to.be.lessThan(60_000n);
      expect(cancel.gasUsed).to.be.lessThan(40_000n);
    });
  });
});
