// Unit tests for the Digital Store (ProdSeller) layer:
//   pricing/overrides → services/prodseller.js → handlers helpers
//   → the activation poll job.
//
// Run with:  node --test test/digital.test.js
//
// Env overrides MUST run before any project module loads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.STORE_FILE = 'test/.tmp-digital-store.json';
process.env.SESSIONS_FILE = 'test/.tmp-digital-sessions.json';
process.env.USERS_FILE = 'test/.tmp-digital-users.json';
process.env.ADMIN_STATE_FILE = 'test/.tmp-digital-admin.json';
process.env.AUDIT_FILE = 'test/.tmp-digital-audit.json';
process.env.WALLETS_FILE = 'test/.tmp-digital-wallets.json';
process.env.WALLET_TX_FILE = 'test/.tmp-digital-wallet-tx.json';
process.env.DIGITAL_OVERRIDES_FILE = 'test/.tmp-digital-overrides.json';
process.env.DIGITAL_POLLS_FILE = 'test/.tmp-digital-polls.json';
process.env.PAYMENTS_FILE = 'test/.tmp-digital-payments.json';
process.env.BINANCE_TX_FILE = 'test/.tmp-digital-binance.json';
process.env.USD_PKR_RATE = '278';
process.env.DIGITAL_MARKUP_PERCENT = '50';
process.env.PRODSELLER_API_KEY = 'test-key-do-not-log';
process.env.PRODSELLER_BASE_URL = 'https://prodseller.test/v1';
process.env.ADMIN_WHATSAPP_NUMBER = '030011122233';
delete process.env.ESIMACCESS_API_KEY;
delete process.env.ESIMACCESS_API_SECRET;
delete process.env.DASHBOARD_PORT;

try {
  for (const f of [
    '.tmp-digital-store.json', '.tmp-digital-sessions.json', '.tmp-digital-users.json',
    '.tmp-digital-admin.json', '.tmp-digital-audit.json', '.tmp-digital-wallets.json',
    '.tmp-digital-wallet-tx.json', '.tmp-digital-overrides.json', '.tmp-digital-polls.json',
    '.tmp-digital-payments.json', '.tmp-digital-binance.json',
  ]) {
    fs.rmSync(new URL(`./${f}`, import.meta.url), { force: true });
  }
} catch { /* ignore */ }

const digital = await import('../lib/digital.js');
const ps = await import('../services/prodseller.js');
const steps = await import('../lib/steps.js');
const ds = await import('../handlers/digitalStore.js');
const polls = await import('../services/digitalPolls.js');
const store = await import('../lib/store.js');
const { SETTINGS } = await import('../config.js');

const RAW_PRODUCT = {
  id: 'prod-1',
  name: 'Netflix 1 Month',
  description: 'Premium gift card',
  price: 1.5,            // what OUR key is charged (USD)
  publicPrice: 9.99,     // must never reach a customer
  stock: 4,
  inStock: true,
  requiresEmailActivation: false,
  delivery: { type: 'instant' },
};

// ── Pricing ──────────────────────────────────────────────────
test('default markup: 50% over the USD price × rate', () => {
  // 1.00 USD × 278 × 1.50 = 417 → rounded to 415 (clean 5s under 1k)
  assert.equal(digital.computePkrPrice(1), 415);
  assert.equal(SETTINGS.digitalMarkupPercent, 50);
  assert.equal(SETTINGS.usdPkrRate, 278);
});

test('roundPkr keeps chat prices tidy', () => {
  assert.equal(digital.roundPkr(417), 415);
  assert.equal(digital.roundPkr(9_994), 9_990);
  assert.equal(digital.roundPkr(42_340), 42_350);
  assert.equal(digital.roundPkr(NaN), 0);
});

test('mergeProduct NEVER exposes the USD price', () => {
  const view = digital.mergeProduct(RAW_PRODUCT, { balanceUsd: 100 });
  assert.equal(view.pricePkr, digital.computePkrPrice(1.5));
  assert.equal(view.price, undefined);
  assert.equal(view.publicPrice, undefined);
  assert.ok(!JSON.stringify(view).includes('publicPrice'));
  assert.ok(!JSON.stringify(view).includes('"price"'));
});

// ── Per-product overrides ────────────────────────────────────
test('override markup changes ONLY that product', () => {
  digital.upsertOverride('prod-1', { markupPercent: 100 });
  const hot = digital.mergeProduct(RAW_PRODUCT, { override: digital.getOverride('prod-1') });
  const other = digital.mergeProduct({ ...RAW_PRODUCT, id: 'prod-2' }, { override: null });
  assert.equal(hot.markupPercent, 100);
  assert.equal(other.markupPercent, 50);
  assert.ok(hot.pricePkr > other.pricePkr);
  digital.upsertOverride('prod-1', { markupPercent: null });
});

test('visible:false hides a product from shoppers only', () => {
  digital.upsertOverride('prod-1', { visible: false });
  const adminList = digital.adminProducts([RAW_PRODUCT], { overrides: digital.allOverrides() });
  const customerList = digital.customerProducts([RAW_PRODUCT], { overrides: digital.allOverrides() });
  assert.equal(adminList.length, 1);
  assert.equal(customerList.length, 0);
  assert.equal(adminList[0].hidden, true);
  digital.upsertOverride('prod-1', { visible: null });
  digital.flushOverrides();
});

test('low supplier balance keeps the item VISIBLE, flagged as restock', () => {
  const list = digital.customerProducts([RAW_PRODUCT], { balanceUsd: 0.1 });
  assert.equal(list.length, 1); // never an "empty shop" because of our balance
  assert.equal(list[0].unaffordable, true);
  const section = digital.digitalSections(list, 'en')[0];
  assert.ok(section.rows[0].description.includes('⏳ Restock'));
  assert.ok(digital.digitalDetailText(list[0], 'en').includes('Restock jaari'));

  const funded = digital.customerProducts([RAW_PRODUCT], { balanceUsd: 100 });
  assert.equal(funded[0].unaffordable, false);
  assert.ok(!digital.digitalSections(funded, 'en')[0].rows[0].description.includes('Restock'));
  assert.ok(!digital.digitalDetailText(funded[0], 'en').includes('Restock jaari'));
});

// ── Pricing inputs: .env defaults, admin overrides ───────────
test('price = USD × rate × ROI — every input is .env/admin driven', () => {
  // 1. Defaults straight from .env (rate 278, ROI 50%).
  assert.equal(digital.mergeProduct(RAW_PRODUCT, {}).pricePkr, digital.computePkrPrice(1.5));

  // 2. Admin raises the PKR-per-USD rate (panel setting).
  const rateChanged = digital.mergeProduct(RAW_PRODUCT, { rate: 400 });
  assert.equal(rateChanged.pricePkr, digital.computePkrPrice(1.5, { rate: 400 }));
  assert.notEqual(rateChanged.pricePkr, digital.mergeProduct(RAW_PRODUCT, {}).pricePkr);

  // 3. ROI: per-product override beats the global one.
  const hotter = digital.mergeProduct(RAW_PRODUCT, { override: { markupPercent: 200 } });
  assert.equal(hotter.pricePkr, digital.computePkrPrice(1.5, { markupPercent: 200 }));
  assert.equal(digital.mergeProduct(RAW_PRODUCT, { markupPercent: 10 }).pricePkr,
    digital.computePkrPrice(1.5, { markupPercent: 10 }));
});

test('admin can set a per-product USD price — shoppers never see USD', () => {
  const overrides = { 'prod-1': { costUsd: 2.5 } };
  const admin = digital.adminProducts([RAW_PRODUCT], { overrides });
  assert.equal(admin[0].costUsd, 2.5);
  assert.equal(admin[0].pricePkr, digital.computePkrPrice(2.5));

  const shop = digital.customerProducts([RAW_PRODUCT], { overrides });
  assert.equal(shop[0].pricePkr, digital.computePkrPrice(2.5));
  assert.equal(shop[0].costUsd, undefined);
  assert.ok(!JSON.stringify(shop).includes('costUsd'));

  // `reset` (costUsd: null) falls back to the supplier price.
  const reset = digital.adminProducts([RAW_PRODUCT], { overrides: { 'prod-1': { costUsd: null } } });
  assert.equal(reset[0].costUsd, 1.5);
  assert.equal(reset[0].pricePkr, digital.computePkrPrice(1.5));
});

test('costUsd override round-trips through the override file', () => {
  digital.upsertOverride('prod-1', { costUsd: 3.25 });
  assert.equal(digital.getOverride('prod-1').costUsd, 3.25);
  digital.upsertOverride('prod-1', { costUsd: null }); // admin typed `reset`
  assert.equal(digital.getOverride('prod-1')?.costUsd, undefined);
  digital.flushOverrides();
});

// ── Price pins (🔖 hold a PKR price, release at the floor) ────
test('a pinned price holds while the ROI stays at/above the floor', () => {
  const formula = digital.mergeProduct(RAW_PRODUCT, {}).pricePkr;
  assert.equal(formula, digital.computePkrPrice(1.5));

  const ctx = { forAdmin: true, override: { pinnedPricePkr: 800 } };
  const pinned = digital.mergeProduct(RAW_PRODUCT, ctx);
  assert.equal(pinned.pricePkr, 800);
  assert.equal(pinned.pinnedActive, true);
  assert.equal(pinned.pinnedPricePkr, 800);
  assert.ok(pinned.pinnedRoi >= SETTINGS.pinnedMarkupFloor);
  assert.equal(pinned.pinnedFloor, SETTINGS.pinnedMarkupFloor);
  assert.equal(digital.mergeProduct(RAW_PRODUCT, {}).pricePkr, formula); // no side effect
});

test('a pin releases when the cost drops ROI below the floor', () => {
  // Supplier cost jumps to 2.5 USD → the 300 pin would be a LOSS;
  // the formula takes over so the floor is never breached.
  const ctx = { forAdmin: true, override: { pinnedPricePkr: 300, costUsd: 2.5 } };
  const released = digital.mergeProduct(RAW_PRODUCT, ctx);
  assert.equal(released.pinnedActive, false);
  assert.equal(released.pricePkr, digital.computePkrPrice(2.5));
  assert.equal(released.pinnedPricePkr, 300); // still visible to the admin
  assert.ok(released.pinnedRoi < SETTINGS.pinnedMarkupFloor);
});

test('pinned price and cost are admin-only fields', () => {
  const overrides = { 'prod-1': { pinnedPricePkr: 700, costUsd: 1.5 } };
  const admin = digital.adminProducts([RAW_PRODUCT], { overrides });
  assert.equal(admin[0].pinnedPricePkr, 700);
  assert.equal(admin[0].pricePkr, 700);
  assert.equal(admin[0].costUsd, 1.5);

  const shop = digital.customerProducts([RAW_PRODUCT], { overrides });
  const json = JSON.stringify(shop);
  assert.equal(shop[0].pricePkr, 700); // the pin still shapes the price
  assert.ok(!json.includes('costUsd'));
  assert.ok(!json.includes('pinnedPricePkr'));
  assert.ok(!json.includes('pinnedRoi'));
});

test('search + presentation helpers', () => {
  const list = digital.customerProducts([RAW_PRODUCT], {});
  assert.equal(digital.searchProducts(list, 'netflix').length, 1);
  assert.equal(digital.searchProducts(list, 'canva').length, 0);
  const sections = digital.digitalSections(list, 'en');
  assert.ok(sections.some((s) => s.rows.some((r) => r.id === 'dp:prod-1')));
  assert.ok(digital.digitalOneLiner(list[0]).includes('Netflix'));
});

// ── Shelf clean-up: names + categories ────────────────────────
test('prettifyDigitalName strips supplier listing noise', () => {
  assert.equal(digital.prettifyDigitalName('CapCut Pro (FW) 6m'), 'CapCut Pro · 6 Months');
  assert.equal(digital.prettifyDigitalName('YouTube Premium (NW) 3m'), 'YouTube Premium · 3 Months');
  assert.equal(digital.prettifyDigitalName('Google AI Pro 3m'), 'Google AI Pro · 3 Months');
  assert.equal(digital.prettifyDigitalName('Microsoft Office 365 1 Year'), 'Microsoft 365 · 1 Year');
  assert.equal(digital.prettifyDigitalName('Miro Lifetime 100 invite'), 'Miro Lifetime · 100 Seats');
  // the bracket content is lifted into its own part — never left as "( )"
  assert.equal(digital.prettifyDigitalName('Canva Pro Admin (500 invitations)'), 'Canva Pro Admin · 500 Seats');
  assert.equal(digital.prettifyDigitalName('Lovable Lite 12m (300 Credits)'), 'Lovable Lite · 12 Months · 300 Credits');
  assert.equal(digital.prettifyDigitalName('Gmail Accounts'), 'Gmail Accounts');
  assert.equal(digital.prettifyDigitalName(''), '');
  assert.equal(digital.prettifyDigitalName(null), '');
});

test('mergeProduct shows the polished name (admin override still wins)', () => {
  const clean = digital.mergeProduct({ ...RAW_PRODUCT, name: 'Netflix 1 Month (FW)' }, {});
  assert.equal(clean.name, 'Netflix · 1 Month');

  digital.upsertOverride('prod-1', { customName: 'Netflix 🎬' });
  assert.equal(digital.mergeProduct(RAW_PRODUCT, { override: digital.getOverride('prod-1') }).name, 'Netflix 🎬');
  digital.upsertOverride('prod-1', { customName: null });
  digital.flushOverrides();
});

test('every product lands in exactly one category', () => {
  const names = [
    'ChatGPT Plus 1 Month', 'Canva Pro 1 Year', 'CapCut Pro 1 Month',
    'YouTube Premium 1 Month', 'NordVPN 1 Year', 'Notion Plus 12 Months',
    'Gmail Accounts', 'Coursera Plus 1 Month', 'Lovable Lite 12m (300 Credits)',
  ];
  const list = names.map((name, i) => ({ id: `p${i}`, name }));

  const byKey = new Map(list.map((p) => [p.id, digital.categoryOf(p)]));
  assert.equal(byKey.get('p0'), 'ai');
  assert.equal(byKey.get('p1'), 'design');
  assert.equal(byKey.get('p2'), 'video');
  assert.equal(byKey.get('p3'), 'stream');
  assert.equal(byKey.get('p4'), 'vpn');
  assert.equal(byKey.get('p5'), 'work');
  assert.equal(byKey.get('p6'), 'email');
  assert.equal(byKey.get('p7'), 'learn');
  assert.equal(byKey.get('p8'), 'build');   // nothing left for "More Picks"

  const cats = digital.digitalCategories(list);
  assert.equal(cats.reduce((n, c) => n + c.count, 0), list.length, 'counts add up');
  assert.ok(cats.every((c) => c.minPkr == null || c.count >= 1));

  // ONE list: the category is the section TITLE, its products the rows.
  const sections = digital.digitalCategorySections(digital.customerProducts(list, {}));
  assert.deepEqual(sections.map((s) => s.title), [
    '🤖 AI Chat & Assistants', '🚀 Code & Automation', '🎨 Design & Creative',
    '✂️ Video & Editing', '📺 Streaming & Music', '🔐 VPN & Security',
    '💼 Productivity', '📧 Email Accounts', '🎓 Learning & Lifestyle',
  ]);
  assert.ok(sections.every((s) => s.title.length <= 24), 'WhatsApp section-title limit');
  assert.ok(sections.every((s) => s.rows.length <= 10), 'WhatsApp rows-per-section limit');
  assert.ok(sections.every((s) => s.rows.every((r) => r.id.startsWith('dp:'))),
    'every row is a product — no second menu to tap through');
  for (const row of sections.flatMap((s) => s.rows)) {
    assert.ok(row.title.length <= 64, `row title too long: ${row.title}`);
    assert.ok(row.description.length <= 72, `row description too long: ${row.description}`);
  }
  // …and each product sits under ITS category's title.
  const sectionOf = new Map(sections.flatMap((s) => s.rows.map((r) => [r.id, s.title])));
  assert.equal(sectionOf.get('dp:p0'), '🤖 AI Chat & Assistants');
  assert.equal(sectionOf.get('dp:p6'), '📧 Email Accounts');
});

test('a category with more than 10 items ends in a "+N more" row', () => {
  const many = Array.from({ length: 19 }, (_, i) => ({ id: `b${i}`, name: `Lovable Lite ${i + 1}m` }));
  const list = digital.customerProducts(many, {});
  const sections = digital.digitalCategorySections(list);

  assert.equal(sections.length, 1, 'still ONE section for the whole category');
  assert.equal(sections[0].title, '🚀 Code & Automation');
  assert.equal(sections[0].rows.length, 10, 'never more than 10 rows');
  assert.equal(sections[0].rows.at(-1).id, 'dcat:build', 'the last row opens the full list');
  assert.match(sections[0].rows.at(-1).title, /➕ 10 more in Code & Automation/);
  assert.ok(sections[0].rows.slice(0, 9).every((r) => r.id.startsWith('dp:b')),
    'the first 9 items are listed directly');
});

test('digitalSections never exceeds 10 rows per section (chunked titles)', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ id: `p${i}`, name: `Netflix 1 Month ${i}` }));
  const list = digital.customerProducts(many, {});
  const sections = digital.digitalSections(list, 'en');

  assert.ok(sections.every((s) => s.rows.length <= 10), 'WhatsApp LIST row limit');
  const instant = sections.filter((s) => s.title.startsWith('⚡'));
  assert.equal(instant.length, 3, '25 instant products = 3 chunks');
  assert.deepEqual(instant.map((s) => s.title), ['⚡ Instant 1/3', '⚡ Instant 2/3', '⚡ Instant 3/3']);
  assert.ok(sections.every((s) => s.title.length <= 24));
});

// ── services/prodseller.js ───────────────────────────────────
test('idempotency key is stable, safe and short enough', () => {
  assert.equal(ps.idempotencyKeyFor('smf-0042'), 'simfly_SMF-0042');
  assert.equal(ps.idempotencyKeyFor('SMF-0042'), ps.idempotencyKeyFor('SMF-0042'));
  assert.ok(ps.idempotencyKeyFor('X'.repeat(400)).length <= 100);
});

test('getProducts normalises the catalogue and caches it', async () => {
  let calls = 0;
  ps.__setTransport(async (cfg) => {
    calls += 1;
    assert.equal(cfg.headers['X-API-Key'], 'test-key-do-not-log');
    return { status: 200, data: { products: [RAW_PRODUCT] }, headers: {} };
  });
  ps.__clearCache();

  const first = await ps.getProducts();
  assert.equal(first.ok, true);
  assert.equal(first.products.length, 1);
  assert.equal(first.products[0].requiresEmailActivation, false);
  assert.equal(first.products[0].stock, 4);

  const second = await ps.getProducts();
  assert.equal(second.cached, true);
  assert.equal(calls, 1, 'second call must come from the cache');

  ps.__setTransport(null);
  ps.__clearCache();
});

test('402 becomes a friendly "wait" message + an admin alert', async () => {
  ps.__setTransport(async () => ({ status: 402, data: { error: 'insufficient' }, headers: {} }));
  const res = await ps.createOrder({ productId: 'prod-1', idempotencyKey: 'simfly_SMF-0001' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'INSUFFICIENT_BALANCE');
  assert.equal(res.alert, true);
  assert.match(res.customerMessage, /patience/i);
  assert.ok(!res.customerMessage.includes('402'));
  ps.__setTransport(null);
});

test('409 becomes an out-of-stock message (no raw API text)', () => {
  const info = ps.errorInfo(409, 'internal: product 12 is gone');
  assert.equal(info.code, 'OUT_OF_STOCK');
  assert.equal(info.alert, false);
  assert.ok(!info.customerMessage.includes('product 12'));
});

test('createOrder sends the key ONLY in the header', async () => {
  let seen = null;
  ps.__setTransport(async (cfg) => {
    seen = cfg;
    return {
      status: 200,
      data: { data: { orderId: 'PS-77', status: 'delivered', deliveredKey: 'NETFLIX-SECRET-KEY' } },
      headers: {},
    };
  });

  const res = await ps.createOrder({ productId: 'prod-1', idempotencyKey: 'simfly_SMF-0009' });
  assert.equal(res.ok, true);
  assert.equal(res.order.orderId, 'PS-77');
  assert.equal(res.order.deliveredKey, 'NETFLIX-SECRET-KEY');

  // Key travels in headers only…
  assert.equal(seen.headers['X-API-Key'], 'test-key-do-not-log');
  assert.equal(seen.headers['Idempotency-Key'], 'simfly_SMF-0009');
  assert.equal(seen.headers['Content-Type'], 'application/json');
  // …and the key never appears in the URL.
  assert.ok(!seen.url.includes('test-key-do-not-log'));
  ps.__setTransport(null);
});

test('getOrderStatus reports delivered / paid', async () => {
  ps.__setTransport(async () => ({
    status: 200,
    data: { data: { orderId: 'PS-77', status: 'paid' } },
    headers: {},
  }));
  const paid = await ps.getOrderStatus('PS-77');
  assert.equal(paid.ok, true);
  assert.equal(paid.status, 'paid');

  ps.__setTransport(async () => ({
    status: 200,
    data: { data: { orderId: 'PS-77', status: 'delivered', deliveredKeys: ['A-B-C'] } },
    headers: {},
  }));
  const delivered = await ps.getOrderStatus('PS-77');
  assert.deepEqual(delivered.order.deliveredKeys, ['A-B-C']);
  ps.__setTransport(null);
});

// ── handler helpers ──────────────────────────────────────────
test('email validation + key masking', () => {
  assert.equal(ds.isValidEmail('a@b.com'), true);
  assert.equal(ds.isValidEmail('nope'), false);
  const masked = ds.maskKey('NETFLIX-SECRET-KEY-1234');
  assert.ok(!masked.includes('SECRET'));
  assert.ok(masked.startsWith('NETF') && masked.endsWith('234'));
  assert.equal(ds.maskKey(''), '—');
});

test('digital and eSIM share the SAME two steps', () => {
  // Both catalogues: Step 1 = product/quantity, Step 2 = pay.
  assert.equal(steps.stepIndex('payment', { catalog: 'digital' }), 1);
  assert.equal(steps.stepPrefix('payment', { catalog: 'digital' }), 'Step 2 of 2: Pay');
  assert.match(steps.withStep('payment', 'hello', { catalog: 'digital' }), /^Step 2 of 2: Pay\nhello/);

  // The activation email is folded into Step 1 — it is not a step.
  assert.equal(steps.stepIndex('email', { catalog: 'digital', email: true }), 0);
  assert.equal(steps.stepPrefix('email', { catalog: 'digital', email: true }), 'Step 1 of 2: Choose & Confirm');
  assert.equal(steps.stepIndex('product', { catalog: 'digital' }), 0);

  // Legacy eSIM signature still works (no opts).
  assert.equal(steps.stepIndex('payment'), 1);
  assert.equal(steps.stepPrefix('payment'), 'Step 2 of 2: Pay');
  assert.match(steps.withStep('payment', 'hi'), /^Step 2 of 2: Pay\nhi/);
  assert.equal(steps.stepPrefix('screenshot'), 'Step 2 of 2: Pay', 'old screenshots are still Step 2');
});

// ── activation poll job ──────────────────────────────────────
test('polls: schedule → track → cancel', () => {
  polls.__setPolls([]);
  const p = polls.schedulePoll('SMF-0001', 'PS-100');
  assert.equal(p.orderId, 'SMF-0001');
  assert.equal(p.prodsellerOrderId, 'PS-100');
  assert.equal(polls.activePolls().length, 1);
  assert.ok(p.nextPollAt > Date.now());

  // Re-scheduling keeps ONE entry (never duplicates the API load).
  polls.schedulePoll('SMF-0001', 'PS-100');
  assert.equal(polls.activePolls().length, 1);

  polls.cancelPoll('SMF-0001');
  assert.equal(polls.activePolls().length, 0);
});

test('polls: an order that is still "paid" stays in the queue', async () => {
  polls.__setPolls([]);
  store.putOrder({
    id: 'SMF-0002',
    jid: '923001112223@s.whatsapp.net',
    phone: '923001112223',
    catalogType: 'digital',
    planName: 'Netflix 1 Month',
    productId: 'prod-1',
    price: 625,
    status: 'awaiting_activation',
    prodsellerOrderId: 'PS-200',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  store.flush();

  const poll = polls.schedulePoll('SMF-0002', 'PS-200', Date.now() - 1);
  ps.__setTransport(async (cfg) => {
    assert.ok(cfg.url.includes('/orders/PS-200'));
    return { status: 200, data: { data: { orderId: 'PS-200', status: 'paid' } }, headers: {} };
  });

  const res = await polls.pollOnce({}, poll);
  assert.equal(res.ok, true);
  assert.equal(res.status, 'paid');
  assert.equal(polls.activePolls().length, 1, 'still waiting → keep polling');
  assert.equal(store.getOrder('SMF-0002').status, 'awaiting_activation');

  polls.__setPolls([]);
  ps.__setTransport(null);
  ps.__clearCache();
});

test('polls: a cancelled/rejected order drops out of the queue', async () => {
  polls.__setPolls([]);
  store.putOrder({
    id: 'SMF-0003',
    jid: '923001112224@s.whatsapp.net',
    phone: '923001112224',
    catalogType: 'digital',
    planName: 'Canva Pro',
    price: 300,
    status: 'rejected',
    prodsellerOrderId: 'PS-300',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  store.flush();
  const poll = polls.schedulePoll('SMF-0003', 'PS-300', Date.now() - 1);
  const res = await polls.pollOnce({}, poll);
  assert.equal(res.skipped, 'status_rejected');
  assert.equal(polls.activePolls().length, 0);
  polls.__setPolls([]);
});
