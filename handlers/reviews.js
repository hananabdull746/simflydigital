// ─────────────────────────────────────────────────────────────
// handlers/reviews.js
// Post-order engagement:
//   1. thank-you + loyalty line + WhatsApp Channel link
//      (right after delivery; session is cleared here)
//   2. short review request (after a delay, or on the customer's
//      next message) — 4 quick-reply star buttons
//   3. 4–5★ -> optional comment -> name choice -> AUTO-BROADCAST
//      to the WhatsApp Channel (db/reviews.json log)
//   3. ≤3★  -> "what went wrong" -> FORWARDED TO ADMIN ONLY
//      (never posted to the channel under any circumstance)
//
// Privacy rules: no phone number / JID ever leaves this module —
// broadcasts carry only a first name (if the customer picked that)
// or "Verified Customer".
// ─────────────────────────────────────────────────────────────
import { ADMIN_JID, BRAND, ORDER_LINK, SETTINGS } from '../config.js';
import { getChannelLink } from '../lib/admins.js';
import { sendButtons, sendText } from '../lib/ui.js';
import { getUser, setUser, getOrder, state } from '../lib/store.js';
import { getLang, recordCompletedOrder, consumeDiscount } from '../lib/users.js';
import { t } from '../lib/lang.js';
import { clearSession } from '../lib/sessions.js';
import { allowProactive, markProactive, proactiveWait } from '../services/pacing.js';
import { runUnboxing } from '../services/unboxing.js';
import { settleGuarantee, guaranteeBadge, guaranteeMessage } from '../services/guarantee.js';
import { withNav, withNavChoices } from './ui.js';
import { postToChannel } from '../lib/channel.js';
import { addReview, allReviews } from '../lib/reviews.js';
import { logOrder, logError } from '../lib/logger.js';

// ── Choice sets ─────────────────────────────────────────────
export const REVIEW_RATING_CHOICES = [
  { id: 'review_5', label: '⭐⭐⭐⭐⭐', keywords: ['5', '5 stars', 'five', 'excellent', 'amazing'] },
  { id: 'review_4', label: '⭐⭐⭐⭐', keywords: ['4', '4 stars', 'four', 'great', 'good'] },
  { id: 'review_3', label: '⭐⭐⭐', keywords: ['3', '3 stars', 'three', 'okay', 'ok'] },
  { id: 'review_low', label: '⭐⭐ or below', keywords: ['2', '1', '2 stars', '1 star', 'poor', 'bad', 'worst', 'below'] },
];

export const REVIEW_COMMENT_CHOICES = [
  { id: 'review_skip', label: '⏭ Skip', keywords: ['skip', 'next', 'chordo', 'chhoro'] },
];

export const REVIEW_NAME_CHOICES = [
  { id: 'review_name_yes', label: '🙋 Show my name', keywords: ['show', 'name', 'yes', 'y', 'show my name'] },
  { id: 'review_name_no', label: '🙈 Keep me anonymous', keywords: ['anonymous', 'anon', 'hide', 'no', 'keep me anonymous'] },
];

const RATING_STARS = { review_5: 5, review_4: 4, review_3: 3, review_low: 2 };

// Rotating fallback comments so a "skip" still yields a lively post.
const DEFAULT_COMMENTS = [
  'Fast delivery, worked instantly!',
  'Smooth process, will order again!',
  'Setup was quick and easy — highly recommended!',
  'Great price, zero hassle!',
];

// Strip anything phone-number-like a customer may have typed into
// their comment before it goes public.
const redact = (text) => String(text).replace(/\+?\d[\d\s().-]{6,}\d/g, '[number]');

// ── Timer (delayed review request) ──────────────────────────
const reviewTimers = new Map();

function clearReviewTimer(jid) {
  const timer = reviewTimers.get(jid);
  if (timer) clearTimeout(timer);
  reviewTimers.delete(jid);
}

export function armReview(sock, jid, delayMs) {
  if (getUser(jid).flow !== 'review_pending') return;
  clearReviewTimer(jid);
  const timer = setTimeout(() => {
    reviewTimers.delete(jid);
    sendReviewRequest(sock, jid).catch((err) => logError('review.timer', err, { jid }));
  }, Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : SETTINGS.reviewDelayMs);
  reviewTimers.set(jid, timer);
}

/** Test helper: drop every pending delayed-review timer. */
export function __clearReviewTimers() {
  for (const timer of reviewTimers.values()) clearTimeout(timer);
  reviewTimers.clear();
}

/** Re-arm pending review requests after a restart. */export function rearmReviews(sock) {
  let n = 0;
  for (const [jid, user] of Object.entries(state.users || {})) {
    if (user?.flow === 'review_pending') {
      armReview(sock, jid);
      n++;
    }
  }
  if (n) console.log(`[reviews] Re-armed ${n} pending review request(s).`);
}

// ── 1. Thank-you right after delivery ───────────────────────
async function sendThankYou(sock, order, loyalty) {
  const lang = getLang(order.jid);
  const pct = SETTINGS.loyaltyDiscountPercent;
  const lines = [t('thanks_head', {}, lang)];
  if (getChannelLink()) {
    lines.push(t('thanks_channel', {}, lang));
    lines.push(t('thanks_link', { link: getChannelLink() }, lang));
  }
  // Loyalty line replaces the sign-off so the message stays ≤ 4 lines.
  lines.push(
    loyalty?.reward
      ? t('thanks_reward', { pct: loyalty.reward.percent, code: loyalty.reward.code }, lang)
      : loyalty && loyalty.remaining > 0
        ? t('thanks_loyalty', { n: loyalty.remaining, pct }, lang)
        : t('thanks_see', {}, lang)
  );
  await sendText(sock, order.jid, lines.join('\n'));
}

/** Called by confirmOrder() once the eSIM/activation has been delivered. */
export async function startPostOrder(sock, order) {
  try {
    // Order concluded → the resumable session is no longer needed.
    clearSession(order.jid);
    // Loyalty counter + one-time reward (feature 10). Only a LOYALTY
    // code is spent here — an admin 🎟️ sale code has no per-customer
    // state (its uses are counted in lib/sales.js).
    const loyalty = recordCompletedOrder(order.jid);
    if (order.discount && order.discount.source !== 'sale') consumeDiscount(order.jid);

    setUser(order.jid, {
      flow: 'review_pending',
      planId: null,
      orderId: order.id,
      choices: [],
      review: {
        orderId: order.id,
        planId: order.planId,
        planName: order.planName,
        stars: null,
        comment: null,
      },
    });
    // Reduced notification pressure: a customer nudged in the last
    // BROADCAST_MIN_GAP_MINUTES gets the receipt only — no extra
    // thank-you on top of it. (The guarantee still CREDITS itself;
    // only the chatter is suppressed.)
    const thanked = allowProactive(order.jid);

    // ⚡ PART C — the Fast Guarantee settles exactly once per order:
    //    inside the window → a one-line badge, past it → an automatic
    //    wallet credit the customer never had to ask for.
    let guarantee = null;
    try {
      guarantee = await settleGuarantee(order);
    } catch (err) {
      logError('guarantee.settle', err, { orderId: order.id });
    }
    if (thanked && guarantee) {
      const lang = getLang(order.jid);
      const note = guarantee.status === 'fast'
        ? guaranteeBadge(order, lang)
        : guaranteeMessage(order, lang);
      if (note) await sendText(sock, order.jid, note);
    }

    // 📦 PART C — the Digital Unboxing: paced beats BEFORE the
    //    thank-you, so the customer still ends on the review prompt.
    if (thanked) await runUnboxing(sock, order, getLang(order.jid));

    if (thanked) await sendThankYou(sock, order, loyalty);
    armReview(sock, order.jid);
    logOrder('thank_you', { id: order.id, planName: order.planName, status: order.status },
      { channel: Boolean(getChannelLink()), sent: thanked, completed: loyalty.completed, reward: loyalty.reward?.code || null });
  } catch (err) {
    logError('postorder.start', err, { orderId: order.id });
  }
}

// ── 2. Review request ───────────────────────────────────────
/**
 * The star prompt is a NUDGE, not a reply:
 *   • it is dropped for good once the order is older than
 *     REVIEW_PROMPT_TIMEOUT_HOURS — nobody gets chased days later
 *   • it waits out BROADCAST_MIN_GAP_MINUTES if this customer was
 *     just nudged (re-armed for exactly the remaining time)
 *   • a re-prompt while the customer is already looking at the
 *     stars is a reply, so neither rule applies to it
 */
export async function sendReviewRequest(sock, jid) {
  const lang = getLang(jid);
  const user = getUser(jid);
  if (user.flow !== 'review_pending' && user.flow !== 'review_rating') return false;
  clearReviewTimer(jid);

  const proactive = user.flow === 'review_pending';
  if (proactive) {
    if (reviewPromptExpired(user)) {
      dropReviewPrompt(jid, 'expired');
      return false;
    }
    const wait = proactiveWait(jid);
    if (wait > 0) {
      armReview(sock, jid, wait);
      return false;
    }
    markProactive(jid);
  }

  const choices = withNavChoices(REVIEW_RATING_CHOICES);
  setUser(jid, { flow: 'review_rating', choices });

  await sendButtons(sock, jid, {
    title: '⭐ Rate your experience',
    text: [t('review_rate_head', {}, lang), t('review_rate_sub', {}, lang)].join('\n'),
    buttons: withNav(REVIEW_RATING_CHOICES.map((c) => ({ id: c.id, text: c.label }))),
  });
  return true;
}

/** Delivered more than REVIEW_PROMPT_TIMEOUT_HOURS ago → stop asking. */
function reviewPromptExpired(user) {
  const hours = Number(SETTINGS.reviewPromptTimeoutHours) || 0;
  if (hours <= 0) return false;
  const orderId = user.review?.orderId || user.orderId;
  const order = orderId ? getOrder(orderId) : null;
  const at = order?.deliveredAt || order?.createdAt;
  const ts = Date.parse(at || '');
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts > hours * 3_600_000;
}

/** Leave no phantom review flow behind — quietly, with no message. */
function dropReviewPrompt(jid, reason) {
  setUser(jid, { flow: 'menu', review: null, choices: [] });
  clearReviewTimer(jid);
  const user = getUser(jid);
  logOrder('review_prompt_skipped', { id: user.orderId || null }, { reason });
}

// ── Follow-up prompts ───────────────────────────────────────
async function askComment(sock, jid) {
  const lang = getLang(jid);
  const choices = withNavChoices(REVIEW_COMMENT_CHOICES);
  setUser(jid, { flow: 'review_comment', choices });
  await sendButtons(sock, jid, {
    title: '🙌 Shukriya!',
    text: [t('review_comment_head', {}, lang), t('review_comment_sub', {}, lang)].join('\n'),
    buttons: withNav([{ id: 'review_skip', text: t('review_skip', {}, lang) }]),
  });
}

async function askNameChoice(sock, jid) {
  const lang = getLang(jid);
  const choices = withNavChoices(REVIEW_NAME_CHOICES);
  setUser(jid, { flow: 'review_name', choices });
  await sendButtons(sock, jid, {
    title: '🙋 Ya 🙈 anonymous?',
    text: [t('review_name_head', {}, lang), t('review_name_sub', {}, lang)].join('\n'),
    buttons: withNav([
      { id: 'review_name_yes', text: t('review_name_yes', {}, lang) },
      { id: 'review_name_no', text: t('review_name_no', {}, lang) },
    ]),
  });
}

async function askNameText(sock, jid) {
  const lang = getLang(jid);
  setUser(jid, { flow: 'review_name_text', choices: [] });
  await sendText(sock, jid, t('review_name_text', {}, lang));
}

async function askLowDetail(sock, jid) {
  const lang = getLang(jid);
  const choices = withNavChoices(REVIEW_COMMENT_CHOICES);
  setUser(jid, { flow: 'review_low_detail', choices });
  await sendButtons(sock, jid, {
    title: '🙏 Honest feedback',
    text: [t('review_low_head', {}, lang), t('review_low_sub', {}, lang)].join('\n'),
    buttons: withNav([{ id: 'review_skip', text: t('review_skip', {}, lang) }]),
  });
}

/** Re-send the prompt for whatever review step the customer is on. */
export async function repromptReview(sock, jid) {
  switch (getUser(jid).flow) {
    case 'review_pending':
    case 'review_rating':
      return sendReviewRequest(sock, jid);
    case 'review_comment':
      return askComment(sock, jid);
    case 'review_name':
      return askNameChoice(sock, jid);
    case 'review_name_text':
      return askNameText(sock, jid);
    case 'review_low_detail':
      return askLowDetail(sock, jid);
    default:
      return false;
  }
}

// ── 3a. Button taps (stars + name choice + skip) ────────────
export async function handleReviewChoice(sock, jid, id) {
  const user = getUser(jid);

  // Star rating
  if (RATING_STARS[id]) {
    if (user.flow !== 'review_rating' || !user.review) return false;
    setUser(jid, { review: { ...user.review, stars: RATING_STARS[id] } });
    if (RATING_STARS[id] >= 4) {
      await askComment(sock, jid);
      return true;
    }
    await askLowDetail(sock, jid);
    return true;
  }

  // Skip button — behaves per current step
  if (id === 'review_skip') {
    if (user.flow === 'review_comment') {
      setUser(jid, { review: { ...user.review, comment: null } });
      await askNameChoice(sock, jid);
      return true;
    }
    if (user.flow === 'review_low_detail') return finishLow(sock, jid, null);
    return false;
  }

  // Name visibility
  if (id === 'review_name_yes') {
    if (user.flow !== 'review_name') return false;
    await askNameText(sock, jid);
    return true;
  }
  if (id === 'review_name_no') {
    if (user.flow !== 'review_name') return false;
    return finalizeReview(sock, jid, { named: false });
  }

  return false;
}

// ── 3b. Free-text replies (comment / first name / low detail) ─
export async function handleReviewText(sock, jid, text) {
  const user = getUser(jid);
  const body = String(text || '').trim();
  const isSkip = /^(skip|next|chordo|chhoro)$/i.test(body);

  if (user.flow === 'review_comment') {
    setUser(jid, { review: { ...user.review, comment: body && !isSkip ? body : null } });
    await askNameChoice(sock, jid);
    return true;
  }

  if (user.flow === 'review_name_text') {
    const firstName = body.split(/\s+/)[0]?.replace(/[^\p{L}\p{M}'-]/gu, '').slice(0, 24) || '';
    return finalizeReview(sock, jid, { named: Boolean(firstName), firstName: firstName || null });
  }

  if (user.flow === 'review_low_detail') {
    return finishLow(sock, jid, body && !isSkip ? body : null);
  }

  return false;
}

// ── 3c. GOOD review -> auto-broadcast to the channel ────────
async function finalizeReview(sock, jid, { named, firstName }) {
  const lang = getLang(jid);
  const user = getUser(jid);
  const review = user.review || {};
  const stars = review.stars ?? 5;
  const hasComment = Boolean(review.comment && review.comment.trim());
  const comment = hasComment
    ? review.comment.trim()
    : DEFAULT_COMMENTS[allReviews().length % DEFAULT_COMMENTS.length];
  const attribution = named && firstName ? `— ${firstName}` : '— Verified Customer';

  const order = review.orderId ? getOrder(review.orderId) : null;
  const planName = review.planName || order?.planName || `${BRAND.name} plan`;

  const broadcast = [
    '*🔥 Real Customer, Real Review!*',
    `📦 Just delivered: ${planName}`,
    `${'⭐'.repeat(stars)} "${redact(comment)}"`,
    attribution,
    '',
    `Want this too? 👉 Order now: ${ORDER_LINK}`,
  ].join('\n');

  const posted = await postToChannel(sock, broadcast);

  const record = await addReview({
    orderId: review.orderId || null,
    plan: planName,
    stars,
    comment: hasComment ? comment : null,
    usedDefaultComment: !hasComment,
    named: Boolean(named && firstName),
    firstName: named && firstName ? firstName : null,
    broadcast: posted.ok ? 'posted' : 'failed',
    broadcastError: posted.ok ? null : posted.error || null,
    channelJid: posted.jid || null,
    channelMsgId: posted.key || null,
  });

  setUser(jid, { flow: 'menu', review: null, choices: [] });

  await sendText(
    sock,
    jid,
    posted.ok ? t('review_done_channel', {}, lang) : t('review_done_ok', {}, lang)
  );
  logOrder('review_broadcast', { id: review.orderId, planName, status: 'reviewed' }, { stars, reviewId: record.id, broadcast: record.broadcast });
  return true;
}

// ── 3d. LOW review -> ADMIN ONLY, never broadcast ───────────
async function finishLow(sock, jid, comment) {
  const lang = getLang(jid);
  const user = getUser(jid);
  const review = user.review || {};
  const stars = review.stars ?? 3;
  const order = review.orderId ? getOrder(review.orderId) : null;
  const planName = review.planName || order?.planName || `${BRAND.name} plan`;

  const record = await addReview({
    orderId: review.orderId || null,
    plan: planName,
    stars,
    comment: comment || null,
    usedDefaultComment: false,
    named: false,
    firstName: null,
    broadcast: 'admin_only', // hard rule: ≤3★ is NEVER posted
    broadcastError: null,
    channelJid: null,
  });

  if (ADMIN_JID) {
    try {
      await sendText(sock, ADMIN_JID, [
        `⚠️ *LOW REVIEW — ${review.orderId || 'unknown order'}*`,
        `⭐ ${stars}/5 • ${planName}`,
        comment ? `💬 ${comment}` : '💬 (customer skipped details)',
        '',
        'Follow-up karein — ye review channel par POST nahi hua.',
      ].join('\n'));
    } catch (err) {
      logError('review.admin_forward', err, { orderId: review.orderId });
    }
  }

  setUser(jid, { flow: 'menu', review: null, choices: [] });
  await sendText(sock, jid, t('review_low_ack', {}, lang));
  logOrder('review_low', { id: review.orderId, planName, status: 'reviewed' }, { stars, reviewId: record.id });
  return true;
}
