// ─────────────────────────────────────────────────────────────
// handlers/adminSales.js
// 🎟️ Admin side of SALE CODES (admin-launched deal codes).
//
//   adm:sales        list + create
//   adm:salenew      typed prompt: `CODE, percent[, days[, maxUses]]`
//   adm:saleitem:<c> one code: info, toggle, delete
//   adm:saleon:<c>   activate / pause
//   adm:saledel:<c>  delete
//
// Customers type the code at the payment step (🎟️ Sale code) and
// get % off BOTH catalogues — logic lives in lib/sales.js.
// ─────────────────────────────────────────────────────────────
import { jidUser } from '../config.js';
import { sendText } from '../lib/ui.js';
import { setUser } from '../lib/store.js';
import { adminScreen, adminNav } from './adminPanel.js';
import { appendAudit, roleFor } from '../lib/admins.js';
import { allSales, createSale, deleteSale, getSale, toggleSale } from '../lib/sales.js';

const backBtn = { id: 'adm:menu', text: '⬅️ Panel' };

const when = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

// ── 1. List ──────────────────────────────────────────────────
export async function openSales(sock, jid, note) {
  const sales = allSales();

  const rows = sales.slice(0, 20).map((s) => {
    const until = when(s.endsAt);
    return {
      id: `adm:saleitem:${s.code}`,
      title: `${s.active ? '🟢' : '⚪'} ${s.code} — ${s.percentOff}% off`,
      description: `${s.uses || 0}/${s.maxUses} uses${until ? ` · till ${until}` : ' · no expiry'}`,
      keywords: [String(s.code).toLowerCase()],
    };
  });

  const buttons = [
    { id: 'adm:salenew', text: '➕ New sale code' },
    { id: 'adm:menu', text: '⬅️ Panel' },
  ];
  const choices = [
    ...rows.map((r) => ({ id: r.id, label: r.title, keywords: r.keywords })),
    ...adminNav(buttons).map((b) => ({ id: b.id, label: b.text, keywords: b.text.toLowerCase().split(/\s+/) })),
  ];

  const live = sales.filter((s) => s.active).length;
  return adminScreen(sock, jid, {
    title: '🎟️ Sale Codes',
    text: [
      note ? `${note}\n` : '',
      `Codes: *${sales.length}* · active: ${live}`,
      '',
      'Customer payment step par *🎟️ Sale code* tap karke code likhta hai — dono catalogues (eSIM + Digital) par lagta hai.',
      '',
      'Format for a new code: `CODE, percent[, days[, maxUses]]`',
      'e.g. `EID20,20,7,200`',
    ].filter(Boolean).join('\n'),
    list: rows.length
      ? { buttonText: 'Code', sections: [{ title: 'Sale codes', rows }] }
      : null,
    buttons,
    choices,
  });
}

// ── 2. One code ──────────────────────────────────────────────
export async function openSaleItem(sock, jid, code, note) {
  const sale = getSale(code);
  if (!sale) {
    return adminScreen(sock, jid, {
      title: '🎟️ Sale code',
      text: `❌ Code *${code}* nahi mila.`,
      buttons: [{ id: 'adm:sales', text: '🎟️ Sale Codes' }],
      choices: [{ id: 'adm:sales', label: '🎟️ Sale Codes', keywords: ['back'] }],
    });
  }

  const until = when(sale.endsAt);
  const buttons = [
    { id: `adm:saleon:${sale.code}`, text: sale.active ? '⏸ Pause code' : '▶️ Activate code' },
    { id: `adm:saledel:${sale.code}`, text: '🗑 Delete code' },
    { id: 'adm:sales', text: '⬅️ All codes' },
  ];

  return adminScreen(sock, jid, {
    title: `🎟️ ${sale.code}`,
    text: [
      note ? `${note}\n` : '',
      `📉 Discount: *${sale.percentOff}% off*`,
      `Status: ${sale.active ? '🟢 active' : '⚪ paused'}`,
      `🧾 Uses: *${sale.uses || 0}* / ${sale.maxUses}`,
      `📅 Valid: ${when(sale.createdAt) || '—'}${until ? ` → ${until}` : ' → no expiry'}`,
      '',
      'Customer ko payment step par *🎟️ Sale code* button milta hai.',
    ].filter(Boolean).join('\n'),
    buttons,
    choices: buttons.map((b) => ({ id: b.id, label: b.text, keywords: b.text.toLowerCase().split(/\s+/) })),
  });
}

// ── 3. id dispatch ───────────────────────────────────────────
export async function handleSalesId(sock, jid, user, id) {
  const [, cmd, a] = id.split(':');

  switch (cmd) {
    case 'sales':
      return openSales(sock, jid);
    case 'saleitem':
      return openSaleItem(sock, jid, a);
    case 'salenew':
      setUser(jid, { adminInput: 'sale_new', adminPayload: null, flow: 'admin' });
      return sendText(
        sock,
        jid,
        '➕ Naya sale code type karein — format:\n`CODE, percent[, days[, maxUses]]`\n\n' +
          'e.g. `EID20,20,7,200` (20% off, 7 din, 200 uses)\n' +
          'e.g. `WELCOME10,10` (10% off, no expiry)\n\n' +
          '*cancel* likhein waapis jane ke liye.'
      );
    case 'saleon': {
      const sale = toggleSale(a);
      if (!sale) return openSales(sock, jid, `❌ Code *${a}* nahi mila.`);
      appendAudit({
        actor: jidUser(jid), role: roleFor(jid), action: 'sale.toggle',
        target: sale.code, detail: sale.active ? 'active' : 'paused',
      });
      return openSaleItem(sock, jid, sale.code, sale.active ? '▶️ Code activated.' : '⏸ Code paused.');
    }
    case 'saledel': {
      const ok = deleteSale(a);
      appendAudit({ actor: jidUser(jid), role: roleFor(jid), action: 'sale.delete', target: String(a), detail: ok ? 'deleted' : 'not found' });
      return openSales(sock, jid, ok ? `🗑 Code *${a}* deleted.` : `❌ Code *${a}* nahi mila.`);
    }
    default:
      return false;
  }
}

// ── 4. typed input ───────────────────────────────────────────
export async function handleSalesInput(sock, jid, user, text) {
  const value = String(text || '').trim();
  setUser(jid, { adminInput: null, adminPayload: null });

  if (/^(cancel|back|stop)$/i.test(value)) {
    return openSales(sock, jid, '❎ Cancel — koi code nahi bana.');
  }

  const parts = value.split(/[,\s]+/).filter(Boolean);
  const code = parts[0] || '';
  const percentOff = Number(parts[1]);
  const days = parts[2] !== undefined ? Number(parts[2]) : 0;
  const maxUses = parts[3] !== undefined ? Number(parts[3]) : 1000;

  const res = createSale({
    code,
    percentOff,
    days: Number.isFinite(days) && days > 0 ? days : 0,
    maxUses: Number.isFinite(maxUses) && maxUses > 0 ? maxUses : 1000,
    createdBy: jidUser(jid),
  });

  if (!res.ok) {
    return sendText(sock, jid, `❌ ${res.error}\nDobara type karein: \`CODE, percent[, days[, maxUses]]\` ya *cancel* likhein.`);
  }

  appendAudit({
    actor: jidUser(jid), role: roleFor(jid), action: 'sale.create',
    target: res.code, detail: `${res.sale.percentOff}% · max ${res.sale.maxUses} · ${res.sale.endsAt ? `till ${when(res.sale.endsAt)}` : 'no expiry'}`,
  });
  return openSaleItem(sock, jid, res.code, '✅ Sale code ban gaya.');
}
