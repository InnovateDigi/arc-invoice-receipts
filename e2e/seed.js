#!/usr/bin/env node
'use strict';
/*
 * Seeds the local deployment (e2e/.local-deployment.json) with one invoice per scenario and prints ONE JSON object
 * (deployment, merchant/payer addresses, ids, memos, pay links, `expect`). Re-runnable: every run uses fresh salts,
 * so it adds six NEW invoices each time. Merchant = account #1, payers = accounts #2 and #3 (local hardhat node only).
 * NOTE: the expired scenario fast-forwards the chain clock by one hour (evm_increaseTime 3600), so each run moves
 * chain time one hour further ahead of wall-clock time (see `node e2e/chain.js now`).
 *
 *   node e2e/seed.js [--base http://127.0.0.1:8080]
 */
const chain = require('./chain.js');

async function main() {
  const { opt } = chain.parseArgs(process.argv.slice(2));
  const base = (typeof opt.base === 'string' ? opt.base : chain.DEFAULT_BASE).replace(/\/+$/, '');
  const ctx = await chain.connect({});
  try {
    const merchant = await chain.getSigner(ctx, 1);
    const payer2 = await chain.getSigner(ctx, 2);
    const payer3 = await chain.getSigner(ctx, 3);
    const merchantAddr = await merchant.getAddress();
    const payer2Addr = await payer2.getAddress();
    const payer3Addr = await payer3.getAddress();

    const head = await chain.latest(ctx.provider);
    const dueLong = head.timestamp + 14 * chain.DAY;
    const reg = (no, desc, usdc, due) =>
      chain.registerInvoice(ctx, merchant, { amount: chain.parseUsdc(usdc), desc, no, due, base });

    const nastyDesc = '=HYPERLINK("http://example.com","click"), line1\nline2 é中文 "quoted"';
    if (Array.from(nastyDesc).length > 140) throw new Error('nasty description is longer than 140 characters');

    // (a) open
    const open = await reg('INV-001', 'Website design, phase 1', '1.25', dueLong);
    // (b) paid by #2
    const paid = await reg('INV-002', 'Hosting, March', '25', dueLong);
    const paidTx = await chain.payInvoice(ctx, payer2, paid.id);
    // (c) cancelled
    const cancelled = await reg('INV-003', 'Cancelled job', '3', dueLong);
    const cancelTx = await chain.cancelInvoice(ctx, merchant, cancelled.id);
    // (e) nasty text for the CSV export, left open
    const nasty = await reg('=1+1', nastyDesc, '0.000001', dueLong);
    // (f) big amount, left open (about 1.23 million native units: nobody can pay it with default hardhat balances)
    const big = await reg('INV-006', 'Large equipment order', '1234567.891234', dueLong);
    // (d) expired, created LAST: due = latest block timestamp + 60, then the chain clock jumps one hour ahead
    const expiredHead = await chain.latest(ctx.provider);
    const expired = await reg('INV-004', 'Expired job', '2', expiredHead.timestamp + 60);
    await chain.increaseTime(ctx.provider, 3600);

    const final = await chain.latest(ctx.provider);
    const scenarios = [
      ['open', open, 'Open'], ['paid', paid, 'Paid'], ['cancelled', cancelled, 'Cancelled'],
      ['expired', expired, 'Expired'], ['nasty', nasty, 'Open'], ['big', big, 'Open']
    ];
    const invoices = {};
    const expect = [];
    for (const [key, inv, want] of scenarios) {
      const info = await chain.invoiceInfo(ctx, inv.id);
      // "Expired" is not a stored status: it is an Open invoice whose due time is before the latest block timestamp.
      const got = info.status === 'Open' && final.timestamp > info.due ? 'Expired' : info.status;
      if (got !== want) throw new Error('scenario ' + key + ' expected ' + want + ' but chain says ' + got);
      invoices[key] = Object.assign({}, inv, { expect: want, onChain: { status: info.status, payer: info.payer, paidAt: info.paidAt, due: info.due } });
      expect.push((inv.no || '(no number)') + ' [' + key + ']: ' + want + ', ' + inv.amountUsdc + ' USDC');
    }
    invoices.paid.payTx = paidTx.tx;
    invoices.paid.payBlock = paidTx.block;
    invoices.paid.payer = payer2Addr;
    invoices.cancelled.cancelTx = cancelTx.tx;

    console.log(JSON.stringify({
      base,
      deployment: ctx.deployment,
      merchant: merchantAddr,
      payers: { '2': payer2Addr, '3': payer3Addr },
      merchantReceiptsLink: chain.receiptsLinkFor(base, merchantAddr),
      payerReceiptsLinks: {
        '2': chain.receiptsLinkFor(base, merchantAddr, payer2Addr),
        '3': chain.receiptsLinkFor(base, merchantAddr, payer3Addr)
      },
      chain: { block: final.number, timestamp: final.timestamp, iso: final.iso, wallClock: Math.floor(Date.now() / 1000) },
      invoices,
      expect
    }, null, 2));
  } finally {
    ctx.provider.destroy();
  }
}

main().catch((e) => {
  console.error(JSON.stringify(chain.describeError(e)));
  process.exitCode = 1;
});
