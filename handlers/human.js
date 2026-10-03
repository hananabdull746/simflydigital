// ─────────────────────────────────────────────────────────────
// handlers/human.js
// "🙋 Talk to Human" escape hatch.
//
//   • Customer taps/types `human` → instant confirmation, EVERY
//     admin (owner + staff) gets one handoff card with the context
//     and the reply instructions.
//   • The session is marked human_mode for HUMAN_MODE_MINUTES —
//     the bot stays quiet on the customer's free text so it never
//     talks over the human, BUT each message (and media) is mirrored
//     to the admins, so whoever handles the chat never flies blind.
//   • Admins reply with `human <number> <message>` (one shot, also
//     (re)opens the window) or the order-card relay.
//   • The window auto-expires: both sides get one closing note.
// ─────────────────────────────────────────────────────────────
import { ADMIN_JID, jidUser } from '../config.js';
import { sendText } from '../lib/ui.js';
import { getLang } from '../lib/users.js';
import { t } from '../lib/lang.js';
import { getUser, setUser, ordersFor, getOrder } from '../lib/store.js';
import {
  saveSession, setHuman, clearHuman, humanActive, humanUntil, humanMinutes,
} from '../lib/sessions.js';
import { STEP_AWAITING, STEP_PAYMENT, STEP_PRODUCT_QTY } from '../lib/steps.js';
import { allAdminJids } from '../lib/admins.js';
import { logOrder } from '../lib/logger.js';

/** Re-ping the team at most this often while a customer keeps re-tapping. */
const REPING_MS = 5 * 60 * 1000;

/** Everyone who must hear about this customer (owner + staff). */
export function humanTargets() {
  const all = allAdminJids();
  if (all.length) return all;
  return ADMIN_JID ? [ADMIN_JID] : [];
}

/** Best-effort fan-out — one dead admin never blocks the others. */
async function sendToTargets(sock, text) {
  for (const target of humanTargets()) {
    try {
      await sendText(sock, target, text);
    } catch (err) {
      console.warn(`[human] Admin forward to ${target} failed: ${err.message}`);
    }
  }
}

/** Short human-readable name of the customer's current screen. */
function stepLabel(user) {
  const map = {
    menu: 'Main menu',
    choose_plan: 'Browsing plans',
    plan_view: 'Viewing a plan',
    choose_compat: 'Device check (compatibility)',
    choose_unlock: 'Device check (factory unlock)',
    esim_qty: 'Choosing quantity (Step 1)',
    choose_payment: 'Choosing payment method (Step 2)',
    await_screenshot: 'Sending payment screenshot',
    pending_admin: 'Waiting for verification',
    review_pending: 'Post-order (review pending)',
    review_rating: 'Post-order (rating)',
    review_comment: 'Post-order (review comment)',
    review_name: 'Post-order (review name)',
    review_name_text: 'Post-order (review name)',
    review_low_detail: 'Post-order (low rating)',
  };
  return map[user.flow] || user.flow || 'Menu';
}

/**
 * One closing note to both sides when the window lapses.
 * `until` is the exact deadline setHuman() stamped — if the window
 * was extended or handed back before the timer fires, this is a
 * silent no-op.
 */
export function armHumanExpiry(sock, jid, until) {
  if (!until) return;
  setTimeout(async () => {
    if (humanUntil(jid) !== until) return; // extended / cleared meanwhile
    clearHuman(jid);
    const num = jidUser(jid);
    await sendToTargets(
      sock,
      `⏱️ *Human window for +${num} expired* — bot wapas active hai (default ${humanMinutes()} min). Dobara lena ho: \`bot off ${num}\`.`
    );
    try {
      await sendText(sock, jid, t('human_expired', {}, getLang(jid)));
    } catch (err) {
      console.warn(`[human] Expiry note to customer failed: ${err.message}`);
    }
    logOrder('human_expired', { id: null, status: 'expired' }, { flow: getUser(jid).flow });
  }, Math.max(0, until - Date.now()) + 50);
}

/**
 * The customer's free text during human mode → mirror it to the
 * team. The customer still hears nothing (the bot never talks over
 * the human), but the question must not vanish.
 */
export async function forwardHumanText(sock, jid, text) {
  if (!humanTargets().length) return;
  const user = getUser(jid);
  const note = [
    `💬 *+${jidUser(jid)}${user.pushName ? ` (${user.pushName})` : ''} · human mode*`,
    '',
    text,
  ].join('\n');
  await sendToTargets(sock, note);
}

/** Any other media in human mode: one heads-up instead of silence. */
export async function noteHumanMedia(sock, jid, type) {
  await sendToTargets(
    sock,
    `📸 *+${jidUser(jid)}* human mode me ${type} bheja hai (customer ki chat khol kar dekhein).`
  );
}

export async function sendHumanHandoff(sock, jid) {
  const lang = getLang(jid);
  const user = getUser(jid);
  const num = jidUser(jid);

  // Re-tap: the team is already connected. The customer gets a
  // short nudge; admins only get re-pinged every REPING_MS so a
  // chatty tapper can't flood them with duplicate handoffs.
  if (humanActive(jid)) {
    await sendText(sock, jid, t('human_again', {}, lang));
    if (Date.now() - (user.humanPingedAt || 0) > REPING_MS) {
      setUser(jid, { humanPingedAt: Date.now() });
      await sendToTargets(sock, [
        `⏳ *+${num} still waiting for a human*${user.pushName ? ` (${user.pushName})` : ''}`,
        `🗨️ Step: ${stepLabel(user)}`,
        `Reply: \`human ${num} <message>\``,
      ].join('\n'));
    }
    return true;
  }

  const profileLastOrder = ordersFor(jid)
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  const planId = user.planId;
  const planName = planId ? `plan ${planId}` : null;

  // Keep the step so the admin sees exactly where the customer
  // stopped: still owes the proof (Step 2) or already waiting on a
  // verdict (post-checkout).
  const openOrder = user.orderId ? getOrder(user.orderId) : null;
  const step = openOrder
    ? (['pending_admin', 'awaiting_supplier_funding', 'awaiting_activation'].includes(openOrder.status)
      ? STEP_AWAITING
      : STEP_PAYMENT)
    : (planId ? STEP_PRODUCT_QTY : null);
  saveSession(jid, {
    step,
    selectedPlanId: planId || null,
    orderId: user.orderId || null,
  });
  const session = setHuman(jid);
  setUser(jid, { choices: [], humanPingedAt: Date.now() });

  await sendText(sock, jid, t('human_reply', {}, lang));

  await sendToTargets(sock, [
    `🙋 *HUMAN REQUEST — customer wants a person*`,
    '',
    `👤 +${num}${user.pushName ? ` (${user.pushName})` : ''}`,
    `🗨️ Step: ${stepLabel(user)}${planName ? ` • 📶 ${planName}` : ''}`,
    `🎫 Order: ${user.orderId || profileLastOrder?.id || '—'}`,
    '',
    `Reply: \`human ${num} <message>\` — customer tak seedha reply jayega.`,
    `Bot wapas chalu karne ke liye \`bot on ${num}\` (auto-resume ${humanMinutes()} min baad).`,
  ].join('\n'));

  armHumanExpiry(sock, jid, session.humanUntil);

  logOrder('human_handoff', { id: user.orderId || null, planName: planId || null, status: 'human' }, { flow: user.flow });
  return true;
}
