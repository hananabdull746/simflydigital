// ─────────────────────────────────────────────────────────────
// lib/admins.js
// Admin system state (Part 1 — in-WhatsApp admin panel).
//
//   • roles      owner (everything) / staff (orders, customers,
//                support only). Resolved from the SENDER JID
//                number alone — never from names or message text.
//   • audit      every admin action appended to db/audit.json
//                (who, what, target, timestamp) and shown in the
//                dashboard / "Recent activity" screen.
//   • blocklist  blocked customers get NO replies (attempts logged)
//   • opt-out    customers who replied STOP (no more broadcasts)
//   • settings   maintenance mode, auto-verifier, accept-orders,
//                review broadcast, default language, quiet hours
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { JSONFilePreset } from 'lowdb/node';
import {
  ADMIN_JID, ALL_ADMIN_JIDS, BRAND, CHANNEL_LINK, OWNER_JIDS, STAFF_JIDS, jidUser, toJid,
} from '../config.js';
import { logAdmin, logError } from './logger.js';

// ── Roles ──────────────────────────────────────────────────────

const dedupe = (list) => list.filter((jid, i) => list.indexOf(jid) === i);

/** JIDs added at runtime from the panel (role filtered, null = any). */
function dynamicJids(role = null) {
  return Object.entries(adminState?.extraAdmins || {})
    .filter(([, v]) => !role || v.role === role)
    .map(([num]) => toJid(num))
    .filter(Boolean);
}

// ── @lid senders (WhatsApp privacy JIDs) ───────────────────────
// Every DM on this bot arrives as `<digits>@lid` — the sender's
// number is hidden. roleFor() keys on phone numbers, so the lid →
// number mapping is resolved once per sender and remembered.

const lidToPn = new Map(); // lid digits -> number digits ('' = not an admin)

const isLidJid = (jid) => /@(hosted\.)?lid$/.test(String(jid || ''));

/** Remember a lid→number mapping (also the unit-test seam). */
export function rememberLid(lidDigits, pnDigits) {
  if (lidDigits) lidToPn.set(String(lidDigits), String(pnDigits || ''));
}

/**
 * Role of a sender, decided ONLY by their phone number.
 * Checks .env lists first, then admins added from the panel.
 * @returns {'owner'|'staff'|null}
 */
export function roleFor(jid) {
  let num = jidUser(jid);
  if (!num) return null;
  if (isLidJid(jid)) {
    // Privacy sender (@lid): check the phone number that
    // linkLidAdmin() mapped for this lid — unknown lid = nobody.
    num = lidToPn.get(num);
    if (!num) return null;
  }
  if (OWNER_JIDS.some((o) => jidUser(o) === num)) return 'owner';
  if (STAFF_JIDS.some((s) => jidUser(s) === num)) return 'staff';
  const dyn = adminState?.extraAdmins?.[num];
  return dyn ? dyn.role : null;
}

/**
 * Resolve the phone number behind an @lid sender (once per sender).
 * Fast path: baileys' local lid store. Fallback: ask for each
 * configured admin's own LID (USync, cached by baileys) and compare —
 * only an admin's lid maps to a number, every other sender stays a
 * customer. Never throws: an unresolved lid keeps today's behaviour.
 */
export async function linkLidAdmin(sock, jid) {
  const lidNum = jidUser(jid);
  if (!lidNum || lidToPn.has(lidNum)) return;
  try {
    const store = sock?.signalRepository?.lidMapping;
    if (!store) { lidToPn.set(lidNum, ''); return; }
    let pnJid = await store.getPNForLID(jid);
    if (!pnJid) {
      for (const adminJid of allAdminJids()) {
        const lidJid = await store.getLIDForPN(adminJid);
        if (lidJid && jidUser(lidJid) === lidNum) { pnJid = adminJid; break; }
      }
    }
    lidToPn.set(lidNum, pnJid ? jidUser(pnJid) : '');
  } catch (err) {
    // Not cached — the next message from this lid retries.
    logError('admin.lid', err, { lid: lidNum });
  }
}

export const isOwner = (jid) => roleFor(jid) === 'owner';
export const isStaff = (jid) => roleFor(jid) === 'staff';
/** Any admin (owner or staff). */
export const isAdminJid = (jid) => roleFor(jid) !== null;

export const ownerJids = () => dedupe([...OWNER_JIDS, ...dynamicJids('owner')]);
export const allAdminJids = () => dedupe([...ALL_ADMIN_JIDS, ...dynamicJids()]);

// ── Add / remove admins (panel, owner only) ────────────────────

/**
 * Add an admin at runtime (persisted in db/admin.json).
 * @param {string} input number or JID (0300…, 92300…, …@s.whatsapp.net)
 * @param {'owner'|'staff'} role
 * @returns {{ok:boolean, number?:string, role?:string, message:string}}
 */
export function addAdmin(input, role = 'staff', by = '') {
  const num = jidUser(toJid(input));
  if (!num || !/^\d{7,15}$/.test(num)) {
    return { ok: false, message: '❌ Number valid nahi hai — format e.g. `03001234567`.' };
  }
  const existing = roleFor(num);
  if (existing) {
    return { ok: false, message: `⚠️ +${num} pehle se admin hai (${existing}).` };
  }
  const clean = role === 'owner' ? 'owner' : 'staff';
  adminState.extraAdmins[num] = { role: clean, by, at: new Date().toISOString() };
  saveAdmin();
  return { ok: true, number: num, role: clean, message: `✅ +${num} ab *${clean === 'owner' ? 'Owner 🧭' : 'Staff 🧑‍💻'}* hai.` };
}

/**
 * Remove a runtime-added admin. .env-configured admins are locked
 * (they must be removed from ADMIN_NUMBERS / STAFF_NUMBERS).
 */
export function removeAdmin(input) {
  const num = jidUser(toJid(input));
  if (!num) return { ok: false, message: '❌ Number valid nahi hai.' };
  if (OWNER_JIDS.some((o) => jidUser(o) === num) || STAFF_JIDS.some((s) => jidUser(s) === num)) {
    return { ok: false, message: `🔒 +${num} .env (ADMIN_NUMBERS / STAFF_NUMBERS) se manage hota hai — wahan se hatayein.` };
  }
  if (!adminState.extraAdmins[num]) {
    return { ok: false, message: `❌ +${num} admin list me nahi hai.` };
  }
  delete adminState.extraAdmins[num];
  saveAdmin();
  return { ok: true, number: num, message: `🗑️ +${num} ke admin rights hata diye.` };
}

/** Every admin with its origin (env = .env file, added = panel). */
export function listAdmins() {
  const env = [
    ...OWNER_JIDS.map((j) => ({ number: jidUser(j), role: 'owner', source: 'env' })),
    ...STAFF_JIDS.map((j) => ({ number: jidUser(j), role: 'staff', source: 'env' })),
  ];
  const added = Object.entries(adminState.extraAdmins).map(([number, v]) => ({
    number, role: v.role, source: 'added', by: v.by || '', at: v.at || '',
  }));
  const seen = new Set();
  return [...env, ...added].filter((a) => !seen.has(a.number) && seen.add(a.number));
}

/** Display name for audit lines / "by [admin]": profile name, else number. */
export function adminName(jid, pushName) {
  if (pushName) return String(pushName).trim();
  return `+${jidUser(jid)}`;
}

/** True when the primary owner (ADMIN_WHATSAPP_NUMBER) is configured. */
export const hasPrimaryOwner = () => Boolean(ADMIN_JID);

// ── Audit log (db/audit.json) ──────────────────────────────────
const AUDIT_MAX = 500;

const AUDIT_DEFAULTS = () => ({ entries: [] });

function normalizeAudit(data) {
  const doc = data && typeof data === 'object' ? data : {};
  doc.entries = Array.isArray(doc.entries) ? doc.entries : [];
  return doc;
}

async function openAudit() {
  fs.mkdirSync(path.dirname(PATHS_AUDIT), { recursive: true });
  try {
    return await JSONFilePreset(PATHS_AUDIT, AUDIT_DEFAULTS());
  } catch (err) {
    const backup = `${PATHS_AUDIT}.corrupt-${Date.now()}`;
    console.warn(`[audit] ${PATHS_AUDIT} unreadable (${err.message}) — backing up to ${backup}.`);
    try { fs.renameSync(PATHS_AUDIT, backup); } catch { /* ignore */ }
    return JSONFilePreset(PATHS_AUDIT, AUDIT_DEFAULTS());
  }
}

// Resolved lazily so config can finish loading first (keeps the
// import order identical to the other lowdb modules).
let PATHS_AUDIT = null;
let auditDb = null;
let auditState = { entries: [] };
let auditReady = null;

async function ensureAudit() {
  if (auditReady) return auditReady;
  auditReady = (async () => {
    const { PATHS } = await import('../config.js');
    PATHS_AUDIT = PATHS.audit;
    auditDb = await openAudit();
    auditState = normalizeAudit(auditDb.data);
  })();
  return auditReady;
}
// Kick off at module load (top-level await, same pattern as sessions.js).
await ensureAudit();

/**
 * Append one audit entry. Never throws — auditing must not break a flow.
 * @param {{actor:string, role?:string, action:string, target?:string, detail?:string}} entry
 */
export function appendAudit(entry) {
  try {
    const record = {
      at: new Date().toISOString(),
      actor: entry.actor || 'unknown',
      role: entry.role || roleFor(entry.actor) || 'owner',
      action: entry.action || 'unknown',
      target: entry.target || '',
      detail: entry.detail || '',
    };
    auditState.entries.push(record);
    if (auditState.entries.length > AUDIT_MAX) {
      auditState.entries = auditState.entries.slice(-AUDIT_MAX);
    }
    logAdmin('audit', record);
    scheduleAuditWrite();
    return record;
  } catch (err) {
    logError('audit.append', err, { action: entry?.action });
    return null;
  }
}

let auditTimer = null;
function scheduleAuditWrite() {
  if (auditTimer) return;
  auditTimer = setTimeout(() => {
    auditTimer = null;
    auditDb.write().catch((err) => {
      console.error(`[audit] Failed to persist: ${err.message}`);
      logError('audit.write', err);
    });
  }, 200);
}

/** Newest-first slice of the audit log (for the dashboard / panel). */
export function recentAudit(limit = 10) {
  return auditState.entries.slice(-Number(limit) || 10).reverse();
}

// ── Admin state (db/admin.json): settings + blocklist + opt-out ─
const ADMIN_DEFAULTS = () => ({
  settings: {
    maintenance: false,
    maintenanceMsg:
      '⚠️ Bot maintenance me hai — hum jald wapas aa rahe hain. Urgent ho toh *support* likhein.',
    autoVerifier: 'off', // 'off' | 'shadow' | 'on'
    acceptOrders: true,
    reviewBroadcast: true,
    defaultLang: 'ur',
    quietHours: { enabled: false, start: 22, end: 9 }, // hours, PKT
    channelLink: '',  // optional override of WHATSAPP_CHANNEL_LINK
    groupJid: '',     // customer-updates group (…@g.us) for group updates
    // 🎨 Branding — blank = use the .env values (BRAND_NAME …).
    // Change these to rebrand the whole bot live (e.g. "Simfly Store").
    brandName: '',
    brandTagline: '',
  },
  blocked: {},   // { [number]: { jid, by, at, reason } }
  optOut: {},    // { [number]: { jid, at } }  — replied STOP
  extraAdmins: {}, // { [number]: { role: 'owner'|'staff', by, at } } — panel-added
});

function normalizeAdminDoc(data) {
  const doc = data && typeof data === 'object' ? data : {};
  const defaults = ADMIN_DEFAULTS();
  doc.settings = { ...defaults.settings, ...(doc.settings || {}) };
  doc.settings.quietHours = { ...defaults.settings.quietHours, ...(doc.settings.quietHours || {}) };
  doc.blocked = doc.blocked && typeof doc.blocked === 'object' ? doc.blocked : {};
  doc.optOut = doc.optOut && typeof doc.optOut === 'object' ? doc.optOut : {};
  doc.extraAdmins = doc.extraAdmins && typeof doc.extraAdmins === 'object' ? doc.extraAdmins : {};
  return doc;
}

// ── 🎨 Live branding ───────────────────────────────────────────
// The .env values, captured once at boot. The panel can override
// name + tagline at runtime (settings.brandName / settings.brandTagline)
// — e.g. rebrand the whole bot live without touching .env or
// restarting. BRAND.footer is a DERIVED getter (name ⚡ tagline), so
// it always follows whatever name/tagline are live.
const ENV_BRAND = { name: BRAND.name, tagline: BRAND.tagline };

/**
 * Push the current settings into the live BRAND object. Every
 * screen reads BRAND.* when it renders, so this is instant.
 * @returns {{name:string, tagline:string, footer:string}}
 */
export function applyBranding(settings = adminState?.settings || {}) {
  const name = String(settings.brandName || '').trim();
  const tagline = String(settings.brandTagline || '').trim();
  BRAND.name = name || ENV_BRAND.name;
  BRAND.tagline = tagline || ENV_BRAND.tagline;
  return { name: BRAND.name, tagline: BRAND.tagline, footer: BRAND.footer };
}

async function openAdminDoc(pathToUse) {
  fs.mkdirSync(path.dirname(pathToUse), { recursive: true });
  try {
    return await JSONFilePreset(pathToUse, ADMIN_DEFAULTS());
  } catch (err) {
    const backup = `${pathToUse}.corrupt-${Date.now()}`;
    console.warn(`[admin] ${pathToUse} unreadable (${err.message}) — backing up to ${backup}.`);
    try { fs.renameSync(pathToUse, backup); } catch { /* ignore */ }
    return JSONFilePreset(pathToUse, ADMIN_DEFAULTS());
  }
}

let adminDb = null;
let adminState = null;
let adminReady = null;

async function ensureAdmin() {
  if (adminReady) return adminReady;
  adminReady = (async () => {
    const { PATHS } = await import('../config.js');
    adminDb = await openAdminDoc(PATHS.admin);
    adminState = normalizeAdminDoc(adminDb.data);
    applyBranding(adminState.settings);
  })();
  return adminReady;
}
await ensureAdmin();

let adminTimer = null;
function saveAdmin() {
  if (adminTimer) return;
  adminTimer = setTimeout(() => {
    adminTimer = null;
    adminDb.write().catch((err) => {
      console.error(`[admin] Failed to persist: ${err.message}`);
      logError('admin.write', err);
    });
  }, 200);
}

// ── Bot settings ───────────────────────────────────────────────
export function getSettings() {
  return adminState.settings;
}

/** Patch + persist settings. Returns the merged settings object. */
export function setSettings(patch) {
  adminState.settings = normalizeAdminDoc({
    ...adminState,
    settings: { ...adminState.settings, ...(patch || {}) },
  }).settings;
  applyBranding(adminState.settings);
  saveAdmin();
  return adminState.settings;
}

/** Toggle helper with confirmation payload for the audit log. */
export function toggleSetting(key, value) {
  const before = adminState.settings[key];
  setSettings({ [key]: value });
  return { key, before, after: adminState.settings[key] };
}

/** Current hour in PKT (Asia/Karachi) — quiet hours are PKT-based. */
export function pktHour(now = Date.now()) {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Karachi', hour: 'numeric', hour12: false,
  }).format(new Date(now));
  return Number(formatted) % 24;
}

/** True when quiet hours are active right now (spans midnight). */
export function isQuietNow(now = Date.now()) {
  const q = adminState.settings.quietHours || {};
  if (!q.enabled) return false;
  const hour = pktHour(now);
  const start = Number(q.start);
  const end = Number(q.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

// ── Channel link + updates group (panel-managed) ───────────────
/** Active channel link: panel override first, then WHATSAPP_CHANNEL_LINK. */
export const getChannelLink = () => adminState.settings.channelLink || CHANNEL_LINK;
/** Group the bot posts update messages to ("" = not set yet). */
export const getGroupJid = () => adminState.settings.groupJid || '';

/** Human label for the end of quiet hours, e.g. "9am". */
export function quietEndLabel() {
  const end = Number(adminState.settings.quietHours?.end ?? 9);
  const suffix = end >= 12 ? 'pm' : 'am';
  const h = end % 12 === 0 ? 12 : end % 12;
  return `${h}${suffix}`;
}

// ── Maintenance / accept-orders gates ─────────────────────────
export const isMaintenance = () => adminState.settings.maintenance === true;
export const acceptsOrders = () => adminState.settings.acceptOrders !== false;
export const reviewBroadcastEnabled = () => adminState.settings.reviewBroadcast !== false;
export const defaultLang = () => (adminState.settings.defaultLang === 'en' ? 'en' : 'ur');

// ── Blocklist ──────────────────────────────────────────────────
export function isBlocked(jid) {
  return Boolean(adminState.blocked[jidUser(jid)]);
}

export function blockJid(jid, by, reason = '') {
  const num = jidUser(jid);
  if (!num) return false;
  adminState.blocked[num] = { jid, by, at: new Date().toISOString(), reason };
  saveAdmin();
  return true;
}

export function unblockJid(jid) {
  const num = jidUser(jid);
  if (!adminState.blocked[num]) return false;
  delete adminState.blocked[num];
  saveAdmin();
  return true;
}

export function allBlocked() {
  return Object.values(adminState.blocked);
}

// ── Broadcast opt-out (customer replied STOP) ─────────────────
export function isOptedOut(jid) {
  return Boolean(adminState.optOut[jidUser(jid)]);
}

export function optOut(jid) {
  const num = jidUser(jid);
  if (!num || adminState.optOut[num]) return false;
  adminState.optOut[num] = { jid, at: new Date().toISOString() };
  saveAdmin();
  return true;
}

export function optIn(jid) {
  const num = jidUser(jid);
  if (!adminState.optOut[num]) return false;
  delete adminState.optOut[num];
  saveAdmin();
  return true;
}

export function allOptedOut() {
  return Object.values(adminState.optOut);
}

/** Test helper — force a fresh state document. */
export function __resetAdminState() {
  adminState = normalizeAdminDoc(ADMIN_DEFAULTS());
  saveAdmin();
  return adminState;
}
