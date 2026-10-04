#!/usr/bin/env node
'use strict';
/*
 * Local-chain helper for browser tests. Talks ONLY to the hardhat node on http://127.0.0.1:8545 (chainId 31337),
 * using its unlocked accounts (--from <i> = account index, 0..19). Prints JSON; errors go to stderr, exit code 1.
 * The contract address comes from e2e/.local-deployment.json (written by deploy-local.js) or --contract <address>.
 *
 *   node e2e/chain.js now                              latest block timestamp + wall clock
 *   node e2e/chain.js time <seconds>                   evm_increaseTime + evm_mine, prints the new latest block
 *   node e2e/chain.js mine [n]                         mine n empty blocks (default 1)
 *   node e2e/chain.js register --from <i> --amount <usdc, e.g. 1.25> --desc <text> [--no <invoice no>]
 *                              [--days <n> | --due-in <seconds>] [--base URL]      (default due: 14 days)
 *   node e2e/chain.js pay <id> --from <i>              pays exactly the invoice amount (amount * 1e12 native)
 *   node e2e/chain.js cancel <id> --from <i>           merchant only
 *   node e2e/chain.js info <id>                        decoded invoice
 *
 * Also require()-able (seed.js uses it): helpers are exported, main() only runs when executed directly.
 */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const RPC = 'http://127.0.0.1:8545';
const DEPLOYMENT_FILE = path.join(__dirname, '.local-deployment.json');
const ART = require('../artifacts/contracts/InvoiceReceipts.sol/InvoiceReceipts.json');
const STATUS = ['None', 'Open', 'Paid', 'Cancelled'];
const SCALE = 10n ** 12n; // native (18 decimals) per USDC unit (6 decimals)
const MAX_UINT96 = (1n << 96n) - 1n;
const DEFAULT_BASE = 'http://127.0.0.1:8080';
const DAY = 86400;

const iso = (ts) => new Date(Number(ts) * 1000).toISOString();

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      if (eq > 0) opt[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opt[a.slice(2)] = argv[++i];
      else opt[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { pos, opt };
}

function loadDeployment() {
  if (!fs.existsSync(DEPLOYMENT_FILE)) throw new Error('e2e/.local-deployment.json missing: run e2e/deploy-local.js (or pass --contract <address>)');
  return JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, 'utf8'));
}

// Connects to the local node and binds the contract. Fails fast if the node is not hardhat's chain 31337
// or if there is no contract code at the address.
async function connect(opt) {
  const net = ethers.Network.from(31337);
  const provider = new ethers.JsonRpcProvider(RPC, net, { staticNetwork: net, cacheTimeout: -1, batchMaxCount: 1, pollingInterval: 50 });
  try {
    const chainId = Number(await provider.send('eth_chainId', []));
    if (chainId !== 31337) throw new Error('expected chainId 31337 on ' + RPC + ', got ' + chainId);
    const deployment = opt && typeof opt.contract === 'string' ? { address: opt.contract, deployBlock: 0, chainId } : loadDeployment();
    const address = ethers.getAddress(deployment.address);
    if ((await provider.getCode(address)).length <= 2) throw new Error('no contract code at ' + address + ' (node restarted? run e2e/deploy-local.js)');
    const contract = new ethers.Contract(address, ART.abi, provider);
    return { provider, contract, address, deployment: { address, deployBlock: deployment.deployBlock, chainId } };
  } catch (e) {
    provider.destroy();
    throw e;
  }
}

const getSigner = (ctx, i) => {
  const n = Number(i);
  if (!Number.isInteger(n) || n < 0 || n > 19) throw new Error('--from must be an account index 0..19');
  return ctx.provider.getSigner(n);
};

async function latest(provider) {
  const b = await provider.getBlock('latest');
  return { number: b.number, timestamp: b.timestamp, iso: iso(b.timestamp) };
}

async function mine(provider, n) {
  for (let i = 0; i < n; i++) await provider.send('evm_mine', []);
  return latest(provider);
}

async function increaseTime(provider, seconds) {
  await provider.send('evm_increaseTime', [seconds]);
  return mine(provider, 1);
}

function parseUsdc(text) {
  const s = String(text);
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error('amount must be a decimal USDC string with at most 6 decimals, got "' + s + '"');
  const raw = ethers.parseUnits(s, 6);
  if (raw <= 0n || raw > MAX_UINT96) throw new Error('amount out of range (must be > 0 and fit in uint96): ' + s);
  return raw;
}

// memo = JSON.stringify({v:1, no, d, s}) with a fresh 16-byte salt s (32 lowercase hex chars); referenceHash = keccak256(memo bytes)
function buildMemo(no, desc) {
  const s = ethers.hexlify(ethers.randomBytes(16)).slice(2);
  const memo = JSON.stringify({ v: 1, no: String(no), d: String(desc), s });
  return { memo, referenceHash: ethers.keccak256(ethers.toUtf8Bytes(memo)) };
}

const payLinkFor = (base, contract, id, memo) =>
  base + '/pay.html#net=local&c=' + contract + '&id=' + id + '&memo=' + encodeURIComponent(memo);
const receiptsLinkFor = (base, merchant, payer) =>
  base + '/receipts.html#net=local&merchant=' + merchant + (payer ? '&payer=' + payer : '');

function findEvent(ctx, receipt, name) {
  for (const log of receipt.logs) {
    try {
      const parsed = ctx.contract.interface.parseLog(log);
      if (parsed && parsed.name === name) return parsed;
    } catch (e) { /* not ours */ }
  }
  return null;
}

// amount: bigint in 6-decimal USDC units; due: unix seconds.
async function registerInvoice(ctx, signer, { amount, desc, no = '', due, base = DEFAULT_BASE }) {
  base = String(base).replace(/\/+$/, '');
  const merchant = await signer.getAddress();
  const { memo, referenceHash } = buildMemo(no, desc);
  const id = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'bytes32'], [merchant, referenceHash]));
  const tx = await ctx.contract.connect(signer).register(referenceHash, amount, due);
  const rc = await tx.wait();
  const ev = findEvent(ctx, rc, 'InvoiceRegistered');
  if (!ev || ev.args.id !== id) throw new Error('InvoiceRegistered id does not match the locally computed id');
  return {
    id, referenceHash, memo,
    payLink: payLinkFor(base, ctx.address, id, memo),
    receiptsLink: receiptsLinkFor(base, merchant),
    tx: tx.hash, block: rc.blockNumber,
    merchant, no: String(no), desc: String(desc),
    amountUsdc: ethers.formatUnits(amount, 6), amountRaw: amount.toString(), due: Number(due), dueIso: iso(due)
  };
}

async function payInvoice(ctx, signer, id) {
  const inv = await ctx.contract.getInvoice(id);
  const value = inv.amount * SCALE;
  const tx = await ctx.contract.connect(signer).pay(id, { value });
  const rc = await tx.wait();
  return { id, tx: tx.hash, block: rc.blockNumber, payer: await signer.getAddress(), valueWei: value.toString(), amountUsdc: ethers.formatUnits(inv.amount, 6) };
}

async function cancelInvoice(ctx, signer, id) {
  const tx = await ctx.contract.connect(signer).cancel(id);
  const rc = await tx.wait();
  return { id, tx: tx.hash, block: rc.blockNumber, from: await signer.getAddress() };
}

async function invoiceInfo(ctx, id) {
  const inv = await ctx.contract.getInvoice(id);
  const head = await latest(ctx.provider);
  const status = STATUS[Number(inv.status)];
  const due = Number(inv.due);
  const paidAt = Number(inv.paidAt);
  return {
    id, status,
    merchant: inv.merchant, payer: inv.payer,
    referenceHash: inv.referenceHash,
    amountUsdc: ethers.formatUnits(inv.amount, 6), amountRaw: inv.amount.toString(), amountWei: (inv.amount * SCALE).toString(),
    due, dueIso: due ? iso(due) : null,
    paidAt, paidAtIso: paidAt ? iso(paidAt) : null,
    latestBlockTimestamp: head.timestamp,
    expiredAtLatestBlock: status === 'Open' && head.timestamp > due,
    expiredByWallClock: status === 'Open' && Date.now() / 1000 > due
  };
}

// Pulls a revert payload (0x + >= 4 bytes) out of whatever shape ethers/hardhat wrapped it in.
function findRevertData(e, depth) {
  if (!e || depth > 6) return null;
  if (typeof e === 'string') return /^0x[0-9a-fA-F]{8,}$/.test(e) ? e : null;
  if (typeof e !== 'object') return null;
  for (const k of ['data', 'error', 'info', 'cause']) {
    const found = findRevertData(e[k], depth + 1);
    if (found) return found;
  }
  return null;
}

function describeError(e) {
  const out = { error: String((e && (e.shortMessage || e.message)) || e) };
  const data = findRevertData(e, 0);
  if (data) {
    try {
      const parsed = new ethers.Interface(ART.abi).parseError(data);
      if (parsed) {
        out.revert = { name: parsed.name, args: Array.from(parsed.args, (a) => String(a)) };
        out.error = 'reverted with ' + parsed.name + '(' + out.revert.args.join(', ') + ')';
      }
    } catch (err) { /* unknown selector */ }
    out.revertData = data;
  }
  return out;
}

const need = (cond, msg) => { if (!cond) throw new Error(msg); };
const print = (o) => console.log(JSON.stringify(o));

async function main() {
  const { pos, opt } = parseArgs(process.argv.slice(2));
  const cmd = pos[0];
  need(cmd, 'usage: node e2e/chain.js now | time <s> | mine [n] | register ... | pay <id> --from <i> | cancel <id> --from <i> | info <id>  (see header of this file)');
  const ctx = await connect(opt);
  try {
    switch (cmd) {
      case 'now': {
        const head = await latest(ctx.provider);
        const wall = Math.floor(Date.now() / 1000);
        print({ block: head.number, chainTimestamp: head.timestamp, chainIso: head.iso, wallClock: wall, wallIso: iso(wall), chainMinusWallSeconds: head.timestamp - wall });
        break;
      }
      case 'time': {
        const secs = Number(pos[1]);
        need(Number.isInteger(secs) && secs >= 0, 'time <seconds> needs a non-negative integer');
        const head = await increaseTime(ctx.provider, secs);
        print({ increasedBy: secs, block: head.number, timestamp: head.timestamp, iso: head.iso });
        break;
      }
      case 'mine': {
        const n = pos[1] === undefined ? 1 : Number(pos[1]);
        need(Number.isInteger(n) && n >= 1 && n <= 5000, 'mine [n] needs an integer 1..5000');
        const head = await mine(ctx.provider, n);
        print({ mined: n, block: head.number, timestamp: head.timestamp, iso: head.iso });
        break;
      }
      case 'register': {
        const signer = await getSigner(ctx, opt.from);
        need(typeof opt.amount === 'string', '--amount <usdc decimal> is required');
        need(typeof opt.desc === 'string', '--desc <text> is required');
        need(!(opt.days !== undefined && opt['due-in'] !== undefined), 'use --days or --due-in, not both');
        let dueIn = 14 * DAY;
        if (opt.days !== undefined) dueIn = Math.round(Number(opt.days) * DAY);
        if (opt['due-in'] !== undefined) dueIn = Math.round(Number(opt['due-in']));
        need(Number.isFinite(dueIn) && dueIn > 0, '--days / --due-in must be a positive number');
        // A short --due-in is relative to the chain's current time, so sync the latest block with the chain clock first.
        const head = opt['due-in'] !== undefined ? await mine(ctx.provider, 1) : await latest(ctx.provider);
        if (Array.from(opt.desc).length > 140) console.error('warning: description is longer than 140 characters');
        const res = await registerInvoice(ctx, signer, {
          amount: parseUsdc(opt.amount), desc: opt.desc, no: typeof opt.no === 'string' ? opt.no : '',
          due: head.timestamp + dueIn, base: typeof opt.base === 'string' ? opt.base : DEFAULT_BASE
        });
        print(res);
        break;
      }
      case 'pay':
      case 'cancel':
      case 'info': {
        const id = pos[1];
        need(/^0x[0-9a-fA-F]{64}$/.test(id || ''), cmd + ' <id> needs a 32-byte hex invoice id');
        if (cmd === 'info') print(await invoiceInfo(ctx, id));
        else if (cmd === 'pay') print(await payInvoice(ctx, await getSigner(ctx, opt.from), id));
        else print(await cancelInvoice(ctx, await getSigner(ctx, opt.from), id));
        break;
      }
      default:
        throw new Error('unknown subcommand "' + cmd + '"');
    }
  } finally {
    ctx.provider.destroy();
  }
}

module.exports = {
  RPC, STATUS, SCALE, DAY, DEFAULT_BASE, iso, parseArgs, loadDeployment, connect, getSigner, latest, mine, increaseTime,
  parseUsdc, buildMemo, payLinkFor, receiptsLinkFor, registerInvoice, payInvoice, cancelInvoice, invoiceInfo, describeError
};

if (require.main === module) {
  main().catch((e) => {
    console.error(JSON.stringify(describeError(e)));
    process.exitCode = 1;
  });
}
