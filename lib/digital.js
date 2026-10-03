// ─────────────────────────────────────────────────────────────
// lib/digital.js
// The Digital Store's pricing + presentation layer.
//
//   ProdSeller sells in USDT; Simfly sells in PKR. Every customer
//   facing price is computed here and NOWHERE else:
//
//       pricePkr = price_usd × USD_PKR_RATE × (1 + markup%)
//                  └ rounded to a clean PKR number ┘
//
//   • markup% defaults to DIGITAL_MARKUP_PERCENT (global) and can
//     be overridden PER PRODUCT in data/digitalProductOverrides.json
//     ({ productId: { markupPercent, costUsd, visible, badge, customName } })
//   • the USD input itself can be overridden per product
//     (`costUsd`) — otherwise the supplier's own `price` drives the
//     maths. Either way NOTHING here is hardcoded: the rate comes
//     from USD_PKR_RATE and the ROI from DIGITAL_MARKUP_PERCENT
//     (.env) or the admin panel's live settings.
//   • `publicPrice` is NEVER used and NEVER shown
//   • the raw USD price is never returned to a customer-facing view
//     (only admin views carry `costUsd`, when `ctx.forAdmin`)
//
// Pure helpers (roundPkr / computePkrPrice / mergeProduct) take
// their inputs as arguments so unit tests need no DB or network.
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs';
import { PATHS, SETTINGS, PAYMENT_METHODS, formatPrice } from '../config.js';

// ── Rounding ──────────────────────────────────────────────────
/**
 * Clean PKR figure: nearest 5 under 1k, nearest 10 under 10k,
 * nearest 50 above (keeps chat prices tidy without squeezing margin).
 */
export function roundPkr(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return 0;
  const abs = Math.abs(v);
  const step = abs < 1000 ? 5 : abs < 10000 ? 10 : 50;
  return Math.round(v / step) * step;
}

/**
 * Customer-facing PKR price for one ProdSeller product.
 * @param {number} priceUsd  the product's `price` field (NOT publicPrice)
 * @param {{rate?:number, markupPercent?:number}} opts
 */
export function computePkrPrice(priceUsd, opts = {}) {
  const rate = Number(opts.rate ?? SETTINGS.usdPkrRate);
  const markup = Number(opts.markupPercent ?? SETTINGS.digitalMarkupPercent);
  const usd = Number(priceUsd);
  if (!Number.isFinite(usd) || usd < 0) return 0;
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  const pct = Number.isFinite(markup) ? markup : 0;
  return roundPkr(usd * rate * (1 + pct / 100));
}

// ── Per-product overrides (data/digitalProductOverrides.json) ─
function readOverrideFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PATHS.digitalOverrides, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return {};
    // Tolerate both the flat map (documented) and a { products } wrapper.
    return parsed.products && typeof parsed.products === 'object' ? parsed.products : parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[digital] Could not read ${PATHS.digitalOverrides}: ${err.message}`);
    }
    return {};
  }
}

let overrideWriteTimer = null;
function writeOverrideFile(doc) {
  try {
    fs.mkdirSync(PATHS.digitalOverrides.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
    fs.writeFileSync(PATHS.digitalOverrides, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  } catch (err) {
    console.error(`[digital] Failed to persist overrides: ${err.message}`);
  }
}
/** Debounced save (admin edits come in one at a time). */
function saveOverridesSoon(doc) {
  if (overrideWriteTimer) clearTimeout(overrideWriteTimer);
  overrideWriteTimer = setTimeout(() => {
    overrideWriteTimer = null;
    writeOverrideFile(doc);
  }, 150);
}
/** Flush pending override writes immediately (tests / shutdown). */
export function flushOverrides() {
  if (overrideWriteTimer) {
    clearTimeout(overrideWriteTimer);
    overrideWriteTimer = null;
    writeOverrideFile(readOverrideFile());
  }
}

export function allOverrides() {
  return readOverrideFile();
}

export function getOverride(productId) {
  return readOverrideFile()[String(productId)] || null;
}

/** Merge a patch into one product's override ({…} or null to reset). */
export function upsertOverride(productId, patch = {}) {
  const doc = readOverrideFile();
  const id = String(productId);
  const prev = doc[id] || {};
  const next = { ...prev };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  if (Object.keys(next).length === 0) delete doc[id];
  else doc[id] = next;
  writeOverrideFile(doc);
  return doc[id] || null;
}

// ── Merge live ProdSeller data with the local override ────────
/**
 * One product, seen through the customer's eyes.
 * Returns a NEW object — the raw payload is never mutated and no
 * USD figure ever travels with it.
 *
 * @param {object} raw          normalized product from services/prodseller
 * @param {{override?:object, balanceUsd?:number|null, rate?:number,
 *          markupPercent?:number}} ctx
 */
export function mergeProduct(raw, ctx = {}) {
  if (!raw || !raw.id) return null;
  const override = ctx.override || null;
  const markupPercent = Number.isFinite(Number(override?.markupPercent))
    ? Number(override.markupPercent)
    : Number(ctx.markupPercent ?? SETTINGS.digitalMarkupPercent);

  // USD input: admin-set price wins, otherwise the supplier's price.
  const overriddenUsd = Number(override?.costUsd);
  const costUsd = override?.costUsd !== undefined && override?.costUsd !== null
    && override.costUsd !== '' && Number.isFinite(overriddenUsd) && overriddenUsd >= 0
    ? overriddenUsd
    : Number(raw.price);

  // PKR price = USD × rate (.env / admin) × (1 + ROI% (.env / admin)).
  let pricePkr = computePkrPrice(costUsd, { rate: ctx.rate, markupPercent });

  // 📌 Admin-pinned price: HOLDS while the ROI it yields stays at or
  // above PINNED_MARKUP_FLOOR% (default 50). The moment supplier
  // costs push that margin under the floor, the pin releases and the
  // formula above takes over again — the shop can never sell below
  // its floor because of a stale pin.
  const rateUsed = Number.isFinite(Number(ctx.rate)) && Number(ctx.rate) > 0
    ? Number(ctx.rate)
    : Number(SETTINGS.usdPkrRate);
  const pinnedRaw = Number(override?.pinnedPricePkr);
  let pinnedActive = false;
  let pinnedRoi = null;
  if (override?.pinnedPricePkr !== undefined && override?.pinnedPricePkr !== null
      && Number.isFinite(pinnedRaw) && pinnedRaw > 0) {
    const costPkr = Number(costUsd) * rateUsed;
    pinnedRoi = costPkr > 0 ? ((pinnedRaw - costPkr) / costPkr) * 100 : null;
    if (pinnedRoi === null || pinnedRoi >= Number(SETTINGS.pinnedMarkupFloor)) {
      pricePkr = Math.round(pinnedRaw);
      pinnedActive = true;
    }
  }

  const inStock = raw.inStock !== false && !(Number.isFinite(raw.stock) && raw.stock <= 0);
  // Which supplier's wallet has to cover this product: the raw view
  // carries it (dual-supplier shelf), otherwise the caller's single
  // balance (legacy single-supplier callers / tests).
  const balanceUsd = raw.balanceUsd ?? ctx.balanceUsd;
  const unaffordable = Number.isFinite(Number(balanceUsd)) && Number(raw.price) > Number(balanceUsd);

  return {
    id: raw.id,
    name: (override?.customName && String(override.customName).trim()) || prettifyDigitalName(raw.name),
    description: raw.description || '',
    badge: override?.badge || null,
    pricePkr,
    // Admin-only (never part of a shopper's JSON):
    //   costUsd    — the USD figure this price was built from
    //   override   — raw override entry (holds costUsd/markup etc.)
    //   pinned*    — the 📌 pin state (price, held?, current ROI)
    ...(ctx.forAdmin
      ? {
          costUsd,
          override,
          // The supplier's own name, unchanged — the shelf shows the
          // polished one, the admin still needs to recognise the SKU.
          rawName: raw.name,
          pinnedPricePkr: override?.pinnedPricePkr ?? null,
          pinnedActive,
          pinnedRoi,
          pinnedFloor: Number(SETTINGS.pinnedMarkupFloor),
        }
      : {}),
    inStock,
    // Exact units left when the supplier reports it (null = unknown).
    stock: Number.isFinite(Number(raw.stock)) && raw.stock !== null && raw.stock !== undefined
      ? Number(raw.stock)
      : null,
    requiresEmailActivation: Boolean(raw.requiresEmailActivation),
    deliveryType: raw.delivery?.type || 'instant',
    sold: raw.sold ?? null,
    imageUrl: raw.imageUrl || null,
    // Admin-only flags (never rendered to a shopper).
    hidden: override?.visible === false,
    unaffordable,
    markupPercent,
  };
}

/**
 * Customer-facing list: hidden products dropped.
 * A low supplier balance (`unaffordable`) does NOT hide the item —
 * the shopper sees it flagged ⏳ Restock and can still order; the
 * order then waits for the admin top-up (402 → awaiting_supplier_funding).
 */
export function customerProducts(rawList = [], ctx = {}) {
  return (rawList || [])
    .map((raw) => mergeProduct(raw, { ...ctx, override: ctx.overrides?.[String(raw.id)] || null }))
    .filter(Boolean)
    .filter((p) => !p.hidden);
}

/** Admin list: everything, with the flags (and `costUsd`) visible. */
export function adminProducts(rawList = [], ctx = {}) {
  return (rawList || [])
    .map((raw) => mergeProduct(raw, { ...ctx, forAdmin: true, override: ctx.overrides?.[String(raw.id)] || null }))
    .filter(Boolean);
}

/** Case-insensitive name/description search. */
export function searchProducts(list = [], query = '') {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return list;
  return list.filter((p) =>
    `${p.name} ${p.description || ''}`.toLowerCase().includes(q)
  );
}

// ── Name polish (supplier name → shelf name) ─────────────────
// Supplier names are written by whoever listed the product:
// `CAPCUT PRO 6 MONTHS`, `n8n Pro 1m (Account)`, `Lovable Pro
// 10000 Credits - (NW)`. The shelf shows one clean format:
//
//      <Brand> · <Duration> · <Credits / Seats>
//      CapCut Pro · 6 Months      ·  Lovable Pro · 10000 Credits
//
// Rule-based and deterministic — no network, no heuristics that can
// rename two products differently on two runs. Admin `customName`
// overrides still win.
const WORD_FIX = new Map(Object.entries({
  capcut: 'CapCut', youtube: 'YouTube', chatgpt: 'ChatGPT', nordvpn: 'NordVPN',
  ilovepdf: 'iLovePDF', n8n: 'n8n', 'bolt.new': 'Bolt.new', 'brain.fm': 'Brain.fm',
  posthog: 'PostHog', supergrok: 'SuperGrok', edx: 'edX', chatprd: 'ChatPRD',
  jetbrains: 'JetBrains', elevenlabs: 'ElevenLabs', gmail: 'Gmail',
  gemini: 'Gemini', google: 'Google', adobe: 'Adobe', figma: 'Figma',
  canva: 'Canva', notion: 'Notion', miro: 'Miro', avira: 'Avira',
  duolingo: 'Duolingo', coursera: 'Coursera', autodesk: 'Autodesk',
  headspace: 'Headspace', supabase: 'Supabase', replit: 'Replit',
  railway: 'Railway', intercom: 'Intercom', airtable: 'Airtable',
  framer: 'Framer', mobbin: 'Mobbin', granola: 'Granola', pangram: 'Pangram',
  supercut: 'Supercut', descript: 'Descript', higgsfield: 'Higgsfield',
  gumloop: 'Gumloop', arize: 'Arize', lovable: 'Lovable', surfshark: 'Surfshark',
  ai: 'AI', vpn: 'VPN', pdf: 'PDF', edu: 'Edu', k12: 'K12', hbo: 'HBO',
  id: 'ID', usd: 'USD', esim: 'eSIM',
}));

// Applied first, case-insensitively, on the whole remaining name.
const PHRASE_FIX = [
  ['microsoft office 365', 'Microsoft 365'],
  ['youtube premium', 'YouTube Premium'],
  ['hbo max', 'HBO Max'],
  ['prime video', 'Prime Video'],
  ['google ai', 'Google AI'],
  ['gmails accounts', 'Gmail Accounts'],
  ['outlook.com email', 'Outlook Email'],
];

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function titleCase(word) {
  if (!word) return word;
  return word[0].toUpperCase() + word.slice(1).toLowerCase();
}

function fixWord(word) {
  const bare = word.replace(/^[^\w.]+|[^\w.]+$/g, '');
  const fixed = WORD_FIX.get(bare.toLowerCase());
  if (fixed === undefined) return titleCase(word);
  // keep any punctuation the token carried (e.g. "Bolt.new," )
  return word.replace(bare, fixed);
}

/** Pull the first duration out of a name, returning its label. */
function extractDuration(s) {
  const re = /(\d{1,4})(?:\s*[-–]\s*(\d{1,4}))?\s*(months?|month|mons?|mths?|weeks?|week|wks?|days?|day|years?|year|yrs?|yr|hours?|hour|hrs?|hr|mth|y|m|w|d)(?![a-z0-9])/i;
  const m = s.match(re);
  if (!m) return { s, label: null };
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : null;
  const u = (m[3] || '').toLowerCase();
  const unit = u.startsWith('m') ? 'Month'
    : u.startsWith('w') ? 'Week'
    : u.startsWith('d') ? 'Day'
    : u.startsWith('h') ? 'Hour'
    : 'Year';
  const plural = (n, word) => `${n} ${n === 1 ? word : `${word}s`}`;
  const label = b ? `${a}–${b} ${unit}s` : plural(a, unit);
  return { s: s.replace(re, ' '), label };
}

function extractMatch(s, re, format) {
  const m = s.match(re);
  if (!m) return { s, label: null };
  return { s: s.replace(re, ' '), label: format(m) };
}

/**
 * The clean shelf name for one supplier product.
 * @param {string} raw supplier's own name
 * @returns {string} e.g. `CapCut Pro · 6 Months`
 */
export function prettifyDigitalName(raw) {
  const original = String(raw || '').trim();
  if (!original) return '';

  let core = original
    .replace(/\((fw|nw|w6d|link|account|new)\)/gi, ' ')   // listing noise
    .replace(/\s*\b(fw|nw)\b(?=\s|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const dur = extractDuration(core);
  core = dur.s;
  const credits = extractMatch(core, /(\d[\d,]*)\s*credits?/i, (m) => `${m[1].replace(/,/g, '')} Credits`);
  core = credits.s;
  const seats = extractMatch(
    core,
    /(\d+)\s*(?:x\s*)?(?:seats?|invites?|invitations?|users?)|(\d+)\s*x\s*seat/i,
    (m) => `${Number(m[1] || m[2])} Seats`,
  );
  core = seats.s;

  core = core
    .replace(/\bpanel\b/gi, ' ')                        // "Lifetime Panel 100 invite"
    .replace(/\(\s*\)/g, ' ')                           // emptied by a credit/seat lift
    .replace(/\s*[-–—:,·]+\s*$/, ' ')
    .replace(/\s*[-–—:,·]+\s*(?=\S)/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  for (const [from, to] of PHRASE_FIX) {
    core = core.replace(new RegExp(`\\b${escapeRe(from)}\\b`, 'i'), to);
  }
  core = core.split(' ').map(fixWord).join(' ').replace(/\s{2,}/g, ' ').trim();

  const parts = [core, dur.label, credits.label, seats.label].filter(Boolean);
  const joined = parts.join(' · ').replace(/\s+·\s*·/g, ' ·').trim();
  const out = joined.replace(/^[·\s]+|[·\s]+$/g, '');
  return out || original;
}

// ── Categories (the browse screen) ────────────────────────────
/**
 * Fixed category list — order here IS the order on screen. A product
 * matches the FIRST category whose keywords hit its (polished) name,
 * so a keyword that belongs to two shelves must be listed in the one
 * it should land in.
 */
export const STORE_CATEGORIES = [
  {
    key: 'ai', emoji: '🤖', title: 'AI Chat & Assistants',
    blurb: 'ChatGPT, Gemini, copilots, voice',
    any: ['gemini', 'chatgpt', 'grok', 'manus', 'gamma', 'chatprd', 'google ai', 'leonardo', 'elevenlabs'],
  },
  {
    key: 'build', emoji: '🚀', title: 'Code & Automation',
    blurb: 'app builders, agents, dev tools',
    any: ['lovable', 'bolt', 'replit', 'n8n', 'gumloop', 'factory', 'warp', 'granola', 'magic patterns', 'pangram', 'supercut', 'posthog', 'supabase', 'railway', 'jetbrains', 'arize'],
  },
  {
    key: 'design', emoji: '🎨', title: 'Design & Creative',
    blurb: 'Canva, Figma, Adobe, Framer',
    any: ['canva', 'adobe', 'figma', 'framer', 'mobbin', 'autodesk', 'ilovepdf'],
  },
  {
    key: 'video', emoji: '✂️', title: 'Video & Editing',
    blurb: 'CapCut, Descript, AI video',
    any: ['capcut', 'descript', 'higgsfield'],
  },
  {
    key: 'stream', emoji: '📺', title: 'Streaming & Music',
    blurb: 'YouTube, Prime Video, HBO Max',
    any: ['youtube', 'prime video', 'hbo', 'brain.fm'],
  },
  {
    key: 'vpn', emoji: '🔐', title: 'VPN & Security',
    blurb: 'NordVPN, Surfshark, Avira',
    any: ['nordvpn', 'surfshark', 'avira'],
  },
  {
    key: 'work', emoji: '💼', title: 'Productivity',
    blurb: 'Notion, Miro, Office, teams',
    any: ['notion', 'miro', 'airtable', 'linear', 'intercom', 'microsoft 365', 'office 365'],
  },
  {
    key: 'email', emoji: '📧', title: 'Email Accounts',
    blurb: 'Gmail, Outlook',
    any: ['gmail', 'outlook'],
  },
  {
    key: 'learn', emoji: '🎓', title: 'Learning & Lifestyle',
    blurb: 'courses, languages, wellness',
    any: ['duolingo', 'coursera', 'edx', 'headspace'],
  },
];

/** Anything no keyword claims — shown last so nothing ever disappears. */
export const MORE_CATEGORY = {
  key: 'more', emoji: '✨', title: 'More Picks', blurb: 'everything else',
  any: [],
};

export function categoryOf(product) {
  const name = String(product?.name || '').toLowerCase();
  for (const cat of STORE_CATEGORIES) {
    if (cat.any.some((kw) => name.includes(kw))) return cat.key;
  }
  return MORE_CATEGORY.key;
}

/** Live categories for one shelf: only the ones that actually hold items. */
export function digitalCategories(list = []) {
  const buckets = new Map();
  for (const p of list || []) {
    const key = categoryOf(p);
    if (!buckets.has(key)) buckets.set(key, { key, count: 0, minPkr: Infinity });
    const b = buckets.get(key);
    b.count += 1;
    const price = Number(p.pricePkr);
    if (Number.isFinite(price) && price > 0) b.minPkr = Math.min(b.minPkr, price);
  }
  const all = [...STORE_CATEGORIES, MORE_CATEGORY];
  return all
    .filter((c) => buckets.has(c.key))
    .map((c) => {
      const b = buckets.get(c.key);
      return { ...c, count: b.count, minPkr: Number.isFinite(b.minPkr) ? b.minPkr : null };
    });
}

// ── Presentation ──────────────────────────────────────────────
/** WhatsApp LIST hard limits: ≤10 sections, ≤10 rows per section. */
export const MAX_LIST_ROWS = 10;
export const MAX_LIST_SECTIONS = 10;

/** In stock first, then cheapest → the eye lands on a buyable price. */
const byShelf = (a, b) =>
  Number(b.inStock) - Number(a.inStock) || a.pricePkr - b.pricePkr;

/**
 * The store browse LIST — ONE message, category TITLES as separators:
 * one section per category, that category's products as the rows.
 * Nothing is hidden behind a second menu. A category holding more than
 * MAX_LIST_ROWS items keeps its first rows and ends with a "➕ N more"
 * row (id `dcat:<key>`) that opens its full list — that is what keeps
 * both the section count and the row count inside WhatsApp's limits.
 */
export function digitalCategorySections(list = []) {
  const out = [];
  for (const c of digitalCategories(list)) {
    const items = (list || []).filter((p) => categoryOf(p) === c.key).sort(byShelf);
    const over = items.length > MAX_LIST_ROWS;
    const shown = over ? items.slice(0, MAX_LIST_ROWS - 1) : items;
    const rows = shown.map((p) => ({
      id: `dp:${p.id}`,
      title: `${p.badge ? `${p.badge} ` : ''}${p.name}`.slice(0, 64),
      description: rowDescription(p, p.requiresEmailActivation ? 'activation' : 'instant').slice(0, 72),
    }));
    if (over) {
      rows.push({
        id: `dcat:${c.key}`,
        title: `➕ ${items.length - shown.length} more in ${c.title}`.slice(0, 64),
        description: `${c.emoji} Full list · ${items.length} items`.slice(0, 72),
      });
    }
    // Section titles stay ≤ 24 chars (WhatsApp's own limit).
    out.push({ title: `${c.emoji} ${c.title}`.slice(0, 24), rows });
  }
  return out;
}

const SECTION_ORDER = ['instant', 'activation'];
const SECTION_BASE = { instant: '⚡ Instant', activation: '📧 Email Activation' };

/** WhatsApp LIST: max 10 rows per section — chunk, never overflow. */
function chunkRows(rows, size = 10) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** One line of a LIST row: price first, delivery cue second (≤72 chars). */
function rowDescription(p, key) {
  const price = formatPrice(p.pricePkr);
  if (!p.inStock) return `❌ ${price} • Out of stock`;
  // Low supplier balance ≠ hidden shop: the item stays listed, just
  // flagged — ordering still works (the order waits for the top-up).
  if (p.unaffordable) return `${price} • ⏳ Restock${key === 'activation' ? ' · 2–6 hrs' : ''}`;
  return `${price} • ${key === 'activation' ? '📧 2–6 hrs' : '⚡ Instant'}`;
}

/**
 * Group the catalogue for the browse LIST.
 *  • instant delivery first, email-activation after it
 *  • cheapest in-stock products first (fast scanning),
 *    anything out of stock pushed to the bottom
 *  • section titles carry the live count so the shopper knows
 *    how much is behind the tap before opening it
 */
export function digitalSections(list = [], lang = 'ur') {
  const grouped = new Map();
  for (const p of list) {
    const key = p.requiresEmailActivation ? 'activation' : 'instant';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(p);
  }
  // In stock first, then cheapest → the eye lands on a buyable price.
  const byPrice = (a, b) =>
    Number(b.inStock) - Number(a.inStock) || a.pricePkr - b.pricePkr;

  const out = [];
  for (const key of SECTION_ORDER.filter((k) => grouped.has(k))) {
    const rows = grouped.get(key).slice().sort(byPrice);
    const chunks = chunkRows(rows, 10);
    chunks.forEach((chunk, i) => {
      out.push({
        // Section titles stay ≤ 24 chars (WhatsApp's own limit).
        title: chunks.length > 1
          ? `${SECTION_BASE[key]} ${i + 1}/${chunks.length}`
          : `${SECTION_BASE[key]} (${rows.length})`,
        rows: chunk.map((p) => ({
          id: `dp:${p.id}`,
          title: `${p.badge ? `${p.badge} ` : ''}${p.name}`.slice(0, 64),
          description: rowDescription(p, key).slice(0, 72),
        })),
      });
    });
  }
  return out;
}

/** Payment chips actually configured right now (never invents one). */
const PAY_ICONS = { sadapay: '💳', binance: '🪙', jazzcash: '📱', easypaisa: '📱', bank: '🏦' };
function paymentChips() {
  const chips = (PAYMENT_METHODS || [])
    .filter((m) => (m.details || []).length > 0)
    .map((m) => `${PAY_ICONS[m.key] || '💳'} ${m.label}`);
  return chips.join(' • ');
}

/**
 * Detail card body (buttons + footer come from lib/ui).
 * Layout: headline → what it is → the three facts a shopper
 * decides on (price / delivery / stock) → how to pay → reassurance.
 */
export function digitalDetailText(product, lang = 'ur') {
  if (!product) return '';
  const delivery = product.requiresEmailActivation
    ? `📧 Email activation — ${SETTINGS.activationEtaLabel}`
    : '⚡ Instant — key yahin chat me mil jayega';
  const stock = !product.inStock
    ? '❌ Out of stock'
    : product.stock != null
      ? `✅ In stock — ${product.stock} left`
      : '✅ In stock';
  const pay = paymentChips();

  return [
    `*${product.name}*`,
    product.description ? `\n${product.description}` : '',
    '',
    `💰 Price: *${formatPrice(product.pricePkr)}*`,
    `📦 Delivery: ${delivery}`,
    `🏷️ Stock: ${stock}`,
    product.unaffordable
      ? '⏳ Restock jaari — order queue me hai, top-up hote hi deliver hoga.'
      : '',
    product.badge ? `⭐ ${product.badge}` : '',
    '',
    pay ? `💳 Pay via: ${pay} — ya apna 💰 Wallet balance.` : '',
    '🔒 Secure checkout • Order ke baad bhi support available.',
  ]
    .filter((line) => line !== false && line !== null && line !== undefined)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

/** Short one-liner for order cards / receipts. */
export function digitalOneLiner(product) {
  if (!product) return '';
  return `${product.name} — ${formatPrice(product.pricePkr)}`;
}
