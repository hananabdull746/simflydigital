// 🏪 WhatsApp Business Catalog tests (services/catalogService.js).
//
// Everything runs against a MOCK socket — no WhatsApp connection is
// opened. Local state goes to test/.tmp-wacat-* so the real catalog/
// folder is never touched.
// Run with:  node --test test/wacatalog.test.js
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR_PATH = path.join(HERE, '.tmp-wacat-dir');
const INDEX_PATH = path.join(HERE, '.tmp-wacat-index.json');
const PRODUCTS_PATH = path.join(DIR_PATH, 'products');

process.env.ADMIN_WHATSAPP_NUMBER = '030011122233';
process.env.CATALOG_DIR = DIR_PATH;
process.env.CATALOG_INDEX_FILE = INDEX_PATH;
process.env.CATALOG_SYNC_DELAY_MS = '0';
process.env.CATALOG_SYNC_BATCH = '100';

const cat = await import('../services/catalogService.js');

function cleanup() {
  fs.rmSync(DIR_PATH, { recursive: true, force: true });
  fs.rmSync(INDEX_PATH, { force: true });
}
after(() => { cleanup(); cat.__clearSocket(); });

/** Fresh mock WhatsApp socket + the calls it received. */
function mockSock({ createFails = null, updateFails = null, remote = [] } = {}) {
  const calls = { create: [], update: [], delete: [], fetch: 0 };
  const sock = {
    async productCreate(payload) {
      if (createFails) { const err = new Error(createFails.message || 'boom'); err.statusCode = createFails.statusCode; throw err; }
      calls.create.push(payload);
      return { id: `wa-${calls.create.length}`, imageUrls: { original: `https://mmg.whatsapp.net/p${calls.create.length}` } };
    },
    async productUpdate(id, payload) {
      if (updateFails) { const err = new Error(updateFails.message || 'boom'); err.statusCode = updateFails.statusCode; throw err; }
      calls.update.push([id, payload]);
      return { id, imageUrls: { original: 'https://mmg.whatsapp.net/updated' } };
    },
    async productDelete(ids) {
      calls.delete.push(ids);
      return { deleted: ids.length };
    },
    async getCatalog() {
      calls.fetch += 1;
      return { products: remote, nextPageCursor: undefined };
    },
  };
  return { sock, calls };
}

function seed(retailerId, fields = {}) {
  const saved = cat.saveLocal(retailerId, {
    name: 'Test Product',
    description: 'A test product',
    price: 449,
    currency: 'PKR',
    ...fields,
  });
  assert.equal(saved.ok, true, saved.message);
  return saved.product;
}

function writeImage(retailerId, bytes = 1024) {
  const folder = path.join(PRODUCTS_PATH, retailerId);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'image.jpg'), Buffer.alloc(bytes, 7));
}

function readIndex() {
  return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
}

// ── local files + validation ──────────────────────────────────
test('a local product round-trips through product.json', () => {
  cleanup();
  seed('canva-pro-2-years', { price: 265 });
  const local = cat.getLocal('canva-pro-2-years');
  assert.equal(local.name, 'Test Product');
  assert.equal(local.price, 265);
  assert.equal(local.currency, 'PKR');
  assert.equal(local.image, null); // no image uploaded yet
  assert.equal(cat.listLocal().length, 1);
});

test('validation rejects bad ids, names and prices', () => {
  cleanup();
  assert.equal(cat.saveLocal('Bad ID!', { name: 'x', price: 1 }).code, 'INVALID_RETAILER_ID');
  assert.equal(cat.saveLocal('ok-id', { name: '', price: 1 }).code, 'INVALID_NAME');
  assert.equal(cat.saveLocal('ok-id', { name: 'x', price: 0 }).code, 'INVALID_PRICE');
  assert.equal(cat.saveLocal('ok-id', { name: 'x', price: 10, currency: 'nope' }).code, 'INVALID_CURRENCY');
  assert.equal(cat.saveLocal('ok-id', { name: 'x'.repeat(71), price: 10 }).code, 'INVALID_NAME');
  assert.equal(fs.existsSync(path.join(PRODUCTS_PATH, 'ok-id')), false);
});

test('saveLocal merges with the existing product (partial edit keeps fields)', () => {
  cleanup();
  seed('partial-edit', { name: 'Original', price: 100, description: 'keep me' });
  const out = cat.saveLocal('partial-edit', { price: 150 });
  assert.equal(out.ok, true);
  const local = cat.getLocal('partial-edit');
  assert.equal(local.price, 150);
  assert.equal(local.name, 'Original');
  assert.equal(local.description, 'keep me');
});

// ── create ────────────────────────────────────────────────────
test('createProduct pushes the payload WA needs and only then marks synced', async () => {
  cleanup();
  writeImage('netflix-1-month');
  seed('netflix-1-month', { name: 'Netflix 1 Month', price: 500 });
  const { sock, calls } = mockSock();
  cat.setSocket(sock);

  const out = await cat.createProduct('netflix-1-month');
  assert.equal(out.ok, true);
  assert.equal(out.created, true);
  assert.equal(calls.create.length, 1);

  const payload = calls.create[0];
  assert.equal(payload.name, 'Netflix 1 Month');
  assert.equal(payload.retailerId, 'netflix-1-month');
  assert.equal(payload.price, 500);
  assert.equal(payload.currency, 'PKR');
  assert.equal(payload.originCountryCode, 'PK');
  assert.equal(payload.isHidden, false);
  assert.ok(Array.isArray(payload.images), 'images MUST be an array');
  assert.equal(payload.images.length, 1);
  assert.equal(payload.images[0].url, path.join(PRODUCTS_PATH, 'netflix-1-month', 'image.jpg'));
  assert.equal(payload.availability, undefined, 'availability has no wire field in this build');
  assert.equal(payload.url, undefined, 'url has no wire field in this build');

  const state = readIndex().products['netflix-1-month'];
  assert.equal(state.whatsappProductId, 'wa-1');
  assert.equal(state.lastStatus, 'synced');
  assert.equal(state.lastError, null);
  assert.equal(cat.getProducts()[0].synced, true);
});

test('createProduct keeps local state when WhatsApp rejects (never marks synced)', async () => {
  cleanup();
  seed('rate-limited-product');
  const { sock } = mockSock({ createFails: { statusCode: 429, message: 'rate limit' } });
  cat.setSocket(sock);

  const out = await cat.createProduct('rate-limited-product');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'RATE_LIMITED');

  const state = readIndex().products['rate-limited-product'];
  assert.equal(state.whatsappProductId, undefined, 'no id without confirmation');
  assert.equal(state.lastStatus, 'error');
  assert.match(state.lastError, /RATE_LIMITED/);

  const view = cat.getProducts()[0];
  assert.equal(view.synced, false);
  assert.equal(view.lastStatus, 'error');
  assert.match(view.lastError, /RATE_LIMITED/);
  cat.__clearSocket();
});

test('pushing while the socket is down reports DISCONNECTED', async () => {
  cleanup();
  seed('offline-product');
  cat.__clearSocket();

  const out = await cat.createProduct('offline-product');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'DISCONNECTED');
  assert.equal(cat.getProducts()[0].synced, false);
});

test('an existing WhatsApp id routes the next push to update', async () => {
  cleanup();
  seed('second-push');
  const { sock, calls } = mockSock();
  cat.setSocket(sock);

  await cat.createProduct('second-push');
  // force:false + same content → still update via createProduct's shortcut
  const again = await cat.createProduct('second-push');
  assert.equal(again.ok, true);
  assert.equal(calls.create.length, 1, 'only the first push creates');
  assert.equal(calls.update.length, 1);
  assert.equal(calls.update[0][0], 'wa-1');
  cat.__clearSocket();
});

// ── update ────────────────────────────────────────────────────
test('a local price edit is pushed as productUpdate with a fresh hash', async () => {
  cleanup();
  seed('editable');
  const { sock, calls } = mockSock();
  cat.setSocket(sock);
  await cat.createProduct('editable');
  assert.equal(calls.create.length, 1);

  cat.saveLocal('editable', { price: 999 });
  const view = cat.getProducts()[0];
  assert.equal(view.synced, false, 'local edit invalidates the sync flag');
  assert.equal(view.lastStatus, 'pending');

  const out = await cat.updateProduct('editable', { force: true });
  assert.equal(out.ok, true);
  assert.equal(calls.update.length, 1);
  assert.equal(calls.update[0][1].price, 999);
  assert.equal(cat.getProducts()[0].synced, true);
  cat.__clearSocket();
});

test('an unchanged product is not re-uploaded', async () => {
  cleanup();
  seed('stable-product');
  const { sock, calls } = mockSock();
  cat.setSocket(sock);
  await cat.createProduct('stable-product');

  const out = await cat.updateProduct('stable-product');
  assert.equal(out.ok, true);
  assert.equal(out.unchanged, true);
  assert.equal(calls.update.length, 0, 'no call when the hash matches');
  cat.__clearSocket();
});

test('an unchanged picture reuses the WA image URL instead of re-uploading', async () => {
  cleanup();
  writeImage('image-reuse', 2048);
  seed('image-reuse');
  const { sock, calls } = mockSock();
  cat.setSocket(sock);
  await cat.createProduct('image-reuse');
  const first = calls.create[0].images[0].url;
  assert.match(first, /\.tmp-wacat-dir/, 'first push uploads the local file');

  cat.saveLocal('image-reuse', { price: 42 }); // text-only change
  await cat.updateProduct('image-reuse', { force: true });
  assert.equal(calls.update[0][1].images[0].url, 'https://mmg.whatsapp.net/p1', 'same picture → reuse the WA url');
  cat.__clearSocket();
});

test('availability maps to isHidden (out of stock hides the product)', async () => {
  cleanup();
  seed('hidden-product', { availability: 'out of stock' });
  const { sock, calls } = mockSock();
  cat.setSocket(sock);
  await cat.createProduct('hidden-product');
  assert.equal(calls.create[0].isHidden, true);
  cat.__clearSocket();
});

// ── images ────────────────────────────────────────────────────
test('saveImage stores the upload, drops stale copies and marks pending', async () => {
  cleanup();
  seed('image-upload');
  const { sock, calls } = mockSock();
  cat.setSocket(sock);
  await cat.createProduct('image-upload');

  const saved = cat.saveImage('image-upload', Buffer.alloc(512, 9), 'photo.png');
  assert.equal(saved.ok, true);
  const local = cat.getLocal('image-upload');
  assert.equal(local.image, path.join(PRODUCTS_PATH, 'image-upload', 'image.png'));
  assert.equal(cat.getProducts()[0].synced, false, 'a new picture must be re-pushed');
  assert.equal(cat.getProducts()[0].lastStatus, 'pending');

  const out = await cat.updateProduct('image-upload', { force: true });
  assert.equal(out.ok, true);
  assert.equal(calls.update.length, 1);
  assert.equal(calls.update[0][1].images[0].url, local.image);
  cat.__clearSocket();
});

test('saveImage rejects empty, oversized and wrong-type uploads', () => {
  cleanup();
  seed('image-rules');
  assert.equal(cat.saveImage('image-rules', Buffer.alloc(0), 'a.jpg').code, 'INVALID_IMAGE');
  assert.equal(cat.saveImage('image-rules', Buffer.alloc(6 * 1024 * 1024), 'a.jpg').code, 'INVALID_IMAGE');
  assert.equal(cat.saveImage('image-rules', Buffer.alloc(10), 'evil.exe').code, 'INVALID_IMAGE');
  assert.equal(cat.saveImage('never-seen', Buffer.alloc(10), 'a.jpg').code, 'NOT_FOUND');
});

// ── delete (spec §7: confirmation required) ───────────────────
test('delete refuses without explicit confirmation', async () => {
  cleanup();
  seed('delete-me');
  const { sock, calls } = mockSock();
  cat.setSocket(sock);

  const out = await cat.deleteProduct('delete-me');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'CONFIRMATION_REQUIRED');
  assert.equal(calls.delete.length, 0);
  assert.ok(cat.getLocal('delete-me'), 'local product survives');
  cat.__clearSocket();
});

test('confirmed delete removes it from WhatsApp AND the local folder', async () => {
  cleanup();
  seed('delete-me');
  const { sock, calls } = mockSock();
  cat.setSocket(sock);
  await cat.createProduct('delete-me');

  const out = await cat.deleteProduct('delete-me', { confirmed: true });
  assert.equal(out.ok, true);
  assert.equal(out.deletedOnWa, true);
  assert.deepEqual(calls.delete, [['wa-1']]);
  assert.equal(cat.getLocal('delete-me'), null);
  assert.equal(readIndex().products['delete-me'], undefined);
  cat.__clearSocket();
});

test('delete of a local-only product needs no WhatsApp call', async () => {
  cleanup();
  seed('never-pushed');
  const { sock, calls } = mockSock();
  cat.setSocket(sock);

  const out = await cat.deleteProduct('never-pushed', { confirmed: true });
  assert.equal(out.ok, true);
  assert.equal(calls.delete.length, 0);
  assert.equal(cat.getLocal('never-pushed'), null);
  cat.__clearSocket();
});

// ── sync (spec §8) ────────────────────────────────────────────
test('syncCatalog creates what WA is missing, keeps orphans, honours dryRun', async () => {
  cleanup();
  seed('on-wa');
  seed('needs-push');
  seed('needs-update');

  const { sock, calls } = mockSock({
    remote: [
      { id: 'remote-1', retailerId: 'on-wa' },
      { id: 'remote-2', retailerId: 'some-manual-product' }, // orphan
    ],
  });
  cat.setSocket(sock);

  // 1) dry run reports the plan without touching WA
  const plan = await cat.syncCatalog({ dryRun: true });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.created.sort(), ['needs-push', 'needs-update']);
  assert.deepEqual(plan.updated, ['on-wa'], 'on WA but never pushed locally → update');
  assert.deepEqual(plan.orphans, ['some-manual-product']);
  assert.equal(calls.create.length + calls.update.length, 0, 'dryRun must not mutate');

  // 2) real run
  const out = await cat.syncCatalog({ delayMs: 0 });
  assert.equal(out.ok, true);
  assert.equal(out.created.length, 2, 'never-synced products are created');
  assert.deepEqual(out.updated, ['on-wa'], 'WA already has it → update');
  assert.equal(out.failed.length, 0);
  assert.equal(calls.create.length, 2, 'never-synced products are created');
  assert.equal(calls.update.length, 1);
  assert.equal(calls.delete.length, 0, 'orphans are reported, never deleted');
  assert.equal(calls.fetch, 2, 'one remote read per run');

  const rows = Object.fromEntries(cat.getProducts().map((p) => [p.retailerId, p]));
  assert.equal(rows['needs-push'].synced, true);
  assert.equal(rows['on-wa'].synced, true);
  cat.__clearSocket();
});

test('syncCatalog wires a stale local id to the id WA returns', async () => {
  cleanup();
  seed('recreated-by-hand');
  const { sock, calls } = mockSock({ remote: [{ id: 'fresh-remote-id', retailerId: 'recreated-by-hand' }] });
  cat.setSocket(sock);

  const out = await cat.syncCatalog({ delayMs: 0 });
  assert.equal(out.ok, true);
  assert.equal(out.updated.length, 1);
  assert.equal(calls.update[0][0], 'fresh-remote-id', 'updates the id WA actually has');
  assert.equal(readIndex().products['recreated-by-hand'].whatsappProductId, 'fresh-remote-id');
  cat.__clearSocket();
});

test('syncCatalog stops with DISCONNECTED when the socket is gone', async () => {
  cleanup();
  seed('any-product');
  cat.__clearSocket();

  const out = await cat.syncCatalog({});
  assert.equal(out.ok, false);
  assert.equal(out.code, 'DISCONNECTED');
});

test('syncCatalog defers past the batch limit instead of hammering WA', async () => {
  cleanup();
  for (const id of ['batch-a', 'batch-b', 'batch-c']) seed(id);
  const { sock, calls } = mockSock();
  cat.setSocket(sock);

  const out = await cat.syncCatalog({ delayMs: 0, limit: 2 });
  assert.equal(out.ok, true);
  assert.equal(calls.create.length, 2, 'batch caps the number of mutations');
  assert.equal(out.deferred, true, 'the leftover product waits for the next run');
  assert.equal(out.created.length, 2);
  const syncedIds = new Set(cat.getProducts().filter((p) => p.synced).map((p) => p.retailerId));
  assert.equal(syncedIds.size, 2, 'exactly the batch got pushed');
  cat.__clearSocket();
});

// ── a reply Baileys cannot parse (library bug, see file header) ─
const UNPARSED = "Cannot read properties of undefined (reading 'attrs')";

test('an unparsable create reply is recovered from the catalogue', async () => {
  cleanup();
  seed('unparsed-create');
  const { sock } = mockSock({
    createFails: { message: UNPARSED },
    remote: [{ id: 'wa-found', retailerId: 'unparsed-create', name: 'Test Product' }],
  });
  cat.setSocket(sock);

  const out = await cat.createProduct('unparsed-create');
  assert.equal(out.ok, true, out.message);
  assert.equal(out.whatsappProductId, 'wa-found', 'the catalogue lookup supplies the id');
  const state = readIndex().products['unparsed-create'];
  assert.equal(state.lastStatus, 'synced');
  assert.equal(state.lastError, null);
  cat.__clearSocket();
});

test('an unparsable reply that is NOT on the catalogue fails with an actionable error', async () => {
  cleanup();
  seed('unparsed-miss');
  const { sock } = mockSock({ createFails: { message: UNPARSED }, remote: [] });
  cat.setSocket(sock);

  const out = await cat.createProduct('unparsed-miss');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'REPLY_MISSING_PRODUCT');
  assert.match(out.message, /WhatsApp Business/, 'the admin gets an actionable hint');
  const state = readIndex().products['unparsed-miss'];
  assert.equal(state.whatsappProductId, undefined, 'never marked synced');
  assert.match(state.lastError, /REPLY_MISSING_PRODUCT/);
  cat.__clearSocket();
});

test('a real WhatsApp error is never mistaken for an unparsable reply', async () => {
  cleanup();
  seed('real-error');
  const { sock } = mockSock({ createFails: { statusCode: 404, message: 'not found' } });
  cat.setSocket(sock);

  const out = await cat.createProduct('real-error');
  assert.equal(out.code, 'PRODUCT_NOT_FOUND');
  assert.equal(cat.getProducts()[0].lastStatus, 'error');
  cat.__clearSocket();
});

test('an unparsable update reply is recovered too', async () => {
  cleanup();
  seed('unparsed-update');
  const { sock, calls } = mockSock();
  cat.setSocket(sock);
  await cat.createProduct('unparsed-update');
  assert.equal(calls.create.length, 1);

  cat.saveLocal('unparsed-update', { price: 777 });
  sock.productUpdate = async () => { throw new Error(UNPARSED); };
  sock.getCatalog = async () => ({ products: [{ id: 'wa-1', retailerId: 'unparsed-update' }] });

  const out = await cat.updateProduct('unparsed-update', { force: true });
  assert.equal(out.ok, true, out.message);
  assert.equal(out.whatsappProductId, 'wa-1');
  assert.equal(cat.getProducts()[0].synced, true, 'the edit counts as pushed after verification');
  cat.__clearSocket();
});

test('the reply spy records WhatsApp IQ frames for the error log', async () => {
  cleanup();
  seed('spy-product');
  const { sock } = mockSock();
  sock.ws = new EventEmitter();
  sock.productCreate = async () => {
    sock.ws.emit('CB:iq', {
      tag: 'iq',
      attrs: { type: 'result', id: 'x', from: 's.whatsapp.net' },
      content: [{ tag: 'product_catalog_add', attrs: { v: '1' }, content: [] }],
    });
    return { id: 'wa-spy', imageUrls: {} };
  };
  const before = cat.__replySpy().seq;
  cat.setSocket(sock);

  const out = await cat.createProduct('spy-product');
  assert.equal(out.ok, true, out.message);
  const spy = cat.__replySpy();
  assert.equal(spy.seq, before + 1);
  assert.match(spy.last.node, /product_catalog_add/);
  cat.__clearSocket();
});

// ── live progress (dashboard polls GET /api/catalog/sync/status) ─
test('syncCatalog publishes live progress while the run is in flight', async () => {
  cleanup();
  for (const id of ['live-a', 'live-b']) seed(id);
  const { sock } = mockSock();
  cat.setSocket(sock);
  const seen = [];

  const out = await cat.syncCatalog({
    delayMs: 0,
    onStep: () => seen.push(cat.syncProgress()),
  });
  assert.equal(out.ok, true);
  assert.ok(seen.length >= 4, 'every step reports progress');
  assert.equal(seen[0].running, true, 'running while the steps report');
  assert.equal(seen[0].total, 2);
  assert.equal(seen[0].done, 0, 'the first step starts at 0/2');
  assert.deepEqual(seen[0].current, { id: 'live-a', action: 'create' });
  const last = seen[seen.length - 1];
  assert.equal(last.done, last.total, 'the last step closes the counter');

  const after = cat.syncProgress();
  assert.equal(after.running, false, 'the flag drops when the run settles');
  assert.equal(after.ok, true);
  assert.equal(after.finishedAt != null, true);
  cat.__clearSocket();
});

test('a systemic reply gap aborts the run after the first proof', async () => {
  cleanup();
  for (const id of ['gap-a', 'gap-b', 'gap-c']) seed(id);
  const { sock } = mockSock({ createFails: { message: UNPARSED }, remote: [] });
  cat.setSocket(sock);

  const out = await cat.syncCatalog({ delayMs: 0 });
  assert.equal(out.ok, false, 'an aborted run is not a success');
  assert.equal(out.code, 'REPLY_MISSING_PRODUCT');
  assert.equal(out.aborted, true);
  assert.equal(out.failed.length, 1, 'one proof is enough');
  assert.equal(out.done, 1, 'the loop stopped at the first product');
  assert.equal(out.created.length, 0);
  const rows = Object.fromEntries(cat.getProducts().map((p) => [p.retailerId, p]));
  assert.equal(rows['gap-b'].lastStatus, 'never', 'the rest is never attempted');
  assert.equal(cat.syncProgress().running, false, 'the flag still drops');
  cat.__clearSocket();
});
