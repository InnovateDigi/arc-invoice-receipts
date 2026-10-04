"use strict";
// Checks that the contract deployed at an address is exactly what this repository compiles to.
//   npx hardhat run scripts/check-deployment.js --network arcTestnet            (address from deployments/arcTestnet.json)
//   CONTRACT=0x... npx hardhat run scripts/check-deployment.js --network arcMainnet
// Read-only: needs no key and sends nothing.
const hre = require("hardhat");
const { ethers, network, artifacts } = hre;
const { loadDeployment, NETWORKS, explorerAddress } = require("./lib/chain");

async function main() {
  const net = network.name;
  const record = loadDeployment(net);
  const address = process.env.CONTRACT || (record && record.address);
  if (!address) throw new Error(`No address: set CONTRACT=0x... or create deployments/${net}.json`);
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const known = NETWORKS[net];
  if (known && chainId !== known.chainId) throw new Error(`Connected to chain ${chainId}, expected ${known.chainId}`);

  const onChain = (await ethers.provider.getCode(address)).toLowerCase();
  if (onChain === "0x") throw new Error(`No contract at ${address} on ${net}`);
  const expected = (await artifacts.readArtifact("InvoiceReceipts")).deployedBytecode.toLowerCase();
  const same = onChain === expected;

  const c = await ethers.getContractAt("InvoiceReceipts", address);
  const scale = await c.SCALE();
  const probe = await c.getInvoice(ethers.ZeroHash);
  console.log(`Network:  ${known ? known.name : net} (chain ${chainId})`);
  console.log(`Address:  ${address} ${explorerAddress(net, address)}`);
  console.log(`Code:     ${(onChain.length - 2) / 2} bytes, keccak256 ${ethers.keccak256(onChain)}`);
  console.log(`Matches the code compiled from contracts/InvoiceReceipts.sol: ${same ? "YES" : "NO"}`);
  console.log(`SCALE():  ${scale} (expected 1000000000000), unknown invoice reads as status ${probe.status} (expected 0)`);
  console.log(`Balance:  ${await ethers.provider.getBalance(address)} (a healthy contract holds 0 unless USDC was force-sent to it)`);
  if (!same || scale !== 10n ** 12n) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
