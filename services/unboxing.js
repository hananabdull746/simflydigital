// ─────────────────────────────────────────────────────────────
// services/unboxing.js
// 📦 PART C — the Digital Unboxing.
//
// A digital delivery has no box to open, so the bot opens one: a
// 3-beat sequence that runs (human-paced, one beat at a time) right
// AFTER the receipt and BEFORE the thank-you, so the customer still
// ends on the thank-you + review prompt.
//
// Rules:
//   • paced through services/pacing.js sendNatural — never a burst
//   • respects the proactive-nudge gap (a customer who was just
//     nudged gets the receipt only, exactly like the thank-you)
//   • disabled with UNBOXING_MODE=off
// ─────────────────────────────────────────────────────────────
import { SETTINGS } from '../config.js';
import { sendText } from '../lib/ui.js';
import { t } from '../lib/lang.js';
import { allowProactive, sendNatural } from '../services/pacing.js';
import { logOrder, logError } from '../lib/logger.js';

export const unboxingEnabled = () => SETTINGS.unboxing !== false;

/** The 3 beats (order matters — the receipt has already gone out). */
export function unboxingBeats(order, lang = 'ur') {
  const jid = order?.jid || '';
  const plan = order?.planName || 'your order';
  const qty = Math.max(1, Number(order?.quantity) || 1);
  return [
    t('unbox_1', { plan }, lang, jid),
    t('unbox_2', { plan, qty }, lang, jid),
    t('unbox_3', { plan, qty }, lang, jid),
  ].filter(Boolean);
}

/**
 * Run the beats. Resolves with the number of messages actually sent
 * (0 when the feature is off or the nudge gap says "leave them be").
 * Never throws — a pacing failure must not break delivery.
 *
 * @param {object} sock
 * @param {object} order
 * @param {string} lang  'ur' (default) | 'en'
 */
export async function runUnboxing(sock, order, lang = 'ur') {
  if (!unboxingEnabled() || !order?.jid) return 0;
  try {
    if (!allowProactive(order.jid)) return 0;
    let sent = 0;
    for (const text of unboxingBeats(order, lang)) {
      // sendNatural(sock, jid, send) calls send(sock, jid) — bind the text.
      await sendNatural(sock, order.jid, (s, j) => sendText(s, j, text), { text });
      sent += 1;
    }
    logOrder('unboxing', { id: order.id, planName: order.planName, status: order.status }, { beats: sent });
    return sent;
  } catch (err) {
    logError('unboxing.run', err, { orderId: order?.id });
    return 0;
  }
}
