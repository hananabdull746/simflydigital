// ─────────────────────────────────────────────────────────────
// services/binanceVerifier.js
// 💳 Binance Pay auto-verification.
//
// The customer does NOT send a screenshot — they type a Transaction
// ID. This module is the whole brain behind that:
//
//   1. LOOKUP     services/binancePay.js pulls the Pay trade history
//                 for a window around "now" (paginated, throttled)
//   2. CLASSIFY   one pure function decides match / amount_mismatch /
//                 currency_mismatch / time_window / already_claimed /
//                 not_found — no I/O, fully unit-testable
//   3. CLAIM      the winning transaction is claimed ATOMICALLY for
//                 one order in db/binanceTransactions.json (the
//                 check and the write happen with no await between
//                 them, so two orders can never claim one payment)
//   4. RETRY      settlement lag is real: not_found is retried every
//                 BINANCE_RETRY_MS up to BINANCE_MAX_WAIT_MS, with
//                 ONE "still checking" progress ping. Timing is
//                 counted from slept durations so tests are exact.
//
// Rollout: BINANCE_VERIFIER_MODE = off | shadow | auto (default
// shadow — the verdict is recorded and reported, the admin still
// confirms). See README → "Binance Pay auto-verification".
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { JSONFilePreset } from 'lowdb/node';
import { BINANCE_PAY, PATHS, formatPrice } from '../config.js';
import { findTransactionById, findWindow, isConfigured, status as apiStatus } from './binancePay.js';
import { logError, logAdmin } from '../lib/logger.js';

/** off → never call Binance · shadow → report only · auto → fulfil. */
export const mode = () => BINANCE_PAY.mode;

/** One USDT figure as Binance Pay shows it (2 dp). */
export const roundUsdt = (value) => Math.round((Number(value) || 0) * 100) / 100;

/** How many USDT this order should receive at the configured rate. */
export function expectedUsdt(order) {
  const rate = Number(BINANCE_PAY.usdtPkrRate) || 0;
  const pkr = Number(order?.paidAmount ?? order?.price ?? 0);
  if (rate <= 0 || pkr <= 0) return 0;
  return roundUsdt(pkr / rate);
}

/** The ± window (ms) a transaction may sit from "now" and still count. */
export const windowMs = () => Math.max(60_000, Number(BINANCE_PAY.matchWindowMinutes) * 60_000);

/** Lookup window: a little before now, a little after (clock skew). */
export function windowAround(now = Date.now()) {
  return {
    startTime: now - windowMs(),
    endTime: now + Math.min(windowMs(), 5 * 60_000),
  };
}

/** Money text for the admin card (PKR + USDT, never rounded away). */
export function usdtLabel(order) {
  const usdt = expectedUsdt(order);
  const rate = Number(BINANCE_PAY.usdtPkrRate) || 0;
  return `${usdt.toFixed(2)} USDT${rate > 0 ? ` @ ${rate} PKR` : ''}`;
}

// ── Store: db/binanceTransactions.json ────────────────────────
const TX_DEFAULTS = () => ({
  transactions: [],
  meta: {
    lastFetch: null,
    lastOk: null,
    lastError: null,
    seen: 0,
    matched: 0,
    shadowed: 0,
    blocked: 0,
  },
});

function normalizeDoc(data) {
  const doc = data && typeof data === 'object' ? data : {};
  doc.transactions = Array.isArray(doc.transactions) ? doc.transactions : [];
  doc.meta = doc.meta && typeof doc.meta === 'object' ? doc.meta : {};
  const d = TX_DEFAULTS().meta;
  for (const k of Object.keys(d)) if (doc.meta[k] === undefined) doc.meta[k] = d[k];
  return doc;
}

async function openStore() {
  fs.mkdirSync(path.dirname(PATHS.binanceTx), { recursive: true });
  try {
    return await JSONFilePreset(PATHS.binanceTx, TX_DEFAULTS());
  } catch (err) {
    const backup = `${PATHS.binanceTx}.corrupt-${Date.now()}`;
    console.warn(`[binance] ${PATHS.binanceTx} unreadable (${err.message}) — backing up to ${backup}.`);
    try { fs.renameSync(PATHS.binanceTx, backup); } catch { /* ignore */ }
    return JSONFilePreset(PATHS.binanceTx, TX_DEFAULTS());
  }
}

let txDb = null;
let txDoc = TX_DEFAULTS();
let txReady = null;

async function ensureStore() {
  if (txReady) return txReady;
  txReady = (async () => {
    txDb = await openStore();
    txDoc = normalizeDoc(txDb.data);
  })();
  return txReady;
}
await ensureStore();

let writeTimer = null;
function saveStore() {
  if (!txDb) return;
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    txDb.write().catch((err) => {
      console.error(`[binance] Failed to persist transactions: ${err.message}`);
      logError('binance.write', err);
    });
  }, 200);
}

/** Newest-first list for the 💳 screen / dashboard. */
export function recentTransactions(limit = 10) {
  return [...txDoc.transactions]
    .sort((a, b) => (b.time || 0) - (a.time || 0) || String(b.firstSeenAt || '').localeCompare(String(a.firstSeenAt || '')))
    .slice(0, Math.max(1, Number(limit) || 10));
}

/** One cached transaction by its Transaction ID. */
export function getTransaction(txId) {
  const id = String(txId || '');
  return txDoc.transactions.find((t) => t.transactionId === id) || null;
}

/** Count of transactions cached for the admin screen. */
export const txCount = () => txDoc.transactions.length;

function bump(key, by = 1) {
  txDoc.meta[key] = (Number(txDoc.meta[key]) || 0) + by;
}

/**
 * Fold a transaction we just saw from Binance into the cache.
 * Never touches a claim: a claimed record keeps its orderId.
 */
export function upsertSeen(transaction, extra = {}) {
  if (!transaction?.transactionId) return null;
  const existing = getTransaction(transaction.transactionId);
  const stamp = new Date().toISOString();
  if (existing) {
    // A claim (order link) is ours, never Binance's — refresh the
    // money/time fields without ever clobbering who owns it.
    const claim = {
      orderId: existing.orderId,
      status: existing.status,
      claimedBy: existing.claimedBy,
      claimedAt: existing.claimedAt,
    };
    Object.assign(existing, transaction, extra, claim, { lastSeenAt: stamp });
    saveStore();
    return existing;
  }
  const record = {
    ...transaction,
    orderId: null,
    status: 'unclaimed',
    claimedBy: null,
    claimedAt: null,
    firstSeenAt: stamp,
    lastSeenAt: stamp,
    ...extra,
  };
  txDoc.transactions.push(record);
  // Keep the cache bounded — the claim history matters most.
  if (txDoc.transactions.length > 500) txDoc.transactions = txDoc.transactions.slice(-500);
  bump('seen');
  saveStore();
  return record;
}

/**
 * ATOMIC claim: check + write with no await in between, so two
 * orders can never be fulfilled from one transaction.
 * @returns {{ok:boolean, reason?:string, orderId?:string|null, transaction?:object}}
 */
export function claimTransaction(txId, orderId, actor = 'binance-verifier') {
  const id = String(txId || '');
  const existing = getTransaction(id);
  if (existing && existing.status === 'claimed' && existing.orderId && existing.orderId !== orderId) {
    return { ok: false, reason: 'already_claimed', orderId: existing.orderId };
  }
  const record = existing || {
    transactionId: id,
    amount: 0,
    currency: 'USDT',
    time: null,
    orderId: null,
    status: 'unclaimed',
    claimedBy: null,
    claimedAt: null,
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };
  const stamp = new Date().toISOString();
  record.status = 'claimed';
  record.orderId = orderId;
  record.claimedBy = actor;
  record.claimedAt = stamp;
  record.lastSeenAt = stamp;
  if (!existing) txDoc.transactions.push(record);
  saveStore();
  return { ok: true, transaction: record };
}

/** Free a claim (order rejected/cancelled — the money may be reused). */
export function releaseTransaction(txId) {
  const record = getTransaction(txId);
  if (!record || record.status !== 'claimed') return false;
  record.status = 'unclaimed';
  record.orderId = null;
  record.claimedBy = null;
  record.claimedAt = null;
  saveStore();
  return true;
}

/** Connectivity + counters for the 💳 screen / dashboard. */
export function storeStatus() {
  const claimed = txDoc.transactions.filter((t) => t.status === 'claimed');
  return {
    ...apiStatus(),
    configured: isConfigured(),
    mode: mode(),
    count: txDoc.transactions.length,
    claimed: claimed.length,
    unclaimed: txDoc.transactions.length - claimed.length,
    lastFetch: txDoc.meta.lastFetch,
    lastOk: txDoc.meta.lastOk,
    lastError: txDoc.meta.lastError,
    seen: Number(txDoc.meta.seen) || 0,
    matched: Number(txDoc.meta.matched) || 0,
    shadowed: Number(txDoc.meta.shadowed) || 0,
    blocked: Number(txDoc.meta.blocked) || 0,
  };
}

function noteFetch({ ok, error }) {
  const stamp = new Date().toISOString();
  txDoc.meta.lastFetch = stamp;
  if (ok) {
    txDoc.meta.lastOk = stamp;
    txDoc.meta.lastError = null;
  } else {
    txDoc.meta.lastError = String(error || 'unknown').slice(0, 200);
  }
  saveStore();
}

/** 💳 "Rescan" — pull the recent window again (admin button + dashboard POST). */
export async function rescan({ startTime, endTime } = {}) {
  const window = startTime || endTime
    ? { startTime, endTime }
    : windowAround(Date.now());

  const res = await findWindow(window);
  noteFetch({ ok: res.ok, error: res.ok ? null : (res.message || res.code) });

  if (!res.ok) {
    return { ok: false, code: res.code, message: res.message, scanned: 0, cached: txDoc.transactions.length };
  }
  for (const tx of res.transactions) upsertSeen(tx);
  logAdmin('binance.rescan', { scanned: res.transactions.length, truncated: Boolean(res.truncated) });
  return {
    ok: true,
    scanned: res.transactions.length,
    truncated: Boolean(res.truncated),
    cached: txDoc.transactions.length,
    lastFetch: txDoc.meta.lastFetch,
  };
}

/** Mark a verdict against the meta counters (admin screen history). */
export function recordVerdict(kind) {
  if (kind === 'match') bump('matched');
  else if (kind === 'shadow') bump('shadowed');
  else if (kind === 'blocked') bump('blocked');
  saveStore();
}

/** Test helper — replace the in-memory cache. */
export function __resetStore(doc = null) {
  txDoc = normalizeDoc(doc);
  saveStore();
  return txDoc;
}

// ── Classification (pure) ─────────────────────────────────────
/**
 * Decide what a fetched transaction means for `order`.
 *
 * @param {object} args
 * @param {object} args.order       the order (paidAmount/price, id)
 * @param {object|null} args.transaction  the normalized Binance row
 * @param {number} [args.now]       epoch ms for the time-window check
 * @returns {{status:string, detail:string, transaction?:object, claimedBy?:string|null}}
 *
 * status:
 *   match             clean — right coin, right amount, right time
 *   not_found         not in the window yet (retry)
 *   currency_mismatch not USDT
 *   outgoing          amount <= 0 (money left the account)
 *   amount_mismatch   wrong number of USDT
 *   time_window       outside ±BINANCE_MATCH_WINDOW_MIN
 *   already_claimed   some other order already used it
 */
export function classify({ order, transaction, now = Date.now() } = {}) {
  if (!transaction || !transaction.transactionId) {
    return { status: 'not_found', detail: 'transaction id not in the window yet' };
  }

  const currency = String(transaction.currency || '').toUpperCase();
  if (currency !== 'USDT') {
    return { status: 'currency_mismatch', transaction, detail: `${currency || 'unknown'} ≠ USDT` };
  }

  const amount = Number(transaction.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { status: 'outgoing', transaction, detail: `amount ${transaction.amount} is not incoming` };
  }

  const want = expectedUsdt(order);
  if (want <= 0) {
    return { status: 'amount_mismatch', transaction, detail: 'order has no payable amount / USDT rate missing' };
  }
  // ±0.01 USDT — one rounding step either side of the quoted figure.
  if (Math.abs(amount - want) > 0.01) {
    return {
      status: 'amount_mismatch',
      transaction,
      detail: `${roundUsdt(amount).toFixed(2)} USDT ≠ ${want.toFixed(2)} USDT (${formatPrice(order?.paidAmount ?? order?.price ?? 0)})`,
    };
  }

  const time = Number(transaction.time);
  if (Number.isFinite(time) && Math.abs(time - now) > windowMs()) {
    const mins = Math.round(Math.abs(time - now) / 60_000);
    return { status: 'time_window', transaction, detail: `payment is ${mins} min away from now (±${BINANCE_PAY.matchWindowMinutes} min)` };
  }

  const cached = getTransaction(transaction.transactionId);
  if (cached && cached.status === 'claimed' && cached.orderId && cached.orderId !== order?.id) {
    return { status: 'already_claimed', transaction, claimedBy: cached.orderId, detail: `already used by ${cached.orderId}` };
  }

  return { status: 'match', transaction, detail: `${roundUsdt(amount).toFixed(2)} USDT matched ${order?.id || 'order'}` };
}

/** Statuses that can never change on a retry — stop immediately. */
const TERMINAL = new Set(['currency_mismatch', 'outgoing', 'amount_mismatch', 'time_window', 'already_claimed']);

// ── Retry loop ────────────────────────────────────────────────
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let sleep = defaultSleep;
/** Test hook: replace the timer. Pass null to restore the real one. */
export function __setSleep(fn) {
  sleep = fn || defaultSleep;
}

// One verification per order at a time (a customer re-typing the id
// must not start a second loop racing the first).
const running = new Set();
export const isVerifying = (orderId) => running.has(String(orderId));

/**
 * Look up `txId` for `order`, retrying while Binance has not caught
 * up. Resolves with `{ status, transaction, attempts, waitedMs }`.
 *
 * Never throws. When nothing can be found in time the caller falls
 * back to the admin card — that fallback is the whole reason this
 * function is allowed to be slow.
 *
 * @param {object}   args
 * @param {object}   args.order
 * @param {string}   args.txId
 * @param {Function} [args.onProgress] called ONCE with 'still' halfway
 * @param {object}   [args.deps]  { sleep, lookup, now, retryMs, maxWaitMs }
 */
export async function verifyWithRetry({ order, txId, onProgress, deps = {} } = {}) {
  const id = String(txId || '').trim();
  const retryMs = Number(deps.retryMs ?? BINANCE_PAY.retryMs);
  const maxWaitMs = Number(deps.maxWaitMs ?? BINANCE_PAY.maxWaitMs);
  const doSleep = deps.sleep || sleep;
  const lookup = deps.lookup || ((value) => findTransactionById(value, windowAround(deps.now ?? Date.now())));
  const orderId = String(order?.id || '');

  if (!id) return { status: 'bad_request', detail: 'empty transaction id', attempts: 0, waitedMs: 0 };
  if (!isConfigured()) {
    return { status: 'not_configured', detail: 'BINANCE_API_KEY / BINANCE_API_SECRET missing', attempts: 0, waitedMs: 0 };
  }

  const alreadyRunning = running.has(orderId);
  running.add(orderId);
  let waited = 0;
  let notified = false;

  try {
    for (let attempt = 1; ; attempt += 1) {
      let verdict;
      try {
        const res = await lookup(id);
        if (res && res.ok === false && res.code && res.code !== 'BAD_REQUEST') {
          // API problem (auth/rate limit/upstream) — not a verdict.
          verdict = { status: 'api_error', detail: res.message || res.code };
        } else {
          const transaction = res?.transaction || null;
          if (transaction) upsertSeen(transaction);
          verdict = classify({ order, transaction, now: deps.now ?? Date.now() });
        }
      } catch (err) {
        logError('binance.lookup', err, { orderId, txId: id });
        verdict = { status: 'api_error', detail: err?.message || 'lookup failed' };
      }

      const done = verdict.status === 'match' || TERMINAL.has(verdict.status) || verdict.status === 'not_configured';
      if (done) {
        return { ...verdict, attempts: attempt, waitedMs: waited, requeued: alreadyRunning };
      }

      // not_found / api_error → keep trying until the window closes.
      if (waited + retryMs > maxWaitMs) {
        return {
          ...verdict,
          status: verdict.status === 'not_found' ? 'timeout' : verdict.status,
          attempts: attempt,
          waitedMs: waited,
          requeued: alreadyRunning,
        };
      }
      if (!notified && typeof onProgress === 'function' && waited + retryMs >= maxWaitMs / 2) {
        notified = true;
        try { await onProgress('still', { attempt, waitedMs: waited }); } catch { /* progress is best-effort */ }
      }
      await doSleep(retryMs);
      waited += retryMs;
    }
  } finally {
    running.delete(orderId);
  }
}

/** One admin-audit line per verdict (never logs the API secret). */
export function auditVerdict(orderId, verdict, actor = 'binance-verifier') {
  try {
    logAdmin('binance.verify', {
      orderId,
      status: verdict?.status,
      txId: verdict?.transaction?.transactionId,
      amount: verdict?.transaction?.amount,
      mode: mode(),
      actor,
    });
  } catch { /* audit is best-effort */ }
}

/** Test helper — forget which orders are mid-verification. */
export function __resetVerifying() {
  running.clear();
}
