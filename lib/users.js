// ─────────────────────────────────────────────────────────────
// lib/users.js
// Per-customer profile (db/users.json): language preference,
// completed-order counter and the loyalty discount code.
// No phone numbers are stored here — the JID is the only key and
// this file never leaves the machine (see .gitignore).
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { JSONFilePreset } from 'lowdb/node';
import { SETTINGS, PATHS } from '../config.js';
import { logError } from './logger.js';

const DEFAULTS = () => ({ seq: 0, users: {} });

function normalize(data) {
  const doc = data && typeof data === 'object' ? data : {};
  doc.seq = Number.isFinite(doc.seq) ? doc.seq : 0;
  doc.users = doc.users && typeof doc.users === 'object' ? doc.users : {};
  return doc;
}

async function openUsers() {
  fs.mkdirSync(path.dirname(PATHS.users), { recursive: true });
  try {
    return await JSONFilePreset(PATHS.users, DEFAULTS());
  } catch (err) {
    const backup = `${PATHS.users}.corrupt-${Date.now()}`;
    console.warn(`[users] ${PATHS.users} unreadable (${err.message}) — backing up to ${backup}.`);
    try { fs.renameSync(PATHS.users, backup); } catch { /* ignore */ }
    return JSONFilePreset(PATHS.users, DEFAULTS());
  }
}

const db = await openUsers();
const state = normalize(db.data);

let timer = null;
function save() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    db.write().catch((err) => {
      console.error(`[users] Failed to persist ${PATHS.users}: ${err.message}`);
      logError('users.write', err);
    });
  }, 200);
}

const BLANK = () => ({
  lang: 'ur',          // 'ur' = Roman Urdu + English mix (default), 'en' = Full English
  completed: 0,        // fulfilled orders (loyalty counter)
  discount: null,      // { code, percent, expiry, used } — one-time reward
  // One-time device micro-check (Step 1): ISO date the customer
  // confirmed "eSIM supported + factory unlocked". Once set the
  // compatibility/unlock questions are never asked again.
  confirmedUnlocked: null,
});

/** Read (or lazily create) a customer profile. */
export function getProfile(jid) {
  if (!state.users[jid]) {
    state.users[jid] = BLANK();
    save();
  }
  return { ...BLANK(), ...state.users[jid] };
}

export function setProfile(jid, patch) {
  const next = { ...getProfile(jid), ...patch };
  state.users[jid] = next;
  save();
  return next;
}

// ── One-time device micro-check (Step 1) ─────────────────────
/** True once this customer has confirmed eSIM support + factory unlock. */
export function deviceConfirmed(jid) {
  return Boolean(getProfile(jid).confirmedUnlocked);
}

/** Stamp the confirmation so the micro-check is never asked again. */
export function markDeviceConfirmed(jid) {
  return setProfile(jid, { confirmedUnlocked: new Date().toISOString() });
}

// ── Language ────────────────────────────────────────────────
export function getLang(jid) {
  const lang = getProfile(jid).lang;
  return lang === 'en' ? 'en' : 'ur';
}

export function setLang(jid, lang) {
  return setProfile(jid, { lang: lang === 'en' ? 'en' : 'ur' });
}

// ── Loyalty counter ─────────────────────────────────────────
const THRESHOLD = () => Math.max(1, SETTINGS.loyaltyOrders);
const PERCENT = () => Math.max(1, SETTINGS.loyaltyDiscountPercent);
const DISCOUNT_MS = 30 * 24 * 60 * 60 * 1000; // 30-day validity

function genCode(jid) {
  const tail = (jid || '').replace(/\D/g, '').slice(-4) || '0000';
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `SIMFLY${PERCENT()}-${tail}${state.seq}-${rand}`;
}

/**
 * Call once per DELIVERED order.
 * @returns {{ completed: number, remaining: number,
 *             reward: {code, percent}|null }}
 *   reward is set exactly when this order unlocked a new code.
 */
export function recordCompletedOrder(jid) {
  const profile = getProfile(jid);
  const threshold = THRESHOLD();
  profile.completed = (profile.completed || 0) + 1;

  let reward = null;
  if (profile.completed % threshold === 0) {
    reward = { code: genCode(jid), percent: PERCENT() };
    profile.discount = {
      ...reward,
      expiry: Date.now() + DISCOUNT_MS,
      used: false,
      issuedAt: Date.now(),
    };
  }
  state.users[jid] = profile;
  save();

  const remaining = threshold - (profile.completed % threshold);
  return { completed: profile.completed, remaining, reward };
}

/** A still-valid, unused discount code for this customer (or null). */
export function validDiscount(jid) {
  const d = getProfile(jid).discount;
  if (!d || d.used) return null;
  if (d.expiry && Date.now() > d.expiry) return null;
  return d;
}

/** Mark the customer's current discount code as spent (single-use). */
export function consumeDiscount(jid) {
  const d = validDiscount(jid);
  if (!d) return false;
  const profile = getProfile(jid);
  profile.discount = { ...profile.discount, used: true };
  state.users[jid] = profile;
  save();
  return true;
}

/** Test helper — wipe a profile. */
export function __clearProfile(jid) {
  delete state.users[jid];
  save();
}
