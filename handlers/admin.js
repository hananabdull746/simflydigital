// ─────────────────────────────────────────────────────────────
// handlers/admin.js
// Text commands the ADMIN sends from their own WhatsApp chat.
// No dashboard, no paid DB — just type a line.
//
//   confirm SMF-0001            -> deliver eSIM to the customer
//   reject  SMF-0001 reason     -> tell the customer it's rejected
//   status  SMF-0001            -> local + supplier-side status
//   orders                      -> list orders waiting on you
//   human  923001234567 <msg>   -> reply to a human-mode customer
//   admin help                  -> show this list
// ─────────────────────────────────────────────────────────────
import { BRAND, formatPrice, jidUser, toJid } from '../config.js';
import { sendText } from '../lib/ui.js';
import { allOrders, pendingOrders, getOrder, getUser } from '../lib/store.js';
import { confirmOrder, rejectOrder } from './orders.js';
import { withAck } from './ui.js';
import { clearHuman, humanActive, setHuman, humanMinutes } from '../lib/sessions.js';
import { getOrderStatus } from '../services/esimaccess.js';
import { appendAudit, adminName, roleFor } from '../lib/admins.js';
import { endRelayFor } from './adminPanel.js';
import { armHumanExpiry } from './human.js';
import { logAdmin } from '../lib/logger.js';

const STATUS_LABEL = {
  await_screenshot: '⏳ awaiting screenshot',
  awaiting_screenshot: '⏳ awaiting screenshot',
  pending_admin: '🔍 needs your confirmation',
  fulfilled: '✅ delivered',
  rejected: '🚫 rejected',
  cancelled: '⛔ cancelled',
};

/** Normalise anything like "smf-1", "SMF 0001", "0001" -> "SMF-0001". */
function normalizeOrderId(token) {
  if (!token) return null;
  const match = String(token).match(/smf[-\s]?(\d{1,6})/i) || String(token).match(/^(\d{1,6})$/);
  if (!match) return null;
  return `SMF-${String(Number(match[1])).padStart(4, '0')}`;
}

export const ADMIN_HELP = [
  `*${BRAND.name} — Admin Commands* 🛠️`,
  '',
  '`admin` → 🛠️ Admin Panel (buttons + lists)',
  '`confirm SMF-0001` → eSIM customer ko bhej dein',
  '`reject SMF-0001 reason` → customer ko inform karein',
  '`status SMF-0001` → order + supplier status dekhein',
  '`orders` → orders jo aapki confirmation ka intezar kar rahe hain',
  '`pending` / `stats` / `find <text>` → jaldi se dekhein',
  '`price <planId> <amount>` → price foran change',
  '`block <number>` / `unblock <number>` → blocklist',
  '`all orders` → aakhri 10 orders (har status)',
  '`bot on 923001234567` → human mode khatam karke bot wapas chalu karein',
  '`bot off 923001234567` → us customer ke liye bot band',
  `\`human 923001234567 <msg>\` → human-mode customer ko reply (phir ${humanMinutes()} min ke liye bot chup)`,
  '`admin help` → ye list',
  '',
  'Ye commands aap apni *personal chat with the bot* me type karein — koi button zaroori nahi.',
  'Role: owner = sab kuch, staff = orders/customers/support only.',
].join('\n');

/** True when this JID holds an owner or staff role (lib/admins). */
export function isAdminJid(jid) {
  return roleFor(jid) !== null;
}

/**
 * Try to interpret an admin command.
 * @returns {Promise<boolean>} true when the message was consumed.
 */
export async function tryAdminCommand(sock, jid, text) {
  const role = roleFor(jid);
  if (!role) return false;

  const raw = String(text || '').trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  logAdmin('command', { from: jidUser(jid), role, text: raw.slice(0, 80) });
  const actor = adminName(jid, getUser(jid).pushName);

  // ── confirm (with an instant supplier-purchase ack) ───────
  if (/^confirm\b/i.test(raw)) {
    const id = normalizeOrderId(raw.split(/\s+/)[1]);
    if (!id) {
      await sendText(sock, jid, 'Format: `confirm SMF-0001`');
      return true;
    }
    // Instant "⏳ working…" ack; the real result message follows.
    const result = await withAck(jid, '⏳ Supplier se eSIM kharida ja raha hai…', () =>
      confirmOrder(sock, id, { actor }));
    appendAudit({ actor: jidUser(jid), role, action: 'order.confirm', target: id, detail: result.ok ? 'typed command' : 'failed' });
    await sendText(sock, jid, result.message);
    return true;
  }

  // ── bot on <number>: end human mode early ────────────────
  if (/^bot\s+on\b/i.test(raw)) {
    // "bot on 923001234567" → the number is the THIRD token.
    const target = toJid(raw.trim().split(/\s+/)[2] || '');
    if (!target) {
      await sendText(sock, jid, 'Format: `bot on 923001234567`');
      return true;
    }
    const wasHuman = clearHuman(target);
    endRelayFor(target);
    appendAudit({ actor: jidUser(jid), role, action: 'bot.on', target: jidUser(target) });
    await sendText(
      sock,
      jid,
      wasHuman || !humanActive(target)
        ? `✅ Bot wapas active hai for +${jidUser(target)} — customer ko reply kar sakte hain.`
        : `❌ Koi human mode active nahi hai for +${jidUser(target)}.`
    );
    return true;
  }

  // ── bot off <number>: hand this customer to the humans ───
  if (/^bot\s+off\b/i.test(raw)) {
    const target = toJid(raw.trim().split(/\s+/)[2] || '');
    if (!target) {
      await sendText(sock, jid, 'Format: `bot off 923001234567`');
      return true;
    }
    const session = setHuman(target);
    armHumanExpiry(sock, target, session.humanUntil);
    appendAudit({ actor: jidUser(jid), role, action: 'bot.off', target: jidUser(target) });
    await sendText(sock, jid, `🛑 Bot band for +${jidUser(target)} (${humanMinutes()} min human mode). Wapas chalu karne ke liye \`bot on ${jidUser(target)}\`.`);
    return true;
  }

  // ── human <number> <message>: reply to a human-mode customer ──
  //    (also (re)opens the window, so the bot stays quiet while
  //     the team talks — same silence `bot off` sets up)
  if (/^human\b/i.test(raw)) {
    const parts = raw.split(/\s+/);
    const target = toJid(parts[1] || '');
    const msg = parts.slice(2).join(' ').trim();
    if (!target || !msg) {
      await sendText(sock, jid, 'Format: `human 923001234567 aapka sawaal` — customer ko bot ke through reply jayega aur human mode barhega.');
      return true;
    }
    const session = setHuman(target);
    armHumanExpiry(sock, target, session.humanUntil);
    await sendText(sock, target, msg);
    appendAudit({ actor: jidUser(jid), role, action: 'human.reply', target: jidUser(target), detail: msg.slice(0, 80) });
    await sendText(sock, jid, `✅ Reply +${jidUser(target)} ko bhej diya (human mode ${humanMinutes()} min barha).`);
    return true;
  }

  // ── reject ────────────────────────────────────────────────
  if (/^reject\b/i.test(raw)) {
    const parts = raw.split(/\s+/);
    const id = normalizeOrderId(parts[1]);
    if (!id) {
      await sendText(sock, jid, 'Format: `reject SMF-0001 reason`');
      return true;
    }
    const reason = parts.slice(2).join(' ') || 'Payment not verified';
    const result = await rejectOrder(sock, id, reason, { actor });
    appendAudit({ actor: jidUser(jid), role, action: 'order.reject', target: id, detail: `${reason} (typed command)` });
    await sendText(sock, jid, result.message);
    return true;
  }

  // ── status (local record + supplier-side state) ───────────
  if (/^status\b/i.test(lower)) {
    const id = normalizeOrderId(raw.split(/\s+/)[1]);
    if (!id) {
      await sendText(sock, jid, 'Format: `status SMF-0001`');
      return true;
    }
    const order = getOrder(id);
    if (!order) {
      await sendText(sock, jid, `❌ Order *${id}* nahi mila.`);
      return true;
    }

    const lines = [
      `🎫 *${order.id}* — ${STATUS_LABEL[order.status] || order.status}`,
      `📶 ${order.planName} • ${formatPrice(order.price)}`,
      `💳 ${order.paymentLabel} • 👤 +${order.phone}`,
      `📅 Placed: ${new Date(order.createdAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`,
    ];

    if (order.supplierOrderId) {
      const s = await getOrderStatus(order.supplierOrderId);
      lines.push(
        `🔗 Supplier ${order.supplierOrderId}: ${s.ok ? s.status : `unreachable (${s.error || 'error'})`}`
      );
    } else if (order.status === 'fulfilled') {
      lines.push('🔗 Fulfillment: manual (koi supplier ref nahi)');
    }

    if (order.status === 'pending_admin') {
      lines.push('', `\`confirm ${order.id}\` ya \`reject ${order.id} reason\``);
    }
    await sendText(sock, jid, lines.join('\n'));
    return true;
  }

  // ── pending list ──────────────────────────────────────────
  if (/^(orders|pending|list)$/i.test(lower)) {
    const list = pendingOrders();
    if (list.length === 0) {
      await sendText(sock, jid, '✅ Koi order pending nahi hai. Sab clear hai!');
      return true;
    }
    const body = list
      .map((o) => `• *${o.id}* — ${o.planName} — ${formatPrice(o.price)}\n  +${o.phone} • ${o.paymentLabel}`)
      .join('\n');
    await sendText(sock, jid, `*🔍 Pending confirmation (${list.length})*\n\n${body}\n\n\`confirm SMF-XXXX\` bhejein.`);
    return true;
  }

  // ── all orders ────────────────────────────────────────────
  if (/^all\s+orders$/i.test(lower) || /^history$/i.test(lower)) {
    const list = allOrders().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 10);
    if (list.length === 0) {
      await sendText(sock, jid, 'Abhi tak koi order nahi.');
      return true;
    }
    const body = list
      .map((o) => `• *${o.id}* — ${o.planName} — ${STATUS_LABEL[o.status] || o.status}`)
      .join('\n');
    await sendText(sock, jid, `*📦 Aakhri ${list.length} orders*\n\n${body}`);
    return true;
  }

  // ── help ──────────────────────────────────────────────────
  if (/^(admin\s+help|adminhelp|admin|help admin)$/i.test(lower)) {
    await sendText(sock, jid, ADMIN_HELP);
    return true;
  }

  return false;
}
