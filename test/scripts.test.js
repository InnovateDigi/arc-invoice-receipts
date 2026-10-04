"use strict";
// Tests for the helper scripts: key loading (must never need or print a real key) and web config generation.
const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { loadKey } = require("../scripts/lib/key");
const { render, build } = require("../scripts/write-web-config");
const { feeOverrides, fmtNative, fmt6, NETWORKS, MIN_MAX_FEE } = require("../scripts/lib/chain");
const { renderMarkdown } = require("../scripts/lib/report");

// Hardhat's public test key: worthless, used only to exercise the parser.
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

describe("scripts", function () {
  describe("key loader", function () {
    let dir;
    const saved = { PRIVATE_KEY: process.env.PRIVATE_KEY, DEPLOYER_KEY_FILE: process.env.DEPLOYER_KEY_FILE };
    beforeEach(function () {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "keytest-"));
      delete process.env.PRIVATE_KEY;
      delete process.env.DEPLOYER_KEY_FILE;
    });
    afterEach(function () {
      fs.rmSync(dir, { recursive: true, force: true });
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
    const write = (name, text) => {
      const f = path.join(dir, name);
      fs.writeFileSync(f, text);
      return f;
    };

    it("returns null when nothing is configured", function () {
      expect(loadKey()).to.equal(null);
    });
    it("reads PRIVATE_KEY, with or without 0x", function () {
      process.env.PRIVATE_KEY = KEY;
      expect(loadKey()).to.equal(KEY);
      process.env.PRIVATE_KEY = KEY.slice(2);
      expect(loadKey()).to.equal(KEY);
    });
    it("reads a file holding the bare hex key", function () {
      process.env.DEPLOYER_KEY_FILE = write("bare", KEY + "\n");
      expect(loadKey()).to.equal(KEY);
    });
    it("reads JSON with a privateKey field, also nested", function () {
      process.env.DEPLOYER_KEY_FILE = write("flat.json", JSON.stringify({ address: "0x1", privateKey: KEY }));
      expect(loadKey()).to.equal(KEY);
      process.env.DEPLOYER_KEY_FILE = write("nested.json", JSON.stringify({ wallet: { private_key: KEY.slice(2) } }));
      expect(loadKey()).to.equal(KEY);
    });
    it("fails with a message that does not contain the file contents", function () {
      process.env.DEPLOYER_KEY_FILE = write("bad.json", JSON.stringify({ hello: "world", secretish: "not a key" }));
      let message = "";
      try {
        loadKey();
      } catch (e) {
        message = e.message;
      }
      expect(message).to.match(/no recognisable private key/);
      expect(message).to.not.include("not a key");
      process.env.DEPLOYER_KEY_FILE = write("junk", "not json at all");
      expect(() => loadKey()).to.throw(/neither a hex key nor JSON/);
    });
  });

  describe("web config generator", function () {
    it("renders a file that defines window.ArcInvoiceDeployments in a browser and exports in Node", function () {
      const text = render({ arcTestnet: { contract: "0xabc", deployBlock: 7 }, arcMainnet: { contract: "", deployBlock: 0 }, local: { contract: "", deployBlock: 0 } });
      const win = {};
      vm.runInNewContext(text, { window: win });
      expect(win.ArcInvoiceDeployments.arcTestnet).to.deep.equal({ contract: "0xabc", deployBlock: 7 });
      const mod = { exports: {} };
      vm.runInNewContext(text, { module: mod, window: undefined });
      expect(mod.exports.arcTestnet.contract).to.equal("0xabc");
    });
    it("builds an entry for every network even when nothing is deployed", function () {
      const built = build();
      expect(Object.keys(built)).to.deep.equal(["arcTestnet", "arcMainnet", "local"]);
      for (const entry of Object.values(built)) {
        expect(entry).to.have.all.keys("contract", "deployBlock");
      }
    });
  });

  describe("chain helpers", function () {
    it("never sets a max fee below Arc's 20 gwei floor", async function () {
      const lowProvider = { send: async () => "0x3b9aca00" }; // 1 gwei
      expect((await feeOverrides(lowProvider)).maxFeePerGas).to.equal(MIN_MAX_FEE);
      const failing = { send: async () => { throw new Error("rpc down"); } };
      expect((await feeOverrides(failing)).maxFeePerGas).to.equal(MIN_MAX_FEE * 2n); // unknown price: twice the floor
      const high = { send: async () => "0x" + (50_000_000_000n).toString(16) }; // 50 gwei
      expect((await feeOverrides(high)).maxFeePerGas).to.equal(100_000_000_000n);
    });
    it("formats native amounts as USDC", function () {
      expect(fmtNative(1_250_000_000_000_000_000n)).to.equal("1.25");
      expect(fmtNative(0n)).to.equal("0");
      expect(fmtNative(11_546_600_000_000_000n, 6)).to.equal("0.011546");
    });
  });

  describe("evidence report (TESTNET.md / MAINNET.md)", function () {
    const hash = (c) => "0x" + c.repeat(32);
    const fake = (priceA) => ({
      deployment: { address: "0x1111111111111111111111111111111111111111", txHash: hash("ab"), blockNumber: 123, gasUsed: "577330", feeUSDC: "0.01212393", verified: "https://explorer.example/address/0x1?tab=contract" },
      result: {
        ranAt: "2026-10-05T00:00:00.000Z",
        merchant: "0x2222222222222222222222222222222222222222",
        payer: "0x3333333333333333333333333333333333333333",
        prices: { A: String(priceA), B: "20000", C: "10000" },
        merchantReceivedOnPay: String(BigInt(priceA) * 10n ** 12n),
        eventCounts: { InvoiceRegistered: 3, InvoicePaid: 1, InvoiceCancelled: 1 },
        invoices: { A: { status: "Paid" }, B: { status: "Cancelled" }, C: { status: "Open" } },
        totalGasUsed: "477352",
        totalFeeNative: "10024390000000000",
        steps: [
          { n: 1, title: `Merchant registers invoice A (${fmt6(BigInt(priceA))} USDC, due in 1 hour)`, outcome: "success", hash: hash("01"), gasUsed: "92655", feeNative: "1945755000000000" },
          { n: 2, title: "Payer pays invoice A in full: x", outcome: "success", hash: hash("02"), gasUsed: "46791", feeNative: "982611000000000" },
          { n: 3, title: "Payer tries to pay invoice A again", outcome: "reverted: AlreadyPaid", hash: hash("03"), gasUsed: "24142", feeNative: "506982000000000" },
          { n: 4, title: "Merchant cancels invoice B", outcome: "success", hash: hash("04"), gasUsed: "29175", feeNative: "612675000000000" },
        ],
      },
    });

    it("formats 6-decimal amounts with at least two decimals", function () {
      expect(fmt6(1_250_000n)).to.equal("1.25");
      expect(fmt6(50_000n)).to.equal("0.05");
      expect(fmt6(3_000_000n)).to.equal("3.00");
      expect(fmt6(10_000n)).to.equal("0.01");
    });
    it("renders the testnet report with explorer links and an estimate for mainnet", function () {
      const { deployment, result } = fake(1_250_000);
      const md = renderMarkdown({ net: "arcTestnet", known: NETWORKS.arcTestnet, deployment, result, price: 20_000_000_001n });
      expect(md).to.include("# Arc Testnet evidence");
      expect(md).to.include("npm run scenario:testnet");
      expect(md).to.include(`https://explorer.testnet.arc.io/tx/${hash("01")}`);
      expect(md).to.include("the payer attached 1.25 USDC");
      expect(md).to.include("## Estimated cost on Arc mainnet");
      expect(md).to.include("| Deploy the contract (once) | 577330 | 0.011546");
      expect(md).to.include("[source on the explorer](https://explorer.example/address/0x1?tab=contract)");
      expect(md).to.not.include("undefined");
    });
    it("renders the mainnet report with actual costs and the small amounts", function () {
      const { deployment, result } = fake(50_000);
      const md = renderMarkdown({ net: "arcMainnet", known: NETWORKS.arcMainnet, deployment, result, price: null });
      expect(md).to.include("# Arc mainnet evidence");
      expect(md).to.include("npm run scenario:mainnet");
      expect(md).to.include(`https://explorer.arc.io/tx/${hash("02")}`);
      expect(md).to.include("the payer attached 0.05 USDC");
      expect(md).to.include("## Actual cost on Arc mainnet");
      expect(md).to.not.include("Estimated cost");
      expect(md).to.not.include("undefined");
    });
  });
});
