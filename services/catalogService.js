// ─────────────────────────────────────────────────────────────
// services/catalogService.js
// 🏪 Auto-post the store to the WhatsApp Business CATALOGUE.
//
// Local truth lives in catalog/:
//   catalog/products/<retailerId>/product.json  (+ image.jpg)
//   catalog/catalog.json                        retailerId → WhatsApp
//                                               product id + sync state
//
// Verified against the INSTALLED @itsliaaa/baileys@0.3.18-final
// (lib/Socket/business.js + lib/Utils/business.js) — every call
// below matches that source exactly:
//
//   sock.productCreate(create)            → uploads images itself
//   sock.productUpdate(productId, update) → same media handling
//   sock.productDelete([productId…])      → { deleted }
//   sock.getCatalog({ jid, limit, cursor }) → { products, nextPageCursor }
//   sock.getCollections(jid, limit)       → { collections }   (read-only:
//     this version has NO collectionCreate/collectionUpdate — do not call them)
//
// Images: `images: [{ url }]` accepts a LOCAL FILE PATH, an http(s)
// URL, a data: URL, a Buffer-ish stream entry or an already-uploaded
// `.whatsapp.net` URL (getStream → waUploadToServer,
// mediaType 'product-catalog-image'). A local path is therefore fine
// — but `images` must ALWAYS be an array: toProductNode reads
// `product.images.length` unconditionally (TypeError otherwise).
//
// Fields this version actually transmits (toProductNode):
//   name · description · retailerId · images · price · currency ·
//   originCountryCode · isHidden
//   ✗ `url` and `availability` are parsed back from WA but NOT sent —
//     availability is therefore modelled locally and mapped to
//     isHidden ('in stock' → visible, anything else → hidden).
//
// Rule from the spec: a product is NEVER marked synchronized until
// WhatsApp has confirmed the operation (the index is written only
// after the API call returns).
//
// Known library bug this file works around: parseProductNode()
// (baileys lib/Utils/business.js:154) reads `productNode.attrs`
// unguarded, so a SUCCESS reply that carries no <product> child dies
// with "Cannot read properties of undefined (reading 'attrs')".
// productWrite() catches that, verifies the write on the catalogue
// (matched on retailerId) and only then marks anything synced.
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PATHS, SETTINGS } from '../config.js';
import { log, logError } from '../lib/logger.js';

const PRODUCTS_DIR = () => path.join(PATHS.catalogDir, 'products');
const DIR_RE = /^[a-z0-9][a-z0-9-]{1,63}$/i; // retailerId = folder name
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // WA catalogue images are capped at ~5MB
const CURRENCIES = /^[A-Z]{3}$/;

let sock = null;

/** Called by index.js on connection.open / connection.close. */
export function setSocket(s) {
  sock = s || null;
  if (s) spyOnReplies(s);
  else log.info({ event: 'catalog.socket' }, 'catalog socket cleared');
}

export function isReady() {
  return Boolean(sock && typeof sock.productCreate === 'function');
}

// ── WhatsApp reply diagnostics ────────────────────────────────
// Every IQ answer from WhatsApp is mirrored through the socket's
// `CB:iq` event, so we keep the last one around: when Baileys chokes
// on an unparsable catalog reply the log shows the actual frame.
const replySpy = { seq: 0, last: null };
const spied = new WeakSet();

function serialiseNode(node) {
  try {
    return JSON.stringify(node, (key, value) => {
      if (value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
        const head = Buffer.from(value.data.subarray(0, 96)).toString('latin1').replace(/[^\x20-\x7e]/g, '.');
        return `<${value.data.length}B ${head}>`;
      }
      return value;
    }).slice(0, 4000);
  } catch {
    return null;
  }
}

function spyOnReplies(s) {
  try {
    const ws = s?.ws;
    if (!ws || typeof ws.on !== 'function' || spied.has(ws)) return;
    spied.add(ws);
    ws.on('CB:iq', (node) => {
      try {
        const type = node?.attrs?.type;
        if (type !== 'result' && type !== 'error') return;
        replySpy.seq += 1;
        replySpy.last = { at: new Date().toISOString(), type, node: serialiseNode(node) };
      } catch { /* the spy must never break the socket */ }
    });
  } catch { /* mock sockets have no ws */ }
}

// ── logging (spec §13: [CATALOG] / [CATALOG ERROR], no secrets) ─
const note = (msg) => console.log(`[CATALOG] ${msg}`);
const fail = (msg) => console.error(`[CATALOG ERROR] ${msg}`);

// ── local files ──────────────────────────────────────────────
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') logError('catalog.read', err, { file });
    return fallback;
  }
}

function writeJson(file, doc) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

/** catalog/catalog.json — { updatedAt, products: { <retailerId>: state } } */
function readIndex() {
  const doc = readJson(PATHS.catalogIndex, null);
  if (!doc || typeof doc !== 'object') return { updatedAt: null, products: {} };
  return { updatedAt: doc.updatedAt || null, products: doc.products || {} };
}

function writeIndex(doc) {
  writeJson(PATHS.catalogIndex, { ...doc, updatedAt: new Date().toISOString() });
}

export function imageFile(retailerId, imageName = 'image.jpg') {
  // basename() — the stored name never escapes its own product folder.
  return path.join(PRODUCTS_DIR(), String(retailerId), path.basename(String(imageName || 'image.jpg')));
}

function imageInfo(retailerId, imageName) {
  const file = imageFile(retailerId, imageName);
  try {
    const st = fs.statSync(file);
    return { file, name: path.basename(file), exists: st.size > 0, bytes: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return { file, name: path.basename(file), exists: false, bytes: 0, mtimeMs: 0 };
  }
}

/** Image facts already resolved by getLocal(). */
const infoFromLocal = (local) => ({
  file: local?.image || null,
  name: local?.imageName || 'image.jpg',
  exists: Boolean(local?.image),
  bytes: Number(local?.imageBytes || 0),
  mtimeMs: Number(local?.imageMtimeMs || 0),
});

/** One local product, exactly as the admin edited it. */
export function getLocal(retailerId) {
  const id = String(retailerId || '');
  if (!DIR_RE.test(id)) return null;
  const file = path.join(PRODUCTS_DIR(), id, 'product.json');
  const product = readJson(file, null);
  if (!product) return null;
  const img = imageInfo(id, product.image);
  return {
    ...product,
    retailerId: product.retailerId || id,
    image: img.exists ? img.file : null,
    imageName: img.name,
    imageBytes: img.bytes,
    imageMtimeMs: img.mtimeMs,
  };
}

/** Every local product (the catalogue the admin maintains). */
export function listLocal() {
  let entries = [];
  try {
    entries = fs.readdirSync(PRODUCTS_DIR(), { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') logError('catalog.list', err, { dir: PRODUCTS_DIR() });
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => getLocal(e.name))
    .filter(Boolean);
}

// ── validation (spec §12: invalid price / image / currency) ──
function validate(product, { requireImage = false } = {}) {
  const p = product || {};
  const name = String(p.name || '').trim();
  if (!name) return { ok: false, code: 'INVALID_NAME', message: 'name is required' };
  if (name.length > 70) return { ok: false, code: 'INVALID_NAME', message: 'name must be ≤ 70 characters' };

  const price = Number(p.price);
  if (!Number.isFinite(price) || price <= 0) {
    return { ok: false, code: 'INVALID_PRICE', message: 'price must be a positive number' };
  }

  const currency = String(p.currency || 'PKR').toUpperCase();
  if (!CURRENCIES.test(currency)) {
    return { ok: false, code: 'INVALID_CURRENCY', message: 'currency must be a 3-letter code (e.g. PKR)' };
  }

  const description = String(p.description || '').trim();
  if (description.length > 1000) {
    return { ok: false, code: 'INVALID_DESCRIPTION', message: 'description must be ≤ 1000 characters' };
  }

  const img = infoFromLocal(p);
  if (requireImage && !img.exists) {
    return { ok: false, code: 'INVALID_IMAGE', message: 'image.jpg is missing for this product' };
  }
  if (img.exists && img.bytes > MAX_IMAGE_BYTES) {
    return { ok: false, code: 'INVALID_IMAGE', message: `image is ${(img.bytes / 1048576).toFixed(1)}MB (max 5MB)` };
  }

  return { ok: true, product: { ...p, name, price, currency, description } };
}

/** Change detector: fields WA should see + the image file itself. */
function localHash(product, img) {
  const basis = JSON.stringify({
    name: product.name,
    description: product.description || '',
    price: Number(product.price),
    currency: product.currency || 'PKR',
    originCountryCode: product.originCountryCode || 'PK',
    availability: product.availability || 'in stock',
    image: img?.exists ? `${img.bytes}:${img.mtimeMs}` : null,
  });
  return crypto.createHash('sha1').update(basis).digest('hex');
}

/** Image identity alone — lets a name-only edit skip the re-upload. */
function imageSig(img) {
  if (!img?.exists) return null;
  return crypto.createHash('sha1').update(`${img.bytes}:${img.mtimeMs}`).digest('hex');
}

// ── payload for productCreate / productUpdate ────────────────
/** 'in stock' → visible; anything else → hidden (availability has no wire field). */
const isHiddenFor = (product) => String(product.availability || 'in stock').toLowerCase() !== 'in stock';

function payloadFrom(product, img, { previous = null } = {}) {
  // Always an array — toProductNode does product.images.length unconditionally.
  let images = [];
  if (img?.exists) {
    // When the picture itself did not change, hand WA the URL it gave
    // us last time: uploadingNecessaryImages passes *.whatsapp.net
    // URLs straight through (no second upload).
    const samePicture = previous?.imageHash && previous.imageHash === imageSig(img);
    const remote = previous?.imageRemoteUrl;
    images = samePicture && remote ? [{ url: remote }] : [{ url: img.file }];
  }
  return {
    name: product.name,
    description: product.description || '',
    retailerId: product.retailerId,
    price: Number(product.price),
    currency: product.currency || 'PKR',
    originCountryCode: product.originCountryCode || 'PK',
    isHidden: isHiddenFor(product),
    images,
  };
}

// ── error handling (spec §12) ────────────────────────────────
/** Baileys parseProductNode(undefined) → "reading 'attrs'" (see productWrite). */
const isUnparsedReply = (err, msg) =>
  err?.code === 'REPLY_MISSING_PRODUCT' || /reading 'attrs'|no product data|no product id/i.test(msg);

function classify(err, op, retailerId) {
  const status = Number(err?.output?.statusCode ?? err?.statusCode ?? err?.status);
  const msg = String(err?.message || err || 'unknown error');
  let code = 'CATALOG_UNAVAILABLE';
  if (!isReady()) code = 'DISCONNECTED';
  else if (status === 429 || /rate.?limit/i.test(msg)) code = 'RATE_LIMITED';
  else if (status === 401 || status === 403 || status === 440 || /login|logged out|authentication/i.test(msg)) code = 'AUTH_EXPIRED';
  else if (status === 404 || /not found/i.test(msg)) code = 'PRODUCT_NOT_FOUND';
  else if (/ENOENT|image/i.test(msg)) code = 'INVALID_IMAGE';
  else if (isUnparsedReply(err, msg)) code = 'REPLY_MISSING_PRODUCT';
  else if (op === 'create') code = 'CREATE_FAILED';
  else if (op === 'update') code = 'UPDATE_FAILED';
  else if (op === 'delete') code = 'DELETE_FAILED';
  const out = { ok: false, code, message: msg.slice(0, 300), retailerId, op };
  logError(`catalog.${op}`, err, { retailerId, code });
  fail(`Failed to ${op} ${retailerId || ''} — ${code}: ${msg.slice(0, 160)}`);
  return out;
}

function disconnected(retailerId, op) {
  fail(`WhatsApp not connected — cannot ${op} ${retailerId || 'catalog'}`);
  const out = { ok: false, code: 'DISCONNECTED', message: 'WhatsApp is not connected', retailerId, op };
  if (retailerId) markError(retailerId, out);
  return out;
}

/** Remember the failed push so the admin UI can show Status = error. */
function markError(retailerId, out) {
  try {
    const index = readIndex();
    const state = index.products[retailerId] || { retailerId };
    index.products[retailerId] = {
      ...state,
      lastStatus: 'error',
      lastError: `${out.code}: ${out.message}`.slice(0, 300),
      lastErrorAt: new Date().toISOString(),
    };
    writeIndex(index);
  } catch (err) {
    logError('catalog.mark_error', err, { retailerId });
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── remote catalogue ─────────────────────────────────────────
/**
 * EVERY product on the WA catalogue (follows the paging cursor).
 * @returns {Promise<{ok, products, code?, message?}>}
 */
export async function remoteCatalog({ limit = 50, maxPages = 40 } = {}) {
  if (!isReady()) return { ok: false, products: [], ...disconnected(null, 'fetch') };
  const products = [];
  let cursor;
  try {
    for (let page = 0; page < maxPages; page += 1) {
      const res = await sock.getCatalog({ limit, cursor });
      products.push(...(res?.products || []));
      cursor = res?.nextPageCursor;
      if (!cursor) break;
    }
    if (!products.length) {
      // Diagnostic: is this a REAL empty catalogue or a bare <iq/> ack?
      // The last IQ frame (the getCatalog answer) tells us which.
      log.info({ event: 'catalog.remote_empty', reply: replySpy.last }, 'remote catalogue is empty');
    }
    return { ok: true, products };
  } catch (err) {
    return { ok: false, products, ...classify(err, 'fetch', null) };
  }
}

// ── create / update / delete ─────────────────────────────────
/**
 * The product with THIS retailerId on the WA catalogue (pages through
 * the cursor). Used to verify a write Baileys could not parse.
 * @returns {Promise<object|null>}
 */
async function findRemote(retailerId) {
  const want = String(retailerId);
  let cursor;
  for (let page = 0; page < 40; page += 1) {
    const res = await sock.getCatalog({ limit: 50, cursor });
    const hit = (res?.products || []).find((p) => p?.retailerId && String(p.retailerId) === want);
    if (hit) return hit;
    cursor = res?.nextPageCursor;
    if (!cursor) return null;
  }
  return null;
}

/**
 * Run productCreate / productUpdate and survive a reply Baileys cannot
 * parse. WhatsApp answers a catalog write with a plain
 * `<iq type="result">` that SOMETIMES carries no <product> child —
 * parseProductNode() then throws "reading 'attrs'". A result without an
 * <error> child (query() asserts that) means WhatsApp accepted the
 * write, so the product is read back from the catalogue instead.
 *
 * When it is NOT on the catalogue either, the write really failed and a
 * friendly REPLY_MISSING_PRODUCT error replaces the library TypeError.
 *
 * @param {'create'|'update'} op
 * @param {string} retailerId
 * @param {() => Promise<object>} fn the baileys call
 * @returns {Promise<object>} parsed remote product (always has .id)
 */
async function productWrite(op, retailerId, fn) {
  try {
    const remote = await fn();
    if (remote?.id) return remote;
    const err = new Error('WhatsApp returned no product id');
    err.code = 'REPLY_MISSING_PRODUCT';
    throw err;
  } catch (err) {
    if (!isUnparsedReply(err, String(err?.message || err))) throw err; // real WA error → classify()
    logError(`catalog.${op}.reply_unparsed`, err, {
      retailerId, seq: replySpy.seq, reply: replySpy.last,
    });
    note(`WhatsApp answered the ${op} of ${retailerId} without product data — verifying on the catalogue`);
    let found = null;
    try {
      found = await findRemote(retailerId);
    } catch (verifyErr) {
      logError('catalog.verify', verifyErr, { retailerId });
    }
    if (found?.id) {
      note(`Verified on the catalogue: ${found.id}`);
      return found;
    }
    const friendly = new Error(
      'WhatsApp acknowledged the write but returned no product data. Make sure this number '
      + 'is a WhatsApp Business account with an active catalog (WhatsApp Business app → '
      + 'Business tools → Catalog), then retry.',
    );
    friendly.code = 'REPLY_MISSING_PRODUCT';
    friendly.cause = err;
    friendly.reply = replySpy.last;
    throw friendly;
  }
}

/**
 * Push ONE local product to WhatsApp (create, or update when the
 * retailerId already lives on the catalogue).
 * @returns {Promise<{ok, retailerId, whatsappProductId, created, remote}>}
 */
export async function createProduct(retailerId, { force = false } = {}) {
  const local = getLocal(retailerId);
  if (!local) return { ok: false, code: 'NOT_FOUND', message: 'no local product', retailerId };
  const check = validate(local);
  if (!check.ok) return { ...check, retailerId };
  if (!isReady()) return disconnected(retailerId, 'create');

  const index = readIndex();
  const previous = index.products[local.retailerId] || null;
  if (previous?.whatsappProductId && !force) {
    return updateProduct(local.retailerId, { force: true });
  }

  const img = infoFromLocal(local);
  const payload = payloadFrom(check.product, img, { previous });
  note(`Creating product ${local.retailerId}`);
  if (img.exists) note('Uploading image');

  try {
    const remote = await productWrite('create', local.retailerId, () => sock.productCreate(payload));
    index.products[local.retailerId] = {
      ...(previous || {}),
      retailerId: local.retailerId,
      whatsappProductId: remote.id,
      name: check.product.name,
      price: Number(check.product.price),
      currency: check.product.currency,
      hash: localHash(check.product, img),
      imageHash: imageSig(img),
      imageRemoteUrl: remote.imageUrls?.original || null,
      reviewStatus: remote.reviewStatus?.whatsapp || null,
      lastSyncedAt: new Date().toISOString(),
      lastStatus: 'synced',
      lastError: null,
    };
    writeIndex(index);
    note(`WhatsApp product created: ${remote.id}`);
    log.info({ event: 'catalog.created', retailerId: local.retailerId, whatsappProductId: remote.id }, 'catalog product created');
    return {
      ok: true, retailerId: local.retailerId, whatsappProductId: remote.id, created: true, remote,
    };
  } catch (err) {
    const out = { ...classify(err, 'create', local.retailerId), retailerId: local.retailerId };
    markError(local.retailerId, out);
    return out;
  }
}

/**
 * Push local edits for ONE product (name / description / price /
 * currency / image / availability — anything in product.json).
 */
export async function updateProduct(retailerId, { force = false } = {}) {
  const local = getLocal(retailerId);
  if (!local) return { ok: false, code: 'NOT_FOUND', message: 'no local product', retailerId };
  const check = validate(local);
  if (!check.ok) return { ...check, retailerId };

  const index = readIndex();
  const state = index.products[local.retailerId];
  let waId = state?.whatsappProductId || null;
  const img = infoFromLocal(local);
  const hash = localHash(check.product, img);
  if (!force && state?.hash === hash && waId) {
    return { ok: true, retailerId: local.retailerId, whatsappProductId: waId, unchanged: true };
  }
  if (!waId) {
    // Never synced yet — create is the correct operation.
    return createProduct(local.retailerId, { force: true });
  }
  if (!isReady()) return disconnected(retailerId, 'update');

  const payload = payloadFrom(check.product, img, { previous: state });
  note(`Updating product ${local.retailerId}`);
  try {
    const remote = await productWrite('update', local.retailerId, () => sock.productUpdate(waId, payload));
    index.products[local.retailerId] = {
      ...state,
      retailerId: local.retailerId,
      whatsappProductId: remote.id,
      name: check.product.name,
      price: Number(check.product.price),
      currency: check.product.currency,
      hash,
      imageHash: imageSig(img),
      imageRemoteUrl: img.exists ? (remote.imageUrls?.original || state?.imageRemoteUrl || null) : null,
      reviewStatus: remote.reviewStatus?.whatsapp || null,
      lastSyncedAt: new Date().toISOString(),
      lastStatus: 'synced',
      lastError: null,
    };
    writeIndex(index);
    note(`WhatsApp product updated: ${remote.id}`);
    log.info({ event: 'catalog.updated', retailerId: local.retailerId, whatsappProductId: remote.id }, 'catalog product updated');
    return { ok: true, retailerId: local.retailerId, whatsappProductId: remote.id, updated: true, remote };
  } catch (err) {
    const out = { ...classify(err, 'update', local.retailerId), retailerId: local.retailerId };
    markError(local.retailerId, out);
    return out;
  }
}

/**
 * Remove the product from WhatsApp AND locally (folder stays only if
 * keepLocal — the dashboard never keeps it: local = source of truth).
 * @param {{confirmed?: boolean, keepLocal?: boolean}} opts spec §7: confirmation required
 */
export async function deleteProduct(retailerId, { confirmed = false, keepLocal = false } = {}) {
  if (!confirmed) {
    return { ok: false, code: 'CONFIRMATION_REQUIRED', message: 'pass confirmed:true to delete', retailerId };
  }
  const index = readIndex();
  const state = index.products[retailerId];
  const waId = state?.whatsappProductId || null;
  let deletedOnWa = false;

  if (waId) {
    if (!isReady()) return disconnected(retailerId, 'delete');
    note(`Deleting product ${retailerId} (${waId})`);
    try {
      const res = await sock.productDelete([waId]);
      deletedOnWa = Number(res?.deleted || 0) > 0;
      // Not deleted on WA (already gone) is still a successful outcome.
      if (!deletedOnWa) note(`WhatsApp reported 0 deletions for ${retailerId} (already removed?)`);
    } catch (err) {
      const out = { ...classify(err, 'delete', retailerId), retailerId };
      // 404-style failures mean it is already gone — fall through to local removal.
      if (out.code !== 'PRODUCT_NOT_FOUND') { markError(retailerId, out); return out; }
    }
  }

  delete index.products[retailerId];
  writeIndex(index);
  if (!keepLocal) {
    fs.rmSync(path.join(PRODUCTS_DIR(), retailerId), { recursive: true, force: true });
  }
  note(`Product removed: ${retailerId}`);
  log.info({ event: 'catalog.deleted', retailerId, whatsappProductId: waId }, 'catalog product deleted');
  return { ok: true, retailerId, whatsappProductId: waId, deletedOnWa };
}

// ── reads (admin API) ────────────────────────────────────────
/**
 * Local products joined with their sync state — the list the admin
 * UI renders.
 */
export function getProducts() {
  const index = readIndex();
  return listLocal().map((p) => {
    const state = index.products[p.retailerId] || {};
    const img = infoFromLocal(p);
    return {
      retailerId: p.retailerId,
      name: p.name,
      description: p.description || '',
      price: Number(p.price),
      currency: p.currency || 'PKR',
      availability: p.availability || 'in stock',
      originCountryCode: p.originCountryCode || 'PK',
      hasImage: img.exists,
      imageBytes: img.bytes,
      whatsappProductId: state.whatsappProductId || null,
      reviewStatus: state.reviewStatus || null,
      synced: Boolean(state.whatsappProductId) && state.hash === localHash(p, img),
      lastSyncedAt: state.lastSyncedAt || null,
      lastStatus: state.lastStatus || (state.whatsappProductId ? 'synced' : 'never'),
      lastError: state.lastError || null,
    };
  });
}

export function getLocalProduct(retailerId) {
  const local = getLocal(retailerId);
  if (!local) return null;
  const state = readIndex().products[local.retailerId] || {};
  return { ...local, whatsappProductId: state.whatsappProductId || null, sync: state };
}

/** Create/replace the LOCAL product file (WhatsApp push = separate sync step). */
export function saveLocal(retailerId, fields) {
  const id = String(retailerId || '').trim();
  if (!DIR_RE.test(id)) {
    return { ok: false, code: 'INVALID_RETAILER_ID', message: 'retailerId must be slug-like (a-z, 0-9, -)' };
  }
  const existing = getLocal(id);
  const imageName = existing?.imageName || 'image.jpg';
  const merged = {
    retailerId: id,
    name: fields.name ?? existing?.name ?? '',
    description: fields.description ?? existing?.description ?? '',
    price: Number(fields.price ?? existing?.price ?? 0),
    currency: (fields.currency ?? existing?.currency ?? 'PKR').toUpperCase(),
    originCountryCode: (fields.originCountryCode ?? existing?.originCountryCode ?? 'PK').toUpperCase(),
    availability: fields.availability ?? existing?.availability ?? 'in stock',
    image: `./${imageName}`,
    imageBytes: existing?.imageBytes ?? 0,
  };
  const check = validate(merged);
  if (!check.ok) return { ...check, retailerId: id };
  writeJson(path.join(PRODUCTS_DIR(), id, 'product.json'), {
    retailerId: id,
    name: merged.name,
    description: merged.description,
    price: merged.price,
    currency: merged.currency,
    originCountryCode: merged.originCountryCode,
    availability: merged.availability,
    image: merged.image,
  });
  log.info({ event: 'catalog.local_saved', retailerId: id }, 'local catalog product saved');
  // Local truth moved — the last push is stale until the next sync.
  const index = readIndex();
  if (index.products[id]) {
    index.products[id].lastStatus = 'pending';
    index.products[id].lastError = null;
    writeIndex(index);
  }
  return { ok: true, retailerId: id, product: getLocal(id) };
}

/** Store an uploaded image (route already parsed the multipart body). */
export function saveImage(retailerId, buffer, filename = 'image.jpg') {
  const id = String(retailerId || '');
  const product = readJson(path.join(PRODUCTS_DIR(), id, 'product.json'), null);
  if (!product) return { ok: false, code: 'NOT_FOUND', message: 'no local product' };
  if (!buffer?.length) return { ok: false, code: 'INVALID_IMAGE', message: 'empty upload' };
  if (buffer.length > MAX_IMAGE_BYTES) {
    return { ok: false, code: 'INVALID_IMAGE', message: `image is ${(buffer.length / 1048576).toFixed(1)}MB (max 5MB)` };
  }
  const ext = (path.extname(String(filename || '')) || '.jpg').toLowerCase();
  if (!IMAGE_EXT.has(ext)) {
    return { ok: false, code: 'INVALID_IMAGE', message: `unsupported image type ${ext} (use jpg/png/webp)` };
  }
  const folder = path.join(PRODUCTS_DIR(), id);
  ensureDir(folder);
  // Drop every previous image.* so one product never keeps stale copies.
  for (const f of fs.readdirSync(folder)) {
    if (/^image\.(jpg|jpeg|png|webp)$/i.test(f)) fs.rmSync(path.join(folder, f), { force: true });
  }
  const target = imageFile(id, `image${ext === '.jpeg' ? '.jpg' : ext}`);
  fs.writeFileSync(target, buffer);
  product.image = `./${path.basename(target)}`;
  writeJson(path.join(folder, 'product.json'), product);
  // The picture changed — the stored WhatsApp image URL is stale now.
  const index = readIndex();
  if (index.products[id]) {
    delete index.products[id].imageRemoteUrl;
    delete index.products[id].imageHash;
    index.products[id].lastStatus = 'pending';
    index.products[id].lastError = null;
    writeIndex(index);
  }
  note(`Image saved for ${id} (${(buffer.length / 1024).toFixed(0)}KB → ${path.basename(target)})`);
  return { ok: true, retailerId: id, bytes: buffer.length, image: product.image };
}

// ── synchronization (spec §8) ────────────────────────────────
/**
 * One product → WhatsApp. Matches on retailerId (create when it is
 * missing on WA, update when the local hash moved).
 */
export async function syncProduct(retailerId, { delayMs = null } = {}) {
  const local = getLocal(retailerId);
  if (!local) return { ok: false, code: 'NOT_FOUND', message: 'no local product', retailerId };
  const index = readIndex();
  const state = index.products[local.retailerId];
  const img = infoFromLocal(local);
  const changed = state?.hash !== localHash(local, img);

  if (!state?.whatsappProductId) {
    const created = await createProduct(local.retailerId);
    if (delayMs) await delay(delayMs);
    return { ...created, action: created.ok ? 'created' : 'failed' };
  }
  if (!changed) return { ok: true, retailerId: local.retailerId, action: 'unchanged' };

  const updated = await updateProduct(local.retailerId, { force: true });
  if (delayMs) await delay(delayMs);
  return { ...updated, action: updated.ok ? 'updated' : 'failed' };
}

// ── live sync progress (dashboard polls while POST /sync runs) ──
function freshProgress() {
  return {
    running: false, ok: null, dryRun: false, code: null,
    total: 0, done: 0,
    created: [], updated: [], unchanged: [], failed: [], orphans: [],
    deferred: false, aborted: false, current: null, last: null,
    startedAt: null, finishedAt: null,
  };
}

// The object below IS the summary of the run in flight: syncCatalog()
// fills it, the dashboard reads it through syncProgress() every tick.
let progress = freshProgress();

/** Snapshot for GET /api/catalog/sync/status (arrays are copied). */
export function syncProgress() {
  return {
    ...progress,
    created: [...progress.created],
    updated: [...progress.updated],
    unchanged: [...progress.unchanged],
    failed: progress.failed.map((f) => ({ ...f })),
    orphans: [...progress.orphans],
    current: progress.current ? { ...progress.current } : null,
    last: progress.last ? { ...progress.last } : null,
  };
}

const startStep = (summary, id, action, onStep) => {
  summary.current = { id, action };
  onStep?.({ phase: 'start', id, action, done: summary.done, total: summary.total });
};

const endStep = (summary, id, action, ok, code, onStep) => {
  summary.done += 1;
  summary.last = { id, action, ok: Boolean(ok), code: code || null, at: new Date().toISOString() };
  onStep?.({ phase: 'end', id, action, ok: Boolean(ok), code: code || null, done: summary.done, total: summary.total });
};

/**
 * Full catalogue sync: read locals → read WA → match on retailerId →
 * create missing → update changed → save ids → log the run.
 *
 * Remote products with a retailerId we do NOT own are reported as
 * `orphans` but never deleted (safety: they may have been created by
 * hand in the WhatsApp Business app).
 *
 * `summary` is the live progress object — every field in it is updated
 * as the run advances, so the dashboard can render it mid-flight.
 *
 * @param {object} summary live progress/summary object
 * @param {{dryRun?:boolean, limit?:number, delayMs?:number, onStep?:Function}} opts
 */
async function runSync(summary, { dryRun = false, limit = 0, delayMs = null, onStep = null }) {
  if (!isReady()) return disconnected(null, 'sync');
  const locals = listLocal();
  summary.total = locals.length;
  const remote = await remoteCatalog();
  if (!remote.ok) return remote;

  const byRetailer = new Map();
  for (const r of remote.products) {
    if (r?.retailerId) byRetailer.set(String(r.retailerId), r);
  }
  const index = readIndex();
  const pace = delayMs ?? SETTINGS.catalogSyncDelayMs;
  const batch = Number(limit) > 0 ? Number(limit) : SETTINGS.catalogSyncBatch;

  summary.ok = true;

  for (const r of remote.products) {
    const rid = r?.retailerId ? String(r.retailerId) : '';
    if (rid && !locals.some((l) => l.retailerId === rid)) summary.orphans.push(rid);
  }

  let mutated = 0;
  /**
   * One failed write. REPLY_MISSING_PRODUCT is SYSTEMIC (WhatsApp acks
   * the IQ but never stores the product — typically: the number is not
   * a WhatsApp Business account with an active catalog), so the FIRST
   * proof aborts the whole run instead of burning 77 × 2min marking
   * every product as failed.
   */
  const failed = (res) => {
    summary.failed.push({ retailerId: res.retailerId, code: res.code, message: res.message });
    if (res.code === 'REPLY_MISSING_PRODUCT' && !summary.aborted) {
      summary.aborted = true;
      summary.ok = false;
      summary.code = 'REPLY_MISSING_PRODUCT';
      fail(`Systemic catalog failure on ${res.retailerId} — aborting the run. `
        + 'WhatsApp acks catalog writes but stores nothing: check that the number is a '
        + 'WhatsApp Business account with an active catalog (WhatsApp Business app → '
        + 'Business tools → Catalog), then sync again.');
      log.warn({ event: 'catalog.sync_aborted', retailerId: res.retailerId }, 'catalog sync aborted early');
    }
  };

  for (const local of locals) {
    const id = local.retailerId;
    const img = infoFromLocal(local);
    const state = index.products[id];
    const onWa = byRetailer.get(id) || null;
    const changed = state?.hash !== localHash(local, img) || Boolean(onWa) !== Boolean(state?.whatsappProductId);

    if (!onWa) {
      if (mutated >= batch) {
        summary.deferred = true;
        endStep(summary, id, 'deferred', true, null, onStep);
        continue;
      }
      if (dryRun) {
        summary.created.push(id);
        endStep(summary, id, 'dry-create', true, null, onStep);
        continue;
      }
      // A stale WhatsApp id (product was removed by hand) must not
      // survive: createProduct() would otherwise route to update.
      if (state?.whatsappProductId) {
        const idx = readIndex();
        delete idx.products[id];
        writeIndex(idx);
      }
      startStep(summary, id, 'create', onStep);
      const res = await createProduct(id, { force: true });
      if (res.ok) { summary.created.push(id); mutated += 1; }
      else failed(res);
      endStep(summary, id, 'create', res.ok, res.code, onStep);
      if (pace) await delay(pace);
      summary.current = null;
      if (summary.aborted) break;
    } else if (changed || state?.whatsappProductId !== onWa.id) {
      if (mutated >= batch) {
        summary.deferred = true;
        endStep(summary, id, 'deferred', true, null, onStep);
        continue;
      }
      if (dryRun) {
        summary.updated.push(id);
        endStep(summary, id, 'dry-update', true, null, onStep);
        continue;
      }
      // The WhatsApp id may have changed (re-created by hand): fix it first.
      if (state?.whatsappProductId !== onWa.id) {
        const idx = readIndex();
        idx.products[id] = { ...(idx.products[id] || {}), whatsappProductId: onWa.id };
        writeIndex(idx);
      }
      startStep(summary, id, 'update', onStep);
      const res = await updateProduct(id, { force: true });
      if (res.ok) { summary.updated.push(id); mutated += 1; }
      else failed(res);
      endStep(summary, id, 'update', res.ok, res.code, onStep);
      if (pace) await delay(pace);
      summary.current = null;
      if (summary.aborted) break;
    } else {
      summary.unchanged.push(id);
      endStep(summary, id, 'unchanged', true, null, onStep);
    }
  }

  const counts = {
    created: summary.created.length, updated: summary.updated.length,
    unchanged: summary.unchanged.length, failed: summary.failed.length,
    orphans: summary.orphans.length,
  };
  note(`Sync ${dryRun ? '(dry run) ' : ''}done: ${counts.created} created · ${counts.updated} updated · ${counts.unchanged} unchanged · ${counts.failed} failed${summary.deferred ? ' · deferred to next run' : ''}${summary.aborted ? ' · ABORTED after a systemic failure' : ''}`);
  log.info({ event: 'catalog.sync', ...counts, dryRun, aborted: Boolean(summary.aborted) }, 'catalog sync finished');
  if (summary.failed.length) {
    fail(`Sync finished with ${summary.failed.length} failure(s): ${summary.failed.slice(0, 3).map((f) => `${f.retailerId}:${f.code}`).join(', ')}`);
  }
  return summary;
}

/**
 * Public entry point. Resets the live progress object, runs the sync
 * and ALWAYS flips `running` to false when it settles (success, error
 * or disconnect), so the status endpoint can never get stuck.
 *
 * @param {{dryRun?:boolean, limit?:number, delayMs?:number, onStep?:Function}} opts
 */
export async function syncCatalog(opts = {}) {
  progress = {
    ...freshProgress(),
    running: true,
    dryRun: Boolean(opts.dryRun),
    startedAt: new Date().toISOString(),
  };
  try {
    const out = await runSync(progress, opts);
    if (out && out !== progress) {
      // Early exit (DISCONNECTED / remote read failed): surface it.
      progress.ok = false;
      progress.code = out.code || 'SYNC_FAILED';
    } else {
      // runSync may have flagged a systemic abort on the summary itself.
      progress.ok = !(progress.code || progress.aborted);
    }
    return out;
  } catch (err) {
    progress.ok = false;
    progress.code = 'SYNC_FAILED';
    logError('catalog.sync', err, {});
    fail(`Sync crashed: ${String(err?.message || err).slice(0, 160)}`);
    return { ok: false, code: 'SYNC_FAILED', message: String(err?.message || err).slice(0, 300), ...progress };
  } finally {
    progress.running = false;
    progress.current = null;
    if (!progress.finishedAt) progress.finishedAt = new Date().toISOString();
  }
}

/** Test/ops helper: drop the socket (simulates a disconnect). */
export function __clearSocket() {
  sock = null;
}

/** Diagnostics: last IQ result/error frame WhatsApp answered with. */
export function __replySpy() {
  return { seq: replySpy.seq, last: replySpy.last ? { ...replySpy.last } : null };
}

/** Test helper: fake an in-flight sync (drives the 409 guard). */
export function __forceSyncRunning(on) {
  progress = { ...progress, running: Boolean(on) };
}
