// ─────────────────────────────────────────────────────────────
// handlers/adminDigital.js
// 🛍️ Admin side of the ProdSeller Digital Store.
//
//   adm:store        catalogue (cost, PKR price, margin, stock)
//   adm:storeitem:<p>  one product: hide/show, USD price, markup,
//                      name, reset
//   adm:storeusd:<p>     typed USD price input (or `reset`)
//   adm:storemarkup:<p> / adm:storemarkupdef  typed % input
//   adm:storerate     typed PKR-per-USD rate input
//   adm:storevis:<p>   visibility toggle (per-product override)
//   adm:storename:<p>  custom customer-facing name
//   adm:storeclr:<p>   drop that product's override
//   adm:storebal      ProdSeller balance (the supplier wallet)
//   adm:storeresh     force a catalogue refresh (kills the 5-min cache)
//
// Pricing lives in lib/digital.js — this file only WRITES the
// override map / default markup / USD rate, never does its own
// maths: sell = USD × rate × (1 + ROI%), all from .env defaults.
// ─────────────────────────────────────────────────────────────
import { SETTINGS, formatPrice, jidUser } from '../config.js';
import { sendText } from '../lib/ui.js';
import { adminScreen, adminNav } from './adminPanel.js';
import { setUser } from '../lib/store.js';
import { adminName, appendAudit, getSettings, setSettings, roleFor } from '../lib/admins.js';
import {
  getProducts, getBalances, __clearCache, isConfigured, supplierLabel,
} from '../services/productCatalog.js';
import { __clearCache as clearSupplierCaches } from '../services/prodseller.js';
import { __clearCache as clearEklasCache } from '../services/eklas.js';
import { adminProducts, allOverrides, upsertOverride } from '../lib/digital.js';
import { activePolls } from '../services/digitalPolls.js';

const ctxFor = () => ({
  overrides: allOverrides(),
  markupPercent: Number.isFinite(Number(getSettings().digitalMarkupPercent))
    ? Number(getSettings().digitalMarkupPercent)
    : undefined,
  rate: rateNow(),
});

/** PKR per USD: admin panel setting → .env USD_PKR_RATE. */
function rateNow() {
  const n = Number(getSettings().usdPkrRate);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function catalog() {
  const res = await getProducts();
  const list = adminProducts(res.products || [], ctxFor());
  const rawById = new Map((res.products || []).map((p) => [String(p.id), p]));
  return { configured: isConfigured() && res.configured !== false, stale: Boolean(res.stale), list, res, rawById };
}

/** One-line "which supplier funds the shelf" summary for the admin screen. */
function supplierSummary(res) {
  const list = res?.products || [];
  const ps = list.filter((p) => p.supplier === 'prodseller').length;
  const ek = list.filter((p) => p.supplier === 'eklas').length;
  const compared = list.filter((p) => p.other).length;
  return `ProdSeller ${ps} · Eklas ${ek}${compared ? ` · ${compared} price-compared` : ''}`;
}

const backBtn = { id: 'adm:menu', text: '⬅️ Panel' };

// ── 1. Catalogue screen ──────────────────────────────────────
export async function openStoreAdmin(sock, jid, note) {
  const { configured, stale, list, rawById, res } = await catalog();

  if (!configured && !list.length) {
    return adminScreen(sock, jid, {
      title: '🛍️ Digital Store',
      text: [
        '⚠️ Koi digital supplier configured nahi hai.',
        '',
        '👉 `.env` me `PRODSELLER_API_KEY=` ya `EKLAS_API_KEY=` set karein, phir *🔁 Refresh* dabayein.',
      ].join('\n'),
      buttons: [backBtn],
      choices: [{ id: 'adm:menu', label: '⬅️ Panel', keywords: ['back', 'panel'] }],
    });
  }

  const rows = list.slice(0, 40).map((p) => {
    const costUsd = Number(p.costUsd ?? rawById.get(String(p.id))?.price ?? 0);
    const rate = rateNow() ?? Number(getSettings().usdPkrRate ?? SETTINGS.usdPkrRate);
    const costPkr = Math.round(costUsd * rate);
    const margin = Math.round(((p.pricePkr - costPkr) / Math.max(1, p.pricePkr)) * 100);
    const overridden = p.override?.costUsd !== undefined && p.override?.costUsd !== null;
    return {
      id: `adm:storeitem:${p.id}`,
      title: `${p.hidden ? '🚫' : p.inStock ? '✅' : '❌'} ${p.name}`,
      description: `${formatPrice(p.pricePkr)} · cost $${costUsd}${overridden ? ' ✏️' : ''} · ${margin}% margin${p.badge ? ` · ${p.badge}` : ''}`,
      keywords: [String(p.name).toLowerCase(), String(p.id)],
    };
  });

  const buttons = [
    { id: 'adm:storeresh', text: '🔁 Refresh' },
    { id: 'adm:storebal', text: '📊 Balance' },
    { id: 'adm:storemarkupdef', text: '✏️ Default Markup' },
    { id: 'adm:storerate', text: '💵 USD Rate' },
    backBtn,
  ];
  const choices = [
    ...rows.map((r) => ({ id: r.id, label: r.title, keywords: r.keywords })),
    ...adminNav(buttons).map((b) => ({ id: b.id, label: b.text, keywords: b.text.toLowerCase().split(/\s+/) })),
  ];

  const defaultMarkup = Number.isFinite(Number(getSettings().digitalMarkupPercent))
    ? Number(getSettings().digitalMarkupPercent)
    : SETTINGS.digitalMarkupPercent;

  return adminScreen(sock, jid, {
    title: '🛍️ Digital Store',
    text: [
      note ? `${note}\n` : '',
      `🧾 Products: *${list.length}* · visible: ${list.filter((p) => !p.hidden).length}`,
      `📈 Default markup: *${defaultMarkup}%*  (rate ${rateNow() ?? SETTINGS.usdPkrRate} PKR/USD)`,
      `📧 Activation products: ${list.filter((p) => p.requiresEmailActivation).length} (poll chal raha hai: ${activePolls().length})`,
      stale ? '⚠️ Catalogue cached — 🔁 Refresh karein.' : '',
      configured ? `✅ Suppliers: ${supplierSummary(res)}` : '⚠️ Supplier key missing',
    ].filter(Boolean).join('\n'),
    list: rows.length ? { buttonText: 'Product', sections: [{ title: 'Products', rows }] } : null,
    buttons,
    choices,
  });
}

// ── 2. One product ───────────────────────────────────────────
export async function openStoreItem(sock, jid, productId) {
  const { list, rawById } = await catalog();
  const p = list.find((x) => String(x.id) === String(productId));
  if (!p) return adminScreen(sock, jid, { title: '🛍️ Product', text: `❌ Product *${productId}* nahi mila.`, buttons: [{ id: 'adm:store', text: '🛍️ Catalogue' }] });

  const rate = rateNow() ?? Number(getSettings().usdPkrRate ?? SETTINGS.usdPkrRate);
  const cost = Number(p.costUsd ?? rawById.get(String(p.id))?.price ?? 0);
  const raw = rawById.get(String(p.id));
  const supplierCost = Number(raw?.price ?? 0);
  const source = supplierLabel(raw?.supplier || 'prodseller');
  const alt = raw?.other?.supplier ? supplierLabel(raw.other.supplier) : null;
  const altCost = raw?.other && Number.isFinite(Number(raw.other.price)) ? Number(raw.other.price) : null;
  const costPkr = Math.round(cost * rate);
  const costOverridden = p.override?.costUsd !== undefined && p.override?.costUsd !== null;
  const markupUsed = p.markupPercent;
  const buttons = [
    { id: `adm:storevis:${p.id}`, text: p.hidden ? '✅ Show product' : '🚫 Hide product' },
    { id: `adm:storepin:${p.id}`, text: '📌 Pin price' },
    { id: `adm:storeprice:${p.id}`, text: '✏️ Price / Markup' },
    { id: `adm:storename:${p.id}`, text: '✏️ Custom name' },
    { id: `adm:storeclr:${p.id}`, text: '♻️ Reset overrides' },
    { id: 'adm:store', text: '⬅️ Catalogue' },
  ];
  const choices = buttons.map((b) => ({ id: b.id, label: b.text, keywords: b.text.toLowerCase().split(/\s+/) }));

  return adminScreen(sock, jid, {
    title: `🛍️ ${p.name}`,
    text: [
      `🧾 ID: ${p.id}`,
      `💰 Sell: *${formatPrice(p.pricePkr)}*  = $${cost} × ${rate} × (1 + ${markupUsed}%)`,
      `💸 Cost: $${cost}${costOverridden ? ' ✏️ (admin-set)' : ` (supplier $${supplierCost})`} ≈ ${formatPrice(costPkr)} · margin *${formatPrice(p.pricePkr - costPkr)}*`,
      `📦 Stock: ${p.inStock ? '✅ in stock' : '❌ out of stock'}`,
      `🚚 Source: *${source}*${raw?.supplierProductId ? ` (sku ${raw.supplierProductId})` : ''}` +
        (alt && altCost != null
          ? `\n   ↔ alternate: ${alt} $${altCost}${altCost < supplierCost ? ' — cheaper, will win when in stock' : ''}${raw?.locked ? ' · 🔒 locked' : ''}`
          : ''),
      `📧 Activation required: ${p.requiresEmailActivation ? 'YES — email pe activate hota hai (⏳ delivery time)' : 'no — instant key'}`,
      `👁️ Visible to customers: *${p.hidden ? 'NO (hidden)' : 'yes'}*`,
      p.pinnedPricePkr != null
        ? `📌 Pin: *${formatPrice(p.pinnedPricePkr)}* — ${p.pinnedActive
            ? `HOLDING (ROI ${p.pinnedRoi == null ? '—' : Math.round(p.pinnedRoi)}% ≥ ${p.pinnedFloor}% floor)`
            : `released — supplier price ne floor gira di (ROI ${p.pinnedRoi == null ? '—' : Math.round(p.pinnedRoi)}% < ${p.pinnedFloor}%)`}`
        : '📌 No pinned price — formula price chal raha hai.',
      p.badge ? `🏷️ Badge: ${p.badge}` : null,
      p.override?.customName ? `✏️ Custom name: ${p.override.customName}` : null,
      p.unaffordable ? `⚠️ Hides from customers (${source} balance kam hai — supplier funding chahiye).` : '',
    ].filter(Boolean).join('\n'),
    buttons,
    choices,
  });
}

// ── 3. id dispatch ───────────────────────────────────────────
export async function handleStoreId(sock, jid, user, id) {
  const parts = id.split(':');
  const [, cmd, a] = parts;

  switch (cmd) {
    case 'store':
      return openStoreAdmin(sock, jid);
    case 'storeitem':
      return openStoreItem(sock, jid, a);
    case 'storevis': {
      const current = allOverrides()[String(a)] || {};
      const next = current.visible === false ? { visible: null } : { visible: false };
      upsertOverride(a, next);
      appendAudit({
        actor: jidUser(jid), role: roleFor(jid), action: 'store.visibility',
        target: String(a), detail: next.visible === false ? 'hidden' : 'visible',
      });
      return openStoreItem(sock, jid, a);
    }
    case 'storemarkup':
      setUser(jid, { adminInput: 'store_markup', adminPayload: String(a), flow: 'admin' });
      return sendText(sock, jid, `✏️ Naya markup % for *${a}* type karein (e.g. \`50\`, ya \`0\` for cost price):`);
    case 'storemarkupdef':
      setUser(jid, { adminInput: 'store_markup_default', adminPayload: null, flow: 'admin' });
      return sendText(sock, jid, `✏️ Default markup % (sab products ke liye). Abhi: *${Number.isFinite(Number(getSettings().digitalMarkupPercent)) ? Number(getSettings().digitalMarkupPercent) : SETTINGS.digitalMarkupPercent}%* — type karein (e.g. \`50\`):`);
    case 'storeusd':
      setUser(jid, { adminInput: 'store_usd', adminPayload: String(a), flow: 'admin' });
      return sendText(
        sock,
        jid,
        `✏️ Is product ka *USD price* type karein (e.g. \`1.25\`) — price usi se calculate hoga. \`reset\` = supplier price wapas.\nAbhi: *$${Number(allOverrides()[String(a)]?.costUsd ?? 'supplier')}*`
      );
    case 'storerate':
      setUser(jid, { adminInput: 'store_rate', adminPayload: null, flow: 'admin' });
      return sendText(sock, jid, `💵 PKR per USD rate (sab prices isi se banti hain). Abhi: *${rateNow() ?? SETTINGS.usdPkrRate}* — type karein (e.g. \`278\`):`);
    case 'storepin': {
      const current = allOverrides()[String(a)]?.pinnedPricePkr;
      setUser(jid, { adminInput: 'store_pin', adminPayload: String(a), flow: 'admin' });
      return sendText(
        sock,
        jid,
        `📌 *Fixed (pinned) PKR price* type karein — yeh price tab tak nahi badlegi jab tak uska ROI ${SETTINGS.pinnedMarkupFloor}% se neeche na aa jaye.\n` +
        `Abhi: ${current != null ? `*${formatPrice(current)}*` : 'off'} — number daalein (e.g. \`650\`) ya \`reset\` likhein:`
      );
    }
    case 'storeprice':
      setUser(jid, { adminInput: 'store_price', adminPayload: String(a), flow: 'admin' });
      return sendText(
        sock,
        jid,
        `✏️ *Price inputs* for *${a}* — do tarah ke:\n` +
        `• \`1.25\` → USD price (supplier jagah is se calculate hogi)\n` +
        `• \`60%\` → markup / ROI (abhi ${Number(allOverrides()[String(a)]?.markupPercent ?? 'default')}%)\n` +
        `• \`reset\` → dono hata dein`
      );
    case 'storename':
      setUser(jid, { adminInput: 'store_name', adminPayload: String(a), flow: 'admin' });
      return sendText(sock, jid, `✏️ Customer-facing naam for *${a}* type karein (blank line ke baghair, ya \`reset\` likhein):`);
    case 'storeclr': {
      upsertOverride(a, { markupPercent: null, customName: null, badge: null, visible: null, costUsd: null, pinnedPricePkr: null });
      appendAudit({ actor: jidUser(jid), role: roleFor(jid), action: 'store.override_reset', target: String(a) });
      return openStoreItem(sock, jid, a);
    }
    case 'storebal': {
      const all = await getBalances({ force: true });
      const line = (id) => {
        const b = all[id];
        const label = supplierLabel(id);
        if (!b.configured) return `• ${label}: ⚙️ not configured`;
        if (!b.ok) return `• ${label}: ❌ fetch fail (${b.code || 'unknown'})`;
        const threshold = id === 'eklas' ? SETTINGS.eklasLowBalanceUsd : SETTINGS.prodsellerLowBalanceUsd;
        return `• ${label}: *${b.balance} USDT* — ${b.balance <= threshold ? '⚠️ LOW (top-up karein)' : '✅ theek hai'} (alert ≤ ${threshold})`;
      };
      return adminScreen(sock, jid, {
        title: '📊 Supplier Balances',
        text: [
          line('prodseller'),
          line('eklas'),
          '',
          'Dono suppliers alag wallets hain — 402 sirf uska balance khaata hai jis se order gaya.',
        ].join('\n'),
        buttons: [
          { id: 'adm:storebal', text: '🔁 Refresh' },
          { id: 'adm:store', text: '⬅️ Catalogue' },
        ],
        choices: [
          { id: 'adm:storebal', label: '🔁 Refresh', keywords: ['refresh'] },
          { id: 'adm:store', label: '⬅️ Catalogue', keywords: ['back'] },
        ],
      });
    }
    case 'storeresh': {
      __clearCache();
      clearSupplierCaches();
      clearEklasCache();
      const res = await getProducts({ force: true });
      const note = res.ok ? `✅ Catalogue refreshed — ${res.products?.length ?? 0} product(s).` : `⚠️ Refresh fail: ${res.code || res.error}`;
      return openStoreAdmin(sock, jid, note);
    }
    default:
      return false;
  }
}

/** Typed input (adminPanel's handleAdminInput delegates here). */
export async function handleStoreInput(sock, jid, user, text) {
  const mode = user.adminInput;
  const payload = user.adminPayload;
  const value = String(text || '').trim();

  if (mode === 'store_markup' || mode === 'store_markup_default') {
    const pct = Number(value.replace(/[^\d.]/g, ''));
    if (!Number.isFinite(pct) || pct < 0 || pct > 1000) {
      return sendText(sock, jid, '❌ 0 se 1000 ke darmiyan number daalein (e.g. `50`).');
    }
    if (mode === 'store_markup_default') {
      setSettings({ digitalMarkupPercent: pct });
      appendAudit({ actor: jidUser(jid), role: roleFor(jid), action: 'store.markup_default', detail: `${pct}%` });
      setUser(jid, { adminInput: null, adminPayload: null });
      return openStoreAdmin(sock, jid, `✅ Default markup → *${pct}%* (ab tak orders par asar nahi — sirf nayi prices).`);
    }
    upsertOverride(payload, { markupPercent: pct });
    appendAudit({ actor: jidUser(jid), role: roleFor(jid), action: 'store.markup', target: payload, detail: `${pct}%` });
    setUser(jid, { adminInput: null, adminPayload: null });
    return openStoreItem(sock, jid, payload);
  }

  if (mode === 'store_usd') {
    if (/^(reset|clear|supplier|none)$/i.test(value)) {
      upsertOverride(payload, { costUsd: null });
      appendAudit({ actor: jidUser(jid), role: roleFor(jid), action: 'store.usd_reset', target: payload });
      setUser(jid, { adminInput: null, adminPayload: null });
      return openStoreItem(sock, jid, payload);
    }
    const usd = Number(value.replace(/[^\d.]/g, ''));
    if (!Number.isFinite(usd) || usd < 0 || usd > 10_000) {
      return sendText(sock, jid, '❌ Sahi USD price daalein (e.g. `1.25`) ya `reset` likhein.');
    }
    upsertOverride(payload, { costUsd: usd });
    appendAudit({ actor: jidUser(jid), role: roleFor(jid), action: 'store.usd', target: payload, detail: `$${usd}` });
    setUser(jid, { adminInput: null, adminPayload: null });
    return openStoreItem(sock, jid, payload);
  }

  if (mode === 'store_rate') {
    const n = Number(value.replace(/[^\d.]/g, ''));
    if (!Number.isFinite(n) || n <= 0 || n > 1000) {
      return sendText(sock, jid, '❌ PKR/USD rate 1 se 1000 ke darmiyan daalein (e.g. `278`).');
    }
    setSettings({ usdPkrRate: n });
    appendAudit({ actor: jidUser(jid), role: roleFor(jid), action: 'store.rate', detail: String(n) });
    setUser(jid, { adminInput: null, adminPayload: null });
    return openStoreAdmin(sock, jid, `✅ USD rate → *${n} PKR* (nayi prices foran lagu).`);
  }

  if (mode === 'store_pin') {
    if (/^(reset|clear|off|none)$/i.test(value)) {
      upsertOverride(payload, { pinnedPricePkr: null });
      appendAudit({ actor: jidUser(jid), role: roleFor(jid), action: 'store.pin_reset', target: payload });
      setUser(jid, { adminInput: null, adminPayload: null });
      return openStoreItem(sock, jid, payload);
    }
    const pkr = Number(value.replace(/[^\d.]/g, ''));
    if (!Number.isFinite(pkr) || pkr <= 0 || pkr > 1_000_000) {
      return sendText(sock, jid, `❌ Sahi PKR price daalein (e.g. \`650\`) ya \`reset\` likhein.`);
    }
    upsertOverride(payload, { pinnedPricePkr: Math.round(pkr) });
    appendAudit({
      actor: jidUser(jid), role: roleFor(jid), action: 'store.pin',
      target: payload, detail: `PKR ${Math.round(pkr)} (floor ${SETTINGS.pinnedMarkupFloor}%)`,
    });
    setUser(jid, { adminInput: null, adminPayload: null });
    return openStoreItem(sock, jid, payload);
  }

  if (mode === 'store_price') {
    if (/^(reset|clear|none)$/i.test(value)) {
      upsertOverride(payload, { costUsd: null, markupPercent: null });
      appendAudit({ actor: jidUser(jid), role: roleFor(jid), action: 'store.price_reset', target: payload });
      setUser(jid, { adminInput: null, adminPayload: null });
      return openStoreItem(sock, jid, payload);
    }
    if (value.endsWith('%')) {
      const pct = Number(value.replace(/[^\d.]/g, ''));
      if (!Number.isFinite(pct) || pct < 0 || pct > 1000) {
        return sendText(sock, jid, '❌ Markup 0–1000% ke darmiyan daalein (e.g. `60%`).');
      }
      upsertOverride(payload, { markupPercent: pct });
      appendAudit({ actor: jidUser(jid), role: roleFor(jid), action: 'store.markup', target: payload, detail: `${pct}%` });
      setUser(jid, { adminInput: null, adminPayload: null });
      return openStoreItem(sock, jid, payload);
    }
    const usd = Number(value.replace(/[^\d.]/g, ''));
    if (!Number.isFinite(usd) || usd < 0 || usd > 10_000) {
      return sendText(sock, jid, '❌ Format: `1.25` (USD price) ya `60%` (markup) — ya `reset`.');
    }
    upsertOverride(payload, { costUsd: usd });
    appendAudit({ actor: jidUser(jid), role: roleFor(jid), action: 'store.usd', target: payload, detail: `$${usd}` });
    setUser(jid, { adminInput: null, adminPayload: null });
    return openStoreItem(sock, jid, payload);
  }

  if (mode === 'store_name') {
    if (/^(reset|clear|none)$/i.test(value)) {
      upsertOverride(payload, { customName: null });
      setUser(jid, { adminInput: null, adminPayload: null });
      return openStoreItem(sock, jid, payload);
    }
    upsertOverride(payload, { customName: value.slice(0, 60) });
    appendAudit({ actor: jidUser(jid), role: roleFor(jid), action: 'store.name', target: payload, detail: value.slice(0, 40) });
    setUser(jid, { adminInput: null, adminPayload: null });
    return openStoreItem(sock, jid, payload);
  }

  return false;
}
