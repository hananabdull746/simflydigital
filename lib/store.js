// ─────────────────────────────────────────────────────────────
// store.js
// Order + session store backed by lowdb (db/orders.json) — a
// lightweight local JSON database, no paid DB anywhere.
// Everything lives in memory for fast synchronous reads and is
// flushed to disk (atomic write) on a short debounce, so restarts
// keep Order IDs, per-user flow state and the full order history.
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { JSONFilePreset } from 'lowdb/node';
import { PATHS } from '../config.js';
import { logError } from './logger.js';

const DEFAULTS = () => ({ seq: 0, users: {}, orders: {} });

/** Normalise a loaded document so older/partial files never crash us. */
function normalize(data) {
  const doc = data && typeof data === 'object' ? data : {};
  doc.seq = Number.isFinite(doc.seq) ? doc.seq : 0;
  doc.users = doc.users && typeof doc.users === 'object' ? doc.users : {};
  doc.orders = doc.orders && typeof doc.orders === 'object' ? doc.orders : {};
  return doc;
}

/**
 * Open db/orders.json with lowdb. On the very first run we adopt the
 * pre-lowdb data/store.json (if present) so no orders are lost.
 */
async function openStore() {
  fs.mkdirSync(path.dirname(PATHS.orders), { recursive: true });

  let seed = DEFAULTS();
  const fresh = !fs.existsSync(PATHS.orders);
  if (fresh && fs.existsSync(PATHS.legacyStore)) {
    try {
      seed = { ...seed, ...JSON.parse(fs.readFileSync(PATHS.legacyStore, 'utf8')) };
      console.log(`[store] Imported legacy state from ${PATHS.legacyStore}`);
    } catch (err) {
      console.warn(`[store] Legacy store unreadable (${err.message}) — starting fresh.`);
    }
  }

  try {
    const db = await JSONFilePreset(PATHS.orders, seed);
    return db;
  } catch (err) {
    // Corrupt file: keep a backup and start clean rather than crash.
    const backup = `${PATHS.orders}.corrupt-${Date.now()}`;
    console.warn(`[store] ${PATHS.orders} unreadable (${err.message}) — backing up to ${backup}.`);
    try { fs.renameSync(PATHS.orders, backup); } catch { /* ignore */ }
    return JSONFilePreset(PATHS.orders, DEFAULTS());
  }
}

const db = await openStore();

/** The live in-memory document (same object lowdb serialises). */
export const state = normalize(db.data);

let flushTimer = null;

/** Persist immediately (lowdb writes atomically). Returns the write promise. */
export function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  return db.write().catch((err) => {
    console.error(`[store] Failed to persist ${PATHS.orders}: ${err.message}`);
    logError('store.flush', err);
  });
}

/** Debounced persist — avoids hammering disk on rapid messages. */
export function save() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, 250);
}

// ── Per-user session state ──────────────────────────────────
const BLANK_USER = () => ({
  seesButtons: true,   // false => this client needs numbered plain-text menus
  flow: 'menu',        // 'menu' | 'choose_plan' | 'plan_view' | 'choose_compat' | ...
  planId: null,        // currently highlighted plan
  planQty: null,       // eSIM quantity picked in Step 1 (1..MAX_QTY_ESIM)
  dpId: null,          // currently highlighted Digital Store product
  dpQty: null,         // digital quantity picked in Step 1 (1..QTY_MAX)
  orderId: null,       // order being built / tracking
  choices: [],         // snapshot of the buttons/list rows we last showed (for typed + numbered input)
  lastMenuAt: 0,       // anti-spam: last menu trigger timestamp
  pushName: null,      // WhatsApp profile name (shown to the admin on human handoff)
  adminInput: null,    // admin panel input mode (find / price / block / compose …)
  adminRelay: null,    // order id whose customer the admin is messaging right now
  adminPayload: null,  // scratch value for the active admin input mode
});

/** Get (or lazily create) the state object for a JID. */
export function getUser(jid) {
  if (!state.users[jid]) {
    state.users[jid] = BLANK_USER();
    save();
  }
  return { ...BLANK_USER(), ...state.users[jid] };
}

/** Mutate a user's state. Always call this instead of poking the object. */
export function setUser(jid, patch) {
  const next = { ...BLANK_USER(), ...getUser(jid), ...patch };
  state.users[jid] = next;
  save();
  return next;
}

/** Wipe a user's flow (used on cancel / completion). */
export function resetUser(jid) {
  return setUser(jid, { flow: 'menu', planId: null, planQty: null, dpId: null, dpQty: null, orderId: null, choices: [] });
}

// ── Order IDs ───────────────────────────────────────────────
/** Next unique Order ID, e.g. "SMF-0001". Sequence is persisted. */
export function nextOrderId() {
  state.seq = (state.seq || 0) + 1;
  save();
  return `SMF-${String(state.seq).padStart(4, '0')}`;
}

/**
 * Next wallet top-up reference, e.g. "WTP-0001".
 * Deliberately a DIFFERENT prefix from SMF so payment matching
 * (services/verifier.js) can never confuse the two.
 */
export function nextTopupId() {
  state.wtpSeq = (Number(state.wtpSeq) || 0) + 1;
  save();
  return `WTP-${String(state.wtpSeq).padStart(4, '0')}`;
}

// ── Orders ──────────────────────────────────────────────────
export function putOrder(order) {
  state.orders[order.id] = order;
  save();
  return order;
}

export function getOrder(id) {
  if (!id) return null;
  const key = String(id).toUpperCase();
  return state.orders[key] || null;
}

export function allOrders() {
  return Object.values(state.orders);
}

export function ordersFor(jid) {
  // Orders the customer deleted from their list stay in the store
  // (admin history keeps them) but disappear from their own view.
  return allOrders().filter((o) => o.jid === jid && !o.hidden);
}

/**
 * Orders waiting on a human decision. Besides the classic
 * "payment screenshot awaiting admin", the Digital Store adds two
 * more waiting states that an owner must act on:
 *   • awaiting_supplier_funding — customer paid, ProdSeller wallet empty
 *   • awaiting_activation       — supplier order placed, key not yet out
 * (wallet top-ups use the same pending_admin status, so they show
 * up here too — tagged "Wallet Top-up" by the admin panel.)
 */
export const PENDING_STATUSES = ['pending_admin', 'awaiting_supplier_funding', 'awaiting_activation'];

export function pendingOrders() {
  return allOrders().filter((o) => PENDING_STATUSES.includes(o.status));
}
