// ─────────────────────────────────────────────────────────────
// plans.js
// Reads data/plans.json (the real Simfly Store eSIM catalogue) and
// shapes it for list rows, button detail cards and plain text.
// The file is re-read on every call so the admin can edit it
// live without restarting the bot.
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs';
import { PATHS, formatPrice, BRAND } from '../config.js';
import { t } from './lang.js';

const SECTION_ORDER = ['short', 'daily', 'monthly'];
const SECTION_TITLES = {
  short: '⏱️ Short Validity (7 \u2013 15 Days)',
  daily: '🔁 Daily Data Packs',
  monthly: '📅 30-Day Packs',
};

/** Optional per-section titles from data/plans.json → "sections": {…}. */
function sectionTitles() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PATHS.plans, 'utf8'));
    return { ...SECTION_TITLES, ...(parsed.sections || {}) };
  } catch {
    return SECTION_TITLES;
  }
}

function readCatalogue() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PATHS.plans, 'utf8'));
    if (!Array.isArray(parsed.plans)) throw new Error('missing "plans" array');
    return parsed;
  } catch (err) {
    console.error(`[plans] Failed to read ${PATHS.plans}: ${err.message}`);
    return { plans: [] };
  }
}

export function allPlans() {
  return readCatalogue().plans;
}

export function getPlan(id) {
  if (!id) return null;
  return allPlans().find((p) => p.id === id) || null;
}

/** Row title — plan name only (spec: name + price on the row). */
export function planTitle(plan) {
  const badge = plan.badge ? `${plan.badge} ` : '';
  return `${badge}${plan.name}`;
}

/** Row description — price, plus the highlight badge when asked for. */
export function planSummary(plan, { withBadge = false } = {}) {
  const parts = [formatPrice(plan.price)];
  if (withBadge && plan.badge) parts.push('⭐ Best Value');
  return parts.filter(Boolean).join(' • ');
}

/**
 * Group the catalogue into list sections (max 5 rows per section).
 * @param stock  optional { [planId]: { ok } } from checkAllStock() —
 *               sold-out plans stay visible with a ❌ marker.
 * @param lang   locale for the "Temporarily unavailable" label.
 */
export function planSections(stock = null, lang = 'ur') {
  const plans = allPlans();
  const grouped = new Map();

  for (const plan of plans) {
    // Hidden plans stay in the file (existing flows keep working)
    // but never appear in the customer browse list.
    if (plan.visible === false) continue;
    const key = SECTION_ORDER.includes(plan.section) ? plan.section : 'short';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(plan);
  }

  return SECTION_ORDER.filter((key) => grouped.has(key)).map((key) => ({
    title: sectionTitles()[key] || SECTION_TITLES[key],
    rows: grouped.get(key).map((plan) => {
      const s = stock ? stock[plan.id] : null;
      const soldOut = Boolean(s && s.ok === false);
      return {
        id: `plan:${plan.id}`,
        title: soldOut ? `❌ ${planTitle(plan)}` : planTitle(plan),
        description: soldOut ? t('stock_unavailable', {}, lang) : planSummary(plan, { withBadge: true }),
      };
    }),
  }));
}

/** Full detail card used by the plan BUTTON message. */
export function planDetailText(plan, lang = 'ur') {
  return [
    `*${plan.name}*`,
    '',
    t('plan_detail_data', { v: plan.data }, lang),
    t('plan_detail_validity', { v: plan.validity }, lang),
    t('plan_detail_price', { v: formatPrice(plan.price) }, lang),
    t('plan_detail_net', { v: BRAND.network }, lang),
    t('plan_detail_act', { v: BRAND.activation }, lang),
    plan.badge ? t('plan_detail_badge', {}, lang) : '',
    '',
    t('plan_detail_foot', {}, lang),
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** Plain-text render of a single plan (used in order summaries). */
export function planOneLiner(plan) {
  return `${plan.name} (${plan.data} \u2022 ${plan.validity}) \u2014 ${formatPrice(plan.price)}`;
}
