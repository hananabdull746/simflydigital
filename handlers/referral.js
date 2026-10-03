// ─────────────────────────────────────────────────────────────
// handlers/referral.js
// 🎁 PART C — the customer-facing half of the Referral Loop.
//
//   🎁 Refer & Earn (welcome-menu row)
//     → the customer's stable code + a ready-to-forward message
//     → 🎟️ Enter invite code → typed code → services/referral.js
//
// Rules kept here: every button goes through withNav() (no dead
// end), user.choices mirrors the shown buttons exactly, and a bad
// code NEVER throws the customer out of the flow.
// ─────────────────────────────────────────────────────────────
import { ORDER_LINK, SETTINGS, formatPrice } from '../config.js';
import { sendButtons, sendText } from '../lib/ui.js';
import { getLang } from '../lib/users.js';
import { t } from '../lib/lang.js';
import { setUser } from '../lib/store.js';
import { withNav, withNavChoices } from './ui.js';
import { sendWelcome } from './menu.js';
import { referralStats, redeem } from '../services/referral.js';
import { logOrder, logError } from '../lib/logger.js';

const enterChoice = (lang) => ({
  id: 'refer_enter',
  label: t('nav_refer_enter', {}, lang),
  keywords: ['enter', 'code', 'invite', 'redeem'],
});

/** 🎁 Refer & Earn — code, worth, and what to do next. */
export async function sendReferral(sock, jid) {
  const lang = getLang(jid);
  const stats = referralStats(jid);

  setUser(jid, { flow: 'refer', choices: withNavChoices([enterChoice(lang)]) });

  const body = [
    t('refer_head', { amount: stats.bonusPkr, cap: stats.capPkr }, lang, jid),
    '',
    t('refer_code', { code: stats.code }, lang, jid),
    stats.invited > 0
      ? t('refer_stats', { n: stats.invited, earned: formatPrice(stats.earned) }, lang, jid)
      : t('refer_share', { amount: stats.bonusPkr }, lang, jid),
  ].join('\n');

  return sendButtons(sock, jid, {
    title: t('refer_title', {}, lang, jid),
    text: body,
    buttons: withNav([
      { id: 'refer_enter', text: t('nav_refer_enter', {}, lang) },
      { id: 'refer_share', text: t('nav_refer_share', {}, lang) },
    ]),
  });
}

/** The ready-made message the customer forwards to a friend. */
export async function sendReferralShare(sock, jid) {
  const lang = getLang(jid);
  const stats = referralStats(jid);
  setUser(jid, { flow: 'refer', choices: withNavChoices([enterChoice(lang)]) });
  return sendText(sock, jid, [
    t('refer_share_head', {}, lang, jid),
    '',
    t('refer_share_text', { code: stats.code, amount: stats.bonusPkr, link: ORDER_LINK }, lang, jid),
  ].join('\n'));
}

/** "Send me your friend's code" — the only free-text step. */
export async function askReferralCode(sock, jid) {
  const lang = getLang(jid);
  setUser(jid, { flow: 'refer_enter', choices: withNavChoices([]) });
  await sendText(sock, jid, t('refer_ask', { amount: SETTINGS.referralBonusPkr }, lang, jid));
  return true;
}

/**
 * Typed code → services/referral.js.
 * Success returns to the menu; a wrong code re-asks (never a dead end).
 */
export async function handleReferralCode(sock, jid, text) {
  const lang = getLang(jid);
  try {
    const res = await redeem(jid, text);
    if (res.ok) {
      await sendText(sock, jid, t('refer_ok', { amount: res.bonusPkr, code: res.code }, lang, jid));
      return sendWelcome(sock, jid);
    }
    const KEY_BY_REASON = {
      self: 'refer_self',
      invalid: 'refer_invalid',
      already: 'refer_already',
      not_new: 'refer_not_new',
      cap: 'refer_cap',
      disabled: 'refer_disabled',
      empty: 'refer_empty',
    };
    const key = KEY_BY_REASON[res.reason] || 'refer_invalid';
    await sendText(sock, jid, t(key, { amount: SETTINGS.referralBonusPkr, code: res.code || '' }, lang, jid));
    logOrder('referral_rejected', { id: null, status: 'rejected' }, { reason: res.reason, code: res.code || null });
    return askReferralCode(sock, jid);
  } catch (err) {
    logError('referral.redeem', err, { jid });
    return askReferralCode(sock, jid);
  }
}
