// ─────────────────────────────────────────────────────────────
// handlers/adminWallet.js
// 💰 Admin side of the customer Wallet.
//
//   adm:wallet        liability + wallets + pending top-ups
//   adm:waltop:<id>   one top-up order (screenshot verify → credit)
//   adm:walcust:<id>  one customer's balance + last ledger entries
//   adm:waladj:<id>   typed manual adjustment (+/- PKR with reason)
//   adm:walaudit      every ledger row vs every stored balance
//
// ⚠️ The ledger is the source of truth: `auditWallets()` is what
// you run when a customer says "my balance is wrong".
// ─────────────────────────────────────────────────────────────
import { SETTINGS, formatPrice, jidUser } from '../config.js';
import { sendText } from '../lib/ui.js';
import { adminScreen, openOrderScreen } from './adminPanel.js';
import { setUser, allOrders } from '../lib/store.js';
import { adminName, appendAudit, roleFor } from '../lib/admins.js';
import {
  allWallets, adjustBalance, auditWallets, getBalance, ledgerFor, totalLiability,
} from '../services/wallet.js';

const backBtn = { id: 'adm:menu', text: '⬅️ Panel' };
const navChoices = (buttons) => buttons.map((b) => ({ id: b.id, label: b.text, keywords: b.text.toLowerCase().split(/\s+/) }));

// ── 1. Overview ──────────────────────────────────────────────
export async function openWalletAdmin(sock, jid, note) {
  const wallets = allWallets();
  const pendingTopups = allOrders().filter((o) => o.catalogType === 'wallet_topup' && ['await_screenshot', 'pending_admin'].includes(o.status));
  const activePollsCount = allOrders().filter((o) => o.status === 'awaiting_activation').length;
  const audit = auditWallets();

  const rows = wallets.slice(0, 25).map((w) => ({
    id: `adm:walcust:${w.customerId}`,
    title: `${w.customerId.slice(0, 14)}… · ${formatPrice(w.balancePkr)}`,
    description: w.updatedAt ? `updated ${new Date(w.updatedAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}` : 'no activity',
    keywords: [String(w.customerId)],
  }));

  const topupRows = pendingTopups.slice(0, 10).map((o) => ({
    id: `adm:waltop:${o.id}`,
    title: `${o.id} · ${formatPrice(o.price)}`,
    description: `${o.status === 'await_screenshot' ? '⏳ screenshot' : '🔍 verify pending'} · ${o.phone}`,
    keywords: [o.id.toLowerCase()],
  }));

  const buttons = [
    { id: 'adm:walaudit', text: '🔎 Audit' },
    { id: 'adm:pending', text: '🔔 Top-ups' },
    backBtn,
  ];

  const sections = [];
  if (rows.length) sections.push({ title: 'Wallets', rows });
  if (topupRows.length) sections.push({ title: 'Pending top-ups', rows: topupRows });

  return adminScreen(sock, jid, {
    title: '💰 Wallets',
    text: [
      note ? `${note}\n` : '',
      `🏦 Total liability: *${formatPrice(totalLiability())}* (customers ka paisa humare paas)`,
      `👥 Wallets: ${wallets.length} · 💳 Pending top-ups: ${pendingTopups.length} · 📧 Activation polls: ${activePollsCount}`,
      audit.ok ? `✅ Ledger audit: ${audit.checked} wallet(s) — every balance matches its ledger.`
        : `❌ Ledger audit: ${audit.issues.length} mismatch(es) — ${audit.issues.slice(0, 3).map((m) => `${m.customerId} ${formatPrice(m.storedPkr)}≠${formatPrice(m.ledgerSumPkr)}`).join(', ')}`,
      '',
      '⚠️ Sirf tab adjust karein jab customer ka proof ho — har change ledger par likha jata hai.',
    ].filter(Boolean).join('\n'),
    list: sections.length ? { buttonText: 'Open', sections } : null,
    buttons,
    choices: [
      ...navChoices(buttons),
      ...rows.map((r) => ({ id: r.id, label: r.title, keywords: r.keywords })),
      ...topupRows.map((r) => ({ id: r.id, label: r.title, keywords: r.keywords })),
    ],
  });
}

// ── 2. One customer's wallet ────────────────────────────────
export async function openWalletCustomer(sock, jid, customerId) {
  const txs = ledgerFor(customerId, 10);
  const balance = getBalance(customerId);

  const buttons = [
    { id: `adm:waladj:${customerId}`, text: '✏️ Manual adjust' },
    { id: 'adm:wallet', text: '⬅️ Wallets' },
  ];

  return adminScreen(sock, jid, {
    title: `💰 ${customerId}`,
    text: [
      `💵 Balance: *${formatPrice(balance)}*`,
      txs.length ? `\n📜 Last ${txs.length} entries:` : '',
      ...txs.map((tx) => `• ${tx.amountPkr >= 0 ? '+' : '−'}${formatPrice(Math.abs(tx.amountPkr))} ${tx.type}${tx.relatedOrderId ? ` (${tx.relatedOrderId})` : ''} — ${new Date(tx.createdAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`),
      txs.length ? '' : '📜 Koi transaction nahi.',
    ].filter(Boolean).join('\n'),
    buttons,
    choices: navChoices(buttons),
  });
}

// ── 3. id dispatch ───────────────────────────────────────────
export async function handleWalletId(sock, jid, user, id) {
  const parts = id.split(':');
  const [, cmd, a] = parts;

  switch (cmd) {
    case 'wallet':
      return openWalletAdmin(sock, jid);
    case 'walcust':
      return openWalletCustomer(sock, jid, a);
    case 'waltop': {
      const order = allOrders().find((o) => o.id === a);
      if (!order) return sendText(sock, jid, `❌ Top-up *${a}* nahi mila.`);
      return openOrderScreen(sock, jid, order.id);
    }
    case 'waladj':
      setUser(jid, { adminInput: 'wallet_adjust', adminPayload: String(a), flow: 'admin' });
      return sendText(sock, jid, [
        `✏️ Adjustment for *${a}* type karein:`,
        '• `+500 bonus` — paisa add',
        '• `-200 correction` — paisa kaat',
        '',
        'Amount ke saath reason likhna zaroori hai (ya *cancel* likhein).',
      ].join('\n'));
    case 'walaudit': {
      const res = auditWallets();
      return adminScreen(sock, jid, {
        title: '🔎 Wallet audit',
        text: res.ok
          ? `✅ *${res.checked}* wallet/customer id(s) — har balance apni ledger ka sum hai. Total liability ${formatPrice(totalLiability())}.`
          : [
              `❌ *${res.issues.length}* mismatch(es) out of ${res.checked}:`,
              ...res.issues.slice(0, 8).map((m) => `• ${m.customerId}: stored ${formatPrice(m.storedPkr)} vs ledger ${formatPrice(m.ledgerSumPkr)} (drift ${formatPrice(m.driftPkr)})`),
            ].join('\n'),
        buttons: [{ id: 'adm:wallet', text: '⬅️ Wallets' }],
        choices: navChoices([{ id: 'adm:wallet', text: '⬅️ Wallets' }]),
      });
    }
    default:
      return false;
  }
}

/** Typed input (adminPanel's handleAdminInput delegates here). */
export async function handleWalletInput(sock, jid, user, text) {
  const customerId = user.adminPayload;
  const raw = String(text || '').trim();
  const amount = Number(raw.replace(/[^\d.+-]/g, ''));
  const reason = raw.replace(/^[+\-\d.\s]+/, '').trim();

  if (!Number.isFinite(amount) || amount === 0) {
    return sendText(sock, jid, '❌ Amount daalein — e.g. `+500 bonus` ya `-200 correction`.');
  }
  if (amount > 100000 || amount < -100000) {
    return sendText(sock, jid, '❌ Ek adjustment me max ±100,000 PKR (galti se bachne ke liye).');
  }
  if (!reason) {
    return sendText(sock, jid, '❌ Reason likhna zaroori hai — e.g. `+500 goodwill`.');
  }

  const actor = adminName(jid, user.pushName);
  const res = await adjustBalance(customerId, Math.round(amount), 'admin_adjustment', {
    note: reason.slice(0, 80),
    actor,
  });
  setUser(jid, { adminInput: null, adminPayload: null });

  if (!res.ok) return sendText(sock, jid, `❌ Adjust fail (${res.code}).`);
  appendAudit({
    actor: jidUser(jid), role: roleFor(jid), action: 'wallet.adjust',
    target: customerId, detail: `${amount > 0 ? '+' : ''}${Math.round(amount)} — ${reason.slice(0, 60)} (new ${formatPrice(res.balance)})`,
  });
  return openWalletCustomer(sock, jid, customerId);
}
