// ─────────────────────────────────────────────────────────────
// handlers/payments.js
// Payment method selection + payment VERIFICATION:
//   choose method -> stock re-check + ETA line + account details
//                 -> loyalty discount applied (if any)
//                 -> screenshot upload -> forwarded to admin
//                 -> order waits for `confirm` / `reject`
//
// UX batch additions: withAck processing acknowledgements, the
// "⏱️ Usually confirmed within X" expectation line (read from
// services/verifier.js), the one-line "✅ Received … being
// verified" status, session persistence for resume, and the
// progress prefix on each step.
// ─────────────────────────────────────────────────────────────
import { downloadMediaMessage } from '@itsliaaa/baileys';
import pino from 'pino';
import { ADMIN_JID, AI_VERIFY, BINANCE_PAY, SETTINGS, formatPrice, jidUser, getPaymentMethod, PAYMENT_METHODS } from '../config.js';
import { sendButtons, sendText } from '../lib/ui.js';
import { getPlan } from '../lib/plans.js';
import { getLang } from '../lib/users.js';
import {
  clearPromo, currentPromo, discountFor, redeemSale, saleReasonText, saleState, setPromo,
} from '../lib/sales.js';
import { t } from '../lib/lang.js';
import { sendPlans, sendOutOfStock } from './menu.js';
import { armReminder, confirmOrder } from './orders.js';
import { appendAudit, getSettings, roleFor } from '../lib/admins.js';
import { withNav, withNavChoices, withAck } from './ui.js';
import { STEP_AWAITING, STEP_PAYMENT, withStep } from '../lib/steps.js';
import { saveSession } from '../lib/sessions.js';
import { getUser, setUser, resetUser, nextOrderId, putOrder, getOrder, flush } from '../lib/store.js';
import { checkStock } from '../services/esimaccess.js';
import { confirmEta, autoCheck, linkPayment, unclaimedPayments } from '../services/verifier.js';
import {
  auditVerdict, claimTransaction, expectedUsdt, isVerifying, mode as binanceMode,
  recordVerdict, usdtLabel, verifyWithRetry,
} from '../services/binanceVerifier.js';
import { isConfigured as binanceReady } from '../services/binancePay.js';
import { readScreenshot } from '../services/ai/gemini.js';
import { decide as aiDecide, stampDecision as stampAi } from '../services/ai/paymentDecisionEngine.js';
import { notifyNewOrder } from './adminPanel.js';
import { checkoutItem } from './checkout.js';
import { walletCheckoutInfo } from './wallet.js';
import { logOrder, logError } from '../lib/logger.js';

const logger = pino({ level: 'silent' });
const now = () => new Date().toISOString();

// The screenshot download must NEVER stall (or swallow) the admin
// alert: it runs in the background with a hard cap.
const SCREENSHOT_DOWNLOAD_MS = 15000;

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ── Choice sets (used by the router for typed/numbered input) ─
export const SCREENSHOT_CHOICES = [
  { id: 'change_payment', label: '💳 Change Payment Method', keywords: ['change', 'payment method', 'dusra method'] },
  { id: 'cancel_order', label: '⛔ Cancel Order', keywords: ['cancel', 'order cancel'] },
];

export const PENDING_CHOICES = [
  { id: 'cancel_order', label: '⛔ Cancel Order', keywords: ['cancel', 'order cancel'] },
  { id: 'menu:orders', label: '📦 Track My Order', keywords: ['orders', 'status', 'track'] },
  { id: 'back_menu', label: '⬅️ Back to Menu', keywords: ['menu', 'back', 'home'] },
];

/** Payment methods actually configured in .env (empty ones are hidden). */
export function paymentChoices() {
  return PAYMENT_METHODS.map((m) => ({
    id: m.id,
    label: m.label,
    keywords: [m.key, m.label.toLowerCase()],
  }));
}

/** Step 3: ask which payment method the customer will use. */
export async function askPaymentMethod(sock, jid) {
  const lang = getLang(jid);
  const choices = paymentChoices();
  if (choices.length === 0) {
    await sendText(
      sock,
      jid,
      '⚠️ Abhi koi payment method configured nahi hai. Admin ko .env me PAYMENT_SADAPAY_NUMBER / PAYMENT_BINANCE_ID set karna hoga.'
    );
    clearCheckoutSession(jid);
    return resetUser(jid);
  }

  // One cart, two catalogues: eSIM plans and Digital Store products
  // both land here (handlers/checkout.js answers "what's in it?").
  const item = await checkoutItem(jid);
  if (!item) {
    clearCheckoutSession(jid);
    return resetUser(jid);
  }

  // Stock re-check right BEFORE the payment step (feature 7).
  const stockOk = await withAck(jid, t('ack_stock', {}, lang), async () => {
    if (item.catalog === 'esim') {
      const s = await checkStock(item.id);
      if (!s.ok) {
        await sendOutOfStock(sock, jid, item.id, { phase: 'browse' });
        return false;
      }
      return true;
    }
    if (item.raw && (item.raw.inStock === false || (Number.isFinite(item.raw.stock) && item.raw.stock <= 0))) {
      const { sendStore } = await import('./digitalStore.js');
      await sendStore(sock, jid, { note: '❌ Item abhi out of stock hai — dobara check karein.' });
      return false;
    }
    return true;
  });
  if (stockOk === false) return false;

  // 💰 Wallet shortcut: when the customer already has enough balance
  // they skip screenshots / NayaPay verification entirely.
  const wallet = await walletCheckoutInfo(jid);

  // 🎟️ Sale code: typed at this step, discounted price shown live.
  const promo = currentPromo(jid);
  const saleDisc = discountFor(jid, { catalog: item.catalog, pricePkr: item.price });
  const saleLine = saleDisc
    ? `🎟️ Code *${saleDisc.code}* — ${saleDisc.percent}% OFF → *${formatPrice(item.price - saleDisc.amount)}* (-${formatPrice(saleDisc.amount)})`
    : null;

  const promoChoice = promo
    ? { id: 'promo_remove', label: '🎟️ Remove code', keywords: ['remove code', 'clear promo', 'no code'] }
    : { id: 'promo_code', label: '🎟️ Sale code', keywords: ['sale', 'promo', 'code', 'discount', 'coupon', 'deal'] };

  const navChoices = withNavChoices(wallet.enabled
    ? [...choices, { id: 'wallet_pay', label: '💰 Wallet', keywords: ['wallet', 'balance', 'pay from wallet'] }, promoChoice]
    : [...choices, promoChoice]);

  setUser(jid, { flow: 'choose_payment', choices: navChoices });
  saveSession(jid, {
    step: STEP_PAYMENT,
    // Back at the payment screen — any pending "resume after top-up"
    // from an earlier shortfall chain is settled by being here.
    resumeAfterTopup: false,
    selectedPlanId: item.catalog === 'esim' ? item.id : null,
    selectedProductId: item.catalog === 'digital' ? item.id : null,
  });

  if (choices.length === 1 && !wallet.enabled) {
    // Only one method configured — skip the extra question entirely.
    return sendPaymentDetails(sock, jid, choices[0].id);
  }

  const walletLine = wallet.enabled
    ? (wallet.enough
        ? `💰 Wallet: *${formatPrice(wallet.balancePkr)}* — *Wallet* button se foran pay karein.`
        : `💰 Wallet: ${formatPrice(wallet.balancePkr)} (shortfall ${formatPrice(wallet.shortfallPkr)}) — top up karke pay kar sakte hain.`)
    : null;

  const buttons = [
    ...(choices.length === 1 ? [] : PAYMENT_METHODS.map((m) => ({ id: m.id, text: `${m.icon} ${m.label}` }))),
    ...(wallet.enabled
      ? [{ id: 'wallet_pay', text: wallet.enough ? `💰 Wallet (${formatPrice(wallet.balancePkr)})` : '➕ Top Up Wallet' }]
      : []),
    promoChoice.id === 'promo_code'
      ? { id: 'promo_code', text: '🎟️ Sale code' }
      : { id: 'promo_remove', text: `🎟️ ${promo} ✕` },
  ];

  await sendButtons(sock, jid, {
    title: '💳 Payment Method',
    text: withStep(STEP_PAYMENT, [
      t('pay_lead', {}, lang),
      '',
      item.catalog === 'esim'
        ? t('pay_plan', { v: `${item.name}${item.quantity > 1 ? ` ×${item.quantity}` : ''} — ${formatPrice(item.price)}` }, lang)
        : `🛍️ ${item.name} — ${formatPrice(item.price)}`,
      item.quantity > 1 ? `📦 ${item.quantity} × ${formatPrice(item.unitPrice || item.price)}` : null,
      saleLine,
      walletLine || '',
      t('pay_eta', { eta: confirmEta() }, lang),
      t('pay_after', {}, lang),
    ].filter(Boolean).join('\n')),
    buttons: withNav(buttons),
  });
  return true;
}

// ── 🎟️ Sale code entry (typed input) ──────────────────────────
export async function promptSaleCode(sock, jid) {
  const lang = getLang(jid);
  setUser(jid, { flow: 'promo_code', choices: withNavChoices([
    { id: 'change_payment', label: '💳 Back to payment', keywords: ['back', 'payment', 'cancel'] },
  ]) });
  await sendButtons(sock, jid, {
    title: '🎟️ Sale code',
    text: [
      'Apna sale/deal code type karein (e.g. `EID20`).',
      '',
      'Code daalte hi discount *foran* payment amount par lag jayega.',
      '',
      'Waapis jane ke liye *back* likhein.',
    ].join('\n'),
    buttons: withNav([{ id: 'change_payment', text: '⬅️ Back to payment' }]),
  });
  return true;
}

/** Typed code → validate → back to the payment screen with the deal applied. */
export async function applySaleCode(sock, jid, text) {
  const value = String(text || '').trim();
  const lang = getLang(jid);

  if (/^(back|cancel|no|nahi)$/i.test(value)) {
    setUser(jid, { flow: 'choose_payment' });
    clearPromo(jid);
    return askPaymentMethod(sock, jid);
  }

  const st = saleState(value);
  if (!st.ok) {
    await sendText(sock, jid, saleReasonText(st.reason));
    return promptSaleCode(sock, jid);
  }

  setPromo(jid, st.code);
  appendPromoAudit(jid, st.code);
  setUser(jid, { flow: 'choose_payment' });
  await sendText(sock, jid, `✅ Code *${st.code}* lag gaya — *${st.percentOff}% OFF* ✅`);
  return askPaymentMethod(sock, jid);
}

/** Remove an applied code (button on the payment screen). */
export async function removeSaleCode(sock, jid) {
  clearPromo(jid);
  setUser(jid, { flow: 'choose_payment' });
  await sendText(sock, jid, '🎟️ Code hata diya gaya.');
  return askPaymentMethod(sock, jid);
}

function appendPromoAudit(jid, code) {
  try {
    appendAudit({ actor: jidUser(jid), role: roleFor(jid) || 'customer', action: 'sale.applied', target: code });
  } catch { /* audit is best-effort on the customer path */ }
}

function clearCheckoutSession(jid) {
  saveSession(jid, { step: null, selectedPlanId: null, orderId: null });
}

// ── Step 2: show account details + generate Order ID ────────
export async function sendPaymentDetails(sock, jid, paymentId) {
  const lang = getLang(jid);
  const method = getPaymentMethod(paymentId);
  if (!method) return sendText(sock, jid, '❌ Invalid payment method. Menu se dobara select karein.');

  // Shared cart: eSIM plan OR Digital Store product.
  const item = await checkoutItem(jid);
  if (!item) return sendPlans(sock, jid);
  const isDigital = item.catalog === 'digital';

  const user = getUser(jid);
  // Re-picking a method keeps the same Order ID (one order per
  // checkout) — but a top-up reference (WTP-xxxx) or an order that is
  // already closed is never reused: that would overwrite that record.
  const prior = user.orderId ? getOrder(user.orderId) : null;
  const orderId = prior
    && prior.jid === jid
    && prior.catalogType !== 'wallet_topup'
    && !['fulfilled', 'refunded', 'cancelled', 'rejected', 'failed'].includes(prior.status)
    ? prior.id
    : nextOrderId();

  // 💳 Binance Pay: the customer owes USDT and types a Transaction
  //    ID instead of uploading a screenshot — same step of the
  //    progress line, different flow.
  const isBinance = method.id === 'pay_binancepay';

  setUser(jid, {
    flow: isBinance ? 'await_binance_tx' : 'await_screenshot',
    orderId,
    choices: withNavChoices(SCREENSHOT_CHOICES),
  });
  saveSession(jid, {
    step: STEP_PAYMENT,
    selectedPlanId: isDigital ? null : item.id,
    selectedProductId: isDigital ? item.id : null,
    orderId,
  });

  // Discount: admin sale code first (both catalogues), then the
  // per-customer loyalty code (eSIM only). One resolver — lib/sales.js
  // — so the screenshot path and the wallet one-tap always agree.
  const disc = discountFor(jid, { catalog: item.catalog, pricePkr: item.price });
  const paid = disc ? item.price - disc.amount : item.price;
  const isNewOrder = !getOrder(orderId);

  putOrder({
    id: orderId,
    jid,
    phone: jidUser(jid),
    name: getUser(jid).pushName || null,
    catalogType: item.catalog,
    planId: isDigital ? null : item.id,
    planName: item.name,
    productId: isDigital ? item.id : null,
    quantity: item.quantity || 1,
    activationEmail: isDigital ? item.activationEmail : null,
    requiresEmailActivation: Boolean(item.requiresEmailActivation),
    data: item.data,
    validity: item.validity,
    price: item.price,
    discount: disc
      ? { code: disc.code, percent: disc.percent, amount: disc.amount, source: disc.source }
      : null,
    paidAmount: paid,
    paymentId: method.id,
    paymentLabel: method.label,
    // 💳 Pay-in details for the USDT flow (null for every other method).
    binance: isBinance
      ? {
        txId: null,
        expectedUsdt: expectedUsdt({ paidAmount: paid }),
        rate: BINANCE_PAY.usdtPkrRate,
        payId: BINANCE_PAY.payId,
        verdict: null,
        checkedAt: null,
      }
      : null,
    paidBy: null,
    status: 'await_screenshot',
    screenshot: null,
    note: '',
    supplierOrderId: null,
    prodsellerOrderId: null,
    reminderAt: null,
    reminderSent: false,
    createdAt: user.orderId ? (getOrder(orderId)?.createdAt ?? now()) : now(),
    updatedAt: now(),
  });
  // Burn one use of an admin sale code — only when the order is new
  // (re-picking a payment method must not double-count).
  if (isNewOrder && disc?.source === 'sale') redeemSale(disc.code);
  flush();
  logOrder('created', { id: orderId, planName: item.name, status: 'await_screenshot' }, { phone: jidUser(jid), payment: method.label, catalogType: item.catalog });

  const amountLines = disc
    ? [
        t('det_amount', { v: formatPrice(item.price) }, lang),
        t('det_discount', { pct: disc.percent, now: formatPrice(paid) }, lang),
      ]
    : [t('det_amount', { v: formatPrice(item.price) }, lang)];

  const productLines = isDigital
    ? [`🛍️ ${item.name}`,
       item.requiresEmailActivation ? '📧 Activation email: (aapka diya hua)' : '⚡ Instant delivery']
    : [`📊 ${item.data} • ${item.validity}`,
       ...(item.quantity > 1
         ? [`📦 ${item.quantity} eSIMs — ${formatPrice(item.price)} (${formatPrice(item.unitPrice || item.price)} each)`]
         : [])];

  // 💳 Binance Pay: the customer sees the USDT figure + our Pay ID
  //    and answers with a Transaction ID — never a PKR line, never a
  //    screenshot (handlers/payments.js → handleBinanceTx).
  if (isBinance) {
    return sendBinancePayScreen(sock, jid, { orderId, item, lang, productLines, paid });
  }

  await sendButtons(sock, jid, {
    title: `🎫 Order ${orderId}`,
    text: withStep(STEP_PAYMENT, [
      t('det_id', { id: orderId }, lang),
      '',
      t('det_pay', { v: method.label }, lang),
      ...method.details.map((line) => `   ${line}`),
      '',
      ...amountLines,
      t('det_plan', { v: item.name }, lang),
      ...productLines,
      '',
      t('det_do', {}, lang),
      t('det_need', {}, lang),
    ].join('\n')),
    buttons: withNav([
      { id: 'change_payment', text: t('btn_change_payment', {}, lang) },
      { id: 'cancel_order', text: t('btn_cancel_order', {}, lang) },
    ]),
  });
  return true;
}

/** Re-ask for the screenshot when the customer sends text instead of an image. */
export async function repromptScreenshot(sock, jid) {
  const lang = getLang(jid);
  const user = getUser(jid);
  const order = user.orderId ? getOrder(user.orderId) : null;
  if (!order) return sendPlans(sock, jid);
  // 💳 Binance Pay orders ask for a Transaction ID, never a photo.
  if (order.paymentId === 'pay_binancepay') return repromptBinanceTx(sock, jid);
  // Never demand a screenshot for an order that is already settled
  // (delivered, refunded, cancelled) — the customer would be stuck in
  // a screenshot loop for a finished payment. `rejected` stays open:
  // a corrected screenshot is exactly how a rejection is retried.
  if (['fulfilled', 'refunded', 'cancelled'].includes(order.status)) {
    return sendText(sock, jid,
      `ℹ️ *${order.id}* ka screenshot step band hai (status: *${order.status}*) — *menu* likhein.`);
  }

  setUser(jid, { flow: 'await_screenshot', choices: withNavChoices(SCREENSHOT_CHOICES) });
  saveSession(jid, { step: STEP_PAYMENT, selectedPlanId: order.planId, selectedProductId: order.productId || null, orderId: order.id });

  await sendButtons(sock, jid, {
    title: `🎫 ${order.id} — screenshot chahiye`,
    text: withStep(STEP_PAYMENT, [
      t('re_head', {}, lang),
      '',
      t('re_id', { id: order.id }, lang),
      t('re_pay', { v: order.paymentLabel, amount: formatPrice(order.price) }, lang),
      '',
      t('re_send', {}, lang),
      t('det_need', {}, lang),
    ].join('\n')),
    buttons: withNav([
      { id: 'change_payment', text: t('btn_change_payment', {}, lang) },
      { id: 'cancel_order', text: t('btn_cancel_order', {}, lang) },
    ]),
  });
  return true;
}

/**
 * Resume of the `awaiting_confirmation` step: the proof is already
 * with us, so the screenshot is NEVER demanded again — we show where
 * the order stands (and fall back to the right screen when it
 * settled or got rejected while the customer was away).
 */
export async function resumeAwaiting(sock, jid) {
  const lang = getLang(jid);
  const user = getUser(jid);
  const order = user.orderId ? getOrder(user.orderId) : null;
  if (!order) return sendPlans(sock, jid);

  if (['fulfilled', 'refunded', 'cancelled'].includes(order.status)) {
    return sendText(sock, jid,
      `✅ *${order.id}* ka payment pehle hi settle ho chuka hai (status: *${order.status}*) — *menu* likhein.`);
  }
  // A rejection re-opens the proof step (a corrected screenshot / tx
  // id is exactly how it gets retried) — so does an order that never
  // got one in the first place.
  if (order.status === 'rejected' || order.status === 'await_screenshot') {
    return repromptScreenshot(sock, jid);
  }

  setUser(jid, { flow: 'pending_admin', orderId: order.id, choices: withNavChoices(PENDING_CHOICES) });
  saveSession(jid, { step: STEP_AWAITING, orderId: order.id });

  await sendButtons(sock, jid, {
    title: `⏳ ${order.id} — verification pending`,
    text: [
      t('shot_ack', { id: order.id }, lang),
      '',
      t('shot_head', {}, lang),
      t('shot_id', { id: order.id }, lang),
      t('shot_plan', { v: `${order.planName} — ${formatPrice(order.price)}` }, lang),
      t('shot_pay', { v: order.paymentLabel }, lang),
      '',
      t('shot_wait', { n: Math.round(SETTINGS.autoReminderMs / 60000) }, lang),
      t('shot_qr', {}, lang),
    ].join('\n'),
    buttons: withNav([
      { id: 'menu:orders', text: t('nav_orders', {}, lang) },
      { id: 'cancel_order', text: t('btn_cancel_order', {}, lang) },
    ]),
  });
  return true;
}

// ── Screenshot received -> ONE admin message (image + buttons) ─
export async function handleScreenshot(sock, jid, rawMsg, parsed) {
  const lang = getLang(jid);
  const user = getUser(jid);
  const order = user.orderId ? getOrder(user.orderId) : null;
  if (!order) {
    setUser(jid, { flow: null, planId: null });
    return sendText(sock, jid, '❌ Pehle ek plan select karein. Menu kholne ke liye *menu* likhein.');
  }
  // A screenshot for an order that is already settled (credited
  // top-up, delivered, refunded, cancelled) must not re-open it or
  // spam the admin card — just tell the customer it is finished.
  // `rejected` is deliberately still open: a better screenshot is how
  // a rejection gets retried.
  if (['fulfilled', 'refunded', 'cancelled'].includes(order.status)) {
    return sendText(sock, jid,
      `✅ *${order.id}* ka payment pehle hi settle ho chuka hai (status: *${order.status}*) — *menu* likhein.`);
  }

  // The image download starts NOW and settles in the background. The
  // admin alert is ONE message (screenshot + details + buttons), so
  // it needs the bytes — but the customer's receipt card must never
  // wait on a slow or hung WhatsApp media fetch.
  const shotReady = downloadScreenshot(sock, order, rawMsg).catch((err) => {
    logError('screenshot.alert', err, { orderId: order.id });
    return null;
  });

  // Acknowledge instantly, then do the FAST local work.
  let check = null;
  const done = await withAck(jid, t('ack_shot', {}, lang), async () => {
    order.status = 'pending_admin';
    order.screenshot = {
      mimetype: parsed?.media?.mimetype || 'image/jpeg',
      bytes: 0,
      receivedAt: now(),
      pending: true,
    };
    if (!order.name) order.name = user.pushName || null;

    // Auto-check against parsed NayaPay emails (drives the card's
    // 🤖 status line + the ⚠️ Suspicious-activity alert).
    check = autoCheck(order);
    if (check.status === 'matched' && check.payment?.status === 'unclaimed') {
      const linked = linkPayment(check.payment.txn, order.id, 'auto-check');
      if (linked.ok) console.log(`[payments] ${order.id} auto-linked to txn ${check.payment.txn}`);
    }
    if (check.status === 'amount_mismatch') {
      order.verifyFails = (order.verifyFails || 0) + 1;
    }

    order.updatedAt = now();
    order.reminderAt = Date.now() + SETTINGS.autoReminderMs;
    order.reminderSent = false;
    putOrder(order);
    flush();

    setUser(jid, { flow: 'pending_admin', choices: withNavChoices(PENDING_CHOICES) });
    // Only the step + order pointer — the plan/product the session
    // already carries is never overwritten (a wallet top-up screenshot
    // must not erase the plan checkout it is paying for).
    saveSession(jid, { step: STEP_AWAITING, orderId: order.id });

    await sendButtons(sock, jid, {
      title: `🎫 ${order.id} received`,
      text: [
        t('shot_ack', { id: order.id }, lang),
        '',
        t('shot_head', {}, lang),
        t('shot_id', { id: order.id }, lang),
        t('shot_plan', { v: `${order.planName} — ${formatPrice(order.price)}` }, lang),
        t('shot_pay', { v: order.paymentLabel }, lang),
        '',
        t('shot_wait', { n: Math.round(SETTINGS.autoReminderMs / 60000) }, lang),
        t('shot_qr', {}, lang),
        t('shot_thanks', {}, lang),
      ].join('\n'),
      buttons: withNav([
        { id: 'menu:orders', text: t('nav_orders', {}, lang) },
        { id: 'cancel_order', text: t('btn_cancel_order', {}, lang) },
      ]),
    }).catch((err) => {
      // The receipt failing must never swallow the admin alert below.
      logError('screenshot.receipt', err, { orderId: order.id });
    });

    return true;
  });

  // Patch the order AFTER both the callback and the download settled
  // (a fast download must not be overwritten by the callback's
  // pending flag), then push the ONE admin message: screenshot as
  // the header, details + typed hints as the caption, Confirm /
  // Reject buttons attached (caption warns when the download failed).
  const buffer = await shotReady;
  const live = getOrder(order.id) || order;
  if (buffer) {
    live.screenshot = { ...(live.screenshot || {}), bytes: buffer.length, pending: false, failed: false };
  } else if (live.screenshot) {
    live.screenshot = { ...live.screenshot, bytes: 0, pending: false, failed: true };
  }
  live.updatedAt = now();
  putOrder(live);
  flush();

  // 🧠 Part B — only when the deterministic check did NOT settle it:
  // read the screenshot (Gemini vision) and hand the ambiguous case to
  // the analyst. The verdict is stamped on the order so the card below
  // can show it; it never overrides what code already proved.
  if (check?.status !== 'matched') {
    await consultAiScreenshot(live, check, buffer);
  }

  await notifyNewOrder(sock, live, buffer);
  armReminder(sock, live.id);
  logOrder('awaiting_verification', live, { admin: ADMIN_JID || 'NOT SET', autoCheck: check?.status });

  // 💳 Auto-verifier: with VERIFY_AUTO=on ('shadow' only logs), a
  //    clean NayaPay amount match confirms the order immediately —
  //    the customer's next message is their delivery, not a "still
  //    waiting" nudge. Any doubt (no match / amount mismatch) falls
  //    through to the admin card as usual.
  if (getSettings().autoVerifier === 'on' && check?.status === 'matched') {
    try {
      const res = await confirmOrder(sock, live.id, { actor: 'auto-verifier' });
      logOrder('auto_confirmed', { id: live.id, status: getOrder(live.id)?.status || 'unknown' }, { ok: res.ok });
      if (res.ok) return done;
    } catch (err) {
      logError('autoconfirm.fail', err, { orderId: live.id });
    }
  }
  return done;
}

/**
 * 🧠 Part B — screenshot evidence + the decision engine.
 *
 * Reads the image with Gemini vision (when configured), then asks the
 * analyst ONLY if services/ai/paymentDecisionEngine.js considers the
 * case ambiguous. Every verdict — including "code forced this" — is
 * stamped onto the order and written to db/aiDecisions.json, so the
 * admin card can show what the machine thinks without ever acting on
 * a payment that the deterministic rules already rejected.
 *
 * Never throws: a dead model must not stop the screenshot alert.
 */
async function consultAiScreenshot(order, check, buffer) {
  if (AI_VERIFY.mode === 'off') return null;
  try {
    // Vision only earns its latency when the code is not sure yet.
    if (buffer && AI_VERIFY.visionEnabled) {
      const read = await readScreenshot(buffer, { mimetype: order.screenshot?.mimetype });
      if (read.ok && read.data) {
        order.paymentEvidence = { ...read.data, source: 'gemini' };
      } else if (read.code && !['NOT_CONFIGURED', 'NO_IMAGE'].includes(read.code)) {
        order.paymentEvidence = {
          source: 'gemini', error: read.code, readAt: new Date().toISOString(),
        };
      }
    }

    const evidence = {
      screenshot: order.paymentEvidence?.amount ? order.paymentEvidence : null,
      candidates: unclaimedPayments().slice(-6).map((p) => ({
        txn: p.txn,
        amount: p.amount,
        status: p.status,
        matchedOrder: p.matchedOrder || null,
        at: p.at,
      })),
    };

    const result = await aiDecide({
      order,
      kind: 'screenshot',
      deterministic: check,
      evidence,
    });

    if (order.paymentEvidence || result) {
      putOrder(order);
      flush();
    }
    if (!result) return null;

    logOrder('ai_decision', order, {
      decision: result.decision,
      mode: result.mode,
      source: result.source,
      status: check?.status || null,
      flags: result.flags.join(','),
    });
    return result;
  } catch (err) {
    logError('ai.screenshot', err, { orderId: order.id });
    return null;
  }
}

/**
 * Download the screenshot (15s hard cap). Returns the buffer, or
 * null when the download failed — sends nothing: the caller patches
 * the order and pushes the ONE combined admin alert.
 */
async function downloadScreenshot(sock, order, rawMsg) {
  try {
    return await withTimeout(
      downloadMediaMessage(rawMsg, 'buffer', {}, {
        logger,
        reuploadRequest: sock.updateMediaMessage,
      }),
      SCREENSHOT_DOWNLOAD_MS,
      'screenshot download',
    );
  } catch (err) {
    console.warn(`[payments] Could not download screenshot from ${order.jid || 'unknown'}: ${err.message}`);
    logError('screenshot.download', err, { orderId: order.id });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// 💳 BINANCE PAY — USDT checkout, Transaction ID instead of a
//    screenshot, auto-verified against GET /sapi/v1/pay/transactions.
//
//   sendBinancePayScreen()  the "pay exactly X USDT" step
//   handleBinanceTx()       typed Transaction ID → verify in the
//                           background (never blocks the chat queue)
//   runVerification()       retry loop → claim → fulfil (auto) or
//                           hand the order to the admin (shadow /
//                           mismatch / timeout / not configured)
// ─────────────────────────────────────────────────────────────

/** "10.00" — the exact USDT figure the customer must send. */
const usdtFigure = (order) => `${expectedUsdt(order).toFixed(2)}`;

/**
 * Step 4 of the USDT flow: Pay ID + exact amount, then "type your
 * Transaction ID". No PKR line — this method is quoted in USDT only.
 */
async function sendBinancePayScreen(sock, jid, { orderId, item, lang, productLines, paid }) {
  const usdt = usdtFigure({ paidAmount: paid });

  await sendButtons(sock, jid, {
    title: `🎫 Order ${orderId}`,
    text: withStep(STEP_PAYMENT, [
      t('det_id', { id: orderId }, lang),
      '',
      `💳 Pay exactly *${usdt} USDT* to our Binance Pay ID:`,
      `   *${BINANCE_PAY.payId}*`,
      '',
      '   Coin: USDT (Binance Pay)',
      '',
      ...productLines,
      '',
      t('pay_eta', { eta: confirmEta() }, lang),
      '',
      'Payment karne ke baad apna *Binance Transaction ID* isi chat me type karein.',
      '❌ Screenshot ki zaroorat nahi.',
      '🙋 Koi masla ho toh *human* likhein.',
    ].join('\n'), { binance: true }),
    buttons: withNav([
      { id: 'change_payment', text: t('btn_change_payment', {}, lang) },
      { id: 'cancel_order', text: t('btn_cancel_order', {}, lang) },
    ]),
  });
  return true;
}

/**
 * Pull a Transaction ID out of whatever the customer typed.
 * Returns null when it does NOT look like one — the router then
 * keeps handling the message normally (commands, buttons, nudge),
 * so "menu" can never be mistaken for a payment.
 *
 * Binance Pay ids look like `M_P_71505104267788288`; pasted labels
 * ("Transaction ID: …") and surrounding punctuation are tolerated.
 */
export function extractTxId(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  // Only the OUTER punctuation is stripped — a whole sentence ("my txid
  // is …") must never collapse into one giant fake id.
  const bare = raw.replace(/^[^A-Za-z0-9_-]+|[^A-Za-z0-9_-]+$/g, '');
  // Whole message = the id. Needs a digit so plain words ("change",
  // "payment") never qualify, and >= 12 chars when it is all digits
  // so a phone number typed by mistake is not treated as one.
  if (/^[A-Za-z0-9_-]{8,64}$/.test(bare) && /\d/.test(bare)) {
    if (/^\d+$/.test(bare) && bare.length < 12) return null;
    return bare;
  }

  const labelled = raw.match(/(?:tx|txn|transaction)\s*(?:id)?\s*[:#=]?\s*([A-Za-z0-9_-]{8,64})/i);
  if (labelled && /\d/.test(labelled[1])) return labelled[1];

  return null;
}

/** Re-show the USDT screen (typed junk / resume / nudge). */
export async function repromptBinanceTx(sock, jid) {
  const lang = getLang(jid);
  const user = getUser(jid);
  const order = user.orderId ? getOrder(user.orderId) : null;
  if (!order || order.paymentId !== 'pay_binancepay') return sendPlans(sock, jid);
  if (['fulfilled', 'refunded', 'cancelled'].includes(order.status)) {
    return sendText(sock, jid,
      `✅ *${order.id}* ka payment pehle hi settle ho chuka hai (status: *${order.status}*) — *menu* likhein.`);
  }

  setUser(jid, { flow: 'await_binance_tx', orderId: order.id, choices: withNavChoices(SCREENSHOT_CHOICES) });
  saveSession(jid, { step: STEP_PAYMENT, orderId: order.id, selectedPlanId: order.planId, selectedProductId: order.productId });

  const isDigital = order.catalogType === 'digital';
  const productLines = order.catalogType === 'wallet_topup'
    ? ['💰 Wallet Top-up — balance me add hoga (USDT me pay karein)']
    : isDigital
      ? [`🛍️ ${order.planName}`, order.requiresEmailActivation ? '📧 Activation email: (aapka diya hua)' : '⚡ Instant delivery']
      : [`📊 ${order.data} • ${order.validity}`];

  await sendButtons(sock, jid, {
    title: `🎫 ${order.id} — Transaction ID chahiye`,
    text: withStep(STEP_PAYMENT, [
      `💳 Pay exactly *${usdtFigure(order)} USDT* to our Binance Pay ID:`,
      `   *${order.binance?.payId || BINANCE_PAY.payId}*`,
      '',
      '   Coin: USDT (Binance Pay)',
      '',
      ...productLines,
      '',
      'Apna *Binance Transaction ID* type karein — screenshot nahi chahiye.',
      '🙋 Koi masla ho toh *human* likhein.',
    ].join('\n'), { binance: true }),
    buttons: withNav([
      { id: 'change_payment', text: t('btn_change_payment', {}, lang) },
      { id: 'cancel_order', text: t('btn_cancel_order', {}, lang) },
    ]),
  });
  return true;
}

/**
 * The customer typed a Transaction ID. Answer IMMEDIATELY, then
 * verify in the background — the chat queue must never sit on a
 * five-minute retry loop.
 *
 * @returns {Promise<boolean>} false → not a transaction id, the
 * router should keep handling this message normally.
 */
export async function handleBinanceTx(sock, jid, text) {
  const txId = extractTxId(text);
  if (!txId) return false;

  const lang = getLang(jid);
  const user = getUser(jid);
  const order = user.orderId ? getOrder(user.orderId) : null;
  if (!order) {
    setUser(jid, { flow: null, orderId: null });
    return sendText(sock, jid, '❌ Pehle ek plan select karein. Menu kholne ke liye *menu* likhein.');
  }
  if (['fulfilled', 'refunded', 'cancelled'].includes(order.status)) {
    return sendText(sock, jid,
      `✅ *${order.id}* ka payment pehle hi settle ho chuka hai (status: *${order.status}*) — *menu* likhein.`);
  }

  // Same id typed twice while the first check is still running.
  if (order.binance?.txId === txId && isVerifying(order.id)) {
    return sendText(sock, jid, `⏳ *${txId}* already verify ho raha hai — thora sabr.`);
  }

  const stamp = now();
  order.binance = {
    ...(order.binance || {}),
    txId,
    expectedUsdt: expectedUsdt(order),
    rate: BINANCE_PAY.usdtPkrRate,
    payId: BINANCE_PAY.payId,
    submittedAt: stamp,
    checkedAt: null,
    verdict: null,
  };
  order.status = 'pending_admin';
  order.screenshot = null;
  order.reminderAt = Date.now() + SETTINGS.autoReminderMs;
  order.reminderSent = false;
  order.updatedAt = stamp;
  putOrder(order);
  flush();

  setUser(jid, { flow: 'pending_admin', choices: withNavChoices(PENDING_CHOICES) });
  saveSession(jid, { step: STEP_AWAITING, orderId: order.id });

  await sendButtons(sock, jid, {
    title: `🎫 ${order.id} — Transaction ID received`,
    text: withStep(STEP_AWAITING, [
      `✅ Transaction ID *${txId}* mil gaya.`,
      '',
      `🤖 Hum Binance par *${usdtFigure(order)} USDT* ka payment verify kar rahe hain.`,
      t('pay_eta', { eta: confirmEta() }, lang),
      '',
      `⏳ Order *${order.id}* — verification chal rahi hai, kuch hi der me jawab aa jayega.`,
    ].join('\n'), { binance: true }),
    buttons: withNav([
      { id: 'menu:orders', text: t('nav_orders', {}, lang) },
      { id: 'cancel_order', text: t('btn_cancel_order', {}, lang) },
    ]),
  });

  // Background: retry → claim → fulfil or hand to the admin.
  const run = runVerification(sock, order.id, txId);
  inFlight.set(order.id, run);
  run
    .catch((err) => { logError('binance.verify', err, { orderId: order.id, txId }); })
    .finally(() => { if (inFlight.get(order.id) === run) inFlight.delete(order.id); });
  return true;
}

// The verification running right now, keyed by order — the chat queue
// never waits on it, but tests/diagnostics can.
const inFlight = new Map();
export const pendingVerification = (orderId) => inFlight.get(String(orderId)) || null;

/**
 * Look the Transaction ID up, retry while Binance settles, then act
 * on the verdict:
 *   match + auto   → claim + confirmOrder (customer gets delivery)
 *   match + shadow → claim + admin card (admin confirms)
 *   anything else  → admin card with the reason (never fulfils)
 */
async function runVerification(sock, orderId, txId) {
  const order = getOrder(orderId);
  if (!order) return;

  const currentMode = binanceMode();
  if (currentMode === 'off' || !binanceReady()) {
    return binanceFallback(sock, orderId, txId, {
      status: currentMode === 'off' ? 'mode_off' : 'not_configured',
      detail: currentMode === 'off' ? 'BINANCE_VERIFIER_MODE=off' : 'BINANCE_API_KEY / BINANCE_API_SECRET missing',
    });
  }

  let verdict = await verifyWithRetry({
    order,
    txId,
    onProgress: async (kind) => {
      if (kind !== 'still') return;
      await sendText(sock, order.jid, '⏳ Still checking, hang tight… (Binance par payment dhundh rahe hain)').catch(() => {});
    },
  });
  auditVerdict(orderId, verdict, currentMode === 'auto' ? 'auto-binance-verifier' : 'shadow-binance-verifier');

  // 🧠 Part B — only the ambiguous verdicts reach the analyst (the
  // clean `match` and every hard mismatch are decided by code alone).
  // A model `approve` can only act when BOTH verifiers are in `auto`
  // AND it is a `time_window` case: the money, the currency and the
  // claim ledger were already proven right by the deterministic code.
  verdict = await consultAiBinance(orderId, verdict);

  if (verdict.status !== 'match') {
    if (['currency_mismatch', 'outgoing', 'amount_mismatch', 'time_window', 'already_claimed'].includes(verdict.status)) {
      recordVerdict('blocked');
    }
    return binanceFallback(sock, orderId, txId, verdict);
  }

  // Clean match — claim it atomically BEFORE any confirmation, so one
  // payment can never fulfil two orders.
  const claim = claimTransaction(txId, orderId, currentMode === 'auto' ? 'auto-binance-verifier' : 'shadow');
  if (!claim.ok) {
    return binanceFallback(sock, orderId, txId, {
      status: 'already_claimed',
      detail: `already used by ${claim.orderId}`,
      transaction: verdict.transaction,
    });
  }

  if (currentMode !== 'auto') {
    recordVerdict('shadow');
    return binanceFallback(sock, orderId, txId, verdict, {
      note: `🤖 Shadow mode — match ${usdtFigure(order)} USDT (BINANCE_VERIFIER_MODE=shadow). Confirm kar dein.`,
      customer: [
        `✅ Payment mil gaya — *${usdtFigure(order)} USDT* match ho gaya.`,
        '',
        '👀 Hamari team confirm kar rahi hai (auto-verification shadow mode me hai).',
        t('pay_eta', { eta: confirmEta() }, getLang(order.jid)),
      ].join('\n'),
    });
  }

  // ── auto mode: fulfil it ourselves ──────────────────────────
  recordVerdict('match');
  stampBinanceVerdict(orderId, verdict, currentMode);
  await sendText(sock, order.jid,
    `✅ *Payment verified* — *${usdtFigure(order)} USDT* confirm ho gaya. Order process ho raha hai…`)
    .catch(() => {});

  const res = await confirmOrder(sock, orderId, { actor: 'auto-binance-verifier' });
  const live = getOrder(orderId) || order;
  if (res?.ok) {
    appendAudit({
      actor: 'auto-binance-verifier',
      role: 'system',
      action: 'payment.auto_verified',
      target: orderId,
      detail: `Binance Pay ${txId} · ${verdict.transaction?.amount ?? ''} USDT`,
    });
    await notifyNewOrder(sock, live, null, {
      headline: `🤖 *AUTO-VERIFIED — ${orderId}*`,
      note: `💳 Binance Pay · tx \`${txId}\` · ${verdict.transaction?.amount ?? usdtFigure(order)} USDT · mode: auto`,
      hideImageWarning: true,
    });
    return;
  }

  // Auto-confirm could not complete (stock, supplier, …) — the
  // verification stands, the admin still has to press confirm.
  return binanceFallback(sock, orderId, txId, verdict, {
    note: `🤖 Auto-confirm failed: ${String(res?.message || 'unknown').slice(0, 160)}`,
    skipCustomer: true,
  });
}

/**
 * 🧠 Part B — the Binance side of the decision engine.
 *
 * Returns the verdict unchanged unless the analyst approved an
 * ambiguous `time_window` case AND both verifiers are in `auto`.
 * The claim ledger is still enforced afterwards, so a transaction
 * that another order already owns can never slip through.
 */
async function consultAiBinance(orderId, verdict) {
  if (AI_VERIFY.mode === 'off') return verdict;
  try {
    const order = getOrder(orderId);
    if (!order) return verdict;

    const result = await aiDecide({
      order,
      kind: 'binance',
      deterministic: verdict,
      evidence: {
        transaction: verdict?.transaction || null,
        candidates: [],
        submittedAt: order.binance?.submittedAt || null,
      },
    });
    if (!result) return verdict;

    stampAi(order, result);
    order.updatedAt = now();
    putOrder(order);
    flush();
    logOrder('ai_decision', order, {
      decision: result.decision,
      mode: result.mode,
      source: result.source,
      status: verdict?.status || null,
      flags: result.flags.join(','),
    });

    const mayUpgrade = result.mayAct
      && result.decision === 'approve'
      && verdict?.status === 'time_window'
      && binanceMode() === 'auto';
    if (!mayUpgrade) return verdict;

    return {
      ...verdict,
      status: 'match',
      detail: `${verdict.detail} · AI approved (${result.model})`,
      aiApproved: true,
    };
  } catch (err) {
    logError('ai.binance', err, { orderId });
    return verdict;
  }
}

/**
 * Persist the verdict onto the order BEFORE it is fulfilled, so the
 * admin card / 💳 screen can always show what the checker decided
 * (the shadow and failure paths stamp it inside binanceFallback).
 */
function stampBinanceVerdict(orderId, verdict, currentMode) {
  const live = getOrder(orderId);
  if (!live) return;
  live.binance = {
    ...(live.binance || {}),
    verdict: verdict?.status || null,
    detail: verdict?.detail || null,
    checkedAt: now(),
    mode: currentMode,
  };
  live.updatedAt = now();
  putOrder(live);
  flush();
}

/**
 * Hand the order to the admin with the verdict attached, and tell the
 * customer what happened. Used by EVERY non-auto path — one place to
 * keep the card, the reminder and the wording consistent.
 */
async function binanceFallback(sock, orderId, txId, verdict, opts = {}) {
  const order = getOrder(orderId);
  if (!order) return;

  const stamp = now();
  order.binance = {
    ...(order.binance || {}),
    txId,
    verdict: verdict?.status || null,
    detail: verdict?.detail || null,
    checkedAt: stamp,
    mode: binanceMode(),
  };
  order.status = 'pending_admin';
  order.updatedAt = stamp;
  order.reminderAt = Date.now() + SETTINGS.autoReminderMs;
  order.reminderSent = false;
  putOrder(order);
  flush();

  const amount = verdict?.transaction?.amount;
  const note = opts.note || `💳 Binance Pay · tx \`${txId}\` · ${amount !== undefined ? `${roundUsdtLabel(amount)} USDT` : usdtFigure(order)} · ${verdict?.status || 'unknown'}${verdict?.detail ? ` — ${verdict.detail}` : ''}`;
  await notifyNewOrder(sock, order, null, { note, hideImageWarning: true });
  armReminder(sock, order.id);

  if (opts.skipCustomer) return;
  await sendText(sock, order.jid, opts.customer || customerLineFor(verdict, order)).catch(() => {});
  return;
}

/** Money label for the admin note (keeps the 2-dp USDT convention). */
const roundUsdtLabel = (amount) => `${(Math.round((Number(amount) || 0) * 100) / 100).toFixed(2)}`;

/** The one customer-facing sentence per verdict. */
function customerLineFor(verdict, order) {
  const want = usdtFigure(order);
  switch (verdict?.status) {
    case 'timeout':
      return [
        `⏳ *${order.id}* — abhi tak Binance par payment nahi mili.`,
        '',
        'Transaction ID dobara check karein (ya galat paste ho gaya ho).',
        'Hamari team order par nazar rakh rahi hai — jaldi confirm ho jayega.',
      ].join('\n');
    case 'amount_mismatch':
      return [
        `❌ Amount match nahi hua — humein *${want} USDT* chahiye tha${verdict.detail ? `, mila: ${verdict.detail}` : ''}.`,
        '',
        'Order admin ke paas hai — *human* likhein toh hum baat karte hain.',
      ].join('\n');
    case 'already_claimed':
      return [
        `⚠️ Yeh Transaction ID (*${txLabel(verdict)}*) pehle kisi aur order par use ho chuki hai.`,
        '',
        'Agar aapne yeh payment kisi doosre order me ki thi toh *human* likhein.',
      ].join('\n');
    case 'currency_mismatch':
    case 'outgoing':
    case 'time_window':
      return [
        `❌ Yeh payment verify nahi ho saka (${verdict.status}).`,
        '',
        `Sirf *USDT* aur *${want} USDT* ke qareeb amount count hoti hai.`,
        'Order admin ke paas bhej diya gaya hai — *human* likhein toh hum check karte hain.',
      ].join('\n');
    case 'mode_off':
    case 'not_configured':
    case 'api_error':
    default:
      return [
        `⏳ *${order.id}* received — auto-verification abhi available nahi hai.`,
        '',
        'Aapka order admin ke paas hai, hum jald confirm kar denge.',
        t('pay_eta', { eta: confirmEta() }, getLang(order.jid)),
      ].join('\n');
  }
}

const txLabel = (verdict) => verdict?.transaction?.transactionId || 'tx';
