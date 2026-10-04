"use strict";
// Deploys InvoiceReceipts and records the result in deployments/<network>.json (and web/js/deployments.js).
//
//   Testnet:  DEPLOYER_KEY_FILE=/path/to/key.json npx hardhat run scripts/deploy.js --network arcTestnet
//   Mainnet:  CONFIRM_MAINNET=yes DEPLOYER_KEY_FILE=/path/to/key.json npx hardhat run scripts/deploy.js --network arcMainnet
//   Estimate only (sends nothing):  DRY_RUN=1 ... npx hardhat run scripts/deploy.js --network arcMainnet
//
// The key is read from PRIVATE_KEY or DEPLOYER_KEY_FILE (see scripts/lib/key.js) and is never printed.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers, network, artifacts } = hre;
const { NETWORKS, feeOverrides, explorerTx, explorerAddress, fmtNative, deploymentFile } = require("./lib/chain");

async function main() {
  const net = network.name;
  const known = NETWORKS[net];
  if (!known) throw new Error(`Unsupported network "${net}". Use arcTestnet, arcMainnet, localhost or hardhat.`);

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer key. Set PRIVATE_KEY or DEPLOYER_KEY_FILE.");
  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (chainId !== known.chainId) throw new Error(`Connected to chain ${chainId}, expected ${known.chainId} for ${net}.`);
  if (net === "arcMainnet" && process.env.CONFIRM_MAINNET !== "yes" && process.env.DRY_RUN !== "1") {
    throw new Error("This is MAINNET and costs real USDC. Re-run with CONFIRM_MAINNET=yes (or DRY_RUN=1 to only estimate).");
  }

  const Factory = await ethers.getContractFactory("InvoiceReceipts");
  const deployTx = await Factory.getDeployTransaction();
  const fees = await feeOverrides(ethers.provider);
  const gasEstimate = await ethers.provider.estimateGas({ ...deployTx, from: deployer.address });
  const worstCase = gasEstimate * fees.maxFeePerGas;
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log(`Network:   ${known.name} (chain ${chainId})`);
  console.log(`Deployer:  ${deployer.address}`);
  console.log(`Balance:   ${fmtNative(balance)} USDC`);
  console.log(`Gas est.:  ${gasEstimate} at max fee ${ethers.formatUnits(fees.maxFeePerGas, "gwei")} gwei => at most ${fmtNative(worstCase)} USDC`);
  if (process.env.DRY_RUN === "1") {
    console.log("DRY_RUN=1: nothing was sent.");
    return;
  }
  if (balance < worstCase) throw new Error(`Balance too low: need about ${fmtNative(worstCase)} USDC for gas, have ${fmtNative(balance)}.`);

  const contract = await Factory.deploy({ ...fees });
  const tx = contract.deploymentTransaction();
  console.log(`Deploy tx: ${tx.hash}`);
  const receipt = await tx.wait(1);
  const address = await contract.getAddress();

  // The runtime code on chain must be exactly what we compiled (the contract has no immutables or constructor arguments).
  const onChain = await ethers.provider.getCode(address);
  const artifact = await artifacts.readArtifact("InvoiceReceipts");
  if (onChain.toLowerCase() !== artifact.deployedBytecode.toLowerCase()) throw new Error("On-chain code differs from the compiled artifact.");

  const block = await ethers.provider.getBlock(receipt.blockNumber);
  const buildInfo = await artifacts.getBuildInfo("contracts/InvoiceReceipts.sol:InvoiceReceipts");
  const record = {
    network: net,
    chainId: Number(chainId),
    contract: "InvoiceReceipts",
    address,
    txHash: tx.hash,
    blockNumber: receipt.blockNumber,
    timestamp: block.timestamp,
    deployer: deployer.address,
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: receipt.gasPrice.toString(),
    feeUSDC: fmtNative(receipt.gasUsed * receipt.gasPrice, 10),
    codeHash: ethers.keccak256(onChain),
    solc: buildInfo ? buildInfo.solcLongVersion : null,
    explorerTx: explorerTx(net, tx.hash),
    explorerAddress: explorerAddress(net, address),
  };
  fs.mkdirSync(path.dirname(deploymentFile(net)), { recursive: true });
  fs.writeFileSync(deploymentFile(net), JSON.stringify(record, null, 2) + "\n");
  console.log(`Deployed:  ${address} in block ${receipt.blockNumber}, fee ${record.feeUSDC} USDC`);
  if (record.explorerAddress) console.log(`Explorer:  ${record.explorerAddress}`);
  console.log(`Saved:     deployments/${net}.json`);

  if (process.env.UPDATE_WEB !== "0") require("./write-web-config").main();
  if (known.explorer) console.log(`Next: npx hardhat verify --network ${net} ${address}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
