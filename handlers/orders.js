// ─────────────────────────────────────────────────────────────
// handlers/orders.js
// Order lifecycle + status tracking:
//   Step 1 (Choose & Confirm): compatibility → factory unlock
//   (ONE time, then never again) → quantity
//   → Step 2 (Pay: payments.js handles method + screenshot)
//   → 15-min timeout reminders → admin confirm/reject
//   → receipt + eSIM delivery via services/esimaccess (or manual)
//
// UX batch additions:
//   • "Step X of 2" progress prefixes (lib/steps.js)
//   • session saved at every step (resume broken flow)
//   • stock re-checked before payment + before purchaseEsim()
//   • compact receipt-style delivery confirmation (PKT time)
//   • 🔁 one-tap reorder (jumps to the payment step)
//   • 🛒 quantity up to MAX_QTY_ESIM — every unit bought + delivered
//     as its OWN eSIM
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN_JID, BRAND, PATHS, SETTINGS, SUPPORT_WA_LINK, formatPrice, jidUser } from '../config.js';
import { sendButtons, sendList, sendText } from '../lib/ui.js';
import { getPlan, planOneLiner } from '../lib/plans.js';
import { deviceConfirmed, getLang, markDeviceConfirmed } from '../lib/users.js';
import { t } from '../lib/lang.js';
import { sendPlans, sendMyOrders, sendOutOfStock } from './menu.js';
import { askPaymentMethod } from './payments.js';
import { startPostOrder } from './reviews.js';
import { withNav, withNavChoices, withAck, withListNav, LIST_NAV_CHOICES } from './ui.js';
import { STEP_PAYMENT, STEP_PRODUCT_QTY, withStep } from '../lib/steps.js';
import { saveSession, clearSession } from '../lib/sessions.js';
import { getUser, setUser, resetUser, putOrder, getOrder, flush, pendingOrders, ordersFor } from '../lib/store.js';
import { checkStock, purchaseEsim } from '../services/esimaccess.js';
import { purchaseFailedAlert } from '../services/adminAlerts.js';
import { notifyOrderCancelled } from './adminPanel.js';
import { allowProactive } from '../services/pacing.js';
import { logOrder, logError } from '../lib/logger.js';

// One pending reminder timer per Order ID (so we never double-send).
const reminders = new Map();

const now = () => new Date().toISOString();

// ── Choice sets (used by the router for typed/numbered input) ─
export const COMPAT_CHOICES = [
  { id: 'compat_yes', label: '✅ Yes, eSIM supported', keywords: ['yes', 'y', 'compatible', 'support karta', 'haan', 'han'] },
  { id: 'compat_no', label: '❌ Not sure / No', keywords: ['no', 'not sure', 'nhi', 'nahi', 'check', 'kaise'] },
];

export const COMPAT_CONFIRM_CHOICES = [
  { id: 'compat_yes', label: '✅ Ab confirm hai', keywords: ['yes', 'y', 'confirm', 'compatible', 'haan', 'han', 'ab'] },
  { id: 'back_plans', label: '⬅️ Back to Plans', keywords: ['back', 'plans', 'plan', 'nhi', 'nahi'] },
];

// Follow-up after "Yes, eSIM supported": factory-unlock status decides
// whether the eSIM can actually activate on the device.
export const UNLOCK_CHOICES = [
  { id: 'unlock_yes', label: '✅ Yes, Factory Unlocked', keywords: ['yes', 'y', 'unlocked', 'factory unlocked', 'factory', 'haan', 'han'] },
  { id: 'unlock_no', label: '🔒 No, Carrier-Locked', keywords: ['no', 'n', 'locked', 'carrier locked', 'carrier', 'lock', 'nhi', 'nahi'] },
  { id: 'unlock_unsure', label: '❓ Not Sure', keywords: ['not sure', 'unsure', 'sure', 'pata nahi', 'check', 'kaise', 'kaise pata'] },
];

// ── Step 1: device micro-check (ONE time) + quantity ────────
// The compatibility + factory-unlock questions belong to Step 1
// ("Choose & Confirm"). They run ONCE per customer — the answer is
// stamped into db/users.json as `confirmedUnlocked`, and every
// later order jumps straight to the quantity picker.
export async function startOrder(sock, jid, planId) {
  const lang = getLang(jid);
  const plan = getPlan(planId);
  if (!plan) return sendPlans(sock, jid);

  setUser(jid, { planId: plan.id, planQty: null, orderId: null });
  saveSession(jid, {
    step: STEP_PRODUCT_QTY,
    selectedPlanId: plan.id,
    selectedProductId: null,
    orderId: null,
    resumeAfterTopup: false,
  });

  if (deviceConfirmed(jid)) return askPlanQuantity(sock, jid, plan);

  setUser(jid, { flow: 'choose_compat', choices: withNavChoices(COMPAT_CHOICES) });

  await sendButtons(sock, jid, {
    title: '✅ Compatibility Check',
    text: withStep(STEP_PRODUCT_QTY, [
      t('compat_lead', {}, lang),
      '',
      t('compat_plan', { v: plan.name }, lang),
      t('compat_price', { v: formatPrice(plan.price) }, lang),
      '',
      t('compat_q', {}, lang),
      t('compat_check', {}, lang),
    ].join('\n')),
    buttons: withNav([
      { id: 'compat_yes', text: t('compat_yes', {}, lang) },
      { id: 'compat_no', text: t('compat_no', {}, lang) },
    ]),
  });
}

export async function handleCompat(sock, jid, choiceId) {
  const lang = getLang(jid);
  if (choiceId === 'compat_no') {
    // One-line self-check + one-line help link (spec: quick-check).
    setUser(jid, { flow: 'choose_compat', choices: withNavChoices(COMPAT_CONFIRM_CHOICES) });
    saveSession(jid, { step: STEP_PRODUCT_QTY });
    await sendButtons(sock, jid, {
      title: '🔍 eSIM Check',
      text: withStep(STEP_PRODUCT_QTY, [
        t('check_hint', {}, lang),
        '',
        t('check_help', { link: SUPPORT_WA_LINK }, lang),
      ].join('\n')),
      buttons: withNav([
        { id: 'compat_yes', text: t('compat_confirm', {}, lang) },
        { id: 'back_plans', text: t('nav_back_plans', {}, lang) },
      ]),
    });
    return;
  }

  return askUnlockCheck(sock, jid);
}

// ── Step 1: factory-unlock check ──────────────────────────────
// A data-only eSIM profile needs an unlocked device; a carrier-locked
// phone (commonly iPhone) cannot add it. Checked before payment.
export async function askUnlockCheck(sock, jid) {
  const lang = getLang(jid);
  // setUser merges into the existing state, so planId survives this step.
  setUser(jid, { flow: 'choose_unlock', choices: withNavChoices(UNLOCK_CHOICES) });
  saveSession(jid, { step: STEP_PRODUCT_QTY });

  await sendButtons(sock, jid, {
    title: '📱 Factory Unlock Check',
    text: withStep(STEP_PRODUCT_QTY, [
      t('unlock_q', {}, lang),
      '',
      t('unlock_note', {}, lang),
    ].join('\n')),
    buttons: withNav([
      { id: 'unlock_yes', text: t('unlock_yes', {}, lang) },
      { id: 'unlock_no', text: t('unlock_no', {}, lang) },
      { id: 'unlock_unsure', text: t('unlock_unsure', {}, lang) },
    ]),
  });
}

export async function handleUnlock(sock, jid, choiceId) {
  const lang = getLang(jid);

  // Carrier-locked device: stop the order flow here — no payment step.
  if (choiceId === 'unlock_no') {
    resetUser(jid);
    clearSession(jid);
    const own = [
      { id: 'menu:support', label: t('nav_support', {}, lang), keywords: ['support', 'help'] },
      { id: 'back_menu', label: t('nav_back_menu', {}, lang), keywords: ['menu', 'back', 'home'] },
    ];
    const choices = withNavChoices(own);
    await sendButtons(sock, jid, {
      title: '🔒 Device not supported',
      text: [
        t('locked_l1', {}, lang),
        '',
        t('locked_l2', {}, lang),
        '',
        t('locked_l3', {}, lang),
      ].join('\n'),
      buttons: choices.map((c) => ({ id: c.id, text: c.label })),
    });
    setUser(jid, { choices });
    return;
  }

  // Not sure: simple self-check, then continue once confirmed.
  if (choiceId === 'unlock_unsure') {
    setUser(jid, { flow: 'choose_unlock', choices: UNLOCK_CHOICES });
    saveSession(jid, { step: STEP_PRODUCT_QTY });
    const choices = withNavChoices([
      { id: 'unlock_yes', label: t('unlock_yes', {}, lang), keywords: ['yes', 'y', 'unlocked', 'haan', 'han'] },
      { id: 'unlock_no', label: t('unlock_no', {}, lang), keywords: ['no', 'n', 'locked', 'carrier', 'nhi', 'nahi'] },
    ]);
    await sendButtons(sock, jid, {
      title: '❓ How to check unlock status',
      text: withStep(STEP_PRODUCT_QTY, [
        t('unsure_head', {}, lang),
        '',
        t('unsure_step1', {}, lang),
        t('unsure_step2', {}, lang),
        t('unsure_step3', {}, lang),
        '',
        t('unsure_confirm', {}, lang),
      ].join('\n')),
      buttons: choices.map((c) => ({ id: c.id, text: c.label })),
    });
    setUser(jid, { choices });
    return;
  }

  // ✅ Confirmed — remember it FOREVER so this is a one-time check.
  markDeviceConfirmed(jid);
  return askPlanQuantity(sock, jid);
}

// ── Step 1: quantity (how many eSIMs this order holds) ──────
/** Biggest quantity one order may hold (env MAX_QTY_ESIM, default 3). */
export const ESIM_QTY_MAX = () => Math.max(1, SETTINGS.maxQtyEsim);

/** Row values for the quantity picker — 1..max while it stays short. */
export function esimQtySteps(max = ESIM_QTY_MAX()) {
  if (max <= 5) return Array.from({ length: max }, (_, i) => i + 1);
  return [...new Set([1, 2, 3, 5, max])];
}

const NAV_BY_ID = new Map(LIST_NAV_CHOICES.map((c) => [c.id, c]));

/** user.choices for a list we just displayed (nav rows keep their own labels). */
function listChoices(sections) {
  return sections.flatMap((s) => s.rows || []).map((r) => NAV_BY_ID.get(r.id) || {
    id: r.id,
    label: r.title,
    keywords: [String(r.title).toLowerCase(), String(r.id).toLowerCase()],
  });
}

/**
 * The quantity screen of Step 1. Each unit is bought and delivered
 * as its own eSIM, so the customer picks the count here — right
 * before payment, after the one-time device check.
 */
export async function askPlanQuantity(sock, jid, plan) {
  const lang = getLang(jid);
  const p = plan || getPlan(getUser(jid).planId);
  if (!p) return sendPlans(sock, jid);

  const max = ESIM_QTY_MAX();
  const steps = esimQtySteps(max);

  const sections = withListNav([{
    title: '🛒 Kitne eSIM lene hain?',
    rows: steps.map((n) => ({
      id: `eqty:${n}`,
      title: n === 1 ? '1 eSIM (standard)' : `${n} eSIMs`,
      description: n === 1
        ? `${formatPrice(p.price)} · single`
        : `${formatPrice(p.price * n)} · ${formatPrice(p.price)} each`,
    })),
  }]);

  setUser(jid, { flow: 'esim_qty', planId: p.id, planQty: null, orderId: null, choices: listChoices(sections) });
  saveSession(jid, { step: STEP_PRODUCT_QTY, selectedPlanId: p.id, orderId: null });

  await sendList(sock, jid, {
    title: '🛒 Quantity',
    buttonText: 'Select qty',
    text: [
      `*${p.name}*`,
      `Ek eSIM: ${formatPrice(p.price)}`,
      '',
      `📊 ${p.data} • ${p.validity}`,
      '',
      max > 1
        ? `Aap ek order me *1–${max}* eSIM le sakte hain — har eSIM alag QR/code ke saath aayegi.`
        : 'Aapke device check ke mutabiq ek eSIM isi order me deliver hogi.',
      '',
      `Quantity tap karein, ya number likhein (1–${max}).`,
    ].join('\n'),
    sections,
  });
  return true;
}

/** A quantity was tapped (eqty:N) or typed (flow: esim_qty). */
export async function handlePlanQuantity(sock, jid, value) {
  const plan = getPlan(getUser(jid).planId);
  if (!plan) return sendPlans(sock, jid);

  const max = ESIM_QTY_MAX();
  const n = Number(String(value ?? '').replace(/[^0-9]/g, ''));
  if (!Number.isInteger(n) || n < 1 || n > max) {
    await sendText(sock, jid, `❌ Quantity 1–${max} ke beech honi chahiye — dobara try karein.`);
    return askPlanQuantity(sock, jid, plan);
  }

  setUser(jid, { planId: plan.id, planQty: n, flow: 'choose_payment', orderId: null });
  saveSession(jid, { step: STEP_PRODUCT_QTY, selectedPlanId: plan.id, orderId: null });
  return askPaymentMethod(sock, jid);
}

// ── 15-minute "still processing" auto-message + admin ping ──
export function armReminder(sock, orderId) {
  const order = getOrder(orderId);
  if (!order || order.status !== 'pending_admin' || order.reminderSent) return;

  const existing = reminders.get(orderId);
  if (existing) clearTimeout(existing);

  const delay = Math.max(0, (order.reminderAt || Date.now()) - Date.now());
  const timer = setTimeout(() => fireReminder(sock, orderId), delay);
  reminders.set(orderId, timer);
}

async function fireReminder(sock, orderId) {
  reminders.delete(orderId);
  const order = getOrder(orderId);
  if (!order || order.status !== 'pending_admin' || order.reminderSent) return;

  order.reminderSent = true;
  order.updatedAt = now();
  putOrder(order);
  flush();

  const mins = Math.max(1, Math.round(SETTINGS.autoReminderMs / 60000));
  const lang = getLang(order.jid);

  // 1. Customer gets a polite "we're on it" — unless they were nudged
  //    inside BROADCAST_MIN_GAP_MINUTES, in which case we stay quiet
  //    (the admin ping below is operational and always goes out).
  const nudged = allowProactive(order.jid);
  if (nudged) {
    try {
      const own = [
        { id: 'menu:support', label: t('nav_support', {}, lang), keywords: ['support', 'help'] },
        { id: 'menu:orders', label: t('nav_orders', {}, lang), keywords: ['orders', 'track', 'status'] },
      ];
      const choices = withNavChoices(own);
      await sendButtons(sock, order.jid, {
        title: '⏳ Processing update',
        text: [
          t('reminder_head', { id: order.id }, lang),
          '',
          t('reminder_body', { id: order.id }, lang),
          t('reminder_ask', {}, lang),
        ].join('\n'),
        buttons: choices.map((c) => ({ id: c.id, text: c.label })),
      });
      console.log(`[orders] Customer reminder sent for ${order.id}`);
    } catch (err) {
      console.error(`[orders] Reminder failed for ${order.id}: ${err.message}`);
      logError('reminder.customer', err, { orderId });
    }
  } else {
    console.log(`[orders] Customer reminder for ${order.id} suppressed (nudge gap)`);
  }

  // 2. Admin gets a nudge to act (spec: 15 min no action -> ping).
  if (ADMIN_JID) {
    try {
      await sendText(
        sock,
        ADMIN_JID,
        [
          `⏰ *${order.id}* — ${mins} min se pending hai!`,
          '',
          `📶 ${order.planName} • ${formatPrice(order.price)}`,
          `💳 ${order.paymentLabel} • 👤 +${order.phone}`,
          '',
          `\`confirm ${order.id}\` ya \`reject ${order.id} reason\``,
        ].join('\n')
      );
      console.log(`[orders] Admin ping sent for ${order.id}`);
    } catch (err) {
      console.error(`[orders] Admin ping failed for ${order.id}: ${err.message}`);
      logError('reminder.admin', err, { orderId });
    }
  }

  logOrder('timeout_reminder', order, { adminPing: Boolean(ADMIN_JID), customerNudged: nudged });
}

/** Re-arm timers after a bot restart so reminders aren't lost. */
export function rearmReminders(sock) {
  const pending = pendingOrders();
  for (const order of pending) {
    if (order.reminderSent) continue;
    if (!order.reminderAt) order.reminderAt = Date.now() + SETTINGS.autoReminderMs;
    armReminder(sock, order.id);
  }
  if (pending.length) console.log(`[orders] Re-armed ${pending.length} pending reminder(s).`);
}

function clearReminder(orderId) {
  const t = reminders.get(orderId);
  if (t) clearTimeout(t);
  reminders.delete(orderId);
}

/** Exported for handlers/digitalStore.js (lazy import — see clearReminderSafe). */
export function __clearOrderReminder(orderId) {
  clearReminder(orderId);
}

/** Test helper — drop every pending reminder timer (nothing keeps the process alive). */
export function __clearReminders() {
  for (const t of reminders.values()) clearTimeout(t);
  reminders.clear();
}

// ── Cancel ──────────────────────────────────────────────────
// Finished orders can't be cancelled — one polite line, no state change.
const FINISHED_LABEL = {
  fulfilled: 'deliver ho chuka hai ✅',
  rejected: 'reject ho chuka hai 🚫',
  cancelled: 'pehle hi cancel ho chuka hai ⛔',
};

export async function cancelOrder(sock, jid) {
  const lang = getLang(jid);
  const user = getUser(jid);
  const order = user.orderId ? getOrder(user.orderId) : null;

  if (order && FINISHED_LABEL[order.status]) {
    // Exactly ONE short reply — no reset, no card, no message rush
    // (the order detail screen stays open).
    return sendText(sock, jid, `⚠️ *${order.id}* ${FINISHED_LABEL[order.status]} — yahan sirf 🗑️ Delete kaam karta hai.`);
  }

  // Customer may cancel any time BEFORE fulfilment — including while
  // the screenshot waits for admin verification (pending_admin).
  if (order && (order.status === 'await_screenshot' || order.status === 'pending_admin')) {
    const wasPendingAdmin = order.status === 'pending_admin';
    order.status = 'cancelled';
    order.cancelledBy = 'customer';
    order.updatedAt = now();
    putOrder(order);
    logOrder('cancelled', order, { by: jidUser(jid), wasPendingAdmin });
    flush();
    if (wasPendingAdmin) {
      // The admins already have an open card for this order — say it.
      try {
        await notifyOrderCancelled(sock, order);
      } catch (err) {
        logError('order.cancel_notice', err, { orderId: order.id });
      }
    }
    // 💰 Wallet-paid orders refund themselves the moment they die
    //    (the money never left our ledger — the customer just gets
    //    the balance back instantly).
    if (order.paidBy === 'wallet' && order.catalogType !== 'wallet_topup') {
      try {
        const { refundToWallet } = await import('./digitalStore.js');
        await refundToWallet(sock, order, 'order cancelled by customer');
      } catch (err) {
        logError('cancel.refund', err, { orderId: order.id });
      }
    }
  }
  if (order) clearReminder(order.id);
  resetUser(jid);
  clearSession(jid);

  const own = [
    { id: 'menu:plans', label: t('nav_plans', {}, lang), keywords: ['plans', 'plan', 'data', 'browse'] },
    { id: 'back_menu', label: t('nav_back_menu', {}, lang), keywords: ['menu', 'back', 'home'] },
  ];
  const choices = withNavChoices(own);
  setUser(jid, { choices });
  await sendButtons(sock, jid, {
    title: '⛔ Order cancelled',
    text: [t('cancel_body', {}, lang), '', t('cancel_hint', {}, lang)].join('\n'),
    buttons: choices.map((c) => ({ id: c.id, text: c.label })),
  });
}

/**
 * 🗑️ Delete from the customer's My Orders list (order detail →
 * Delete button). Deleting a still-open order cancels it first so
 * the admins' open card is never left dangling. The record itself
 * stays in the store — it just disappears from the customer's view.
 *
 * Messaging stays minimal (one confirmation line + the silent list)
 * so the customer never gets a burst of messages.
 */
export async function deleteOrder(sock, jid) {
  const user = getUser(jid);
  const order = user.orderId ? getOrder(user.orderId) : null;
  if (!order || order.jid !== jid) return sendText(sock, jid, '❌ Order nahi mila.');

  if (order.status === 'await_screenshot' || order.status === 'pending_admin') {
    order.status = 'cancelled';
    order.cancelledBy = 'customer';
    order.updatedAt = now();
    putOrder(order);
    logOrder('cancelled', order, { by: jidUser(jid), via: 'delete' });
    flush();
    clearReminder(order.id);
    try {
      await notifyOrderCancelled(sock, order);
    } catch (err) {
      logError('order.cancel_notice', err, { orderId: order.id });
    }
  }

  order.hidden = true;
  order.updatedAt = now();
  putOrder(order);
  flush();
  logOrder('deleted', order, { by: jidUser(jid) });

  await sendText(sock, jid, `🗑️ *${order.id}* hata diya gaya.`);
  return sendMyOrders(sock, jid, { silent: true });
}

// ── Manual delivery payload (data/deliveries.json) ──────────
// Used when ESIMACCESS credentials are NOT configured — the bot
// still delivers an activation guide the admin has prepared.
function loadDeliveries() {
  try {
    return JSON.parse(fs.readFileSync(PATHS.deliveries, 'utf8'));
  } catch (err) {
    console.warn(`[orders] Could not read ${PATHS.deliveries}: ${err.message}`);
    return {};
  }
}

export function resolveDelivery(order) {
  const book = loadDeliveries();
  return book.orders?.[order.id] || book.plans?.[order.planId] || book.default || null;
}

/** Send the manual eSIM activation payload to the customer. */
async function sendDelivery(sock, order, payload) {
  // Plans flagged "manual": true in data/deliveries.json are handled
  // by the admin by hand — the receipt card above already went out,
  // so nothing automatic is sent here.
  if (payload?.manual) return 'manual';

  const text = payload?.text?.trim() || `Aapka *${order.planName}* eSIM activate ho gaya hai. Details ke liye support se rabta karein. 🙏`;
  const file = payload?.image;

  if (file) {
    const abs = path.isAbsolute(file) ? file : path.join(PATHS.root, file);
    if (fs.existsSync(abs)) {
      const buf = fs.readFileSync(abs);
      await sock.sendMessage(order.jid, { image: buf, caption: text });
      return 'text+image';
    }
    console.warn(`[orders] Delivery image not found: ${abs} — sending text only.`);
  }
  await sendText(sock, order.jid, text);
  return 'text';
}

/** Turn a supplier QR value (url / path / base64) into sendable media. */
function qrMedia(qr) {
  if (!qr) return null;
  if (typeof qr === 'object') return qr; // already { url } / { buffer }
  const value = String(qr).trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return { url: value };
  if (value.startsWith('data:image')) return { buffer: Buffer.from(value.split(',')[1] || '', 'base64') };
  try {
    if (fs.existsSync(value)) return { url: value };
  } catch { /* not a path */ }
  if (value.length > 128) {
    const buf = Buffer.from(value, 'base64');
    if (buf.length > 0) return { buffer: buf };
  }
  return null;
}

/** Send the real eSIM(s) (QR + activation code) that came back from eSIMaccess. */
async function sendSupplierEsim(sock, order, esimOrList) {
  const list = (Array.isArray(esimOrList) ? esimOrList : [esimOrList]).filter(Boolean);
  const total = Math.max(list.length, Math.max(1, Number(order.quantity) || 1));
  const multi = total > 1;
  let sent = 'text';

  for (let i = 0; i < list.length; i += 1) {
    const esim = list[i];
    const caption = [
      multi ? `📶 *eSIM ${i + 1} of ${total}* — *${BRAND.name}* ⚡` : `*${BRAND.name} — eSIM Delivered* ⚡`,
      '',
      `🎫 ${order.id} • ${order.planName}`,
      `📊 ${order.data} • ${order.validity}`,
      esim.activationCode ? `🔑 Activation code: ${esim.activationCode}` : '',
      esim.iccid ? `📱 ICCID: ${esim.iccid}` : '',
      '',
      '1️⃣ Settings > Cellular / Mobile Data > *Add eSIM*',
      '2️⃣ QR scan karein (ya code manually enter karein)',
      '3️⃣ Line label dein > Continue > Data roaming *ON* ✅',
      '',
      '⚡ Activation foran — koi waiting nahi. Shukriya! 🙏',
    ]
      .filter(Boolean)
      .join('\n');

    const media = qrMedia(esim.qr);
    if (media) {
      await sock.sendMessage(order.jid, media.buffer ? { image: media.buffer, caption } : { image: media.url, caption });
      sent = 'qr+text';
    } else {
      await sendText(sock, order.jid, caption);
      sent = 'text';
    }
  }
  return sent;
}

// ── Compact delivery receipt (feature 13) ───────────────────
// Sent FIRST, then the QR/activation instructions, then the
// thank-you + channel link (reviews.js) and the review request.
export async function sendReceipt(sock, order) {
  const lang = getLang(order.jid);
  const when = new Date(order.updatedAt || Date.now()).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Asia/Karachi',
  });
  const qty = Math.max(1, Number(order.quantity) || 1);
  await sendText(sock, order.jid, [
    t('receipt_done', {}, lang),
    t('receipt_plan', { v: order.planName }, lang),
    qty > 1 ? `📦 Quantity: ${qty} eSIMs` : null,
    t('receipt_price', { v: formatPrice(order.price) }, lang),
    t('receipt_order', { v: order.id }, lang),
    t('receipt_date', { v: when }, lang),
  ].filter(Boolean).join('\n'));
}

// ── Admin confirms / rejects ────────────────────────────────
/**
 * @param {{actor?: string}} opts — who confirmed (shown on the card
 *        + written to db/audit.json by the admin panel).
 */
export async function confirmOrder(sock, orderId, opts = {}) {
  const actor = opts.actor || 'admin';
  const order = getOrder(orderId);
  if (!order) return { ok: false, message: `Order *${orderId}* nahi mila.` };
  if (order.status === 'fulfilled') return { ok: false, message: `*${orderId}* pehle hi deliver ho chuka hai ✅` };
  if (order.status === 'cancelled') return { ok: false, message: `⛔ *${orderId}* customer ne cancel kar diya hai — confirm nahi ho sakta.` };

  // 💰 Wallet top-up: nothing to purchase — credit the ledger instead.
  if (order.catalogType === 'wallet_topup') {
    const { creditTopup } = await import('./wallet.js');
    return creditTopup(sock, orderId, actor);
  }

  // 🛍️ Digital Store: ProdSeller purchase + key delivery lives in
  //    handlers/digitalStore.js (same return shape as this function).
  if (order.catalogType === 'digital') {
    const { confirmDigitalOrder } = await import('./digitalStore.js');
    return confirmDigitalOrder(sock, orderId, { actor });
  }

  // 1. Stock check (skipped automatically when supplier is unconfigured).
  const stock = await checkStock(order.planId);
  if (!stock.ok) {
    logOrder('stock_blocked', order, { stock: stock.stock });
    // Customer gets a switch/refund path IMMEDIATELY (feature 7).
    try {
      await sendOutOfStock(sock, order.jid, order.planId, { phase: 'paid' });
    } catch (err) {
      logError('stock.customer_notice', err, { orderId });
    }
    return {
      ok: false,
      message: `❌ *${orderId}* — supplier me stock khatam hai (stock: ${stock.stock ?? 0}). Customer ko plan-switch/refund offer kar diya — stock aate hi dobara \`confirm ${orderId}\` bhejein.`,
    };
  }

  // 2. Real supplier purchase — ONE eSIM per unit. Step 1 lets an
  //    order hold up to MAX_QTY_ESIM units; whatever is already
  //    bought sits in order.esims, so a retry after a partial
  //    failure only purchases what is still missing.
  const qty = Math.max(1, Number(order.quantity) || 1);
  const bought = Array.isArray(order.esims) ? order.esims.filter(Boolean) : [];
  const missing = qty - bought.length;
  const base = bought.length; // units already in hand — never re-numbered
  let purchase = null;

  for (let i = 0; i < missing; i += 1) {
    const unit = base + i + 1;
    // A DISTINCT supplier reference per unit is what makes each one
    // a separate eSIM — never the bare Order ID twice.
    const ref = qty === 1 ? order.id : `${order.id}-${unit}`;
    const res = await purchaseEsim(order.planId, ref);
    if (!res.ok) {
      purchase = res;
      break;
    }
    bought.push(res);
  }

  if (bought.length > 0) {
    order.esims = bought;
    order.supplierOrderId = bought[0].supplierOrderId ?? null;
    order.qr = bought[0].qr ?? null;
    order.activationCode = bought[0].activationCode ?? null;
    order.iccid = bought[0].iccid ?? null;
    putOrder(order);
    flush();
  }

  if (bought.length >= qty) {
    try {
      await sendReceipt(sock, order);
      const how = await sendSupplierEsim(sock, order, bought);
      clearReminder(orderId);
      order.status = 'fulfilled';
      order.fulfillment = 'supplier';
      order.confirmedBy = actor;
      order.confirmedAt = now();
      order.deliveredAt = now();
      order.actionVersion = (order.actionVersion || 0) + 1;
      order.updatedAt = now();
      putOrder(order);
      resetUser(order.jid);
      flush();
      logOrder('delivered', order, { via: 'esimaccess', how, units: bought.length });
      await startPostOrder(sock, order);
      return {
        ok: true,
        message: `✅ *${orderId}* delivered via eSIMaccess (${how}${bought.length > 1 ? `, ${bought.length} eSIMs` : ''}) — +${order.phone} ko QR/code bhej diya.\n📶 ${planOneLiner(order)}`,
      };
    } catch (err) {
      // eSIM bought but send failed — keep it recorded for a resend.
      putOrder(order);
      flush();
      logError('delivery.send', err, { orderId, supplierOrderId: order.supplierOrderId });
      return {
        ok: false,
        message: `⚠️ *${orderId}* — eSIM kharid li gaya (ref: ${order.supplierOrderId || 'n/a'}) lekin bhejne me masla aaya.\nCustomer ko dobara bhejne ke liye phir \`confirm ${orderId}\` bhejein.`,
      };
    }
  }

  // Partial: SOME units are already paid for and in hand. Send what
  // we have, page the owners, and let a second `confirm` buy the rest.
  if (bought.length > 0) {
    const left = qty - bought.length;
    let how = 'partial';
    try {
      await sendReceipt(sock, order);
      how = await sendSupplierEsim(sock, order, bought);
    } catch (err) {
      logError('delivery.send', err, { orderId });
    }
    order.status = 'pending_admin';
    order.updatedAt = now();
    putOrder(order);
    flush();
    logOrder('partial_delivered', order, { bought: bought.length, wanted: qty });
    try {
      await purchaseFailedAlert(sock, order, `${left} unit(s) left — ${purchase?.error || 'supplier stopped'}`);
    } catch (err) {
      logError('purchase.alert', err, { orderId });
    }
    return {
      ok: false,
      message: `⚠️ *${orderId}* — ${qty} me se *${bought.length}* eSIM deliver ho gayi (${how}), *${left}* reh gayi.\nMasla theek karke dobara \`confirm ${orderId}\` bhejein — baqi kharid li jayegi.`,
    };
  }

  if (purchase && purchase.code !== 'NOT_CONFIGURED') {
    // Supplier reachable but the purchase failed — keep the order pending
    // and page the owners: payment already arrived (CRITICAL alert).
    logError('esimaccess.purchase', new Error(purchase.error || 'unknown'), { orderId });
    // Wallet-paid orders must not sit on money we already took — put it
    // straight back so the customer can retry without contacting support.
    if (order.paidBy === 'wallet') {
      const { refundToWallet } = await import('./digitalStore.js');
      try { await refundToWallet(sock, order, 'supplier purchase failed'); } catch (err) {
        logError('refund.after_purchase_fail', err, { orderId });
      }
      return {
        ok: false,
        message: `❌ *${orderId}* — supplier purchase fail, *${formatPrice(order.price)}* wallet me wapas daal diya gaya hai. Customer ko bol dein ke dobara order karein.`,
      };
    }
    try {
      await purchaseFailedAlert(sock, order, purchase.error);
    } catch (err) {
      logError('purchase.alert', err, { orderId });
    }
    return {
      ok: false,
      message: `⚠️ *${orderId}* — supplier purchase fail: ${String(purchase.error || 'unknown').slice(0, 140)}\nOrder pending hai \u2014 masla theek karke dobara \`confirm ${orderId}\` bhejein.`,
    };
  }

  // 3. NOT_CONFIGURED -> manual mode (data/deliveries.json).
  const payload = resolveDelivery(order);
  let how = 'text';
  try {
    await sendReceipt(sock, order);
    how = await sendDelivery(sock, order, payload);
  } catch (err) {
    console.error(`[orders] Delivery failed for ${orderId}: ${err.message}`);
    logError('delivery.manual', err, { orderId });
    return { ok: false, message: `Delivery failed: ${err.message}` };
  }

  clearReminder(orderId);
  order.status = 'fulfilled';
  order.fulfillment = 'manual';
  order.confirmedBy = actor;
  order.confirmedAt = now();
  order.deliveredAt = now();
  order.actionVersion = (order.actionVersion || 0) + 1;
  order.updatedAt = now();
  putOrder(order);
  resetUser(order.jid);
  flush();
  logOrder('delivered', order, { via: 'manual', how });
  await startPostOrder(sock, order);

  return {
    ok: true,
    message: `✅ *${orderId}* delivered to +${order.phone} (${how}${payload?.image ? ` + image` : ''})\n📶 ${planOneLiner(order)}${how === 'manual' ? '\n✍️ Manual plan — details ab customer ko khud bhej dein.' : ''}`,
  };
}

export async function rejectOrder(sock, orderId, reason, opts = {}) {
  const actor = opts.actor || 'admin';
  const order = getOrder(orderId);
  if (!order) return { ok: false, message: `Order *${orderId}* nahi mila.` };
  if (order.status === 'fulfilled') return { ok: false, message: `*${orderId}* already delivered \u2014 reject nahi ho sakta.` };

  // 💰 Top-ups get their own reject (no refund: nothing was credited).
  if (order.catalogType === 'wallet_topup') {
    const { rejectTopup } = await import('./wallet.js');
    return rejectTopup(sock, orderId, reason, actor);
  }

  // A paid order that gets rejected must return the money first —
  // wallet-paid orders refund instantly, screenshot-paid ones can't
  // (the cash never entered the bot), so we say so plainly.
  if (order.paidBy === 'wallet') {
    const { refundToWallet } = await import('./digitalStore.js');
    await refundToWallet(sock, order, reason || 'payment rejected');
    order.status = 'refunded';
    order.rejectedBy = actor;
    order.rejectedAt = now();
    order.actionVersion = (order.actionVersion || 0) + 1;
    order.updatedAt = now();
    putOrder(order);
    resetUser(order.jid);
    clearSession(order.jid);
    flush();
    logOrder('rejected', order, { reason: order.note || reason, actor, refunded: true });
    return { ok: true, message: `🚫 *${orderId}* rejected — wallet me *${formatPrice(order.price)}* refund kar diya gaya.` };
  }

  clearReminder(orderId);
  order.status = 'rejected';
  order.note = reason || 'Payment not verified';
  order.rejectedBy = actor;
  order.rejectedAt = now();
  order.actionVersion = (order.actionVersion || 0) + 1;
  order.updatedAt = now();
  putOrder(order);
  const planId = order.planId;
  resetUser(order.jid);
  clearSession(order.jid); // concluded — nothing left to resume
  flush();
  logOrder('rejected', order, { reason: order.note, actor });

  try {
    const lang = getLang(order.jid);
    const own = [
      { id: 'retry_payment', label: '🔁 Retry Payment', keywords: ['retry', 'again', 'dobara', 'pay'] },
      { id: 'menu:support', label: t('nav_support', {}, lang), keywords: ['support', 'help', 'contact'] },
      { id: 'back_menu', label: t('nav_back_menu', {}, lang), keywords: ['menu', 'back', 'home'] },
    ];
    const choices = withNavChoices(own);
    await sendButtons(sock, order.jid, {
      title: `🚫 ${order.id} rejected`,
      text: [
        t('reject_head', { id: order.id }, lang),
        '',
        t('orderinfo_plan', { v: order.planName }, lang),
        t('orderinfo_payment', { v: order.paymentLabel }, lang),
        t('reject_reason', { v: order.note }, lang),
        '',
        t('reject_follow', {}, lang),
      ].join('\n'),
      buttons: choices.map((c) => ({ id: c.id, text: c.label })),
    });
    // Keep the plan selected so 🔁 Retry Payment can re-open the
    // payment step for the same plan (a NEW Order ID is created).
    setUser(order.jid, { planId, choices });
  } catch (err) {
    console.error(`[orders] Reject notice failed for ${orderId}: ${err.message}`);
    logError('reject.notice', err, { orderId });
  }

  return { ok: true, message: `🚫 *${orderId}* rejected \u2014 +${order.phone} ko inform kar diya.` };
}

// ── 🔁 Resend an eSIM (admin panel) ──────────────────────────
/**
 * Send the stored QR/activation again, or re-run the delivery path
 * when nothing was stored yet.
 * @param {{actor?: string}} opts
 */
export async function resendEsim(sock, orderId, opts = {}) {
  const actor = opts.actor || 'admin';
  const order = getOrder(orderId);
  if (!order) return { ok: false, message: `Order *${orderId}* nahi mila.` };

  const stored = Array.isArray(order.esims) && order.esims.length
    ? order.esims
    : (order.qr || order.activationCode)
      ? [{ qr: order.qr, activationCode: order.activationCode, iccid: order.iccid }]
      : null;

  if (stored) {
    try {
      const how = await sendSupplierEsim(sock, order, stored);
      order.actionVersion = (order.actionVersion || 0) + 1;
      order.updatedAt = now();
      putOrder(order);
      flush();
      logOrder('resent', order, { actor, how });
      return { ok: true, message: `🔁 *${orderId}* dobara bhej diya (+${order.phone}, ${how}).` };
    } catch (err) {
      logError('resend', err, { orderId });
      return { ok: false, message: `❌ *${orderId}* dobara bhejna fail: ${err.message}` };
    }
  }

  if (order.status === 'fulfilled' || order.status === 'pending_admin'
      || order.status === 'awaiting_supplier_funding') {
    return confirmOrder(sock, orderId, { actor });
  }

  if (order.status === 'awaiting_activation') {
    return {
      ok: false,
      message: `⏳ *${orderId}* activation pending hai — supplier ke key aane ka intezaar hai (poll chal raha hai).`,
    };
  }

  return {
    ok: false,
    message: `⚠️ *${orderId}* ke liye eSIM details store me nahi hain — pehle confirm karein.`,
  };
}

// ── 🔁 One-tap reorder (feature 6) ──────────────────────────
// Jumps straight to Step 3 (Payment Method) with the same plan —
// the stock re-check happens inside askPaymentMethod().
export async function reorderLast(sock, jid) {
  const lang = getLang(jid);
  const lastDone = ordersFor(jid)
    .filter((o) => o.status === 'fulfilled')
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];

  if (!lastDone) return sendMyOrders(sock, jid);

  const plan = getPlan(lastDone.planId);
  if (!plan) return sendPlans(sock, jid);

  setUser(jid, { planId: plan.id, planQty: 1, orderId: null, flow: 'choose_payment' });
  saveSession(jid, { step: STEP_PAYMENT, selectedPlanId: plan.id, selectedProductId: null, orderId: null });
  logOrder('reorder', { id: lastDone.id, planName: plan.name, status: 'reorder' }, { from: lastDone.id });
  return askPaymentMethod(sock, jid);
}
