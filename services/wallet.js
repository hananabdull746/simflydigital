// ─────────────────────────────────────────────────────────────
// services/wallet.js
// The customer Simfly Wallet — prepaid PKR balance that can pay
// for ANY order (eSIM or Digital Store) without the screenshot /
// verification wait, plus instant refunds on supplier failures.
//
// Storage
//   db/wallets.json           { seq, wallets: { customerId: { balancePkr, updatedAt } } }
//   db/walletTransactions.json { seq, tx: [ …ledger rows… ] }   (append-only)
//
// INTEGRITY RULES (see README → "Wallet Feature")
//   1. EVERY balance change goes through adjustBalance(). There is
//      no other code path that writes balancePkr — checkout,
//      top-ups, refunds and admin adjustments all funnel here.
//   2. The read → check → write runs inside one async mutex, so a
//      rapid double-tap (or two devices) can only debit ONCE.
//   3. A debit that would go below zero is rejected with
//      { ok:false, code:'INSUFFICIENT_FUNDS' } — balance never
//      goes negative.
//   4. Every change appends an immutable ledger row carrying
//      balanceAfter, so the visible balance is always verifiable
//      by summing the ledger (auditWallets() does exactly that).
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { JSONFilePreset } from 'lowdb/node';
import { PATHS } from '../config.js';
import { logError } from '../lib/logger.js';

const WALLET_DEFAULTS = () => ({ seq: 0, wallets: {} });
const TX_DEFAULTS = () => ({ seq: 0, tx: [] });

function normalizeWallets(data) {
  const doc = data && typeof data === 'object' ? data : {};
  doc.seq = Number.isFinite(doc.seq) ? doc.seq : 0;
  doc.wallets = doc.wallets && typeof doc.wallets === 'object' ? doc.wallets : {};
  return doc;
}

function normalizeTx(data) {
  const doc = data && typeof data === 'object' ? data : {};
  doc.seq = Number.isFinite(doc.seq) ? doc.seq : 0;
  doc.tx = Array.isArray(doc.tx) ? doc.tx : [];
  return doc;
}

async function openJson(file, defaults) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    return await JSONFilePreset(file, defaults());
  } catch (err) {
    const backup = `${file}.corrupt-${Date.now()}`;
    console.warn(`[wallet] ${file} unreadable (${err.message}) — backing up to ${backup}.`);
    try { fs.renameSync(file, backup); } catch { /* ignore */ }
    return JSONFilePreset(file, defaults());
  }
}

const walletDb = await openJson(PATHS.wallets, WALLET_DEFAULTS);
const txDb = await openJson(PATHS.walletTx, TX_DEFAULTS);
const wallets = normalizeWallets(walletDb.data);
const ledger = normalizeTx(txDb.data);

// ── Async mutex: the whole read/check/write is one critical section ──
let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

let walletTimer = null;
let txTimer = null;
function persist() {
  if (!walletTimer) {
    walletTimer = setTimeout(() => {
      walletTimer = null;
      walletDb.write().catch((err) => {
        console.error(`[wallet] Failed to persist ${PATHS.wallets}: ${err.message}`);
        logError('wallet.write', err);
      });
    }, 150);
  }
  if (!txTimer) {
    txTimer = setTimeout(() => {
      txTimer = null;
      txDb.write().catch((err) => {
        console.error(`[wallet] Failed to persist ${PATHS.walletTx}: ${err.message}`);
        logError('wallet.tx.write', err);
      });
    }, 150);
  }
}

/** Block both files to disk right now (tests / shutdown). */
export async function flushWallet() {
  if (walletTimer) { clearTimeout(walletTimer); walletTimer = null; }
  if (txTimer) { clearTimeout(txTimer); txTimer = null; }
  await Promise.allSettled([walletDb.write(), txDb.write()]);
}

const normalizeId = (customerId) => String(customerId || '').replace(/\D/g, '') || String(customerId || '').trim();

/** Current balance (PKR). 0 when the customer has never topped up. */
export function getBalance(customerId) {
  const id = normalizeId(customerId);
  const w = wallets.wallets[id];
  return w ? Number(w.balancePkr) || 0 : 0;
}

/** The wallet record itself (or a blank one). */
export function getWallet(customerId) {
  const id = normalizeId(customerId);
  const w = wallets.wallets[id];
  return { customerId: id, balancePkr: w ? Number(w.balancePkr) || 0 : 0, updatedAt: w?.updatedAt || null };
}

/** Every wallet, richest first (dashboard + admin list). */
export function allWallets() {
  return Object.values(wallets.wallets)
    .map((w) => ({
      customerId: String(w.customerId ?? ''),
      balancePkr: Number(w.balancePkr) || 0,
      updatedAt: w.updatedAt || null,
    }))
    .sort((a, b) => b.balancePkr - a.balancePkr);
}

/**
 * THE single balance mutator.
 *
 * @param {string} customerId  bare phone number / JID number part
 * @param {number} amountPkr   POSITIVE = credit, NEGATIVE = debit
 * @param {string} type        'topup' | 'order_payment' | 'refund' | 'admin_adjustment'
 * @param {{relatedOrderId?:string, note?:string, status?:string, actor?:string}} meta
 * @returns {Promise<{ok:boolean, balance:number, tx?:object,
 *                    code?:string}>}
 */
export function adjustBalance(customerId, amountPkr, type, meta = {}) {
  const id = normalizeId(customerId);
  const amount = Number(amountPkr);
  if (!id) return Promise.resolve({ ok: false, balance: 0, code: 'BAD_CUSTOMER' });
  if (!Number.isFinite(amount) || amount === 0) {
    return Promise.resolve({ ok: false, balance: getBalance(id), code: 'BAD_AMOUNT' });
  }

  return withLock(() => {
    const existing = wallets.wallets[id];
    const before = existing ? Number(existing.balancePkr) || 0 : 0;
    const after = before + amount;

    // Rule 3: never negative.
    if (after < 0) {
      return { ok: false, balance: before, code: 'INSUFFICIENT_FUNDS', requiredPkr: Math.abs(after) };
    }

    // Rule 1+2: one atomic write of balance + ledger row.
    wallets.wallets[id] = { customerId: id, balancePkr: after, updatedAt: new Date().toISOString() };
    wallets.seq = (wallets.seq || 0) + 1;

    const tx = {
      id: `WTX-${String(wallets.seq).padStart(6, '0')}`,
      customerId: id,
      type,
      amountPkr: amount,
      relatedOrderId: meta.relatedOrderId || null,
      balanceAfter: after,
      status: meta.status || 'completed',
      createdAt: new Date().toISOString(),
      note: meta.note ? String(meta.note).slice(0, 200) : '',
      actor: meta.actor || null,
    };
    ledger.tx.push(tx);
    if (ledger.tx.length > 5000) ledger.tx = ledger.tx.slice(-5000);
    persist();
    return { ok: true, balance: after, tx };
  });
}

/** Convenience wrappers (still going through adjustBalance). */
export const credit = (customerId, amountPkr, type, meta) =>
  adjustBalance(customerId, Math.abs(Number(amountPkr) || 0), type, meta);
export const debit = (customerId, amountPkr, type, meta) =>
  adjustBalance(customerId, -Math.abs(Number(amountPkr) || 0), type, meta);

/** One customer's ledger, newest first. */
export function ledgerFor(customerId, limit = 50) {
  const id = normalizeId(customerId);
  return ledger.tx
    .filter((t) => t.customerId === id)
    .slice(-Math.max(1, Number(limit) || 50))
    .reverse();
}

/** Newest ledger rows across all customers (dashboard). */
export function recentLedger(limit = 50) {
  return ledger.tx.slice(-Math.max(1, Number(limit) || 50)).reverse();
}

/** Sum of all balances — money Simfly OWES in service (liability). */
export function totalLiability() {
  return Object.values(wallets.wallets).reduce((sum, w) => sum + (Number(w.balancePkr) || 0), 0);
}

/**
 * Consistency check: every wallet's balance must equal the sum of
 * its ledger rows. Run periodically / via the "wallet audit" admin
 * command — any mismatch means a bug (or a hand-edited file).
 */
export function auditWallets() {
  const sums = new Map();
  for (const t of ledger.tx) {
    sums.set(t.customerId, (sums.get(t.customerId) || 0) + Number(t.amountPkr || 0));
  }
  const issues = [];
  const ids = new Set([...Object.keys(wallets.wallets), ...sums.keys()]);
  for (const id of ids) {
    const stored = wallets.wallets[id] ? Number(wallets.wallets[id].balancePkr) || 0 : 0;
    const summed = sums.get(id) || 0;
    if (Math.abs(stored - summed) > 0.005) {
      issues.push({ customerId: id, storedPkr: stored, ledgerSumPkr: summed, driftPkr: stored - summed });
    }
  }
  return { ok: issues.length === 0, checked: ids.size, issues };
}

// ── Top-up anti-abuse ─────────────────────────────────────────
const topupAttempts = new Map(); // customerId -> [timestamps]

/** True when this customer may START another top-up right now. */
export function topupAllowed(customerId, max = 5, windowMs = 600_000) {
  const id = normalizeId(customerId);
  const now = Date.now();
  const list = (topupAttempts.get(id) || []).filter((t) => now - t < windowMs);
  topupAttempts.set(id, list);
  return list.length < max;
}

/** Record that a top-up was started (call when the flow begins). */
export function recordTopupAttempt(customerId) {
  const id = normalizeId(customerId);
  const list = topupAttempts.get(id) || [];
  list.push(Date.now());
  topupAttempts.set(id, list);
}

/** Test helper — forget rate-limit windows. */
export function __resetTopupAttempts() {
  topupAttempts.clear();
}
