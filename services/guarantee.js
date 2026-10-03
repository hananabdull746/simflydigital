// ─────────────────────────────────────────────────────────────
// services/guarantee.js
// ⚡ PART C — the Fast Guarantee.
//
// One promise the store makes in public: an order is delivered
// inside FAST_GUARANTEE_MINUTES of being confirmed, or the customer
// is credited FAST_GUARANTEE_CREDIT_PKR in the wallet —
// automatically, without asking, without a support chat.
//
//   status 'fast'   → a badge line (goes on the thank-you)
//   status 'missed' → one wallet credit (idempotent per order) +
//                     an honest message
//   status 'unknown'→ no timestamps yet, nothing is promised
//
// The credit goes through services/wallet.js, so it obeys the same
// ledger/audit rules as a top-up and can never double-fire: the
// order carries `guaranteeSettled` once the credit has been made.
// ─────────────────────────────────────────────────────────────
import { SETTINGS } from '../config.js';
import { adjustBalance } from './wallet.js';
import { getOrder, putOrder, flush } from '../lib/store.js';
import { t } from '../lib/lang.js';
import { logOrder, logError } from '../lib/logger.js';

const limitMinutes = () => Math.max(1, Number(SETTINGS.fastGuaranteeMinutes) || 15);
const creditPkr = () => Math.max(0, Number(SETTINGS.fastGuaranteeCreditPkr) || 0);

const fmtTime = (ms) => (ms < 60_000 ? '<1 min' : `${Math.round(ms / 60_000)} min`);

/**
 * Pure verdict for one order — no side effects, safe to call twice.
 * @returns {{status:'fast'|'missed'|'unknown', minutesMs:number,
 *            time:string, limitMinutes:number, creditPkr:number}}
 */
export function guaranteeResult(order) {
  const limit = limitMinutes();
  const start = Date.parse(order?.confirmedAt || order?.paidAt || '');
  const end = Date.parse(order?.deliveredAt || '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return { status: 'unknown', minutesMs: 0, time: '—', limitMinutes: limit, creditPkr: creditPkr() };
  }
  const minutesMs = end - start;
  return {
    status: minutesMs <= limit * 60_000 ? 'fast' : 'missed',
    minutesMs,
    time: fmtTime(minutesMs),
    limitMinutes: limit,
    creditPkr: creditPkr(),
  };
}

/**
 * Settle the guarantee on a DELIVERED order (called once from
 * startPostOrder). Credits the wallet on a miss and stamps the order,
 * so a restart or a re-delivery never pays twice.
 *
 * @returns {Promise<null|{status,time,limitMinutes,credit:number,credited:boolean,balanceAfter:number|null}>}
 */
export async function settleGuarantee(order) {
  if (!order?.id) return null;
  const live = getOrder(order.id) || order;
  if (live.guaranteeSettled) return live.guarantee || null;

  const result = guaranteeResult(live);
  if (result.status === 'unknown') return null;

  const stamp = { ...result, credit: 0, credited: false, balanceAfter: null, at: new Date().toISOString() };

  if (result.status === 'missed' && result.creditPkr > 0) {
    try {
      const res = await adjustBalance(live.jid, result.creditPkr, 'guarantee', {
        relatedOrderId: live.id,
        note: `Fast Guarantee missed (limit ${result.limitMinutes} min)`,
        actor: 'fast-guarantee',
      });
      stamp.credit = res.ok ? result.creditPkr : 0;
      stamp.credited = res.ok;
      stamp.balanceAfter = res.ok ? res.balance : null;
    } catch (err) {
      logError('guarantee.credit', err, { orderId: live.id });
    }
  }

  live.guarantee = stamp;
  live.guaranteeSettled = true;
  try {
    putOrder(live);
    flush();
  } catch (err) {
    logError('guarantee.persist', err, { orderId: live.id });
  }

  logOrder('guarantee', { id: live.id, planName: live.planName, status: live.status }, {
    verdict: stamp.status,
    took: stamp.time,
    limitMinutes: stamp.limitMinutes,
    credit: stamp.credit,
  });
  return stamp;
}

/** The badge line for a FAST delivery (null when there is nothing to say). */
export function guaranteeBadge(order, lang = 'ur') {
  const stamp = order?.guarantee;
  if (!stamp || stamp.status !== 'fast') return null;
  return t('guarantee_fast', { time: stamp.time, limit: stamp.limitMinutes }, lang, order?.jid || '');
}

/** The honest one-per-order message for a MISSED guarantee. */
export function guaranteeMessage(order, lang = 'ur') {
  const stamp = order?.guarantee;
  if (!stamp || stamp.status !== 'missed') return null;
  const key = stamp.credited ? 'guarantee_missed' : 'guarantee_missed_nocredit';
  return t(key, { time: stamp.time, limit: stamp.limitMinutes, amount: stamp.credit || creditPkr() },
    lang, order?.jid || '');
}
