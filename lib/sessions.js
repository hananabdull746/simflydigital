// ─────────────────────────────────────────────────────────────
// lib/sessions.js
// Resumable order sessions + "🙋 Talk to Human" mode
// (db/sessions.json).
//
//   • A session is saved at every step of the order flow so a
//     customer who disappears can be offered "Continue?" for
//     SESSION_TTL_HOURS (default 24h).
//   • humanUntil marks the customer as handled by the human team
//     for HUMAN_MODE_MINUTES (default 30 min) — during that time
//     the bot stays quiet on free text (see handlers/human.js).
//   • Sessions are cleared when an order completes.
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { JSONFilePreset } from 'lowdb/node';
import { SETTINGS, PATHS } from '../config.js';
import { logError } from './logger.js';

const DEFAULTS = () => ({ sessions: {} });

function normalize(data) {
  const doc = data && typeof data === 'object' ? data : {};
  doc.sessions = doc.sessions && typeof doc.sessions === 'object' ? doc.sessions : {};
  return doc;
}

async function openSessions() {
  fs.mkdirSync(path.dirname(PATHS.sessions), { recursive: true });
  try {
    return await JSONFilePreset(PATHS.sessions, DEFAULTS());
  } catch (err) {
    const backup = `${PATHS.sessions}.corrupt-${Date.now()}`;
    console.warn(`[sessions] ${PATHS.sessions} unreadable (${err.message}) — backing up to ${backup}.`);
    try { fs.renameSync(PATHS.sessions, backup); } catch { /* ignore */ }
    return JSONFilePreset(PATHS.sessions, DEFAULTS());
  }
}

const db = await openSessions();
const state = normalize(db.data);

let timer = null;
function save() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    db.write().catch((err) => {
      console.error(`[sessions] Failed to persist ${PATHS.sessions}: ${err.message}`);
      logError('sessions.write', err);
    });
  }, 200);
}

const ttlMs = () => Math.max(1, SETTINGS.sessionTtlHours) * 60 * 60 * 1000;
export const humanMinutes = () => Math.max(1, SETTINGS.humanModeMinutes);
const humanMs = () => humanMinutes() * 60 * 1000;

/**
 * Upsert the session for a customer (merges — you can save just
 * the fields that changed). Always stamps updatedAt.
 * @param {string} jid
 * @param {{ step?: string, selectedPlanId?: string|null,
 *           selectedProductId?: string|null, orderId?: string|null,
 *           resumeAfterTopup?: boolean, humanUntil?: number }} patch
 */
export function saveSession(jid, patch = {}) {
  const prev = state.sessions[jid] || {};
  state.sessions[jid] = {
    ...prev,
    ...patch,
    jid,
    updatedAt: Date.now(),
  };
  save();
  return state.sessions[jid];
}

/**
 * The live session for a customer — null when there is none or it
 * is older than SESSION_TTL_HOURS (expired sessions are dropped).
 */
export function getSession(jid, now = Date.now()) {
  const s = state.sessions[jid];
  if (!s) return null;
  if (now - (s.updatedAt || 0) > ttlMs()) {
    delete state.sessions[jid];
    save();
    return null;
  }
  return s;
}

/**
 * True when there is a fresh, resumable ORDER step for this
 * customer — an eSIM plan OR a Digital Store product must have been
 * selected for the prompt to make sense.
 */
export function resumableSession(jid, now = Date.now()) {
  const s = getSession(jid, now);
  return s && s.step && (s.selectedPlanId || s.selectedProductId) ? s : null;
}

/**
 * Order completed / cancelled — drop the order part of the session.
 * A customer who is currently in human mode keeps that marker.
 */
export function clearSession(jid) {
  const s = state.sessions[jid];
  if (!s) return;
  const humanActive = (s.humanUntil || 0) > Date.now();
  if (humanActive) {
    state.sessions[jid] = {
      jid, step: null, selectedPlanId: null, selectedProductId: null,
      orderId: null, resumeAfterTopup: false, humanUntil: s.humanUntil, updatedAt: Date.now(),
    };
  } else {
    delete state.sessions[jid];
  }
  save();
}

// ── Human mode ──────────────────────────────────────────────
export function setHuman(jid) {
  const prev = state.sessions[jid] || {};
  state.sessions[jid] = {
    ...prev,
    jid,
    humanUntil: Date.now() + humanMs(),
    updatedAt: Date.now(),
  };
  save();
  return state.sessions[jid];
}

/** True while the customer is handed over to the human team. */
export function humanActive(jid, now = Date.now()) {
  const s = state.sessions[jid];
  return Boolean(s && (s.humanUntil || 0) > now);
}

/** Exact epoch-ms deadline of the current human window (0 = none). */
export function humanUntil(jid) {
  const s = state.sessions[jid];
  return (s && s.humanUntil) || 0;
}

export function clearHuman(jid) {
  const s = state.sessions[jid];
  if (!s) return false;
  if (!s.humanUntil) return false;
  delete s.humanUntil;
  save();
  return true;
}

/** Test helpers. */
export function __sessionStore() {
  return state.sessions;
}
export function __resetSession(jid) {
  delete state.sessions[jid];
  save();
}
