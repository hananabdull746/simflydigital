// ─────────────────────────────────────────────────────────────
// handlers/digitalStore.js
// Customer-facing HALF of the Digital Store (second catalogue).
//
//   🛍️ browse list (sections + search)  → detail card
//   → ✅ Order Now → 📧 activation email (when required, with a
//     one-time confirmation, because it CANNOT be undone)
//   → into the EXISTING payment step (payments.js) — same Order
//     IDs, same screenshot/NayaPay verification, same admin cards
//   → on confirmation the bot buys from the CHEAPEST in-stock
//     supplier (services/productCatalog.js = ProdSeller + Eklas) and
//     delivers:
//         status "delivered" → key(s) immediately + thank-you
//         status "paid"      → activation poll job (digitalPolls)
//         402                → awaiting supplier funding + CRITICAL
//         409                → honest out-of-stock + refund choice
//     A supplier that runs out mid-checkout falls back to the other
//     one automatically (never on an ambiguous network failure).
//
// UX rules honoured on every screen (same as eSIM):
//   • withNav()/withListNav() on every screen — never a dead-end
//   • user.choices mirrors the displayed buttons exactly
//   • minimal text, footer branding from lib/ui
//   • customer strings go through t() where a translation exists
// ─────────────────────────────────────────────────────────────
import { BRAND, SETTINGS, formatPrice, jidUser } from '../config.js';
import { sendButtons, sendList, sendText } from '../lib/ui.js';
import { withNav, withListNav, withNavChoices, withAck, LIST_NAV_CHOICES } from './ui.js';
import { STEP_PAYMENT, STEP_PRODUCT_QTY, withStep } from '../lib/steps.js';
import { getLang } from '../lib/users.js';
import { t } from '../lib/lang.js';
import {
  MORE_CATEGORY, STORE_CATEGORIES, allOverrides, categoryOf,
  customerProducts, digitalCategories, digitalCategorySections,
  digitalDetailText, digitalSections, mergeProduct, searchProducts,
} from '../lib/digital.js';
import {
  getProducts, getProduct, getBalance, createOrder, idempotencyKeyFor, isConfigured, supplierLabel,
} from '../services/productCatalog.js';
import { getOrder, getUser, putOrder, setUser, resetUser, flush } from '../lib/store.js';
import { saveSession, getSession } from '../lib/sessions.js';
import { askPaymentMethod } from './payments.js';
import { sendReceipt } from './orders.js';
import { startPostOrder } from './reviews.js';
import { alertAdmins, purchaseFailedAlert } from '../services/adminAlerts.js';
import { adjustBalance } from '../services/wallet.js';
import { schedulePoll, cancelPoll } from '../services/digitalPolls.js';
import { logOrder, logError } from '../lib/logger.js';
import { getSettings } from '../lib/admins.js';

const now = () => new Date().toISOString();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Basic sanity check for an activation address. */
export function isValidEmail(value) {
  return EMAIL_RE.test(String(value || '').trim());
}

/** Keys are NEVER logged and only ever masked in admin cards. */
export function maskKey(key) {
  const s = String(key || '');
  if (!s) return '—';
  if (s.length <= 8) return `${s[0] || '*'}${'*'.repeat(Math.max(3, s.length - 1))}`;
  return `${s.slice(0, 4)}${'*'.repeat(Math.min(12, s.length - 7))}${s.slice(-3)}`;
}

// ── Catalogue loading ─────────────────────────────────────────
/** Per-product admin overrides (data/digitalProductOverrides.json). */
const overrideMap = () => allOverrides();

async function loadCatalog() {
  const catalog = await getProducts();
  const overrides = overrideMap();
  const raw = catalog.products || [];
  const balanceUsd = catalog.balances?.prodseller ?? catalog.balances?.eklas ?? null;
  const ctx = { overrides, balanceUsd, markupPercent: globalMarkup(), rate: rateNow() };
  return {
    raw,
    stale: Boolean(catalog.stale),
    configured: catalog.configured !== false && isConfigured(),
    customer: customerProducts(raw, ctx),
  };
}

/** Merged (customer-priced) product by id, or null. */
async function productView(productId) {
  const res = await getProduct(productId);
  const raw = res.ok
    ? res.product
    : (await getProducts()).products?.find((p) => p.id === productId) || null;
  if (!raw) return null;
  const balance = raw.balanceUsd ?? (await getBalance()).balance ?? null;
  return mergeProduct(raw, {
    override: overrideMap()[String(productId)] || null,
    balanceUsd: balance,
    markupPercent: globalMarkup(),
    rate: rateNow(),
  });
}

/** Default markup: admin panel override → .env DIGITAL_MARKUP_PERCENT. */
function globalMarkup() {
  try {
    const v = getSettings().digitalMarkupPercent;
    return Number.isFinite(Number(v)) ? Number(v) : undefined;
  } catch {
    return undefined;
  }
}

/** PKR per USD: admin panel override → .env USD_PKR_RATE. */
function rateNow() {
  try {
    const n = Number(getSettings().usdPkrRate);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Shared with handlers/checkout.js — the cart resolver. */
export { productView as digitalProductView };

// ── 1. Browse LIST ────────────────────────────────────────────
const STORE_KEYWORDS = {
  'dp_search': ['search', 'find', 'look', 'keyword'],
  'back_store': ['back', 'store', 'categories', 'all categories', 'sab'],
};

const SEARCH_ROW = { id: 'dp_search', title: '🔍 Search products', description: 'Naam type karke dhoondein' };
const BACK_ROW = { id: 'back_store', title: '⬅️ All Categories', description: 'Sab categories par wapas' };

/** Keyword sets for the fixed rows — the rows themselves come from withListNav(). */
const NAV_EXTRA = Object.fromEntries(LIST_NAV_CHOICES.map((c) => [c.id, c]));
const OWN_EXTRA = {
  dp_search: { id: 'dp_search', label: SEARCH_ROW.title, keywords: STORE_KEYWORDS.dp_search },
  back_store: { id: 'back_store', label: BACK_ROW.title, keywords: STORE_KEYWORDS.back_store },
};

/**
 * Build `user.choices` from the RENDERED sections, in row order.
 * The numbered plain-text fallback numbers every row (Menu rows
 * included), so choices[i] MUST be sections' row i — the product
 * list is never the source of truth here.
 *
 * Products that are NOT rows (typing a product name while browsing)
 * ride along AFTER the rows: numbers still map 1..N, an unmatched
 * name still opens its detail card.
 */
function choicesFor(sections, list = []) {
  const byId = new Map((list || []).map((p) => [`dp:${p.id}`, p]));
  const out = sections
    .flatMap((s) => s.rows || [])
    .map((r) => OWN_EXTRA[r.id]
      || NAV_EXTRA[r.id]
      || (byId.has(r.id)
        ? (() => {
            const p = byId.get(r.id);
            return { id: r.id, label: p.name, keywords: [p.name.toLowerCase(), String(p.pricePkr)] };
          })()
        : { id: r.id, label: r.title, keywords: [String(r.title).toLowerCase()] }));

  const seen = new Set(out.map((c) => c.id));
  for (const p of list || []) {
    const id = `dp:${p.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: p.name, keywords: [p.name.toLowerCase(), String(p.pricePkr)] });
  }
  return out;
}

export async function sendStore(sock, jid, opts = {}) {
  const lang = getLang(jid);
  return withAck(jid, opts.silent ? null : t('ack_stock', {}, lang), async () => {
    const catalog = await loadCatalog();
    const list = opts.query ? searchProducts(catalog.customer, opts.query) : catalog.customer;

    if (!catalog.configured) {
      const choices = withNavChoices([
        { id: 'back_menu', label: t('nav_back_menu', {}, lang), keywords: ['menu', 'back', 'home'] },
      ]);
      setUser(jid, { flow: 'digital_browse', choices });
      return sendButtons(sock, jid, {
        title: '🛍️ Digital Store',
        text: [
          'Abhi Digital Store configured nahi hai.',
          '',
          'Admin ko `PRODSELLER_API_KEY` set karna hoga (.env) — uske baad yahan subscriptions, accounts aur keys bikengi.',
        ].join('\n'),
        buttons: choices.map((c) => ({ id: c.id, text: c.label })),
      });
    }

    if (list.length === 0) {
      // Catalogue exists but nothing is buyable right now (supplier
      // balance or overrides) — say "restocking", never "empty shop".
      const restocking = !opts.query && catalog.raw.length > 0;
      const choices = withNavChoices([
        { id: 'dp_search', label: '🔍 Search products', keywords: STORE_KEYWORDS.dp_search },
        { id: 'menu:plans', label: t('nav_plans', {}, lang), keywords: ['plans', 'plan', 'data'] },
        { id: 'back_menu', label: t('nav_back_menu', {}, lang), keywords: ['menu', 'back', 'home'] },
      ]);
      setUser(jid, { flow: 'digital_browse', choices });
      return sendButtons(sock, jid, {
        title: '🛍️ Digital Store',
        text: opts.query
          ? `"${opts.query}" se koi product nahi mila. Doosra keyword try karein ya sab dekhein.`
          : restocking
            ? [
                '⏳ Store thori der me wapas aa raha hai — stock restock ho raha hai.',
                '',
                'Kuch minute baad dobara check karein, ya *eSIM plans* dekh lein.',
              ].join('\n')
            : 'Abhi is section me koi product available nahi hai — thori der baad dobara check karein.',
        buttons: choices.map((c) => ({ id: c.id, text: c.label })),
      });
    }

    // ── ONE list, categories as SECTION TITLES ─────────────────
    // No second menu: every category is a section header and its
    // products are the rows right under it (a category with more than
    // 10 items ends in a "➕ N more" row that opens its full list).
    // Search keeps the flat result list — that is what was asked for.
    const cats = digitalCategories(list);
    const sections = opts.query
      ? withListNav([...digitalSections(list, lang), { title: '↩️ Browse', rows: [SEARCH_ROW, BACK_ROW] }])
      : withListNav(digitalCategorySections(list), { extraRows: [SEARCH_ROW] });
    const choices = choicesFor(sections, list);
    setUser(jid, { flow: 'digital_browse', dpId: null, dpQty: 1, choices });

    const restockingCount = list.filter((p) => p.unaffordable).length;
    await sendList(sock, jid, {
      title: `🛍️ ${BRAND.name} · Digital Store`,
      buttonText: opts.query ? '🛍️ View Product' : '🛍️ Browse',
      text: [
        opts.query
          ? `🔍 Results for "${opts.query}" — ${list.length} item${list.length === 1 ? '' : 's'}`
          : `${list.length} product${list.length === 1 ? '' : 's'} · ${cats.length} categories — har category apni section me.`,
        '⚡ Instant delivery • 📧 Email activation' + (SETTINGS.walletEnabled ? ' • 💰 Wallet se ek-tap pay' : ''),
        '⚡ Instant delivery • 📧 Email activation' + (SETTINGS.walletEnabled ? ' • 💰 Wallet se ek-tap pay' : ''),
        restockingCount
          ? `⏳ ${restockingCount} item${restockingCount === 1 ? '' : 's'} restock me hain — order le rahe hain, delivery upar se lag sakti hai.`
          : '',
        catalog.stale ? '⚠️ Prices temporarily cached — order karne par live check hoga.' : '',
      ].filter(Boolean).join('\n'),
      sections,
    });
    return true;
  });
}

/** One category → its products (same screens, same fallback rules). */
export async function sendStoreCategory(sock, jid, key) {
  const lang = getLang(jid);
  const cat = [...STORE_CATEGORIES, MORE_CATEGORY].find((c) => c.key === key);
  if (!cat) return sendStore(sock, jid);

  return withAck(jid, t('ack_stock', {}, lang), async () => {
    const catalog = await loadCatalog();
    const subset = catalog.customer.filter((p) => categoryOf(p) === cat.key);
    if (subset.length === 0) return sendStore(sock, jid);

    const sections = withListNav([
      ...digitalSections(subset, lang),
      { title: '↩️ Browse', rows: [SEARCH_ROW, BACK_ROW] },
    ]);
    const choices = choicesFor(sections, subset);
    setUser(jid, { flow: 'digital_browse', dpId: null, dpQty: 1, choices });

    const restockingCount = subset.filter((p) => p.unaffordable).length;
    await sendList(sock, jid, {
      title: `${cat.emoji} ${cat.title}`,
      buttonText: '🛍️ View Product',
      text: [
        `${subset.length} item${subset.length === 1 ? '' : 's'} — ${cat.blurb}.`,
        '⚡ Instant • 📧 Email activation • 💰 Wallet pay',
        restockingCount ? `⏳ ${restockingCount} restock me hain.` : '',
        catalog.stale ? '⚠️ Prices temporarily cached — order karne par live check hoga.' : '',
      ].filter(Boolean).join('\n'),
      sections,
    });
    return true;
  });
}

export async function sendStoreSearch(sock, jid) {
  const lang = getLang(jid);
  setUser(jid, { flow: 'digital_search', choices: withNavChoices([
    { id: 'back_store', label: '⬅️ Back to Store', keywords: ['back', 'store', 'all'] },
    { id: 'back_menu', label: t('nav_back_menu', {}, lang), keywords: ['menu', 'back', 'home'] },
  ]) });
  await sendButtons(sock, jid, {
    title: '🔍 Search Digital Store',
    text: 'Product ka naam type karein (e.g. *Netflix*, *Canva*, *Office*).',
    buttons: [
      { id: 'back_store', text: '⬅️ Back to Store' },
      { id: 'main_menu', text: '🏠 Main Menu' },
    ],
  });
  return true;
}

// ── 2. Detail card ────────────────────────────────────────────
export async function sendDigitalDetail(sock, jid, productId) {
  const lang = getLang(jid);
  return withAck(jid, t('ack_stock', {}, lang), async () => {
    const product = await productView(productId);
    if (!product || product.hidden) {
      await sendText(sock, jid, t('plan_unknown', {}, lang));
      return sendStore(sock, jid);
    }

    if (!product.inStock) return digitalOutOfStock(sock, jid, productId, { phase: 'browse' });

    const own = [
      { id: 'dp_order', label: '✅ Order Now', keywords: ['order', 'order now', 'buy', 'purchase', 'len'] },
      { id: 'back_store', label: '⬅️ Back', keywords: ['back', 'back to store', 'store', 'go back'] },
    ];
    const choices = withNavChoices(own);
    setUser(jid, { flow: 'digital_view', dpId: product.id, planId: null, dpQty: 1, choices });

    await sendButtons(sock, jid, {
      title: `🛍️ ${product.name}`,
      text: withStep(STEP_PRODUCT_QTY, digitalDetailText(product, lang)),
      buttons: choices.map((c) => ({ id: c.id, text: c.label })),
    });
    return true;
  });
}

// ── Out of stock (same pattern as the eSIM sold-out screen) ──
export async function digitalOutOfStock(sock, jid, productId, { phase = 'browse', orderId = null } = {}) {
  const lang = getLang(jid);
  const own = [
    { id: 'back_store', label: '🛍️ See Other Products', keywords: ['products', 'other', 'store', 'back'] },
  ];
  if (phase === 'paid') {
    own.push({ id: `walrefund:${orderId || ''}`, label: '💰 Refund to Wallet', keywords: ['refund', 'wallet', 'paisay'] });
    own.push({ id: 'menu:support', label: t('nav_support_refund', {}, lang), keywords: ['support', 'help'] });
  }
  const choices = withNavChoices(own);
  setUser(jid, { flow: 'digital_browse', dpId: productId, choices });

  await sendButtons(sock, jid, {
    title: '❌ Out of stock',
    text: phase === 'paid'
      ? [
          '😔 Maaf kijiye — aapka payment aa chuka hai lekin yeh item abhi out of stock ho gaya hai.',
          '',
          'Aap wallet refund le sakte hain (foran) ya koi doosra product dekh sakte hain.',
        ].join('\n')
      : 'Yeh item abhi out of stock hai — thori der baad dobara check karein ya koi doosra product dekhein.',
    buttons: choices.map((c) => ({ id: c.id, text: c.label })),
  });
  return true;
}

// ── 3. Order Now → quantity → email (if needed) → payment ────
/** Hard cap: one supplier order, never a runaway quantity. */
export const QTY_MAX = 10;
const QTY_STEPS = [1, 2, 3, 5, 10];

export async function startDigitalOrder(sock, jid, productId) {
  const id = productId || getUser(jid).dpId;
  if (!id) return sendStore(sock, jid);

  return withAck(jid, '⏳ Live stock check…', async () => {
    const product = await productView(id);
    if (!product) {
      await sendText(sock, jid, '❌ Yeh product abhi available nahi.');
      return sendStore(sock, jid);
    }
    if (!product.inStock || product.hidden) return digitalOutOfStock(sock, jid, product.id, { phase: 'browse' });

    // Always ask how many first — the answer sets the order total.
    setUser(jid, { dpId: product.id, planId: null, dpQty: 1 });
    return askQuantity(sock, jid, product);
  });
}

/** Quantity picker (LIST → Menu rows stay available, never a dead-end). */
export async function askQuantity(sock, jid, product) {
  const p = product || (await productView(getUser(jid).dpId));
  if (!p) return sendStore(sock, jid);

  const sections = withListNav([{
    title: '🛒 Kitne lene hain?',
    rows: QTY_STEPS.map((n) => ({
      id: `dqty:${n}`,
      title: n === 1 ? '1 piece (standard)' : `${n} pieces`,
      description: n === 1
        ? `${formatPrice(p.pricePkr)} · single`
        : `${formatPrice(p.pricePkr * n)} · ${formatPrice(p.pricePkr)} each`,
    })),
  }]);

  setUser(jid, { flow: 'digital_qty', dpId: p.id, choices: choicesFor(sections, []) });

  await sendList(sock, jid, {
    title: '🛒 Quantity',
    buttonText: 'Select qty',
    text: [
      `*${p.name}*`,
      `Ek piece: ${formatPrice(p.pricePkr)}`,
      '',
      p.requiresEmailActivation
        ? `📧 Sab ${QTY_MAX} tak ek hi email par activate honge.`
        : '⚡ Sab pieces ek hi order me deliver honge.',
      '',
      `Quantity tap karein, ya custom number likhein (1–${QTY_MAX}, e.g. \`7\`).`,
    ].join('\n'),
    sections,
  });
  return true;
}

/** A quantity was tapped (dqty:N) or typed (flow: digital_qty). */
export async function handleQuantity(sock, jid, value) {
  const p = await productView(getUser(jid).dpId);
  if (!p) return sendStore(sock, jid);

  const n = Number(String(value).replace(/[^0-9]/g, ''));
  if (!Number.isInteger(n) || n < 1 || n > QTY_MAX) {
    await sendText(sock, jid, `❌ Quantity 1–${QTY_MAX} ke beech honi chahiye — dobara try karein.`);
    return askQuantity(sock, jid, p);
  }

  setUser(jid, { dpId: p.id, dpQty: n });
  return proceedToPayment(sock, jid, p);
}

/** Shared tail of the order flow: activation email (if needed) → payment. */
async function proceedToPayment(sock, jid, product) {
  if (product.requiresEmailActivation) return askActivationEmail(sock, jid, product);

  saveSession(jid, { step: STEP_PAYMENT, selectedProductId: product.id, selectedPlanId: null, orderId: null });
  return askPaymentMethod(sock, jid);
}

export async function askActivationEmail(sock, jid, product) {
  const lang = getLang(jid);
  const p = product || (await productView(getUser(jid).dpId));
  if (!p) return sendStore(sock, jid);

  setUser(jid, { flow: 'digital_email', dpId: p.id, choices: withNavChoices([
    { id: 'back_store', label: '⬅️ Back', keywords: ['back', 'store'] },
    { id: 'back_menu', label: t('nav_back_menu', {}, lang), keywords: ['menu', 'back', 'home'] },
  ]) });
  saveSession(jid, { step: STEP_PRODUCT_QTY, selectedProductId: p.id, selectedPlanId: null, orderId: null });

  await sendButtons(sock, jid, {
    title: '📧 Activation Email',
    text: withStep(STEP_PRODUCT_QTY, [
      '*Yeh plan instant key nahi deta* — isko aapke email par activate kiya jata hai.',
      '',
      `📧 Which email should we activate this on? (Gmail/Outlook etc.)`,
      '',
      `⏱️ ${SETTINGS.activationEtaLabel}`,
      '',
      'Type karein ya *back* likhein.',
    ].join('\n')),
    buttons: withNav([
      { id: 'back_store', text: '⬅️ Back' },
    ]),
  });
  return true;
}

/** Email typed → validate → one-time confirmation (cannot be undone). */
export async function confirmActivationEmail(sock, jid, email) {
  const lang = getLang(jid);
  if (!isValidEmail(email)) {
    setUser(jid, { flow: 'digital_email' });
    return sendButtons(sock, jid, {
      title: '❌ Email theek nahi lag rahi',
      text: 'Dobara type karein — format aisa hona chahiye: `name@gmail.com`',
      buttons: withNav([{ id: 'back_store', text: '⬅️ Back' }]),
    });
  }

  const value = String(email).trim().toLowerCase();
  setUser(jid, { flow: 'digital_email_confirm', choices: withNavChoices([
    { id: 'dpemail_yes', label: '✅ Yes, correct', keywords: ['yes', 'y', 'correct', 'haan', 'han', 'confirm'] },
    { id: 'dpemail_no', label: '✏️ Change email', keywords: ['no', 'change', 'wrong', 'dobara', 'nahi'] },
  ]) });
  // Remembered on the session (NOT an order yet).
  saveSession(jid, { activationEmail: value });

  await sendButtons(sock, jid, {
    title: '📧 Confirm activation email',
    text: [
      `Activating on: *${value}*`,
      '',
      '— correct?',
      '',
      `⚠️ Payment ke baad is email ko badalna mushkil hai — is liye ek baar confirm kar lein.`,
      `⏱️ ${SETTINGS.activationEtaLabel}`,
    ].join('\n'),
    buttons: withNav([
      { id: 'dpemail_yes', text: '✅ Yes, correct' },
      { id: 'dpemail_no', text: '✏️ Change email' },
    ]),
  });
  return true;
}

export async function handleEmailAnswer(sock, jid, yes) {
  const session = getSession(jid);
  const product = await productView(getUser(jid).dpId);
  if (!product) return sendStore(sock, jid);

  if (!yes) return askActivationEmail(sock, jid, product);

  const email = session?.activationEmail;
  if (!email) return askActivationEmail(sock, jid, product);
  setUser(jid, { activationEmail: email });
  saveSession(jid, { activationEmail: email, step: STEP_PAYMENT, selectedProductId: product.id, selectedPlanId: null });
  return askPaymentMethod(sock, jid);
}

// ── 4. Fulfilment (called by confirmOrder for catalogType digital) ──
/**
 * Place the real ProdSeller order for a CONFIRMED Simfly order and
 * deliver whatever comes back. Idempotency-Key = `simfly_<OrderId>`
 * so a retry can never double-charge the ProdSeller wallet.
 *
 * @returns {Promise<{ok:boolean, message:string}>}
 */
export async function confirmDigitalOrder(sock, orderId, opts = {}) {
  const actor = opts.actor || 'admin';
  const order = getOrder(orderId);
  if (!order) return { ok: false, message: `Order *${orderId}* nahi mila.` };
  if (order.status === 'fulfilled') return { ok: false, message: `*${orderId}* pehle hi deliver ho chuka hai ✅` };
  if (order.status === 'cancelled') return { ok: false, message: `⛔ *${orderId}* customer ne cancel kar diya hai.` };

  if (!isConfigured()) {
    await alertAdmins(sock, [
      '🔴 *Digital Store — API key missing*',
      '',
      `🧾 ${order.id} confirm hone par supplier call fail karega.`,
      '`.env` me PRODSELLER_API_KEY ya EKLAS_API_KEY set karein.',
    ].join('\n'), { critical: true, title: '🔴 No digital supplier configured' });
    return { ok: false, message: `⚠️ *${orderId}* — koi digital supplier configured nahi hai (.env → PRODSELLER_API_KEY / EKLAS_API_KEY).` };
  }

  // 1. LIVE stock/price check right before we spend money.
  const live = await getProduct(order.productId);
  const liveProduct = live.ok ? live.product : null;
  if (liveProduct && (liveProduct.inStock === false || (Number.isFinite(liveProduct.stock) && liveProduct.stock <= 0))) {
    return outOfStockAfterPayment(sock, order, actor, 'stock changed since browse');
  }
  if (!live.ok && (live.code === 'OUT_OF_STOCK' || live.code === 'NOT_FOUND')) {
    return outOfStockAfterPayment(sock, order, actor, live.code);
  }
  const chosenSupplier = liveProduct?.supplier || live.supplier || order.supplier || 'prodseller';

  // 2. Buy. Stable Idempotency-Key per Simfly order id (both suppliers).
  const purchase = await createOrder({
    productId: order.productId,
    quantity: Math.max(1, Math.min(QTY_MAX, Number(order.quantity) || 1)),
    email: order.activationEmail || undefined,
    idempotencyKey: idempotencyKeyFor(order.id),
    clientOrderId: idempotencyKeyFor(order.id),
  });

  if (purchase.ok) {
    const ps = purchase.order;
    const supplier = purchase.supplier || chosenSupplier;
    order.supplier = supplier;
    order.prodsellerOrderId = supplier === 'prodseller' ? ps.orderId : (order.prodsellerOrderId ?? null);
    order.supplierOrderId = ps.orderId;
    order.updatedAt = now();
    putOrder(order);
    flush();

    if (ps.status === 'delivered') {
      try {
        await sendReceipt(sock, order);
        await sendDeliveredKeys(sock, order, ps);
        finalizeDigital(sock, order, actor, 'instant');
        resetUser(order.jid);
        flush();
        await startPostOrder(sock, order);
        return { ok: true, message: `✅ *${order.id}* delivered via ${supplierLabel(supplier)} — +${order.phone} ko key bhej di.\n🛍️ ${order.planName}` };
      } catch (err) {
        logError('digital.deliver', err, { orderId: order.id });
        order.status = 'fulfilled';
        order.deliveredKey = ps.deliveredKey ?? null;
        order.deliveredKeys = ps.deliveredKeys ?? null;
        order.confirmedBy = actor;
        order.confirmedAt = now();
        order.deliveredAt = now();
        order.actionVersion = (order.actionVersion || 0) + 1;
        order.updatedAt = now();
        putOrder(order);
        flush();
        return { ok: true, message: `✅ *${order.id}* supplier se deliver hua lekin chat me bhejna fail — \`resend ${order.id}\` bhejein.` };
      }
    }

    if (ps.status === 'paid' || ps.status === 'pending') {
      return startActivation(sock, order, actor, ps, supplier);
    }

    if (ps.status === 'failed') {
      return supplierFailure(sock, order, actor, 'supplier reported the order as failed');
    }

    // Unknown-but-successful status: treat as activation pending.
    return startActivation(sock, order, actor, ps, supplier);
  }

  // 3. Structured failures.
  const supplier = purchase.supplier || chosenSupplier;
  switch (purchase.code) {
    case 'INSUFFICIENT_BALANCE':
      return insufficientBalance(sock, order, actor, supplier);
    case 'OUT_OF_STOCK':
    case 'NOT_FOUND':
      return outOfStockAfterPayment(sock, order, actor, purchase.code);
    case 'AUTH':
    case 'UPSTREAM':
    case 'NETWORK':
    case 'RATE_LIMITED':
    case 'BAD_REQUEST':
    default: {
      logError('supplier.order', new Error(purchase.error || purchase.code || 'unknown'), { orderId: order.id, supplier, tried: purchase.tried });
      try {
        await purchaseFailedAlert(sock, order, purchase.error || purchase.code);
      } catch (err) {
        logError('digital.alert', err, { orderId: order.id });
      }
      const label = supplierLabel(supplier);
      const retried = Array.isArray(purchase.tried) && purchase.tried.length > 1
        ? ` (tried: ${purchase.tried.map(supplierLabel).join(' → ')})`
        : '';
      return {
        ok: false,
        message: `⚠️ *${order.id}* — ${label} call fail${retried}: ${String(purchase.error || purchase.code).slice(0, 140)}\nOrder pending hai — masla theek karke dobara \`confirm ${order.id}\` bhejein.`,
      };
    }
  }
}

function finalizeDigital(sock, order, actor, how) {
  clearReminderSafe(order.id);
  cancelPoll(order.id);
  const supplier = order.supplier || 'prodseller';
  order.status = 'fulfilled';
  order.fulfillment = how === 'instant' ? supplier : `${supplier}_activation`;
  order.confirmedBy = actor;
  order.confirmedAt = now();
  order.deliveredAt = now();
  order.actionVersion = (order.actionVersion || 0) + 1;
  order.updatedAt = now();
  putOrder(order);
  flush();
  // NEVER log the key itself — only that it was delivered.
  logOrder('key_delivered', { id: order.id, status: order.status, catalogType: 'digital' }, { via: supplier, how });
  return { ok: true, message: `✅ *${order.id}* delivered (+${order.phone}) — key customer ko bhej di.` };
}

/** Send the actual key(s) — receipt card style, then the payload. */
async function sendDeliveredKeys(sock, order, psOrder) {
  const keys = (psOrder.deliveredKeys && psOrder.deliveredKeys.length
    ? psOrder.deliveredKeys
    : [psOrder.deliveredKey]).filter((k) => k !== undefined && k !== null && k !== '');

  const lines = [
    '✅ *DELIVERED*',
    '',
    `🎟️ ${order.planName}`,
    `🎫 ${order.id}`,
    order.activationEmail ? `📧 Activated on: ${order.activationEmail}` : '',
    '',
    ...keys.map((k, i) => (keys.length > 1 ? `🔑 Key ${i + 1}: \`${k}\`` : `🔑 Key: \`${k}\``)),
    '',
    '⚠️ Is key ko kisi ke saath share na karein. Problem ho toh *support* likhein.',
  ].filter(Boolean).join('\n');

  await sendText(sock, order.jid, lines);
  order.deliveredKey = keys.length === 1 ? keys[0] : null;
  order.deliveredKeys = keys.length > 1 ? keys : null;
  order.updatedAt = now();
  putOrder(order);
  flush();
  logOrder('keys_sent', { id: order.id }, { count: keys.length });
  return 'text';
}

// ── Email-activation: poll until "delivered" ──────────────────
async function startActivation(sock, order, actor, psOrder, supplier = 'prodseller') {
  order.status = 'awaiting_activation';
  order.supplier = supplier;
  order.supplierOrderId = psOrder.orderId;
  if (supplier === 'prodseller') order.prodsellerOrderId = psOrder.orderId;
  order.confirmedBy = actor;
  order.confirmedAt = now();
  order.actionVersion = (order.actionVersion || 0) + 1;
  order.updatedAt = now();
  putOrder(order);
  flush();
  schedulePoll(order.id, psOrder.orderId, Date.now(), supplier);
  logOrder('activation_started', { id: order.id }, { supplier, supplierOrderId: psOrder.orderId });

  const lang = getLang(order.jid);
  try {
    await sendButtons(sock, order.jid, {
      title: `✅ ${order.id} — payment confirmed`,
      text: [
        `✅ Payment confirmed! Activating on your email — *${SETTINGS.activationEtaLabel}*.`,
        '',
        `📧 ${order.activationEmail || 'your email'}`,
        `🎟️ ${order.planName}`,
        `⏱️ Hum message karenge jaise hi ready ho jaye.`,
      ].join('\n'),
      buttons: withNav([
        { id: 'menu:orders', text: t('nav_orders', {}, lang) },
      ]),
    });
  } catch (err) {
    logError('digital.activation.notice', err, { orderId: order.id });
  }

  return { ok: true, message: `⏳ *${order.id}* — activation started (${supplierLabel(supplier)} ${psOrder.orderId}). Poll job chal raha hai.` };
}

// ── 402: customer already paid US, supplier wallet is empty ───
async function insufficientBalance(sock, order, actor, supplier = 'prodseller') {
  const label = supplierLabel(supplier);
  order.status = 'awaiting_supplier_funding';
  order.supplier = supplier;
  order.confirmedBy = actor;
  order.confirmedAt = now();
  order.actionVersion = (order.actionVersion || 0) + 1;
  order.updatedAt = now();
  putOrder(order);
  flush();
  logOrder('awaiting_supplier_funding', { id: order.id, status: order.status }, { catalogType: 'digital' });

  // Customer must NEVER hear "payment failed" — they already paid in PKR.
  try {
    const lang = getLang(order.jid);
    await sendButtons(sock, order.jid, {
      title: `⏳ ${order.id} processing`,
      text: [
        '✅ Payment received — shukriya!',
        '',
        'Aapka order processing me hai, thanks for your patience. ' +
          `Hum message karenge jaise hi ready ho jaye (${SETTINGS.activationEtaLabel}).`,
      ].join('\n'),
      buttons: withNav([
        { id: 'menu:orders', text: t('nav_orders', {}, lang) },
      ]),
    });
  } catch (err) {
    logError('digital.funding.notice', err, { orderId: order.id });
  }

  await alertAdmins(sock, [
    `🔴 *${label.toUpperCase()} WALLET EMPTY — top up NOW*`,
    '',
    `🧾 ${order.id} · ${order.planName} · ${formatPrice(order.price)}`,
    `👤 +${order.phone}`,
    'Customer ka payment AA CHUKA hai — agar wallet me USDT nahi toh yeh order stuck rahega.',
    '',
    'Wallet bharne ke baad neeche Retry dabayein.',
  ].join('\n'), {
    critical: true,
    title: `🔴 Top up ${label} wallet`,
    buttons: [
      { id: `adm:retry:${order.id}`, text: '🔁 Retry Order' },
      { id: `adm:det:${order.id}`, text: '🔍 Details' },
    ],
  });

  return { ok: false, message: `⏳ *${order.id}* — awaiting supplier funding (${label} wallet 402). Customer ko patience message bhej diya.` };
}

// ── 409: stock changed between browse and confirmation ───────
async function outOfStockAfterPayment(sock, order, actor, reason) {
  logOrder('digital_oos', { id: order.id, status: order.status }, { reason });
  await digitalOutOfStock(sock, order.jid, order.productId, { phase: 'paid', orderId: order.id });
  await alertAdmins(sock, [
    '📦 *DIGITAL PRODUCT OUT OF STOCK*',
    '',
    `🧾 ${order.id} · ${order.planName} · ${formatPrice(order.price)}`,
    `👤 +${order.phone}`,
    `❌ ${reason}`,
    '',
    'Customer ko refund/switch offer kar diya gaya hai.',
  ].join('\n'), {
    critical: true,
    title: '📦 Out of stock',
    buttons: [{ id: `adm:det:${order.id}`, text: '🔍 Details' }],
  });

  if (order.paidBy === 'wallet') {
    // Wallet-funded orders refund instantly (strictly better than limbo).
    return refundToWallet(sock, order, 'supplier out of stock');
  }

  return { ok: false, message: `📦 *${order.id}* — out of stock after payment (${reason}). Customer ko switch/refund offer kar diya.` };
}

// ── Any post-payment failure ──────────────────────────────────
async function supplierFailure(sock, order, actor, reason) {
  logError('prodseller.failed', new Error(reason), { orderId: order.id });
  if (order.paidBy === 'wallet') return refundToWallet(sock, order, reason);

  try {
    await purchaseFailedAlert(sock, order, reason);
  } catch (err) {
    logError('digital.alert', err, { orderId: order.id });
  }
  return { ok: false, message: `⚠️ *${order.id}* — supplier failure: ${String(reason).slice(0, 140)}` };
}

/**
 * Instant wallet refund (used by every post-payment failure path
 * when the customer paid from their Simfly Wallet).
 */
export async function refundToWallet(sock, order, reason = '') {
  const amount = Number(order.price) || 0;
  if (!amount) return { ok: false, message: `❌ *${order.id}* ka amount 0 hai — refund skip.` };

  const res = await adjustBalance(order.jid ? jidUser(order.jid) : order.phone, amount, 'refund', {
    relatedOrderId: order.id,
    note: `order refund: ${reason}`.slice(0, 200),
  });
  if (!res.ok) {
    logError('wallet.refund', new Error(res.code || 'refund_failed'), { orderId: order.id });
    return { ok: false, message: `❌ *${order.id}* wallet refund fail (${res.code}) — manually credit karein.` };
  }

  order.status = 'refunded';
  order.refundedAt = now();
  order.refundedVia = 'wallet';
  order.actionVersion = (order.actionVersion || 0) + 1;
  order.updatedAt = now();
  putOrder(order);
  flush();
  logOrder('refunded_to_wallet', { id: order.id, status: order.status }, { amount });

  try {
    await sendButtons(sock, order.jid, {
      title: `😔 ${order.id} could not be completed`,
      text: [
        `😔 That order couldn't be completed — *${formatPrice(amount)} refunded to your wallet instantly*.`,
        '',
        `💰 New balance: *${formatPrice(res.balance)}*`,
      ].join('\n'),
      buttons: withNav([
        { id: 'wallet_home', text: '💰 My Wallet' },
        { id: 'back_store', text: '🛍️ Try another product' },
      ]),
    });
  } catch (err) {
    logError('wallet.refund.notice', err, { orderId: order.id });
  }
  return { ok: true, message: `↩️ *${order.id}* — ${formatPrice(amount)} wallet me refund (balance ${formatPrice(res.balance)}).` };
}

/** Offer a non-wallet-paid customer: retry or refund to wallet. */
export async function offerRetryOrWallet(sock, order, headline) {
  const lang = getLang(order.jid);
  const own = [
    { id: `dp:${order.productId}`, label: '🔁 Retry with another product', keywords: ['retry', 'again', 'dobara'] },
    { id: `walrefund:${order.id}`, label: '💰 Refund to Wallet', keywords: ['refund', 'wallet'] },
    { id: 'menu:support', label: t('nav_support', {}, lang), keywords: ['support', 'help'] },
  ];
  const choices = withNavChoices(own);
  setUser(order.jid, { choices });
  await sendButtons(sock, order.jid, {
    title: `😕 ${order.id} — options`,
    text: [
      headline,
      '',
      'Kya karna chahenge?',
    ].join('\n'),
    buttons: choices.map((c) => ({ id: c.id, text: c.label })),
  });
  return true;
}

// Reminders live in handlers/orders.js — keep the import lazy so the
// orders <-> digitalStore cycle can never bite at module load.
async function clearReminderSafe(orderId) {
  try {
    const orders = await import('./orders.js');
    if (typeof orders.__clearOrderReminder === 'function') orders.__clearOrderReminder(orderId);
  } catch { /* reminders are cosmetic */ }
}

/**
 * Called by the activation poller when ProdSeller flips the order
 * to "delivered": send the key(s), close the order, run the same
 * thank-you → channel-link → review flow as an eSIM delivery.
 */
export async function deliverActivatedOrder(sock, orderId, psOrder) {
  const order = getOrder(orderId);
  if (!order) return { ok: false, message: `Order *${orderId}* nahi mila.` };
  if (order.status === 'fulfilled') return { ok: true, message: `*${orderId}* already delivered.` };

  await sendReceipt(sock, order);
  await sendDeliveredKeys(sock, order, psOrder);
  finalizeDigital(sock, order, order.confirmedBy || 'activation-poller', 'activation');
  resetUser(order.jid);
  flush();
  await startPostOrder(sock, order);
  logOrder('activation_delivered', { id: order.id }, { prodsellerOrderId: order.prodsellerOrderId });
  return { ok: true, message: `✅ *${order.id}* activation complete — key delivered.` };
}
