// ─────────────────────────────────────────────────────────────
// handlers/adminPanel.js
// PART 1 of the admin system: the in-WhatsApp admin panel.
//
//   🛠️ Admin Panel        one LIST, pending-count badge
//   🔔 Pending Orders     list + one card per order
//   📊 Today's Stats      orders / delivered / revenue / profit
//   🔍 Find Order         id, number or name
//   📦 Plans & Prices     -> handlers/adminPlans.js
//   💳 Payments           parsed NayaPay emails + verifier status
//   ⭐ Reviews            channel broadcast controls (compliance)
//   📢 Broadcast          -> handlers/adminBroadcast.js
//   🚫 Blocklist          blocked customers get NO replies
//   ⚙️ Bot Settings       maintenance / verifier / quiet hours
//   🌐 Dashboard          DASHBOARD_URL (no dashboard ships with
//                         the bot, so this row just explains that)
//
// Rules that apply everywhere in here:
//   • identity = sender JID number ONLY (lib/admins roles)
//   • non-admins never see any of this (router gate)
//   • every action lands in db/audit.json
//   • every screen has ⬅️ Admin Menu + 🏠 Exit Admin
//   • button ids carry the order id + version so a stale tap can
//     never confirm/reject an order twice
// ─────────────────────────────────────────────────────────────
import { ADMIN_JID, BRAND, SETTINGS, formatPrice, jidUser, toJid } from '../config.js';
import { sendButtons, sendList, sendText, shouldUsePlain } from '../lib/ui.js';
import {
  allOrders, flush, getOrder, getUser, pendingOrders, putOrder, setUser,
} from '../lib/store.js';
import { confirmOrder, rejectOrder, resendEsim } from './orders.js';
import { sendWelcome } from './menu.js';
import { setHuman } from '../lib/sessions.js';
import { armHumanExpiry } from './human.js';
import { getLang } from '../lib/users.js';
import { matchChoice } from '../lib/message.js';
import { getPlan } from '../lib/plans.js';
import { withAck, BUTTON_LIMIT } from './ui.js';
import {
  adminName, allAdminJids, appendAudit, blockJid, getSettings, isBlocked,
  roleFor, setSettings, unblockJid, allBlocked,
} from '../lib/admins.js';
import {
  autoCheck, autoCheckLabel, linkPayment, recentPayments, scanInbox, scanStatus, unclaimedPayments,
} from '../services/verifier.js';
import {
  mode as binanceMode, recentTransactions as recentBinanceTx, rescan as binanceRescan,
  storeStatus as binanceStoreStatus, usdtLabel,
} from '../services/binanceVerifier.js';
import { allReviews, updateReview } from '../lib/reviews.js';
import { cardLine as aiCardLine } from '../services/ai/paymentDecisionEngine.js';
import { postToChannel } from '../lib/channel.js';
import { logAdmin, logError } from '../lib/logger.js';
import { applyPrice, handlePlansId, openPlans } from './adminPlans.js';
import { composeBroadcast, handleBroadcastId, openBroadcast, attachBroadcastImage } from './adminBroadcast.js';
import { openTeam, handleTeamId, openComms, handleCommsId, handleTeamInput } from './adminTeam.js';
import { openStoreAdmin, handleStoreId, handleStoreInput } from './adminDigital.js';
import { handleSalesId, handleSalesInput } from './adminSales.js';
import { openWalletAdmin, handleWalletId, handleWalletInput } from './adminWallet.js';
import { getBalances, supplierLabel } from '../services/productCatalog.js';
import { totalLiability } from '../services/wallet.js';
import { dashboardUrl } from '../dashboard/server.js';

// ── small helpers ─────────────────────────────────────────────
const PKT = { timeZone: 'Asia/Karachi' };

/** First 5 + last 3 only — full numbers never go into admin cards. */
export function maskPhone(phone) {
  const s = String(phone || '').replace(/\D/g, '');
  if (s.length <= 6) return phone ? String(phone) : '—';
  return `+${s.slice(0, 5)}${'*'.repeat(Math.max(3, s.length - 8))}${s.slice(-3)}`;
}

/** Human age of an order ("4m", "2h 10m", "3d"). */
export function ageLabel(createdAt, at = Date.now()) {
  const ms = Math.max(0, at - new Date(createdAt || at).getTime());
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ${min % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

const stamp = (iso) =>
  new Date(iso).toLocaleString('en-GB', { ...PKT, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

const STATUS_TEXT = {
  await_screenshot: '⏳ awaiting screenshot',
  awaiting_screenshot: '⏳ awaiting screenshot',
  pending_admin: '⏳ awaiting confirmation',
  awaiting_supplier_funding: '🟠 awaiting supplier funding',
  awaiting_activation: '📧 awaiting activation key',
  refunded: '↩️ refunded to wallet',
  fulfilled: '✅ delivered',
  rejected: '❌ rejected',
  cancelled: '⛔ cancelled',
};

const STATUS_TAP = {
  pending_admin: 'confirmation',
  awaiting_supplier_funding: 'confirmation',
  awaiting_activation: 'confirmation',
  fulfilled: 'delivered',
  rejected: 'rejected',
  cancelled: 'cancelled',
};

// One confirmation/rejection at a time per order (no double delivery).
const locks = new Set();

/** Navigation that every admin screen carries. */
export function adminNav(buttons = []) {
  const out = (buttons || []).map((b) => ({ ...b }));
  const has = (id) => out.some((b) => b.id === id);
  if (!has('adm:menu') && out.length < BUTTON_LIMIT) out.push({ id: 'adm:menu', text: '⬅️ Admin Menu' });
  if (!has('adm:exit') && out.length < BUTTON_LIMIT) out.push({ id: 'adm:exit', text: '🏠 Exit Admin' });
  return out;
}

/** Choice twin of adminNav() — keeps the numbered fallback aligned. */
export function adminNavChoices(choices = []) {
  const out = (choices || []).map((c) => ({ ...c }));
  const has = (id) => out.some((c) => c.id === id);
  if (!has('adm:menu') && out.length < BUTTON_LIMIT) {
    out.push({ id: 'adm:menu', label: '⬅️ Admin Menu', keywords: ['back', 'admin menu', 'menu'] });
  }
  if (!has('adm:exit') && out.length < BUTTON_LIMIT) {
    out.push({ id: 'adm:exit', label: '🏠 Exit Admin', keywords: ['exit', 'close', 'home'] });
  }
  return out;
}

/**
 * Render one admin screen. Either a LIST (opts.list) or buttons.
 * Always stores the matching choices so typed + numbered replies work.
 */
export async function adminScreen(sock, jid, opts) {
  const {
    title, text, buttons = [], choices = [], list = null, note = null,
  } = opts || {};
  if (note) await sendText(sock, jid, note);

  if (list) {
    const sections = list.sections.map((s) => ({
      ...(s.title ? { title: s.title } : {}),
      rows: s.rows.map((r) => ({ ...r, description: r.description || undefined })),
    }));
    const choiceList = list.choices
      || sections.flatMap((s) => s.rows.map((r) => ({ id: r.id, label: r.title, keywords: r.keywords || [] })));
    setUser(jid, { choices: adminNavChoices(choiceList) });
    return sendList(sock, jid, {
      title, text, buttonText: list.buttonText || title || 'Select', sections,
    });
  }

  const own = choices.length
    ? choices
    : buttons.map((b) => ({ id: b.id, label: b.text, keywords: [String(b.text || b.id).toLowerCase()] }));
  // flow 'admin' = typed / numbered replies are matched against THIS
  // screen's choices (the router checks it before the customer menus).
  setUser(jid, { flow: 'admin', choices: adminNavChoices(own) });
  return sendButtons(sock, jid, { title, text, buttons: adminNav(buttons) });
}

// ── The panel ─────────────────────────────────────────────────
const PANEL_ROWS = [
  { id: 'adm:pending', title: '🔔 Pending Orders', description: 'Confirm / reject waiting orders', keywords: ['pending', 'orders', 'confirm'] },
  { id: 'adm:stats', title: "📊 Today's Stats", description: 'Orders, revenue, profit', keywords: ['stats', 'today', 'sales'] },
  { id: 'adm:find', title: '🔍 Find Order / Customer', description: 'Order id, number or name', keywords: ['find', 'search', 'customer'] },
  { id: 'adm:plans', title: '📦 Plans & Prices', description: 'Edit price, show/hide plan', keywords: ['plans', 'price', 'prices'] },
  { id: 'adm:store', title: '🛍️ Digital Store', description: 'ProdSeller + Eklas products, markup, stock', keywords: ['store', 'digital', 'products', 'prodseller', 'eklas', 'markup'] },
  { id: 'adm:sales', title: '🎟️ Sale Codes', description: 'Launch % off deals, pause or delete', keywords: ['sale', 'sales', 'code', 'promo', 'deal', 'discount', 'offer'] },
  { id: 'adm:wallet', title: '💰 Wallets & Top-ups', description: 'Liability, ledger, manual adjust', keywords: ['wallet', 'balance', 'topup', 'ledger'] },
    { id: 'adm:pay', title: '💳 Payments', description: 'Binance Pay tx + NayaPay emails', keywords: ['payments', 'binance', 'nayapay', 'verifier', 'usdt'] },
  { id: 'adm:reviews', title: '⭐ Reviews', description: 'Channel broadcasts', keywords: ['reviews', 'stars', 'ratings'] },
  { id: 'adm:bc', title: '📢 Broadcast', description: 'Message your customers', keywords: ['broadcast', 'message', 'blast'] },
  { id: 'adm:block', title: '🚫 Blocklist', description: 'Blocked numbers', keywords: ['block', 'blocked', 'blocklist'] },
  { id: 'adm:team', title: '👥 Admins', description: 'Add / remove admin rights', keywords: ['admin', 'admins', 'team', 'staff', 'add', 'remove'], ownerOnly: true },
  { id: 'adm:comms', title: '📣 Channel & Group', description: 'Link + group update sender', keywords: ['channel', 'group', 'link', 'update'], ownerOnly: true },
  { id: 'adm:settings', title: '⚙️ Bot Settings', description: 'Mode, verifier, quiet hours', keywords: ['settings', 'config', 'mode'], ownerOnly: true },
  { id: 'adm:dashboard', title: '🌐 Dashboard', description: 'Open the web dashboard', keywords: ['dashboard', 'web', 'browser'] },
];

/**
 * Open the admin panel LIST.
 * @returns {Promise<boolean>} false when the JID is not an admin
 */
export async function openPanel(sock, jid, note) {
  const role = roleFor(jid);
  if (!role) return false;

  const pending = pendingOrders().length;
  const rows = PANEL_ROWS
    .filter((r) => !r.ownerOnly || role === 'owner')
    .map((r) => ({
      id: r.id,
      title: r.id === 'adm:pending' ? `🔔 Pending Orders (${pending})` : r.title,
      description: r.description,
    }));

  const choices = PANEL_ROWS
    .filter((r) => !r.ownerOnly || role === 'owner')
    .map((r) => ({ id: r.id, label: r.title, keywords: r.keywords }));

  setUser(jid, { flow: 'admin', adminInput: null, adminRelay: null, adminPayload: null, choices });

  const intro = [
    pending > 0 ? `⏳ *${pending}* order(s) aapki confirmation ka intezar kar rahe hain.` : '✅ Koi pending order nahi.',
    `👤 Role: *${role === 'owner' ? 'Owner 🧭' : 'Staff 🧑‍💻'}*`,
    'Row tap karein ya number reply karein (1–' + rows.length + ').',
  ].join('\n');

  await sendList(sock, jid, {
    title: `🛠️ ${BRAND.name} Admin Panel`,
    text: note ? `${note}\n\n${intro}` : intro,
    buttonText: 'Open',
    sections: [{ title: 'Admin', rows }],
  });
  return true;
}

// ── Order card ────────────────────────────────────────────────
function customerLabel(order) {
  const name = order.name ? `${order.name} · ` : '';
  return `${name}${maskPhone(order.phone)}`;
}

/** Delivered keys must never be shown in full — first/last chars only. */
function maskKey(key) {
  const s = String(key || '');
  if (s.length <= 10) return `${s.slice(0, 3)}${'*'.repeat(Math.max(3, s.length - 4))}${s.slice(-1)}`;
  return `${s.slice(0, 6)}…${s.slice(-4)} (${s.length} chars)`;
}

/**
 * Catalogue-specific lines for a card: Digital Store orders carry an
 * activation email + ProdSeller reference, top-ups carry nothing to
 * fulfil, wallet-paid ones say so up front.
 */
function fulfillmentLines(order) {
  const lines = [];
  if (order.paidBy === 'wallet') lines.push('💰 Paid from wallet (no screenshot verification)');
  if (order.catalogType === 'wallet_topup') {
    lines.push(`💳 Top-up ${formatPrice(order.price)} → customer wallet${order.walletCredited ? ' ✅ credited' : ''}`);
    return lines;
  }
  if (order.catalogType === 'digital') {
    lines.push(`🛍️ Digital product: ${order.productId || order.planName}`);
    if (order.requiresEmailActivation && order.activationEmail) {
      lines.push(`📧 Activation on: ${order.activationEmail} (supplier email pe activate karta hai — ⏳ delivery time)`);
    }
    if (order.supplier || order.prodsellerOrderId) {
      lines.push(`🔗 ${supplierLabel(order.supplier || 'prodseller')} order: ${order.supplierOrderId || order.prodsellerOrderId}`);
    }
    if (Array.isArray(order.deliveredKeys) && order.deliveredKeys.length) {
      lines.push(`🔑 Keys: ${order.deliveredKeys.map(maskKey).join(', ')}`);
    }
    if (order.status === 'awaiting_activation') {
      lines.push(`⏳ Polling ${supplierLabel(order.supplier || 'prodseller')} every few minutes for the key…`);
    }
  }
  return lines;
}

/** The compact per-order card (the screenshot image is forwarded right after it). */
export function orderCard(order) {
  return [
    `🧾 *${order.id}* · ${formatPrice(order.price)}`,
    `📦 ${order.planName}${order.data ? ` · ${order.data} ${order.validity}` : ''}${(Number(order.quantity) || 1) > 1 ? ` · ×${order.quantity} eSIMs` : ''}`,
    `👤 ${customerLabel(order)}`,
    `💳 ${order.paymentLabel} · ⏱️ ${ageLabel(order.createdAt)}`,
    ...fulfillmentLines(order),
    ...verificationLines(order),
    statusLine(order),
  ].filter(Boolean).join('\n');
}

/**
 * The verification line differs by method: NayaPay orders show the
 * parsed-email auto-check, 💳 Binance Pay orders show the amount we
 * are waiting for, the Transaction ID and the verdict of the last
 * lookup (the customer never sees any of this).
 */
function verificationLines(order) {
  // 🧠 Part B — the analyst's verdict rides under the code's own line.
  const ai = aiCardLine(order);
  if (order.paymentId !== 'pay_binancepay') {
    return [`🤖 Auto-check: ${autoCheckLabel(order)}`, ai].filter(Boolean);
  }
  const b = order.binance || {};
  const head = `💳 Binance Pay: ${b.txId ? `tx \`${b.txId}\`` : '⏳ Transaction ID pending'} · want *${usdtLabel(order)}*`;
  if (!b.verdict) return [head, ai].filter(Boolean);
  const detail = b.detail ? ` — ${b.detail}` : '';
  const when = b.checkedAt ? ` (${stamp(b.checkedAt)})` : '';
  return [head, `🤖 Verify: *${b.verdict}*${detail}${when} · mode: ${b.mode || binanceMode()}`, ai].filter(Boolean);
}

function statusLine(order) {
  if (order.status === 'fulfilled') {
    const refund = order.refundNeeded
      ? ` · ↩️ Refund needed (flagged ${stamp(order.refundNeeded.at)})`
      : '';
    return `✅ Delivered${order.confirmedBy ? ` by ${order.confirmedBy}` : ''}${order.confirmedAt ? ` · ${stamp(order.confirmedAt)}` : ''}${refund}`;
  }
  if (order.status === 'rejected') {
    return `❌ Rejected: ${order.note || 'no reason'}${order.rejectedBy ? ` by ${order.rejectedBy}` : ''}`;
  }
  if (order.status === 'cancelled') return '⛔ Cancelled by customer';
  return null;
}

/** Card buttons depend on where the order currently is. */
function cardButtons(order) {
  const v = order.actionVersion || 0;
  const id = order.id;
  if (order.status === 'pending_admin') {
    return [
      { id: `adm:conf:${id}:v${v}`, text: '✅ Confirm' },
      { id: `adm:rej:${id}:v${v}`, text: '❌ Reject' },
      { id: `adm:msg:${id}`, text: '💬 Message Customer' },
      { id: `adm:det:${id}`, text: '🔍 Details' },
    ];
  }
  if (order.status === 'awaiting_supplier_funding') {
    return [
      { id: `adm:conf:${id}:v${v}`, text: '🔁 Retry purchase' },
      { id: `adm:rej:${id}:v${v}`, text: '↩️ Reject + refund' },
      { id: `adm:msg:${id}`, text: '💬 Message Customer' },
      { id: `adm:det:${id}`, text: '🔍 Details' },
    ];
  }
  if (order.status === 'awaiting_activation') {
    return [
      { id: `adm:det:${id}`, text: '🔍 Details' },
      { id: `adm:msg:${id}`, text: '💬 Message Customer' },
      { id: 'adm:store', text: '🛍️ Store' },
      { id: `adm:retry:${id}`, text: '🔁 Re-check now' },
    ];
  }
  if (order.status === 'fulfilled') {
    return [
      { id: `adm:retry:${id}`, text: '🔁 Resend eSIM' },
      { id: `adm:undo:${id}`, text: '↩️ Refund needed' },
      { id: `adm:msg:${id}`, text: '💬 Message Customer' },
      { id: `adm:det:${id}`, text: '🔍 Details' },
    ];
  }
  return [
    { id: `adm:det:${id}`, text: '🔍 Details' },
    { id: `adm:retry:${id}`, text: '🔁 Re-check / resend' },
  ];
}

/**
 * Send the order card (buttons + choices) to one chat.
 * @param {{note?: string}} opts optional line sent before the card
 */
export async function sendOrderCard(sock, jid, order, opts = {}) {
  if (opts.note) await sendText(sock, jid, opts.note);
  const buttons = cardButtons(order);
  const choices = buttons.map((b) => ({
    id: b.id,
    label: b.text,
    keywords: b.text.toLowerCase().replace(/^[^\w]+/, '').split(' '),
  }));
  return adminScreen(sock, jid, {
    title: `${order.id} · ${STATUS_TEXT[order.status] || order.status}`,
    text: orderCard(order),
    buttons,
    choices,
  });
}

/** Every configured admin JID (falls back to the primary owner). */
function adminTargets() {
  return allAdminJids().length ? allAdminJids() : [ADMIN_JID].filter(Boolean);
}

/**
 * Push a new order to every admin as ONE message — no more
 * summary + card + image rush. The payment screenshot rides as the
 * image header, the details + typed-command hints as the caption
 * and the Confirm/Reject buttons attach to the same message.
 * imageBuffer null = download failed → a buttons message with the
 * warning folded into the caption (still exactly one message).
 * @param {Buffer|null} imageBuffer downloaded screenshot
 * @param {{note?:string, headline?:string, hideImageWarning?:boolean}} [opts]
 *        note        extra line folded into the caption (verdict, discount…)
 *        headline    replaces the "🆕 NEW ORDER" first line
 *        hideImageWarning  skip the "screenshot download failed" line
 *                          (no screenshot exists — e.g. 💳 Binance Pay)
 * @returns {Promise<number>} how many admins got the alert
 */
export async function notifyNewOrder(sock, order, imageBuffer = null, opts = {}) {
  const caption = [
    opts.headline || ('🆕 *NEW ORDER — ' + order.id + '*'),
    '',
    orderCard(order),
    order.discount ? `🎁 Discount ${order.discount.percent}% (${order.discount.code}): -${formatPrice(order.discount.amount)}` : null,
    opts.note || null,
    `🕐 Placed: ${new Date(order.createdAt).toLocaleString('en-GB', { ...PKT, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`,
    imageBuffer ? null : (opts.hideImageWarning
      ? null
      : '⚠️ Screenshot image download nahi ho saka — customer se seedha photo dobara bhejwayein.'),
    '',
    '*Reply with:*',
    `\`confirm ${order.id}\` → customer ko eSIM bhejein`,
    `\`reject ${order.id} reason\` → customer ko inform karein`,
    `\`orders\` → saare pending orders dekhein`,
  ].filter(Boolean).join('\n');

  const buttons = cardButtons(order);
  const choices = buttons.map((b) => ({
    id: b.id,
    label: b.text,
    keywords: b.text.toLowerCase().replace(/^[^\w]+/, '').split(' '),
  }));
  const title = `${order.id} · ${STATUS_TEXT[order.status] || order.status}`;

  const targets = adminTargets();
  const results = await Promise.allSettled(
    targets.map(async (target) => {
      setUser(target, { flow: 'admin', choices: adminNavChoices(choices) });
      if (!imageBuffer) {
        return sendButtons(sock, target, { title, text: caption, buttons: adminNav(buttons) });
      }
      // Plain-text clients: image + caption only (the caption already
      // carries the typed commands), still one message.
      if (shouldUsePlain(target)) {
        return sock.sendMessage(target, { image: imageBuffer, caption });
      }
      // ONE message: screenshot header + details + action buttons.
      try {
        return await sock.sendMessage(
          target,
          {
            image: imageBuffer,
            caption,
            title,
            footer: BRAND.footer,
            nativeFlow: adminNav(buttons),
          },
          { quoted: null },
        );
      } catch (err) {
        logError('order.alert', err, { orderId: order.id, target });
        // Still one message — keep the proof of payment, drop buttons.
        return sock.sendMessage(target, { image: imageBuffer, caption });
      }
    }),
  );
  const delivered = results.filter((r) => r.status === 'fulfilled').length;

  if (delivered === 0) {
    console.warn('[admin] No admin JID configured — new order NOT announced.');
  } else {
    console.log(`[admin] ${order.id} alert sent to ${delivered} admin(s)`);
  }
  logAdmin('order.new', { orderId: order.id, admins: delivered, image: Boolean(imageBuffer) });
  return delivered;
}

/**
 * Customer cancelled before fulfilment — tell every admin at once so
 * the (possibly still open) order card never gets confirmed.
 */
export async function notifyOrderCancelled(sock, order) {
  const targets = adminTargets();
  const text = `⛔ *${order.id}* — customer ne order cancel kar diya. Yeh card confirm/reject mat karein.`;
  await Promise.allSettled(targets.map((target) => sendText(sock, target, text)));
  logAdmin('order.cancelled', { orderId: order.id, by: order.jid });
}

// ── Pending orders ────────────────────────────────────────────
export async function showPending(sock, jid) {
  const list = pendingOrders().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  if (list.length === 0) {
    return adminScreen(sock, jid, {
      title: '🔔 Pending Orders',
      text: '✅ Koi order pending nahi hai. Sab clear hai!',
      buttons: [{ id: 'adm:stats', text: "📊 Today's Stats" }],
    });
  }

  const rows = list.slice(0, 15).map((o) => {
    const age = ageLabel(o.createdAt);
    const stale = Date.now() - new Date(o.createdAt).getTime() > 15 * 60000;
    return {
      id: `adm:open:${o.id}`,
      title: `${stale ? '🔴 ' : ''}${o.id} · ${formatPrice(o.price)}`,
      description: `${o.planName} · ${age} · ${autoCheckLabel(o)}`,
      keywords: [o.id.toLowerCase(), String(o.phone || '')],
    };
  });

  return adminScreen(sock, jid, {
    title: `🔔 Pending (${list.length})`,
    text: list.length > 15 ? `Sirf pehle 15 dikha rahe hain (${list.length} total).\n🔴 = 15 min se zyada purana.` : 'Tap a row to open its card.',
    list: { buttonText: 'Open order', sections: [{ title: 'Waiting on you', rows }] },
  });
}

// ── Order details ─────────────────────────────────────────────
export async function openOrderScreen(sock, jid, orderId) {
  const order = getOrder(orderId);
  if (!order) {
    return adminScreen(sock, jid, {
      title: '🔍 Order',
      text: `❌ Order *${orderId}* nahi mila.`,
      buttons: [{ id: 'adm:pending', text: '🔔 Pending Orders' }],
    });
  }

  const check = autoCheck(order);
  const lines = [
    `🧾 *${order.id}* · ${STATUS_TEXT[order.status] || order.status}`,
    `📶 ${order.planName} · ${order.data || '—'} ${order.validity || ''}`.trim(),
    `💰 ${formatPrice(order.price)}${order.discount ? ` (discounted from ${formatPrice(order.discount.amount + order.price)} on ${order.discount.code})` : ''}`,
    `💳 ${order.paymentLabel}`,
    ...fulfillmentLines(order),
    `👤 ${customerLabel(order)}`,
    `🌐 Language: ${getLang(order.jid)}`,
    `📅 Placed: ${stamp(order.createdAt)}`,
    order.screenshot?.receivedAt
      ? `📎 Screenshot: ${stamp(order.screenshot.receivedAt)}${order.screenshot.pending ? ' (⬇️ forwarding…)' : order.screenshot.failed ? ' (⚠️ image fetch failed — customer se dobara bhejwayein)' : ` (${order.screenshot.bytes} bytes)`}`
      : '📎 Screenshot: none',
    `🤖 Auto-check: ${autoCheckLabel(order)}`,
    check.payment ? `🔎 ${check.detail} (txn ${check.payment.txn})` : null,
    order.confirmedBy ? `✅ Confirmed by ${order.confirmedBy} · ${stamp(order.confirmedAt)}` : null,
    order.rejectedBy ? `❌ Rejected by ${order.rejectedBy} · ${stamp(order.rejectedAt)} — ${order.note}` : null,
    order.supplierOrderId ? `🔗 Supplier ref (${supplierLabel(order.supplier || 'prodseller')}): ${order.supplierOrderId}` : null,
    order.prodsellerOrderId && !order.supplierOrderId ? `🔗 ProdSeller ref: ${order.prodsellerOrderId}` : null,
    order.pollTimedOutAt ? `⚠️ Activation poll timed out ${stamp(order.pollTimedOutAt)} — manual follow-up` : null,
    order.verifyFails ? `⚠️ Verification failures: ${order.verifyFails}` : null,
    order.refundNeeded ? `↩️ Refund needed — flagged by ${order.refundNeeded.by} · ${stamp(order.refundNeeded.at)}` : null,
    order.refundedVia === 'wallet' ? `↩️ Refunded to wallet ${stamp(order.refundedAt)}` : null,
    `📤 Reminders sent: ${order.reminderSent ? 'yes' : 'no'}`,
  ].filter(Boolean);

  const buttons = [];
  if (order.status === 'pending_admin' || order.status === 'awaiting_supplier_funding') {
    const v = order.actionVersion || 0;
    buttons.push(
      { id: `adm:conf:${order.id}:v${v}`, text: order.status === 'awaiting_supplier_funding' ? '🔁 Retry purchase' : '✅ Confirm' },
      { id: `adm:rej:${order.id}:v${v}`, text: order.status === 'awaiting_supplier_funding' ? '↩️ Reject + refund' : '❌ Reject' },
    );
  }
  if (order.status === 'awaiting_activation') {
    buttons.push({ id: `adm:retry:${order.id}`, text: '🔁 Re-check now' });
    buttons.push({ id: `adm:rej:${order.id}:v${order.actionVersion || 0}`, text: '↩️ Reject + refund' });
  }
  if (order.status === 'fulfilled') {
    buttons.push({ id: `adm:retry:${order.id}`, text: '🔁 Resend eSIM' });
    if (!order.refundNeeded) buttons.push({ id: `adm:undo:${order.id}`, text: '↩️ Refund needed' });
  }
  buttons.push({ id: `adm:msg:${order.id}`, text: '💬 Message Customer' });

  const choices = buttons.map((b) => ({ id: b.id, label: b.text, keywords: b.text.toLowerCase().split(/\s+/) }));
  return adminScreen(sock, jid, {
    title: `🔍 ${order.id}`,
    text: lines.join('\n'),
    buttons,
    choices,
  });
}

// ── Confirm / Reject ──────────────────────────────────────────
function alreadyActioned(order, jid) {
  if (order.status === 'fulfilled' || order.status === 'rejected' || order.status === 'cancelled') {
    const who = order.confirmedBy || order.rejectedBy || 'system';
    const when = order.confirmedAt || order.rejectedAt || order.updatedAt;
    return `⚠️ *${order.id}* is already ${STATUS_TAP[order.status] || order.status} — ${who} ne ${stamp(when)} par action liya.`;
  }
  return null;
}

async function runConfirm(sock, jid, user, orderId) {
  const order = getOrder(orderId);
  if (!order) return sendText(sock, jid, `❌ Order *${orderId}* nahi mila.`);

  const stale = alreadyActioned(order, jid);
  if (stale) return sendText(sock, jid, stale);

  if (locks.has(orderId)) {
    return sendText(sock, jid, `⏳ *${orderId}* pehle se process ho raha hai — thora ruk kar dekhein.`);
  }
  locks.add(orderId);

  const actor = adminName(jid, getUser(jid).pushName);
  try {
    const res = await withAck(jid, `⏳ *${orderId}* — supplier se eSIM li ja rahi hai…`, () =>
      confirmOrder(sock, orderId, { actor }));

    appendAudit({
      actor: jidUser(jid), role: roleFor(jid), action: 'order.confirm',
      target: orderId, detail: `${res.ok ? 'delivered' : 'failed'} (${res.ok ? order.planName : String(res.message).slice(0, 120)})`,
    });

    if (res.ok) {
      await sendText(sock, jid, `✅ *${orderId}* delivered by ${actor}`);
      const after = getOrder(orderId) || order;
      return sendOrderCard(sock, jid, after, { note: null });
    }
    await sendText(sock, jid, res.message);
    return sendOrderCard(sock, jid, order);
  } finally {
    locks.delete(orderId);
  }
}

const REASON_TEXT = {
  amount: 'Amount mismatch',
  notreceived: 'Payment not received',
  unclear: 'Screenshot unclear or fake',
  duplicate: 'Duplicate order',
};

function rejectRows(orderId) {
  return [
    { id: `adm:rejdo:${orderId}:amount`, title: 'Amount mismatch', description: 'Payment amount order se match nahi karta' },
    { id: `adm:rejdo:${orderId}:notreceived`, title: 'Payment not received', description: 'Koi payment land nahi hui' },
    { id: `adm:rejdo:${orderId}:unclear`, title: 'Screenshot unclear / fake', description: 'Screenshot parh nahi aa raha' },
    { id: `adm:rejdo:${orderId}:duplicate`, title: 'Duplicate order', description: 'Ek hi payment par dobara order' },
    { id: `adm:rejcustom:${orderId}`, title: '✏️ Custom reason', description: 'Type karein' },
  ];
}

async function runReject(sock, jid, orderId, reason) {
  const order = getOrder(orderId);
  if (!order) return sendText(sock, jid, `❌ Order *${orderId}* nahi mila.`);

  const stale = alreadyActioned(order, jid);
  if (stale) return sendText(sock, jid, stale);

  if (locks.has(orderId)) return sendText(sock, jid, `⏳ *${orderId}* pehle se process ho raha hai.`);
  locks.add(orderId);

  const actor = adminName(jid, getUser(jid).pushName);
  try {
    const res = await rejectOrder(sock, orderId, reason, { actor });
    appendAudit({
      actor: jidUser(jid), role: roleFor(jid), action: 'order.reject',
      target: orderId, detail: reason,
    });
    const after = getOrder(orderId) || order;
    await sendText(sock, jid, `❌ Rejected: ${reason} by ${actor}${res.ok ? '' : `\n${res.message}`}`);
    return sendOrderCard(sock, jid, after);
  } finally {
    locks.delete(orderId);
  }
}

// ── Stats ─────────────────────────────────────────────────────
function periodOrders(period) {
  const all = allOrders();
  const today = new Date().toLocaleDateString('en-CA', PKT);
  if (period === 'day') return all.filter((o) => new Date(o.createdAt).toLocaleDateString('en-CA', PKT) === today);
  const days = period === 'week' ? 7 : 30;
  const since = Date.now() - days * 86400000;
  return all.filter((o) => new Date(o.createdAt).getTime() >= since);
}

function statsText(period, label) {
  const list = periodOrders(period);
  const done = list.filter((o) => o.status === 'fulfilled');
  const pending = list.filter((o) => o.status === 'pending_admin');
  const rejected = list.filter((o) => o.status === 'rejected');
  const revenue = done.reduce((sum, o) => sum + Number(o.price || 0), 0);
  const profit = done.reduce((sum, o) => {
    const plan = getPlan(o.planId);
    const cost = Number(plan?.cost ?? NaN);
    return sum + (Number.isFinite(cost) && cost > 0 ? Number(o.price || 0) - cost : 0);
  }, 0);

  const byPlan = {};
  for (const o of list) byPlan[o.planName || o.planId || '?'] = (byPlan[o.planName || o.planId || '?'] || 0) + 1;
  const top = Object.entries(byPlan).sort((a, b) => b[1] - a[1])[0];

  const times = done
    .filter((o) => o.createdAt && o.updatedAt)
    .map((o) => new Date(o.updatedAt).getTime() - new Date(o.createdAt).getTime());
  const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length / 60000) : null;

  return [
    `📊 *${label}*`,
    '',
    `🧾 Orders: *${list.length}*`,
    `✅ Delivered: ${done.length}`,
    `⏳ Pending: ${pending.length}`,
    `❌ Rejected: ${rejected.length}`,
    `💰 Revenue: *${formatPrice(revenue)}*`,
    `📈 Est. profit: ${profit > 0 ? formatPrice(profit) : '—'}`,
    `🏆 Top plan: ${top ? `${top[0]} (${top[1]})` : '—'}`,
    `⏱️ Avg delivery: ${avg !== null ? `${avg}m` : '—'}`,
  ].join('\n');
}

async function showStats(sock, jid, period = 'day') {
  const labels = { day: "📅 Today", week: '📅 This Week', month: '🗓️ This Month' };
  const buttons = [
    { id: 'adm:stats:day', text: labels.day },
    { id: 'adm:stats:week', text: labels.week },
    { id: 'adm:stats:month', text: labels.month },
  ];
  const choices = buttons.map((b) => ({ id: b.id, label: b.text, keywords: b.text.toLowerCase().split(/\s+/) }));

  // Extra money lines: what we owe customers (wallet liability) and
  // what each supplier wallet holds (both are cached).
  let money = '';
  try {
    const balances = await getBalances();
    const psLine = balances.prodseller.configured
      ? balances.prodseller.ok
        ? `🛒 ${supplierLabel('prodseller')} balance: *${balances.prodseller.balance} USDT*${balances.prodseller.balance <= SETTINGS.prodsellerLowBalanceUsd ? ' ⚠️ LOW' : ''}`
        : '🛒 ProdSeller balance: ❌ fetch fail'
      : null;
    const ekLine = balances.eklas.configured
      ? balances.eklas.ok
        ? `🛒 Eklas balance: *${balances.eklas.balance} USDT*${balances.eklas.balance <= SETTINGS.eklasLowBalanceUsd ? ' ⚠️ LOW' : ''}`
        : '🛒 Eklas balance: ❌ fetch fail'
      : null;
    money = [
      '',
      `🏦 Wallet liability: *${formatPrice(totalLiability())}*`,
      psLine || ekLine ? [psLine, ekLine].filter(Boolean).join('\n') : '🛒 Supplier balance: —',
    ].join('\n');
  } catch { /* stats must never fail because a supplier is down */ }

  return adminScreen(sock, jid, {
    title: labels[period],
    text: `${statsText(period, labels[period].replace(/^\S+\s/, ''))}${money}`,
    buttons,
    choices,
  });
}

// ── Find ──────────────────────────────────────────────────────
function customerSummary(orders) {
  const name = orders.find((o) => o.name)?.name || 'Unknown';
  const spent = orders.filter((o) => o.status === 'fulfilled').reduce((s, o) => s + Number(o.price || 0), 0);
  const last = [...orders].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  const jid = last?.jid;
  return [
    `👤 *${name}* · ${maskPhone(last?.phone)}`,
    `🧾 Orders: ${orders.length} · Spent: ${formatPrice(spent)}`,
    `🌐 Language: ${jid ? getLang(jid) : '—'}`,
    `📅 Last: ${last ? `${last.id} (${stamp(last.createdAt)})` : '—'}`,
    `🚫 Blocked: ${jid && isBlocked(jid) ? 'YES' : 'no'}`,
  ].join('\n');
}

async function runFind(sock, jid, user, query) {
  const q = String(query || '').trim();
  const digits = q.replace(/\D/g, '');
  const hits = allOrders().filter((o) => {
    if (!q) return false;
    if (o.id.toLowerCase().includes(q.toLowerCase())) return true;
    if (digits && String(o.phone || '').includes(digits)) return true;
    if (o.name && o.name.toLowerCase().includes(q.toLowerCase())) return true;
    return false;
  });

  if (hits.length === 0) {
    return adminScreen(sock, jid, {
      title: '🔍 Find',
      text: `❌ "${q}" se koi order/customer nahi mila.`,
      buttons: [{ id: 'adm:find', text: '🔍 Try again' }],
      choices: [{ id: 'adm:find', label: '🔍 Try again', keywords: ['again', 'retry'] }],
    });
  }

  const byCustomer = new Map();
  for (const o of hits) {
    const key = o.jid || o.phone;
    if (!byCustomer.has(key)) byCustomer.set(key, []);
    byCustomer.get(key).push(o);
  }

  if (hits.length === 1) {
    const order = hits[0];
    const buttons = [
      { id: `adm:blockof:${order.id}`, text: '🚫 Block' },
      { id: `adm:retry:${order.id}`, text: '🔁 Resend eSIM' },
      { id: `adm:msg:${order.id}`, text: '💬 Message' },
      { id: `adm:det:${order.id}`, text: '🔍 Details' },
    ];
    const choices = buttons.map((b) => ({
      id: b.id, label: b.text, keywords: b.text.toLowerCase().replace(/^[^\w]+/, '').split(' '),
    }));
    return adminScreen(sock, jid, {
      title: `${order.id} · ${STATUS_TEXT[order.status] || order.status}`,
      text: `${customerSummary([order])}\n\n${orderCard(order)}`,
      buttons,
      choices,
    });
  }

  const rows = hits.slice(0, 15).map((o) => ({
    id: `adm:open:${o.id}`,
    title: `${o.id} · ${formatPrice(o.price)} · ${STATUS_TEXT[o.status] || o.status}`,
    description: `${o.planName} · ${ageLabel(o.createdAt)}`,
    keywords: [o.id.toLowerCase()],
  }));
  const summaries = [...byCustomer.values()].slice(0, 3).map(customerSummary).join('\n\n');

  return adminScreen(sock, jid, {
    title: `🔍 ${hits.length} matches`,
    text: summaries,
    list: { buttonText: 'Open order', sections: [{ title: 'Matches', rows }] },
  });
}

// ── Customer actions (block / message) ────────────────────────
async function confirmBlock(sock, jid, targetJidOrPhone) {
  const target = String(targetJidOrPhone).includes('@') ? targetJidOrPhone : toJid(targetJidOrPhone);
  const num = jidUser(target);
  if (!num) return sendText(sock, jid, '❌ Number samajh nahi aaya.');
  return adminScreen(sock, jid, {
    title: '🚫 Block customer',
    text: [
      `Block *+${num}*?`,
      '',
      'Unhe ab koi reply nahi milega (aur spam ka attempt log hoga).',
    ].join('\n'),
    buttons: [
      { id: `adm:blockyes:${num}`, text: '🚫 Yes, block' },
      { id: 'adm:find', text: '⬅️ Back' },
    ],
    choices: [
      { id: `adm:blockyes:${num}`, label: '🚫 Yes, block', keywords: ['yes', 'block', 'confirm'] },
      { id: 'adm:find', label: '⬅️ Back', keywords: ['back', 'cancel'] },
    ],
  });
}

async function runBlock(sock, jid, user, num) {
  const actor = adminName(jid, user.pushName);
  const target = toJid(num);
  if (!target) return sendText(sock, jid, '❌ Number galat hai.');
  blockJid(target, actor, 'manual');
  appendAudit({ actor: jidUser(jid), role: roleFor(jid), action: 'customer.block', target: num });
  return adminScreen(sock, jid, {
    title: '🚫 Blocklist',
    text: `🚫 +${num} blocked by ${actor}.\n\nUnhe ab koi reply nahi milega.`,
    buttons: [{ id: 'adm:block', text: '🚫 View blocklist' }],
  });
}

async function runUnblock(sock, jid, user, num) {
  const actor = adminName(jid, user.pushName);
  unblockJid(toJid(num));
  appendAudit({ actor: jidUser(jid), role: roleFor(jid), action: 'customer.unblock', target: num });
  return showBlocklist(sock, jid, `✅ +${num} unblocked by ${actor}.`);
}

async function showBlocklist(sock, jid, note) {
  const list = allBlocked();
  if (list.length === 0) {
    return adminScreen(sock, jid, {
      title: '🚫 Blocklist',
      text: note || 'Blocklist khaali hai. ✅',
      buttons: [{ id: 'adm:blockadd', text: '🚫 Block a number' }],
      choices: [{ id: 'adm:blockadd', label: '🚫 Block a number', keywords: ['block', 'add'] }],
      note: null,
    });
  }
  const rows = list.slice(0, 20).map((b) => ({
    id: `adm:unblock:${jidUser(b.jid)}`,
    title: `+${jidUser(b.jid)}`,
    description: `blocked ${stamp(b.at)} by ${b.by}${b.reason ? ` · ${b.reason}` : ''}`,
    keywords: [jidUser(b.jid)],
  }));
  return adminScreen(sock, jid, {
    title: `🚫 Blocklist (${list.length})`,
    text: note || 'Row tap karke unblock karein.',
    list: { buttonText: 'Unblock', sections: [{ title: 'Blocked', rows }] },
  });
}

// Customer JID -> active message relay (admin talking to them).
const relays = new Map();

/** orderId of an active relay for this customer, or null. */
export function relayCustomer(customerJid) {
  return relays.get(customerJid) || null;
}

/** Drop the relay for a customer (bot-on / end / restart of a chat). */
export function endRelayFor(customerJid) {
  return relays.delete(customerJid);
}

async function startRelay(sock, jid, user, orderId) {
  const order = getOrder(orderId);
  if (!order) return sendText(sock, jid, `❌ Order *${orderId}* nahi mila.`);
  setUser(jid, { adminRelay: orderId, adminInput: null, adminPayload: null });
  // Bot stays quiet on the customer while the admin talks.
  const session = setHuman(order.jid);
  armHumanExpiry(sock, order.jid, session.humanUntil);
  relays.set(order.jid, { adminJid: jid, orderId });
  return adminScreen(sock, jid, {
    title: `💬 Message ${order.id}`,
    text: [
      `Ab aapka har text *+${maskPhone(order.phone)}* ko jayega as *${BRAND.name} Team*.`,
      '',
      "Type your message. *end* bhejne ke liye `end` likhein.",
    ].join('\n'),
    buttons: [{ id: `adm:end`, text: '🔚 End chat' }],
    choices: [{ id: 'adm:end', label: '🔚 End chat', keywords: ['end', 'stop', 'exit'] }],
  });
}

async function relayMessage(sock, jid, user, text) {
  const orderId = user.adminRelay;
  const order = orderId ? getOrder(orderId) : null;
  const actor = adminName(jid, getUser(jid).pushName);

  if (/^(end|exit|stop|end chat|khatam|done)$/i.test(text)) {
    setUser(jid, { adminRelay: null });
    if (order) relays.delete(order.jid);
    return sendText(sock, jid, `🔚 Chat relay band — ${orderId ? `*${orderId}*` : ''} customer ke saath.`);
  }

  if (!order) {
    setUser(jid, { adminRelay: null });
    return sendText(sock, jid, '❌ Relay target nahi mila — panel dobara kholein.');
  }
  relays.set(order.jid, { adminJid: jid, orderId });

  try {
    await sendText(sock, order.jid, `*${BRAND.name} Team:*\n${text}`);
  } catch (err) {
    logError('admin.relay', err, { orderId });
    return sendText(sock, jid, `❌ Customer ko bhejna fail: ${err.message}`);
  }
  appendAudit({ actor: jidUser(jid), role: roleFor(jid), action: 'customer.message', target: orderId, detail: text.slice(0, 80) });

  return adminScreen(sock, jid, {
    title: `💬 Sent to ${order.id}`,
    text: `✅ Bhej diya gaya (+${maskPhone(order.phone)}).\n\nAur message type karein ya relay band karein.`,
    buttons: [{ id: 'adm:end', text: '🔚 End chat' }],
    choices: [{ id: 'adm:end', label: '🔚 End chat', keywords: ['end', 'stop', 'exit'] }],
  });
}

// ── Payments screen ───────────────────────────────────────────
/** The 💳 Binance Pay block: config health + the last cached rows. */
function binancePayLines() {
  const s = binanceStoreStatus();
  const health = s.configured
    ? '✅ ready'
    : (s.hasKey ? '⚠️ BINANCE_PAY_ID missing' : '⚠️ BINANCE_API_KEY / BINANCE_API_SECRET missing');
  const head = [
    '— 💳 Binance Pay —',
    `${health} · mode: *${s.mode}*${s.payIdMasked ? ` · Pay ID: ${s.payIdMasked}` : ''}`,
    s.lastOk
      ? `🔎 Last fetch: ${stamp(s.lastOk)} · cached ${s.count} (claimed ${s.claimed})`
      : `🔎 Never fetched · cached ${s.count}`,
    s.lastError ? `⚠️ ${s.lastError}` : null,
  ].filter(Boolean);

  const rows = recentBinanceTx(5);
  if (rows.length === 0) {
    head.push('  (koi transaction cache nahi hui — *Fetch Binance* dabayein)');
  } else {
    for (const tx of rows) {
      const tag = tx.status === 'claimed' ? `✅ ${tx.orderId}` : '⏳ unclaimed';
      const sign = Number(tx.amount) > 0 ? '+' : '';
      head.push(`• ${sign}${tx.amount} ${tx.currency || 'USDT'} · ${tx.transactionId} · ${tag}`);
    }
  }
  return head;
}

async function showPayments(sock, jid, note) {
  const status = scanStatus();
  const list = recentPayments(10);
  const lines = [
    '💳 *Payments*',
    '',
    `🤖 Verifier: ${status.message}`,
    status.lastScan ? `🔎 Last scan: ${stamp(status.lastScan)}` : '🔎 Never scanned',
    '',
    ...binancePayLines(),
    '',
    '— 📧 NayaPay emails —',
  ];
  if (list.length === 0) {
    lines.push('Koi payment email parse nahi hui.');
  } else {
    for (const p of list) {
      const tag = p.status === 'claimed' ? `✅ ${p.matchedOrder}` : '⏳ unclaimed';
      lines.push(`• ${formatPrice(p.amount)} · ${p.txn} · ${tag}`);
      lines.push(`  ${stamp(p.at)}`);
    }
  }

  const unclaimed = unclaimedPayments();
  const buttons = [];
  const choices = [];
  if (unclaimed.length > 0) {
    buttons.push({ id: 'adm:paylink', text: '📎 Link payment to order' });
    choices.push({ id: 'adm:paylink', label: '📎 Link payment to order', keywords: ['link', 'payment', 'claim'] });
  }
  buttons.push({ id: 'adm:btxrescan', text: '🔄 Fetch Binance' });
  choices.push({ id: 'adm:btxrescan', label: '🔄 Fetch Binance', keywords: ['binance', 'fetch', 'usdt', 'transactions'] });
  buttons.push({ id: 'adm:rescan', text: '🔄 Rescan inbox' });
  choices.push({ id: 'adm:rescan', label: '🔄 Rescan inbox', keywords: ['rescan', 'scan', 'inbox'] });

  return adminScreen(sock, jid, { title: '💳 Payments', text: lines.join('\n'), buttons, choices, note });
}

async function startPayLink(sock, jid, user) {
  const unclaimed = unclaimedPayments();
  if (unclaimed.length === 0) {
    return showPayments(sock, jid, '⚠️ Koi unclaimed payment nahi mili — pehle inbox scan karein.');
  }
  const rows = unclaimed.slice(0, 5).map((p) => ({
    id: `adm:paytxn:${p.txn}`,
    title: `${formatPrice(p.amount)} · ${p.txn}`,
    description: stamp(p.at),
    keywords: [p.txn.toLowerCase()],
  }));
  return adminScreen(sock, jid, {
    title: '📎 Link payment',
    text: 'Unclaimed payment choose karein, phir order id type karein.',
    list: { buttonText: 'Select payment', sections: [{ title: 'Unclaimed', rows }] },
  });
}

// ── Reviews screen ────────────────────────────────────────────
async function showReviews(sock, jid, note) {
  const reviews = [...allReviews()].slice(-10).reverse();
  const held = reviews.filter((r) => r.stars >= 4 && r.broadcast !== 'posted');
  const posted = reviews.find((r) => r.broadcast === 'posted' && r.channelMsgId && r.channelJid);

  const lines = ['⭐ *Last 10 reviews*', ''];
  if (reviews.length === 0) lines.push('Abhi tak koi review nahi.');
  for (const r of reviews) {
    const flag = r.broadcast === 'posted' ? '📣 channel' : r.broadcast === 'admin_only' ? '🔒 admin only' : '⚠️ failed';
    lines.push(`• ${r.id} ${'⭐'.repeat(r.stars)} · ${r.orderId || '—'} · ${flag}`);
    if (r.comment) lines.push(`  "${String(r.comment).slice(0, 90)}"`);
  }
  lines.push('', '🔒 Compliance: ≤3★ reviews kabhi broadcast nahi hote.');

  const buttons = [];
  const choices = [];
  if (held.length > 0) {
    buttons.push({ id: 'adm:revbc', text: `📣 Broadcast ${held.length} held` });
    choices.push({ id: 'adm:revbc', label: '📣 Broadcast held', keywords: ['broadcast', 'post', 'channel'] });
  }
  if (posted) {
    buttons.push({ id: `adm:revdel:${posted.id}`, text: '🗑️ Unpublish last' });
    choices.push({ id: `adm:revdel:${posted.id}`, label: '🗑️ Unpublish last', keywords: ['unpublish', 'delete', 'remove'] });
  }
  return adminScreen(sock, jid, { title: '⭐ Reviews', text: lines.join('\n'), buttons, choices, note });
}

async function broadcastHeldReviews(sock, jid, user) {
  const actor = adminName(jid, user.pushName);
  const held = allReviews().filter((r) => r.stars >= 4 && r.broadcast !== 'posted');
  if (held.length === 0) {
    return showReviews(sock, jid, '⚠️ Broadcast ke liye koi held review nahi (sirf ≥4★ eligible hote hain).');
  }
  let ok = 0;
  for (const r of held.slice(0, 5)) {
    const text = [
      '*🔥 Real Customer, Real Review!*',
      `📦 Just delivered: ${r.plan}`,
      `${'⭐'.repeat(r.stars)} "${r.comment || 'Great service!'}"`,
      r.firstName ? `— ${r.firstName}` : '— Verified Customer',
    ].join('\n');
    const posted = await postToChannel(sock, text);
    if (posted.ok) {
      ok += 1;
      updateReview(r.id, { broadcast: 'posted', channelJid: posted.jid, channelMsgId: posted.key || null });
    }
  }
  appendAudit({ actor: jidUser(jid), role: roleFor(jid), action: 'reviews.broadcast', target: `${ok}/${held.length}`, detail: actor });
  return showReviews(sock, jid, `📣 ${ok}/${held.length} review(s) channel par post ho gaye.`);
}

async function unpublishReview(sock, jid, user, reviewId) {
  const review = allReviews().find((r) => r.id === reviewId);
  if (!review) return sendText(sock, jid, `❌ Review *${reviewId}* nahi mili.`);
  if (!review.channelJid || !review.channelMsgId) {
    return showReviews(sock, jid, `⚠️ ${reviewId} ka channel message id store nahi hua (purana record) — manually channel se delete karein.`);
  }
  try {
    await sock.sendMessage(review.channelJid, {
      delete: { remoteJid: review.channelJid, id: review.channelMsgId, fromMe: true },
    });
    updateReview(reviewId, { broadcast: 'unpublished' });
    appendAudit({ actor: jidUser(jid), role: roleFor(jid), action: 'reviews.unpublish', target: reviewId });
    return showReviews(sock, jid, `🗑️ ${reviewId} channel se hata diya.`);
  } catch (err) {
    logError('reviews.unpublish', err, { reviewId });
    return showReviews(sock, jid, `❌ Unpublish fail: ${err.message}`);
  }
}

// ── Settings screen ───────────────────────────────────────────
const VERIFIER_CYCLE = { off: 'shadow', shadow: 'on', on: 'off' };
const VERIFIER_LABEL = { off: 'OFF', shadow: 'SHADOW (log only)', on: 'ON (auto-confirm)' };

async function showSettings(sock, jid, note) {
  const s = getSettings();
  const lines = [
    '⚙️ *Bot Settings*',
    '',
    `🤖 Maintenance: ${s.maintenance ? 'ON (customers see maintenance reply)' : 'OFF'}`,
    `💳 Auto-verifier: ${VERIFIER_LABEL[s.autoVerifier] || s.autoVerifier}`,
    `🛒 Accept new orders: ${s.acceptOrders ? 'ON' : 'OFF'}`,
    `⭐ Review broadcast: ${s.reviewBroadcast ? 'ON' : 'OFF'}`,
    `🌐 Default language: ${s.defaultLang === 'en' ? 'English' : 'Roman Urdu'}`,
    `🕙 Quiet hours: ${s.quietHours.enabled ? `ON (${s.quietHours.start}:00–${s.quietHours.end}:00 PKT)` : 'OFF'}`,
    '',
    'Row tap karke toggle karein — har toggle confirm screen dikhata hai.',
  ].join('\n');

  const rows = [
    { id: 'adm:set:maintenance', title: '🤖 Maintenance mode', description: s.maintenance ? 'ON — tap to turn OFF' : 'OFF — tap to turn ON' },
    { id: 'adm:set:verifier', title: '💳 Auto-verifier', description: VERIFIER_LABEL[s.autoVerifier] },
    { id: 'adm:set:accept', title: '🛒 Accept new orders', description: s.acceptOrders ? 'ON' : 'OFF' },
    { id: 'adm:set:reviewb', title: '⭐ Review broadcast', description: s.reviewBroadcast ? 'ON' : 'OFF' },
    { id: 'adm:set:lang', title: '🌐 Default language', description: s.defaultLang === 'en' ? 'English' : 'Roman Urdu' },
    { id: 'adm:set:quiet', title: '🕙 Quiet hours', description: s.quietHours.enabled ? `ON ${s.quietHours.start}–${s.quietHours.end} PKT` : 'OFF' },
    { id: 'adm:set:msg', title: '✏️ Maintenance message', description: 'Customer ko kya dikhana hai' },
    { id: 'adm:set:brand', title: '🎨 Brand name', description: s.brandName || `${BRAND.name} (.env)` },
    { id: 'adm:set:tagline', title: '🎨 Brand tagline', description: s.brandTagline || `${BRAND.tagline} (.env)` },
  ];

  return adminScreen(sock, jid, {
    title: '⚙️ Bot Settings',
    text: lines,
    list: { buttonText: 'Setting', sections: [{ title: 'Settings', rows }] },
    note,
  });
}

const SETTING_TOGGLES = {
  maintenance: (s) => ({ maintenance: !s.maintenance }),
  accept: (s) => ({ acceptOrders: !s.acceptOrders }),
  reviewb: (s) => ({ reviewBroadcast: !s.reviewBroadcast }),
  lang: (s) => ({ defaultLang: s.defaultLang === 'en' ? 'ur' : 'en' }),
  quiet: (s) => ({ quietHours: { ...s.quietHours, enabled: !s.quietHours.enabled } }),
  verifier: (s) => ({ autoVerifier: VERIFIER_CYCLE[s.autoVerifier] || 'off' }),
};

const SETTING_NAME = {
  maintenance: 'Maintenance mode',
  accept: 'Accept new orders',
  reviewb: 'Review broadcast',
  lang: 'Default language',
  quiet: 'Quiet hours',
  verifier: 'Auto-verifier',
  brand: 'Brand name',
  tagline: 'Brand tagline',
};

async function confirmSetting(sock, jid, key) {
  const s = getSettings();
  if (key === 'msg') {
    setUser(jid, { adminInput: 'maintenance_msg', adminPayload: null });
    return sendText(sock, jid, `Current message:\n\n${s.maintenanceMsg}\n\nNaya message type karein (ya *cancel*).`);
  }
  if (key === 'brand') {
    setUser(jid, { adminInput: 'brand_name', adminPayload: null });
    return sendText(
      sock,
      jid,
      `?? Brand name abhi: *${s.brandName || `${BRAND.name} (.env)`}*\n` +
        'Poore bot ka naam badlega (welcome, menus, receipts, footer).\n' +
        'Naya type karein — e.g. `Simfly Store` — ya `reset` (.env wapas).'
    );
  }
  if (key === 'tagline') {
    setUser(jid, { adminInput: 'brand_tagline', adminPayload: null });
    return sendText(
      sock,
      jid,
      `?? Tagline abhi: *${s.brandTagline || `${BRAND.tagline} (.env)`}*\n` +
        'Naya type karein — e.g. `Har Cheez Digital` — ya `reset`.'
    );
  }
  const patch = SETTING_TOGGLES[key]?.(s);
  if (!patch) return showSettings(sock, jid, '❌ Unknown setting.');
  const after = Object.entries(patch)[0];
  const value = after[1] === true ? 'ON' : after[1] === false ? 'OFF' : String(after[1]);
  return adminScreen(sock, jid, {
    title: `⚙️ ${SETTING_NAME[key] || key}`,
    text: [
      `*${SETTING_NAME[key] || key}* → *${value}*?`,
      '',
      key === 'maintenance' && patch.maintenance
        ? `Customers ko ye message jayega:\n"${s.maintenanceMsg}"`
        : 'Change foran apply hoga aur audit log me record hoga.',
    ].join('\n'),
    buttons: [
      { id: `adm:setdo:${key}`, text: '✅ Yes, apply' },
      { id: 'adm:settings', text: '❌ Cancel' },
    ],
    choices: [
      { id: `adm:setdo:${key}`, label: '✅ Yes, apply', keywords: ['yes', 'apply', 'confirm'] },
      { id: 'adm:settings', label: '❌ Cancel', keywords: ['cancel', 'no', 'back'] },
    ],
  });
}

async function applySetting(sock, jid, user, key) {
  const patch = SETTING_TOGGLES[key]?.(getSettings());
  if (!patch) return showSettings(sock, jid, '❌ Unknown setting.');
  const before = getSettings()[Object.keys(patch)[0]];
  setSettings(patch);
  const after = getSettings()[Object.keys(patch)[0]];
  appendAudit({
    actor: jidUser(jid), role: roleFor(jid), action: 'settings.toggle', target: key,
    detail: `${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
  });
  return showSettings(sock, jid, `✅ ${SETTING_NAME[key] || key} updated.`);
}

async function showDashboard(sock, jid) {
  // The bundled dashboard (dashboard/server.js) wins when its port is
  // open; DASHBOARD_URL stays as the link to an external dashboard.
  const url = dashboardUrl() || SETTINGS.dashboardUrl;
  if (!url) {
    return adminScreen(sock, jid, {
      title: '🌐 Dashboard',
      text: [
        'Bundled dashboard band hai (DASHBOARD_PORT 0 ya khaali).',
        '',
        'Enable karne ke liye `.env` me:',
        '`DASHBOARD_PORT=8787`',
        '`DASHBOARD_TOKEN=some-long-secret`',
        '',
        'Ya koi bahar ka dashboard link set karein:',
        '`DASHBOARD_URL=https://…` (.env) phir dobara yahan tap karein.',
      ].join('\n'),
      buttons: [{ id: 'adm:settings', text: '⚙️ Bot Settings' }],
      choices: [{ id: 'adm:settings', label: '⚙️ Bot Settings', keywords: ['settings'] }],
    });
  }
  return adminScreen(sock, jid, {
    title: '🌐 Dashboard',
    text: `Apna dashboard kholein:\n${url}`,
    buttons: [
      { id: 'dash_open', url, text: '🌐 Open Dashboard' },
      { id: 'adm:pending', text: '🔔 Pending Orders' },
    ],
    choices: [{ id: 'adm:pending', label: '🔔 Pending Orders', keywords: ['pending', 'orders'] }],
  });
}

// ── Input modes (typed follow-ups) ────────────────────────────
async function handleAdminInput(sock, jid, user, text) {
  const mode = user.adminInput;
  if (!mode) return false;

  if (/^(cancel|stop|back)$/i.test(text)) {
    setUser(jid, { adminInput: null, adminPayload: null });
    return openPanel(sock, jid, '❌ Cancelled.');
  }

  switch (mode) {
    case 'find':
      setUser(jid, { adminInput: null, adminPayload: null });
      return runFind(sock, jid, user, text);
    case 'price': {
      const planId = user.adminPayload;
      setUser(jid, { adminInput: null, adminPayload: null });
      return applyPrice(sock, jid, user, planId, text);
    }
    case 'block':
      setUser(jid, { adminInput: null, adminPayload: null });
      return runBlock(sock, jid, user, text);
    case 'rej_reason': {
      const orderId = user.adminPayload;
      setUser(jid, { adminInput: null, adminPayload: null, flow: 'admin' });
      return runReject(sock, jid, orderId, text);
    }
    case 'paylink':
      setUser(jid, { adminInput: null, adminPayload: null });
      return linkPaymentFlow(sock, jid, user, text);
    case 'maintenance_msg':
      setSettings({ maintenanceMsg: text });
      appendAudit({ actor: jidUser(jid), role: roleFor(jid), action: 'settings.message', detail: text.slice(0, 80) });
      setUser(jid, { adminInput: null, adminPayload: null });
      return showSettings(sock, jid, '✅ Maintenance message updated.');
    case 'brand_name':
    case 'brand_tagline': {
      const isName = mode === 'brand_name';
      const field = isName ? 'brandName' : 'brandTagline';
      const reset = /^(reset|clear|default|env)$/i.test(text);
      const value = reset ? '' : String(text).trim().slice(0, 40);
      setSettings({ [field]: value });
      appendAudit({
        actor: jidUser(jid), role: roleFor(jid), action: 'settings.brand',
        target: isName ? 'name' : 'tagline', detail: reset ? 'reset to .env' : value,
      });
      setUser(jid, { adminInput: null, adminPayload: null });
      return showSettings(sock, jid, `✅ Branding updated → *${BRAND.name}* · ${BRAND.tagline}`);
    }
    case 'add_admin':
    case 'channel_link':
    case 'group_jid':
    case 'group_update':
      return handleTeamInput(sock, jid, user, text);
    case 'broadcast':
      return composeBroadcast(sock, jid, user, text);
    default:
      // 🛍️ store / 💰 wallet prompts own their own input modes.
      if (typeof mode === 'string' && mode.startsWith('store_')) {
        return handleStoreInput(sock, jid, user, text);
      }
      if (typeof mode === 'string' && mode.startsWith('sale_')) {
        return handleSalesInput(sock, jid, user, text);
      }
      if (typeof mode === 'string' && mode.startsWith('wallet_')) {
        return handleWalletInput(sock, jid, user, text);
      }
      setUser(jid, { adminInput: null, adminPayload: null });
      return false;
  }
}

async function linkPaymentFlow(sock, jid, user, text) {
  const raw = String(text || '').trim().toUpperCase();
  const order = getOrder(raw)
    || getOrder(`SMF-${String(Number(raw)).padStart(4, '0')}`)
    || allOrders().find((o) => o.id.toUpperCase() === raw);
  if (!order) return sendText(sock, jid, `❌ Order *${text}* nahi mila — dobara type karein ya *cancel* likhein.`);
  const txn = user.adminPayload;
  const res = linkPayment(txn, order.id, adminName(jid, getUser(jid).pushName));
  if (!res.ok) return sendText(sock, jid, `❌ ${res.reason}`);
  appendAudit({ actor: jidUser(jid), role: roleFor(jid), action: 'payment.link', target: order.id, detail: txn });
  return sendOrderCard(sock, jid, order, { note: `✅ ${txn} → ${order.id} linked.` });
}

// ── Entry point: all `adm:` ids + admin-only input ────────────
export async function handleAdminId(sock, jid, user, id) {
  if (!id || !id.startsWith('adm:')) return false;
  if (!roleFor(jid)) return false;

  const parts = id.split(':');
  const [, cmd, a, b] = parts;

  // Delegated screens live in their own modules.
  if (id.startsWith('adm:plan')) return handlePlansId(sock, jid, user, id);
  if (id.startsWith('adm:bc')) return handleBroadcastId(sock, jid, user, id);
  if (id.startsWith('adm:team')) return handleTeamId(sock, jid, user, id);
  if (id.startsWith('adm:comms')) return handleCommsId(sock, jid, user, id);
  if (id.startsWith('adm:store')) return handleStoreId(sock, jid, user, id);
  if (id.startsWith('adm:sale')) return handleSalesId(sock, jid, user, id);
  if (id.startsWith('adm:wallet') || id.startsWith('adm:wal')) return handleWalletId(sock, jid, user, id);

  switch (cmd) {
    case 'menu':
      return openPanel(sock, jid);
    case 'exit': {
      setUser(jid, { flow: 'menu', adminInput: null, adminRelay: null, adminPayload: null, choices: [] });
      return sendWelcome(sock, jid);
    }
    case 'pending':
      return showPending(sock, jid);
    case 'open':
    case 'det':
      return openOrderScreen(sock, jid, a);
    case 'conf': {
      const order = getOrder(a);
      if (!order) return sendText(sock, jid, `❌ Order *${a}* nahi mila.`);
      const v = order.actionVersion || 0;
      if (`v${v}` !== b) {
        return sendText(sock, jid, alreadyActioned(order, jid) || `⚠️ *${a}* ka status badal chuka hai — card dobara kholein.`);
      }
      if (order.price > SETTINGS.confirmTwiceAbove) {
        return adminScreen(sock, jid, {
          title: `⚠️ High value ${order.id}`,
          text: [
            `*High value order* — ${formatPrice(order.price)} (${SETTINGS.confirmTwiceAbove}+ threshold).`,
            '',
            `Dobara tap karein toh supplier se eSIM kharidi jayegi.`,
          ].join('\n'),
          buttons: [
            { id: `adm:conf2:${a}:v${v}`, text: `✅ Yes, confirm ${formatPrice(order.price)}` },
            { id: `adm:rej:${a}:v${v}`, text: '❌ Reject' },
            { id: `adm:det:${a}`, text: '🔍 Details' },
          ],
          choices: [
            { id: `adm:conf2:${a}:v${v}`, label: '✅ Yes, confirm', keywords: ['yes', 'confirm', 'do it'] },
            { id: `adm:rej:${a}:v${v}`, label: '❌ Reject', keywords: ['reject', 'no'] },
            { id: `adm:det:${a}`, label: '🔍 Details', keywords: ['details', 'info'] },
          ],
        });
      }
      return runConfirm(sock, jid, user, a);
    }
    case 'conf2':
      return runConfirm(sock, jid, user, a);
    case 'rej': {
      const order = getOrder(a);
      if (!order) return sendText(sock, jid, `❌ Order *${a}* nahi mila.`);
      const stale = alreadyActioned(order, jid);
      if (stale) return sendText(sock, jid, stale);
      const rows = rejectRows(a);
      setUser(jid, { adminPayload: null, flow: 'admin' });
      return adminScreen(sock, jid, {
        title: `❌ Reject ${a}`,
        text: 'Reason choose karein (customer ko yahi dikhega):',
        list: { buttonText: 'Reason', sections: [{ title: 'Quick reasons', rows }] },
      });
    }
    case 'rejdo':
      return runReject(sock, jid, a, REASON_TEXT[b] || 'Payment not verified');
    case 'rejcustom':
      setUser(jid, { adminInput: 'rej_reason', adminPayload: a, flow: 'admin' });
      return sendText(sock, jid, `✏️ Custom reason type karein for *${a}* (ya *cancel*):`);
    case 'blockof': {
      const order = getOrder(a);
      if (!order) return sendText(sock, jid, `❌ Order *${a}* nahi mila.`);
      return confirmBlock(sock, jid, order.jid);
    }
    case 'msg':
      return startRelay(sock, jid, user, a);
    case 'end':
      return relayMessage(sock, jid, user, 'end');
    case 'retry': {
      const actor = adminName(jid, getUser(jid).pushName);
      const res = await withAck(jid, `⏳ *${a}* dobara bheja ja raha hai…`, () => resendEsim(sock, a, { actor }));
      appendAudit({ actor: jidUser(jid), role: roleFor(jid), action: 'order.resend', target: a, detail: res.ok ? 'ok' : String(res.message).slice(0, 100) });
      await sendText(sock, jid, res.message);
      const order = getOrder(a);
      return order ? sendOrderCard(sock, jid, order) : openPanel(sock, jid);
    }
    case 'undo': {
      const order = getOrder(a);
      if (!order) return sendText(sock, jid, `❌ Order *${a}* nahi mila.`);
      if (order.status !== 'fulfilled') return sendText(sock, jid, `⚠️ *${a}* delivered nahi hai — refund flag sirf delivered orders par lagta hai.`);
      const actor = adminName(jid, user.pushName);
      order.refundNeeded = { at: new Date().toISOString(), by: actor };
      order.actionVersion = (order.actionVersion || 0) + 1;
      putOrder(order);
      flush();
      appendAudit({ actor: jidUser(jid), role: roleFor(jid), action: 'order.refund_flag', target: a, detail: 'no money moved' });
      return sendOrderCard(sock, jid, order, { note: `↩️ ${a} par "Refund needed" flag lag gaya (koi paisa move nahi hua).` });
    }
    case 'stats':
      return showStats(sock, jid, a || 'day');
    case 'find':
      setUser(jid, { adminInput: 'find', adminPayload: null, flow: 'admin' });
      return sendText(sock, jid, '🔍 Order id, mobile number ya customer name type karein:');
    case 'block':
      return showBlocklist(sock, jid);
    case 'blockadd':
      setUser(jid, { adminInput: 'block', adminPayload: null, flow: 'admin' });
      return sendText(sock, jid, '🚫 Block karne ka number type karein (e.g. 923001234567):');
    case 'blockyes':
      return runBlock(sock, jid, user, a);
    case 'unblock':
      return runUnblock(sock, jid, user, a);
    case 'pay':
      return showPayments(sock, jid);
    case 'rescan': {
      const res = await scanInbox();
      appendAudit({ actor: jidUser(jid), role: roleFor(jid), action: 'payments.rescan', detail: res.message.slice(0, 80) });
      return showPayments(sock, jid, res.ok ? '✅ Scan complete.' : `⚠️ ${res.message}`);
    }
    case 'btxrescan': {
      const res = await withAck(jid, '⏳ Binance Pay history fetch ho rahi hai…', () => binanceRescan());
      const msg = res?.ok
        ? `✅ ${res.scanned} transaction fetch hue (cache: ${res.cached}${res.truncated ? ' · window capped' : ''}).`
        : `⚠️ ${res?.message || res?.code || 'fetch failed'}`;
      appendAudit({ actor: jidUser(jid), role: roleFor(jid), action: 'payments.binance_fetch', detail: msg.slice(0, 80) });
      return showPayments(sock, jid, msg);
    }
    case 'paylink':
      return startPayLink(sock, jid, user);
    case 'paytxn':
      setUser(jid, { adminInput: 'paylink', adminPayload: a, flow: 'admin' });
      return sendText(sock, jid, `📎 *${a}* ke liye order id type karein (e.g. SMF-0001):`);
    case 'reviews':
      return showReviews(sock, jid);
    case 'revbc':
      return broadcastHeldReviews(sock, jid, user);
    case 'revdel':
      return unpublishReview(sock, jid, user, a);
    case 'settings':
      return showSettings(sock, jid);
    case 'set':
      return confirmSetting(sock, jid, a);
    case 'setdo':
      return applySetting(sock, jid, user, a);
    case 'dashboard':
      return showDashboard(sock, jid);
    case 'plans':
      return openPlans(sock, jid);
    case 'bc':
      return openBroadcast(sock, jid);
    default:
      return false;
  }
}

/**
 * Single entry the router calls for every message from a JID that
 * holds an admin role. Returns true when the message was consumed.
 */
export async function handleAdminMessage(sock, jid, user, parsed, rawMsg) {
  const role = roleFor(jid);
  if (!role) return false;

  // 1. Tapped button / list row from any admin screen.
  if (parsed.command && parsed.command.startsWith('adm:')) {
    return handleAdminId(sock, jid, user, parsed.command);
  }

  const text = (parsed.text || '').trim();

  // 2. The admin keyword ALWAYS opens the panel list — even while a
  //    relay or an input prompt is pending (openPanel clears both).
  if (parsed.channel !== 'interactive') {
    const kw = text.toLowerCase();
    if (kw === 'admin' || kw === '/admin' || kw === 'panel' || kw === 'admin panel') {
      return openPanel(sock, jid);
    }
  }

  // 3. Message relay: the admin's next text goes to the customer.
  if (user.adminRelay) {
    if (parsed.media && !text) {
      setUser(jid, { adminRelay: null });
      await sendText(sock, jid, '🔚 Relay band — sirf text forward hota hai.');
      return true;
    }
    if (!text) return true;
    if (parsed.channel === 'interactive' && parsed.command !== 'adm:end') {
      setUser(jid, { adminRelay: null });
      return false; // let a nav tap leave the relay
    }
    return relayMessage(sock, jid, user, text);
  }

  // 4. A pending input mode (find / price / block / compose / …).
  if (user.adminInput && text) {
    return handleAdminInput(sock, jid, user, text);
  }
  if (user.adminInput && parsed.media?.type === 'image') {
    return attachBroadcastImage(sock, jid, user, rawMsg);
  }
  if (user.adminInput && parsed.media) return true;

  if (!text) return false;

  // 5. Typed admin commands (confirm / reject / status / bot …) are
  //    handled by handlers/admin.js — never let a screen choice
  //    like "reject" swallow `reject SMF-0001 reason`.
  const TYPED_ADMIN = /^(confirm|reject|status|orders|pending|all\s+orders|history|bot\s+(on|off)|admin\s*help|adminhelp)\b/i;
  if (TYPED_ADMIN.test(text)) return false;

  // 6. Screen triggers + quick commands.
  const lower = text.toLowerCase();
  if (await quickCommand(sock, jid, user, text, lower)) return true;

  // 7. Choice matching while a screen is open (typed / numbered).
  if (user.flow === 'admin' && Array.isArray(user.choices) && user.choices.length) {
    const matched = matchChoice(parsed.command || text, user.choices);
    if (matched) {
      if (matched.via === 'number' || matched.via === 'label') setUser(jid, { seesButtons: false });
      return handleAdminId(sock, jid, user, matched.choice.id);
    }
  }

  return false;
}

/** Typed admin shortcuts: pending / stats / find / price / block / bot. */
async function quickCommand(sock, jid, user, text, lower) {
  if (/^(pending|orders|queue)$/.test(lower)) return showPending(sock, jid);
  if (/^stats$/.test(lower) || /^stats\s+(day|week|month)$/.test(lower)) {
    return showStats(sock, jid, lower.split(/\s+/)[1] || 'day');
  }
  if (/^find\s+\S+/.test(text)) {
    return runFind(sock, jid, user, text.replace(/^find\s+/i, ''));
  }
  if (/^price\s+\S+\s+\d+/.test(text)) {
    const [, planId, amount] = text.split(/\s+/);
    return applyPrice(sock, jid, user, planId, amount);
  }
  if (/^block\s+\S+/.test(text)) {
    return runBlock(sock, jid, user, text.replace(/^block\s+/i, ''));
  }
  if (/^unblock\s+\S+/.test(text)) {
    return runUnblock(sock, jid, user, text.replace(/^unblock\s+/i, ''));
  }
  return false;
}

/** Exported for the daily summary / alerts module. */
export { STATUS_TEXT, locks as __orderLocks };
