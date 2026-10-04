"use strict";
// Renders TESTNET.md / MAINNET.md from the result of scripts/scenario.js. Pure function, unit-tested.
const { ethers } = require("ethers");
const { fmtNative, explorerTx, explorerAddress, fmt6 } = require("./chain");

/** price: current mainnet eth_gasPrice in wei (BigInt) used for the cost table; defaults to the 20 gwei floor. */
function renderMarkdown({ net, known, deployment, result, price }) {
  const link = (h) => (explorerTx(net, h) ? `[\`${h.slice(0, 10)}…${h.slice(-6)}\`](${explorerTx(net, h)})` : `\`${h}\``);
  const rows = result.steps
    .map((s) => {
      const fee = s.feeNative ? fmtNative(BigInt(s.feeNative), 6) : "";
      return `| ${s.n} | ${s.title} | ${s.outcome} | ${s.hash.startsWith("0x") ? link(s.hash) : s.hash} | ${s.gasUsed || ""} | ${fee} |`;
    })
    .join("\n");
  const gasOf = (match) => {
    const s = result.steps.find((x) => x.title.startsWith(match) && x.outcome === "success");
    return s ? BigInt(s.gasUsed) : null;
  };
  const gasRegister = gasOf("Merchant registers invoice A");
  const gasPay = gasOf("Payer pays invoice A");
  const gasCancel = gasOf("Merchant cancels");
  const gasDeploy = BigInt(deployment.gasUsed);
  price = price || ethers.parseUnits("20", "gwei");
  const ceiling = ethers.parseUnits("20000", "gwei");
  const usdc = (gas, p) => fmtNative(gas * p, 6);
  const mainnetRows = [
    ["Deploy the contract (once)", gasDeploy],
    ["Register an invoice", gasRegister],
    ["Pay an invoice", gasPay],
    ["Cancel an invoice", gasCancel],
  ]
    .map(([what, gas]) => `| ${what} | ${gas} | ${usdc(gas, price)} | ${usdc(gas, ceiling)} |`)
    .join("\n");
  const isMain = !known.testnet;
  const which = isMain ? "mainnet" : "testnet";
  const verified = deployment.verified
    ? `yes, [source on the explorer](${deployment.verified})`
    : `not yet (run \`npm run verify:${which}\`)`;
  const priceA = BigInt(result.prices.A);
  return `# ${isMain ? "Arc mainnet" : "Arc Testnet"} evidence

Every row below is a real transaction on **${known.name}** (chain id ${known.chainId}), produced by \`npm run deploy:${which}\` and \`npm run scenario:${which}\`. Nothing is simulated. Click a hash to open it on the explorer. Run at ${result.ranAt}.

- Contract: \`${deployment.address}\` ([explorer](${explorerAddress(net, deployment.address)}))
- Deployment transaction: ${link(deployment.txHash)} in block ${deployment.blockNumber}, ${deployment.gasUsed} gas, fee ${deployment.feeUSDC} USDC
- Merchant (also the deployer): \`${result.merchant}\`
- Payer (throw-away wallet): \`${result.payer}\`
- Source code verified on the explorer: ${verified}

## The scenario

| # | Step | Result | Transaction | Gas used | Fee (USDC) |
| - | - | - | - | - | - |
${rows}

Failed attempts are real transactions too: Arc includes a reverting transaction in a block and charges its gas, so each \`reverted\` row has a hash. The payer's funds never moved in those rows; only the fee was spent.

## What it shows

- **Create and pay in one transaction.** Invoice A: the payer attached ${fmt6(priceA)} USDC to \`pay()\`; the merchant's balance rose by exactly ${fmtNative(BigInt(result.merchantReceivedOnPay))} USDC in that same transaction and the contract's balance stayed 0.
- **Receipt.** The \`InvoicePaid\` event carries invoice id, merchant, payer, reference hash, amount and time. Events found on chain at the end: ${Object.entries(result.eventCounts).map(([k, v]) => `${v} x ${k}`).join(", ")}.
- **Double payment**: refused (\`AlreadyPaid\`). **Partial payment**: refused (\`WrongAmount\`). **Payment after cancellation**: refused (\`AlreadyCancelled\`). **Payment after the due time**: refused (\`InvoiceExpired\`). **Cancel by a stranger**: refused (\`NotMerchant\`).
- Final on-chain states: invoice A ${result.invoices.A.status}, invoice B ${result.invoices.B.status}, invoice C ${result.invoices.C.status} (never paid, expired).

Total for the whole scenario: ${result.steps.length} transactions, ${result.totalGasUsed} gas, ${fmtNative(BigInt(result.totalFeeNative), 6)} USDC in fees.

${
    isMain
      ? `## Actual cost on Arc mainnet

Deploying cost ${deployment.feeUSDC} USDC (${deployment.gasUsed} gas). The whole scenario above cost ${fmtNative(BigInt(result.totalFeeNative), 6)} USDC in fees, including five reverted attempts. The contract itself charges nothing.
`
      : `## Estimated cost on Arc mainnet

Measured gas from the rows above, priced at Arc mainnet's current \`eth_gasPrice\` (${ethers.formatUnits(price, "gwei")} gwei, read from the public RPC at the time of the run) and, for the worst case, at the protocol's maximum base fee of 20,000 gwei.

| Action | Gas | Typical cost (USDC) | Worst case (USDC) |
| - | - | - | - |
${mainnetRows}

Deploying costs about ${usdc(gasDeploy, price)} USDC at today's price. Keep a few cents of USDC in the deployer wallet; the worst case is a theoretical ceiling, not an expectation. Fee-free for merchants and payers: the contract charges nothing, only the network gas above applies.
`
  }`;
}

module.exports = { renderMarkdown };
