// ─────────────────────────────────────────────────────────────
// lib/sales.js
// 🎟️ Admin-launched SALE CODES (deal codes).
//
//   admin:  panel → 🎟️ Sale Codes → create "EID20, 20%, 7 days"
//   customer: at the payment step → 🎟️ Sale code → types EID20
//             → discount applied to BOTH catalogues (eSIM + Digital)
//
// Storage: data/sales.json ({ codes: [...] }) — same sync-JSON style
// as data/digitalProductOverrides.json.
//
// One code = { code, percentOff, active, maxUses, uses,
//              startsAt, endsAt, createdAt, createdBy }.
//
// `discountFor()` is the single checkout entry point used by BOTH
// payment paths (screenshot flow + one-tap wallet). It prefers an
// admin sale code, then falls back to the per-customer loyalty code
// (eSIM only, issued by lib/users.js).
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs';
import { PATHS } from '../config.js';
import { getSession, saveSession } from './sessions.js';
import { validDiscount } from './users.js';

const CODE_RE = /^[A-Z0-9_-]{3,20}$/;

function readDoc() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PATHS.sales, 'utf8'));
    const codes = Array.isArray(parsed?.codes) ? parsed.codes : Array.isArray(parsed) ? parsed : [];
    return { codes };
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[sales] ${PATHS.sales} unreadable: ${err.message}`);
    return { codes: [] };
  }
}

function writeDoc(doc) {
  try {
    fs.mkdirSync(PATHS.sales.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
    fs.writeFileSync(PATHS.sales, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  } catch (err) {
    console.error(`[sales] could not persist: ${err.message}`);
  }
}

/** Every sale code, newest first. */
export function allSales() {
  return readDoc().codes
    .slice()
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

export function getSale(code) {
  const key = normCode(code);
  return readDoc().codes.find((c) => c.code === key) || null;
}

export const normCode = (code) => String(code || '').trim().toUpperCase();

/** Status of one code right now (never throws). */
export function saleState(code) {
  const key = normCode(code);
  const sale = readDoc().codes.find((c) => c.code === key);
  if (!sale) return { ok: false, reason: 'not_found', code: key };
  if (!sale.active) return { ok: false, reason: 'disabled', code: key };
  const now = Date.now();
  if (sale.startsAt && now < Date.parse(sale.startsAt)) return { ok: false, reason: 'not_started', code: key };
  if (sale.endsAt && now > Date.parse(sale.endsAt)) return { ok: false, reason: 'expired', code: key };
  if (Number.isFinite(sale.maxUses) && sale.maxUses > 0 && (sale.uses || 0) >= sale.maxUses) {
    return { ok: false, reason: 'maxed', code: key };
  }
  return { ok: true, code: key, percentOff: Number(sale.percentOff) || 0, sale };
}

const REASON_TEXT = {
  not_found: '❌ Yeh code valid nahi hai — dobara check karein.',
  disabled: '⛔ Yeh code abhi disabled hai.',
  not_started: '⏳ Yeh code abhi shuru nahi hua.',
  expired: '⌛ Yeh code expire ho chuka hai.',
  maxed: '🚫 Yeh code ki limit khatam ho gayi hai.',
};

export function saleReasonText(reason) {
  return REASON_TEXT[reason] || REASON_TEXT.not_found;
}

/**
 * Create (or replace) a sale code.
 * @param {{code:string, percentOff:number, maxUses?:number,
 *          days?:number, startsAt?:string, createdBy?:string}} input
 * @returns {{ok:boolean, code?:string, error?:string, sale?:object}}
 */
export function createSale(input = {}) {
  const code = normCode(input.code);
  const percentOff = Number(input.percentOff);
  if (!CODE_RE.test(code)) return { ok: false, error: 'Code 3–20 letters/numbers ka hona chahiye (e.g. `EID20`).' };
  if (!Number.isFinite(percentOff) || percentOff < 1 || percentOff > 90) {
    return { ok: false, error: 'Discount 1–90% ke darmiyan hona chahiye (e.g. `20`).' };
  }
  const maxUses = Math.max(1, Number(input.maxUses) || 1000);
  const days = Number(input.days);
  const now = new Date();

  const sale = {
    code,
    percentOff: Math.round(percentOff),
    active: true,
    maxUses,
    uses: 0,
    startsAt: input.startsAt || null,
    endsAt: Number.isFinite(days) && days > 0
      ? new Date(now.getTime() + days * 86_400_000).toISOString()
      : null,
    createdAt: now.toISOString(),
    createdBy: String(input.createdBy || 'admin'),
  };

  const doc = readDoc();
  const idx = doc.codes.findIndex((c) => c.code === code);
  if (idx >= 0) doc.codes[idx] = { ...doc.codes[idx], ...sale, uses: doc.codes[idx].uses || 0 };
  else doc.codes.push(sale);
  writeDoc(doc);
  return { ok: true, code, sale: doc.codes.find((c) => c.code === code) };
}

export function toggleSale(code) {
  const key = normCode(code);
  const doc = readDoc();
  const sale = doc.codes.find((c) => c.code === key);
  if (!sale) return null;
  sale.active = !sale.active;
  writeDoc(doc);
  return sale;
}

export function deleteSale(code) {
  const key = normCode(code);
  const doc = readDoc();
  const before = doc.codes.length;
  doc.codes = doc.codes.filter((c) => c.code !== key);
  writeDoc(doc);
  return doc.codes.length < before;
}

/** Burn one use (called when the order that used the code is created). */
export function redeemSale(code) {
  const key = normCode(code);
  const doc = readDoc();
  const sale = doc.codes.find((c) => c.code === key);
  if (!sale) return false;
  sale.uses = (sale.uses || 0) + 1;
  writeDoc(doc);
  return true;
}

/** PKR discount amount for a price + percent. */
export function discountAmount(pricePkr, percentOff) {
  const price = Number(pricePkr) || 0;
  const pct = Number(percentOff) || 0;
  if (price <= 0 || pct <= 0) return 0;
  return Math.round((price * pct) / 100);
}

// ── Checkout ────────────────────────────────────────────────
const PROMO_FLOW = 'promo_code';

/** Remember / clear the typed code on the checkout session. */
export function setPromo(jid, code) {
  saveSession(jid, { promoCode: code ? normCode(code) : null });
}
export function clearPromo(jid) {
  saveSession(jid, { promoCode: null });
}
export function currentPromo(jid) {
  return getSession(jid)?.promoCode || null;
}

/**
 * The discount this checkout should get — ONE place, used by the
 * screenshot flow (handlers/payments.js) and the wallet one-tap
 * (handlers/wallet.js) so both paths always agree.
 *
 * Priority: admin sale code (session) → loyalty code (eSIM only).
 * @returns {null | {code, percent, amount, source}}
 */
export function discountFor(jid, { catalog = 'esim', pricePkr = 0 } = {}) {
  const promo = currentPromo(jid);
  if (promo) {
    const st = saleState(promo);
    if (st.ok) {
      const amount = discountAmount(pricePkr, st.percentOff);
      if (amount > 0) return { code: st.code, percent: st.percentOff, amount, source: 'sale' };
    }
    // Stale/invalid code — drop it so the customer isn't shown it.
    clearPromo(jid);
  }
  if (catalog === 'esim') {
    const loyalty = validDiscount(jid);
    if (loyalty) {
      const amount = discountAmount(pricePkr, loyalty.percent);
      if (amount > 0) return { code: loyalty.code, percent: loyalty.percent, amount, source: 'loyalty' };
    }
  }
  return null;
}

export { PROMO_FLOW };
