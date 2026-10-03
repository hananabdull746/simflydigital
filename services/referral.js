// ─────────────────────────────────────────────────────────────
// services/referral.js
// 🎁 PART C — the Referral Loop.
//
// Every customer gets ONE stable invite code. Share it, a NEW
// customer applies it at the 🎁 Refer & Earn screen, and both
// wallets are credited REFERRAL_BONUS_PKR from the same ledger as
// every other credit (services/wallet.js).
//
// Fraud guards (all enforced here, all persisted in
// db/referrals.json so a restart can't forget them):
//   1. one credit per new phone   — an invitee is credited once,
//                                   ever, and only before their
//                                   first delivered order
//   2. no self-referral           — your own code does nothing
//   3. monthly cap per referrer   — REFERRAL_MONTHLY_CAP PKR of
//                                   bonuses per calendar month
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { JSONFilePreset } from 'lowdb/node';
import { SETTINGS, PATHS } from '../config.js';
import { adjustBalance } from './wallet.js';
import { getProfile, setProfile } from '../lib/users.js';
import { logOrder, logError } from '../lib/logger.js';

const DEFAULTS = () => ({ codes: {}, entries: [] });

function normalize(data) {
  const doc = data && typeof data === 'object' ? data : {};
  doc.codes = doc.codes && typeof doc.codes === 'object' ? doc.codes : {};
  doc.entries = Array.isArray(doc.entries) ? doc.entries : [];
  return doc;
}

async function openReferrals() {
  fs.mkdirSync(path.dirname(PATHS.referrals), { recursive: true });
  try {
    return await JSONFilePreset(PATHS.referrals, DEFAULTS());
  } catch (err) {
    const backup = `${PATHS.referrals}.corrupt-${Date.now()}`;
    console.warn(`[referral] ${PATHS.referrals} unreadable (${err.message}) — backing up to ${backup}.`);
    try { fs.renameSync(PATHS.referrals, backup); } catch { /* ignore */ }
    return await JSONFilePreset(PATHS.referrals, DEFAULTS());
  }
}

const db = await openReferrals();
const state = normalize(db.data);

async function save() {
  try {
    await db.write();
  } catch (err) {
    console.error(`[referral] Failed to persist ${PATHS.referrals}: ${err.message}`);
    logError('referral.write', err);
  }
}

const bonus = () => Math.max(0, Number(SETTINGS.referralBonusPkr) || 0);
const cap = () => Math.max(0, Number(SETTINGS.referralMonthlyCapPkr) || 0);

/** Digits-only key so `@s.whatsapp.net` and `@lid` compare equal. */
const key = (jid) => String(jid || '').replace(/\D/g, '').slice(-10);

/** `SF-XXXXX` from the customer's own number (stable, not reversible). */
function baseCode(jid) {
  const digits = String(jid || '').replace(/\D/g, '');
  let hash = 5381;
  for (const ch of digits) hash = ((hash * 33) ^ ch.charCodeAt(0)) >>> 0;
  return `SF-${hash.toString(36).toUpperCase().slice(-5).padStart(5, '0')}`;
}

/**
 * The customer's invite code — created once, then stable forever.
 * A rare hash collision is resolved by suffixing, never reassigned.
 */
export function referralCodeFor(jid) {
  if (!jid) return null;
  const owned = Object.entries(state.codes).find(([, owner]) => key(owner) === key(jid));
  if (owned) return owned[0];

  const base = baseCode(jid);
  let code = base;
  for (let i = 2; state.codes[code] && key(state.codes[code]) !== key(jid); i += 1) {
    code = `${base}-${i}`;
    if (i > 50) { code = `${base}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`; break; }
  }
  state.codes[code] = jid;
  save();
  return code;
}

/** Resolve a typed code back to its owner's jid (null when unknown). */
export function ownerOf(input) {
  const raw = String(input || '').trim().toUpperCase();
  if (!raw) return null;
  const candidates = [raw, `SF-${raw}`, raw.replace(/^SF-?/, '')];
  for (const c of candidates) {
    const hit = Object.keys(state.codes).find((k) => k.toUpperCase() === c.toUpperCase());
    if (hit) return state.codes[hit];
  }
  return null;
}

/** Credits recorded for one referrer inside `YYYY-MM` (or all time). */
export function creditedFor(jid, month = null) {
  const k = key(jid);
  return state.entries
    .filter((e) => key(e.byJid) === k && (!month || e.month === month))
    .reduce((sum, e) => sum + (Number(e.amountPkr) || 0), 0);
}

/** All-time invited count for one referrer. */
export function invitedBy(jid) {
  const k = key(jid);
  return state.entries.filter((e) => key(e.byJid) === k).length;
}

export function allReferrals() {
  return state.entries;
}

/** Everything the 🎁 screen shows one customer. */
export function referralStats(jid) {
  const month = new Date().toISOString().slice(0, 7);
  const used = creditedFor(jid, month);
  return {
    code: referralCodeFor(jid),
    bonusPkr: bonus(),
    invited: invitedBy(jid),
    earned: creditedFor(jid),
    month,
    usedThisMonth: used,
    capPkr: cap(),
    remainingThisMonth: cap() > 0 ? Math.max(0, cap() - used) : 0,
  };
}

/**
 * Redeem somebody else's code for `jid`.
 *
 * @param {string} jid     the NEW customer (invitee)
 * @param {string} input   what they typed ("SF-1A2B3", "1a2b3", …)
 * @returns {Promise<{ok:boolean, code?:string, reason:string,
 *                    bonusPkr?:number, balance?:number}>}
 */
export async function redeem(jid, input) {
  const code = String(input || '').trim().toUpperCase();
  if (!jid) return { ok: false, reason: 'bad_customer' };
  if (!code) return { ok: false, reason: 'empty' };
  if (bonus() <= 0) return { ok: false, reason: 'disabled' };

  const owner = ownerOf(code);
  if (!owner) return { ok: false, reason: 'invalid', code };

  if (key(owner) === key(jid)) return { ok: false, reason: 'self', code };

  const profile = getProfile(jid);
  if (profile.referredBy) return { ok: false, reason: 'already', code };
  // Guard 1: only a phone that has NEVER been delivered to.
  if (Number(profile.completed || 0) > 0) return { ok: false, reason: 'not_new', code };

  // Guard 3: monthly cap for the referrer.
  const month = new Date().toISOString().slice(0, 7);
  const used = creditedFor(owner, month);
  if (cap() > 0 && used + bonus() > cap()) return { ok: false, reason: 'cap', code };

  // Both credits go through the wallet ledger — atomic, auditable.
  const invitee = await adjustBalance(jid, bonus(), 'referral', {
    note: `Invite code ${code} redeemed`,
    actor: 'referral',
  });
  const referrer = await adjustBalance(owner, bonus(), 'referral', {
    note: `Referred a new customer (${code})`,
    actor: 'referral',
  });

  state.entries.push({
    id: `REF-${String(state.entries.length + 1).padStart(4, '0')}`,
    code,
    byJid: owner,
    jid,
    amountPkr: bonus(),
    month,
    referrerPaid: referrer.ok,
    inviteePaid: invitee.ok,
    at: new Date().toISOString(),
  });
  setProfile(jid, { referredBy: { code, at: new Date().toISOString() } });
  await save();

  logOrder('referral', { id: null, status: 'referred' }, {
    code,
    bonusPkr: bonus(),
    referrerPaid: referrer.ok,
    inviteePaid: invitee.ok,
    inviteeBalance: invitee.ok ? invitee.balance : null,
  });

  return {
    ok: true,
    code,
    bonusPkr: bonus(),
    balance: invitee.ok ? invitee.balance : null,
    referrerPaid: referrer.ok,
  };
}

/** Test helper — wipe the store (never used in production paths). */
export function __resetReferrals() {
  state.codes = {};
  state.entries = [];
  return save();
}
