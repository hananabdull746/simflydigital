// ─────────────────────────────────────────────────────────────
// services/adminAlerts.js
// Everything the owner(s) should be told WITHOUT having to ask.
//
//   🔴 CRITICAL (sent even during quiet hours)
//      • purchaseEsim() failed AFTER payment (order id + 🔁 Retry)
//      • stock alert / suspicious activity
//   ⚠️ normal (held during quiet hours, flushed at 9am PKT)
//      • payment auto-verified
//      • verifier offline / NOT_CONFIGURED
//      • supplier balance below SUPPLIER_LOW_BALANCE_USD
//      • either digital supplier wallet (ProdSeller / Eklas) below
//        its own threshold
//      • plan went out of stock
//      • order pending > 15 min (every 15 min, max 3 per order)
//      • 3+ verification failures on one number
//      • a payment reference seen on more than one payment
//
//   📊 9:00 PM PKT daily summary (orders/delivered/pending/
//      rejected/revenue/profit/top plan/supplier balance)
//   📅 Monday 09:00 PKT weekly summary
// ─────────────────────────────────────────────────────────────
import cron from 'node-cron';
import { BRAND, SETTINGS, formatPrice, jidUser } from '../config.js';
import { allOrders, pendingOrders, getOrder } from '../lib/store.js';
import { getPlan, allPlans } from '../lib/plans.js';
import {
  isQuietNow, quietEndLabel, ownerJids, appendAudit, getSettings,
} from '../lib/admins.js';
import { sendButtons, sendText } from '../lib/ui.js';
import { isOnline, scanStatus, recentPayments } from './verifier.js';
import { getBalance } from './esimaccess.js';
import { getBalance as getProdSellerBalance, isConfigured as prodSellerConfigured } from './prodseller.js';
import { getBalance as getEklasBalance, isConfigured as eklasConfigured } from './eklas.js';
import { totalLiability } from './wallet.js';
import { logAdmin, logError } from '../lib/logger.js';

const PKT = { timeZone: 'Asia/Karachi' };

// ── Delivery to owners ────────────────────────────────────────
const heldAlerts = []; // quiet-hours queue
const notifiedDays = new Set(); // once-per-day alerts
const reminded = new Map(); // orderId -> { count, lastAt }

/** Push one alert to every owner (critical bypasses quiet hours). */
export async function alertAdmins(sock, text, opts = {}) {
  const { critical = false, buttons = null } = opts;

  if (!critical && isQuietNow()) {
    heldAlerts.push({ text, buttons });
    console.log(`[alerts] held for quiet hours until ${quietEndLabel()}`);
    return { held: true };
  }

  const targets = ownerJids().length ? ownerJids() : [];
  if (targets.length === 0) {
    console.warn('[alerts] No owner JID configured — alert not delivered.');
    return { sent: 0 };
  }

  let sent = 0;
  for (const jid of targets) {
    try {
      if (buttons && buttons.length) {
        await sendButtons(sock, jid, { title: opts.title || `${BRAND.name} Admin Alert`, text, buttons });
      } else {
        await sendText(sock, jid, text);
      }
      sent += 1;
    } catch (err) {
      logError('alerts.send', err, { jid });
    }
  }
  logAdmin('alert', { critical, sent, preview: text.slice(0, 60) });
  return { sent };
}

/** Flush anything held back by quiet hours (runs every minute). */
export async function flushHeld(sock) {
  if (heldAlerts.length === 0 || isQuietNow()) return 0;
  const queue = heldAlerts.splice(0, heldAlerts.length);
  let sent = 0;
  for (const item of queue) {
    const res = await alertAdmins(sock, item.text, { critical: true, buttons: item.buttons });
    sent += res.sent || 0;
  }
  if (sent) {
    await alertAdmins(sock, `🌅 Quiet hours khatam — ${queue.length} held alert(s) upar bheje gaye.`, { critical: true });
  }
  return sent;
}

// ── Individual alerts ─────────────────────────────────────────
/** 🔴 purchaseEsim() failed after payment — CRITICAL, with Retry. */
export async function purchaseFailedAlert(sock, order, error) {
  return alertAdmins(sock, [
    `🔴 *PURCHASE FAILED — ${order.id}*`,
    '',
    `📶 ${order.planName} · ${formatPrice(order.price)}`,
    `👤 +${order.phone}`,
    `❌ ${String(error || 'unknown error').slice(0, 180)}`,
    '',
    'Payment aa chuki hai — jaldi retry karein.',
  ].join('\n'), {
    critical: true,
    title: '🔴 Order needs you NOW',
    buttons: [
      { id: `adm:retry:${order.id}`, text: '🔁 Retry delivery' },
      { id: `adm:det:${order.id}`, text: '🔍 Details' },
    ],
  });
}

/** 📦 Plan out of stock (also fires from the stock watcher). */
export async function stockAlert(sock, planId) {
  const plan = getPlan(planId);
  if (!plan) return null;
  return alertAdmins(sock, [
    `📦 *OUT OF STOCK — ${plan.name}*`,
    '',
    `💰 ${formatPrice(plan.price)} · ${plan.data} ${plan.validity}`,
    '',
    'Customer offers are still live — stock aate hi sell karna best hai.',
  ].join('\n'), { title: '📦 Stock alert' });
}

/** ⚠️ NayaPay verifier offline / not configured (once per day). */
export async function verifierAlertIfNeeded(sock) {
  if (isOnline()) return null;
  const day = new Date().toLocaleDateString('en-CA', PKT);
  if (notifiedDays.has(`verifier:${day}`)) return null;
  notifiedDays.add(`verifier:${day}`);
  return alertAdmins(sock, [
    '⚠️ *Payment verifier OFFLINE*',
    '',
    `Status: ${scanStatus().message}`,
    'Is waqt har payment manually confirm karni paregi.',
  ].join('\n'), { title: '⚠️ Verifier' });
}

/** 💰 Supplier balance below the configured threshold. */
export async function balanceAlertIfNeeded(sock) {
  const threshold = Number(SETTINGS.supplierLowBalanceUsd || 0);
  if (threshold <= 0) return null;
  const balance = await getBalance();
  if (!balance?.ok || !Number.isFinite(Number(balance.balance))) return null;
  if (Number(balance.balance) >= threshold) return null;

  const day = new Date().toLocaleDateString('en-CA', PKT);
  if (notifiedDays.has(`balance:${day}`)) return null;
  notifiedDays.add(`balance:${day}`);

  return alertAdmins(sock, [
    '💰 *Supplier balance LOW*',
    '',
    `Balance: $${Number(balance.balance).toFixed(2)} (threshold $${threshold})`,
    'Naye orders deliver hone se pehle top-up kar dein.',
  ].join('\n'), { title: '💰 Supplier balance' });
}

/** 🛍️ ProdSeller (Digital Store supplier) balance — separate wallet,
 *  separate threshold: running out here blocks EVERY digital order
 *  with a 402, so it warns on its own cadence (once per hour). */
export async function prodsellerBalanceAlertIfNeeded(sock) {
  if (!prodSellerConfigured()) return null;
  const threshold = Number(SETTINGS.prodsellerLowBalanceUsd || 0);
  if (threshold <= 0) return null;

  const balance = await getProdSellerBalance();
  if (!balance?.ok || !Number.isFinite(Number(balance.balance))) return null;
  if (Number(balance.balance) >= threshold) return null;

  const hourKey = `psbal:${new Date().toISOString().slice(0, 13)}`;
  if (notifiedDays.has(hourKey)) return null;
  notifiedDays.add(hourKey);

  return alertAdmins(sock, [
    '🛒 *ProdSeller balance LOW* (Digital Store)',
    '',
    `Balance: $${Number(balance.balance).toFixed(2)} (threshold $${threshold})`,
    '⚠️ Naye digital orders ab *402 — insufficient balance* denge.',
    '👉 ProdSeller panel se USDT top-up karein, phir 🔁 Retry dabayein.',
  ].join('\n'), { title: '🛒 ProdSeller balance', buttons: [{ id: 'adm:storebal', text: '📊 Check balance' }] });
}

/** Eklas (second Digital Store supplier) balance — its OWN wallet and
 *  its OWN threshold: a 402 here only blocks the orders it sources,
 *  and the store already falls back to ProdSeller. Hourly, same as above. */
export async function eklasBalanceAlertIfNeeded(sock) {
  if (!eklasConfigured()) return null;
  const threshold = Number(SETTINGS.eklasLowBalanceUsd || 0);
  if (threshold <= 0) return null;

  const balance = await getEklasBalance();
  if (!balance?.ok || !Number.isFinite(Number(balance.balance))) return null;
  if (Number(balance.balance) >= threshold) return null;

  const hourKey = `ekbal:${new Date().toISOString().slice(0, 13)}`;
  if (notifiedDays.has(hourKey)) return null;
  notifiedDays.add(hourKey);

  return alertAdmins(sock, [
    '🛒 *Eklas balance LOW* (Digital Store)',
    '',
    `Balance: $${Number(balance.balance).toFixed(2)} (threshold $${threshold})`,
    'Eklas-sourced digital orders ab *402 — insufficient balance* denge.',
    '👉 Eklas panel se USDT top-up karein, phir 🔁 Retry dabayein.',
  ].join('\n'), { title: '🛒 Eklas balance', buttons: [{ id: 'adm:storebal', text: '📊 Check balance' }] });
}

/** ⏳ Order pending > 15 min — every 15 min, max 3 per order. */
export async function pendingReminders(sock) {
  const max = SETTINGS.adminReminderMax ?? 3;
  const cadence = SETTINGS.adminReminderMs || 15 * 60000;
  let sent = 0;

  for (const order of pendingOrders()) {
    const state = reminded.get(order.id) || { count: 0, lastAt: 0 };
    if (state.count >= max) continue;
    const age = Date.now() - new Date(order.createdAt).getTime();
    if (age < cadence) continue;
    if (state.count > 0 && Date.now() - state.lastAt < cadence) continue;

    state.count += 1;
    state.lastAt = Date.now();
    reminded.set(order.id, state);

    const res = await alertAdmins(sock, [
      `⏳ *${order.id}* abhi bhi pending hai (${Math.round(age / 60000)} min).`,
      '',
      `📶 ${order.planName} · ${formatPrice(order.price)}`,
      `💳 ${order.paymentLabel} · 👤 +${order.phone}`,
      '',
      `Reminder ${state.count}/${max}.`,
    ].join('\n'), {
      title: `⏳ Pending ${order.id}`,
      buttons: [
        { id: `adm:open:${order.id}`, text: '🔍 Open card' },
        { id: 'adm:pending', text: '🔔 All pending' },
      ],
    });
    sent += res.sent || 0;
  }
  return sent;
}

/** 🚨 Suspicious activity: 3+ verify fails, reused payment refs. */
export async function suspiciousActivity(sock) {
  let hits = 0;

  // 1. Same number with 3+ verification failures.
  for (const order of allOrders()) {
    if ((order.verifyFails || 0) < 3 || order.suspiciousAlerted) continue;
    order.suspiciousAlerted = true;
    const { putOrder, flush } = await import('../lib/store.js');
    putOrder(order);
    flush();
    hits += 1;
    await alertAdmins(sock, [
      '🚨 *SUSPICIOUS — repeated verification failures*',
      '',
      `👤 +${order.phone} · ${order.verifyFails} failed attempts`,
      `🧾 Latest: ${order.id}`,
      '',
      'Fake screenshots hone ki sambhavna hai — manually check karein.',
    ].join('\n'), { critical: true, title: '🚨 Suspicious activity' });
  }

  // 2. One payment reference used on more than one payment record.
  const byRef = new Map();
  for (const p of recentPayments(200)) {
    if (!p.reference) continue;
    if (!byRef.has(p.reference)) byRef.set(p.reference, []);
    byRef.get(p.reference).push(p);
  }
  const day = new Date().toLocaleDateString('en-CA', PKT);
  for (const [reference, list] of byRef) {
    if (list.length < 2) continue;
    const flag = `ref:${reference}`;
    if (notifiedDays.has(`${flag}:${day}`)) continue;
    notifiedDays.add(`${flag}:${day}`);
    hits += 1;
    await alertAdmins(sock, [
      '🚨 *SUSPICIOUS — payment reference reused*',
      '',
      `Reference *${reference}* ${list.length} payments me aaya hai:`,
      ...list.map((p) => `• ${formatPrice(p.amount)} · ${p.txn} · ${p.status}`),
      '',
      'Ek hi payment dobara claim ho sakti hai — manually verify karein.',
    ].join('\n'), { critical: true, title: '🚨 Reused reference' });
  }

  return hits;
}

// ── Summaries ─────────────────────────────────────────────────
function stats(periodDays) {
  const since = periodDays ? Date.now() - periodDays * 86400000 : -Infinity;
  const list = allOrders().filter((o) => new Date(o.createdAt || 0).getTime() >= since);
  const done = list.filter((o) => o.status === 'fulfilled');
  const revenue = done.reduce((s, o) => s + Number(o.price || 0), 0);
  const profit = done.reduce((s, o) => {
    const plan = getPlan(o.planId);
    const cost = Number(plan?.cost ?? NaN);
    return s + (Number.isFinite(cost) && cost > 0 ? Number(o.price || 0) - cost : 0);
  }, 0);
  const byPlan = {};
  for (const o of list) byPlan[o.planName || '?'] = (byPlan[o.planName || '?'] || 0) + 1;
  const top = Object.entries(byPlan).sort((a, b) => b[1] - a[1])[0];
  return {
    placed: list.length,
    delivered: done.length,
    pending: pendingOrders().length,
    rejected: list.filter((o) => o.status === 'rejected').length,
    revenue,
    profit,
    top,
  };
}

async function supplierBalanceLine() {
  const balance = await getBalance();
  if (!balance?.ok) return 'Supplier balance: —';
  return `Supplier balance: $${Number(balance.balance).toFixed(2)}`;
}

/** 💰 Wallet liability + 🛍️ ProdSeller (digital supplier) balance. */
async function moneyLines() {
  const lines = [`🏦 Wallet liability: *${formatPrice(totalLiability())}*`];
  try {
    const ps = await getProdSellerBalance();
    lines.push(ps?.ok
      ? `🛒 ProdSeller balance: *$${Number(ps.balance).toFixed(2)}*`
      : '🛒 ProdSeller balance: —');
  } catch {
    lines.push('🛒 ProdSeller balance: —');
  }
  return lines;
}

export async function runDailySummary(sock) {
  const s = stats(1);
  const lines = [
    '📊 *DAILY SUMMARY*',
    '',
    `🧾 Orders: ${s.placed}`,
    `✅ Delivered: ${s.delivered} · ⏳ Pending: ${s.pending} · ❌ Rejected: ${s.rejected}`,
    `💰 Revenue: *${formatPrice(s.revenue)}*`,
    `📈 Est. profit: ${s.profit > 0 ? formatPrice(s.profit) : '—'}`,
    `🏆 Top plan: ${s.top ? `${s.top[0]} (${s.top[1]})` : '—'}`,
    await supplierBalanceLine(),
    ...(await moneyLines()),
    '',
    `⚙️ Verifier: ${isOnline() ? 'ON' : 'OFF'} · Stock: ${allPlans().filter((p) => p.visible !== false).length} plans live`,
  ];
  const res = await alertAdmins(sock, lines.join('\n'), { critical: true, title: '📊 Daily summary' });
  appendAudit({ actor: 'system', role: 'owner', action: 'summary.daily', detail: `placed=${s.placed} revenue=${s.revenue}` });
  return res;
}

export async function runWeeklySummary(sock) {
  const week = stats(7);
  const month = stats(30);
  const lines = [
    '📅 *WEEKLY SUMMARY*',
    '',
    '— Last 7 days —',
    `🧾 ${week.placed} orders · ✅ ${week.delivered} delivered · ⏳ ${week.pending} pending`,
    `💰 Revenue: *${formatPrice(week.revenue)}* · 📈 Profit: ${week.profit > 0 ? formatPrice(week.profit) : '—'}`,
    `🏆 Top plan: ${week.top ? `${week.top[0]} (${week.top[1]})` : '—'}`,
    '',
    '— Last 30 days —',
    `🧾 ${month.plans || month.placed} orders · 💰 ${formatPrice(month.revenue)}`,
    await supplierBalanceLine(),
    ...(await moneyLines()),
  ];
  const res = await alertAdmins(sock, lines.join('\n'), { critical: true, title: '📅 Weekly summary' });
  appendAudit({ actor: 'system', role: 'owner', action: 'summary.weekly', detail: `placed=${week.placed} revenue=${week.revenue}` });
  return res;
}

// ── Jobs ──────────────────────────────────────────────────────
let minuteTimer = null;
let dailyTask = null;
let weeklyTask = null;
let jobsSocket = null;

/** One tick: pending reminders + suspicious + verifier + flush. */
export async function runAdminJobsOnce(sock) {
  const s = sock || jobsSocket;
  if (!s) return { skipped: true };
  try {
    await flushHeld(s);
    await pendingReminders(s);
    await suspiciousActivity(s);
    await verifierAlertIfNeeded(s);
    await balanceAlertIfNeeded(s);
    await prodsellerBalanceAlertIfNeeded(s);
    await eklasBalanceAlertIfNeeded(s);
    return { ok: true };
  } catch (err) {
    logError('alerts.job', err);
    return { ok: false, error: err.message };
  }
}

/** Start the cron + per-minute jobs (called on connection open). */
export function startAdminJobs(sock) {
  stopAdminJobs();
  jobsSocket = sock;

  minuteTimer = setInterval(() => { runAdminJobsOnce(jobsSocket); }, 60_000);

  try {
    if (cron.validate(SETTINGS.dailySummaryCron)) {
      dailyTask = cron.schedule(SETTINGS.dailySummaryCron, () => {
        runDailySummary(jobsSocket);
      }, { timezone: 'Asia/Karachi' });
    } else {
      console.warn(`[alerts] Bad DAILY_SUMMARY_CRON: ${SETTINGS.dailySummaryCron}`);
    }
    if (cron.validate(SETTINGS.weeklySummaryCron)) {
      weeklyTask = cron.schedule(SETTINGS.weeklySummaryCron, () => {
        runWeeklySummary(jobsSocket);
      }, { timezone: 'Asia/Karachi' });
    } else {
      console.warn(`[alerts] Bad WEEKLY_SUMMARY_CRON: ${SETTINGS.weeklySummaryCron}`);
    }
  } catch (err) {
    logError('alerts.cron', err);
  }

  console.log(`[alerts] Admin jobs started (daily ${SETTINGS.dailySummaryCron}, weekly ${SETTINGS.weeklySummaryCron}, Asia/Karachi)`);
}

export function stopAdminJobs() {
  if (minuteTimer) { clearInterval(minuteTimer); minuteTimer = null; }
  if (dailyTask?.stop) dailyTask.stop();
  if (weeklyTask?.stop) weeklyTask.stop();
  dailyTask = null;
  weeklyTask = null;
}

/** Test helper — forget once-per-day / per-order guards. */
export function __resetAdminAlerts() {
  heldAlerts.length = 0;
  notifiedDays.clear();
  reminded.clear();
}
