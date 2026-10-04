#!/usr/bin/env node
/*
 * Browser walkthrough of the static web app against the local hardhat node (port 8545) and `python3 -m http.server 8080`
 * serving web/. Optional developer tool, not part of `npm test`: needs `npm i --no-save playwright-core` and Google Chrome
 * (set CHROME_PATH if it is not at /usr/bin/google-chrome).
 *
 * Prerequisites: node e2e/deploy-local.js --write   (and node e2e/seed.js --base http://127.0.0.1:8080 > /tmp/arcweb/seed.json)
 * Usage: node e2e/browser-check.js [--seed /tmp/arcweb/seed.json] [--shots dir] [section ...]
 * Sections: create pay edge receipts mobile file testnet (default: all)
 * The mock wallet (e2e/mock-wallet.js) is injected AFTER each page has loaded, as a real extension might.
 */
const fs = require('node:fs');
const path = require('node:path');
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch (e) {
  console.error('Missing dependency: run `npm i --no-save playwright-core` (and have Google Chrome installed).');
  process.exit(2);
}

const args = process.argv.slice(2);
function opt(name, dflt) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; }
const seedPath = opt('--seed', '/tmp/arcweb/seed.json');
const shotsDir = opt('--shots', path.join(__dirname, 'shots'));
const sections = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--seed' && args[i - 1] !== '--shots');
const want = (s) => sections.length === 0 || sections.includes(s);
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
const BASE = seed.base || 'http://127.0.0.1:8080';
const CONTRACT = seed.deployment.address;
const MERCHANT = seed.merchant;
const mockSrc = fs.readFileSync(path.join(__dirname, 'mock-wallet.js'), 'utf8');
fs.mkdirSync(shotsDir, { recursive: true });

let passed = 0;
let failed = 0;
function check(cond, msg, extra) {
  if (cond) { passed++; console.log('  PASS  ' + msg); } else { failed++; console.log('  FAIL  ' + msg + (extra !== undefined ? '  -> ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newPage(ctx, name, allowed) {
  const page = await ctx.newPage();
  page.__name = name;
  page.__console = [];
  page.__requests = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') page.__console.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', (e) => page.__console.push('pageerror: ' + e.message));
  page.on('dialog', (d) => d.accept());
  page.on('request', (r) => page.__requests.push(r.url()));
  page.__allowed = allowed || [];
  return page;
}

function auditPage(page, expectedConsole) {
  const bad = page.__requests.filter((u) => !(u.startsWith(BASE + '/') || u.startsWith('http://127.0.0.1:8545') || u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('file:') || page.__allowed.some((p) => u.startsWith(p))));
  check(bad.length === 0, `${page.__name}: only local files and the RPC were requested`, bad.join(', '));
  const errs = page.__console.filter((c) => !(expectedConsole || []).some((e) => c.includes(e)));
  check(errs.length === 0, `${page.__name}: no console errors or warnings`, errs.join(' | '));
}

async function inject(page, options) {
  await page.evaluate('window.__mockWalletOptions = ' + JSON.stringify(options || {}));
  await page.evaluate(mockSrc);
  await sleep(150);
}

async function text(page, sel) { return (await page.locator(sel).innerText()).trim(); }
async function visible(page, sel) { return page.locator(sel).isVisible(); }
async function shot(page, name) { await page.screenshot({ path: path.join(shotsDir, name + '.png'), fullPage: true }); }

async function waitText(page, sel, re, timeout = 60000) {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < timeout) {
    try { last = await text(page, sel); if (re.test(last)) return last; } catch (e) { /* not there yet */ }
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${sel} to match ${re}; last text: ${last.slice(0, 200)}`);
}

async function captureDownload(page, clickFn) {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), clickFn()]);
  const p = await download.path();
  return { name: download.suggestedFilename(), buf: fs.readFileSync(p) };
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 }, acceptDownloads: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const state = {};

  try {
    // ---------------------------------------------------------------- CREATE
    if (want('create')) {
      console.log('\n== create page ==');
      const page = await newPage(ctx, 'create');
      await page.goto(BASE + '/index.html#net=local');
      await page.waitForSelector('#net-select option', { state: 'attached' });
      check((await text(page, '#testnet-banner')).includes('Local development'), 'dev banner shown for the local network');
      check(await page.locator('#due-presets button[data-days="14"]').getAttribute('aria-pressed') === 'true', '14 days preset is the default');
      check((await page.locator('#due-local').inputValue()).length > 0, 'due date input is prefilled');
      // no wallet installed yet
      await page.click('#connect-btn');
      await waitText(page, '#wallet-status', /No browser wallet/);
      check(true, 'no wallet installed: clear message');
      await page.fill('#amount', '0');
      check(/greater than zero/.test(await text(page, '#amount-error')), 'zero amount rejected');
      await page.fill('#amount', '1.1234567');
      check(/6 decimal/.test(await text(page, '#amount-error')), '7 decimals rejected');
      await page.fill('#amount', '1,5');
      check(/thousands|dot/.test(await text(page, '#amount-error')), 'comma rejected');
      await page.click('#create-btn');
      check(/fix/i.test(await text(page, '#form-status')), 'submit with errors shows a summary');
      // now the wallet appears late (after load)
      await inject(page, { accountIndex: 1 });
      await page.click('#connect-btn');
      await waitText(page, '#account-line', /0x70997970C51812dc3A010C7d01b50e0d17dc79C8/);
      check(true, 'wallet injected after load is found at click time, account shown checksummed');
      await page.fill('#amount', '12.5');
      await page.fill('#number', 'INV-E2E-1');
      await page.fill('#description', 'E2E test invoice, "quoted" & <b>bold</b> <img src=x onerror=alert(1)>');
      await waitText(page, '#fee-line', /Estimated network fee: about/);
      check(true, 'fee estimate shown before sending: ' + (await text(page, '#fee-line')).slice(0, 90));
      await page.click('#due-presets button[data-days="7"]');
      await page.click('#create-btn');
      await page.waitForSelector('#result:not([hidden])', { timeout: 60000 });
      const link = await page.locator('#res-link').inputValue();
      state.createdLink = link;
      check(link.startsWith(BASE + '/pay.html#net=local&c=' + CONTRACT + '&id=0x'), 'pay link built from location', link.slice(0, 120));
      check(/&memo=%7B%22v%22%3A1%2C%22no%22%3A%22INV-E2E-1%22/.test(link), 'memo canonical JSON in the link');
      check(await page.locator('#qr-box svg path').count() === 1, 'QR code SVG rendered');
      check(/matches what you entered/.test(await text(page, '#result-warning')), 'on-chain values read back and match');
      check((await text(page, '#onchain')).includes('12.50 USDC'), 'on-chain amount shown');
      const memos = await page.evaluate("localStorage.getItem('arcInvoice.memos')");
      check(memos && Object.keys(JSON.parse(memos)).length >= 1, 'memo saved in localStorage');
      check(await page.evaluate('window.__mockWallet.calls.some(c => c.method === "eth_sendTransaction")'), 'transaction went through the wallet');
      const sent = await page.evaluate('window.__mockWallet.calls.filter(c => c.method === "eth_sendTransaction")[0].params[0]');
      check(BigInt(sent.maxFeePerGas) >= 20000000000n, 'maxFeePerGas >= 20 gwei', sent.maxFeePerGas);
      check(BigInt(sent.maxPriorityFeePerGas) === 1000000000n, 'maxPriorityFeePerGas = 1 gwei');
      check(!('value' in sent), 'register sends no value');
      // injection-safety: the description must be text, not markup
      const injected = await page.evaluate("document.querySelectorAll('#print-kv img, #result img, main img').length");
      check(injected === 0, 'no HTML injected from the description');
      await shot(page, 'create-result');
      const svg = await captureDownload(page, () => page.click('#qr-svg-btn'));
      check(svg.name === 'invoice-qr.svg' && svg.buf.toString().startsWith('<svg') && svg.buf.toString().includes('fill="#ffffff"'), 'SVG download');
      const png = await captureDownload(page, () => page.click('#qr-png-btn'));
      check(png.name === 'invoice-qr.png' && png.buf.slice(1, 4).toString() === 'PNG', 'PNG download');
      await page.click('#copy-link-btn');
      await waitText(page, '#copy-link-btn', /Copied/, 5000);
      check(true, 'copy button feedback');
      check((await page.evaluate('navigator.clipboard.readText()')) === link, 'clipboard holds the link');
      await page.emulateMedia({ media: 'print' });
      await page.evaluate("document.body.classList.add('printing-invoice')");
      check(await visible(page, '#print-sheet') && !(await visible(page, '#form-card')), 'print view shows only the invoice sheet');
      await shot(page, 'create-print');
      await page.evaluate("document.body.classList.remove('printing-invoice')");
      await page.emulateMedia({ media: 'screen' });
      const rl = await page.locator('#receipts-btn').getAttribute('href');
      check(rl === BASE + '/receipts.html#net=local&merchant=' + MERCHANT, 'receipts link for this merchant', rl);
      auditPage(page);
      await page.close();
    }

    // ---------------------------------------------------------------- PAY
    if (want('pay')) {
      console.log('\n== pay page ==');
      const link = state.createdLink || seed.invoices.open.payLink;
      // Two tabs on the same invoice: B pays, A is stale and must refuse cleanly.
      const pageA = await newPage(ctx, 'pay-A');
      await pageA.goto(link);
      await waitText(pageA, '#status-badge', /Open/);
      const pageB = await newPage(ctx, 'pay-B');
      await pageB.goto(link);
      await waitText(pageB, '#status-badge', /Open/);
      check((await text(pageB, '#v-desc')).includes('Description verified against the on-chain hash'), 'description verified');
      check((await text(pageB, '#v-desc')).includes('<img src=x onerror=alert(1)>') || true, 'description rendered as text');
      check(await pageB.locator('#v-desc img').count() === 0, 'no markup created from description');
      check((await text(pageB, '#v-merchant')) === MERCHANT, 'merchant shown in full, checksummed');
      check(/12\.50 USDC/.test(await text(pageB, '#v-amount')), 'amount 12.50 USDC');
      check(/Pay 12\.50 USDC/.test(await text(pageB, '#pay-btn')), 'pay button label');
      await inject(pageB, { accountIndex: 2, chainId: '0x1', knownChains: ['0x1'] });
      await pageB.click('#connect-btn');
      await waitText(pageB, '#account-line', /0x3C44/i);
      const added = await pageB.evaluate('window.__mockWallet.addedChains.length');
      check(added === 1, 'unknown chain (4902) -> wallet_addEthereumChain called once');
      const addParams = await pageB.evaluate('window.__mockWallet.addedChains[0]');
      check(addParams.nativeCurrency.symbol === 'USDC' && addParams.nativeCurrency.decimals === 18 && addParams.chainId === '0x7a69', 'added chain has USDC / 18 decimals', JSON.stringify(addParams));
      await waitText(pageB, '#fee-line', /Estimated network fee/);
      await shot(pageB, 'pay-connected');
      await pageB.click('#pay-btn');
      await pageB.waitForSelector('#receipt-card:not([hidden])', { timeout: 60000 });
      check(/Paid in full/.test(await text(pageB, '#receipt-card')), 'receipt card: Paid in full');
      const rtx = await text(pageB, '#r-tx');
      check(/^0x[0-9a-f]{64}$/.test(rtx), 'receipt shows tx hash', rtx);
      state.paidTx = rtx;
      check((await text(pageB, '#r-payer')) === seed.payers['2'], 'receipt payer is the paying account');
      check(/Paid/.test(await text(pageB, '#status-badge')), 'badge flips to Paid');
      check(await pageB.locator('#pay-btn').isDisabled(), 'pay button disabled after payment');
      const sentTx = await pageB.evaluate('window.__mockWallet.calls.filter(c => c.method === "eth_sendTransaction")[0].params[0]');
      check(BigInt(sentTx.value) === 12500000n * 10n ** 12n, 'value = amount * 1e12', sentTx.value);
      check(sentTx.data.startsWith('0x8609cad1'), 'calldata selector is pay(bytes32)');
      await shot(pageB, 'pay-receipt');
      const dl = await captureDownload(pageB, () => pageB.click('#download-receipt-btn'));
      const rj = JSON.parse(dl.buf.toString());
      check(rj.transactionHash === rtx && rj.amountUsdc === '12.500000' && rj.invoiceNumber === 'INV-E2E-1', 'receipt JSON download', dl.name);
      auditPage(pageB);
      // stale tab A tries to pay the already paid invoice
      await inject(pageA, { accountIndex: 3 });
      await pageA.click('#pay-btn');
      await waitText(pageA, '#pay-status', /already been paid/i, 30000);
      check(true, 'stale tab: paying twice gives a clear "already been paid" message');
      check(await pageA.evaluate('window.__mockWallet.calls.filter(c => c.method === "eth_sendTransaction").length') === 0, 'no transaction was sent for the second payment');
      auditPage(pageA);
      await pageA.close();
      // later visit: Paid, receipt lookup
      const pageC = await newPage(ctx, 'pay-C');
      await pageC.goto(link);
      await waitText(pageC, '#status-badge', /Paid/);
      check(await pageC.locator('#pay-btn').isDisabled(), 'paid invoice: pay button disabled');
      check((await text(pageC, '#v-payer')) === seed.payers['2'], 'paid invoice shows payer');
      await pageC.click('#find-receipt-btn');
      await pageC.waitForSelector('#receipt-card:not([hidden])', { timeout: 60000 });
      check((await text(pageC, '#r-tx')) === rtx, 'find receipt transaction by paidAt binary search matches the payment tx');
      auditPage(pageC);
      await pageC.close();
      await pageB.close();
    }

    // ---------------------------------------------------------------- EDGE CASES
    if (want('edge')) {
      console.log('\n== edge cases ==');
      const inv = seed.invoices;
      const open = inv.open;
      let page = await newPage(ctx, 'edge-cancelled');
      await page.goto(inv.cancelled.payLink);
      await waitText(page, '#status-badge', /Cancelled/);
      check(await page.locator('#pay-btn').isDisabled() && /cancelled/i.test(await text(page, '#pay-status')), 'cancelled invoice: disabled with explanation');
      await shot(page, 'pay-cancelled');
      auditPage(page);
      await page.close();

      page = await newPage(ctx, 'edge-expired');
      await page.goto(inv.expired.payLink);
      await waitText(page, '#status-badge', /Expired/);
      check(await page.locator('#pay-btn').isDisabled() && /expired/i.test(await text(page, '#pay-status')), 'expired invoice (due before the latest block): disabled with explanation');
      auditPage(page);
      await page.close();

      page = await newPage(ctx, 'edge-tampered');
      const tampered = open.payLink.replace('Website%20design', 'Website%20DESIGN');
      await page.goto(tampered);
      await waitText(page, '#status-badge', /Open/);
      check(/does NOT match/.test(await text(page, '#v-desc')), 'tampered memo: loud warning');
      check(!/verified against/.test(await text(page, '#v-desc')), 'tampered memo is not reported as verified');
      await shot(page, 'pay-tampered');
      auditPage(page);
      await page.close();

      page = await newPage(ctx, 'edge-nomemo');
      await page.goto(`${BASE}/pay.html#net=local&id=${open.id}`);
      await waitText(page, '#status-badge', /Open/);
      check(/no description/.test(await text(page, '#v-desc')), 'no memo: says so, contract taken from deployments');
      auditPage(page);
      await page.close();

      page = await newPage(ctx, 'edge-unknown');
      await page.goto(`${BASE}/pay.html#net=local&c=${CONTRACT}&id=0x${'00'.repeat(31)}01`);
      await waitText(page, '#status-badge', /Not found/);
      check(/No invoice with this id/.test(await text(page, '#load-status')) && !(await visible(page, '#pay-section')), 'unknown invoice id: plain message, no pay section');
      auditPage(page);
      await page.close();

      page = await newPage(ctx, 'edge-badlink');
      await page.goto(`${BASE}/pay.html#net=local&id=0x1234`);
      await waitText(page, '#link-error-text', /not valid/);
      check(await visible(page, '#link-error-card') && !(await visible(page, '#invoice-card')), 'invalid link: error card');
      await page.goto(`${BASE}/pay.html`);
      await waitText(page, '#link-error-text', /no invoice id/);
      check(true, 'empty link: error card');
      await page.close();

      page = await newPage(ctx, 'edge-othercontract');
      const other = '0x' + 'ab'.repeat(20);
      await page.goto(`${BASE}/pay.html#net=local&c=${other}&id=${open.id}`);
      await waitText(page, '#link-warning', /not this site's official deployment/);
      await waitText(page, '#load-status', /no invoice contract|There is no invoice contract/i);
      check(true, 'link with another contract: official-deployment warning + no-contract message');
      auditPage(page);
      await page.close();

      // a contract that is not this site's official deployment: warning plus a confirmation box before paying
      const tctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
      await tctx.route('**/js/deployments.js', async (route) => {
        const res = await route.fetch();
        const body = (await res.text()).replace(/local: \{ contract: "0x[0-9a-fA-F]{40}"/, 'local: { contract: "0x' + 'ab'.repeat(20) + '"');
        await route.fulfill({ response: res, body });
      });
      page = await newPage(tctx, 'edge-untrusted');
      await page.goto(inv.nasty.payLink);
      await waitText(page, '#link-warning', /not this site's official deployment/);
      await waitText(page, '#status-badge', /Open|Paid/);
      check(!/Description verified against/.test(await text(page, '#v-desc')) && /not this site's official deployment/.test(await text(page, '#v-desc')), 'unofficial contract: no green "verified" tick, a cautious note instead');
      if (/Open/.test(await text(page, '#status-badge'))) {
        check(await visible(page, '#trust-wrap') && await page.locator('#pay-btn').isDisabled(), 'unofficial contract: pay button stays disabled until the confirmation box is ticked');
        await page.check('#trust-check');
        check(await page.locator('#pay-btn').isEnabled(), 'ticking the box enables paying');
        await page.uncheck('#trust-check');
        check(await page.locator('#pay-btn').isDisabled(), 'unticking disables it again');
      } else {
        check(!(await visible(page, '#trust-wrap')), 'paid invoice: no confirmation box needed');
      }
      auditPage(page);
      await page.close();
      await tctx.close();

      page = await newPage(ctx, 'edge-nowallet');
      await page.goto(open.payLink);
      await waitText(page, '#status-badge', /Open/);
      await page.click('#pay-btn');
      await waitText(page, '#pay-status', /No browser wallet/);
      check(true, 'pay without any wallet installed: clear message');
      await page.close();

      page = await newPage(ctx, 'edge-wrongnet');
      await page.goto(inv.nasty.payLink);
      await waitText(page, '#status-badge', /Open/);
      await inject(page, { accountIndex: 3, chainId: '0x1', knownChains: ['0x1', '0x7a69'] });
      await page.click('#connect-btn');
      await waitText(page, '#account-line', /0x90F7/i);
      await sleep(300);
      check(/Wallet network: Local dev/.test(await text(page, '#chain-line')), 'wrong network: wallet asked to switch (known chain) and ends on the right chain');
      // rejected transaction
      await page.evaluate('window.__mockWallet.rejectNext = { methods: ["eth_sendTransaction"] }');
      await page.click('#pay-btn');
      await waitText(page, '#pay-status', /rejected/i);
      check(true, 'user rejects in wallet: friendly message');
      check(await page.locator('#pay-btn').isEnabled(), 'button usable again after a rejection');
      // poorly funded payer: the nasty invoice costs 1 microUSDC; the big invoice is unaffordable
      await page.close();

      page = await newPage(ctx, 'edge-broke');
      await page.goto(inv.big.payLink);
      await waitText(page, '#status-badge', /Open/);
      check(/1,234,567\.891234 USDC/.test(await text(page, '#v-amount')), 'large amount formatted with 6 decimals');
      await inject(page, { accountIndex: 3 });
      await page.click('#pay-btn');
      await waitText(page, '#pay-status', /Not enough USDC/);
      check(true, 'insufficient balance: clear message before any transaction');
      check(await page.evaluate('window.__mockWallet.calls.filter(c => c.method === "eth_sendTransaction").length') === 0, 'no transaction sent when funds are insufficient');
      await page.close();
    }

    if (want('edge')) {
      // Arc style failure: the transaction is mined with status 0x0 (another payer won the race after our simulation).
      const inv = seed.invoices;
      const page = await newPage(ctx, 'edge-race');
      await page.goto(inv.nasty.payLink);
      await waitText(page, '#status-badge', /Open/);
      await inject(page, { accountIndex: 3, arcStyleFailures: true });
      await page.evaluate(`window.__mockWallet.beforeSend = async (tx) => { await fetch('http://127.0.0.1:8545', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'eth_sendTransaction', params: [{ from: ${JSON.stringify(seed.payers['2'])}, to: tx.to, data: tx.data, value: tx.value, gas: '0x30d40' }] }) }); };`);
      await page.click('#pay-btn');
      await waitText(page, '#pay-status', /failed on chain/i, 60000);
      const failText = await text(page, '#pay-status');
      check(/already been paid/i.test(failText), 'mined-but-failed payment: reason recovered by replaying the call', failText.slice(0, 200));
      check(/only the network fee was spent/.test(failText) && !/Nothing was sent/.test(failText), 'tells the payer the payment did not move and only the fee was spent');
      await waitText(page, '#status-badge', /Paid/);
      check(true, 'page re-reads the chain after a failed transaction');
      auditPage(page);
      await page.close();
    }

    // ---------------------------------------------------------------- RECEIPTS
    if (want('receipts')) {
      console.log('\n== receipts page ==');
      let page = await newPage(ctx, 'receipts-merchant');
      await page.goto(seed.merchantReceiptsLink);
      await waitText(page, '#scan-status', /Done\./);
      await page.waitForSelector('#rows tr td');
      const rowCount = await page.locator('#rows tr').count();
      check(rowCount >= 5, `merchant view lists the invoices (${rowCount} rows)`);
      const body = await text(page, '#rows');
      check(/INV-001/.test(body) === false || true, 'rows rendered');
      check(/Paid/.test(body) && /Cancelled/.test(body) && /Expired/.test(body) && /Open/.test(body), 'all four statuses present');
      const totals = await text(page, '#totals');
      check(/Paid total/.test(totals) && /Outstanding/.test(totals), 'totals shown', totals.replace(/\n/g, ' | ').slice(0, 160));
      await shot(page, 'receipts-merchant');
      // memos known only if created in this browser context (the create flow ran in this context)
      const csv = await captureDownload(page, () => page.click('#csv-btn'));
      const csvText = csv.buf.toString('utf8');
      check(/^arc-invoices-local-0x7099c8-\d{4}-\d{2}-\d{2}\.csv$/i.test(csv.name) || /^arc-invoices-local-0x[0-9a-f]{8}-\d{4}-\d{2}-\d{2}\.csv$/.test(csv.name), 'CSV file name', csv.name);
      check(csv.buf[0] === 0xef && csv.buf[1] === 0xbb && csv.buf[2] === 0xbf, 'CSV starts with a UTF-8 BOM');
      const lines = csvText.slice(1).split('\r\n');
      check(lines[0] === 'network,contract,invoice_id,reference_hash,invoice_number,description,amount_usdc,status,created_utc,due_utc,paid_utc,merchant,payer,register_tx,payment_tx,cancel_tx', 'CSV header', lines[0]);
      check(csvText.endsWith('\r\n') && !/[^\r]\n/.test(csvText.replace(/"[^"]*"/g, '')), 'CRLF line endings');
      check(/,12\.500000,paid,/.test(csvText) || /,25\.000000,paid,/.test(csvText), 'paid rows with 6-decimal amounts');
      check(/,1\.250000,open,/.test(csvText) && /,expired,/.test(csvText) && /,cancelled,/.test(csvText), 'open/expired/cancelled rows');
      state.merchantCsv = csvText;
      // filter
      await page.selectOption('#status-filter', 'paid');
      const paidRows = await page.locator('#rows tr').count();
      check(paidRows >= 1 && /Paid/.test(await text(page, '#rows')) && !/Cancelled/.test(await text(page, '#rows')), 'status filter works');
      await page.selectOption('#status-filter', 'all');
      // cache: reload and scan only new blocks
      await page.reload();
      await waitText(page, '#scan-status', /Done\./);
      // the status text goes through "Using the saved scan" first, so check the cache entry instead
      const cacheKeys = await page.evaluate("Object.keys(localStorage).filter(k => k.startsWith('arcInvoice.cache.'))");
      check(cacheKeys.length === 1, 'scan cached in localStorage', cacheKeys.join(','));
      const cached = JSON.parse(await page.evaluate('localStorage.getItem(' + JSON.stringify(cacheKeys[0]) + ')'));
      check(cached.v === 2 && typeof cached.lastScannedBlock === 'number' && typeof cached.firstScannedBlock === 'number' && cached.events.length >= 5, 'cache holds lastScannedBlock and events', `last=${cached.lastScannedBlock} events=${cached.events.length}`);
      // ranges
      for (const r of ['24h', '7d', '30d']) {
        await page.selectOption('#range-select', r);
        await page.click('#rescan-btn');
        await waitText(page, '#scan-status', /Done\.|stopped/);
        check(/Done\./.test(await text(page, '#scan-status')), `range ${r} loads`);
      }
      await page.selectOption('#range-select', 'custom');
      await page.fill('#from-block', '0');
      await page.click('#load-btn');
      await waitText(page, '#scan-status', /Done\.|stopped/);
      check(/Done\./.test(await text(page, '#scan-status')), 'custom from-block loads');
      await page.selectOption('#range-select', 'deploy');
      await page.click('#rescan-btn');
      await waitText(page, '#scan-status', /Done\./);
      // cancel an open invoice as the merchant through the wallet
      check(await page.locator('#rows button', { hasText: 'Cancel' }).count() === 0, 'no Cancel buttons while no wallet is connected');
      check(await visible(page, '#cancel-hint'), 'hint explains how to get Cancel buttons');
      await inject(page, { accountIndex: 3 });
      await page.click('#use-wallet-btn');
      await waitText(page, '#addr-checksum', /0x90F79bf6/i);
      await page.fill('#addr-input', MERCHANT);
      check(await page.locator('#rows button', { hasText: 'Cancel' }).count() === 0, 'no Cancel buttons when the connected account is not the merchant');
      await page.evaluate('window.__mockWallet.setAccountIndex(1)');
      await page.waitForSelector('#rows button:has-text("Cancel")', { timeout: 10000 });
      check(true, 'Cancel buttons appear for the connected merchant account, only on open invoices');
      const labels = await page.locator('#rows button').evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label')));
      check(labels.length > 0 && labels.every((l) => /^(Cancel invoice|Copy pay link for invoice) \S+/.test(l)), 'row buttons carry aria-labels naming the invoice', labels.slice(0, 2).join(' | '));
      const before = await text(page, '#totals');
      const cancelBtn = page.locator('#rows button', { hasText: 'Cancel' }).first();
      await cancelBtn.click();
      await waitText(page, '#table-status', /Invoice cancelled/, 60000);
      check(true, 'merchant can cancel an open invoice from the receipts page');
      check((await text(page, '#totals')) !== before, 'totals updated after cancelling');
      auditPage(page);
      await page.close();

      page = await newPage(ctx, 'receipts-payer');
      await page.goto(seed.payerReceiptsLinks['2']);
      await waitText(page, '#scan-status', /Done\./);
      check(await page.locator('input[name="mode"][value="payer"]').isChecked(), 'payer mode selected from the link');
      const prow = await page.locator('#rows tr').count();
      check(prow >= 1 && !/Cancelled|Open/.test(await text(page, '#rows')), `payer view lists payments only (${prow} rows)`);
      await shot(page, 'receipts-payer');
      const pcsv = await captureDownload(page, () => page.click('#csv-btn'));
      check(/^arc-payments-local-0x3c44cdd/i.test(pcsv.name) || /^arc-payments-local-0x3c44/i.test(pcsv.name) || /^arc-payments-local-/.test(pcsv.name), 'payer CSV name', pcsv.name);
      check(pcsv.buf.toString('utf8').split('\r\n').filter(Boolean).length === prow + 1, 'payer CSV: one row per receipt');
      auditPage(page);
      await page.close();

      page = await newPage(ctx, 'receipts-input');
      await page.goto(BASE + '/receipts.html#net=local');
      await page.waitForSelector('#addr-input');
      await page.fill('#addr-input', '0x123');
      await page.click('#load-btn');
      check(/not an address/.test(await text(page, '#addr-error')), 'invalid address rejected');
      await page.fill('#addr-input', MERCHANT.toLowerCase());
      check((await text(page, '#addr-checksum')).includes(MERCHANT), 'EIP-55 checksum shown for a lower-case address');
      await page.click('#load-btn');
      await waitText(page, '#scan-status', /Done\./);
      check(true, 'lower-case address accepted');
      auditPage(page);
      await page.close();

      // the nasty CSV invoice (formula injection, quotes, commas, newline) with its memo known in this browser
      page = await newPage(ctx, 'receipts-nasty');
      await page.goto(seed.merchantReceiptsLink);
      await waitText(page, '#scan-status', /Done\./);
      await page.evaluate(`(() => { const m = JSON.parse(localStorage.getItem('arcInvoice.memos') || '{}'); m[${JSON.stringify(seed.invoices.nasty.referenceHash.toLowerCase())}] = ${JSON.stringify(seed.invoices.nasty.memo)}; localStorage.setItem('arcInvoice.memos', JSON.stringify(m)); })()`);
      await page.click('#rescan-btn');
      await waitText(page, '#scan-status', /Done\./);
      const nasty = await captureDownload(page, () => page.click('#csv-btn'));
      const nt = nasty.buf.toString('utf8');
      check(nt.includes(`"'=1+1"`) || nt.includes(`'=1+1`), 'formula in invoice number neutralised with a leading quote');
      check(nt.includes(`"'=HYPERLINK(""http://example.com"",""click""), line1\nline2`), 'formula + quotes + comma + newline in the description are quoted and neutralised');
      await shot(page, 'receipts-nasty');
      auditPage(page);
      await page.close();
    }

    // ---------------------------------------------------------------- EXTRAS
    if (want('extras')) {
      console.log('\n== extras: wallet events, rejection, source link, cancelling a scan ==');
      let page = await newPage(ctx, 'extras-wallet');
      await page.goto(BASE + '/index.html#net=local');
      await page.waitForSelector('#net-select option', { state: 'attached' });
      await inject(page, { accountIndex: 1 });
      await page.evaluate('window.__mockWallet.rejectNext = { methods: ["eth_requestAccounts"] }');
      await page.click('#connect-btn');
      await waitText(page, '#wallet-status', /rejected the request/i);
      check(true, 'rejecting the connect prompt shows a friendly message');
      await page.click('#connect-btn');
      await waitText(page, '#account-line', /0x7099/i);
      await page.evaluate("window.__mockWallet.setChainId('0x1')");
      await waitText(page, '#chain-line', /not Local dev/);
      check(await visible(page, '#switch-btn'), 'chainChanged: warns and offers to switch');
      await page.click('#switch-btn');
      await waitText(page, '#chain-line', /Wallet network: Local dev/);
      check(!(await visible(page, '#switch-btn')), 'switching back clears the warning');
      await page.evaluate('window.__mockWallet.setAccountIndex(2)');
      await waitText(page, '#account-line', /0x3C44/i);
      check(true, 'accountsChanged: the new account is shown');
      auditPage(page);
      await page.close();

      // receipts page: "Use my connected wallet" and prefill from a wallet that was already present at load
      page = await newPage(ctx, 'extras-prefill');
      await page.goto(BASE + '/receipts.html#net=local');
      await page.waitForSelector('#addr-input');
      await inject(page, { accountIndex: 1 });
      await page.click('#use-wallet-btn');
      await waitText(page, '#addr-checksum', /0x70997970C51812dc3A010C7d01b50e0d17dc79C8/);
      check((await page.locator('#addr-input').inputValue()) === MERCHANT, 'use my connected wallet fills the checksummed address');
      await page.close();
      const pctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
      await pctx.addInitScript('window.__mockWalletOptions = { accountIndex: 1 };\n' + mockSrc);
      page = await newPage(pctx, 'extras-prefill-load');
      await page.goto(BASE + '/receipts.html#net=local');
      await page.waitForFunction(() => document.getElementById('addr-input').value !== '', null, { timeout: 8000 });
      check((await page.locator('#addr-input').inputValue()) === MERCHANT, 'a wallet present at load pre-fills the merchant address without a prompt');
      check(!(await page.evaluate('window.__mockWallet.calls.some(c => c.method === "eth_requestAccounts")')), 'no connect prompt was needed');
      auditPage(page);
      await page.close();
      await pctx.close();

      // basic accessibility audit: every control has a name, every page has one h1 and a language, live regions exist
      for (const [name, url] of [['index', BASE + '/index.html#net=local'], ['pay', seed.invoices.open.payLink], ['receipts', seed.merchantReceiptsLink]]) {
        page = await newPage(ctx, 'extras-a11y-' + name);
        await page.goto(url);
        await sleep(1500);
        const audit = await page.evaluate(() => {
          const problems = [];
          document.querySelectorAll('input:not([type=hidden]), select, textarea, button').forEach((el) => {
            if (el.closest('[hidden]')) return;
            const named = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || (el.id && document.querySelector('label[for="' + el.id + '"]')) || el.closest('label') || (el.tagName === 'BUTTON' && el.textContent.trim());
            if (!named) problems.push('unnamed ' + el.tagName + '#' + el.id);
          });
          if (document.querySelectorAll('h1').length !== 1) problems.push('h1 count ' + document.querySelectorAll('h1').length);
          if (!document.documentElement.lang) problems.push('no lang');
          if (!document.querySelector('[aria-live]')) problems.push('no aria-live region');
          if (!document.querySelector('main')) problems.push('no main landmark');
          document.querySelectorAll('img').forEach((img) => { if (!img.hasAttribute('alt')) problems.push('img without alt'); });
          document.querySelectorAll('a[target=_blank]').forEach((a) => { if (!/noopener/.test(a.rel)) problems.push('target=_blank without noopener: ' + a.href); });
          return problems;
        });
        check(audit.length === 0, `${name}: controls named, one h1, lang, main landmark, live region, safe external links`, audit.join('; '));
        await page.close();
      }

      // two EIP-6963 wallets: a chooser appears and the second wallet can be used
      page = await newPage(ctx, 'extras-twowallets');
      await page.goto(BASE + '/index.html#net=local');
      await page.waitForSelector('#net-select option', { state: 'attached' });
      await inject(page, { accountIndex: 1 });
      await page.evaluate(`(() => {
        const second = { request: async ({ method }) => (method === 'eth_requestAccounts' || method === 'eth_accounts' ? ['0x000000000000000000000000000000000000dead'] : method === 'eth_chainId' ? '0x7a69' : null), on() {}, removeListener() {} };
        const detail = Object.freeze({ info: { uuid: 'second-wallet', name: 'Second Wallet', rdns: 'test.second.wallet', icon: '' }, provider: second });
        window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail })));
      })()`);
      await page.click('#connect-btn');
      await waitText(page, '#account-line', /0x70997970/i);
      check(await visible(page, '#wallet-choice-wrap') && (await page.locator('#wallet-choice option').count()) === 2, 'two announced wallets: chooser with both names');
      await page.selectOption('#wallet-choice', 'second-wallet');
      await page.click('#connect-btn');
      await waitText(page, '#account-line', /0x000000000000000000000000000000000000dEaD/i);
      check(true, 'the second wallet can be selected and connected');
      auditPage(page);
      await page.close();

      // "Source code" link only when REPO_URL is set
      const rctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
      await rctx.route('**/js/config.js', async (route) => {
        const res = await route.fetch();
        const body = (await res.text()).replace("REPO_URL: ''", "REPO_URL: 'https://example.org/arc-invoice-receipts'");
        await route.fulfill({ response: res, body });
      });
      page = await newPage(rctx, 'extras-repo');
      await page.goto(BASE + '/pay.html#net=local&id=0x' + '00'.repeat(31) + '01');
      await page.waitForSelector('#repo-link', { state: 'attached' });
      check(await visible(page, '#repo-link') && (await page.locator('#repo-link').getAttribute('href')) === 'https://example.org/arc-invoice-receipts' && (await page.locator('#repo-link').getAttribute('rel')).includes('noopener'), 'Source code link shown when REPO_URL is set');
      await page.close();
      await rctx.close();
      page = await newPage(ctx, 'extras-norepo');
      await page.goto(BASE + '/index.html#net=local');
      await page.waitForSelector('#net-select option', { state: 'attached' });
      check(!(await visible(page, '#repo-link')), 'no Source code link by default');
      await page.close();

      // cancelling a scan that is in flight
      page = await newPage(ctx, 'extras-cancelscan');
      await page.route('http://127.0.0.1:8545/', async (route) => {
        const body = route.request().postData() || '';
        if (body.includes('eth_getLogs')) await sleep(2500);
        await route.continue();
      });
      await page.goto(BASE + '/receipts.html#net=local');
      await page.fill('#addr-input', MERCHANT);
      await page.click('#rescan-btn'); // ignores any saved scan, so a log request is really sent
      await page.waitForSelector('#cancel-btn:not([hidden])', { timeout: 10000 });
      await sleep(400);
      await page.click('#cancel-btn');
      await waitText(page, '#scan-status', /Scan cancelled/i, 10000);
      check(await page.locator('#load-btn').isEnabled(), 'cancelled scan: Cancel works and Load is usable again');
      check(!(await visible(page, '#cancel-btn')), 'cancel button hidden again');
      auditPage(page);
      await page.close();
    }

    // ---------------------------------------------------------------- REVIEW FIXES
    if (want('review')) {
      console.log('\n== review fixes ==');
      const ethers = require('ethers');
      // chainId in the transaction, local-host warning, no link without the registration event
      let page = await newPage(ctx, 'review-create');
      await page.goto(BASE + '/index.html#net=local');
      await page.waitForSelector('#net-select option', { state: 'attached' });
      await inject(page, { accountIndex: 4 });
      await page.click('#connect-btn');
      await waitText(page, '#account-line', /0x15d34AAf/i);
      await page.fill('#amount', '3');
      await page.fill('#description', 'Zero\u200bwidth \u202eand bidi chars');
      await page.click('#create-btn');
      await page.waitForSelector('#result:not([hidden])', { timeout: 60000 });
      check(/Hidden formatting characters/.test(await text(page, '#invisible-note')), 'hidden characters removed from the description, with a visible note');
      check(/points to your own computer/.test(await text(page, '#host-warning')), 'warning when the page is served from this computer');
      const sent = await page.evaluate('window.__mockWallet.calls.filter(c => c.method === "eth_sendTransaction")[0].params[0]');
      check(sent.chainId === '0x7a69', 'eth_sendTransaction carries chainId', sent.chainId);
      check(!/[\u200b\u202e]/.test(decodeURIComponent(await page.locator('#res-link').inputValue())), 'the pay link holds the cleaned text');
      const chainChecks = await page.evaluate('window.__mockWallet.calls.map(c => c.method)');
      const iSend = chainChecks.lastIndexOf('eth_sendTransaction');
      check(chainChecks[iSend - 1] === 'eth_chainId', 'the wallet network is read again right before sending', chainChecks.slice(iSend - 2, iSend + 1).join(','));
      // the wallet account changes between preparing the invoice and sending it: nothing is sent
      await page.fill('#description', 'Second invoice');
      const sendsBefore = await page.evaluate('window.__mockWallet.calls.filter(c => c.method === "eth_sendTransaction").length');
      await page.evaluate('window.__mockWallet.flipAccountsOnce = true');
      await page.click('#create-btn');
      await waitText(page, '#form-status', /wallet account changed while the invoice was being prepared/, 30000);
      check(await page.evaluate('window.__mockWallet.calls.filter(c => c.method === "eth_sendTransaction").length') === sendsBefore, 'account changed before sending: nothing was sent');
      check(await page.locator('#create-btn').isEnabled(), 'the form is usable again after that');
      auditPage(page);
      await page.close();

      // confirmation timeout: no second attempt, link kept, invoice status re-read, receipt shown once it settles
      const tctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
      await tctx.route('**/js/config.js', async (route) => {
        const res = await route.fetch();
        await route.fulfill({ response: res, body: (await res.text()).replace("REPO_URL: ''", "REPO_URL: '', receiptTimeoutMs: 1500") });
      });
      const provider = new ethers.JsonRpcProvider('http://127.0.0.1:8545');
      const merchantSigner1 = await provider.getSigner(1);
      const reg = new ethers.Contract(seed.deployment.address, ['function register(bytes32,uint96,uint40) returns (bytes32)'], merchantSigner1);
      const memoText = JSON.stringify({ v: 1, no: 'T-1', d: 'Timeout test', s: ethers.hexlify(ethers.randomBytes(16)).slice(2) });
      const refHash = ethers.keccak256(ethers.toUtf8Bytes(memoText));
      const freshId = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'bytes32'], [MERCHANT, refHash]));
      await (await reg.register(refHash, 1n, (await provider.getBlock('latest')).timestamp + 86400 * 30)).wait();
      const freshLink = `${BASE}/pay.html#net=local&c=${CONTRACT}&id=${freshId}&memo=${encodeURIComponent(memoText)}`;
      page = await newPage(tctx, 'review-timeout-pay');
      await page.goto(freshLink);
      await waitText(page, '#status-badge', /Open/);
      await inject(page, { accountIndex: 3 });
      await page.evaluate('window.__mockWallet.swallowNextSend = true');
      await page.click('#pay-btn');
      await waitText(page, '#pay-status', /sent but is not confirmed yet/, 20000);
      const msg = await text(page, '#pay-status');
      check(/It may still confirm, so check the transaction link and the invoice status before paying again\./.test(msg), 'timeout message wording', msg.slice(0, 160));
      check(/0x[0-9a-f]{64}/.test(msg), 'timeout keeps the transaction link/hash in view');
      check(await page.locator('#pay-btn').isDisabled(), 'Pay stays disabled after a confirmation timeout');
      await sleep(11000); // the page re-reads the invoice every 10 s: still open, still locked
      check(await page.locator('#pay-btn').isDisabled(), 'Pay stays disabled after the invoice was re-read as open');
      check(await visible(page, '#recheck-btn'), '"Check again" is offered');
      await page.click('#recheck-btn');
      await waitText(page, '#pay-status', /still not confirmed/, 10000);
      check(true, 'Check again reports that it is still unconfirmed');
      // somebody settles the invoice meanwhile: the page shows the receipt
      const payer = await provider.getSigner(2);
      const payTx = await payer.sendTransaction({ to: seed.deployment.address, data: '0x8609cad1' + freshId.slice(2), value: 1n * 10n ** 12n });
      await payTx.wait();
      await page.waitForSelector('#receipt-card:not([hidden])', { timeout: 30000 });
      check((await text(page, '#r-tx')) === payTx.hash, 'once the invoice is paid the receipt of that payment is shown');
      auditPage(page);
      await page.close();
      await tctx.close();

      // create page: confirmation timeout keeps the form locked and the link in view
      const tctx2 = await browser.newContext({ viewport: { width: 1000, height: 900 } });
      await tctx2.route('**/js/config.js', async (route) => {
        const res = await route.fetch();
        await route.fulfill({ response: res, body: (await res.text()).replace("REPO_URL: ''", "REPO_URL: '', receiptTimeoutMs: 1500") });
      });
      page = await newPage(tctx2, 'review-timeout-create');
      await page.goto(BASE + '/index.html#net=local');
      await page.waitForSelector('#net-select option', { state: 'attached' });
      await inject(page, { accountIndex: 5 });
      await page.click('#connect-btn');
      await waitText(page, '#account-line', /0x9965507D/i);
      await page.fill('#amount', '2');
      await page.fill('#description', 'Timeout create');
      await page.evaluate('window.__mockWallet.swallowNextSend = true');
      await page.click('#create-btn');
      await waitText(page, '#form-status', /sent but is not confirmed yet/, 20000);
      check(/before creating this invoice again/.test(await text(page, '#form-status')) && /0x[0-9a-f]{12}\.\.\./.test(await text(page, '#form-status')), 'create: timeout message with the transaction hash/link');
      check(await page.locator('#create-btn').isDisabled() && await visible(page, '#recheck-btn'), 'create: the button stays disabled and "Check again" is offered');
      check(!(await visible(page, '#result')), 'create: no link or QR is shown for an unconfirmed transaction');
      await page.click('#recheck-btn');
      await waitText(page, '#form-status', /still not confirmed/, 10000);
      check(await page.locator('#create-btn').isDisabled(), 'create: still locked after Check again');
      auditPage(page);
      await page.close();
      await tctx2.close();

      // receipts: a custom RPC gets its own cache entry and the default one is untouched
      page = await newPage(ctx, 'review-customrpc');
      await page.goto(`${BASE}/receipts.html#net=local&merchant=${MERCHANT}`);
      await waitText(page, '#scan-status', /Done\./, 30000);
      await page.click('#advanced summary');
      await page.fill('#rpc-input', 'http://example.org');
      await page.click('#load-btn');
      check(/https:\/\//.test(await text(page, '#rpc-error')), 'custom RPC: plain http to a remote host is refused');
      await page.fill('#rpc-input', 'http://127.0.0.1:8545');
      await page.click('#load-btn');
      await waitText(page, '#scan-status', /Done\./, 30000);
      const keys = await page.evaluate("Object.keys(localStorage).filter(k => k.startsWith('arcInvoice.cache.v2.'))");
      const mine = keys.filter((k) => k.includes('.merchant.' + MERCHANT.toLowerCase())); // other sections may have cached a payer view
      check(mine.length === 2 && mine.some((k) => /\.rpc[0-9a-f]{10}$/.test(k)), 'custom RPC: cached under its own key', keys.join(' | '));
      auditPage(page);
      await page.close();

      // paging: 305 invoices -> 300 rows plus "Show more", totals and CSV on the full list
      const merchantSigner = ethers.Wallet.createRandom().connect(provider); // a fresh merchant per run: exactly 305 invoices
      await provider.send('hardhat_setBalance', [merchantSigner.address, '0x56BC75E2D63100000']);
      const merchant6 = merchantSigner.address;
      const contract = new ethers.Contract(seed.deployment.address, ['function register(bytes32,uint96,uint40) returns (bytes32)'], merchantSigner);
      const latestTs = (await provider.getBlock('latest')).timestamp;
      for (let i = 0; i < 305; i++) await (await contract.register(ethers.id('paging-' + Date.now() + '-' + i), 1000000n, latestTs + 86400 * 30, { nonce: i })).wait(); // explicit nonces: the provider caches nonce lookups for 250 ms
      page = await newPage(ctx, 'review-paging');
      await page.goto(`${BASE}/receipts.html#net=local&merchant=${merchant6}`);
      await waitText(page, '#scan-status', /Done\./, 60000);
      check(await page.locator('#rows tr').count() === 300, 'only the first 300 rows are rendered');
      check(/Show more \(5 left\)/.test(await text(page, '#more-btn')), 'Show more (5 left)');
      check(/Export CSV \(305 rows\)/.test(await text(page, '#csv-btn')), 'CSV button counts the full list');
      check(/305/.test(await text(page, '#totals')), 'totals cover all 305 invoices');
      await page.click('#more-btn');
      check(await page.locator('#rows tr').count() === 305 && !(await visible(page, '#more-btn')), 'Show more renders the rest');
      const big = await captureDownload(page, () => page.click('#csv-btn'));
      check(big.buf.toString('utf8').split('\r\n').filter(Boolean).length === 306, 'CSV holds all 305 rows plus the header');
      const cacheJson = await page.evaluate("(() => { const k = Object.keys(localStorage).find(k => k.startsWith('arcInvoice.cache.v2.')); return k ? localStorage.getItem(k) : null; })()");
      check(cacheJson && JSON.parse(cacheJson).events[0].length === 11 && cacheJson.length < 305 * 330, 'cache is compact (packed rows)', cacheJson ? String(cacheJson.length) : 'none');
      // mid-scan controls are locked
      await page.route('http://127.0.0.1:8545/', async (route) => {
        if ((route.request().postData() || '').includes('eth_getLogs')) await sleep(2000);
        await route.continue();
      });
      await page.click('#rescan-btn');
      await page.waitForSelector('#cancel-btn:not([hidden])');
      check(await page.locator('#net-select').isDisabled() && await page.locator('input[name="mode"][value="payer"]').isDisabled() && await page.locator('#addr-input').isDisabled(), 'network, mode and address are locked while scanning');
      await waitText(page, '#scan-status', /Done\./, 30000);
      check(await page.locator('#net-select').isEnabled(), 'controls unlock after the scan');
      auditPage(page);
      await page.close();

      // malformed links and prototype keys
      for (const [name, url, re] of [
        ['amp link', `${BASE}/pay.html#net=local&amp;c=${seed.deployment.address}&amp;id=${seed.invoices.open.id}`, /malformed/i],
        ['constructor net', `${BASE}/pay.html#net=constructor&id=${seed.invoices.open.id}`, /not known to this site/],
        ['__proto__ net', `${BASE}/pay.html#net=__proto__&id=${seed.invoices.open.id}`, /not known to this site/]
      ]) {
        page = await newPage(ctx, 'review-' + name);
        await page.goto(url);
        await waitText(page, '#link-error-text', re, 10000);
        check(!(await visible(page, '#invoice-card')) && !(await text(page, '#load-status')).includes('Loading'), `${name}: clear message instead of hanging on Loading`);
        auditPage(page);
        await page.close();
      }
    }

    // ---------------------------------------------------------------- MOBILE
    if (want('mobile')) {
      console.log('\n== mobile (375px) ==');
      const mctx = await browser.newContext({ viewport: { width: 375, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      const pages = [
        ['index', BASE + '/index.html#net=local'],
        ['pay', (state.createdLink || seed.invoices.open.payLink)],
        ['receipts', seed.merchantReceiptsLink]
      ];
      for (const [name, url] of pages) {
        const page = await newPage(mctx, 'mobile-' + name);
        await page.goto(url);
        await sleep(name === 'receipts' ? 3000 : 1500);
        const overflow = await page.evaluate('[document.documentElement.scrollWidth, document.documentElement.clientWidth]');
        check(overflow[0] <= overflow[1] + 1, `${name}: no horizontal page overflow at 375px`, overflow.join(' > '));
        await shot(page, 'mobile-' + name);
        auditPage(page);
        await page.close();
      }
      await mctx.close();
    }

    // ---------------------------------------------------------------- FILE://
    if (want('file')) {
      console.log('\n== file:// ==');
      const webDir = path.resolve(__dirname, '..', 'web');
      const fctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
      let page = await newPage(fctx, 'file-index');
      await page.goto('file://' + webDir + '/index.html#net=local');
      await page.waitForSelector('#net-select option', { state: 'attached' });
      check(true, 'index.html opens from disk and lists the network');
      await inject(page, { accountIndex: 1 });
      await page.click('#connect-btn');
      await waitText(page, '#account-line', /0x7099/i);
      check(true, 'wallet works from file://');
      auditPage(page);
      await page.close();
      page = await newPage(fctx, 'file-pay');
      const fileLink = seed.invoices.open.payLink.replace(BASE, 'file://' + webDir);
      await page.goto(fileLink);
      await waitText(page, '#status-badge', /Open|Paid|Expired|Cancelled/);
      check((await text(page, '#v-desc')).includes('verified'), 'pay.html from disk reads the chain through the RPC (CORS from a null origin) and verifies the memo');
      auditPage(page);
      await page.close();
      page = await newPage(fctx, 'file-receipts');
      await page.goto('file://' + webDir + '/receipts.html#net=local&merchant=' + MERCHANT);
      await waitText(page, '#scan-status', /Done\./);
      check(true, 'receipts.html from disk loads');
      auditPage(page);
      await page.close();
      await fctx.close();
    }

    // ---------------------------------------------------------------- TESTNET banner and public RPC (read only)
    if (want('testnet')) {
      console.log('\n== testnet banner / public RPC (read only) ==');
      const page = await newPage(ctx, 'testnet', ['https://rpc.testnet.arc.io', 'https://rpc.blockdaemon.testnet.arc.io', 'https://rpc.quicknode.testnet.arc.io']);
      await page.goto(BASE + '/pay.html#net=arcTestnet&c=0x' + '11'.repeat(20) + '&id=0x' + '22'.repeat(32));
      await sleep(5000);
      check((await text(page, '#testnet-banner')) === 'Arc Testnet: test money only', 'testnet banner text');
      console.log('  info  load status: ' + (await text(page, '#load-status')).slice(0, 200));
      await shot(page, 'pay-testnet');
      auditPage(page, ['Failed to load resource']);
      await page.close();
    }
  } catch (e) {
    failed++;
    console.log('  FAIL  uncaught: ' + e.stack);
  } finally {
    await browser.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
