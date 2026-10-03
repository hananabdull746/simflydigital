// ─────────────────────────────────────────────────────────────
// services/digitalPolls.js
// Email-activation poller for the Digital Store.
//
// Some digital products are NOT handed over as a raw key — the
// supplier activates the subscription on the email the customer
// gave us. `POST /orders` then answers status "paid" and the
// key only appears once `GET /orders/:id` says "delivered".
//
// The order is polled on the supplier it was ACTUALLY placed on
// (order.supplier = prodseller | eklas) — never guessed.
//
// This job walks those orders every ACTIVATION_POLL_MINUTES
// (default 2) until:
//   • status = delivered → key(s) + thank-you/review flow
//   • status = failed    → failure / refund path
//   • ACTIVATION_MAX_WAIT_HOURS elapse → CRITICAL admin alert
//     carrying the supplier order id for manual follow-up
//
// State lives in db/digitalOrderPolls.json so a restart resumes
// every in-flight poll instead of losing it.
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { JSONFilePreset } from 'lowdb/node';
import { PATHS, SETTINGS } from '../config.js';
import { getOrder, putOrder, flush } from '../lib/store.js';
import { getOrderStatus, isConfigured, supplierLabel } from './productCatalog.js';
import { alertAdmins } from './adminAlerts.js';
import { deliverActivatedOrder, refundToWallet } from '../handlers/digitalStore.js';
import { logOrder, logError } from '../lib/logger.js';

const DEFAULTS = () => ({ polls: [] });

function normalize(data) {
  const doc = data && typeof data === 'object' ? data : {};
  doc.polls = Array.isArray(doc.polls) ? doc.polls : [];
  return doc;
}

async function openPolls() {
  fs.mkdirSync(path.dirname(PATHS.digitalPolls), { recursive: true });
  try {
    return await JSONFilePreset(PATHS.digitalPolls, DEFAULTS());
  } catch (err) {
    const backup = `${PATHS.digitalPolls}.corrupt-${Date.now()}`;
    console.warn(`[polls] ${PATHS.digitalPolls} unreadable (${err.message}) — backing up to ${backup}.`);
    try { fs.renameSync(PATHS.digitalPolls, backup); } catch { /* ignore */ }
    return JSONFilePreset(PATHS.digitalPolls, DEFAULTS());
  }
}

const db = await openPolls();
const state = normalize(db.data);

let timer = null;
function save() {
  db.write().catch((err) => {
    console.error(`[polls] Failed to persist ${PATHS.digitalPolls}: ${err.message}`);
    logError('polls.write', err);
  });
}

const pollMs = () => Math.max(1, SETTINGS.activationPollMinutes) * 60_000;
const maxWaitMs = () => Math.max(1, SETTINGS.activationMaxWaitHours) * 60 * 60_000;

/** Start (or refresh) the poll for one Simfly order. */
export function schedulePoll(orderId, supplierOrderId, at = Date.now(), supplier = 'prodseller') {
  const existing = state.polls.find((p) => p.orderId === orderId);
  if (existing) {
    existing.prodsellerOrderId = supplierOrderId || existing.prodsellerOrderId;
    existing.supplierOrderId = supplierOrderId || existing.supplierOrderId || existing.prodsellerOrderId;
    existing.supplier = supplier || existing.supplier || 'prodseller';
    existing.nextPollAt = at + pollMs();
    save();
    return existing;
  }
  const poll = {
    orderId,
    prodsellerOrderId: supplierOrderId || null,
    supplierOrderId: supplierOrderId || null,
    supplier: supplier || 'prodseller',
    nextPollAt: at + pollMs(),
    attemptsCount: 0,
    startedAt: at,
    maxUntil: at + maxWaitMs(),
  };
  state.polls.push(poll);
  save();
  console.log(`[polls] Watching ${orderId} → ${poll.supplierOrderId} (${poll.supplier}) until ${new Date(poll.maxUntil).toISOString()}`);
  return poll;
}

/** Stop watching (delivered / cancelled / refunded). */
export function cancelPoll(orderId) {
  const before = state.polls.length;
  state.polls = state.polls.filter((p) => p.orderId !== orderId);
  if (state.polls.length !== before) save();
  return before !== state.polls.length;
}

/** In-flight polls (admin dashboard / tests). */
export function activePolls() {
  return state.polls.map((p) => ({ ...p }));
}

/** One poll step for one order — exported so tests can drive it. */
export async function pollOnce(sock, poll) {
  const order = getOrder(poll.orderId);
  if (!order) {
    cancelPoll(poll.orderId);
    return { skipped: 'order_missing' };
  }
  if (order.status !== 'awaiting_activation') {
    cancelPoll(poll.orderId);
    return { skipped: `status_${order.status}` };
  }

  const supplier = poll.supplier || order.supplier || 'prodseller';
  const supplierOrderId = poll.supplierOrderId || poll.prodsellerOrderId
    || order.supplierOrderId || order.prodsellerOrderId;
  const label = supplierLabel(supplier);

  const res = await getOrderStatus(supplierOrderId, supplier);
  poll.attemptsCount += 1;
  poll.lastPollAt = Date.now();

  if (!res.ok) {
    // Transient API failure: keep waiting, just push the next attempt out.
    poll.nextPollAt = Date.now() + pollMs();
    save();
    return { ok: false, code: res.code };
  }

  if (res.status === 'delivered') {
    cancelPoll(poll.orderId);
    save();
    try {
      await deliverActivatedOrder(sock, poll.orderId, res.order);
      return { ok: true, delivered: true };
    } catch (err) {
      logError('polls.deliver', err, { orderId: poll.orderId });
      return { ok: false, error: err.message };
    }
  }

  if (res.status === 'failed') {
    cancelPoll(poll.orderId);
    save();
    order.status = 'pending_admin';
    order.note = `${label} reported the activation as FAILED`;
    order.actionVersion = (order.actionVersion || 0) + 1;
    order.updatedAt = new Date().toISOString();
    putOrder(order);
    flush();
    if (order.paidBy === 'wallet') await refundToWallet(sock, order, 'supplier activation failed');
    await alertAdmins(sock, [
      '🔴 *ACTIVATION FAILED*',
      '',
      `🧾 ${order.id} · ${order.planName}`,
      `🔗 ${label} order: ${supplierOrderId || '—'}`,
      `📧 ${order.activationEmail || '—'}`,
      '',
      `Manually check ${label} / refund karein.`,
    ].join('\n'), {
      critical: true,
      title: '🔴 Activation failed',
      buttons: [{ id: `adm:det:${order.id}`, text: '🔍 Details' }],
    });
    return { ok: true, failed: true };
  }

  // pending / paid — still waiting.
  if (Date.now() >= poll.maxUntil) {
    cancelPoll(poll.orderId);
    save();
    order.pollTimedOutAt = new Date().toISOString();
    order.actionVersion = (order.actionVersion || 0) + 1;
    order.updatedAt = new Date().toISOString();
    putOrder(order);
    flush();
    await alertAdmins(sock, [
      '🔴 *ACTIVATION TIMED OUT — manual follow-up*',
      '',
      `🧾 ${order.id} · ${order.planName} · ${order.price} PKR`,
      `🔗 ${label} order: *${supplierOrderId || 'unknown'}*`,
      `📧 ${order.activationEmail || '—'}`,
      `⏱️ ${SETTINGS.activationMaxWaitHours}h window expired after ${poll.attemptsCount} checks.`,
      '',
      `${label} panel me is order ka status dekhein.`,
    ].join('\n'), {
      critical: true,
      title: '🔴 Activation timed out',
      buttons: [{ id: `adm:det:${order.id}`, text: '🔍 Details' }],
    });
    logOrder('activation_timeout', { id: order.id }, { supplier, supplierOrderId });
    return { ok: true, timedOut: true };
  }

  poll.nextPollAt = Date.now() + pollMs();
  save();
  return { ok: true, status: res.status };
}

/** Run every due poll once. */
export async function runDuePolls(sock) {
  if (!sock || !isConfigured()) return { skipped: true };
  const due = state.polls.filter((p) => p.nextPollAt <= Date.now());
  const results = [];
  for (const poll of due) {
    results.push(await pollOnce(sock, poll));
  }
  return { checked: due.length, results };
}

// ── Job ───────────────────────────────────────────────────────
let jobSocket = null;

export function startPolls(sock) {
  stopPolls();
  jobSocket = sock;
  // Check every 30s; each poll has its own nextPollAt cadence, so a
  // tick with nothing due costs exactly one array scan.
  timer = setInterval(() => {
    runDuePolls(jobSocket).catch((err) => logError('polls.tick', err));
  }, 30_000);
  if (state.polls.length > 0) {
    console.log(`[polls] Resumed ${state.polls.length} activation poll(s) after restart.`);
  }
}

export function stopPolls() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Test helper — replace the poll list. */
export function __setPolls(list = []) {
  state.polls = Array.isArray(list) ? list : [];
  save();
  return state.polls;
}
