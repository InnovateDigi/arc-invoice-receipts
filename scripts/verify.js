"use strict";
// Publishes the contract source on the Arc explorer (Blockscout) and records the result in deployments/<network>.json.
//   npx hardhat run scripts/verify.js --network arcTestnet        (address from deployments/arcTestnet.json)
//   CONTRACT=0x... npx hardhat run scripts/verify.js --network arcMainnet
// Needs no key. Exit code 1 if the explorer refused it; the contract works either way.
const fs = require("fs");
const hre = require("hardhat");
const { network } = hre;
const { loadDeployment, deploymentFile, explorerAddress } = require("./lib/chain");

async function main() {
  const net = network.name;
  const record = loadDeployment(net);
  const address = process.env.CONTRACT || (record && record.address);
  if (!address) throw new Error(`No address: set CONTRACT=0x... or create deployments/${net}.json`);

  let verified = false;
  try {
    await hre.run("verify:verify", {
      address,
      constructorArguments: [],
      contract: "contracts/InvoiceReceipts.sol:InvoiceReceipts",
    });
    verified = true;
  } catch (e) {
    if (/already verified/i.test(String(e.message))) verified = true;
    else {
      console.error("Verification failed:", String(e.message).split("\n")[0]);
      console.error("If the explorer's API refuses scripts (Arc mainnet's explorer sits behind a bot check), verify by hand:");
      console.error("  npm run verify:json   then upload deployments/verification/InvoiceReceipts.standard-input.json on the");
      console.error("  explorer's 'Verify & publish' page (Solidity, Standard JSON input, compiler v0.8.28+commit.7893614a).");
    }
  }
  if (verified) {
    const link = `${explorerAddress(net, address)}?tab=contract`;
    console.log(`Source verified: ${link}`);
    if (record) {
      record.verified = link;
      fs.writeFileSync(deploymentFile(net), JSON.stringify(record, null, 2) + "\n");
    }
  }
  process.exitCode = verified ? 0 : 1;
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
