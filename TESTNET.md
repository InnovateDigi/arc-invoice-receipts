# Arc Testnet evidence

**Status: not deployed to Arc Testnet yet.** When this was prepared (4 Oct 2026, 22:15-23:05 UTC) the deployer wallet
`0x8cfE492Cb7A935B83080026C592e717ab34D6D59` held 0 testnet USDC, and Circle's faucet asks for a human check, so no
transaction has been sent to a public network. Everything else is done and tested locally, including on Arc's own EVM
rules (Arc Foundry's `arc-anvil --network arc`).

To produce the evidence, send testnet USDC (20 is plenty; about 0.04 USDC is used) to the address above from
https://faucet.circle.com (network: Arc Testnet), then run:

```bash
export DEPLOYER_KEY_FILE=/path/to/key.json
npm run deploy:testnet      # deploys, records deployments/arcTestnet.json, regenerates web/js/deployments.js
npm run verify:testnet      # publishes the source on explorer.testnet.arc.io (Blockscout)
npm run scenario:testnet    # create, pay, pay twice, partial payment, cancel, pay cancelled, pay expired
```

`npm run scenario:testnet` regenerates this file with the contract address, every transaction hash as an explorer
link, gas used, fees, and the mainnet cost estimate. A background watcher on the build machine runs exactly these three
commands as soon as the wallet holds 3 testnet USDC.

## Scenario already run on the local Arc-faithful node (not public evidence)

The same script ran against `arc-anvil --network arc` (Arc Foundry v0.8.0-2). 10 transactions, all as expected:

| # | Step | Result | Gas used |
| - | - | - | - |
| 1 | Merchant registers invoice A (1.25 USDC, due in 1 hour) | success | 92,655 |
| 2 | Payer pays invoice A in full (1.25 USDC attached to `pay()`); merchant balance +1.25 USDC, contract balance 0 | success | 46,791 |
| 3 | Payer tries to pay invoice A again | reverted `AlreadyPaid` | 24,142 |
| 4 | Merchant registers invoice B (0.50 USDC) | success | 92,655 |
| 5 | Payer tries to pay only half of invoice B | reverted `WrongAmount` | 26,520 |
| 6 | Payer (not the merchant) tries to cancel invoice B | reverted `NotMerchant` | 24,253 |
| 7 | Merchant cancels invoice B | success | 29,175 |
| 8 | Payer tries to pay the cancelled invoice B | reverted `AlreadyCancelled` | 24,155 |
| 9 | Merchant registers invoice C (due in 20 seconds) | success | 92,655 |
| 10 | Payer tries to pay invoice C after its due time | reverted `InvoiceExpired` | 24,351 |

Like Arc itself, the node mines a reverting transaction (status 0) and charges its gas, so failed attempts have hashes
too. Final states: A paid, B cancelled, C open but expired.

## Estimated cost on Arc mainnet

Measured gas, priced at the 20 gwei base fee Arc mainnet showed on 4 Oct 2026 (`eth_gasPrice` 20.000000001 gwei; fee
history flat at 20 gwei; the protocol's maximum is 20,000 gwei, a theoretical ceiling).

| Action | Gas | At 20 gwei (USDC) | At the 20,000 gwei ceiling (USDC) |
| - | - | - | - |
| Deploy the contract (once) | 577,330 | 0.0115 | 11.5 |
| Register an invoice | 92,655 | 0.0019 | 1.85 |
| Pay an invoice | 46,791 | 0.0009 | 0.94 |
| Cancel an invoice | 29,175 | 0.0006 | 0.58 |

A dry run of the real deploy command against the Arc mainnet RPC (`DRY_RUN=1`, nothing sent) estimated 583,079 gas for
the deployment, about 0.0122 USDC at the 21 gwei effective price (20 gwei base fee plus our 1 gwei tip). The script
refuses to start unless the wallet holds gas x its 40 gwei fee cap (about 0.025 USDC). Keep 0.03 USDC for the deployment
alone, or about 0.25 USDC to also run the small live scenario on mainnet (`npm run scenario:mainnet`, about 0.011 USDC in
fees; 0.15 USDC moves to a throw-away wallet and is swept back). The contract itself charges nothing.
