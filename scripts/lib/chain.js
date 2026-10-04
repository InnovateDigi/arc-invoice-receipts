"use strict";
// Small helpers shared by the deploy and scenario scripts.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..", "..");

// Arc facts used by the scripts (see README for sources).
const NETWORKS = {
  arcTestnet: { chainId: 5042002n, name: "Arc Testnet", explorer: "https://explorer.testnet.arc.io", testnet: true },
  arcMainnet: { chainId: 5042n, name: "Arc", explorer: "https://explorer.arc.io", testnet: false },
  hardhat: { chainId: 31337n, name: "Hardhat in-process", explorer: "", testnet: true },
  localhost: { chainId: 31337n, name: "Local node", explorer: "", testnet: true },
  arcAnvil: { chainId: 31337n, name: "arc-anvil (Arc Foundry local node)", explorer: "", testnet: true },
};
const MIN_MAX_FEE = ethers.parseUnits("20", "gwei"); // Arc silently drops transactions below this
const PRIORITY_FEE = ethers.parseUnits("1", "gwei");

/** Fee fields for every transaction: never below Arc's 20 gwei floor, with headroom over the current price. */
async function feeOverrides(provider) {
  let gasPrice = 0n;
  try {
    gasPrice = BigInt(await provider.send("eth_gasPrice", []));
  } catch (e) {
    gasPrice = MIN_MAX_FEE;
  }
  const doubled = gasPrice * 2n;
  const maxFeePerGas = doubled > MIN_MAX_FEE ? doubled : MIN_MAX_FEE;
  return { maxFeePerGas, maxPriorityFeePerGas: PRIORITY_FEE < maxFeePerGas ? PRIORITY_FEE : 0n };
}

function explorerTx(net, hash) {
  const base = (NETWORKS[net] || {}).explorer;
  return base ? `${base}/tx/${hash}` : "";
}
function explorerAddress(net, address) {
  const base = (NETWORKS[net] || {}).explorer;
  return base ? `${base}/address/${address}` : "";
}

/** USDC amount from a native (18-decimal) value, trimmed: 1250000000000000000 -> "1.25". */
function fmtNative(wei, maxDecimals = 8) {
  const s = ethers.formatUnits(wei, 18);
  const [i, f = ""] = s.split(".");
  const frac = f.slice(0, maxDecimals).replace(/0+$/, "");
  return frac ? `${i}.${frac}` : i;
}

/** 6-decimal USDC units as text with at least two decimals: 1250000 -> "1.25", 50000 -> "0.05", 3000000 -> "3.00". */
function fmt6(units) {
  const [i, f = ""] = ethers.formatUnits(units, 6).split(".");
  let frac = f.replace(/0+$/, "");
  while (frac.length < 2) frac += "0";
  return `${i}.${frac}`;
}

function deploymentFile(net) {
  return path.join(ROOT, "deployments", `${net}.json`);
}
function loadDeployment(net) {
  const f = deploymentFile(net);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { ROOT, NETWORKS, MIN_MAX_FEE, PRIORITY_FEE, feeOverrides, explorerTx, explorerAddress, fmtNative, fmt6, deploymentFile, loadDeployment, sleep };
