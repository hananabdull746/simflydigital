// ─────────────────────────────────────────────────────────────
// handlers/menu.js
// Welcome screen, plan catalogue, plan detail card, eSIM guide,
// support card, "My Orders", sold-out handling, language toggle,
// resume prompt and the reorder entry point.
//
// Rules honoured on every screen here:
//   • buttons/rows ALWAYS go through withNav()/withListNav() so
//     there is no dead-end (🏠 Main Menu + 🙋 Talk to Human)
//   • user.choices mirrors the DISPLAYED rows/buttons exactly so
//     the numbered plain-text fallback never mis-maps
//   • every body is 1–2 lines of text (footer comes from lib/ui)
//   • all customer-facing strings go through t() (lib/lang.js)
// ─────────────────────────────────────────────────────────────
import { BRAND, SETTINGS, formatPrice, SUPPORT_WA_LINK } from '../config.js';
import { getChannelLink } from '../lib/admins.js';
import { sendList, sendButtons, sendText } from '../lib/ui.js';
import { getPlan, allPlans, planSections, planDetailText } from '../lib/plans.js';
import { ordersFor, setUser } from '../lib/store.js';
import { getLang } from '../lib/users.js';
import { t } from '../lib/lang.js';
import { withNav, withListNav, withNavChoices, withAck, LIST_NAV_CHOICES } from './ui.js';
import { checkAllStock } from '../services/esimaccess.js';
import { resumableSession, clearSession } from '../lib/sessions.js';
import { STEP_PRODUCT_QTY, withStep } from '../lib/steps.js';

const fmtTime = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

const STATUS_LABEL = {
  await_screenshot: '⏳ Waiting for your screenshot',
  awaiting_screenshot: '⏳ Waiting for your screenshot',
  pending_admin: '🔍 Verification in progress',
  awaiting_supplier_funding: '🟠 Waiting for supplier funding',
  awaiting_activation: '📧 Activation in progress — key will arrive shortly',
  refunded: '↩️ Refunded to wallet',
  fulfilled: '✅ eSIM delivered',
  rejected: '🚫 Rejected — please contact support',
  cancelled: '⛔ Cancelled',
};

// Typed-input keywords (English stays the matching language).
const WELCOME_KEYWORDS = {
  'menu:plans': ['plans', 'plan', 'view plans', 'browse', 'data', 'bundle', 'rates', 'price'],
  'menu:orders': ['orders', 'my orders', 'order status', 'track', 'track my order'],
  'menu:support': ['support', 'talk', 'contact', 'help me', 'call'],
  'menu:how': ['how', 'esim', 'guide', 'works', 'what is esim'],
  'menu:store': ['store', 'shop', 'digital', 'products', 'digital store'],
  'menu:wallet': ['wallet', 'balance', 'my wallet', 'wallet balance'],
  'refer': ['refer', 'referral', 'refer and earn', 'invite', 'invite code', 'bonus', 'free credit'],
  'human': ['human', 'person', 'agent', 'team', 'baat'],
  'lang_toggle': ['language', 'lang', 'urdu', 'english'],
};

// ── Welcome rows (single source: rendered AND typed) ────────
function welcomeRows(lang) {
  const plans = planSections(null, lang).flatMap((s) => s.rows);
  const cheapest = allPlans().length ? Math.min(...allPlans().map((p) => p.price)) : 0;
  return [
    { id: 'menu:plans', title: t('nav_plans', {}, lang), description: t('row_plans', { n: plans.length, from: formatPrice(cheapest) }, lang) },
    { id: 'menu:store', title: '🛍️ Digital Store', description: 'Netflix, Canva, tools & more — instant + activation products' },
    { id: 'menu:wallet', title: '💰 My Wallet', description: 'Balance check + Add Money — screenshot-less payment' },
    { id: 'menu:orders', title: t('nav_orders', {}, lang), description: t('row_orders', {}, lang) },
    { id: 'refer', title: t('nav_refer', {}, lang), description: t('row_refer', { amount: SETTINGS.referralBonusPkr }, lang) },
    { id: 'menu:support', title: t('nav_support', {}, lang), description: t('row_support', {}, lang) },
    { id: 'menu:how', title: t('nav_how', {}, lang), description: t('row_how', {}, lang) },
    { id: 'human', title: t('nav_human', {}, lang), description: t('row_human', {}, lang) },
    { id: 'lang_toggle', title: t('nav_lang', {}, lang), description: t('row_lang', {}, lang) },
  ];
}

export function welcomeChoices(lang) {
  return welcomeRows(lang).map((r) => ({
    id: r.id,
    label: r.title,
    keywords: WELCOME_KEYWORDS[r.id] || [],
  }));
}

/** One choice per plan row (typed + numbered input). */
function planChoices(stock, lang) {
  return planSections(stock, lang).flatMap((section) =>
    section.rows.map((row) => {
      const plan = getPlan(row.id.slice('plan:'.length));
      const short = plan?.name?.replace(/^pakistan\s+/i, '').toLowerCase();
      return {
        id: row.id,
        label: row.title,
        keywords: plan
          ? [plan.name.toLowerCase(), formatPrice(plan.price).toLowerCase(), String(plan.price), ...(short ? [short] : [])]
          : [],
      };
    })
  );
}

const orderChoice = (o) => ({
  id: `orderinfo:${o.id}`,
  label: `${o.id} — ${o.planName}`,
  keywords: [o.id.toLowerCase()],
});

// ── 1. Welcome (LIST message) ───────────────────────────────
export async function sendWelcome(sock, jid) {
  const lang = getLang(jid);
  // A returning customer with an unfinished order gets the resume
  // prompt instead of a plain menu (feature: resume broken flow).
  if (resumableSession(jid)) return sendResumePrompt(sock, jid);

  const rows = welcomeRows(lang);
  const choices = welcomeChoices(lang);
  setUser(jid, { flow: 'menu', choices });

  await sendList(sock, jid, {
    title: `👋 ${BRAND.name}`,
    buttonText: '📋 Open Menu',
    text: [
      t('welcome_greet', {}, lang),
      '',
      t('welcome_brand', { brand: BRAND.name, tagline: BRAND.tagline }, lang),
      t('welcome_network', { network: BRAND.network }, lang),
      t('welcome_choose', {}, lang),
      getChannelLink() ? t('welcome_channel', { link: getChannelLink() }, lang) : null,
    ]
      .filter(Boolean)
      .join('\n'),
    sections: [{ title: 'Main Menu', rows }],
  });
}

// ── 2. Plans LIST message (stock-checked first) ─────────────
export async function sendPlans(sock, jid) {
  const lang = getLang(jid);
  return withAck(jid, t('ack_stock', {}, lang), async () => {
    const stock = await checkAllStock(); // 60s cached, local fallback
    const sections = withListNav(planSections(stock, lang));
    const choices = [...planChoices(stock, lang), ...LIST_NAV_CHOICES];
    setUser(jid, { flow: 'choose_plan', planId: null, choices });

    await sendList(sock, jid, {
      title: `📶 ${BRAND.name} Data Plans`,
      buttonText: '📶 Select a Plan',
      text: [
        t('plans_head', { network: BRAND.network }, lang),
        t('plans_pick', {}, lang),
      ].join('\n'),
      sections,
    });
  });
}

// ── Sold-out plan (feature 7) ───────────────────────────────
/**
 * @param phase 'browse' → See Other Plans + Notify Me
 *              'paid'   → customer already paid: also offer Support (refund path)
 */
export async function sendOutOfStock(sock, jid, planId, { phase = 'browse' } = {}) {
  const lang = getLang(jid);
  const plan = getPlan(planId);
  const own = [
    { id: 'back_plans', label: t('nav_other_plans', {}, lang), keywords: ['plans', 'other', 'see', 'back'] },
    { id: `notify_me:${planId}`, label: t('nav_notify_me', {}, lang), keywords: ['notify', 'alert', 'remind', 'notify me'] },
  ];
  if (phase === 'paid') {
    own.push({ id: 'menu:support', label: t('nav_support_refund', {}, lang), keywords: ['support', 'refund'] });
  }
  const choices = withNavChoices(own);
  setUser(jid, { flow: 'choose_plan', planId: plan?.id || planId, choices });

  await sendButtons(sock, jid, {
    title: t('oos_title', {}, lang),
    text: phase === 'paid'
      ? t('oos_paid', { plan: plan?.name || planId }, lang)
      : t('oos_body', { plan: plan?.name || planId }, lang),
    buttons: choices.map((c) => ({ id: c.id, text: c.label })),
  });
  return true;
}

// ── 3. Plan detail BUTTON message ───────────────────────────
export async function sendPlanDetail(sock, jid, planId) {
  const lang = getLang(jid);
  const plan = getPlan(planId);
  if (!plan) {
    await sendText(sock, jid, t('plan_unknown', {}, lang));
    return sendPlans(sock, jid);
  }

  return withAck(jid, t('ack_stock', {}, lang), async () => {
    const stock = await checkAllStock(); // cached — cheap
    const s = stock[plan.id];
    if (s && s.ok === false) return sendOutOfStock(sock, jid, plan.id, { phase: 'browse' });

    const own = [
      { id: 'order_now', label: t('nav_order_now', {}, lang), keywords: ['order', 'order now', 'buy', 'purchase', 'len', 'kharid'] },
      { id: 'back_plans', label: t('nav_back_plans', {}, lang), keywords: ['back', 'back to plans', 'plans', 'go back'] },
    ];
    const choices = withNavChoices(own);
    setUser(jid, { flow: 'plan_view', planId: plan.id, choices });

    await sendButtons(sock, jid, {
      title: `📶 ${plan.name}`,
      text: withStep(STEP_PRODUCT_QTY, planDetailText(plan, lang)),
      buttons: choices.map((c) => ({ id: c.id, text: c.label })),
    });
    return true;
  });
}

// ── 4. How eSIM works (BUTTON message) ──────────────────────
// Short factual framing ONLY: data/roaming profile vs. local SIM.
// Never phrase this as getting around any registration — it is a
// technical distinction, not a circumvention claim.
export async function sendHowEsim(sock, jid) {
  const lang = getLang(jid);
  const own = [
    { id: 'menu:plans', label: t('nav_plans', {}, lang), keywords: ['plans', 'plan', 'data', 'order', 'browse'] },
    { id: 'back_menu', label: t('nav_back_menu', {}, lang), keywords: ['menu', 'back', 'home'] },
  ];
  const choices = withNavChoices(own);
  setUser(jid, { flow: 'how', choices });

  await sendButtons(sock, jid, {
    title: '❓ How eSIM Works',
    text: [
      t('how_line1', {}, lang),
      t('how_line2', {}, lang),
      t('how_line3', {}, lang),
      t('how_line4', {}, lang),
      getChannelLink() ? t('welcome_channel', { link: getChannelLink() }, lang) : null,
    ]
      .filter(Boolean)
      .join('\n'),
    buttons: choices.map((c) => ({ id: c.id, text: c.label })),
  });
}

// ── 5. Support card ─────────────────────────────────────────
export async function sendSupport(sock, jid) {
  const lang = getLang(jid);
  const own = [
    { id: 'human', label: t('nav_human', {}, lang), keywords: ['human', 'agent', 'person', 'team'] },
    { id: 'back_menu', label: t('nav_back_menu', {}, lang), keywords: ['menu', 'back', 'home'] },
  ];
  const choices = withNavChoices(own);
  setUser(jid, { flow: 'support', choices });

  await sendButtons(sock, jid, {
    title: '💬 Talk to Support',
    text: [
      t('support_brand', { brand: BRAND.name }, lang),
      '',
      t('support_wa', { link: SUPPORT_WA_LINK || 'isi chat par' }, lang),
      t('support_hours', {}, lang),
      t('support_pitch', {}, lang),
    ].join('\n'),
    buttons: choices.map((c) => ({ id: c.id, text: c.label })),
  });
}

// ── 6. My Orders (last 3 + one-tap reorder) ─────────────────
export async function sendMyOrders(sock, jid, opts = {}) {
  const lang = getLang(jid);
  const run = async () => {
    const orders = ordersFor(jid).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

    if (orders.length === 0) {
      const own = [
        { id: 'menu:plans', label: t('nav_view_plans', {}, lang), keywords: ['plans', 'plan', 'data', 'order', 'browse'] },
        { id: 'back_menu', label: t('nav_back_menu', {}, lang), keywords: ['menu', 'back', 'home'] },
      ];
      const choices = withNavChoices(own);
      setUser(jid, { flow: 'choose_order', choices });
      return sendButtons(sock, jid, {
        title: '📦 My Orders',
        text: [t('orders_none', {}, lang), '', t('orders_empty_body', {}, lang)].join('\n'),
        buttons: choices.map((c) => ({ id: c.id, text: c.label })),
      });
    }

    // Spec shortcut: a single order jumps straight to its detail card.
    if (orders.length === 1) return sendOrderInfo(sock, jid, orders[0].id);

    // Show the LAST 3 orders (plan • price • date • status).
    const top = orders.slice(0, 3);
    const sections = withListNav([
      {
        title: 'Your Orders',
        rows: top.map((o) => ({
          id: `orderinfo:${o.id}`,
          title: `${o.id} — ${o.planName}`,
          description: `${formatPrice(o.price)} • ${o.status === 'fulfilled' ? `${fmtTime(o.createdAt)} • ` : ''}${STATUS_LABEL[o.status] || o.status}`,
        })),
      },
    ]);
    const choices = [...top.map(orderChoice), ...LIST_NAV_CHOICES];
    setUser(jid, { flow: 'choose_order', choices });

    await sendList(sock, jid, {
      title: `📦 My Orders (${orders.length})`,
      buttonText: '📋 View Order',
      text: t('orders_list_hint', {}, lang),
      sections,
    });

    // One-tap reorder on the most recent COMPLETED order.
    const lastDone = top.find((o) => o.status === 'fulfilled');
    if (lastDone) {
      const own = [{ id: 'reorder', label: t('nav_reorder', {}, lang), keywords: ['reorder', 'again', 'same', 'same again'] }];
      const reorderChoices = withNavChoices(own);
      setUser(jid, { flow: 'choose_order', choices: reorderChoices });
      await sendButtons(sock, jid, {
        title: '🔁 One-tap reorder',
        text: t('reorder_offer', { plan: lastDone.planName, price: formatPrice(lastDone.price) }, lang),
        buttons: reorderChoices.map((c) => ({ id: c.id, text: c.label })),
      });
    }
    return true;
  };
  // opts.silent skips the "⏳" ack — used right after a delete
  // confirmation so the customer never gets a burst of messages.
  if (opts.silent) return run();
  return withAck(jid, t('ack_orders', {}, lang), run);
}

// ── 7. Single order detail (button message) ─────────────────
export async function sendOrderInfo(sock, jid, orderId) {
  const lang = getLang(jid);
  const order = ordersFor(jid)
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .find((o) => o.id === String(orderId).toUpperCase());

  if (!order) {
    await sendText(sock, jid, t('order_not_found', { id: orderId }, lang));
    return sendMyOrders(sock, jid);
  }

  const own = [];
  if (order.status === 'fulfilled') {
    own.push({ id: 'reorder', label: t('nav_reorder', {}, lang), keywords: ['reorder', 'again', 'same', 'same again'] });
  }
  // Cancel works while the order is still open; on a finished order
  // it replies with a one-liner. Delete hides it from this list.
  own.push({ id: 'cancel_order', label: t('btn_cancel_order', {}, lang), keywords: ['cancel', 'order cancel'] });
  own.push({ id: 'delete_order', label: '🗑️ Delete Order', keywords: ['delete', 'remove', 'hatana'] });
  own.push({ id: 'back_menu', label: t('nav_back_menu', {}, lang), keywords: ['menu', 'back', 'home'] });
  const choices = withNavChoices(own);
  setUser(jid, { flow: 'order_info', orderId: order.id, choices });

  await sendButtons(sock, jid, {
    title: `🎫 ${order.id}`,
    text: [
      `*${order.id}* — ${STATUS_LABEL[order.status] || order.status}`,
      '',
      t('orderinfo_plan', { v: order.planName }, lang),
      `📊 ${order.data} • ${order.validity}`,
      (Number(order.quantity) || 1) > 1 ? `📦 ${order.quantity} eSIMs` : null,
      t('orderinfo_price', { v: formatPrice(order.price) }, lang),
      t('orderinfo_payment', { v: order.paymentLabel }, lang),
      t('orderinfo_placed', { v: fmtTime(order.createdAt) }, lang),
      order.note ? t('orderinfo_note', { v: order.note }, lang) : '',
    ]
      .filter(Boolean)
      .join('\n'),
    buttons: choices.map((c) => ({ id: c.id, text: c.label })),
  });
}

// ── 8. Resume broken flow (feature 3) ───────────────────────
export const RESUME_KEYWORDS = {
  resume_continue: ['continue', 'resume', 'yes', 'haan', 'wapas'],
  resume_start: ['start over', 'restart', 'new', 'naya', 'fresh'],
  resume_menu: ['menu', 'home', 'main menu'],
};

export async function sendResumePrompt(sock, jid) {
  const lang = getLang(jid);
  const session = resumableSession(jid);
  if (!session) return sendWelcome(sock, jid);

  // Two carts, one prompt: the resumed item can be an eSIM plan or
  // a Digital Store product (handlers/checkout.js decides later).
  let name = null;
  let price = 0;
  let planId = null;
  if (session.selectedProductId) {
    const { digitalProductView } = await import('./digitalStore.js');
    const product = await digitalProductView(session.selectedProductId);
    if (!product) {
      clearSession(jid);
      return sendWelcome(sock, jid);
    }
    name = product.name;
    price = product.pricePkr;
  } else {
    const plan = getPlan(session.selectedPlanId);
    if (!plan) {
      clearSession(jid);
      return sendWelcome(sock, jid);
    }
    name = plan.name;
    price = plan.price;
    planId = plan.id;
  }

  const choices = [
    { id: 'resume_continue', label: '✅ Continue', keywords: RESUME_KEYWORDS.resume_continue },
    { id: 'resume_start', label: '🆕 Start Over', keywords: RESUME_KEYWORDS.resume_start },
    { id: 'resume_menu', label: '🏠 Main Menu', keywords: RESUME_KEYWORDS.resume_menu },
    { id: 'human', label: t('nav_human', {}, lang), keywords: ['human', 'agent', 'person', 'team'] },
  ];
  setUser(jid, {
    flow: 'menu',
    planId,
    dpId: session.selectedProductId || null,
    choices,
  });

  await sendButtons(sock, jid, {
    title: '🔄 Continue your order?',
    text: t('resume_prompt', { plan: name, price: formatPrice(price) }, lang),
    buttons: choices.map((c) => ({ id: c.id, text: c.label })),
  });
  return true;
}

// ── 9. Language toggle (feature 9) ──────────────────────────
export async function sendLanguageScreen(sock, jid) {
  const lang = getLang(jid);
  const own = [
    { id: 'lang_en', label: '🇬🇧 English', keywords: ['english', 'en', 'eng'] },
    { id: 'lang_ur', label: '🇵🇰 Roman Urdu', keywords: ['urdu', 'roman urdu', 'ur', 'default'] },
  ];
  const choices = withNavChoices(own);
  setUser(jid, { flow: 'menu', choices });

  await sendButtons(sock, jid, {
    title: '🌐 Language',
    text: t('lang_screen', { current: lang === 'en' ? 'English' : 'Roman Urdu' }, lang),
    buttons: choices.map((c) => ({ id: c.id, text: c.label })),
  });
  return true;
}
