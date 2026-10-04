# Arc Invoice Receipts

**Invoice links with on-chain receipts for USDC on Arc.** A merchant creates an invoice and shares a link or QR
code. The payer settles it in **one transaction** and the USDC goes **straight to the merchant**. The contract
records who paid and when, and emits a receipt event. No server, no account, no fee, no owner, no upgrade path.

> **Read this first.** This code was written by an AI system and has **not had a professional security audit**.
> It is small and heavily tested (see below), but tests are not an audit. Use small amounts until you have read the
> contract yourself. Licence: MIT. See [SECURITY.md](SECURITY.md).

## Who it is for

A freelancer, small shop or open-source maintainer who wants to be paid in USDC on [Arc](https://docs.arc.io)
without running a server, signing up to a payment processor, or paying a percentage. You need a wallet; your
customers need a wallet with a little USDC (on Arc, USDC is also the gas currency, so no second token is needed).

## How it works

```
  Merchant                           Arc                                  Payer
  --------                           ---                                  -----
  create page: amount, text, due
  register(hash, amount, due) ─────▶ invoice stored (status Open)
  pay link + QR code  ◀─ computed locally
                                                                     opens link ──▶ pay page reads getInvoice(id)
                                                                     pay(id) + exact USDC attached
                                     status = Paid, payer, time stored
              USDC arrives ◀──────── contract forwards the value to the merchant in the same call
                                     event InvoicePaid (the receipt) ─────────────▶ receipt on screen
  receipts page: scans events ─────▶ lists invoices and payments, exports CSV
```

1. **Create** (`web/index.html`). Connect a wallet, type an amount, an invoice number, a description and a due date.
   The page hashes the text, sends `register(referenceHash, amount, due)` and shows a pay link and a QR code. Only the
   hash of the text is on-chain; the text itself travels in the link, and the pay page checks it against the hash.
2. **Pay** (`web/pay.html`). The page reads the invoice from the chain through the public RPC (no wallet needed to
   look), shows merchant, amount, due time and status, and lets the payer settle it. Payment is a single call,
   `pay(id)`, with exactly `amount` USDC attached as the transaction value.
3. **Receipts** (`web/receipts.html`). Lists a merchant's invoices (or a payer's payments) from the contract's events
   and exports them as CSV for bookkeeping. The connected merchant can also cancel an open invoice there, and copy a pay
   link again.

### Why one transaction

On Arc, USDC is the **native currency** (like ETH on Ethereum), so a payment is just value attached to a contract
call. There is no `approve` step and no token transfer inside the contract: `pay` forwards `msg.value` to the merchant
with a plain call, and the contract's balance stays zero. Amounts are stored in the 6-decimal USDC unit that Arc's
ERC-20 view uses (1.25 USDC = `1250000`); the attached value is `amount * 1e12` because the native unit has 18 decimals.

### Arc details the code accounts for

- **Two views of one balance.** Native USDC has 18 decimals, the ERC-20 view has 6. Invoices use 6 decimals and the
  contract converts exactly (`amount * 1e12`); it never reads `balanceOf` or `address(this).balance` for accounting.
- **Fee floor.** Arc silently drops transactions with `maxFeePerGas` below 20 gwei; the pages and scripts always set
  at least 20 gwei.
- **Failed transactions are mined.** A reverting transaction gets a receipt with status 0 and costs gas. The pay page
  simulates first, and recovers the reason of a mined failure by replaying the call at its block.
- **System logs.** Native transfers emit EIP-7708 `Transfer` logs from a system address, so a payment receipt holds
  three logs. The pages only trust logs from the invoice contract.
- **Log limits.** Public RPCs cap `eth_getLogs` ranges (10,000 blocks, 100,000 on one provider) and rate-limit; the
  receipts page pages through history, rotates between the official public endpoints and caches progress.
- **Timestamps** never go backwards but can repeat, so "due" is inclusive and compared with `block.timestamp` only.

### Why a contract at all, when you can just send USDC?

A plain transfer carries no invoice. With this contract the payment is tied to one specific invoice, cannot be sent
twice, cannot be underpaid or overpaid, stops being possible after the due time or a cancellation, and leaves a
receipt (who, how much, when, which invoice) that anyone can verify on-chain. The merchant gets bookkeeping for free,
the payer gets proof of payment, and neither has to trust a payment processor.

### What the contract enforces

| Rule | What happens |
| - | - |
| Only the merchant registers their own invoices | `register` makes `msg.sender` the merchant; id = `keccak256(abi.encode(merchant, referenceHash))` |
| Nothing is registered twice | same merchant and same reference hash again: `AlreadyRegistered` (also after paid or cancelled) |
| Sane inputs | zero hash `ZeroReferenceHash`, zero amount `ZeroAmount`, due not after now `DueNotInFuture` |
| Exact payment only | any other amount (partial, over, zero): `WrongAmount(expected, sent)` |
| Paid once | a second payment: `AlreadyPaid`; nothing moves |
| Cancel is final | only the merchant, only while unpaid; afterwards paying reverts `AlreadyCancelled` |
| Deadline | payable up to and including `due`; afterwards `InvoiceExpired` |
| Payout can fail safely | merchant cannot receive (reverting contract, blocklisted address): `TransferFailed`, state unchanged |
| Receipt | `InvoicePaid(id, merchant, payer, referenceHash, amount, paidAt)`; also stored: payer and time |
| No custody | no `receive`/`fallback`; `pay` is the only payable function; effects are written before the payout, and the payout call never copies return data |
| No admin | no owner, no fee, no upgrade, no `delegatecall`, no `selfdestruct` (a test inspects the bytecode) |

A reverted transaction changes no state; the payer loses only the gas of the failed attempt. The web page simulates
the call first and shows the reason instead of letting the payer send a doomed transaction.

## Use it from code (scripts and agents)

The pages are optional: the contract is the product, and anything that can send a transaction can use it.

```js
// ethers v6; ABI from artifacts/contracts/InvoiceReceipts.sol/InvoiceReceipts.json after `npm run compile`
const invoices = new ethers.Contract(ADDRESS, ABI, signer);

// merchant: register 25 USDC (6-decimal units), payable for 14 days
const referenceHash = ethers.id("INV-2026-001 | Logo design | any random salt");
const id = await invoices.invoiceId(merchant, referenceHash);
await (await invoices.register(referenceHash, 25_000_000n, BigInt(Math.floor(Date.now() / 1000) + 14 * 86400))).wait();

// payer: read it, then pay exactly 25 USDC as the transaction value (18-decimal native units)
const inv = await invoices.getInvoice(id);                       // { merchant, due, paidAt, status, referenceHash, payer, amount }
await (await invoices.pay(id, { value: inv.amount * 10n ** 12n })).wait();

// anyone: the receipt, filtered by merchant (topic 2) or payer (topic 3)
const receipts = await invoices.queryFilter(invoices.filters.InvoicePaid(null, merchant));
```

Status values: 0 none, 1 open, 2 paid, 3 cancelled. An open invoice whose `due` is in the past can no longer be paid.
Set `maxFeePerGas` to at least 20 gwei on Arc or the transaction is dropped.

## Limits and what it does NOT do

- **No refunds and no disputes.** A payment is final. Refunding is a separate payment you make yourself.
- **No tax or legal advice.** A receipt event is a record that a payment happened, not a tax invoice. Check what your
  jurisdiction requires (VAT, invoice numbering, company details).
- **No partial payments, instalments, subscriptions or recurring billing.** One invoice, one exact payment. Split a
  job into several invoices if you want instalments.
- **USDC only** (the native currency of Arc). No EURC, no other tokens, no currency conversion.
- **Hard deadline.** After the due time the invoice cannot be paid; register a new one (with a new reference hash).
  For "no deadline" pick a far date.
- **Cancel cannot be undone**, and a cancelled or paid reference hash cannot be reused by the same merchant.
- **One payout address per invoice**: the account that registered it. A smart-contract merchant must accept plain USDC
  transfers.
- **Circle can blocklist addresses.** A payment to or from a blocklisted address reverts at protocol level.
- **Not private.** Amounts, merchant and payer addresses and timestamps are public. The description is not on-chain
  (only its hash) but it is inside the pay link, so share links accordingly.
- **No notifications.** The static page cannot email you; open the receipts page to see payments.
- **Wallet needed.** Pay and create use a browser wallet (EIP-1193 / EIP-6963). There is no WalletConnect, so on a
  phone open the link inside the wallet app's browser.
- **Merchant identity is just an address.** Anyone can register an invoice with a convincing description. Payers should
  confirm the merchant address with the merchant by another channel. The page shows it prominently.
- **Receipts scan takes time on a long-lived deployment.** Arc's public RPC allows at most 10,000 blocks per
  `eth_getLogs`; the page pages through history (about 2 blocks per second), caches progress in the browser, and
  lets you pick a recent range.
- **Timestamps** are block timestamps: whole seconds, never going backwards, but consecutive blocks can share one.

## Ideas for later (not built)

- Pay with EURC or other tokens through an approve-and-pull path (USDC itself needs none on Arc).
- Optional payer allow-list per invoice, and invoice batches registered in one transaction.
- A static, pre-built index file (generated by a script and hosted next to the pages) so the receipts page does not
  have to scan old blocks.
- Attaching the invoice hash to a native transfer with Arc's Memo contract for payers who do not use the pay page.

## Run the tests

Needs Node 20 or newer (developed on Node 24).

```bash
npm ci
npm test               # 1,219 tests: contract suite, script tests, web module tests, web-against-contract tests
npm run coverage       # solidity-coverage on the contract suite: 100% statements, branches, functions and lines
```

The contract suite (56 tests) covers every rule and every revert above, the events and their indexed topics, hostile
merchant contracts (reverting, gas-burning, return-data bombs, re-entering, paying the next invoice in a chain), smart
contract payers, USDC force-sent into the contract, a bytecode scan for forbidden opcodes, and randomised
register/pay/cancel/time sequences checked against an independent model. It was reviewed by a second, independent
AI reviewer who also wrote 36 hand-made mutants of the contract (drop a check, flip a comparison, reorder the effects,
change the scale, record the wrong payer...); the suite kills 35 of them and the one survivor is semantically identical
code. The web modules have their own unit tests, `test/web-integration.test.js` drives them against the real contract,
and the optional `e2e/` walkthrough runs all three pages in a real Chrome against a local node with a mock wallet
(about 230 checks: failure paths, wrong network, hostile links and memos, CSV, file:// and mobile width). A second,
independent AI review of the web app found no critical or high issue and 15 smaller ones, all fixed.

The contract suite also passes against Arc's own EVM rules with [Arc Foundry](https://docs.arc.io/arc/tutorials/install-arc-foundry)'s
local node (`arc-anvil --network arc`, release v0.8.0-2):

```bash
arc-anvil --network arc --port 8646 &
npm run test:arc-anvil
```

## Run the web app

`web/` is the whole site: plain HTML, CSS and JavaScript, no build step, no framework, no third-party requests.
Open `web/index.html` from disk, or serve the folder with any static host (GitHub Pages, IPFS, `python3 -m http.server
-d web 8080`). Pay links only work for your customers if the pages are hosted somewhere they can reach. For GitHub
Pages, enable Pages with source "GitHub Actions" once; `.github/workflows/pages.yml` then publishes `web/`. Page
parameters live in the URL fragment, so they are never sent to a server. Contract addresses are in
`web/js/deployments.js` (generated by the deploy script).

## Deploy

The deployer key is read from `PRIVATE_KEY` or from a file named by `DEPLOYER_KEY_FILE` (bare hex or JSON with a
`privateKey` field) and is never printed. Keep it outside the repository.

```bash
# Arc Testnet (get test USDC at https://faucet.circle.com)
DEPLOYER_KEY_FILE=/path/to/key.json npm run deploy:testnet
DEPLOYER_KEY_FILE=/path/to/key.json npm run scenario:testnet     # create, pay, pay twice, partial, cancel, pay cancelled, expired

# Arc mainnet: costs real USDC, so it asks for an explicit confirmation. DRY_RUN=1 prints the cost and sends nothing.
DRY_RUN=1 DEPLOYER_KEY_FILE=/path/to/key.json npm run deploy:mainnet
CONFIRM_MAINNET=yes DEPLOYER_KEY_FILE=/path/to/key.json npm run deploy:mainnet

# Optional live proof on mainnet with small invoices (0.05, 0.02, 0.01 USDC; about 0.011 USDC in fees); writes MAINNET.md
CONFIRM_MAINNET=yes DEPLOYER_KEY_FILE=/path/to/key.json npm run scenario:mainnet
```

Each deployment is recorded in `deployments/<network>.json` and `web/js/deployments.js` is regenerated. Afterwards:

```bash
npm run check:mainnet                      # read-only: is the code at the address exactly what this repo compiles to?
npm run verify:mainnet                     # publish the source on the explorer (Blockscout)
npm run verify:json                        # if the explorer's API refuses scripts: writes the standard JSON input to upload by hand
```

`deployments/verification/InvoiceReceipts.standard-input.json` is committed: compiling it with solc 0.8.28 reproduces
the deployed bytecode exactly, metadata hash included, so anyone can check the explorer's "verified" badge themselves.

Arc facts the scripts rely on (from the [official docs](https://docs.arc.io)): testnet chain id 5042002, mainnet 5042;
USDC is the gas token; transactions with `maxFeePerGas` below 20 gwei are silently dropped, so every transaction sets
at least 20 gwei.

### Cost

Measured gas: deploy about 577,000, register about 93,000, pay about 47,000, cancel about 29,000. At Arc's 20 gwei
minimum fee that is roughly 0.012 USDC to deploy, 0.0019 USDC to register, 0.0009 USDC to pay and 0.0006 USDC to
cancel. The contract itself charges nothing. See [TESTNET.md](TESTNET.md) for measured numbers.

## Deployed addresses

| Network | Chain id | Contract | Explorer |
| - | - | - | - |
| Arc Testnet | 5042002 | see [TESTNET.md](TESTNET.md) | [explorer.testnet.arc.io](https://explorer.testnet.arc.io) |
| Arc Mainnet | 5042 | _not deployed yet_ | [explorer.arc.io](https://explorer.arc.io) |

## Layout

```
contracts/InvoiceReceipts.sol   the whole contract (about 170 lines, NatSpec on every function)
contracts/test/                 test-only helpers: hostile merchants, smart-contract payer, force-send helper
test/                           contract tests, script tests, web module tests (test/web), web-against-contract tests
scripts/deploy.js               deploy, record in deployments/, regenerate web/js/deployments.js
scripts/scenario.js             scripted scenario on a deployed contract; writes TESTNET.md
scripts/verify.js               publish the source on the Arc explorer (Blockscout)
scripts/check-deployment.js     read-only: is the code at an address exactly what this repo compiles to?
scripts/export-standard-json.js standard JSON input for manual explorer verification
web/                            static app: index.html (create), pay.html, receipts.html, js/, css/
web/vendor/                     qrcode-generator (MIT), vendored unchanged
e2e/                            optional browser walkthrough with a mock wallet (needs playwright-core and Chrome)
deployments/                    addresses and transaction hashes per network
.github/workflows/              tests on every push; publish web/ to GitHub Pages
```

Third-party code: the web app vendors [`qrcode-generator`](https://github.com/kazuhikoarase/qrcode-generator) by
Kazuhiko Arase (MIT) to draw QR codes locally. Development tooling is Hardhat, ethers, chai and solidity-coverage; none
of it ships in the web app.

## Licence

MIT, see [LICENSE](LICENSE). This code was written by an AI system and has not had a professional security audit.
