// ─────────────────────────────────────────────────────────────
// handlers/router.js
// Turns an inbound WhatsApp message into the right bot reaction.
//
// Input can arrive four ways and all of them are handled:
//   1. a tapped LIST row          -> structured id (plan:xxx)
//   2. a tapped BUTTON            -> button id (order_now, pay_*)
//   3. a bare number              -> our numbered plain-text fallback
//   4. typed words                -> fuzzy label / keyword match
//
// UX batch additions:
//   • main_menu / human / lang / alerts / reorder / resume ids
//   • human-mode silencing (free text ignored for 30 min)
//   • unsupported-media fallback (never silent)
//   • resume prompt + "I didn't get that" on unrecognized input
// ─────────────────────────────────────────────────────────────
import { SETTINGS, getPaymentMethod, ADMIN_JID, jidUser } from '../config.js';
import { parseIncoming, matchChoice } from '../lib/message.js';
import { getUser, setUser, getOrder } from '../lib/store.js';
import { checkLimit, menuCooldown } from '../lib/ratelimit.js';
import { sendText, sendButtons } from '../lib/ui.js';
import { getLang, setLang } from '../lib/users.js';
import { t } from '../lib/lang.js';
import { resumableSession, clearSession, humanActive } from '../lib/sessions.js';
import { STEP_PAYMENT, normalizeStep } from '../lib/steps.js';
import { getPlan } from '../lib/plans.js';
import { setUiSocket, withNav, withNavChoices } from './ui.js';
import {
  sendWelcome,
  sendPlans,
  sendPlanDetail,
  sendHowEsim,
  sendSupport,
  sendMyOrders,
  sendOrderInfo,
  sendResumePrompt,
  sendLanguageScreen,
} from './menu.js';
import {
  startOrder,
  handleCompat,
  handleUnlock,
  askUnlockCheck,
  handlePlanQuantity,
  askPlanQuantity,
  cancelOrder,
  deleteOrder,
  reorderLast,
} from './orders.js';
import {
  askPaymentMethod,
  sendPaymentDetails,
  handleScreenshot,
  repromptScreenshot,
  resumeAwaiting,
  promptSaleCode,
  applySaleCode,
  removeSaleCode,
  handleBinanceTx,
  repromptBinanceTx,
} from './payments.js';
import {
  sendReviewRequest,
  handleReviewChoice,
  handleReviewText,
  repromptReview,
} from './reviews.js';
import { sendHumanHandoff, forwardHumanText, noteHumanMedia } from './human.js';
import { sendReferral, sendReferralShare, askReferralCode, handleReferralCode } from './referral.js';
import { subscribeRestock, sendAlertsScreen, togglePriceAlert, handleUnsub } from './notify.js';
import {
  sendStore, sendStoreSearch, sendDigitalDetail, startDigitalOrder, handleEmailAnswer,
  confirmActivationEmail, sendStoreCategory, handleQuantity,
} from './digitalStore.js';
import {
  sendWallet, showWalletHistory, startTopup, handleTopupAmountText,
  askTopupMethodPublic, payFromWallet, confirmWalletPay, refundOrderToWallet, sendTopupDetails,
  changeTopupPayment,
} from './wallet.js';
import { tryAdminCommand } from './admin.js';
import { handleAdminMessage, relayCustomer } from './adminPanel.js';
import { enqueue, noteArrival, sendNatural } from '../services/pacing.js';
import {
  acceptsOrders, getSettings, isBlocked, isMaintenance, isQuietNow, linkLidAdmin, optOut,
  quietEndLabel, roleFor,
} from '../lib/admins.js';

/** True when this JID holds an owner or staff role (lib/admins). */
const isAdminRole = (jid) => roleFor(jid) !== null;

// 🌙 Quiet hours: at most one heads-up per customer per quiet window.
const quietNoted = new Map();

async function noteQuietOnce(sock, jid) {
  const last = quietNoted.get(jid) || 0;
  if (Date.now() - last < 6 * 3600_000) return;
  quietNoted.set(jid, Date.now());
  try {
    await sendText(
      sock,
      jid,
      `🌙 Quiet hours hain (till ${quietEndLabel()} PKT) — us ke baad reply karenge. Urgent ho toh *support* likhein.`
    );
  } catch (err) {
    console.warn(`[router] quiet-hours note failed: ${err.message}`);
  }
}

// Casual words that mean "show me the welcome menu".
const WELCOME_TRIGGERS = new Set([
  'menu', 'home', 'start', 'hi', 'hello', 'hey', 'salam', 'assalam',
  'assalamualaikum', 'aoa', 'back', 'main menu', 'welcome',
]);

const TEXT_COMMANDS = [
  { words: ['plans', 'plan', 'view plans', 'price', 'prices', 'rates', 'bundle', 'bundles', 'data plans'], id: 'menu:plans' },
  { words: ['orders', 'my orders', 'order', 'order status', 'track', 'track order'], id: 'menu:orders' },
  { words: ['support', 'contact', 'help', 'help me', 'talk'], id: 'menu:support' },
  { words: ['how', 'esim', 'how esim works', 'guide', 'what is esim', 'how it works'], id: 'menu:how' },
  { words: ['store', 'shop', 'digital store', 'digital', 'products', 'products list'], id: 'menu:store' },
  { words: ['wallet', 'balance', 'my wallet', 'wallet balance'], id: 'menu:wallet' },
  // Also checked inside the human-mode block (which has no `choices`
  // to match against) so a re-tap of "human" stays a re-tap.
  { words: ['human'], id: 'human' },
];

/** Map free-typed text to a well-known command id (null when none). */
function matchTextCommand(text) {
  const lower = String(text || '').trim().toLowerCase();
  if (!lower) return null;
  if (WELCOME_TRIGGERS.has(lower)) return 'back_menu';

  const exact = TEXT_COMMANDS.find((c) => c.words.includes(lower));
  if (exact) return exact.id;

  if (/\b(view|show|all|latest|cheap(est)?)\s+plans?\b/.test(lower)) return 'menu:plans';
  if (/\bmy\s+orders?\b/.test(lower)) return 'menu:orders';
  if (/\b(talk to|contact|email)\s+support\b/.test(lower)) return 'menu:support';
  if (/\bhow\s+\w*\s*esim\b|\besim\s+works\b/.test(lower)) return 'menu:how';
  return null;
}

/**
 * Land a resumed session on the RIGHT screen of the two-step
 * checkout. The order record is the source of truth: once the proof
 * is with us we never ask for it again, and a settled order says so.
 * @returns {Promise<false>} false → the customer is still on Step 1,
 *          which the caller re-opens itself.
 */
async function resumeCheckout(sock, jid, session) {
  const step = normalizeStep(session.step);
  const orderId = session.orderId;
  const open = orderId ? getOrder(orderId) : null;
  const mine = open && open.jid === jid ? open : null;

  if (mine) setUser(jid, { orderId: mine.id });

  if (mine) {
    // Proof submitted — or the order already concluded: never ask
    // for the screenshot again, just show where it stands.
    if (['pending_admin', 'awaiting_supplier_funding', 'awaiting_activation',
      'fulfilled', 'refunded', 'cancelled', 'failed'].includes(mine.status)) {
      return resumeAwaiting(sock, jid);
    }
    // Proof still owed — including a rejection the customer may retry.
    if (['await_screenshot', 'rejected'].includes(mine.status)) {
      if (mine.paymentId === 'pay_binancepay') return repromptBinanceTx(sock, jid);
      return repromptScreenshot(sock, jid);
    }
  }

  if (step !== STEP_PAYMENT) return false;

  // Step 2, no order yet → back to the payment method screen.
  if (session.selectedProductId) {
    setUser(jid, { dpId: session.selectedProductId, planId: null });
  } else if (session.selectedPlanId) {
    const plan = getPlan(session.selectedPlanId);
    if (!plan) {
      clearSession(jid);
      return sendWelcome(sock, jid);
    }
    setUser(jid, { planId: plan.id, dpId: null });
  }
  return askPaymentMethod(sock, jid);
}

/** Run a resolved choice id against the right handler. */
async function dispatch(sock, jid, user, id) {
  if (id.startsWith('menu:')) {
    const section = id.slice(5);
    if (section === 'plans') return sendPlans(sock, jid);
    if (section === 'orders') return sendMyOrders(sock, jid);
    if (section === 'support') return sendSupport(sock, jid);
    if (section === 'how') return sendHowEsim(sock, jid);
    if (section === 'store') return sendStore(sock, jid);
    if (section === 'wallet') return sendWallet(sock, jid);
    return sendWelcome(sock, jid);
  }

  if (id.startsWith('plan:')) return sendPlanDetail(sock, jid, id.slice('plan:'.length));
  // Step 1 quantity rows (eSIM), same shape as the digital dqty:N rows.
  if (id.startsWith('eqty:')) return handlePlanQuantity(sock, jid, id.slice('eqty:'.length));
  if (id.startsWith('orderinfo:')) return sendOrderInfo(sock, jid, id.slice('orderinfo:'.length));
  if (id.startsWith('review_')) return handleReviewChoice(sock, jid, id);
  if (id.startsWith('notify_me:')) return subscribeRestock(sock, jid, id.slice('notify_me:'.length));
  if (id.startsWith('unsub:')) return handleUnsub(sock, jid, id.slice('unsub:'.length));

  // ── 🛍️ Digital Store (second catalog) ────────────────────────
  if (id.startsWith('dp:')) return sendDigitalDetail(sock, jid, id.slice('dp:'.length));
  if (id.startsWith('dcat:')) return sendStoreCategory(sock, jid, id.slice('dcat:'.length));
  if (id.startsWith('dqty:')) return handleQuantity(sock, jid, id.slice('dqty:'.length));
  if (id.startsWith('dpemail_')) return handleEmailAnswer(sock, jid, id === 'dpemail_yes');
  if (id === 'dp_order') return startDigitalOrder(sock, jid);
  if (id === 'dp_search') return sendStoreSearch(sock, jid);
  if (id === 'back_store') return sendStore(sock, jid);

  // ── 💰 Wallet (top-up + pay-from-wallet) ─────────────────────
  if (id.startsWith('walrefund:')) return refundOrderToWallet(sock, jid, id.slice('walrefund:'.length));
  if (id.startsWith('wallet_short:')) return startTopup(sock, jid, { shortfall: Number(id.slice('wallet_short:'.length)) || 0 });
  if (id.startsWith('wallet_amount:')) return askTopupMethodPublic(sock, jid, Number(id.slice('wallet_amount:'.length)) || 0);

  // A payment method tap means different things mid-top-up.
  if (getPaymentMethod(id)) {
    if (user.flow === 'wallet_topup_method') return sendTopupDetails(sock, jid, id);
    return sendPaymentDetails(sock, jid, id);
  }

  switch (id) {
    case 'back_menu':
    case 'main_menu':
      return sendWelcome(sock, jid);
    // 🎁 PART C — Refer & Earn screen (+ share text + "enter a code").
    case 'refer':
      return sendReferral(sock, jid);
    case 'refer_share':
      return sendReferralShare(sock, jid);
    case 'refer_enter':
      return askReferralCode(sock, jid);
    case 'back_plans':
      return sendPlans(sock, jid);
    case 'order_now':
      // ⚙️ Settings → "Accept new orders: OFF" pauses checkout.
      if (!acceptsOrders()) {
        return sendText(
          sock,
          jid,
          '⏸️ Abhi naye orders temporarily band hain — hum jald wapas shuru karenge. Support chahiye toh *support* likhein.'
        );
      }
      return startOrder(sock, jid, user.planId);
    case 'retry_payment':
      if (!user.planId) return sendWelcome(sock, jid);
      return askPaymentMethod(sock, jid);
    case 'compat_yes':
    case 'compat_no':
      return handleCompat(sock, jid, id);
    case 'unlock_yes':
    case 'unlock_no':
    case 'unlock_unsure':
      return handleUnlock(sock, jid, id);
    case 'change_payment':
      return askPaymentMethod(sock, jid);
    case 'promo_code':
      return promptSaleCode(sock, jid);
    case 'promo_remove':
      return removeSaleCode(sock, jid);
    case 'cancel_order':
      return cancelOrder(sock, jid);
    case 'delete_order':
      return deleteOrder(sock, jid);

    // ── 💰 Wallet ─────────────────────────────────────────────
    case 'wallet_home':
      return sendWallet(sock, jid);
    case 'wallet_add':
      return startTopup(sock, jid);
    case 'wallet_custom':
      setUser(jid, { flow: 'wallet_topup_custom', choices: null });
      return sendText(
        sock,
        jid,
        `✏️ Amount type karein — min *${SETTINGS.walletTopupMin}*, max *${SETTINGS.walletTopupMax}*. (e.g. \`1500\`)`
      );
    case 'wallet_history':
      return showWalletHistory(sock, jid);
    case 'wallet_pay':
      return payFromWallet(sock, jid);
    case 'wallet_pay_confirm':
      return confirmWalletPay(sock, jid);
    case 'wallet_pay_cancel':
      return sendWallet(sock, jid);
    case 'change_topup_payment':
      return changeTopupPayment(sock, jid);

    // ── UX batch ────────────────────────────────────────────
    case 'human':
      return sendHumanHandoff(sock, jid);
    case 'lang_toggle':
      return sendLanguageScreen(sock, jid);
    case 'lang_en':
      setLang(jid, 'en');
      return sendLanguageScreen(sock, jid);
    case 'lang_ur':
      setLang(jid, 'ur');
      return sendLanguageScreen(sock, jid);
    case 'alerts':
      return sendAlertsScreen(sock, jid);
    case 'alerts_price_on':
      return togglePriceAlert(sock, jid, true);
    case 'alerts_price_off':
      return togglePriceAlert(sock, jid, false);
    case 'reorder':
      return reorderLast(sock, jid);
    case 'resume_continue': {
      const session = resumableSession(jid);
      if (!session) return sendWelcome(sock, jid);

      const resumed = await resumeCheckout(sock, jid, session);
      if (resumed !== false) return resumed;

      // Still on Step 1 — re-open the first screen of the checkout.
      if (session.selectedProductId) {
        setUser(jid, { dpId: session.selectedProductId, planId: null });
        return sendDigitalDetail(sock, jid, session.selectedProductId);
      }
      const plan = getPlan(session.selectedPlanId);
      if (!plan) {
        clearSession(jid);
        return sendWelcome(sock, jid);
      }
      setUser(jid, { planId: plan.id, dpId: null });
      return startOrder(sock, jid, plan.id); // Step 1 (device check / quantity)
    }
    case 'resume_start':
      clearSession(jid);
      setUser(jid, { planId: null, dpId: null, orderId: null });
      return sendPlans(sock, jid);
    case 'resume_menu':
      clearSession(jid);
      setUser(jid, { planId: null, dpId: null, orderId: null });
      return sendWelcome(sock, jid);

    default:
      return false;
  }
}

/** Unsupported media: never silent — polite fallback + menu. */
async function sendMediaFallback(sock, jid) {
  const lang = getLang(jid);
  const choices = withNavChoices([
    { id: 'menu:plans', label: t('nav_plans', {}, lang), keywords: ['plans', 'plan', 'data'] },
    { id: 'back_menu', label: t('nav_back_menu', {}, lang), keywords: ['menu', 'back', 'home'] },
  ]);
  setUser(jid, { choices });
  await sendButtons(sock, jid, {
    title: '🎙️ Unsupported',
    text: t('media_fallback', {}, lang),
    buttons: withNav([
      { id: 'menu:plans', text: t('nav_plans', {}, lang) },
      { id: 'back_menu', text: t('nav_back_menu', {}, lang) },
    ]),
  });
  return true;
}

/** Context-aware nudge when nothing matched. */
async function nudge(sock, jid, user, parsed) {
  switch (user.flow) {
    case 'choose_compat':
      return startOrder(sock, jid, user.planId);
    case 'choose_unlock':
      return askUnlockCheck(sock, jid);
    case 'esim_qty':
      return askPlanQuantity(sock, jid);
    case 'choose_payment':
      return askPaymentMethod(sock, jid);
    case 'await_screenshot':
      return repromptScreenshot(sock, jid);
    case 'await_binance_tx':
      return repromptBinanceTx(sock, jid);
    case 'pending_admin':
      return sendText(
        sock,
        jid,
        `⏳ *${user.orderId || 'Aapka order'}* abhi verification me hai — hum jald jawab bhejenge. ` +
          'Status dekhne ke liye *orders* likhein.'
      );
    case 'choose_plan':
    case 'plan_view':
      return sendPlans(sock, jid);
    case 'choose_order':
    case 'order_info':
      return sendMyOrders(sock, jid);
    case 'how':
      return sendHowEsim(sock, jid);
    case 'support':
      return sendSupport(sock, jid);
    case 'refer':
      return sendReferral(sock, jid);
    case 'refer_enter':
      return askReferralCode(sock, jid);
    // ── Digital Store / Wallet nudges ────────────────────────
    case 'digital_browse':
    case 'digital_view':
      return sendStore(sock, jid);
    case 'digital_search':
      return sendStoreSearch(sock, jid);
    case 'digital_email':
    case 'digital_email_confirm':
      return sendDigitalDetail(sock, jid, user.dpId || '');
    case 'wallet_home':
      return sendWallet(sock, jid);
    case 'wallet_topup_amount':
      return startTopup(sock, jid, { skipGuard: true });
    case 'wallet_topup_custom':
      return sendText(sock, jid, '✏️ Amount type karein — e.g. `1500`.');
    case 'wallet_topup_method':
      return changeTopupPayment(sock, jid);
    case 'wallet_pay_confirm':
      return payFromWallet(sock, jid);
    case 'review_pending':
    case 'review_rating':
    case 'review_comment':
    case 'review_name':
    case 'review_name_text':
    case 'review_low_detail':
      return repromptReview(sock, jid);
    default: {
      // Unrecognized input: resume prompt when an order is waiting,
      // otherwise a short "I didn't get that" + the main menu.
      const lang = getLang(jid);
      if (resumableSession(jid)) return sendResumePrompt(sock, jid);
      await sendText(sock, jid, t('didnt_get', {}, lang));
      return sendWelcome(sock, jid);
    }
  }
}

/** Fire-and-forget presence update; never let it break a reply. */
async function presence(sock, type, jid) {
  try {
    await sock.sendPresenceUpdate?.(type, jid);
  } catch {
    /* presence is cosmetic — ignore */
  }
}

/**
 * Entry point for every inbound message.
 *
 * Order of operations for a message that gets a reply:
 *   1. mark it SEEN  (blue ticks)
 *   2. debounce       (identical double-taps are dropped)
 *   3. queue it behind anything already running for this chat
 *   4. show "typing…" → natural think-time → send the reply
 *   5. clear "typing…"
 *
 * Steps 3–5 live in services/pacing.js so every chat is paced the
 * same way and replies from one customer never interleave.
 */
export async function handleMessage(sock, rawMsg) {
  if (!rawMsg?.message || rawMsg.key.fromMe) return;

  const jid = rawMsg.key.remoteJid;
  if (!jid || rawMsg.key.remoteJid === 'status@broadcast') return;
  // Bot runs 1:1 with customers — ignore groups, channels and newsletters.
  if (/@g\.us$|@newsletter$|@broadcast$/.test(jid)) return;

  // Privacy senders arrive as @lid — remember their phone number
  // (once) so roleFor() can recognise an admin hiding behind a lid.
  if (/@(hosted\.)?lid$/.test(jid)) await linkLidAdmin(sock, jid);

  // withAck(jid, text, fn) sends through the current socket.
  setUiSocket(sock);

  const parsed = parseIncoming(rawMsg);

  // 1. Mark the chat as read FIRST (blue ticks), then reply.
  try {
    await sock.readMessages?.([rawMsg.key]);
  } catch (err) {
    console.warn(`[router] read receipt failed for ${jid}: ${err.message}`);
  }

  // ── anti-spam (exits before the typing indicator: no reply coming) ──
  // EXCEPT the payment screenshot we asked for ourselves: it is the
  // one message a real buyer must never lose to the limiter.
  const awaitedShot =
    getUser(jid).flow === 'await_screenshot' &&
    parsed.media &&
    (parsed.media.type === 'image' || parsed.media.type === 'document');
  if (!awaitedShot) {
    const limit = checkLimit(jid, SETTINGS.rateLimitMax, SETTINGS.rateLimitWindowMs);
    if (!limit.ok) {
      if (limit.warn) {
        await sendText(sock, jid, '⚠️ Thora aahista! Bohat tez messages aa rahe hain — 1 minute ruk kar dobara try karein.');
      }
      return;
    }
  }

  // Double-tap protection: the same words twice inside
  // DEBOUNCE_WINDOW_MS are one message, not two. Media is exempt
  // (a screenshot can never be swallowed).
  if (noteArrival(jid, parsed.text).duplicate) return;

  // One reply at a time per chat: a burst is answered in order,
  // each after a natural think-time, with "typing…" held up for the
  // whole exchange (services/pacing.js).
  await enqueue(jid, async () => {
    await presence(sock, 'composing', jid);
    try {
      await sendNatural(sock, jid, () => route(sock, rawMsg, jid, parsed), { text: parsed.text });
    } finally {
      await presence(sock, 'paused', jid);
    }
  });
}

/** The actual decision tree (runs inside the typing-indicator window). */
async function route(sock, rawMsg, jid, parsed) {
  const user = getUser(jid);
  const text = String(parsed.text || '').trim();

  // ── 🚫 blocked customers get NO reply (attempts are logged) ──
  if (isBlocked(jid)) {
    if (text) console.log(`[router] blocked jid said something: ${jid}`);
    return;
  }

  // ── 📸 screenshot: the ONE message the bot itself asked for ──
  //    Runs BEFORE maintenance, the admin panel, relay and human
  //    mode on purpose. An owner buying their own plan used to hit
  //    handleAdminMessage() first and the image was swallowed by
  //    the panel (adminInput / relay), so the admin alert — the
  //    screenshot included — never went out. Never intercept it.
  if (
    user.flow === 'await_screenshot' &&
    parsed.media &&
    (parsed.media.type === 'image' || parsed.media.type === 'document')
  ) {
    if (rawMsg.pushName && user.pushName !== rawMsg.pushName) setUser(jid, { pushName: rawMsg.pushName });
    return handleScreenshot(sock, jid, rawMsg, parsed);
  }

  // A real tap means this client renders interactive UI fine.
  if (parsed.channel === 'interactive') setUser(jid, { seesButtons: true });
  if (rawMsg.pushName && user.pushName !== rawMsg.pushName) setUser(jid, { pushName: rawMsg.pushName });

  // ── ⚙️ maintenance mode: only admins get a normal reply ──────
  if (isMaintenance() && !isAdminRole(jid)) {
    await sendText(sock, jid, getSettings().maintenanceMsg);
    return;
  }

  // ── admin system: panel, buttons, relay, input modes, quick ──
  //    commands (non-admins never reach this — lib/admins roles)
  if (await handleAdminMessage(sock, jid, user, parsed, rawMsg)) return;

  const hasAnything = Boolean(parsed.text || parsed.command || parsed.media);
  if (!hasAnything) return;

  // ── 🔕 STOP / unsubscribe = broadcast opt-out (never blocks the
  //    service — orders/support keep working) ─────────────────────
  if (parsed.channel === 'text' && !isAdminRole(jid) && /^(stop|unsubscribe|stop messages|opt ?out)$/i.test(text)) {
    const first = optOut(jid);
    return sendText(
      sock,
      jid,
      first
        ? '✅ Aap promotional messages ki list se hata diye gaye hain. Orders aur support normal chalte rahenge. Wapas chahiye toh *alerts* likhein.'
        : '✅ Aap already broadcast list me nahi hain. Orders aur support normal chalte rahenge.'
    );
  }

  // ── 🌙 quiet hours: one heads-up per customer, then carry on ──
  if (!isAdminRole(jid) && isQuietNow() && parsed.channel === 'text') {
    noteQuietOnce(sock, jid);
  }

  // ── 📢 admin relaying this customer: their reply goes to the admin ──
  const relay = relayCustomer(jid);
  if (relay && parsed.channel === 'text' && text) {
    try {
      await sendText(sock, relay.adminJid, [
        `💬 *Customer reply — ${relay.orderId}*`,
        `👤 +${String(jid).split('@')[0].split(':')[0]}`,
        '',
        text,
      ].join('\n'));
    } catch (err) {
      console.warn(`[router] relay forward failed: ${err.message}`);
    }
    return;
  }

  // ── admin commands (typed in the admin's own chat) ────────
  if (parsed.text && (await tryAdminCommand(sock, jid, parsed.text))) return;

  // ── human mode: silent on free text (admin is talking), but
  //    explicit menu taps / typed menu words still work ────────
  if (humanActive(jid)) {
    if (parsed.channel === 'interactive' && parsed.command) {
      const routed = await dispatch(sock, jid, user, parsed.command);
      if (routed !== false) return;
    }
    if (parsed.channel === 'text' && parsed.text) {
      const textId = matchTextCommand(parsed.text);
      if (textId) {
        if (textId === 'back_menu' && !menuCooldown(jid, SETTINGS.menuCooldownMs)) return;
        return dispatch(sock, jid, user, textId);
      }
      // Not a menu word: mirror it to the team instead of dropping it.
      // The customer still hears nothing (the bot never talks over
      // the human), but the human handling the chat must SEE the
      // question — and media gets the same treatment below.
      await forwardHumanText(sock, jid, parsed.text);
    }
    if (parsed.media) {
      await noteHumanMedia(sock, jid, parsed.media.type);
    }
    return;
  }

  // ── post-delivery review: any message inside the pending window
  //    is the "next message" that triggers the review request ────
  if (user.flow === 'review_pending') return sendReviewRequest(sock, jid);

  // A payment screenshot that arrived while `flow` drifted out of
  // sync (menu tap, stray back, resume prompt) must still reach the
  // admin — repair the flow and treat it as the awaited shot instead
  // of answering "🎙️ Unsupported" and dropping the proof. Runs for
  // captioned images too.
  if (parsed.media && (parsed.media.type === 'image' || parsed.media.type === 'document')) {
    const open = user.orderId ? getOrder(user.orderId) : null;
    if (open && open.jid === jid && ['await_screenshot', 'pending_admin', 'rejected'].includes(open.status)) {
      setUser(jid, { flow: 'await_screenshot', orderId: open.id, choices: null });
      return handleScreenshot(sock, jid, rawMsg, parsed);
    }
  }

  // ── feature 12: anything else media-ish gets a polite fallback ──
  if (parsed.media && !parsed.text) return sendMediaFallback(sock, jid);

  // ── free text that belongs to a specific screen ────────────
  //    (top-up amount, product search query, activation email, sale code)
  if (parsed.channel === 'text' && parsed.text) {
    // 💳 Binance Pay: the awaited Transaction ID. Runs FIRST — it
    //    returns false for anything that is not an id (commands,
    //    buttons and the nudge below keep working as before).
    if (user.flow === 'await_binance_tx') {
      const taken = await handleBinanceTx(sock, jid, text);
      if (taken !== false) return;
    }
    if (user.flow === 'wallet_topup_custom') return handleTopupAmountText(sock, jid, text);
    if (user.flow === 'digital_search') return sendStore(sock, jid, { query: text });
    // A typed number = a CUSTOM quantity — but only for clients that
    // render buttons. Numbered plain-text clients map 1..N onto the
    // rows they were shown (presets + Menu), so let choice matching
    // resolve those instead of hijacking "6" (their Menu row).
    if (user.flow === 'digital_qty' && user.seesButtons !== false) {
      return handleQuantity(sock, jid, text);
    }
    // Step 1 quantity for eSIM orders (typed number = a custom count).
    if (user.flow === 'esim_qty' && user.seesButtons !== false) {
      return handlePlanQuantity(sock, jid, text);
    }
    if (user.flow === 'digital_email') return confirmActivationEmail(sock, jid, text);
    if (user.flow === 'promo_code') return applySaleCode(sock, jid, text);
    // 🎁 PART C — a typed invite code (SF-1A2B3) on the referral screen.
    if (user.flow === 'refer_enter') return handleReferralCode(sock, jid, text);
  }

  // ── ids that stay valid on any screen ─────────────────────
  const cmd = parsed.command;
  if (cmd) {
    const routed = await dispatch(sock, jid, user, cmd);
    if (routed !== false) return;
  }

  // ── review follow-up text (comment / first name / low rating) ─
  if (
    parsed.channel === 'text' &&
    parsed.text &&
    ['review_comment', 'review_name_text', 'review_low_detail'].includes(user.flow)
  ) {
    return handleReviewText(sock, jid, parsed.text);
  }

  // ── typed commands (welcome / plans / orders / support) ───
  if (parsed.channel === 'text' && parsed.text) {
    const textId = matchTextCommand(parsed.text);
    if (textId) {
      // Anti-spam: the welcome menu can't be spammed with typed words.
      if (textId === 'back_menu' && !menuCooldown(jid, SETTINGS.menuCooldownMs)) return;
      return dispatch(sock, jid, user, textId);
    }
  }

  // ── choice matching against what we last displayed ────────
  const choices = Array.isArray(user.choices) && user.choices.length ? user.choices : [];
  const matched = choices.length ? matchChoice(parsed.command || parsed.text, choices) : null;

  if (matched) {
    // A bare number or an exactly-typed label means this client is
    // probably not rendering buttons -> switch them to plain menus.
    if (parsed.channel === 'text' && (matched.via === 'number' || matched.via === 'label')) {
      setUser(jid, { seesButtons: false });
    }
    return dispatch(sock, jid, user, matched.choice.id);
  }

  // ── nothing matched ───────────────────────────────────────
  return nudge(sock, jid, user, parsed);
}
