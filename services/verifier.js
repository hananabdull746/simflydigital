// ─────────────────────────────────────────────────────────────
// services/verifier.js
// Payment auto-verification status ("NayaPay verifier").
//
// When a real auto-verifier is wired up later, flip NAYAPAY_AUTO_VERIFY
// to true in .env (or point isOnline() at the actual health check) —
// every payment screen reads its ETA from here, so customers see
// "within 1-2 mins" only when the fast path is genuinely online.
//
// Part 1 (admin system) adds the parsed-payment-email store:
//   • addPaymentEmail()  ingest one notification (or test fixture)
//   • autoCheck(order)   the status line on the admin order card
//   • linkPayment()      the 💳 "Link payment to order" button
//   • scanInbox()        honest NOT_CONFIGURED until an inbox is wired
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { JSONFilePreset } from 'lowdb/node';
import { SETTINGS, PATHS, formatPrice, jidUser } from '../config.js';
import { logError, logAdmin } from '../lib/logger.js';

/** True when the automatic payment verifier can confirm payments. */
export function isOnline() {
  return SETTINGS.nayapayAutoVerify === true;
}

/** Human confirmation ETA for the payment screens. */
export function confirmEta() {
  return isOnline() ? 'within 1-2 mins' : 'within 15 mins';
}

export const NAME = 'NayaPay';

// ── Parsed payment emails (db/payments.json) ───────────────────
const PAY_DEFAULTS = () => ({ emails: [], meta: { lastScan: null, lastError: null } });

function normalizePayments(data) {
  const doc = data && typeof data === 'object' ? data : {};
  doc.emails = Array.isArray(doc.emails) ? doc.emails : [];
  doc.meta = doc.meta && typeof doc.meta === 'object' ? doc.meta : {};
  if (doc.meta.lastScan === undefined) doc.meta.lastScan = null;
  if (doc.meta.lastError === undefined) doc.meta.lastError = null;
  return doc;
}

async function openPayments() {
  fs.mkdirSync(path.dirname(PATHS.payments), { recursive: true });
  try {
    return await JSONFilePreset(PATHS.payments, PAY_DEFAULTS());
  } catch (err) {
    const backup = `${PATHS.payments}.corrupt-${Date.now()}`;
    console.warn(`[verifier] ${PATHS.payments} unreadable (${err.message}) — backing up to ${backup}.`);
    try { fs.renameSync(PATHS.payments, backup); } catch { /* ignore */ }
    return JSONFilePreset(PATHS.payments, PAY_DEFAULTS());
  }
}

let payDb = null;
let payState = { emails: [], meta: { lastScan: null, lastError: null } };
let payReady = null;

async function ensurePayments() {
  if (payReady) return payReady;
  payReady = (async () => {
    payDb = await openPayments();
    payState = normalizePayments(payDb.data);
  })();
  return payReady;
}
await ensurePayments();

let payTimer = null;
function savePayments() {
  if (payTimer) return;
  payTimer = setTimeout(() => {
    payTimer = null;
    payDb.write().catch((err) => {
      console.error(`[verifier] Failed to persist payments: ${err.message}`);
      logError('verifier.write', err);
    });
  }, 200);
}

// ── Parsing ────────────────────────────────────────────────────
/**
 * Parse one NayaPay notification into a normalized record.
 * Accepts a string (email body) or an object ({subject, body, from}).
 * Returns null when no amount could be found — never throws.
 */
export function parsePaymentEmail(input) {
  try {
    const raw = typeof input === 'string'
      ? { subject: '', body: input }
      : {
        subject: input?.subject || input?.title || '',
        body: input?.body || input?.text || input?.snippet || input?.content || '',
        from: input?.from || input?.sender || '',
      };
    const text = `${raw.subject}\n${raw.body}`.replace(/\u00a0/g, ' ');

    // Money first: PKR 1,234 / 1234 Rs / Rs. 1,234
    const money = text.match(/(?:PKR|Rs\.?|PKR\s?)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
    if (!money) return null;
    const amount = Number(money[1].replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) return null;

    // Transaction id: any long alnum token, prefer explicit labels.
    const txnLabel = text.match(
      /\b(?:txn|transaction|reference|ref(?:erence)?|trf|transfer)\s*(?:id|no|#|:)?\s*([A-Za-z0-9-]{6,32})/i,
    );
    const referenceLabel = text.match(/\b(?:SMF[- ]?\d{3,6})\b/i);
    const genericTxn = text.match(/\b([A-Z0-9]{8,24})\b/);

    const txn = (txnLabel?.[1] || genericTxn?.[1] || '').trim();
    const reference = (referenceLabel?.[0] || '').replace(/\s+/g, '-').toUpperCase();

    return {
      txn,
      reference,
      amount,
      currency: 'PKR',
      from: raw.from || '',
      subject: raw.subject || '',
      raw: text.trim().slice(0, 400),
    };
  } catch (err) {
    logError('verifier.parse', err);
    return null;
  }
}

/** Ingest one parsed payment email. Dedupes on txn id. */
export function addPaymentEmail(input) {
  const parsed = input && typeof input === 'object' && input.txn !== undefined
    ? input
    : parsePaymentEmail(input);
  if (!parsed || !parsed.amount) return null;

  const id = parsed.txn || `eml-${Date.now()}-${payState.emails.length}`;
  const existing = payState.emails.find((e) => e.txn === id || e.id === id);
  if (existing) return existing;

  const record = {
    id,
    txn: parsed.txn || id,
    reference: parsed.reference || '',
    amount: parsed.amount,
    currency: parsed.currency || 'PKR',
    subject: parsed.subject || '',
    at: new Date().toISOString(),
    matchedOrder: null,
    status: 'unclaimed',
    claimedBy: null,
    claimedAt: null,
  };
  payState.emails.push(record);
  if (payState.emails.length > 500) payState.emails = payState.emails.slice(-500);
  savePayments();
  return record;
}

/** Newest payment emails, for the 💳 Payments screen. */
export function recentPayments(limit = 10) {
  return payState.emails.slice(-Number(limit) || 10).reverse();
}

/** Unclaimed payments (candidates for manual linking). */
export function unclaimedPayments() {
  return payState.emails.filter((e) => e.status === 'unclaimed');
}

/** Scan status for the 💳 Payments screen. */
export function scanStatus() {
  return {
    configured: false, // set true once a real inbox poller exists
    lastScan: payState.meta.lastScan,
    lastError: payState.meta.lastError,
    message: isOnline()
      ? 'Auto-verifier ON'
      : 'NOT_CONFIGURED — no payment inbox connected yet. Emails can be added with addPaymentEmail().',
  };
}

/** Honest stub: reports NOT_CONFIGURED instead of faking a scan. */
export async function scanInbox() {
  payState.meta.lastScan = new Date().toISOString();
  payState.meta.lastError = 'NOT_CONFIGURED';
  savePayments();
  return { ok: false, scanned: 0, message: scanStatus().message };
}

// ── Auto-check: the order-card status line ─────────────────────
/**
 * Compare a pending order against stored payment emails.
 * @returns {{status:'matched'|'amount_mismatch'|'no_match', payment?:object, detail:string}}
 */
export function autoCheck(order) {
  const price = Number(order?.price || 0);
  const orderId = String(order?.orderId || order?.id || '').toUpperCase();

  // 1) Email that already references this order id.
  const byRef = [...payState.emails].reverse().find(
    (e) => e.reference && (e.reference.includes(orderId) || orderId.includes(e.reference)),
  );
  if (byRef) {
    if (Math.abs(Number(byRef.amount) - price) < 0.5) {
      return { status: 'matched', payment: byRef, detail: `matched txn ${byRef.txn}` };
    }
    return {
      status: 'amount_mismatch',
      payment: byRef,
      detail: `email ${formatPrice(byRef.amount, byRef.currency)} ≠ ${formatPrice(price)}`,
    };
  }

  // 2) Unclaimed email with an exactly matching amount (oldest first).
  const byAmount = payState.emails.find(
    (e) => e.status === 'unclaimed' && Math.abs(Number(e.amount) - price) < 0.5,
  );
  if (byAmount) {
    return { status: 'matched', payment: byAmount, detail: `matched txn ${byAmount.txn}` };
  }

  // 3) Exactly one unclaimed email and it does not match the amount:
  //    that is an unambiguous "amount mismatch". With several
  //    unclaimed emails we cannot tell which one belongs to this
  //    order, so stay honest and report no_match.
  const unclaimed = payState.emails.filter((e) => e.status === 'unclaimed');
  if (unclaimed.length === 1 && price > 0) {
    return {
      status: 'amount_mismatch',
      payment: unclaimed[0],
      detail: `email ${formatPrice(unclaimed[0].amount)} ≠ ${formatPrice(price)}`,
    };
  }

  return { status: 'no_match', detail: 'no email match yet' };
}

/** One-word label for the admin order card. */
export function autoCheckLabel(order) {
  const check = autoCheck(order);
  if (check.status === 'matched') return `✅ matched ${NAME} email`;
  if (check.status === 'amount_mismatch') return `❌ ${check.detail}`;
  return `⚠️ ${check.detail}`;
}

/** 💳 "Link payment to order" — claim a payment for an order. */
export function linkPayment(txn, orderId, actor = 'admin') {
  const payment = payState.emails.find((e) => e.txn === txn || e.id === txn);
  if (!payment) return { ok: false, reason: 'Payment not found.' };
  if (payment.status === 'claimed' && payment.matchedOrder && payment.matchedOrder !== orderId) {
    return { ok: false, reason: `Already linked to ${payment.matchedOrder}.` };
  }
  payment.status = 'claimed';
  payment.matchedOrder = orderId;
  payment.claimedBy = actor;
  payment.claimedAt = new Date().toISOString();
  savePayments();
  logAdmin('payment.linked', { txn: payment.txn, orderId, actor });
  return { ok: true, payment };
}

/** Remove a payment record (admin cleanup). */
export function unlinkPayment(txn) {
  const payment = payState.emails.find((e) => e.txn === txn || e.id === txn);
  if (!payment) return false;
  payment.status = 'unclaimed';
  payment.matchedOrder = null;
  payment.claimedBy = null;
  payment.claimedAt = null;
  savePayments();
  return true;
}

/** JID that owns a payment lookup (used by the Find screen). */
export function paymentJid(payment) {
  return payment?.from ? jidUser(payment.from) : null;
}

/** Test helper — replace in-memory payment state. */
export function __resetPayments(emails = []) {
  payState = normalizePayments({ emails, meta: { lastScan: null, lastError: null } });
  savePayments();
  return payState;
}
