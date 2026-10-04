"use strict";
// Writes the Solidity "standard JSON input" for InvoiceReceipts, for explorers whose verification API is not reachable
// from scripts (Arc mainnet's explorer sits behind a bot check): upload this file on the explorer's "Verify & publish"
// page, method "Solidity (Standard JSON input)".
//   npx hardhat run scripts/export-standard-json.js        -> deployments/verification/InvoiceReceipts.standard-input.json
// The input contains only contracts/InvoiceReceipts.sol and the exact compiler settings used for the deployment.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ROOT } = require("./lib/chain");

async function main() {
  await hre.run("compile");
  const info = await hre.artifacts.getBuildInfo("contracts/InvoiceReceipts.sol:InvoiceReceipts");
  if (!info) throw new Error("No build info; run `npm run compile` first");
  const key = "contracts/InvoiceReceipts.sol";
  const input = {
    language: "Solidity",
    sources: { [key]: { content: info.input.sources[key].content } },
    settings: {
      optimizer: info.input.settings.optimizer,
      evmVersion: info.input.settings.evmVersion,
      outputSelection: { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata"] } },
    },
  };
  const dir = path.join(ROOT, "deployments", "verification");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "InvoiceReceipts.standard-input.json");
  fs.writeFileSync(file, JSON.stringify(input, null, 2) + "\n");
  console.log(`wrote ${path.relative(ROOT, file)}`);
  console.log(`Contract name:     contracts/InvoiceReceipts.sol:InvoiceReceipts (or just InvoiceReceipts)`);
  console.log(`Compiler:          v${info.solcLongVersion}`);
  console.log(`EVM version:       ${input.settings.evmVersion}`);
  console.log(`Optimizer:         ${input.settings.optimizer.enabled ? "enabled" : "disabled"}, ${input.settings.optimizer.runs} runs`);
  console.log(`Constructor args:  none`);
  console.log(`Licence:           MIT`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
