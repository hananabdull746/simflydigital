// ─────────────────────────────────────────────────────────────
// config.js
// Central configuration. Everything user-tunable comes from .env
// so nothing (payment accounts, admin number, supplier keys) is
// ever hardcoded. See .env.example for the documented list.
// ─────────────────────────────────────────────────────────────
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Parse a boolean env flag ("true"/"1"/"yes"). */
function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

/** Parse a number env flag with a fallback. */
function int(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Parse a decimal env flag (rates, percentages) with a fallback. */
function num(value, fallback) {
  const n = Number.parseFloat(value ?? '');
  return Number.isFinite(n) ? n : fallback;
}

/** First non-empty env value among the given keys (in order). */
function first(...keys) {
  for (const key of keys) {
    const v = process.env[key];
    if (v !== undefined && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/**
 * Turn any user-supplied phone number into a canonical WhatsApp JID.
 * Accepts: "03001234567", "923001234567", "3001234567",
 *          "923001234567@s.whatsapp.net" or a bare "923001234567:12".
 */
export function toJid(input) {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  if (raw.includes('@')) return raw.split(':')[0];

  let digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('0')) digits = '92' + digits.slice(1);      // local PK format
  else if (digits.startsWith('92')) { /* already international */ }
  else if (digits.length === 10) digits = '92' + digits;            // 3001234567
  return `${digits}@s.whatsapp.net`;
}

/** The bare phone number part of a JID, e.g. "923001234567". */
export function jidUser(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}

/** Split a comma/space separated phone list into canonical JIDs. */
export function toJidList(value) {
  return String(value || '')
    .split(/[,\s;]+/)
    .map((part) => toJid(part))
    .filter(Boolean)
    .filter((jid, i, arr) => arr.indexOf(jid) === i);
}

/** True when the given JID is the configured admin. */
export function isAdmin(jid) {
  if (!ADMIN_JID) return false;
  return jidUser(jid) === jidUser(ADMIN_JID);
}

const ROOT = __dirname;

export const AUTH_DIR = path.resolve(ROOT, process.env.AUTH_DIR || 'auth_info');
export const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
export const DB_DIR = path.resolve(ROOT, process.env.DB_DIR || 'db');
export const LOG_DIR = path.resolve(ROOT, process.env.LOG_DIR || 'logs');

// Catalogue meta (network / activation wording) lives in
// data/plans.json so the menu, plan cards and this banner never
// disagree. Re-read once at boot; the plan LIST itself is live.
const catalogueMeta = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'plans.json'), 'utf8'));
  } catch {
    return {};
  }
})();

export const BRAND = {
  // BRAND_NAME is the ONE brand-facing name in the whole project.
  // (BOT_DISPLAY_NAME / FOOTER_TEXT are gone — see .env.example.)
  name: first('BRAND_NAME') || 'Simfly Store',
  tagline: process.env.BRAND_TAGLINE || 'Aapki Digital Zaroorat, Ek Store Mein',
  /**
   * Watermark stamped into the footer of every list / button message.
   * DERIVED — never assigned. Built from the two env vars so the
   * footer can never drift from the brand name/tagline again:
   *     "{BRAND_NAME} ⚡ {BRAND_TAGLINE}"
   */
  get footer() {
    return `${this.name} ⚡ ${this.tagline}`;
  },
  network: catalogueMeta.network || 'Telenor/Zong 4G',
  currency: 'PKR',
  activation: catalogueMeta.activation || 'Activation guide in chat',
};

export const ADMIN_JID = toJid(process.env.ADMIN_WHATSAPP_NUMBER);
export const SUPPORT_JID = toJid(process.env.SUPPORT_WHATSAPP_NUMBER) || ADMIN_JID;

// ── Admin system: roles ────────────────────────────────────────
// ADMIN_WHATSAPP_NUMBER stays the primary owner. ADMIN_NUMBERS adds
// more owners, STAFF_NUMBERS adds the limited role (orders /
// customers / support only — no prices, settings, broadcast,
// exports or blocklist). Identity is ALWAYS the sender JID number.
export const OWNER_JIDS = (() => {
  const list = [ADMIN_JID, ...toJidList(first('ADMIN_NUMBERS'))].filter(Boolean);
  return list.filter((jid, i) => list.indexOf(jid) === i);
})();

export const STAFF_JIDS = (() => {
  const owners = OWNER_JIDS.map(jidUser);
  return toJidList(first('STAFF_NUMBERS')).filter((jid) => !owners.includes(jidUser(jid)));
})();

export const ALL_ADMIN_JIDS = [...OWNER_JIDS, ...STAFF_JIDS];

/** `https://wa.me/<number>` for the support/admin contact (used in CTA links). */
export const SUPPORT_WA_LINK = SUPPORT_JID
  ? `https://wa.me/${jidUser(SUPPORT_JID)}`
  : 'https://wa.me/';

export const SETTINGS = {
  // Spec: 15 min with no admin action => auto-update to customer + admin ping.
  autoReminderMs: int(process.env.AUTO_REMINDER_MINUTES, 15) * 60 * 1000,
  // Post-delivery review request delay (spec: "a short delay").
  reviewDelayMs: int(process.env.REVIEW_DELAY_MINUTES, 2) * 60 * 1000,
  rateLimitMax: int(process.env.RATE_LIMIT_MAX, 8),
  rateLimitWindowMs: int(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
  menuCooldownMs: int(process.env.MENU_COOLDOWN_MS, 5_000),
  forcePlain: bool(process.env.FORCE_PLAIN_TEXT, false),
  // ── UX batch ──────────────────────────────────────────────
  // Loyalty: completed orders needed for a reward + reward %.
  loyaltyOrders: int(process.env.LOYALTY_ORDERS, 5),
  loyaltyDiscountPercent: int(process.env.LOYALTY_DISCOUNT_PERCENT, 10),
  // How long one supplier stock snapshot stays fresh (seconds).
  stockCacheSeconds: int(process.env.STOCK_CACHE_SECONDS, 60),
  // Step 1 (Choose & Confirm) — biggest eSIM quantity one order may
  // hold. Each unit is bought and delivered as its OWN eSIM.
  maxQtyEsim: Math.max(1, int(process.env.MAX_QTY_ESIM, 3)),
  // Unfinished order sessions are offered for resume up to this long.
  sessionTtlHours: int(process.env.SESSION_TTL_HOURS, 24),
  // How long "🙋 Talk to Human" silences the bot for that customer.
  humanModeMinutes: int(process.env.HUMAN_MODE_MINUTES, 30),
  // Cron expression for the plan alert checker (stock + price drops).
  alertsCron: first('ALERTS_CRON') || '*/15 * * * *',
  // NayaPay auto-verifier status (see services/verifier.js).
  nayapayAutoVerify: bool(process.env.NAYAPAY_AUTO_VERIFY, false),
  // ── Admin system ───────────────────────────────────────────
  // Orders above this amount need a SECOND confirmation tap.
  confirmTwiceAbove: int(process.env.CONFIRM_TWICE_ABOVE_PKR, 3000),
  // Broadcast safety valves (unofficial WhatsApp route = ban risk).
  broadcastPerMinute: Math.max(1, int(process.env.BROADCAST_MSGS_PER_MINUTE, 8)),
  broadcastDailyCap: Math.max(1, int(process.env.BROADCAST_DAILY_CAP, 200)),
  // "min-max" ms of random extra delay between two DMs (tests use "0-0").
  broadcastJitterMs: (() => {
    const raw = String(process.env.BROADCAST_JITTER_MS || '').trim();
    if (!raw) return [3_000, 9_000];
    const [a, b] = raw.split('-');
    const min = Math.max(0, Number(a) || 0);
    const max = Math.max(min, Number(b ?? a) || 0);
    return [min, max];
  })(),
  // Supplier account balance alert threshold (USD, 0 = never alert).
  supplierLowBalanceUsd: int(process.env.SUPPLIER_LOW_BALANCE_USD, 10),
  // Pending-order reminder cadence for admins (max 3 per order).
  adminReminderMs: int(process.env.ADMIN_REMINDER_MINUTES, 15) * 60 * 1000,
  adminReminderMax: 3,
  // Daily/weekly admin summary times (server cron, PKT timezone).
  dailySummaryCron: first('DAILY_SUMMARY_CRON') || '0 21 * * *',
  weeklySummaryCron: first('WEEKLY_SUMMARY_CRON') || '0 9 * * 1',
  // 🌐 row of the admin panel — URL of the web dashboard. Empty
  // falls back to http://localhost:<DASHBOARD_PORT> when the
  // bundled dashboard is enabled (see dashboard/server.js).
  dashboardUrl: first('DASHBOARD_URL'),

  // ── Digital Store (ProdSeller) ────────────────────────────
  // USD -> PKR conversion used to price the digital catalogue.
  usdPkrRate: num(process.env.USD_PKR_RATE, 278),
  // Global margin applied on top of ProdSeller's `price` field.
  // Per-product overrides live in data/digitalProductOverrides.json.
  digitalMarkupPercent: num(process.env.DIGITAL_MARKUP_PERCENT, 50),
  // Catalogue cache TTL (seconds). Last-known-good is kept on failure.
  productCacheSeconds: int(process.env.PRODSELLER_CACHE_SECONDS, 300),
  // ProdSeller wallet low-balance threshold (USDT).
  prodsellerLowBalanceUsd: num(process.env.PRODSELLER_LOW_BALANCE_USD, 15),
  // Customer-facing ETA for email-activation products.
  activationEtaLabel: first('ACTIVATION_ETA_LABEL') || 'usually within 2-6 hours',
  activationPollMinutes: Math.max(1, int(process.env.ACTIVATION_POLL_MINUTES, 2)),
  activationMaxWaitHours: Math.max(1, int(process.env.ACTIVATION_MAX_WAIT_HOURS, 6)),
  // 📌 Pinned price floor: an admin-pinned PKR price keeps holding
  // until the margin it yields drops below this ROI (%).
  pinnedMarkupFloor: num(process.env.PINNED_MARKUP_FLOOR, 50),
  // Daily catalogue re-fetch (node-cron). Refreshes supplier prices
  // + balance and pages the owner when prices moved.
  priceSyncCron: first('PRICE_SYNC_CRON') || '0 6 * * *',
  priceSyncEnabled: bool(process.env.PRICE_SYNC_ENABLED, true),

  // ── Dual-supplier compare engine (ProdSeller + Eklas) ──────
  // How long a computed "cheapest + in stock" snapshot stays fresh
  // (seconds) before the catalogue layer re-queries BOTH suppliers.
  productCompareCacheSeconds: Math.max(1, int(process.env.PRODUCT_COMPARE_CACHE_SECONDS, 120)),
  // Eklas wallet low-balance threshold (USDT) — own alert, own
  // threshold, deliberately separate from PRODSELLER_LOW_BALANCE_USD.
  eklasLowBalanceUsd: num(process.env.EKLAS_LOW_BALANCE_USD, 15),

  // ── Natural pacing / bot maturity ─────────────────────────
  // Delay before a reply: length-proportional, clamped to [min,max].
  minReplyDelayMs: int(process.env.MIN_REPLY_DELAY_MS, 700),
  maxReplyDelayMs: int(process.env.MAX_REPLY_DELAY_MS, 2800),
  // Messages from one customer inside this window are debounced
  // (buffered + processed together) instead of answered one by one.
  debounceWindowMs: Math.max(0, int(process.env.DEBOUNCE_WINDOW_MS, 1500)),
  // A star-rating prompt nobody answers is quietly dropped after
  // this many hours — never chased.
  reviewPromptTimeoutHours: Math.max(1, int(process.env.REVIEW_PROMPT_TIMEOUT_HOURS, 6)),
  // Minimum gap between two proactive nudges (reminder, thank-you,
  // review prompt) to the same customer — 0 disables the rule.
  broadcastMinGapMinutes: Math.max(0, int(process.env.BROADCAST_MIN_GAP_MINUTES, 30)),

  // ── Customer wallet ───────────────────────────────────────
  walletEnabled: bool(process.env.WALLET_ENABLED, true),
  walletTopupMin: int(process.env.WALLET_TOPUP_MIN, 100),
  walletTopupMax: int(process.env.WALLET_TOPUP_MAX, 20000),
  // Anti-abuse: max top-up attempts a customer may start inside the window.
  walletTopupMaxAttempts: int(process.env.WALLET_TOPUP_MAX_ATTEMPTS, 5),
  walletTopupWindowMs: int(process.env.WALLET_TOPUP_WINDOW_MS, 600_000),
  // ── Purple Cow layer (marketing) ───────────────────────────
  // ⚡ Fast Guarantee: delivery inside this many minutes is badged,
  //    beyond it the bot credits the wallet WITHOUT being asked.
  fastGuaranteeMinutes: Math.max(1, int(process.env.FAST_GUARANTEE_MINUTES, 15)),
  fastGuaranteeCreditPkr: Math.max(0, int(process.env.FAST_GUARANTEE_CREDIT_PKR, 100)),
  // 📦 Digital unboxing: the short "it landed" beat sequence that
  //    runs (paced) BEFORE the thank-you. `off` disables it.
  unboxing: String(process.env.UNBOXING_MODE || 'on').trim().toLowerCase() !== 'off',
  // 🎁 Referral loop: bonus for BOTH sides, capped per referrer/month.
  referralBonusPkr: Math.max(0, int(process.env.REFERRAL_BONUS_PKR, 100)),
  referralMonthlyCapPkr: Math.max(0, int(process.env.REFERRAL_MONTHLY_CAP, 1000)),

  // Internal web dashboard (dashboard/server.js) — 0 disables it.
  dashboardPort: int(process.env.DASHBOARD_PORT, 0),
  dashboardToken: first('DASHBOARD_TOKEN'),

  // 🏪 WhatsApp Catalog (services/catalogService.js): pause between
  //    two catalogue mutations — WA rate-limits productCreate/Update.
  catalogSyncDelayMs: Math.max(0, int(process.env.CATALOG_SYNC_DELAY_MS, 300)),
  //    Products pushed to the catalog per single sync run (the rest waits
  //    for the next run). 100 = one run covers the whole seeded catalog.
  catalogSyncBatch: Math.max(1, int(process.env.CATALOG_SYNC_BATCH, 100)),
};

/** WhatsApp Channel invite link (post-order thank-you + review broadcasts). */
export const CHANNEL_LINK = first('WHATSAPP_CHANNEL_LINK');
/** Optional direct channel JID (e.g. 120363…@newsletter) — skips invite resolution. */
export const CHANNEL_JID = first('WHATSAPP_CHANNEL_JID');
/** "Order now" CTA used inside auto-posted reviews (falls back to a wa.me chat link). */
export const ORDER_LINK = first('ORDER_LINK') || SUPPORT_WA_LINK;

/**
 * eSIMaccess.com supplier credentials.
 * The bot works without them (local catalogue + admin-managed delivery),
 * but purchaseEsim()/checkStock() only hit the real supplier when both
 * key and secret are set. See services/esimaccess.js.
 */
export const ESIMACCESS = {
  apiKey: first('ESIMACCESS_API_KEY'),
  apiSecret: first('ESIMACCESS_API_SECRET'),
  baseUrl: first('ESIMACCESS_BASE_URL') || 'https://api.esimaccess.com',
  timeoutMs: int(process.env.ESIMACCESS_TIMEOUT_MS, 15_000),
  get isConfigured() {
    return Boolean(this.apiKey && this.apiSecret);
  },
};

/**
 * ProdSeller (prodseller.com/v1) — the SECOND catalogue: digital
 * subscriptions / accounts / keys. The key only ever leaves the
 * process inside the X-API-Key header to prodseller.com.
 * See services/prodseller.js and README → "Digital Store".
 */
export const PRODSELLER = {
  apiKey: first('PRODSELLER_API_KEY'),
  baseUrl: first('PRODSELLER_BASE_URL') || 'https://prodseller.com/v1',
  timeoutMs: int(process.env.PRODSELLER_TIMEOUT_MS, 15_000),
  get isConfigured() {
    return Boolean(this.apiKey);
  },
};

/**
 * Eklas (api.eklas.dev/v1) — the SECOND digital supplier, so the
 * store can pick whichever of ProdSeller / Eklas is cheaper and in
 * stock for each product (see services/productCatalog.js).
 *
 * NOTE the auth style is DIFFERENT from ProdSeller:
 *   ProdSeller → X-API-Key header
 *   Eklas      → Authorization: Bearer <key>
 * The key only ever leaves the process inside that Bearer header.
 */
export const EKLAS = {
  apiKey: first('EKLAS_API_KEY'),
  baseUrl: first('EKLAS_BASE_URL') || 'https://api.eklas.dev/v1',
  timeoutMs: int(process.env.EKLAS_TIMEOUT_MS, 15_000),
  get isConfigured() {
    return Boolean(this.apiKey);
  },
};

/**
 * Binance Pay — the USDT checkout with AUTO-VERIFICATION.
 * The customer is shown a USDT amount + our Binance Pay ID, then
 * types their Transaction ID; the bot looks it up on Binance
 * (GET /sapi/v1/pay/transactions) instead of asking for a screenshot.
 *
 * Deliberately SEPARATE from PAYMENT_BINANCE_ID (the older
 * "send crypto to this Binance ID" method) — this one needs a
 * read-only API key + secret to sign the lookup.
 *
 *   apiKey / apiSecret  read-only spot key (X-MBX-APIKEY header)
 *   payId               the Binance Pay ID customers pay TO
 *   mode                'off'     → never look up, always admin
 *                       'shadow'  → look up + report, still admin
 *                       'auto'    → a clean match fulfils itself
 */
export const BINANCE_PAY = {
  apiKey: first('BINANCE_API_KEY'),
  apiSecret: first('BINANCE_API_SECRET'),
  payId: first('BINANCE_PAY_ID'),
  baseUrl: first('BINANCE_BASE_URL') || 'https://api.binance.com',
  timeoutMs: int(process.env.BINANCE_TIMEOUT_MS, 15_000),
  // PKR per USDT — its OWN rate (USDT trades at a small premium or
  // discount to the dollar), defaulting to USD_PKR_RATE so checkout
  // works before anyone sets it.
  usdtPkrRate: num(process.env.USDT_PKR_RATE, num(process.env.USD_PKR_RATE, 278)),
  // How far either side of "now" a transaction may sit and still match.
  matchWindowMinutes: Math.max(1, int(process.env.BINANCE_MATCH_WINDOW_MIN, 60)),
  // The retry loop: look again every retryMs until maxWaitMs.
  retryMs: Math.max(1_000, int(process.env.BINANCE_RETRY_MS, 20_000)),
  maxWaitMs: Math.max(5_000, int(process.env.BINANCE_MAX_WAIT_MS, 300_000)),
  // Rollout: ship in 'shadow', promote to 'auto' once you trust it.
  mode: ['off', 'shadow', 'auto'].includes(String(process.env.BINANCE_VERIFIER_MODE || '').trim().toLowerCase())
    ? String(process.env.BINANCE_VERIFIER_MODE).trim().toLowerCase()
    : 'shadow',
  /** API key + secret present (the lookup can be signed). */
  get hasKey() {
    return Boolean(this.apiKey && this.apiSecret);
  },
  /** Key AND the Pay ID customers pay into are all present. */
  get isConfigured() {
    return this.hasKey && Boolean(this.payId);
  },
};

/**
 * AI Payment Decision Engine (Part B).
 *
 * Deterministic verification ALWAYS runs first (services/verifier.js
 * for parsed payment emails, services/binanceVerifier.js for Binance).
 * The models are only ever consulted when that code says "I cannot
 * tell" — and even then they can never override a hard invariant.
 *
 *   groq*        the analyst: one low-temperature JSON verdict
 *   gemini*      vision: reads the payment screenshot (amount / txn id)
 *   timeoutMs    give up and hand the order to the admin
 *   mode         'off'     → never call a model, code only
 *                'shadow'  → call + report on the admin card, never act
 *                'auto'    → may act, but ONLY when every invariant holds
 */
export const AI_VERIFY = {
  groqApiKey: first('GROQ_API_KEY'),
  groqModel: first('GROQ_MODEL') || 'llama-3.3-70b-versatile',
  geminiApiKey: first('GEMINI_API_KEY'),
  geminiModel: first('GEMINI_MODEL') || 'gemini-2.0-flash',
  groqBaseUrl: first('GROQ_BASE_URL') || 'https://api.groq.com/openai/v1',
  geminiBaseUrl: first('GEMINI_BASE_URL') || 'https://generativelanguage.googleapis.com/v1beta',
  timeoutMs: Math.max(1_000, int(process.env.AI_DECISION_TIMEOUT_MS, 8_000)),
  /** Read live so a mode flip (env / settings / test) takes effect at once. */
  get mode() {
    const raw = String(process.env.AI_VERIFIER_MODE || '').trim().toLowerCase();
    return ['off', 'shadow', 'auto'].includes(raw) ? raw : 'shadow';
  },
  /** The analyst can be called at all. */
  get enabled() {
    return Boolean(this.groqApiKey) && this.mode !== 'off';
  },
  /** Screenshot reading is available. */
  get visionEnabled() {
    return Boolean(this.geminiApiKey);
  },
};

/**
 * Payment methods rendered to the customer.
 * Primary keys are the spec variables (PAYMENT_*); the older
 * JAZZCASH_NUMBER / EASYPAISA_NUMBER / BANK_* names still work.
 * A method is only offered when its account details are configured.
 */
const PAYMENT_DEFS = [
  {
    id: 'pay_sadapay',
    key: 'sadapay',
    label: 'SadaPay',
    icon: '\uD83D\uDCB3',
    // Hidden entirely until an account number is configured.
    fields: first('PAYMENT_SADAPAY_NUMBER', 'SADAPAY_NUMBER')
      ? [
          ['Account', first('PAYMENT_SADAPAY_NUMBER', 'SADAPAY_NUMBER')],
          ['Title', first('PAYMENT_SADAPAY_TITLE', 'SADAPAY_TITLE')],
        ]
      : [],
  },
  {
    // 💳 Binance Pay — USDT amount + Transaction ID, no screenshot.
    // The bespoke screen lives in handlers/payments.js
    // (sendBinancePayDetails) — `details` here only decides whether
    // the button is shown at all.
    id: 'pay_binancepay',
    key: 'binancepay',
    label: 'Binance Pay',
    icon: '\uD83D\uDCB3',
    fields: first('BINANCE_PAY_ID')
      ? [
          ['Binance Pay ID', first('BINANCE_PAY_ID')],
          ['Coin', 'USDT'],
        ]
      : [],
  },
  {
    id: 'pay_binance',
    key: 'binance',
    label: 'Binance ID',
    icon: '\uD83D\uDCB3',
    // Hidden entirely until the Binance ID is configured.
    fields: first('PAYMENT_BINANCE_ID', 'BINANCE_ID')
      ? [
          ['Binance ID', first('PAYMENT_BINANCE_ID', 'BINANCE_ID')],
          ['Coin / Network', first('PAYMENT_BINANCE_NETWORK', 'BINANCE_NETWORK')],
        ]
      : [],
  },
  {
    id: 'pay_jazzcash',
    key: 'jazzcash',
    label: 'JazzCash',
    icon: '\uD83D\uDCB3',
    fields: [
      ['Account', first('PAYMENT_JAZZCASH_NUMBER', 'JAZZCASH_NUMBER')],
      ['Title', first('PAYMENT_JAZZCASH_TITLE', 'JAZZCASH_TITLE')],
    ],
  },
  {
    id: 'pay_easypaisa',
    key: 'easypaisa',
    label: 'Easypaisa',
    icon: '\uD83D\uDCB3',
    fields: [
      ['Account', first('PAYMENT_EASYPAISA_NUMBER', 'EASYPAISA_NUMBER')],
      ['Title', first('PAYMENT_EASYPAISA_TITLE', 'EASYPAISA_TITLE')],
    ],
  },
  {
    id: 'pay_bank',
    key: 'bank',
    label: 'Bank Transfer',
    icon: '\uD83D\uDCB3',
    // PAYMENT_BANK_DETAILS is one free-form block (shown verbatim);
    // the granular BANK_* vars remain as a fallback.
    fields: first('PAYMENT_BANK_DETAILS')
      ? [['', first('PAYMENT_BANK_DETAILS')]]
      : [
          ['Bank', first('BANK_NAME')],
          ['Title', first('BANK_TITLE')],
          ['IBAN', first('BANK_IBAN')],
          ['Account', first('BANK_ACCOUNT')],
          ['Branch', first('BANK_BRANCH')],
        ],
  },
].map((m) => ({
  ...m,
  // Drop empty fields so half-configured accounts don't print blanks.
  details: m.fields
    .filter(([, v]) => v && String(v).trim())
    .map(([k, v]) => (k ? `${k}: ${String(v).trim()}` : String(v).trim())),
}));

/** Payment methods that have at least one configured detail line. */
export const PAYMENT_METHODS = PAYMENT_DEFS.filter((m) => m.details.length > 0);

export function getPaymentMethod(id) {
  return PAYMENT_METHODS.find((m) => m.id === id) || null;
}

/** Pretty PKR price, e.g. 2277 -> "PKR 2,277". */
export function formatPrice(amount) {
  return `${BRAND.currency} ${Number(amount).toLocaleString('en-US')}`;
}

export const PATHS = {
  root: ROOT,
  dataDir: DATA_DIR,
  plans: path.join(DATA_DIR, 'plans.json'),
  deliveries: path.join(DATA_DIR, 'deliveries.json'),
  // Order store (lowdb). Overridable so tests and multi-instance
  // setups can point it elsewhere.
  orders: path.resolve(ROOT, process.env.STORE_FILE || path.join(DB_DIR, 'orders.json')),
  // Captured reviews (broadcast + admin-forwarded). Overridable for tests.
  reviews: path.resolve(ROOT, process.env.REVIEWS_FILE || path.join(DB_DIR, 'reviews.json')),
  // Resumable order sessions + human-mode state (customer data).
  sessions: path.resolve(ROOT, process.env.SESSIONS_FILE || path.join(DB_DIR, 'sessions.json')),
  // Per-customer profile: language, loyalty counter, discount codes.
  users: path.resolve(ROOT, process.env.USERS_FILE || path.join(DB_DIR, 'users.json')),
  // Plan alert subscriptions + last stock/price snapshot.
  alerts: path.resolve(ROOT, process.env.ALERTS_FILE || path.join(DB_DIR, 'alerts.json')),
  // ── Admin system ──────────────────────────────────────────
  // Every admin action (who / what / target / when).
  audit: path.resolve(ROOT, process.env.AUDIT_FILE || path.join(DB_DIR, 'audit.json')),
  // Bot settings + blocklist + broadcast opt-outs.
  admin: path.resolve(ROOT, process.env.ADMIN_STATE_FILE || path.join(DB_DIR, 'admin.json')),
  // Parsed payment emails for the NayaPay verifier.
  payments: path.resolve(ROOT, process.env.PAYMENTS_FILE || path.join(DB_DIR, 'payments.json')),
  // Binance Pay transaction cache + claim ledger (auto-verification).
  binanceTx: path.resolve(ROOT, process.env.BINANCE_TX_FILE || path.join(DB_DIR, 'binanceTransactions.json')),
  // AI Payment Decision Engine audit log (Part B).
  aiDecisions: path.resolve(ROOT, process.env.AI_DECISIONS_FILE || path.join(DB_DIR, 'aiDecisions.json')),
  // 🎁 Referral codes + credits (Part C).
  referrals: path.resolve(ROOT, process.env.REFERRALS_FILE || path.join(DB_DIR, 'referrals.json')),
  // Broadcast daily counters.
  broadcast: path.resolve(ROOT, process.env.BROADCAST_FILE || path.join(DB_DIR, 'broadcast.json')),
  // ── Digital Store (ProdSeller) ────────────────────────────
  // Per-product admin overrides: markup / visibility / name / badge.
  digitalOverrides: path.resolve(ROOT, process.env.DIGITAL_OVERRIDES_FILE || path.join(DATA_DIR, 'digitalProductOverrides.json')),
  // Manual ONE Simfly product → ProdSeller ID / Eklas ID mapping.
  // Deliberately hand-maintained (no fuzzy name matching) — see
  // services/productCatalog.js.
  productSupplierMap: path.resolve(ROOT, process.env.PRODUCT_SUPPLIER_MAP_FILE || path.join(DATA_DIR, 'productSupplierMap.json')),
  // Admin-launched sale codes (🎟️ deal codes customers type at checkout).
  sales: path.resolve(ROOT, process.env.SALES_FILE || path.join(DATA_DIR, 'sales.json')),
  // Last supplier price/balance snapshot (daily PRICE_SYNC diff base).
  priceSync: path.resolve(ROOT, process.env.PRICE_SYNC_FILE || path.join(DB_DIR, 'priceSync.json')),
  // In-flight email-activation polls (order -> ProdSeller order id).
  digitalPolls: path.resolve(ROOT, process.env.DIGITAL_POLLS_FILE || path.join(DB_DIR, 'digitalOrderPolls.json')),
  // ── WhatsApp Catalog (auto-post to the WA Business catalogue) ─
  // catalog/products/<retailerId>/product.json + image.jpg = local truth.
  catalogDir: path.resolve(ROOT, process.env.CATALOG_DIR || path.join(ROOT, 'catalog')),
  // catalog/catalog.json = retailerId → WhatsApp product id + sync state.
  catalogIndex: path.resolve(ROOT, process.env.CATALOG_INDEX_FILE || path.join(ROOT, 'catalog', 'catalog.json')),
  // ── Customer wallet ───────────────────────────────────────
  wallets: path.resolve(ROOT, process.env.WALLETS_FILE || path.join(DB_DIR, 'wallets.json')),
  walletTx: path.resolve(ROOT, process.env.WALLET_TX_FILE || path.join(DB_DIR, 'walletTransactions.json')),
  // Locale dictionaries (locales/en.json + locales/ur.json).
  locales: path.join(ROOT, 'locales'),
  // Legacy pre-lowdb state file (seeded into db/orders.json once).
  legacyStore: path.join(DATA_DIR, 'store.json'),
  log: path.join(LOG_DIR, 'bot.log'),
};
