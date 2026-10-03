// ─────────────────────────────────────────────────────────────
// lib/alerts.js
// Plan alert subscriptions + the stock/price snapshot the cron
// job diffs against (db/alerts.json).
//
//   • type 'restock' — this customer wants THIS plan back in stock
//   • type 'price'   — this customer wants to hear about drops
//   • at most ONE alert per subscriber per day (lastAlertDay)
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { JSONFilePreset } from 'lowdb/node';
import { PATHS } from '../config.js';
import { logError } from './logger.js';

const DEFAULTS = () => ({ seq: 0, subscriptions: {}, snapshot: {} });

function normalize(data) {
  const doc = data && typeof data === 'object' ? data : {};
  doc.seq = Number.isFinite(doc.seq) ? doc.seq : 0;
  doc.subscriptions = doc.subscriptions && typeof doc.subscriptions === 'object' ? doc.subscriptions : {};
  doc.snapshot = doc.snapshot && typeof doc.snapshot === 'object' ? doc.snapshot : {};
  return doc;
}

async function openAlerts() {
  fs.mkdirSync(path.dirname(PATHS.alerts), { recursive: true });
  try {
    return await JSONFilePreset(PATHS.alerts, DEFAULTS());
  } catch (err) {
    const backup = `${PATHS.alerts}.corrupt-${Date.now()}`;
    console.warn(`[alerts] ${PATHS.alerts} unreadable (${err.message}) — backing up to ${backup}.`);
    try { fs.renameSync(PATHS.alerts, backup); } catch { /* ignore */ }
    return JSONFilePreset(PATHS.alerts, DEFAULTS());
  }
}

const db = await openAlerts();
const state = normalize(db.data);

let timer = null;
function save() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    db.write().catch((err) => {
      console.error(`[alerts] Failed to persist ${PATHS.alerts}: ${err.message}`);
      logError('alerts.write', err);
    });
  }, 200);
}

const key = (jid, type, planId) => `${jid}|${type}|${planId || '*'}`;

export function subscribe(jid, type, planId = null) {
  const id = key(jid, type, planId);
  if (state.subscriptions[id]) return state.subscriptions[id];
  state.seq += 1;
  state.subscriptions[id] = {
    id: `ALR-${String(state.seq).padStart(4, '0')}`,
    jid,
    type,                       // 'restock' | 'price'
    planId: planId || null,
    createdAt: Date.now(),
    lastAlertDay: null,
  };
  save();
  return state.subscriptions[id];
}

export function unsubscribe(jid, type, planId = null) {
  const id = key(jid, type, planId);
  const existed = Boolean(state.subscriptions[id]);
  delete state.subscriptions[id];
  save();
  return existed;
}

/** Remove by stored entry id (the 🔕 Unsubscribe button). */
export function unsubscribeById(entryId) {
  const entry = Object.values(state.subscriptions).find((s) => s.id === entryId);
  if (!entry) return null;
  delete state.subscriptions[key(entry.jid, entry.type, entry.planId)];
  save();
  return entry;
}

export function findSubscription(jid, type, planId = null) {
  return state.subscriptions[key(jid, type, planId)] || null;
}

export function subsFor(type, planId = null) {
  return Object.values(state.subscriptions).filter(
    (s) => s.type === type && (planId == null || s.planId === planId)
  );
}

export function allSubsFor(jid) {
  return Object.values(state.subscriptions).filter((s) => s.jid === jid);
}

/** Every subscription entry (broadcast audience "alert subscribers"). */
export function allSubscriptions() {
  return Object.values(state.subscriptions);
}

export const dayKey = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/** One alert per subscriber per day, hard rule. */
export function alertAllowed(entry, now = Date.now()) {
  return entry.lastAlertDay !== dayKey(now);
}

export function markAlerted(entryId, now = Date.now()) {
  const entry = Object.values(state.subscriptions).find((s) => s.id === entryId);
  if (entry) {
    entry.lastAlertDay = dayKey(now);
    save();
  }
  return entry;
}

// ── Snapshot (stock + price) ────────────────────────────────
export function getSnapshot() {
  return state.snapshot || {};
}

export function setSnapshot(snapshot) {
  state.snapshot = snapshot || {};
  save();
  return state.snapshot;
}
