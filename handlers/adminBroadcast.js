// ─────────────────────────────────────────────────────────────
// handlers/adminBroadcast.js
// 📢 Broadcast screen of the admin panel.
//
// Safety rules baked in (this bot messages customers over an
// UNOFFICIAL WhatsApp route — mass-messaging is the #1 ban risk):
//   • only customers who ordered before, or who opted IN by
//     subscribing to alerts, are ever recipients
//   • blocked + STOP (opt-out) JIDs are always skipped
//   • BROADCAST_MSGS_PER_MINUTE (default 8) + random 3–9s jitter
//   • BROADCAST_DAILY_CAP (default 200) hard daily ceiling
//   • a live ⏹️ Stop button cancels the run mid-flight
//   • preview before send, and a compliance note on every preview
//
// Flow: audience → compose (text, optional image) → preview →
//       ✅ Send / ✏️ Edit / ❌ Cancel → throttled send → summary.
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { SETTINGS, PATHS, jidUser } from '../config.js';
import { sendButtons, sendText } from '../lib/ui.js';
import { allOrders, getUser, setUser } from '../lib/store.js';
import { isBlocked, isOptedOut, adminName, appendAudit, roleFor } from '../lib/admins.js';
import { allSubscriptions } from '../lib/alerts.js';
import { downloadMediaMessage } from '@itsliaaa/baileys';
import pino from 'pino';
import { adminScreen } from './adminPanel.js';
import { logAdmin, logError } from '../lib/logger.js';

const logger = pino({ level: 'silent' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Drafts + stop flags live OUTSIDE user state (a Buffer draft must
// never be serialised into db/orders.json).
const drafts = new Map();   // adminJid -> { audience, text, image }
const stopFlags = new Map(); // adminJid -> boolean

const AUDIENCES = [
  { key: 'all', title: '👥 All customers', description: 'Jinke paas kabhi ek bhi order hai' },
  { key: 'recent', title: '🕒 Bought in last 30 days', description: 'Pichle 30 din ke buyers' },
  { key: 'subs', title: '🔔 Alert subscribers', description: 'Jinhone restock/price alerts enable kiye' },
];

const AUDIENCE_LABEL = {
  all: 'All customers',
  recent: 'Last 30 days',
  subs: 'Alert subscribers',
};

/** Recipients for an audience — blocked + opted-out always dropped. */
export function resolveAudience(audience) {
  const seen = new Set();
  const out = [];
  const push = (jid) => {
    if (!jid) return;
    if (seen.has(jid)) return;
    if (isBlocked(jid) || isOptedOut(jid)) return;
    seen.add(jid);
    out.push(jid);
  };

  if (audience === 'subs') {
    for (const s of allSubscriptions()) push(s.jid);
    return out;
  }

  const since = audience === 'recent' ? Date.now() - 30 * 86400000 : -Infinity;
  for (const order of allOrders()) {
    if (new Date(order.createdAt || 0).getTime() >= since) push(order.jid);
  }
  return out;
}

// ── Daily cap counter (db/broadcast.json) ─────────────────────
// Tiny daily counters → plain fs (no lowdb, no top-level await:
// this module sits in an import cycle with adminPanel).
const dayKey = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });

function readDays() {
  try {
    const doc = JSON.parse(fs.readFileSync(PATHS.broadcast, 'utf8'));
    return doc.days && typeof doc.days === 'object' ? doc.days : {};
  } catch {
    return {};
  }
}

const days = readDays();

/** How many broadcast messages have gone out today (PKT). */
export function broadcastUsage() {
  return Number(days[dayKey()] || 0);
}

function bumpUsage(n = 1) {
  const key = dayKey();
  days[key] = Number(days[key] || 0) + n;
  try {
    fs.mkdirSync(path.dirname(PATHS.broadcast), { recursive: true });
    const tmp = `${PATHS.broadcast}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ days }, null, 2));
    fs.renameSync(tmp, PATHS.broadcast);
  } catch (err) {
    logError('broadcast.write', err);
  }
}

const jitter = () => {
  const [min, max] = SETTINGS.broadcastJitterMs || [3000, 9000];
  return min + Math.floor(Math.random() * Math.max(1, max - min));
};

// ── Screens ───────────────────────────────────────────────────
export async function openBroadcast(sock, jid, note) {
  if (!roleFor(jid)) return false;
  const rows = AUDIENCES.map((a) => ({
    id: `adm:bca:${a.key}`,
    title: a.title,
    description: a.description,
    keywords: a.key === 'all' ? ['all', 'customers'] : a.key === 'recent' ? ['recent', '30', 'days'] : ['subscribers', 'alerts'],
  }));
  return adminScreen(sock, jid, {
    title: '📢 Broadcast',
    text: [
      'Audience choose karein.',
      '',
      `📤 Aaj bheje: ${broadcastUsage()}/${SETTINGS.broadcastDailyCap} (daily cap)`,
      `⚡ Rate: ${SETTINGS.broadcastPerMinute}/min + random 3–9s jitter`,
      '',
      '🔒 Sirf existing customers ya alert subscribers — blocked/STOP wale chhod diye jate hain.',
    ].join('\n'),
    list: { buttonText: 'Audience', sections: [{ title: 'Audience', rows }] },
    note,
  });
}

async function askMessage(sock, jid, audience) {
  setUser(jid, { adminInput: 'broadcast', adminPayload: audience, flow: 'admin' });
  return sendText(sock, jid, [
    `📢 *${AUDIENCE_LABEL[audience]}* — ab message likhein.`,
    '',
    'Plain text bhejein. Saath image chahiye toh seedha photo bhej dein (phir caption likhein).',
    '*cancel* likhein toh band ho jayega.',
    '',
    '⚠️ PII (phone numbers, logins, screenshots) mat likhein.',
  ].join('\n'));
}

/** Preview: everything the admin sees before anything leaves. */
async function showPreview(sock, jid, draft, note) {
  const recipients = resolveAudience(draft.audience);
  const used = broadcastUsage();
  const remaining = Math.max(0, SETTINGS.broadcastDailyCap - used);
  const capped = Math.min(recipients.length, remaining);
  const perMsg = 60000 / SETTINGS.broadcastPerMinute + 6000;
  const mins = Math.max(1, Math.ceil((capped * perMsg) / 60000));

  setUser(jid, { adminInput: null, adminPayload: null, flow: 'admin' });
  return adminScreen(sock, jid, {
    title: '📢 Broadcast preview',
    text: [
      `Audience: *${AUDIENCE_LABEL[draft.audience]}*`,
      `👥 Estimated recipients: *${capped}*${capped < recipients.length ? ` (cap aaj ${remaining} tak hi allow karega)` : ''}`,
      `⏱️ Estimated time: ~${mins} min (${SETTINGS.broadcastPerMinute}/min + jitter)`,
      `📤 Aaj bheje: ${used}/${SETTINGS.broadcastDailyCap}`,
      '',
      '── message ──',
      String(draft.text || '').slice(0, 900),
      draft.image ? '\n🖼️ + image attached' : '',
      '',
      '── end ──',
      '',
      '🔒 PII mat bhejein. Customers STOP likh kar opt-out kar sakte hain.',
      '📢 Channel par post karna safer hai — DM sirf zaroori ho toh.',
    ].filter(Boolean).join('\n'),
    buttons: [
      { id: 'adm:bcgo', text: '✅ Send' },
      { id: 'adm:bcedit', text: '✏️ Edit' },
      { id: 'adm:bccancel', text: '❌ Cancel' },
    ],
    choices: [
      { id: 'adm:bcgo', label: '✅ Send', keywords: ['send', 'yes', 'go'] },
      { id: 'adm:bcedit', label: '✏️ Edit', keywords: ['edit', 'change'] },
      { id: 'adm:bccancel', label: '❌ Cancel', keywords: ['cancel', 'no', 'back'] },
    ],
    note,
  });
}

// ── Compose ───────────────────────────────────────────────────
export async function composeBroadcast(sock, jid, user, text) {
  const audience = user.adminPayload || 'all';
  const draft = drafts.get(jid) || { audience, text: null, image: null };
  draft.audience = audience;
  draft.text = text;
  drafts.set(jid, draft);
  return showPreview(sock, jid, draft);
}

export async function attachBroadcastImage(sock, jid, user, rawMsg) {
  const audience = user.adminPayload || 'all';
  const draft = drafts.get(jid) || { audience, text: null, image: null };
  draft.audience = audience;
  try {
    draft.image = await downloadMediaMessage(rawMsg, 'buffer', {}, {
      logger,
      reuploadRequest: sock.updateMediaMessage,
    });
  } catch (err) {
    logError('broadcast.image', err, {});
    await sendText(sock, jid, `❌ Image download fail: ${err.message}`);
    return true;
  }
  drafts.set(jid, draft);
  if (draft.text) return showPreview(sock, jid, draft);
  return askMessage(sock, jid, draft.audience); // now type the caption/text
}

// ── Send loop ─────────────────────────────────────────────────
async function runSend(sock, jid, user) {
  const draft = drafts.get(jid);
  if (!draft || !draft.text) {
    return openBroadcast(sock, jid, '❌ Pehle message compose karein.');
  }

  const recipients = resolveAudience(draft.audience);
  const used = broadcastUsage();
  const remaining = Math.max(0, SETTINGS.broadcastDailyCap - used);
  if (recipients.length === 0 || remaining === 0) {
    return openBroadcast(
      sock, jid,
      remaining === 0
        ? `❌ Daily cap (${SETTINGS.broadcastDailyCap}) poora — aaj aur broadcast nahi.`
        : '❌ Is audience me koi recipient nahi mila.',
    );
  }

  const targets = recipients.slice(0, remaining);
  const skipped = recipients.length - targets.length;
  const actor = adminName(jid, getUser(jid).pushName);

  stopFlags.set(jid, false);
  appendAudit({
    actor: jidUser(jid), role: roleFor(jid), action: 'broadcast.start',
    target: draft.audience, detail: `${targets.length} recipients by ${actor}`,
  });
  logAdmin('broadcast.start', { from: jidUser(jid), audience: draft.audience, recipients: targets.length });

  await sendButtons(sock, jid, {
    title: '📤 Broadcast running',
    text: [
      `${targets.length} recipients ko bheja ja raha hai…`,
      skipped > 0 ? `⚠️ Daily cap ki wajah se ${skipped} chhod diye.` : '',
      `⚡ ${SETTINGS.broadcastPerMinute}/min + 3–9s jitter — rukne me thora waqt.`,
    ].filter(Boolean).join('\n'),
    buttons: [
      { id: 'adm:bcstop', text: '⏹️ Stop' },
      { id: 'adm:menu', text: '⬅️ Admin Menu' },
    ],
  }).catch(() => null);

  let sent = 0;
  let failed = 0;
  let stopped = false;
  const perMessage = Math.round(60000 / SETTINGS.broadcastPerMinute);

  for (const to of targets) {
    if (stopFlags.get(jid)) {
      stopped = true;
      break;
    }
    try {
      if (draft.image) await sock.sendMessage(to, { image: draft.image, caption: draft.text });
      else await sendText(sock, to, draft.text);
      sent += 1;
      bumpUsage();
    } catch (err) {
      failed += 1;
      logError('broadcast.send', err, { to });
    }
    await sleep(perMessage + jitter());
  }

  stopFlags.delete(jid);
  drafts.delete(jid);
  setUser(jid, { adminInput: null, adminPayload: null, flow: 'admin' });

  appendAudit({
    actor: jidUser(jid), role: roleFor(jid), action: 'broadcast.end',
    target: draft.audience, detail: `sent=${sent} failed=${failed} stopped=${stopped}`,
  });

  return adminScreen(sock, jid, {
    title: stopped ? '⏹️ Broadcast stopped' : '✅ Broadcast done',
    text: [
      stopped ? `⏹️ Rok diya gaya.` : `✅ Broadcast mukammal.`,
      '',
      `📤 Sent: *${sent}*`,
      `❌ Failed: ${failed}`,
      skipped > 0 ? `⏭️ Cap ki wajah se chhode: ${skipped}` : '',
      `📤 Aaj total: ${broadcastUsage()}/${SETTINGS.broadcastDailyCap}`,
    ].filter(Boolean).join('\n'),
    buttons: [{ id: 'adm:bc', text: '📢 New broadcast' }],
    choices: [{ id: 'adm:bc', label: '📢 New broadcast', keywords: ['new', 'broadcast', 'again'] }],
  });
}

/** Mid-run stop button (works because the loop awaits sleeps). */
export async function stopBroadcast(sock, jid) {
  if (!stopFlags.has(jid)) {
    return adminScreen(sock, jid, {
      title: '⏹️ Stop',
      text: 'Koi broadcast chal nahi raha.',
      buttons: [{ id: 'adm:bc', text: '📢 Broadcast' }],
    });
  }
  stopFlags.set(jid, true);
  await sendText(sock, jid, '⏹️ Stop bhej diya — current message ke baad ruk jayega.');
  return true;
}

// ── id dispatch ───────────────────────────────────────────────
export async function handleBroadcastId(sock, jid, user, id) {
  if (!roleFor(jid)) return false;
  const [, cmd, a] = id.split(':');
  switch (cmd) {
    case 'bc':
      return openBroadcast(sock, jid);
    case 'bca':
      drafts.set(jid, { audience: a, text: null, image: null });
      return askMessage(sock, jid, a);
    case 'bcgo':
      return runSend(sock, jid, user);
    case 'bcedit':
      return askMessage(sock, jid, drafts.get(jid)?.audience || 'all');
    case 'bccancel':
      drafts.delete(jid);
      setUser(jid, { adminInput: null, adminPayload: null, flow: 'admin' });
      return adminScreen(sock, jid, {
        title: '❌ Broadcast cancelled',
        text: 'Kuch bhi send nahi hua.',
        buttons: [{ id: 'adm:bc', text: '📢 Broadcast' }],
      });
    case 'bcstop':
      return stopBroadcast(sock, jid);
    default:
      return false;
  }
}
