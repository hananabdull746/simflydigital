// ─────────────────────────────────────────────────────────────
// handlers/wallet.js
// 💰 Customer Wallet — the prepaid PKR balance customers can load
// once (money is verified AT TOP-UP TIME) and then spend at
// checkout with ONE tap, for both eSIM plans and Digital Store
// products. No screenshot / NayaPay wait at purchase time.
//
//   🏠 wallet home     balance + ➕ Add Money / 📜 History
//   ➕ top-up           quick amounts → EXISTING payment method
//                       flow (WTP-XXXX reference, tagged
//                       purpose "wallet_topup") → NayaPay verifier
//                       / admin 💰 Confirm Top-up
//   💰 pay from wallet  at the EXISTING payment-method step →
//                       atomic debit → straight to the supplier
//                       API (skip verification) → deliver
//   ↩️ refunds          any post-payment failure lands back here
//
// Rules:
//   • balance only ever moves through services/wallet.js
//     adjustBalance() — one atomic check-and-write
//   • the visible balance always equals the ledger sum
//   • top-up attempts are rate-limited per customer
// ─────────────────────────────────────────────────────────────
import { SETTINGS, formatPrice, jidUser, getPaymentMethod, PAYMENT_METHODS, BINANCE_PAY } from '../config.js';
import { sendButtons, sendList, sendText } from '../lib/ui.js';
import { withNav, withListNav, withNavChoices, LIST_NAV_CHOICES } from './ui.js';
import { STEP_PAYMENT, withStep } from '../lib/steps.js';
import { getLang } from '../lib/users.js';
import { t } from '../lib/lang.js';
import { getUser, setUser, putOrder, getOrder, nextOrderId, nextTopupId, flush } from '../lib/store.js';
import { saveSession, getSession } from '../lib/sessions.js';
import {
  adjustBalance, getBalance, ledgerFor, recordTopupAttempt, topupAllowed, totalLiability,
} from '../services/wallet.js';
import { paymentChoices, SCREENSHOT_CHOICES } from './payments.js';
import { confirmOrder } from './orders.js';
import { sendOrderCard } from './adminPanel.js';
import { allAdminJids } from '../lib/admins.js';
import { discountFor, redeemSale } from '../lib/sales.js';
import { checkoutItem } from './checkout.js';
import { refundToWallet } from './digitalStore.js';
import { expectedUsdt } from '../services/binanceVerifier.js';
import { logOrder, logError } from '../lib/logger.js';

const now = () => new Date().toISOString();

const QUICK_AMOUNTS = [500, 1000, 2000, 5000];

const TX_LABEL = {
  topup: '➕ Top-up',
  order_payment: '🛒 Order payment',
  refund: '↩️ Refund',
  admin_adjustment: '✏️ Admin adjustment',
};

// ── 1. Wallet home ────────────────────────────────────────────
export async function sendWallet(sock, jid) {
  const lang = getLang(jid);
  if (!SETTINGS.walletEnabled) {
    return sendText(sock, jid, '💰 Wallet abhi disabled hai (WALLET_ENABLED=false).');
  }
  const balance = getBalance(jidUser(jid));

  const own = [
    { id: 'wallet_add', label: '➕ Add Money', keywords: ['add', 'topup', 'top up', 'deposit', 'paise'] },
    { id: 'wallet_history', label: '📜 Transaction History', keywords: ['history', 'transactions', 'ledger', 'statements'] },
    { id: 'back_menu', label: '🏠 Main Menu', keywords: ['menu', 'home', 'main menu'] },
  ];
  const choices = withNavChoices(own);
  setUser(jid, { flow: 'wallet_home', choices });

  await sendButtons(sock, jid, {
    title: '💰 My Wallet',
    text: [
      `💰 Available balance: *${formatPrice(balance)}*`,
      '',
      'Wallet se payment karein toh screenshot/verification ka wait nahi — order foran process hota hai.',
      balance > 0 ? '' : '➕ Add Money karke apna balance load karein.',
    ].filter(Boolean).join('\n'),
    buttons: choices.map((c) => ({ id: c.id, text: c.label })),
  });
  return true;
}

export async function showWalletHistory(sock, jid, limit = 15) {
  const customerId = jidUser(jid);
  const rows = ledgerFor(customerId, limit).map((tx) => ({
    id: 'wallet_home',
    title: `${tx.amountPkr >= 0 ? '🟢 +' : '🔴 '}${formatPrice(Math.abs(tx.amountPkr))} — ${TX_LABEL[tx.type] || tx.type}`,
    description: `${new Date(tx.createdAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}${tx.relatedOrderId ? ` · ${tx.relatedOrderId}` : ''}`,
    keywords: [String(tx.type)],
  }));

  if (rows.length === 0) {
    const own = [
      { id: 'wallet_add', label: '➕ Add Money', keywords: ['add', 'topup', 'deposit'] },
      { id: 'wallet_home', label: '⬅️ Back to Wallet', keywords: ['back', 'wallet'] },
    ];
    const choices = withNavChoices(own);
    setUser(jid, { flow: 'wallet_home', choices });
    return sendButtons(sock, jid, {
      title: '📜 Wallet History',
      text: 'Abhi tak koi transaction nahi hai.',
      buttons: choices.map((c) => ({ id: c.id, text: c.label })),
    });
  }

  setUser(jid, { flow: 'wallet_home', choices: withNavChoices([
    { id: 'wallet_home', label: '⬅️ Back to Wallet', keywords: ['back', 'wallet'] },
    { id: 'back_menu', label: '🏠 Main Menu', keywords: ['menu', 'home'] },
  ]) });

  await sendList(sock, jid, {
    title: `📜 Wallet History (₹${formatPrice(getBalance(customerId))} balance)`.replace('₹', ''),
    buttonText: 'Transaction',
    text: `Balance: *${formatPrice(getBalance(customerId))}*\nHar entry ledger se aati hai — balance hamesha in ka sum hota hai.`,
    sections: withListNav([{ title: 'Transactions', rows }], { include: ['menu'] }),
  });
  return true;
}

// ── 2. Add money ──────────────────────────────────────────────
export async function startTopup(sock, jid, opts = {}) {
  if (!SETTINGS.walletEnabled) return sendText(sock, jid, '💰 Wallet abhi disabled hai.');
  const customerId = jidUser(jid);

  if (!opts.skipGuard && !topupAllowed(customerId, SETTINGS.walletTopupMaxAttempts, SETTINGS.walletTopupWindowMs)) {
    return sendButtons(sock, jid, {
      title: '⏳ Thora ruk kar',
      text: `Aap zyada top-up attempts kar chuke hain — ${Math.round(SETTINGS.walletTopupWindowMs / 60000)} minute baad dobara try karein.`,
      buttons: withNav([{ id: 'wallet_home', text: '⬅️ Back to Wallet' }]),
    });
  }
  if (!opts.skipGuard) recordTopupAttempt(customerId);

  // Chained from an under-funded checkout: keep the pending order
  // alive so the flow resumes at the payment step automatically.
  if (opts.shortfall) {
    const target = Math.min(
      SETTINGS.walletTopupMax,
      Math.max(SETTINGS.walletTopupMin, Math.ceil(Number(opts.shortfall) / 100) * 100)
    );
    // Without this marker resumeCheckoutAfterTopup() never fires —
    // the customer would sit on the top-up's screenshot step forever
    // and the bot would keep asking for a SadaPay screenshot after
    // the money had already been credited.
    saveSession(jid, { resumeAfterTopup: true, step: STEP_PAYMENT });
    return askTopupAmount(sock, jid, { suggested: target });
  }

  return askTopupAmount(sock, jid, opts);
}

async function askTopupAmount(sock, jid, opts = {}) {
  const lang = getLang(jid);
  const rows = QUICK_AMOUNTS.map((a) => ({
    id: `wallet_amount:${a}`,
    title: formatPrice(a),
    description: a === opts.suggested ? '👉 Suggested (order ke liye)' : 'Tap to select',
    keywords: [String(a)],
  }));
  rows.push({
    id: 'wallet_custom',
    title: '✏️ Custom Amount',
    description: `Min ${formatPrice(SETTINGS.walletTopupMin)} · Max ${formatPrice(SETTINGS.walletTopupMax)}`,
    keywords: ['custom', 'own', 'other'],
  });

  setUser(jid, { flow: 'wallet_topup_amount', choices: withNavChoices([
    { id: 'wallet_home', label: '⬅️ Back to Wallet', keywords: ['back', 'wallet'] },
    { id: 'back_menu', label: '🏠 Main Menu', keywords: ['menu', 'home'] },
  ]) });

  await sendList(sock, jid, {
    title: '➕ Add Money',
    buttonText: 'Select amount',
    text: [
      opts.suggested ? `⚠️ Aapka order ${formatPrice(opts.suggested)} ke qareeb hai — kam se kam itna load karein.` : 'Amount choose karein:',
      '',
      `Min ${formatPrice(SETTINGS.walletTopupMin)} · Max ${formatPrice(SETTINGS.walletTopupMax)} per top-up`,
    ].join('\n'),
    sections: [{ title: 'Amounts', rows }],
  });
  return true;
}

/** Typed custom amount (flow = wallet_topup_custom). */
export async function handleTopupAmountText(sock, jid, text) {
  const amount = Number(String(text).replace(/[^\d.]/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) {
    return sendText(sock, jid, '❌ Sirf amount type karein — e.g. `1500`.');
  }
  if (amount < SETTINGS.walletTopupMin || amount > SETTINGS.walletTopupMax) {
    return sendText(sock, jid,
      `❌ Amount ${formatPrice(SETTINGS.walletTopupMin)} se ${formatPrice(SETTINGS.walletTopupMax)} ke darmiyan hona chahiye.`);
  }
  return askTopupMethod(sock, jid, Math.round(amount));
}

async function askTopupMethod(sock, jid, amount) {
  const lang = getLang(jid);
  const choices = paymentChoices();
  if (choices.length === 0) {
    return sendText(sock, jid, '⚠️ Koi payment method configured nahi hai — admin ko .env setup karna hoga.');
  }

  // Remember the amount across the method tap.
  setUser(jid, {
    flow: 'wallet_topup_method',
    topupAmount: amount,
    choices: withNavChoices([
      ...choices,
      { id: 'wallet_home', label: '⬅️ Back to Wallet', keywords: ['back', 'wallet'] },
    ]),
  });

  // A single configured method skips the question (same as orders).
  if (choices.length === 1) return sendTopupDetails(sock, jid, choices[0].id);

  await sendButtons(sock, jid, {
    title: '➕ Add Money',
    text: [
      `💰 Amount: *${formatPrice(amount)}*`,
      '',
      'Payment method choose karein — account details foran mil jayenge.',
      `⏱️ ${t('pay_eta', { eta: 'within 15 mins' }, lang)}`,
    ].join('\n'),
    buttons: withNav(PAYMENT_METHODS.map((m) => ({ id: m.id, text: `${m.icon} ${m.label}` }))),
  });
  return true;
}

/** Step: account details + a WTP reference (top-ups never use SMF ids). */
export async function sendTopupDetails(sock, jid, paymentId) {
  const lang = getLang(jid);
  const method = getPaymentMethod(paymentId);
  const user = getUser(jid);
  const amount = Number(user.topupAmount) || 0;
  if (!method) return sendText(sock, jid, '❌ Invalid payment method.');
  if (!amount) return askTopupAmount(sock, jid);

  const refId = user.topupRef || nextTopupId();
  // 💳 Binance Pay: the customer owes USDT and answers with a
  //    Transaction ID — no screenshot step for this method.
  const isBinance = method.id === 'pay_binancepay';
  setUser(jid, {
    flow: isBinance ? 'await_binance_tx' : 'await_screenshot',
    orderId: refId,
    choices: isBinance ? withNavChoices(SCREENSHOT_CHOICES) : null,
  });
  saveSession(jid, { step: STEP_PAYMENT, orderId: refId });

  putOrder({
    id: refId,
    jid,
    phone: jidUser(jid),
    name: user.pushName || null,
    catalogType: 'wallet_topup',
    planId: null,
    planName: 'Wallet Top-up',
    productId: null,
    data: null,
    validity: null,
    price: amount,
    discount: null,
    paymentId: method.id,
    paymentLabel: method.label,
    // 💳 Pay-in details for the USDT flow (null for every other method).
    binance: isBinance
      ? {
        txId: null,
        expectedUsdt: expectedUsdt({ price: amount }),
        rate: BINANCE_PAY.usdtPkrRate,
        payId: BINANCE_PAY.payId,
        verdict: null,
        checkedAt: null,
      }
      : null,
    paidBy: null,
    purpose: 'wallet_topup',
    status: 'await_screenshot',
    screenshot: null,
    note: '',
    supplierOrderId: null,
    prodsellerOrderId: null,
    reminderAt: null,
    reminderSent: false,
    createdAt: now(),
    updatedAt: now(),
  });
  flush();
  logOrder('topup_created', { id: refId, status: 'await_screenshot', catalogType: 'wallet_topup' }, { amount });

  // 💳 Binance Pay: USDT figure + our Pay ID, "type your Transaction
  //    ID" — never a PKR line, never a screenshot.
  if (isBinance) {
    const usdt = `${expectedUsdt({ price: amount }).toFixed(2)}`;
    await sendButtons(sock, jid, {
      title: `➕ Wallet Top-up ${refId}`,
      text: withStep(STEP_PAYMENT, [
        t('det_id', { id: refId }, lang),
        '',
        `💳 Pay exactly *${usdt} USDT* to our Binance Pay ID:`,
        `   *${BINANCE_PAY.payId}*`,
        '',
        '   Coin: USDT (Binance Pay)',
        '',
        'Payment karne ke baad apna *Binance Transaction ID* isi chat me type karein.',
        '❌ Screenshot ki zaroorat nahi.',
        `⏱️ ${t('pay_eta', { eta: 'within 15 mins' }, lang)}`,
        '🙋 Koi masla ho toh *human* likhein.',
      ].join('\n'), { binance: true }),
      buttons: withNav([
        { id: 'change_topup_payment', text: t('btn_change_payment', {}, lang) },
        { id: 'wallet_home', text: '⬅️ Cancel top-up' },
      ]),
    });
    return true;
  }

  await sendButtons(sock, jid, {
    title: `➕ Wallet Top-up ${refId}`,
    text: withStep(STEP_PAYMENT, [
      t('det_id', { id: refId }, lang),
      '',
      `💰 Amount to add: *${formatPrice(amount)}*`,
      t('det_pay', { v: method.label }, lang),
      ...method.details.map((line) => `   ${line}`),
      '',
      t('det_do', {}, lang),
      'Screenshot bhejein ya Transaction ID type karein.',
      `⏱️ ${t('pay_eta', { eta: 'within 15 mins' }, lang)}`,
    ].join('\n')),
    buttons: withNav([
      { id: 'change_topup_payment', text: t('btn_change_payment', {}, lang) },
      { id: 'wallet_home', text: '⬅️ Cancel top-up' },
    ]),
  });
  return true;
}

/** 💰 Confirm Top-up (admin card action lives in adminPanel). */
export async function creditTopup(sock, orderId, actor = 'admin') {
  const order = getOrder(orderId);
  if (!order) return { ok: false, message: `Order *${orderId}* nahi mila.` };
  if (order.status === 'fulfilled') return { ok: false, message: `*${orderId}* pehle hi credit ho chuka hai ✅` };

  const res = await adjustBalance(order.jid ? jidUser(order.jid) : order.phone, order.price, 'topup', {
    relatedOrderId: order.id,
    note: `wallet top-up via ${order.paymentLabel}`,
    actor,
  });
  if (!res.ok) return { ok: false, message: `❌ Top-up credit fail (${res.code}).` };

  order.status = 'fulfilled';
  order.paidBy = 'topup';
  order.walletCredited = true;
  order.confirmedBy = actor;
  order.confirmedAt = now();
  order.actionVersion = (order.actionVersion || 0) + 1;
  order.updatedAt = now();
  putOrder(order);
  flush();
  logOrder('topup_credited', { id: order.id, status: order.status }, { amount: order.price, balance: res.balance });

  const lang = getLang(order.jid);
  try {
    await sendButtons(sock, order.jid, {
      title: '✅ Wallet updated',
      text: [
        `✅ *${formatPrice(order.price)}* added! New balance: *${formatPrice(res.balance)}*`,
        '',
        'Ab aap wallet se seedha payment kar sakte hain — bina screenshot ke.',
      ].join('\n'),
      buttons: withNav([
        { id: 'wallet_home', text: '🛍️ Start Shopping' },
        { id: 'menu:plans', text: t('nav_plans', {}, lang) },
      ]),
    });
  } catch (err) {
    logError('wallet.topup.notice', err, { orderId });
  }

  // Top-up chained from an under-funded checkout resumes right here.
  // When there is nothing to resume (top-up started from the wallet
  // screen, session expired, cart cleared) the customer must still be
  // released from this top-up's "send screenshot" step — otherwise
  // every later message is answered with "screenshot chahiye" for an
  // order that is already credited.
  const resumed = await resumeCheckoutAfterTopup(sock, order.jid);
  if (!resumed) releaseTopupState(order.jid, order.id);
  return { ok: true, message: `✅ *${orderId}* — ${formatPrice(order.price)} credited (balance ${formatPrice(res.balance)}).` };
}

/**
 * Drop every trace of a decided top-up (credited / rejected) from the
 * customer's screen state. Only touches state that still points at
 * THIS top-up, so an unrelated checkout is never disturbed.
 */
function releaseTopupState(jid, topupId) {
  if (!jid || !topupId) return;
  const user = getUser(jid);
  if (user.orderId === topupId) {
    setUser(jid, { orderId: null, flow: 'wallet_home', choices: null });
  }
  const session = getSession(jid);
  if (session && session.orderId === topupId) {
    saveSession(jid, { step: null, orderId: null, resumeAfterTopup: false });
  }
}

export async function rejectTopup(sock, orderId, reason, actor = 'admin') {
  const order = getOrder(orderId);
  if (!order) return { ok: false, message: `Order *${orderId}* nahi mila.` };
  order.status = 'rejected';
  order.note = reason || 'Top-up not verified';
  order.rejectedBy = actor;
  order.rejectedAt = now();
  order.actionVersion = (order.actionVersion || 0) + 1;
  order.updatedAt = now();
  putOrder(order);
  flush();
  releaseTopupState(order.jid, order.id);
  try {
    await sendButtons(sock, order.jid, {
      title: `🚫 Top-up ${order.id} rejected`,
      text: `Aapka top-up verify nahi ho saka (${order.note}). Koi masla ho toh *support* likhein.`,
      buttons: withNav([{ id: 'wallet_home', text: '⬅️ Back to Wallet' }]),
    });
  } catch (err) {
    logError('wallet.topup.reject', err, { orderId });
  }
  return { ok: true, message: `🚫 *${orderId}* rejected.` };
}

/** Re-pick the method for an in-flight top-up (same amount, same WTP id). */
export async function changeTopupPayment(sock, jid) {
  const user = getUser(jid);
  if (!user.topupAmount) return startTopup(sock, jid);
  return askTopupMethod(sock, jid, Number(user.topupAmount));
}

/** Resume helper used by the router's wallet_amount:<N> rows. */
export { askTopupMethod as askTopupMethodPublic };
export async function resumeCheckoutAfterTopup(sock, jid) {
  const session = getSession(jid);
  if (!session || !session.resumeAfterTopup) return false;
  if (!session.selectedPlanId && !session.selectedProductId) return false;

  saveSession(jid, { step: STEP_PAYMENT, resumeAfterTopup: false, orderId: null });
  setUser(jid, { orderId: null });
  const { askPaymentMethod } = await import('./payments.js');
  try {
    await sendText(sock, jid, '✅ Wallet balance ab kaafi hai — wapas checkout par chalte hain.');
    await askPaymentMethod(sock, jid);
    return true;
  } catch (err) {
    logError('wallet.resume', err, { jid });
    return false;
  }
}

// ── 3. Pay from wallet (checkout integration) ────────────────
/**
 * Balance + shortfall facts for the payment-method screen.
 * `payable` is AFTER the discount (🎟️ sale code / loyalty), so the
 * wallet path always charges exactly what the screenshot path asks for.
 */
export async function walletCheckoutInfo(jid) {
  if (!SETTINGS.walletEnabled) return { enabled: false, balancePkr: 0, item: null };
  const item = await checkoutItem(jid);
  const balancePkr = getBalance(jidUser(jid));
  const disc = item
    ? discountFor(jid, { catalog: item.catalog, pricePkr: item.price })
    : null;
  const payable = item ? item.price - (disc?.amount || 0) : 0;
  return {
    enabled: true,
    balancePkr,
    item,
    disc,
    payable,
    shortfallPkr: item ? Math.max(0, payable - balancePkr) : 0,
    enough: item ? balancePkr >= payable : false,
  };
}

export async function payFromWallet(sock, jid) {
  const info = await walletCheckoutInfo(jid);
  if (!info.enabled || !info.item) return sendText(sock, jid, '❌ Checkout state nahi mila — *menu* likhein.');

  if (!info.enough) {
    const own = [
      { id: `wallet_short:${info.shortfallPkr}`, label: `➕ Top Up ${formatPrice(info.shortfallPkr)} & Continue`, keywords: ['topup', 'add', 'continue'] },
      { id: 'change_payment', label: '💳 Pay with screenshot instead', keywords: ['screenshot', 'other', 'payment'] },
      { id: 'cancel_order', label: t('btn_cancel_order', {}, getLang(jid)), keywords: ['cancel'] },
    ];
    const choices = withNavChoices(own);
    setUser(jid, { flow: 'choose_payment', choices });
    await sendButtons(sock, jid, {
      title: '💰 Wallet balance kam hai',
      text: [
        `💰 Wallet: *${formatPrice(info.balancePkr)}* (not enough)`,
        `🧾 Order total: ${formatPrice(info.item.price)}`,
        info.disc ? `🎟️ Code *${info.disc.code}*: −${formatPrice(info.disc.amount)}` : null,
        `➕ Shortfall: *${formatPrice(info.shortfallPkr)}*`,
      ].filter(Boolean).join('\n'),
      buttons: choices.map((c) => ({ id: c.id, text: c.label })),
    });
    return true;
  }

  const after = info.balancePkr - info.payable;
  const needsApproval = info.payable > SETTINGS.confirmTwiceAbove;
  const own = [
    { id: 'wallet_pay_confirm', label: '✅ Confirm', keywords: ['yes', 'confirm', 'pay', 'haan'] },
    { id: 'change_payment', label: '⬅️ Back', keywords: ['back', 'change', 'payment'] },
  ];
  const choices = withNavChoices(own);
  setUser(jid, { flow: 'wallet_pay_confirm', choices });

  await sendButtons(sock, jid, {
    title: '💰 Pay from Wallet',
    text: [
      info.disc
        ? `🧾 ${formatPrice(info.item.price)} − ${formatPrice(info.disc.amount)} (*${info.disc.code}* ${info.disc.percent}% off)`
        : `🛍️ ${info.item.name}`,
      `Pay *${formatPrice(info.payable)}* from wallet?`,
      `Balance after: *${formatPrice(after)}*`,
      '',
      `🛍️ ${info.item.name}`,
      needsApproval
        ? `\n⚠️ High-value order (${formatPrice(info.payable)} > ${formatPrice(SETTINGS.confirmTwiceAbove)}) — admin ki ek quick ✅ ke baad supplier ko order jayega.`
        : '\n⚡ Confirm karte hi supplier ko order chala diya jayega — koi screenshot/screenshot wait nahi.',
    ].join('\n'),
    buttons: choices.map((c) => ({ id: c.id, text: c.label })),
  });
  return true;
}

/**
 * THE one-tap payment: atomic debit → order record → supplier API.
 * Runs inside the wallet mutex via adjustBalance, so a double-tap
 * can only deduct ONCE (the second tap finds the order already
 * created and short-circuits).
 */
export async function confirmWalletPay(sock, jid) {
  const user = getUser(jid);
  const item = await checkoutItem(jid);
  if (!item) return sendText(sock, jid, '❌ Checkout state nahi mila — *menu* likhein.');

  const customerId = jidUser(jid);
  const existing = user.orderId ? getOrder(user.orderId) : null;
  // Double-tap guard: an order that already holds this customer's
  // wallet money is never charged a second time — at ANY step of
  // fulfilment (pending_admin, awaiting_activation, …), not just the
  // first one.
  const moneyHeld = existing
    && existing.jid === jid
    && existing.paidBy === 'wallet'
    && !['refunded', 'cancelled', 'failed', 'rejected'].includes(existing.status);
  if (moneyHeld) {
    // The first tap already took the money.
    return sendText(sock, jid, `⏳ *${existing.id}* pehle se process ho raha hai.`);
  }

  // Re-read the balance right before debiting (the confirm screen
  // may be minutes old). Discount (🎟️ sale code / loyalty) is part
  // of the payable amount — one resolver for both payment paths.
  const disc = discountFor(jid, { catalog: item.catalog, pricePkr: item.price });
  const payable = item.price - (disc?.amount || 0);
  const balance = getBalance(customerId);
  if (balance < payable) {
    return payFromWallet(sock, jid);
  }

  // Reuse only THIS checkout's own in-flight order. A top-up
  // reference (WTP-xxxx) left behind by an Add Money flow must never
  // become the purchase's Order ID — it would overwrite the record
  // that proves the wallet credit.
  const reusable = existing
    && existing.jid === jid
    && existing.catalogType !== 'wallet_topup'
    && ['await_screenshot', 'pending_admin'].includes(existing.status);
  const orderId = reusable ? existing.id : nextOrderId();
  const order = buildWalletOrder(jid, orderId, item, disc, payable);

  // 1. Atomic check-and-deduct (rejects a would-be negative balance).
  const debit = await adjustBalance(customerId, -payable, 'order_payment', {
    relatedOrderId: orderId,
    note: disc
      ? `${item.name} (${item.catalog}) −${disc.code} ${disc.percent}%`
      : `${item.name} (${item.catalog})`,
  });
  if (!debit.ok) {
    return sendText(sock, jid, debit.code === 'INSUFFICIENT_FUNDS'
      ? '❌ Wallet balance kam ho gaya — dobara check karein.'
      : `❌ Wallet payment fail (${debit.code}).`);
  }

  // 2. Order is now PAID — record it and go straight to fulfilment.
  order.status = 'pending_admin';
  order.paidBy = 'wallet';
  order.walletDebitTx = debit.tx?.id || null;
  order.createdAt = order.createdAt || now();
  order.updatedAt = now();
  putOrder(order);
  // Burn one use of an admin sale code (loyalty codes are consumed
  // on delivery in handlers/reviews.js).
  if (disc?.source === 'sale') redeemSale(disc.code);
  flush();
  setUser(jid, {
    flow: 'pending_admin',
    orderId,
    dpId: item.catalog === 'digital' ? item.id : null,
    planId: item.catalog === 'esim' ? item.id : null,
    choices: withNavChoices([
      { id: 'menu:orders', label: '📦 Track My Order', keywords: ['orders', 'status', 'track'] },
      { id: 'cancel_order', label: '⛔ Cancel Order', keywords: ['cancel', 'order cancel'] },
      { id: 'back_menu', label: '⬅️ Back to Menu', keywords: ['menu', 'back', 'home'] },
    ]),
  });
  saveSession(jid, { step: null, orderId });
  logOrder('paid_from_wallet', { id: orderId, status: 'pending_admin', catalogType: item.catalog }, { amount: payable, balance: debit.balance });

  const needsApproval = payable > SETTINGS.confirmTwiceAbove;
  if (needsApproval) {
    // High-value safeguard: money is safe in the order, one admin ✅
    // releases the supplier call (same threshold as CONFIRM_TWICE_ABOVE_PKR).
    await notifyAdminsForWalletOrder(sock, order);
    await sendButtons(sock, jid, {
      title: `⏳ ${orderId} — payment received`,
      text: [
        `✅ *${formatPrice(payable)}* aapke wallet se cut gaya hai.`,
        disc ? `🎟️ Code *${disc.code}* — ${disc.percent}% OFF (-${formatPrice(disc.amount)})` : null,
        '',
        `⚠️ High-value order hai — admin ek quick confirm karega, phir foran process hoga.`,
        `⏱️ Usually confirmed within 15 mins.`,
      ].filter(Boolean).join('\n'),
      buttons: withNav([
        { id: 'menu:orders', text: t('nav_orders', {}, getLang(jid)) },
        { id: 'cancel_order', text: t('btn_cancel_order', {}, getLang(jid)) },
      ]),
    });
    return { ok: true, message: `💰 *${orderId}* wallet se paid — admin confirmation pending.` };
  }

  // 3. Auto path: supplier call immediately (this is the whole point
  //    of the wallet — no verification wait).
  const res = await confirmOrder(sock, orderId, { actor: 'wallet-auto' });
  return res;
}

function buildWalletOrder(jid, orderId, item, disc = null, payable = item.price) {
  const user = getUser(jid);
  return {
    id: orderId,
    jid,
    phone: jidUser(jid),
    name: user.pushName || null,
    catalogType: item.catalog,
    planId: item.catalog === 'esim' ? item.id : null,
    planName: item.name,
    productId: item.catalog === 'digital' ? item.id : null,
    quantity: item.catalog === 'digital' ? (item.quantity || 1) : 1,
    activationEmail: item.activationEmail || user.activationEmail || null,
    requiresEmailActivation: Boolean(item.requiresEmailActivation),
    data: item.data || null,
    validity: item.validity || null,
    price: item.price,
    discount: disc
      ? { code: disc.code, percent: disc.percent, amount: disc.amount, source: disc.source }
      : null,
    paidAmount: payable,
    paymentId: 'wallet',
    paymentLabel: '💰 Wallet',
    paidBy: 'wallet',
    status: 'pending_admin',
    screenshot: null,
    note: '',
    supplierOrderId: null,
    prodsellerOrderId: null,
    reminderAt: null,
    reminderSent: false,
    createdAt: now(),
    updatedAt: now(),
  };
}

async function notifyAdminsForWalletOrder(sock, order) {
  const targets = allAdminJids().length ? allAdminJids() : [];
  for (const target of targets) {
    try {
      await sendOrderCard(sock, target, order, {
        note: '💰 Paid from WALLET — no screenshot needed. Ek ✅ se supplier ko order chala diya jayega.',
      });
    } catch (err) {
      logError('wallet.admin_notice', err, { orderId: order.id, target });
    }
  }
}

// ── 4. Refund entry point (walrefund:<orderId>) ───────────────
export async function refundOrderToWallet(sock, jid, orderId) {
  const order = getOrder(String(orderId || '').toUpperCase());
  if (!order) return sendText(sock, jid, '❌ Order nahi mila.');
  if (order.jid && order.jid !== jid && !allAdminJids().includes(jid)) {
    return sendText(sock, jid, '❌ Yeh order aapka nahi hai.');
  }
  if (order.refundedVia === 'wallet' || order.status === 'refunded') {
    return sendText(sock, jid, `✅ *${order.id}* pehle hi wallet me refund ho chuka hai.`);
  }
  if (order.paidBy === 'wallet') {
    return refundToWallet(sock, order, 'customer requested refund');
  }
  return refundToWallet(sock, order, 'customer requested refund (screenshot-paid)');
}

/** Admin/diagnostic view of total wallet liability. */
export function liabilityLabel() {
  return formatPrice(totalLiability());
}

export { TX_LABEL };
