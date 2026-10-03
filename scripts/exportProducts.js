// scripts/exportProducts.js
// Re-fetch the live catalogue from BOTH supplier APIs (ProdSeller +
// Eklas, force = no cache) and rewrite products.txt in the layout:
//     Name | Duration | Description | Rs price
// Prices are the customer-facing PKR ones (rate/markup from the
// admin panel, per-product overrides + pins included), eSIM plans
// come straight from data/plans.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS } from '../config.js';
import { getProducts, isConfigured } from '../services/productCatalog.js';
import { allOverrides, categoryOf, customerProducts, STORE_CATEGORIES, MORE_CATEGORY } from '../lib/digital.js';
import { getSettings } from '../lib/admins.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'products.txt');

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
const rateNow = () => { const n = Number(getSettings()?.usdPkrRate); return n > 0 ? n : undefined; };
const markupNow = () => num(getSettings()?.digitalMarkupPercent);
const rs = (n) => `Rs ${Number(n).toLocaleString('en-US')}`;
const line = '='.repeat(87);

// Supplier descriptions carry newlines + HTML (<blockquote>, <tg-emoji>) —
// flatten to ONE plain-text line so every product stays a single record.
const clean = (s) => String(s || '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/[\r\n\t]+/g, ' ')
  .replace(/\s{2,}/g, ' ')
  .trim();

// Polished shelf name → { name, duration } (first "·" splits, rest is duration).
function splitName(polished) {
  const parts = String(polished || '').split('·').map((s) => s.trim()).filter(Boolean);
  return { name: parts[0] || polished, dur: parts.slice(1).join(' · ') };
}

async function main() {
  if (!isConfigured()) {
    console.error('No supplier API configured (PRODSELLER_API_KEY / EKLAS_* missing) — nothing fetched.');
    process.exit(1);
  }

  const res = await getProducts({ force: true });
  if (!res.ok && !(res.products || []).length) {
    console.error('Catalogue fetch failed:', res.failures);
    process.exit(1);
  }

  const rate = rateNow() ?? SETTINGS.usdPkrRate;
  const markup = markupNow() ?? SETTINGS.digitalMarkupPercent;
  const list = customerProducts(res.products, {
    overrides: allOverrides(),
    balanceUsd: res.balances?.prodseller ?? res.balances?.eklas ?? null,
    markupPercent: markup,
    rate,
  });

  // ── Section 1: eSIM plans ───────────────────────────────────
  const plansDoc = JSON.parse(fs.readFileSync(path.join(root, 'data', 'plans.json'), 'utf8'));
  const esim = (plansDoc.plans || []).map((p) => {
    const desc = [`${p.data} data`, p.validity, plansDoc.network, plansDoc.activation]
      .filter(Boolean).join(' · ');
    return `${p.name} | - | ${desc} | ${rs(p.price)}`;
  });

  // ── Section 2: digital products, grouped by shelf category ─
  const cats = [...STORE_CATEGORIES, MORE_CATEGORY];
  const groups = new Map(cats.map((c) => [c.key, []]));
  for (const p of list) groups.get(categoryOf(p)).push(p);

  const out = [];
  let digitalCount = 0;
  for (const c of cats) {
    const items = groups.get(c.key);
    if (!items.length) continue;
    out.push(`  [${c.emoji} ${c.title}]  ${items.length} product${items.length === 1 ? '' : 's'}`);
    for (const p of items) {
      const { name, dur } = splitName(clean(p.name));
      out.push(`${clean(name)} | ${clean(dur) || '-'} | ${clean(p.description) || '-'} | ${rs(p.pricePkr)}`);
      digitalCount++;
    }
  }

  const generated = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const header = [
    line,
    'SIMFLY STORE - PRODUCT LIST (what the customer pays)',
    'Every product name, its description and the price in PKR shown at checkout.',
    `Generated: ${generated}`,
    `Price basis: eSIM = PKR as listed | digital = supplier USD x ${rate} PKR/USD x (1 + ${markup}% markup)`,
    ...(res.stale ? ['⚠️ Supplier API stale — prices below come from the last good catalogue.'] : []),
    line,
  ];

  const footer = [
    line,
    `TOTAL: ${esim.length} eSIM plan(s) + ${digitalCount} digital product(s)`,
    'All prices are the ones the customer is charged - no USD is ever shown in chat.',
    line,
  ];

  const body = [
    '',
    line,
    ' SECTION 1 - eSIM DATA PLANS (Telenor/Zong 4G)',
    line,
    ...esim,
    '',
    line,
    ' SECTION 2 - DIGITAL STORE (subscriptions, accounts, gift cards)',
    line,
    ...out,
    '',
    ...footer,
  ];

  fs.writeFileSync(OUT, `${[...header, ...body].join('\r\n')}\r\n`, 'utf8');
  console.log(`OK: ${esim.length} eSIM + ${digitalCount} digital products written (${res.products.length} fetched, stale=${Boolean(res.stale)})`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
