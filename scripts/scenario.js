"use strict";
// Scripted scenario on a deployed InvoiceReceipts: every rule is exercised with real transactions and the
// transaction hashes are written to TESTNET.md (Arc Testnet) or MAINNET.md (Arc mainnet) and to
// deployments/scenario-<network>.json.
//
//   DEPLOYER_KEY_FILE=/path/to/key.json npx hardhat run scripts/scenario.js --network arcTestnet
//   CONFIRM_MAINNET=yes DEPLOYER_KEY_FILE=/path/to/key.json npx hardhat run scripts/scenario.js --network arcMainnet
//
// The deployer is the merchant. The payer is a throw-away wallet whose key is kept OUTSIDE this repository
// (default ../_invoice_scenario/payer-<network>.json, override with SCENARIO_PAYER_FILE). It is funded by the merchant
// (2 USDC on testnet; 0.15 USDC on mainnet, where the invoices are small: 0.05, 0.02 and 0.01 USDC) and swept back at
// the end. Failed attempts are sent with an explicit gas limit so that they are mined and have a transaction hash,
// exactly as a real user's failed attempt would.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers, network } = hre;
const { ROOT, NETWORKS, feeOverrides, fmtNative, fmt6, loadDeployment, sleep } = require("./lib/chain");
const { renderMarkdown } = require("./lib/report");

const USDC = 1_000_000n; // 6-decimal units
const SCALE = 10n ** 12n;
const MAINNET_RPC = process.env.ARC_MAINNET_RPC_URL || "https://rpc.mainnet.arc.io";
const PAYER_FILE = process.env.SCENARIO_PAYER_FILE || path.join(ROOT, "..", "_invoice_scenario", `payer-${network.name}.json`);
const SMALL = network.name === "arcMainnet" || process.env.SCENARIO_SMALL === "1"; // real money: small invoices
const LOCAL = ["hardhat", "localhost", "arcAnvil"].includes(network.name); // throw-away dev nodes with unlocked accounts

const steps = [];
let inv; // contract bound to the merchant
let iface;

function nowIso() {
  return new Date().toISOString();
}

function reasonFrom(e) {
  const data = (e && (e.data || (e.error && e.error.data) || (e.info && e.info.error && e.info.error.data))) || null;
  const hex = typeof data === "string" ? data : data && data.data;
  if (hex && typeof hex === "string" && hex.length >= 10) {
    try {
      const parsed = iface.parseError(hex);
      if (parsed) return parsed.args.length ? `${parsed.name}(${parsed.args.join(", ")})` : parsed.name;
    } catch (_) {}
  }
  return null;
}

/** Sends one transaction and records it. `expectRevert` is the custom error the contract must answer with. */
async function run(signer, title, req, { expectRevert = null, note = "" } = {}) {
  const fees = await feeOverrides(ethers.provider);
  const from = await signer.getAddress();
  let simulated = null;
  try {
    await ethers.provider.call({ ...req, from });
  } catch (e) {
    simulated = reasonFrom(e) || "reverted";
  }
  if (expectRevert && !(simulated && simulated.startsWith(expectRevert))) {
    throw new Error(`${title}: expected ${expectRevert} but simulation said ${simulated || "success"}`);
  }
  if (!expectRevert && simulated) throw new Error(`${title}: expected success but simulation said ${simulated}`);

  const tx = { ...req, ...fees, gasLimit: req.gasLimit || 250000n };
  let hash, receipt;
  try {
    const sent = await signer.sendTransaction(tx);
    hash = sent.hash;
    receipt = await sent.wait();
  } catch (e) {
    if (e.receipt) {
      receipt = e.receipt; // mined with status 0
      hash = receipt.hash;
    } else if (expectRevert && LOCAL) {
      // Hardhat's automine throws for a failing transaction instead of returning a receipt
      steps.push({ n: steps.length + 1, title, outcome: `reverted: ${simulated}`, ok: true, hash: "(local node: no receipt)", note });
      console.log(`  ${steps.length}. ${title} -> reverted: ${simulated}`);
      return null;
    } else {
      throw e;
    }
  }
  const mined = receipt.status === 1;
  if (expectRevert && mined) throw new Error(`${title}: expected a revert but the transaction succeeded (${hash})`);
  if (!expectRevert && !mined) throw new Error(`${title}: expected success but the transaction failed (${hash})`);
  const fee = receipt.gasUsed * receipt.gasPrice;
  steps.push({
    n: steps.length + 1,
    title,
    outcome: mined ? "success" : `reverted: ${simulated}`,
    ok: true,
    hash,
    block: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    feeNative: fee.toString(),
    note,
  });
  console.log(`  ${steps.length}. ${title} -> ${mined ? "success" : "reverted: " + simulated} (${hash})`);
  await sleep(LOCAL ? 0 : 400); // let the load-balanced RPC catch up
  return receipt;
}

async function chainTime() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}

async function main() {
  const net = network.name;
  const known = NETWORKS[net];
  if (!known) throw new Error(`Unsupported network ${net}`);
  if (net === "arcMainnet" && process.env.CONFIRM_MAINNET !== "yes") {
    throw new Error("This is MAINNET and spends real USDC (about 0.011 USDC in fees; 0.15 USDC moves to a throw-away wallet and is swept back). Re-run with CONFIRM_MAINNET=yes.");
  }
  const [deployerSigner, localPayer] = await ethers.getSigners();
  if (!deployerSigner) throw new Error("No deployer key. Set PRIVATE_KEY or DEPLOYER_KEY_FILE.");
  const merchant = new ethers.NonceManager(deployerSigner);
  const merchantAddress = deployerSigner.address;

  // the contract under test
  let deployment = loadDeployment(net);
  if (!deployment && LOCAL) {
    const c = await (await ethers.getContractFactory("InvoiceReceipts")).deploy();
    await c.waitForDeployment();
    const rc = await c.deploymentTransaction().wait();
    deployment = {
      network: net,
      chainId: Number(known.chainId),
      address: await c.getAddress(),
      txHash: c.deploymentTransaction().hash,
      blockNumber: rc.blockNumber,
      gasUsed: rc.gasUsed.toString(),
      effectiveGasPrice: rc.gasPrice.toString(),
      feeUSDC: fmtNative(rc.gasUsed * rc.gasPrice, 10),
    };
  }
  if (!deployment) throw new Error(`No deployments/${net}.json. Run the deploy script first.`);
  const contractAddress = deployment.address;
  const artifact = await hre.artifacts.readArtifact("InvoiceReceipts");
  iface = new ethers.Interface(artifact.abi);
  inv = new ethers.Contract(contractAddress, artifact.abi, ethers.provider);
  const code = await ethers.provider.getCode(contractAddress);
  if (code === "0x") throw new Error(`No contract code at ${contractAddress} on ${net}`);

  console.log(`Scenario on ${known.name}, contract ${contractAddress}`);
  console.log(`Merchant (deployer): ${merchantAddress}`);

  // the payer
  let payerWallet;
  if (LOCAL) {
    payerWallet = localPayer;
  } else {
    let key;
    if (fs.existsSync(PAYER_FILE)) {
      key = JSON.parse(fs.readFileSync(PAYER_FILE, "utf8")).privateKey;
    } else {
      key = ethers.Wallet.createRandom().privateKey;
      fs.mkdirSync(path.dirname(PAYER_FILE), { recursive: true, mode: 0o700 });
      fs.writeFileSync(PAYER_FILE, JSON.stringify({ note: "throw-away testnet payer for the invoice scenario", privateKey: key }) + "\n", { mode: 0o600 });
    }
    payerWallet = new ethers.Wallet(key, ethers.provider);
  }
  const payer = new ethers.NonceManager(payerWallet);
  const payerAddress = payerWallet.address;
  console.log(`Payer (throw-away):  ${payerAddress}`);

  const fees = await feeOverrides(ethers.provider);
  const need = SMALL ? 150_000_000_000_000_000n : 2n * 10n ** 18n; // native units: 0.15 or 2 USDC
  const payerBalance = await ethers.provider.getBalance(payerAddress);
  const startBalances = {};
  if (payerBalance < need && !LOCAL) {
    const merchantBalance = await ethers.provider.getBalance(merchantAddress);
    const reserve = SMALL ? 40_000_000_000_000_000n : 10n ** 17n; // fees for the merchant's own transactions
    if (merchantBalance < need + reserve) {
      throw new Error(`Merchant ${merchantAddress} has ${fmtNative(merchantBalance)} USDC; needs about ${fmtNative(need + reserve)} to run the scenario.`);
    }
    const r = await (await merchant.sendTransaction({ to: payerAddress, value: need - payerBalance, gasLimit: 21000n, ...fees })).wait();
    console.log(`  funded payer with ${fmtNative(need - payerBalance)} USDC (${r.hash})`);
    await sleep(500);
  }
  startBalances.merchant = await ethers.provider.getBalance(merchantAddress);
  startBalances.payer = await ethers.provider.getBalance(payerAddress);

  const call = (fn, args, value = 0n) => ({ to: contractAddress, data: iface.encodeFunctionData(fn, args), value });
  const stamp = Date.now().toString(36);
  const refA = ethers.id(`scenario-A-${stamp}`);
  const refB = ethers.id(`scenario-B-${stamp}`);
  const refC = ethers.id(`scenario-C-${stamp}`);
  const idA = await inv.invoiceId(merchantAddress, refA);
  const idB = await inv.invoiceId(merchantAddress, refB);
  const idC = await inv.invoiceId(merchantAddress, refC);
  const priceA = SMALL ? 50_000n : 1_250_000n; // 0.05 or 1.25 USDC
  const priceB = SMALL ? 20_000n : 500_000n; // 0.02 or 0.50 USDC
  const priceC = SMALL ? 10_000n : 100_000n; // 0.01 or 0.10 USDC

  console.log("Steps:");
  // 1-2. create and pay
  let t = await chainTime();
  await run(merchant, `Merchant registers invoice A (${fmt6(priceA)} USDC, due in 1 hour)`, call("register", [refA, priceA, t + 3600]), {
    note: `id ${idA}`,
  });
  const merchantBeforePay = await ethers.provider.getBalance(merchantAddress);
  const payReceipt = await run(payer, `Payer pays invoice A in full: ${fmt6(priceA)} USDC attached to the pay() call`, call("pay", [idA], priceA * SCALE), {
    note: "USDC goes straight to the merchant; receipt event InvoicePaid",
  });
  const merchantAfterPay = await ethers.provider.getBalance(merchantAddress);
  const received = merchantAfterPay - merchantBeforePay;
  if (received !== priceA * SCALE) throw new Error(`Merchant received ${received}, expected ${priceA * SCALE}`);
  const contractBalance = await ethers.provider.getBalance(contractAddress);
  console.log(`  merchant received ${fmtNative(received)} USDC in that transaction; contract balance ${fmtNative(contractBalance)}`);
  let receiptEvent = null;
  if (payReceipt) {
    for (const log of payReceipt.logs) {
      if (log.address.toLowerCase() !== contractAddress.toLowerCase()) continue;
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === "InvoicePaid") {
        receiptEvent = { id: parsed.args.id, merchant: parsed.args.merchant, payer: parsed.args.payer, amount: parsed.args.amount.toString(), paidAt: Number(parsed.args.paidAt) };
      }
    }
    if (!receiptEvent || receiptEvent.payer !== payerAddress || receiptEvent.merchant !== merchantAddress || receiptEvent.id !== idA) {
      throw new Error("Receipt event missing or wrong");
    }
  }
  const paidState = await inv.getInvoice(idA);
  if (Number(paidState.status) !== 2 || paidState.payer !== payerAddress) throw new Error("Invoice A is not recorded as paid by the payer");

  // 3. double payment
  await run(payer, "Payer tries to pay invoice A again", call("pay", [idA], priceA * SCALE), {
    expectRevert: "AlreadyPaid",
    note: "double payment impossible; the failed attempt costs only gas",
  });

  // 4-6. partial payment, stranger cancel, cancel, pay cancelled
  t = await chainTime();
  await run(merchant, `Merchant registers invoice B (${fmt6(priceB)} USDC, due in 1 hour)`, call("register", [refB, priceB, t + 3600]), { note: `id ${idB}` });
  await run(payer, `Payer tries to pay only half of invoice B (${fmt6(priceB / 2n)} USDC)`, call("pay", [idB], (priceB / 2n) * SCALE), {
    expectRevert: "WrongAmount",
    note: "partial payment impossible",
  });
  await run(payer, "Payer (not the merchant) tries to cancel invoice B", call("cancel", [idB]), {
    expectRevert: "NotMerchant",
    note: "only the merchant can cancel",
  });
  await run(merchant, "Merchant cancels invoice B", call("cancel", [idB]), { note: "event InvoiceCancelled" });
  await run(payer, "Payer tries to pay the cancelled invoice B in full", call("pay", [idB], priceB * SCALE), {
    expectRevert: "AlreadyCancelled",
    note: "payment after cancellation impossible",
  });

  // 7-8. expiry
  t = await chainTime();
  const dueC = t + 20;
  await run(merchant, `Merchant registers invoice C (${fmt6(priceC)} USDC, due in 20 seconds)`, call("register", [refC, priceC, dueC]), { note: `id ${idC}` });
  if (LOCAL) {
    await network.provider.send("evm_increaseTime", [30]);
    await network.provider.send("evm_mine");
  } else {
    process.stdout.write("  waiting for invoice C to pass its due time");
    while ((await chainTime()) <= dueC) {
      await sleep(2000);
      process.stdout.write(".");
    }
    process.stdout.write("\n");
  }
  await run(payer, "Payer tries to pay invoice C after its due time", call("pay", [idC], priceC * SCALE), {
    expectRevert: "InvoiceExpired",
    note: "payment after the due time impossible",
  });

  // final state
  const finalState = {};
  for (const [name, id] of [["A", idA], ["B", idB], ["C", idC]]) {
    const s = await inv.getInvoice(id);
    finalState[name] = { id, status: ["None", "Open", "Paid", "Cancelled"][Number(s.status)], amount: s.amount.toString(), due: Number(s.due), payer: s.payer, paidAt: Number(s.paidAt) };
  }
  const expected = { A: "Paid", B: "Cancelled", C: "Open" };
  for (const k of Object.keys(expected)) if (finalState[k].status !== expected[k]) throw new Error(`Invoice ${k} ends ${finalState[k].status}, expected ${expected[k]}`);
  const finalContractBalance = await ethers.provider.getBalance(contractAddress);
  if (finalContractBalance !== 0n) throw new Error("Contract holds a balance");

  // sweep the payer's leftovers back to the merchant
  let swept = 0n;
  if (!LOCAL) {
    const bal = await ethers.provider.getBalance(payerAddress);
    const reserve = 21000n * fees.maxFeePerGas;
    if (bal > reserve) {
      swept = bal - reserve;
      const r = await (await payer.sendTransaction({ to: merchantAddress, value: swept, gasLimit: 21000n, ...fees })).wait();
      console.log(`  swept ${fmtNative(swept)} USDC back to the merchant (${r.hash})`);
    }
  }

  const endBalances = { merchant: await ethers.provider.getBalance(merchantAddress), payer: await ethers.provider.getBalance(payerAddress) };

  // events as a wallet or the receipts page would see them
  const fromBlock = Number(deployment.blockNumber);
  const logs = await ethers.provider.getLogs({ address: contractAddress, fromBlock, toBlock: "latest" });
  const counts = {};
  for (const l of logs) {
    const p = iface.parseLog(l);
    if (p) counts[p.name] = (counts[p.name] || 0) + 1;
  }

  const totalGas = steps.reduce((a, s) => a + BigInt(s.gasUsed || 0), 0n);
  const totalFee = steps.reduce((a, s) => a + BigInt(s.feeNative || 0), 0n);
  const result = {
    network: net,
    chainId: Number(known.chainId),
    contract: contractAddress,
    ranAt: nowIso(),
    merchant: merchantAddress,
    payer: payerAddress,
    prices: { A: priceA.toString(), B: priceB.toString(), C: priceC.toString() },
    invoices: finalState,
    receiptEvent,
    merchantReceivedOnPay: received.toString(),
    eventCounts: counts,
    steps,
    totalGasUsed: totalGas.toString(),
    totalFeeNative: totalFee.toString(),
    balances: { start: { merchant: startBalances.merchant.toString(), payer: startBalances.payer.toString() }, end: { merchant: endBalances.merchant.toString(), payer: endBalances.payer.toString() } },
  };
  fs.mkdirSync(path.join(ROOT, "deployments"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "deployments", `scenario-${net}.json`), JSON.stringify(result, null, 2) + "\n");
  console.log("Event counts on chain:", JSON.stringify(counts));
  console.log(`Scenario OK: ${steps.length} transactions, ${totalGas} gas, ${fmtNative(totalFee, 8)} USDC in fees.`);

  const outMd = process.env.OUT_MD || (net === "arcTestnet" ? path.join(ROOT, "TESTNET.md") : net === "arcMainnet" ? path.join(ROOT, "MAINNET.md") : null);
  if (outMd) {
    const md = renderMarkdown({ net, known, deployment, result, price: await mainnetPrice() });
    fs.writeFileSync(outMd, md);
    console.log("wrote", path.relative(ROOT, outMd));
  }
}

async function mainnetPrice() {
  try {
    const p = new ethers.JsonRpcProvider(MAINNET_RPC, undefined, { staticNetwork: true });
    return BigInt(await p.send("eth_gasPrice", []));
  } catch (e) {
    return null;
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
