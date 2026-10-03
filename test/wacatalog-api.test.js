// 🏪 HTTP-level tests for the dashboard's /api/catalog routes.
// Boots the real zero-dependency dashboard server on a random port
// against tmp stores + a MOCK WhatsApp socket (never a live session).
// Run with:  node --test test/wacatalog-api.test.js
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(HERE, '.tmp-waapi');
const DIR_PATH = path.join(TMP, 'catalog');
const INDEX_PATH = path.join(TMP, 'catalog.json');
const PRODUCTS_PATH = path.join(DIR_PATH, 'products');
const TOKEN = 'wacat-api-test-token';
const PORT = String(41000 + Math.floor(Math.random() * 4000));

// Every project import below must stay dynamic — config.js reads env
// at import time.
process.env.ADMIN_WHATSAPP_NUMBER = '030011122233';
for (const [key, file] of [
  ['STORE_FILE', 'orders.json'], ['REVIEWS_FILE', 'reviews.json'],
  ['SESSIONS_FILE', 'sessions.json'], ['USERS_FILE', 'users.json'],
  ['ALERTS_FILE', 'alerts.json'], ['AUDIT_FILE', 'audit.json'],
  ['ADMIN_STATE_FILE', 'admin.json'], ['PAYMENTS_FILE', 'payments.json'],
  ['BINANCE_TX_FILE', 'binance.json'], ['BROADCAST_FILE', 'broadcast.json'],
  ['WALLETS_FILE', 'wallets.json'], ['WALLET_TX_FILE', 'walletTx.json'],
  ['DIGITAL_POLLS_FILE', 'polls.json'], ['PRICE_SYNC_FILE', 'priceSync.json'],
  ['DIGITAL_OVERRIDES_FILE', 'overrides.json'], ['SALES_FILE', 'sales.json'],
  ['PRODUCT_SUPPLIER_MAP_FILE', 'supplierMap.json'],
]) {
  process.env[key] = path.join(TMP, file);
}
process.env.CATALOG_DIR = DIR_PATH;
process.env.CATALOG_INDEX_FILE = INDEX_PATH;
process.env.CATALOG_SYNC_DELAY_MS = '0';
process.env.CATALOG_SYNC_BATCH = '100';
process.env.DASHBOARD_PORT = PORT;
process.env.DASHBOARD_TOKEN = TOKEN;
delete process.env.ESIMACCESS_API_KEY;
delete process.env.ESIMACCESS_API_SECRET;

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const catalog = await import('../services/catalogService.js');
const dash = await import('../dashboard/server.js');

/** Mock WhatsApp socket — records every call it receives. */
function mockSock() {
  const calls = { create: 0, update: 0, delete: 0 };
  let seq = 0;
  return {
    calls,
    sock: {
      async productCreate() { seq += 1; calls.create += 1; return { id: `wa-${seq}`, imageUrls: { original: `https://mmg.whatsapp.net/${seq}` } }; },
      async productUpdate(id) { calls.update += 1; return { id, imageUrls: { original: 'https://mmg.whatsapp.net/u' } }; },
      async productDelete(ids) { calls.delete += 1; return { deleted: ids.length }; },
      async getCatalog() { return { products: [], nextPageCursor: undefined }; },
    },
  };
}

const BASE = `http://127.0.0.1:${PORT}`;
const call = async (p, { method = 'GET', body, headers = {} } = {}) => {
  const r = await fetch(`${BASE}/api/${p}${p.includes('?') ? '&' : '?'}token=${TOKEN}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, out: await r.json().catch(() => null) };
};

function multipart(bytes, filename = 'photo.jpg') {
  const boundary = `----wacat${Date.now()}${Math.random().toString(16).slice(2)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: image/jpeg\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, bytes, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

const server = dash.startDashboard();
assert.ok(server, 'dashboard must start when DASHBOARD_PORT is set');
await new Promise((resolve, reject) => {
  if (server.listening) return resolve();
  server.once('listening', resolve);
  server.once('error', reject);
});

after(async () => {
  dash.stopDashboard();
  catalog.__clearSocket();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── auth ─────────────────────────────────────────────────────
test('the catalog API demands the dashboard token', async () => {
  const r = await fetch(`${BASE}/api/catalog`);
  assert.equal(r.status, 401);
});

// ── disconnected behaviour (spec §12: DISCONNECTED → 503) ────
test('GET /api/catalog reports the connection state', async () => {
  const { status, out } = await call('catalog');
  assert.equal(status, 200);
  assert.equal(out.connected, false);
  assert.equal(out.code, 'DISCONNECTED');
  assert.deepEqual(out.products, []);
});

test('POST saves locally and reports the failed push (never lies about synced)', async () => {
  const { status, out } = await call('catalog', {
    method: 'POST',
    body: { retailerId: 'api-product', name: 'API Product', description: 'via HTTP', price: 100, currency: 'PKR', push: true },
  });
  assert.equal(status, 201);
  assert.equal(out.ok, true);
  assert.equal(out.product.retailerId, 'api-product');
  assert.equal(out.whatsapp.ok, false);
  assert.equal(out.whatsapp.code, 'DISCONNECTED');

  const list = await call('catalog');
  assert.equal(list.out.products.length, 1);
  assert.equal(list.out.products[0].synced, false);
  assert.equal(list.out.products[0].lastStatus, 'error');
  assert.match(list.out.products[0].lastError, /DISCONNECTED/);
});

test('POST rejects a bad payload with a structured error', async () => {
  const { status, out } = await call('catalog', {
    method: 'POST',
    body: { retailerId: 'bad product', name: 'X', price: 5 },
  });
  assert.equal(status, 400);
  assert.equal(out.code, 'INVALID_RETAILER_ID');
});

test('PUT edits the local product (push attempt reports DISCONNECTED)', async () => {
  const { status, out } = await call('catalog/api-product', {
    method: 'PUT',
    body: { price: 250, push: true },
  });
  assert.equal(status, 200);
  assert.equal(out.product.price, 250);
  assert.equal(out.whatsapp.code, 'DISCONNECTED');
});

test('POST /image accepts a multipart upload and stores it', async () => {
  const upload = multipart(Buffer.alloc(700, 3), 'photo.jpg');
  const r = await fetch(`${BASE}/api/catalog/api-product/image?token=${TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': upload.contentType },
    body: upload.body,
  });
  const out = await r.json();
  assert.equal(r.status, 200);
  assert.equal(out.ok, true);
  assert.ok(fs.existsSync(path.join(PRODUCTS_PATH, 'api-product', 'image.jpg')), 'image lands in the product folder');

  const list = await call('catalog');
  assert.equal(list.out.products[0].hasImage, true);
  assert.equal(list.out.products[0].synced, false, 'a new picture must be re-pushed');
});

test('POST /image without a file part is a 400', async () => {
  const r = await fetch(`${BASE}/api/catalog/api-product/image?token=${TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=nope' },
    body: '--nope\r\nContent-Disposition: form-data; name="other"\r\n\r\nx\r\n--nope--\r\n',
  });
  assert.equal(r.status, 400);
});

test('sync while disconnected answers 503 DISCONNECTED', async () => {
  const { status, out } = await call('catalog/sync', { method: 'POST', body: { dryRun: true } });
  assert.equal(status, 503);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'DISCONNECTED');
});

// ── live sync progress (status polling + single-run guard) ────
test('GET /api/catalog/sync/status reports an idle sync', async () => {
  const { status, out } = await call('catalog/sync/status');
  assert.equal(status, 200);
  assert.equal(out.running, false);
  assert.equal(typeof out.total, 'number');
  assert.ok(Array.isArray(out.created));
  assert.ok(Array.isArray(out.failed));
});

test('POST /sync while a run is in flight answers 409 SYNC_RUNNING', async () => {
  catalog.__forceSyncRunning(true);
  try {
    const { status, out } = await call('catalog/sync', { method: 'POST', body: { dryRun: true } });
    assert.equal(status, 409);
    assert.equal(out.code, 'SYNC_RUNNING');
    assert.equal(out.running, true);
  } finally {
    catalog.__forceSyncRunning(false);
  }
  const idle = await call('catalog/sync/status');
  assert.equal(idle.out.running, false, 'the guard releases again');
});

test('DELETE demands confirmation, then removes the product', async () => {
  const refused = await call('catalog/api-product', { method: 'DELETE' });
  assert.equal(refused.status, 409);
  assert.equal(refused.out.code, 'CONFIRMATION_REQUIRED');
  assert.ok(fs.existsSync(path.join(PRODUCTS_PATH, 'api-product')));

  const done = await call('catalog/api-product?confirmed=1', { method: 'DELETE' });
  assert.equal(done.status, 200);
  assert.equal(done.out.ok, true);
  assert.equal(fs.existsSync(path.join(PRODUCTS_PATH, 'api-product')), false);

  const missing = await call('catalog/nope?confirmed=1', { method: 'DELETE' });
  assert.equal(missing.status, 200, 'nothing to delete is still success');
});

test('DELETE of an unknown product is a 404 on GET', async () => {
  const { status } = await call('catalog/ghost-product');
  assert.equal(status, 404);
});

// ── connected behaviour (mock socket attached) ───────────────
test('with a live socket the API creates, pushes and syncs', async () => {
  const mock = mockSock();
  catalog.setSocket(mock.sock);

  const created = await call('catalog', {
    method: 'POST',
    body: { retailerId: 'live-product', name: 'Live Product', description: 'pushed', price: 449, currency: 'PKR', push: true },
  });
  assert.equal(created.status, 201);
  assert.equal(created.out.whatsapp.ok, true);
  assert.equal(created.out.whatsapp.created, true);
  assert.equal(mock.calls.create, 1);

  let list = await call('catalog');
  assert.equal(list.out.connected, true);
  assert.equal(list.out.code, undefined);
  const row = list.out.products.find((p) => p.retailerId === 'live-product');
  assert.equal(row.synced, true);
  assert.equal(row.lastStatus, 'synced');
  assert.ok(row.whatsappProductId);

  // local edit → pending → push again
  const edited = await call('catalog/live-product', { method: 'PUT', body: { price: 550, push: true } });
  assert.equal(edited.out.whatsapp.ok, true);
  assert.equal(edited.out.whatsapp.updated, true);
  assert.equal(mock.calls.update, 1);

  // full sync over HTTP
  const sync = await call('catalog/sync', { method: 'POST', body: { dryRun: false } });
  assert.equal(sync.status, 200);
  assert.equal(sync.out.ok, true);
  assert.ok(Array.isArray(sync.out.created));
  assert.ok(Array.isArray(sync.out.updated));
  assert.ok(Array.isArray(sync.out.unchanged));
  assert.ok(Array.isArray(sync.out.failed));

  const del = await call('catalog/live-product?confirmed=1', { method: 'DELETE' });
  assert.equal(del.out.ok, true);
  assert.equal(mock.calls.delete, 1);
  assert.equal(fs.existsSync(path.join(PRODUCTS_PATH, 'live-product')), false);
  catalog.__clearSocket();
});

test('the dashboard HTML ships the catalog tab', async () => {
  const r = await fetch(`${BASE}/?token=${TOKEN}`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /data-tab="catalog"/);
  assert.match(html, /tab-catalog/);
  assert.match(html, /async function loadCatalog/);
  assert.match(html, /WhatsApp Catalog/);
  assert.match(html, /id="catProgress"/, 'live sync progress card');
  assert.match(html, /catalog\/sync\/status/, 'the UI polls the status endpoint');
});
