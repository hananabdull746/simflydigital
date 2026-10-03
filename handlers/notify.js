// ─────────────────────────────────────────────────────────────
// handlers/notify.js
// "🔔 Notify Me" (sold-out plans) + "🔔 Alerts" (main menu):
//   • restock subscription for one plan
//   • global price-drop subscription
//   • per-alert "🔕 Unsubscribe"
// The actual notifications are sent by services/alertsJob.js
// (node-cron, every 15 minutes).
// ─────────────────────────────────────────────────────────────
import { sendButtons, sendText } from '../lib/ui.js';
import { getPlan } from '../lib/plans.js';
import { getLang } from '../lib/users.js';
import { t } from '../lib/lang.js';
import {
  subscribe, unsubscribe, findSubscription, allSubsFor, unsubscribeById,
} from '../lib/alerts.js';
import { withNav } from './ui.js';

// ── 🔔 Notify Me (from a sold-out plan) ─────────────────────
export async function subscribeRestock(sock, jid, planId) {
  const lang = getLang(jid);
  const plan = getPlan(planId);
  if (!plan) {
    await sendText(sock, jid, t('notify_unknown', {}, lang));
    return false;
  }
  subscribe(jid, 'restock', plan.id);
  await sendButtons(sock, jid, {
    title: '🔔 Alerts on',
    text: t('notify_done', { plan: plan.name }, lang),
    buttons: withNav([
      { id: `plan:${plan.id}`, text: '📶 See Plan' },
    ]),
  });
  return true;
}

// ── 🔔 Alerts screen (main menu row) ────────────────────────
export async function sendAlertsScreen(sock, jid) {
  const lang = getLang(jid);
  const subs = allSubsFor(jid);
  const priceOn = subs.some((s) => s.type === 'price');
  const restockCount = subs.filter((s) => s.type === 'restock').length;

  const summary = [
    t('alerts_title', {}, lang),
    '',
    restockCount > 0 ? t('alerts_restock_count', { n: restockCount }, lang) : t('alerts_restock_none', {}, lang),
    t(priceOn ? 'alerts_price_on' : 'alerts_price_off', {}, lang),
  ].join('\n');

  await sendButtons(sock, jid, {
    title: '🔔 Alerts',
    text: summary,
    buttons: withNav([
      priceOn
        ? { id: 'alerts_price_off', text: '🔕 Stop price alerts' }
        : { id: 'alerts_price_on', text: '🔔 Price drop alerts' },
    ]),
  });
  return true;
}

export async function togglePriceAlert(sock, jid, enable) {
  const lang = getLang(jid);
  if (enable) subscribe(jid, 'price', null);
  else unsubscribe(jid, 'price', null);
  await sendText(sock, jid, t(enable ? 'alerts_price_enabled' : 'alerts_price_disabled', {}, lang));
  return sendAlertsScreen(sock, jid);
}

// ── 🔕 Unsubscribe (button on every alert) ──────────────────
export async function handleUnsub(sock, jid, entryId) {
  const lang = getLang(jid);
  const entry = unsubscribeById(entryId);
  if (!entry) {
    await sendText(sock, jid, t('unsub_unknown', {}, lang));
    return false;
  }
  await sendButtons(sock, jid, {
    title: '🔕 Alerts off',
    text: t('unsub_done', {}, lang),
    buttons: withNav([]),
  });
  return true;
}
