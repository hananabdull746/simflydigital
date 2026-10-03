// ─────────────────────────────────────────────────────────────
// handlers/adminPlans.js
// 📦 Plans & Prices screen of the admin panel.
//
//   • LIST of every plan (hidden ones flagged)
//   • detail: price, wholesale cost, margin %, stock, visible?
//   • ✏️ Edit Price  = type a number -> "Old → New, apply?" -> the
//                     file is written INSTANTLY (plans.js re-reads
//                     data/plans.json on every call, so customers
//                     see the new price on the next message)
//   • 👁️ Show/Hide   = toggle `visible` (hidden plans disappear from
//                     the customer browse list but existing flows
//                     keep working)
//
// Owner-only for edits (staff can browse).
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, formatPrice, jidUser } from '../config.js';
import { sendText } from '../lib/ui.js';
import { getUser, setUser } from '../lib/store.js';
import { getPlan } from '../lib/plans.js';
import { checkAllStock } from '../services/esimaccess.js';
import { adminName, appendAudit, roleFor } from '../lib/admins.js';
import { adminScreen } from './adminPanel.js';
import { logError } from '../lib/logger.js';

// ── Catalogue read/write (data/plans.json) ────────────────────
function readDoc() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PATHS.plans, 'utf8'));
    if (!Array.isArray(parsed.plans)) throw new Error('missing "plans" array');
    return parsed;
  } catch (err) {
    logError('plans.read', err, { file: PATHS.plans });
    return { plans: [] };
  }
}

/** Atomic write so a crash can never truncate the catalogue. */
function writeDoc(doc) {
  fs.mkdirSync(path.dirname(PATHS.plans), { recursive: true });
  const tmp = `${PATHS.plans}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, PATHS.plans);
}

function updatePlan(planId, patch) {
  const doc = readDoc();
  const plan = doc.plans.find((p) => p.id === planId);
  if (!plan) return { ok: false, reason: 'not found' };
  Object.assign(plan, patch);
  writeDoc(doc);
  return { ok: true, plan };
}

/** Wholesale cost + margin for the detail line ("—" when unknown). */
function marginLines(plan) {
  const price = Number(plan.price || 0);
  const cost = Number.isFinite(Number(plan.cost)) && plan.cost !== null ? Number(plan.cost) : null;
  if (cost === null) return { cost: '—', margin: '—' };
  const profit = price - cost;
  const pct = price > 0 ? Math.round((profit / price) * 100) : 0;
  return { cost: formatPrice(cost), margin: `${formatPrice(profit)} (${pct}%)` };
}

// ── Screens ───────────────────────────────────────────────────
export async function openPlans(sock, jid, note) {
  const role = roleFor(jid);
  if (!role) return false;

  const doc = readDoc();
  let stock = {};
  try {
    stock = await checkAllStock();
  } catch {
    stock = {};
  }

  if (doc.plans.length === 0) {
    return adminScreen(sock, jid, {
      title: '📦 Plans & Prices',
      text: `❌ ${PATHS.plans} me koi plan nahi mila.`,
      buttons: [],
    });
  }

  const rows = doc.plans.map((p) => {
    const s = stock[p.id];
    const stockLabel = s?.ok === false ? 'OOS' : s?.ok ? `${s.stock ?? 0} left` : 'stock —';
    const hidden = p.visible === false ? ' · HIDDEN' : '';
    return {
      id: `adm:plan:${p.id}`,
      title: `${p.name} · ${formatPrice(p.price)}${hidden}`,
      description: `${p.data} · ${p.validity} · cost ${marginLines(p).cost} · ${stockLabel}`,
      keywords: [p.id, p.name.toLowerCase()],
    };
  });

  return adminScreen(sock, jid, {
    title: '📦 Plans & Prices',
    text: [
      `${doc.plans.length} plan(s) · tap for price / cost / stock.`,
      role === 'owner' ? '✏️ Price edit owner-only hai.' : '👁️ Staff view only — price edit owner karega.',
    ].join('\n'),
    list: { buttonText: 'Plan', sections: [{ title: 'Catalogue', rows }] },
    note,
  });
}

async function showPlan(sock, jid, planId, note) {
  const doc = readDoc();
  const plan = doc.plans.find((p) => p.id === planId);
  if (!plan) return adminScreen(sock, jid, {
    title: '📦 Plan',
    text: `❌ Plan *${planId}* nahi mila.`,
    buttons: [{ id: 'adm:plans', text: '⬅️ Plans' }],
  });

  let stockLabel = '—';
  try {
    const s = await checkAllStock();
    const hit = s[plan.id];
    stockLabel = hit?.ok === false ? '⛔ Out of stock' : hit?.ok ? `${hit.stock ?? 0} in stock` : '—';
  } catch {
    stockLabel = '—';
  }

  const { cost, margin } = marginLines(plan);
  const visible = plan.visible !== false;
  const buttons = [
    { id: `adm:planprice:${plan.id}`, text: '✏️ Edit Price' },
    { id: `adm:planvis:${plan.id}`, text: visible ? '👁️ Hide' : '👁️ Show' },
    { id: 'adm:plans', text: '🔙 Back' },
  ];
  const choices = buttons.map((b) => ({
    id: b.id, label: b.text, keywords: b.text.toLowerCase().replace(/^[^\w]+/, '').split(' '),
  }));

  return adminScreen(sock, jid, {
    title: plan.name,
    text: [
      `📦 *${plan.name}* (${plan.id})`,
      `📶 ${plan.data} · ${plan.validity}`,
      `💰 Sell: *${formatPrice(plan.price)}*`,
      `🏭 Cost: ${cost}`,
      `📈 Margin: ${margin}`,
      `📊 Stock: ${stockLabel}`,
      `👁️ Visible: ${visible ? 'YES' : 'NO (hidden from customers)'}`,
      plan.badge ? `🏅 Badge: ${plan.badge}` : null,
    ].filter(Boolean).join('\n'),
    buttons,
    choices,
    note,
  });
}

// ── Price editing ─────────────────────────────────────────────
export async function applyPrice(sock, jid, user, planId, amountText) {
  const role = roleFor(jid);
  if (role !== 'owner') {
    return adminScreen(sock, jid, {
      title: '🔒 Owner only',
      text: '✏️ Price edit sirf OWNER role kar sakta hai (staff view-only hai).',
      buttons: [{ id: 'adm:plans', text: '📦 Plans' }],
    });
  }

  const plan = getPlan(planId);
  if (!plan) return adminScreen(sock, jid, {
    title: '📦 Plans',
    text: `❌ Plan *${planId}* nahi mila.`,
    buttons: [{ id: 'adm:plans', text: '📦 Plans' }],
  });

  const amount = Number(String(amountText || '').replace(/[,\s]/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) {
    setUser(jid, { adminInput: 'price', adminPayload: planId });
    return sendText(sock, jid, `❌ *${amountText}* theek nahi lagta — sirf amount type karein (e.g. 249) ya *cancel* likhein.`);
  }

  // Confirm screen: Old → New, then apply.
  setUser(jid, { adminInput: null, adminPayload: null, flow: 'admin' });
  return adminScreen(sock, jid, {
    title: `✏️ ${plan.name}`,
    text: [
      `*Old:* ${formatPrice(plan.price)}`,
      `*New:* ${formatPrice(amount)}`,
      '',
      `Apply karein? Customers ko foran naya price dikhega.`,
    ].join('\n'),
    buttons: [
      { id: `adm:planapply:${planId}:${amount}`, text: '✅ Yes, apply' },
      { id: `adm:plan:${planId}`, text: '❌ Cancel' },
    ],
    choices: [
      { id: `adm:planapply:${planId}:${amount}`, label: '✅ Yes, apply', keywords: ['yes', 'apply', 'confirm'] },
      { id: `adm:plan:${planId}`, label: '❌ Cancel', keywords: ['cancel', 'no', 'back'] },
    ],
  });
}

async function commitPrice(sock, jid, user, planId, amount) {
  const before = getPlan(planId);
  if (!before) return openPlans(sock, jid);
  const price = Number(amount);
  if (!Number.isFinite(price) || price <= 0) return showPlan(sock, jid, planId, '❌ Amount galat hai.');

  const res = updatePlan(planId, { price });
  if (!res.ok) return openPlans(sock, jid, `❌ ${planId}: ${res.reason}`);

  const actor = adminName(jid, getUser(jid).pushName);
  appendAudit({
    actor: jidUser(jid), role: roleFor(jid), action: 'plan.price',
    target: planId, detail: `${formatPrice(before.price)} -> ${formatPrice(price)} by ${actor}`,
  });
  return showPlan(sock, jid, planId, `✅ ${before.name}: ${formatPrice(before.price)} → ${formatPrice(price)} (saved)`);
}

// ── Show / hide ───────────────────────────────────────────────
async function toggleVisible(sock, jid, user, planId) {
  const plan = getPlan(planId);
  if (!plan) return openPlans(sock, jid);
  const visible = plan.visible === false;
  const res = updatePlan(planId, { visible });
  if (!res.ok) return openPlans(sock, jid, `❌ ${planId}: ${res.reason}`);

  appendAudit({
    actor: jidUser(jid), role: roleFor(jid), action: visible ? 'plan.show' : 'plan.hide',
    target: planId, detail: `visible=${visible}`,
  });
  return showPlan(
    sock, jid, planId,
    visible ? `👁️ ${plan.name} customers ko dikhne laga.` : `🙈 ${plan.name} customers se chhup gaya (existing orders chalte rahenge).`,
  );
}

// ── id dispatch ───────────────────────────────────────────────
export async function handlePlansId(sock, jid, user, id) {
  if (!roleFor(jid)) return false;
  const [, cmd, a, b] = id.split(':');
  switch (cmd) {
    case 'plans':
      return openPlans(sock, jid);
    case 'plan':
      return showPlan(sock, jid, a);
    case 'planprice': {
      if (roleFor(jid) !== 'owner') {
        return adminScreen(sock, jid, {
          title: '🔒 Owner only',
          text: '✏️ Price edit sirf OWNER role kar sakta hai.',
          buttons: [{ id: `adm:plan:${a}`, text: '⬅️ Back' }],
        });
      }
      setUser(jid, { adminInput: 'price', adminPayload: a, flow: 'admin' });
      return sendText(sock, jid, `✏️ *${a}* ka naya price (PKR) type karein ya *cancel* likhein:`);
    }
    case 'planapply':
      return commitPrice(sock, jid, user, a, b);
    case 'planvis':
      return toggleVisible(sock, jid, user, a);
    default:
      return false;
  }
}
