#!/usr/bin/env node
'use strict';
/*
 * Deploys InvoiceReceipts to the LOCAL hardhat node (http://127.0.0.1:8545, chainId 31337) with account #0.
 * Prints one JSON line {address, deployBlock, chainId} and writes it to e2e/.local-deployment.json.
 *
 *   node e2e/deploy-local.js            deploy only
 *   node e2e/deploy-local.js --write    deploy, then put address/block into the `local` entry of web/js/deployments.js
 *   node e2e/deploy-local.js --restore  no deployment: reset that entry to  local: { contract: "", deployBlock: 0 }
 */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const RPC = 'http://127.0.0.1:8545';
const ROOT = path.resolve(__dirname, '..');
const DEPLOYMENTS_JS = path.join(ROOT, 'web', 'js', 'deployments.js');
const OUT = path.join(__dirname, '.local-deployment.json');
const LOCAL_SRC = 'local:\\s*\\{\\s*contract:\\s*"[^"]*"\\s*,\\s*deployBlock:\\s*\\d+\\s*\\}';

// Replaces ONLY the `local: { contract: "...", deployBlock: N }` text; every other byte of the file is kept.
function patchDeployments(address, block) {
  const src = fs.readFileSync(DEPLOYMENTS_JS, 'utf8');
  const hits = src.match(new RegExp(LOCAL_SRC, 'g'));
  if (!hits || hits.length !== 1) throw new Error('expected exactly one local entry in ' + DEPLOYMENTS_JS + ', found ' + (hits ? hits.length : 0));
  const next = src.replace(new RegExp(LOCAL_SRC), () => 'local: { contract: "' + address + '", deployBlock: ' + block + ' }');
  if (next !== src) fs.writeFileSync(DEPLOYMENTS_JS, next);
}

async function main() {
  const flags = process.argv.slice(2);
  if (flags.includes('--restore')) {
    patchDeployments('', 0);
    console.log(JSON.stringify({ restored: true, file: DEPLOYMENTS_JS }));
    return;
  }
  const net = ethers.Network.from(31337);
  const provider = new ethers.JsonRpcProvider(RPC, net, { staticNetwork: net, cacheTimeout: -1, batchMaxCount: 1, pollingInterval: 50 });
  try {
    const chainId = Number(await provider.send('eth_chainId', []));
    if (chainId !== 31337) throw new Error('expected chainId 31337 on ' + RPC + ', got ' + chainId);
    const art = require('../artifacts/contracts/InvoiceReceipts.sol/InvoiceReceipts.json');
    const signer = await provider.getSigner(0);
    const factory = new ethers.ContractFactory(art.abi, art.bytecode, signer);
    const contract = await factory.deploy();
    const receipt = await contract.deploymentTransaction().wait();
    await contract.waitForDeployment();
    const address = await contract.getAddress();
    if ((await provider.getCode(address)).length <= 2) throw new Error('no code at ' + address + ' after deployment');
    const out = { address, deployBlock: receipt.blockNumber, chainId };
    fs.writeFileSync(OUT, JSON.stringify(out) + '\n');
    if (flags.includes('--write')) patchDeployments(address, out.deployBlock);
    console.log(JSON.stringify(out));
  } finally {
    provider.destroy();
  }
}

main().catch((e) => {
  console.error('deploy-local failed: ' + (e && (e.shortMessage || e.message) || e));
  process.exitCode = 1;
});
