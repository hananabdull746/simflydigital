// ─────────────────────────────────────────────────────────────
// services/alertsJob.js
// Scheduled plan watcher (node-cron, every 15 min by default):
//   • snapshot current stock + prices (cached, cheap)
//   • diff against the previous snapshot
//   • ONE short message per subscriber per day:
//       back-in-stock → "📶 Order Now" button
//       price drop    → same
//     every alert also carries "🔕 Unsubscribe".
// ─────────────────────────────────────────────────────────────
import cron from 'node-cron';
import { SETTINGS, formatPrice } from '../config.js';
import { allPlans } from '../lib/plans.js';
import { sendButtons } from '../lib/ui.js';
import { withNav } from '../handlers/ui.js';
import {
  getSnapshot, setSnapshot, subsFor, alertAllowed, markAlerted,
} from '../lib/alerts.js';
import { checkAllStock } from './esimaccess.js';
import { stockAlert } from './adminAlerts.js';
import { logError } from '../lib/logger.js';

let task = null;

// Plans we already paged the admins about (cleared when restocked).
const stockAlerted = new Set();

/** Build the next snapshot: { [planId]: { stock, price } }. */
async function currentSnapshot() {
  const stockMap = await checkAllStock();
  const snap = {};
  for (const plan of allPlans()) {
    const s = stockMap[plan.id] || { ok: true, stock: null };
    snap[plan.id] = {
      stock: s.ok ? (Number.isFinite(s.stock) ? s.stock : 1) : 0,
      price: plan.price,
    };
  }
  return snap;
}

/**
 * One diff + notify pass. Exported so tests can run it directly.
 * @returns {Promise<{notified: number, restocked: number, dropped: number, baseline: boolean}>}
 */
export async function runAlertsOnce(sock) {
  const prev = getSnapshot();
  const baseline = Object.keys(prev).length === 0;
  const snap = await currentSnapshot();

  const restocked = [];
  const dropped = [];
  const outOfStock = [];
  if (!baseline) {
    for (const plan of allPlans()) {
      const before = prev[plan.id];
      const after = snap[plan.id];
      if (!before || !after) continue;
      if (before.stock <= 0 && after.stock > 0) {
        restocked.push(plan);
        stockAlerted.delete(plan.id); // can fire again next drop
      }
      if (before.stock > 0 && after.stock <= 0) outOfStock.push(plan);
      if (after.price < before.price) dropped.push(plan);
    }
  } else {
    // First pass: don't page the admins about plans that are ALREADY out.
    for (const [id, s] of Object.entries(snap)) if (s.stock <= 0) stockAlerted.add(id);
  }
  setSnapshot(snap);
  if (baseline) return { notified: 0, restocked: 0, dropped: 0, baseline: true };

  // 🔴 Admin alert: a plan just went out of stock (once per drop).
  for (const plan of outOfStock) {
    if (stockAlerted.has(plan.id)) continue;
    stockAlerted.add(plan.id);
    try {
      await stockAlert(sock, plan.id);
    } catch (err) {
      logError('alerts.stock_admin', err, { planId: plan.id });
    }
  }

  let notified = 0;
  notified += await notifySubs(sock, 'restock', restocked);
  notified += await notifySubs(sock, 'price', dropped);
  return { notified, restocked: restocked.length, dropped: dropped.length, baseline: false };
}

async function notifySubs(sock, type, plans) {
  if (!sock || plans.length === 0) return 0;
  let n = 0;
  for (const sub of subsFor(type)) {
    if (!alertAllowed(sub)) continue; // max 1 alert / subscriber / day
    // A plan-specific sub gets its plan; a global sub gets the first hit.
    const plan = sub.planId ? plans.find((p) => p.id === sub.planId) : plans[0];
    if (!plan) continue;

    const body =
      type === 'restock'
        ? [
            `🔔 *Back in stock!*`,
            `📦 ${plan.name} — ${formatPrice(plan.price)}`,
          ].join('\n')
        : [
            `🔔 *Price drop!*`,
            `📦 ${plan.name} — now ${formatPrice(plan.price)}`,
          ].join('\n');

    try {
      await sendButtons(sock, sub.jid, {
        title: '🔔 Plan alert',
        text: body,
        buttons: withNav([
          { id: `plan:${plan.id}`, text: '📶 Order Now' },
          { id: `unsub:${sub.id}`, text: '🔕 Unsubscribe' },
        ], { human: false }),
      });
      markAlerted(sub.id);
      n += 1;
    } catch (err) {
      logError('alerts.send', err, { sub: sub.id });
    }
  }
  return n;
}

/** Start the cron watcher (idempotent). Returns the cron task. */
export function startAlertsJob(sock) {
  if (task) return task;
  if (!cron.validate(SETTINGS.alertsCron)) {
    console.warn(`[alerts] Invalid ALERTS_CRON "${SETTINGS.alertsCron}" — job not started.`);
    return null;
  }
  task = cron.schedule(SETTINGS.alertsCron, () => {
    runAlertsOnce(sock).then((r) => {
      if (r.notified) console.log(`[alerts] Sent ${r.notified} alert(s) (${r.restocked} restocked, ${r.dropped} dropped).`);
    }).catch((err) => logError('alerts.job', err));
  });
  console.log(`[alerts] Plan watcher scheduled: ${SETTINGS.alertsCron}`);
  return task;
}

export function stopAlertsJob() {
  if (task) {
    try { task.stop(); } catch { /* already stopped */ }
    task = null;
  }
}
