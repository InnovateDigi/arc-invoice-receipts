# Security

**This code was written by an AI system and has not had a professional security audit.** It is small
(`contracts/InvoiceReceipts.sol` is about 170 lines) and has a thorough automated test suite with 100% line and
branch coverage, but tests are not an audit. Read the contract before you trust it with money, and start with small
amounts.

## What the contract guarantees (and the tests check)

- It has no owner, no admin function, no fee, no upgrade path, no `delegatecall`, no `selfdestruct`, and no
  `receive` or `fallback`. Nobody, including the authors, can pause it, change it, or move anyone's funds.
- It never keeps funds: `pay` forwards exactly the attached USDC to the merchant in the same call.
- An invoice is paid at most once, in full, by exact amount, up to and including its due second.
- Only the merchant who registered an invoice can cancel it, and only while it is unpaid.

## Known limits and risks

- USDC on Arc is issued by Circle, which can blocklist addresses. A payment to or from a blocklisted address
  reverts (the payer then loses only the gas of the failed transaction).
- If a merchant is a smart contract, it must accept plain USDC transfers; otherwise `pay` reverts with
  `TransferFailed`.
- USDC force-sent to the contract (for example with `selfdestruct`) cannot be recovered. It does not affect any
  invoice.
- The static web pages are code you must trust: host them yourself and check the contract address in the pay link
  against the address you published.
- Invoices and payments are public on-chain. Only a hash of the invoice text is stored, but amounts, merchant and
  payer addresses are visible to everyone.

## Reporting a problem

Please open an issue on the repository. If it is sensitive, use the repository's private vulnerability reporting
(Security tab) instead of a public issue.
