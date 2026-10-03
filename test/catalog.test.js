// Dual-supplier digital catalogue tests (ProdSeller + Eklas):
//   supplier map → price compare → safe fallback → routing
// Run with:  node --test test/catalog.test.js
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.ADMIN_WHATSAPP_NUMBER = '030011122233';
process.env.PRODSELLER_API_KEY = 'ps-test-key-do-not-log';
process.env.PRODSELLER_BASE_URL = 'https://prodseller.test/v1';
process.env.EKLAS_API_KEY = 'eklas-test-key-do-not-log';
process.env.EKLAS_BASE_URL = 'https://eklas.test/v1';
process.env.PRODUCT_SUPPLIER_MAP_FILE = 'test/.tmp-supplier-map.json';
process.env.PRODUCT_COMPARE_CACHE_SECONDS = '120';

const MAP_FILE = new URL('./.tmp-supplier-map.json', import.meta.url);

function writeMap(doc) {
  fs.writeFileSync(MAP_FILE, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}
function clearMap() {
  fs.rmSync(MAP_FILE, { force: true });
}
after(() => clearMap());

const ps = await import('../services/prodseller.js');
const ek = await import('../services/eklas.js');
const pc = await import('../services/productCatalog.js');

/** Reset every cache + transport so each scenario starts from zero. */
function reset() {
  ps.__setTransport(null);
  ek.__setTransport(null);
  ps.__clearCache();
  ek.__clearCache();
  pc.__clearCache();
}

const PS_PRODUCT = {
  id: 'prod-1',
  name: 'Netflix 1 Month',
  price: 5,
  inStock: true,
  stock: 12,
  requiresEmailActivation: false,
  delivery: { type: 'instant' },
};
const EK_PRODUCT = {
  id: 'ek-1',
  name: 'Netflix 1 Month',
  price: 3.5,
  inStock: true,
  stock: 7,
  requiresEmailActivation: false,
  delivery: { type: 'instant' },
};

/** Catalogue + balance transport for one supplier (never touches /orders). */
function shelfTransport({ products, balance = 100 }) {
  return async (cfg) => {
    if (cfg.url.includes('/balance')) return { status: 200, data: { balance }, headers: {} };
    return { status: 200, data: { products }, headers: {} };
  };
}

// ── supplier map ──────────────────────────────────────────────
test('an unmapped product stays ProdSeller-only', () => {
  reset();
  clearMap();
  const entry = pc.entryFor('prod-1');
  assert.equal(entry.prodseller, 'prod-1');
  assert.equal(entry.eklas, null);
  assert.equal(entry.locked, false);
});

test('the map links a canonical id to BOTH supplier SKUs', () => {
  reset();
  writeMap({ default: 'prodseller', products: { 'prod-1': { prodseller: 'prod-1', eklas: 'ek-1' } } });
  const entry = pc.entryFor('prod-1');
  assert.equal(entry.prodseller, 'prod-1');
  assert.equal(entry.eklas, 'ek-1');
  assert.equal(entry.locked, false);
});

test('a locked entry refuses the alternate supplier', () => {
  reset();
  writeMap({ default: 'prodseller', products: { 'prod-1': { prodseller: 'prod-1', eklas: 'ek-1', locked: true } } });
  assert.equal(pc.entryFor('prod-1').locked, true);
  clearMap();
});

// ── price compare ─────────────────────────────────────────────
test('the CHEAPER in-stock supplier wins the shelf', async () => {
  reset();
  writeMap({ default: 'prodseller', products: { 'prod-1': { prodseller: 'prod-1', eklas: 'ek-1' } } });
  ps.__setTransport(shelfTransport({ products: [PS_PRODUCT] }));
  ek.__setTransport(shelfTransport({ products: [EK_PRODUCT] }));

  const res = await pc.getProducts({ force: true });
  assert.equal(res.ok, true);
  const p = res.products.find((x) => x.id === 'prod-1');
  assert.ok(p, 'the mapped product is still listed under its canonical id');
  assert.equal(p.supplier, 'eklas');
  assert.equal(p.supplierProductId, 'ek-1');
  assert.equal(p.price, 3.5);
  assert.equal(p.other.supplier, 'prodseller');
});

test('an out-of-stock cheaper alternate is skipped', async () => {
  reset();
  writeMap({ default: 'prodseller', products: { 'prod-1': { prodseller: 'prod-1', eklas: 'ek-1' } } });
  ps.__setTransport(shelfTransport({ products: [PS_PRODUCT] }));
  ek.__setTransport(shelfTransport({ products: [{ ...EK_PRODUCT, inStock: false, stock: 0 }] }));

  const res = await pc.getProducts({ force: true });
  const p = res.products.find((x) => x.id === 'prod-1');
  assert.equal(p.supplier, 'prodseller');
  assert.equal(p.supplierProductId, 'prod-1');
});

test('a locked product never leaves its supplier even when cheaper', async () => {
  reset();
  writeMap({ default: 'prodseller', products: { 'prod-1': { prodseller: 'prod-1', eklas: 'ek-1', locked: true } } });
  ps.__setTransport(shelfTransport({ products: [PS_PRODUCT] }));
  ek.__setTransport(shelfTransport({ products: [EK_PRODUCT] }));

  const res = await pc.getProducts({ force: true });
  const p = res.products.find((x) => x.id === 'prod-1');
  assert.equal(p.supplier, 'prodseller');
  assert.equal(p.locked, true);
});

test('an Eklas-only map entry shows up as its own shelf item', async () => {
  reset();
  writeMap({ default: 'prodseller', products: { 'vpn-basic': { prodseller: null, eklas: 'ek-9' } } });
  ps.__setTransport(shelfTransport({ products: [PS_PRODUCT] }));
  ek.__setTransport(shelfTransport({ products: [{ ...EK_PRODUCT, id: 'ek-9', name: 'VPN Basic' }] }));

  const res = await pc.getProducts({ force: true });
  const vpn = res.products.find((x) => x.id === 'vpn-basic');
  assert.ok(vpn, 'the Eklas-only product is listed under its canonical id');
  assert.equal(vpn.supplier, 'eklas');
  assert.equal(vpn.supplierProductId, 'ek-9');
  // …and the unmapped ProdSeller product is untouched.
  assert.equal(res.products.find((x) => x.id === 'prod-1').supplier, 'prodseller');
});

// ── Eklas products on the shelf (deduped) ─────────────────────
test('an unmapped Eklas product gets its OWN shelf row', async () => {
  reset();
  clearMap();
  ps.__setTransport(shelfTransport({ products: [PS_PRODUCT] }));
  ek.__setTransport(shelfTransport({
    products: [
      EK_PRODUCT,                                  // same name as PS_PRODUCT
      { ...EK_PRODUCT, id: 'ek-50', name: 'Discord Nitro 1 Month', price: 2 },
    ],
  }));

  const res = await pc.getProducts({ force: true });
  const eklasOnly = res.products.find((x) => x.id === 'eklas:ek-50');
  assert.ok(eklasOnly, 'the Eklas-only product is listed');
  assert.equal(eklasOnly.supplier, 'eklas');
  assert.equal(eklasOnly.supplierProductId, 'ek-50');
  assert.equal(pc.entryFor('eklas:ek-50').eklas, 'ek-50');
  assert.equal(pc.entryFor('eklas:ek-50').prodseller, null);
});

test('an Eklas DUPLICATE is not listed twice — it becomes the alternate', async () => {
  reset();
  clearMap();
  ps.__setTransport(shelfTransport({ products: [PS_PRODUCT] }));
  ek.__setTransport(shelfTransport({ products: [EK_PRODUCT] }));

  const res = await pc.getProducts({ force: true });
  const netflix = res.products.filter((x) => norm(x.name) === norm(PS_PRODUCT.name));
  assert.equal(netflix.length, 1, 'the same product must appear ONCE');
  assert.equal(netflix[0].supplier, 'eklas', 'the cheaper duplicate still wins the shelf');
  assert.equal(netflix[0].supplierProductId, 'ek-1');
  assert.equal(netflix[0].other.supplier, 'prodseller', 'and the other supplier stays comparable');
  assert.equal(res.products.find((x) => x.id.startsWith('eklas:')), undefined,
    'the duplicate never becomes its own row');
});

test('an Eklas-only product listed twice under one name is shown once', async () => {
  reset();
  clearMap();
  ps.__setTransport(shelfTransport({ products: [] }));
  ek.__setTransport(shelfTransport({
    products: [
      { ...EK_PRODUCT, id: 'ek-70', name: 'Spotify Premium 1 Month', price: 3 },
      { ...EK_PRODUCT, id: 'ek-71', name: 'SPOTIFY Premium, 1 Month!', price: 4 },
    ],
  }));

  const res = await pc.getProducts({ force: true });
  const rows = res.products.filter((x) => x.supplier === 'eklas');
  assert.equal(rows.length, 1, 'duplicate names collapse into one row');
  assert.equal(rows[0].supplierProductId, 'ek-70');
});

test('supplier twins that polish to the SAME shelf name list once', async () => {
  reset();
  clearMap();
  ps.__setTransport(shelfTransport({
    products: [{ ...PS_PRODUCT, id: 'ps-cap', name: 'Capcut Pro 7D FW', price: 0.13 }],
  }));
  ek.__setTransport(shelfTransport({
    products: [{ ...EK_PRODUCT, id: 'ek-cap', name: 'Capcut Pro 7 Days (FW)', price: 0.5 }],
  }));

  const res = await pc.getProducts({ force: true });
  const capcut = res.products.filter((x) => /capcut/i.test(x.name));
  assert.equal(capcut.length, 1, 'FW / 7D / 7 Days are ONE product to the shopper');
  assert.equal(capcut[0].supplier, 'prodseller', 'cheaper supplier still wins');
  assert.equal(capcut[0].supplierProductId, 'ps-cap');
  assert.equal(capcut[0].other.supplier, 'eklas', 'the twin stays a comparable alternate');
  assert.equal(res.products.find((x) => x.id.startsWith('eklas:')), undefined,
    'the twin never becomes its own row');
});

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// ── checkout: fallback ────────────────────────────────────────
/** Full scenario: mapped product, ProdSeller chosen, both shelves stocked. */
async function primeCheckout() {
  reset();
  writeMap({ default: 'prodseller', products: { 'prod-1': { prodseller: 'prod-1', eklas: 'ek-1' } } });
  ps.__setTransport(shelfTransport({ products: [PS_PRODUCT] }));
  ek.__setTransport(shelfTransport({ products: [{ ...EK_PRODUCT, price: 9 }] }));
  await pc.getProducts({ force: true });
  assert.equal((await pc.getProducts()).products.find((x) => x.id === 'prod-1').supplier, 'prodseller');
}

test('out of stock on the winner → checkout FALLS BACK to the other supplier', async () => {
  await primeCheckout();

  let eklasOrder = null;
  ps.__setTransport(async (cfg) => {
    if (cfg.method === 'post') return { status: 409, data: { error: 'gone' }, headers: {} };
    if (cfg.url.includes('/balance')) return { status: 200, data: { balance: 100 }, headers: {} };
    return { status: 200, data: { products: [PS_PRODUCT] }, headers: {} };
  });
  ek.__setTransport(async (cfg) => {
    if (cfg.method === 'post') {
      eklasOrder = cfg;
      return { status: 200, data: { data: { orderId: 'EK-55', status: 'delivered', deliveredKey: 'KEY-123' } }, headers: {} };
    }
    if (cfg.url.includes('/balance')) return { status: 200, data: { balance: 100 }, headers: {} };
    return { status: 200, data: { products: [{ ...EK_PRODUCT, price: 9 }] }, headers: {} };
  });

  const res = await pc.createOrder({
    productId: 'prod-1',
    idempotencyKey: 'simfly_SMF-0042',
    clientOrderId: 'simfly_SMF-0042',
  });
  assert.equal(res.ok, true, `expected a fallback purchase, got ${JSON.stringify(res)}`);
  assert.equal(res.supplier, 'eklas');
  assert.deepEqual(res.tried, ['prodseller', 'eklas']);
  assert.equal(res.order.orderId, 'EK-55');
  assert.ok(eklasOrder, 'the Eklas API was actually called');
  assert.equal(eklasOrder.headers.Authorization, 'Bearer eklas-test-key-do-not-log');
  assert.equal(eklasOrder.data.client_order_id, 'simfly_SMF-0042');
  assert.equal(eklasOrder.headers['X-API-Key'], undefined);
  assert.equal(eklasOrder.headers['Idempotency-Key'], undefined);
});

test('an AMBIGUOUS 5xx is never retried on the other supplier', async () => {
  await primeCheckout();

  let psCalls = 0;
  let eklasCalls = 0;
  ps.__setTransport(async (cfg) => {
    if (cfg.method === 'post') {
      psCalls += 1;
      return { status: 500, data: { error: 'boom' }, headers: {} };
    }
    if (cfg.url.includes('/balance')) return { status: 200, data: { balance: 100 }, headers: {} };
    return { status: 200, data: { products: [PS_PRODUCT] }, headers: {} };
  });
  ek.__setTransport(async () => {
    eklasCalls += 1;
    return { status: 500, data: { error: 'boom' }, headers: {} };
  });

  const res = await pc.createOrder({ productId: 'prod-1', idempotencyKey: 'simfly_SMF-0043' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'UPSTREAM');
  assert.equal(res.supplier, 'prodseller');
  assert.deepEqual(res.tried, ['prodseller'], 'no second supplier may be charged after an ambiguous failure');
  assert.equal(eklasCalls, 0, 'the Eklas API must not be called at all');
  assert.ok(psCalls >= 1);
});

test('a locked product never falls back', async () => {
  reset();
  writeMap({ default: 'prodseller', products: { 'prod-1': { prodseller: 'prod-1', eklas: 'ek-1', locked: true } } });
  ps.__setTransport(shelfTransport({ products: [PS_PRODUCT] }));
  ek.__setTransport(shelfTransport({ products: [EK_PRODUCT] }));
  await pc.getProducts({ force: true });

  let eklasCalls = 0;
  ps.__setTransport(async (cfg) => {
    if (cfg.method === 'post') return { status: 409, data: { error: 'gone' }, headers: {} };
    if (cfg.url.includes('/balance')) return { status: 200, data: { balance: 100 }, headers: {} };
    return { status: 200, data: { products: [PS_PRODUCT] }, headers: {} };
  });
  ek.__setTransport(async () => {
    eklasCalls += 1;
    return { status: 200, data: { data: { orderId: 'EK-1', status: 'delivered' } }, headers: {} };
  });

  const res = await pc.createOrder({ productId: 'prod-1', idempotencyKey: 'simfly_SMF-0044' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'OUT_OF_STOCK');
  assert.deepEqual(res.tried, ['prodseller']);
  assert.equal(eklasCalls, 0);
});

test('a wallet top-up style 402 also falls back (no order can exist yet)', async () => {
  await primeCheckout();
  ps.__setTransport(async (cfg) => {
    if (cfg.method === 'post') return { status: 402, data: { error: 'no funds' }, headers: {} };
    if (cfg.url.includes('/balance')) return { status: 200, data: { balance: 0 }, headers: {} };
    return { status: 200, data: { products: [PS_PRODUCT] }, headers: {} };
  });
  ek.__setTransport(async (cfg) => {
    if (cfg.method === 'post') return { status: 200, data: { data: { orderId: 'EK-77', status: 'delivered', deliveredKey: 'K' } }, headers: {} };
    if (cfg.url.includes('/balance')) return { status: 200, data: { balance: 100 }, headers: {} };
    return { status: 200, data: { products: [{ ...EK_PRODUCT, price: 9 }] }, headers: {} };
  });

  const res = await pc.createOrder({ productId: 'prod-1', idempotencyKey: 'simfly_SMF-0045' });
  assert.equal(res.ok, true);
  assert.equal(res.supplier, 'eklas');
  assert.equal(res.order.orderId, 'EK-77');
});

// ── order status routing ──────────────────────────────────────
test('order status is polled on the supplier the order was placed on', async () => {
  reset();
  writeMap({ default: 'prodseller', products: { 'prod-1': { prodseller: 'prod-1', eklas: 'ek-1' } } });

  let seen = null;
  ek.__setTransport(async (cfg) => {
    seen = cfg;
    return { status: 200, data: { data: { orderId: 'EK-55', status: 'delivered' } }, headers: {} };
  });
  const onEklas = await pc.getOrderStatus('EK-55', 'eklas');
  assert.equal(onEklas.ok, true);
  assert.equal(onEklas.status, 'delivered');
  assert.ok(seen.url.startsWith('https://eklas.test/v1/orders/'));
  assert.equal(seen.headers.Authorization, 'Bearer eklas-test-key-do-not-log');
  assert.equal(seen.headers['X-API-Key'], undefined);

  ps.__setTransport(async (cfg) => {
    seen = cfg;
    return { status: 200, data: { data: { orderId: 'PS-1', status: 'paid' } }, headers: {} };
  });
  const onPs = await pc.getOrderStatus('PS-1', 'prodseller');
  assert.equal(onPs.status, 'paid');
  assert.ok(seen.url.startsWith('https://prodseller.test/v1/orders/'));
  assert.equal(seen.headers['X-API-Key'], 'ps-test-key-do-not-log');
  assert.equal(seen.headers.Authorization, undefined);

  clearMap();
  reset();
});
