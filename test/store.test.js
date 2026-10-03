// Digital Store BROWSE + QUANTITY screens:
//   category landing → one category's products → quantity picker →
//   the cart resolver (unit price × quantity) → the hand-pinned
//   Google Gemini supplier map entry.
//
// Run with:  node --test test/store.test.js
//
// Env overrides MUST run before any project module loads.
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.STORE_FILE = 'test/.tmp-store-store.json';
process.env.SESSIONS_FILE = 'test/.tmp-store-sessions.json';
process.env.USERS_FILE = 'test/.tmp-store-users.json';
process.env.ADMIN_STATE_FILE = 'test/.tmp-store-admin.json';
process.env.AUDIT_FILE = 'test/.tmp-store-audit.json';
process.env.WALLETS_FILE = 'test/.tmp-store-wallets.json';
process.env.WALLET_TX_FILE = 'test/.tmp-store-wallet-tx.json';
process.env.DIGITAL_OVERRIDES_FILE = 'test/.tmp-store-overrides.json';
process.env.DIGITAL_POLLS_FILE = 'test/.tmp-store-polls.json';
process.env.PAYMENTS_FILE = 'test/.tmp-store-payments.json';
process.env.BINANCE_TX_FILE = 'test/.tmp-store-binance.json';
process.env.USD_PKR_RATE = '278';
process.env.DIGITAL_MARKUP_PERCENT = '50';
process.env.PRODSELLER_API_KEY = 'ps-test-key-do-not-log';
process.env.PRODSELLER_BASE_URL = 'https://prodseller.test/v1';
process.env.EKLAS_API_KEY = 'eklas-test-key-do-not-log';
process.env.EKLAS_BASE_URL = 'https://eklas.test/v1';
process.env.PRODUCT_SUPPLIER_MAP_FILE = 'data/productSupplierMap.json';
process.env.ADMIN_WHATSAPP_NUMBER = '030011122233';
delete process.env.ESIMACCESS_API_KEY;
delete process.env.ESIMACCESS_API_SECRET;
delete process.env.DASHBOARD_PORT;

const TMP_FILES = [
  '.tmp-store-store.json', '.tmp-store-sessions.json', '.tmp-store-users.json',
  '.tmp-store-admin.json', '.tmp-store-audit.json', '.tmp-store-wallets.json',
  '.tmp-store-wallet-tx.json', '.tmp-store-overrides.json', '.tmp-store-polls.json',
  '.tmp-store-payments.json', '.tmp-store-binance.json',
];
function cleanTmp() {
  for (const f of TMP_FILES) fs.rmSync(new URL(`./${f}`, import.meta.url), { force: true });
}
cleanTmp();
after(() => cleanTmp());

const ps = await import('../services/prodseller.js');
const ek = await import('../services/eklas.js');
const pc = await import('../services/productCatalog.js');
const ds = await import('../handlers/digitalStore.js');
const digital = await import('../lib/digital.js');
const store = await import('../lib/store.js');
const { checkoutItem } = await import('../handlers/checkout.js');

/** One shelf: four instant products across four categories + one activation item. */
const SHELF = [
  { id: 'prod-youtube', name: 'YouTube Premium 1 Month', price: 2, inStock: true, stock: 5, requiresEmailActivation: false },
  { id: 'prod-canva', name: 'Canva Pro 1 Year', price: 3, inStock: true, stock: 5, requiresEmailActivation: false },
  { id: 'prod-chatgpt', name: 'ChatGPT Plus 1 Month', price: 5, inStock: true, stock: 5, requiresEmailActivation: false },
  { id: 'prod-nord', name: 'NordVPN 1 Year', price: 4, inStock: true, stock: 5, requiresEmailActivation: false },
  { id: 'prod-course', name: 'Coursera Plus 1 Month', price: 6, inStock: true, stock: 5, requiresEmailActivation: true },
];

function stubShelf() {
  const transport = async (cfg) => {
    if (cfg.url.includes('/balance')) return { status: 200, data: { balance: 100 }, headers: {} };
    if (cfg.method === 'post') return { status: 409, data: { error: 'gone' }, headers: {} };
    return { status: 200, data: { products: SHELF }, headers: {} };
  };
  ps.__setTransport(transport);
  ek.__setTransport(transport);
  ps.__clearCache();
  ek.__clearCache();
  pc.__clearCache();
}
stubShelf();
// Every test starts from the SAME shared shelf (each test may re-stub).
beforeEach(() => stubShelf());

/** Cheap recording socket — asserts read `sent`. */
function stubSock(sent) {
  return {
    sendMessage: async (jid, content) => {
      sent.push({ jid, content });
      return { key: { id: `m${sent.length}`, remoteJid: jid } };
    },
  };
}

const JID = (n) => `92300100000${n}@s.whatsapp.net`;

/** The last LIST message captured (interactive list shape). */
function lastList(sent) {
  for (let i = sent.length - 1; i >= 0; i -= 1) {
    if (Array.isArray(sent[i].content?.sections)) return sent[i].content;
  }
  return null;
}
const renderedIds = (list) => list.sections.flatMap((s) => s.rows || []).map((r) => r.rowId);

test('the store is ONE list — categories are SECTION TITLES, not a second menu', async () => {
  const sent = [];
  const sock = stubSock(sent);
  await ds.sendStore(sock, JID(1));

  const list = lastList(sent);
  assert.ok(list, 'a LIST message was sent');

  // Category titles as separators, Menu last — no category-picker screen.
  assert.deepEqual(list.sections.map((s) => s.title), [
    '🤖 AI Chat & Assistants', '🎨 Design & Creative', '📺 Streaming & Music',
    '🔐 VPN & Security', '🎓 Learning & Lifestyle', 'Menu',
  ]);
  assert.ok(list.sections.every((s) => s.title.length <= 24), 'section titles ≤ 24 chars');
  assert.ok(list.sections.length <= 10, 'WhatsApp sections limit');
  assert.ok(list.sections.every((s) => s.rows.length <= 10), 'WhatsApp rows limit');

  // The rows ARE the products, and 🔍 Search rides in the Menu section.
  const aiIds = list.sections[0].rows.map((r) => r.rowId);
  assert.ok(aiIds.includes('dp:prod-chatgpt'), 'the category product is listed right there');
  assert.ok(!aiIds.some((id) => id.startsWith('dcat:')), 'small categories need no drill row');
  assert.ok(renderedIds(list).includes('dp_search'));
  assert.ok(renderedIds(list).includes('main_menu'));

  // Numbered plain-text fallback: choices[i] must be rendered row i.
  const rows = renderedIds(list);
  const choices = store.getUser(JID(1)).choices;
  assert.deepEqual(choices.slice(0, rows.length).map((c) => c.id), rows,
    'choices mirror the rendered rows, Menu rows included');
  // …while a typed product name still finds its detail card.
  assert.ok(choices.some((c) => c.id === 'dp:prod-youtube'), 'typed product names still work');
  assert.equal(choices.length, rows.length,
    'every product is a visible row → no hidden choices to drift out of sync');
  assert.equal(store.getUser(JID(1)).flow, 'digital_browse');
});

test('a 19-item category stays one section: 9 rows + a "+N more" row', async () => {
  ps.__setTransport(async (cfg) => {
    if (cfg.url.includes('/balance')) return { status: 200, data: { balance: 100 }, headers: {} };
    if (cfg.method === 'post') return { status: 409, data: { error: 'gone' }, headers: {} };
    return {
      status: 200,
      data: {
        products: Array.from({ length: 19 }, (_, i) => ({
          id: `prod-love${i}`, name: `Lovable Lite ${i + 1}m`, price: 1 + i, inStock: true, stock: 3, requiresEmailActivation: false,
        })),
      },
      headers: {},
    };
  });
  ek.__setTransport(async () => ({ status: 200, data: { products: [] }, headers: {} }));
  ps.__clearCache();
  ek.__clearCache();
  pc.__clearCache();

  const sent = [];
  const sock = stubSock(sent);
  await ds.sendStore(sock, JID(6));

  const list = lastList(sent);
  const section = list.sections.find((s) => s.title.startsWith('🚀'));
  assert.ok(section, 'the category is a section title');
  assert.equal(section.rows.length, 10, 'never more than 10 rows');
  assert.equal(section.rows.at(-1).rowId, 'dcat:build', 'last row opens the full list');
  assert.ok(section.rows.slice(0, 9).every((r) => r.rowId.startsWith('dp:')));

  const rows = renderedIds(list);
  const choices = store.getUser(JID(6)).choices;
  assert.deepEqual(choices.slice(0, rows.length).map((c) => c.id), rows,
    'the drill row stays aligned with the numbered fallback');

  stubShelf(); // restore the shared shelf for any later test
});

test('a category lists ONLY its own products, with back + search rows', async () => {
  const sent = [];
  const sock = stubSock(sent);
  await ds.sendStoreCategory(sock, JID(2), 'design');

  const list = lastList(sent);
  assert.ok(list);
  assert.equal(list.title, '🎨 Design & Creative');
  const ids = renderedIds(list);
  assert.ok(ids.includes('dp:prod-canva'), 'the category product is listed');
  assert.ok(!ids.includes('dp:prod-youtube'), 'other categories stay out');
  assert.ok(ids.includes('back_store') && ids.includes('dp_search'),
    'never a dead-end: back to all categories + search');

  const choices = store.getUser(JID(2)).choices;
  assert.deepEqual(choices.slice(0, ids.length).map((c) => c.id), ids);
  for (const row of list.sections.flatMap((s) => s.rows)) {
    assert.ok((row.title || '').length <= 64, `row title too long: ${row.title}`);
    assert.ok((row.description || '').length <= 72, `row description too long: ${row.description}`);
  }
  assert.ok(list.sections.every((s) => s.title.length <= 24), 'section titles ≤ 24 chars');
  assert.ok(list.sections.every((s) => (s.rows || []).length <= 10), '≤ 10 rows per section');
});

test('an unknown category key falls back to the store list', async () => {
  const sent = [];
  const sock = stubSock(sent);
  await ds.sendStoreCategory(sock, JID(3), 'not-a-category');
  const list = lastList(sent);
  assert.ok(list);
  assert.equal(list.sections[0].title, '🤖 AI Chat & Assistants',
    'back to the one-list store, categories as section titles');
});

test('Order Now asks HOW MANY, and the cart total is unit price × quantity', async () => {
  const sent = [];
  const sock = stubSock(sent);
  await ds.startDigitalOrder(sock, JID(4), 'prod-course');

  const list = lastList(sent);
  assert.ok(list, 'the quantity screen is a LIST');
  const qtyIds = renderedIds(list).filter((id) => id.startsWith('dqty:'));
  assert.deepEqual(qtyIds, ['dqty:1', 'dqty:2', 'dqty:3', 'dqty:5', 'dqty:10'],
    'the row order is the quantity order, cap = 10');
  assert.equal(store.getUser(JID(4)).flow, 'digital_qty');
  assert.equal(store.getUser(JID(4)).dpId, 'prod-course');

  // Every row shows the running total, not just the unit price.
  const priceOf = (n) => qtyIds.length && list.sections
    .flatMap((s) => s.rows)
    .find((r) => r.rowId === `dqty:${n}`);
  assert.match(priceOf(3).description, /each/);
  assert.ok(renderedIds(list).includes('main_menu'), 'Menu nav rows still available');

  // A custom quantity typed by the customer (1–10).
  await ds.handleQuantity(sock, JID(4), '4');
  assert.equal(store.getUser(JID(4)).dpQty, 4);
  assert.equal(store.getUser(JID(4)).flow, 'digital_email',
    'activation product → the email step, not the payment step');

  const item = await checkoutItem(JID(4));
  assert.equal(item.catalog, 'digital');
  assert.equal(item.quantity, 4);
  assert.equal(item.unitPrice, digital.computePkrPrice(6), 'unit price comes straight from the catalogue');
  assert.equal(item.price, item.unitPrice * 4, 'the CART total is × quantity');
  assert.match(item.name, /×4$/, 'the order name says how many');
});

test('a quantity outside 1–10 re-asks instead of silently clamping', async () => {
  const sent = [];
  const sock = stubSock(sent);
  await ds.startDigitalOrder(sock, JID(5), 'prod-course');
  await ds.handleQuantity(sock, JID(5), '99');

  assert.equal(store.getUser(JID(5)).dpQty, 1, 'nothing was stored');
  assert.equal(store.getUser(JID(5)).flow, 'digital_qty', 'the picker stays up');
  assert.ok(sent.some((s) => /1\s*[-–]\s*10/.test(s.content?.text || '')),
    'the customer is told the allowed range');
  assert.ok(lastList(sent), 'the quantity screen is re-sent');
});

test('Google Gemini is pinned to the ProdSeller SKU (Eklas = compared alternate)', () => {
  const entry = pc.entryFor('6a31035939dc014325da2c66');
  assert.equal(entry.prodseller, '6a31035939dc014325da2c66', 'ProdSeller stays primary');
  assert.equal(entry.eklas, '9', 'the Eklas SKU is linked, so ONE shelf row is shown');
  assert.equal(entry.locked, false,
    'price compare stays on: Eklas takes over only if it becomes cheaper');
});
