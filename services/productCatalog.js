// ─────────────────────────────────────────────────────────────
// services/productCatalog.js
// The Digital Store's DUAL-SUPPLIER layer (ProdSeller + Eklas).
//
// Nothing above this module has to know there are two suppliers:
// handlers keep calling getProducts()/getProduct()/createOrder()
// with the same shape they used when there was only one.
//
// What it does:
//   • loads data/productSupplierMap.json — the ONE hand-maintained
//     canonical id → { prodseller id, eklas id } mapping for every
//     product that is sold by BOTH suppliers. Never fuzzy-matched for
//     routing: an explicit map entry always wins.
//   • merges both catalogues into ONE raw list keyed by canonical id.
//     Eklas products are listed too — one that carries the same name
//     as a product already on the shelf is LINKED as that row's
//     alternate instead of being shown twice, a unique one gets its
//     own row under `eklas:<sku>`.
//   • for every product it picks the CHEAPEST supplier that is in
//     stock, cached for PRODUCT_COMPARE_CACHE_SECONDS
//   • checkout goes to that supplier and falls back to the other one
//     ONLY on failures where no supplier order can have been created
//     (out of stock / not found / low balance / auth / not
//     configured / rate limited). Ambiguous failures (network,
//     upstream 5xx) are never retried on the second supplier — that
//     is how a double purchase gets avoided.
//   • `locked` entries never leave their supplier at all
//
// Failure policy: every function NEVER throws — it returns
// { ok, … , code, customerMessage, alert }.
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs';
import { PATHS, SETTINGS } from '../config.js';
import * as prodseller from './prodseller.js';
import * as eklas from './eklas.js';
import { prettifyDigitalName } from '../lib/digital.js';
import { log } from '../lib/logger.js';

const SUPPLIERS = { prodseller, eklas };
export const SUPPLIER_IDS = ['prodseller', 'eklas'];

/** Human name for a supplier id (admin cards, dashboard, logs). */
export function supplierLabel(id) {
  return id === 'eklas' ? 'Eklas' : 'ProdSeller';
}

export const isConfigured = () => prodseller.isConfigured() || eklas.isConfigured();

/** Suppliers that actually have a key right now, cheapest-candidate order preserved. */
export function configuredSuppliers() {
  return SUPPLIER_IDS.filter((id) => SUPPLIERS[id].isConfigured());
}

// ── 1. Supplier map (data/productSupplierMap.json) ────────────
/** Namespace for Eklas products that have no map entry of their own. */
export const EKLAS_ID_PREFIX = 'eklas:';

/**
 * Display-level duplicate key: what the shopper sees is the POLISHED
 * name, so that is what decides "same product" — `Capcut Pro 7D FW`
 * and `Capcut Pro 7 Days (FW)` both polish to `CapCut Pro · 7 Days`
 * and must land on ONE shelf row (the cheaper supplier still wins).
 */
function normName(name) {
  return String(prettifyDigitalName(name) || name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

let mapCache = { mtimeMs: -1, doc: null };

function emptyMap() {
  return { default: 'prodseller', products: {}, locked: [] };
}

export function loadSupplierMap({ force = false } = {}) {
  let mtimeMs = -1;
  try {
    mtimeMs = fs.statSync(PATHS.productSupplierMap).mtimeMs;
  } catch {
    mtimeMs = -1;
  }
  if (!force && mapCache.doc && mapCache.mtimeMs === mtimeMs) return mapCache.doc;

  let doc = emptyMap();
  if (mtimeMs >= 0) {
    try {
      const parsed = JSON.parse(fs.readFileSync(PATHS.productSupplierMap, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        const products = parsed.products && typeof parsed.products === 'object' && !Array.isArray(parsed.products)
          ? parsed.products
          : (Array.isArray(parsed.entries)
            ? Object.fromEntries(parsed.entries.map((e) => [String(e.id ?? e.productId), e]))
            : {});
        doc = {
          default: parsed.default === 'eklas' ? 'eklas' : 'prodseller',
          products: Object.fromEntries(
            Object.entries(products).map(([k, v]) => [String(k), normalizeEntry(k, v)]),
          ),
          locked: Array.isArray(parsed.locked) ? parsed.locked.map(String) : [],
        };
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[catalog] Could not read ${PATHS.productSupplierMap}: ${err.message}`);
      }
      doc = emptyMap();
    }
  }
  mapCache = { mtimeMs, doc };
  return doc;
}

function normalizeEntry(key, value) {
  const raw = value && typeof value === 'object' ? value : {};
  const prodsellerId = raw.prodseller ?? raw.prodsellerId ?? null;
  const eklasId = raw.eklas ?? raw.eklasId ?? null;
  return {
    id: String(key),
    prodseller: prodsellerId === null || prodsellerId === undefined || prodsellerId === '' ? null : String(prodsellerId),
    eklas: eklasId === null || eklasId === undefined || eklasId === '' ? null : String(eklasId),
    locked: raw.locked === true,
  };
}

/**
 * Routing for ONE canonical product id.
 * An unmapped product keeps its historical behaviour: Prodseller-only.
 * `eklas:<sku>` ids are Eklas-only rows (no map entry needed).
 */
export function entryFor(canonicalId) {
  const id = String(canonicalId);
  const doc = loadSupplierMap();
  const entry = doc.products[id];
  if (entry) return { ...entry, locked: entry.locked || doc.locked.includes(id) };
  if (id.startsWith(EKLAS_ID_PREFIX)) {
    return { id, prodseller: null, eklas: id.slice(EKLAS_ID_PREFIX.length), locked: doc.locked.includes(id) };
  }
  return { id, prodseller: id, eklas: null, locked: doc.locked.includes(id) };
}

/** Reverse lookup: which canonical id owns this supplier's product id? */
function canonicalIdFor(supplierId, supplierProductId) {
  const doc = loadSupplierMap();
  for (const [key, entry] of Object.entries(doc.products)) {
    if (entry[supplierId] === String(supplierProductId)) return key;
  }
  return String(supplierProductId);
}

// ── 2. Catalogue: both suppliers → one raw list ───────────────
let catalogueCache = { at: 0, value: null };

const catalogueTtlMs = () => Math.max(1, SETTINGS.productCompareCacheSeconds) * 1000;

function inStock(raw) {
  return Boolean(raw) && raw.inStock !== false && !(Number.isFinite(raw.stock) && raw.stock <= 0);
}

/**
 * Both catalogues side by side, merged on the canonical id.
 * @returns {Promise<{ok, products, stale, configured, balances, failures}>}
 *   every product carries: supplier, supplierProductId, alternate, balanceUsd
 */
export async function getCatalogue({ force = false } = {}) {
  if (!force && catalogueCache.value && Date.now() - catalogueCache.at < catalogueTtlMs()) {
    return { ...catalogueCache.value, cached: true };
  }

  const [psRes, ekRes, balances] = await Promise.all([
    prodseller.getProducts({ force }),
    eklas.getProducts({ force }),
    getBalances({ force }),
  ]);
  psBalance = balances.prodseller.balance;
  ekBalance = balances.eklas.balance;

  const ekById = new Map((ekRes.products || []).map((p) => [p.id, p]));
  const products = [];
  const stale = Boolean(psRes.stale || ekRes.stale);
  const failures = [];
  if (prodseller.isConfigured() && !psRes.ok) failures.push({ supplier: 'prodseller', code: psRes.code });
  if (eklas.isConfigured() && !ekRes.ok) failures.push({ supplier: 'eklas', code: ekRes.code });

  // Eklas SKUs already spoken for (map entry, or linked as an alternate).
  const claimedEklas = new Set();

  // ProdSeller side: every product is listed (its id stays the canonical id
  // unless the map gives it another one).
  for (const p of psRes.products || []) {
    const entry = entryFor(p.id);
    const canonical = entry.prodseller === null || entry.prodseller === p.id
      ? entry.id
      : canonicalIdFor('prodseller', p.id);
    const alternate = entry.eklas ? ekById.get(entry.eklas) || null : null;
    if (alternate) claimedEklas.add(alternate.id);
    products.push({
      ...p,
      id: canonical,
      supplier: 'prodseller',
      supplierProductId: p.id,
      alternate: alternate ? { supplier: 'eklas', product: alternate } : null,
      locked: entry.locked,
      balanceUsd: psBalance,
    });
  }

  // Map entries with `prodseller: null` — an Eklas-only shelf item under
  // its own canonical id.
  for (const [key, entry] of Object.entries(loadSupplierMap().products)) {
    if (!entry.eklas || entry.prodseller) continue;
    if (claimedEklas.has(entry.eklas)) continue;
    const e = ekById.get(entry.eklas);
    if (!e) continue;
    claimedEklas.add(entry.eklas);
    products.push({
      ...e,
      id: key,
      supplier: 'eklas',
      supplierProductId: entry.eklas,
      alternate: null,
      locked: entry.locked,
      balanceUsd: ekBalance,
    });
  }

  // Every OTHER Eklas product is listed as well — that is the whole point
  // of running two suppliers. Duplicates are removed one level up: an Eklas
  // item with the same name as a product already on the shelf becomes that
  // row's `alternate` (so compare + fallback still work) instead of a
  // second row; a product Eklas lists twice under one name is dropped.
  const shelfByName = new Map();
  for (const p of products) {
    if (p.supplier !== 'prodseller') continue;
    const key = normName(p.name);
    if (key && !shelfByName.has(key)) shelfByName.set(key, p);
  }
  const seenEklasNames = new Set();
  for (const e of ekRes.products || []) {
    if (claimedEklas.has(e.id)) continue;
    const key = normName(e.name);
    const twin = key ? shelfByName.get(key) : null;
    if (twin) {
      claimedEklas.add(e.id);
      if (!twin.alternate) twin.alternate = { supplier: 'eklas', product: e, auto: true };
      continue;
    }
    if (key) {
      if (seenEklasNames.has(key)) continue;
      seenEklasNames.add(key);
    }
    claimedEklas.add(e.id);
    const canonical = `${EKLAS_ID_PREFIX}${e.id}`;
    products.push({
      ...e,
      id: canonical,
      supplier: 'eklas',
      supplierProductId: e.id,
      alternate: null,
      locked: entryFor(canonical).locked,
      balanceUsd: ekBalance,
    });
  }

  // Compare: pick the cheapest supplier that can actually deliver.
  const compared = products.map((p) => {
    const chosen = chooseCheapest(p);
    return { ...chosen, balanceUsd: chosen.supplier === 'eklas' ? ekBalance : psBalance };
  });

  const value = {
    ok: psRes.ok || ekRes.ok,
    products: compared,
    stale,
    configured: isConfigured(),
    failures,
    balances: { prodseller: psBalance, eklas: ekBalance },
  };

  if (value.products.length > 0) catalogueCache = { at: Date.now(), value };
  else if (catalogueCache.value) return { ...catalogueCache.value, stale: true, cached: true };

  return value;
}

let psBalance = null;
let ekBalance = null;

/**
 * Cheapest in-stock supplier for one raw product.
 * Ties go to the primary supplier; a fully out-of-stock product keeps
 * its primary supplier so the shelf still reads honestly.
 */
function chooseCheapest(product) {
  const primary = {
    supplier: product.supplier,
    supplierProductId: product.supplierProductId,
    price: Number(product.price),
    product,
  };
  const alt = product.alternate
    ? {
        supplier: product.alternate.supplier,
        supplierProductId: product.alternate.product.id,
        price: Number(product.alternate.product.price),
        product: product.alternate.product,
      }
    : null;

  if (!alt || product.locked) {
    return { ...product, chosen: primary, other: alt };
  }

  const primaryOk = inStock(primary.product) && Number.isFinite(primary.price);
  const altOk = inStock(alt.product) && Number.isFinite(alt.price);

  let winner = primary;
  if (altOk && (!primaryOk || alt.price < primary.price)) winner = alt;
  if (primaryOk && altOk && alt.price === primary.price) winner = primary;

  return {
    ...product,
    supplier: winner.supplier,
    supplierProductId: winner.supplierProductId,
    price: winner.price,
    primary,
    chosen: winner,
    other: winner === primary ? alt : primary,
    alternate: winner === primary ? product.alternate : null,
  };
}

/**
 * Merged catalogue in the exact shape handlers already consume.
 * Each product additionally carries `supplier` + `supplierProductId`
 * so checkout knows where to buy it.
 */
export async function getProducts({ force = false } = {}) {
  const cat = await getCatalogue({ force });
  return {
    ok: cat.ok,
    products: cat.products,
    stale: cat.stale,
    configured: cat.configured,
    failures: cat.failures,
    balances: cat.balances,
    cached: Boolean(cat.cached),
  };
}

/** Live stock/price for ONE canonical product id. */
export async function getProduct(canonicalId, { force = true } = {}) {
  const cat = await getCatalogue({ force });
  const merged = cat.products.find((p) => p.id === String(canonicalId));
  if (!merged) {
    return { ok: false, code: 'NOT_FOUND', product: null, customerMessage: prodseller.errorInfo(404).customerMessage };
  }

  // Re-check the CHOSEN supplier live so we never spend money on a
  // stale quote.
  const live = await SUPPLIERS[merged.supplier].getProduct(merged.supplierProductId);
  if (live.ok) {
    const patched = { ...merged, ...live.product, alternate: merged.alternate };
    return { ok: true, product: chooseCheapest(patched), supplier: merged.supplier };
  }
  if (live.code === 'OUT_OF_STOCK' || live.code === 'NOT_FOUND') {
    const swapped = trySwapAfterLiveFailure(merged, live.code);
    if (swapped) return { ok: true, product: swapped, supplier: swapped.supplier, swapped: true };
  }
  // Live check failed for an ambiguous reason — the cached view is
  // still good enough to show, checkout re-verifies anyway.
  return { ok: true, product: merged, supplier: merged.supplier, degraded: live.code };
}

function trySwapAfterLiveFailure(merged, code) {
  if (!merged.other || merged.locked) return null;
  const other = merged.other;
  if (!inStock(other.product)) return null;
  const switched = {
    ...merged,
    supplier: other.supplier,
    supplierProductId: other.supplierProductId,
    price: other.price,
    primary: merged.chosen,
    chosen: other,
    other: merged.chosen,
    alternate: null,
    swappedFrom: merged.supplier,
  };
  log.info({ event: 'catalog.swap', productId: merged.id, from: merged.supplier, to: other.supplier, code }, 'supplier swap after live failure');
  return switched;
}

/** Supplier balances (null when that supplier is not configured). */
export async function getBalances({ force = false } = {}) {
  const [ps, ek] = await Promise.all([
    prodseller.isConfigured() ? prodseller.getBalance({ force }) : Promise.resolve({ ok: false, code: 'NOT_CONFIGURED' }),
    eklas.isConfigured() ? eklas.getBalance({ force }) : Promise.resolve({ ok: false, code: 'NOT_CONFIGURED' }),
  ]);
  psBalance = ps.ok ? ps.balance : null;
  ekBalance = ek.ok ? ek.balance : null;
  return {
    prodseller: { configured: prodseller.isConfigured(), ok: ps.ok, balance: ps.ok ? ps.balance : null, code: ps.code },
    eklas: { configured: eklas.isConfigured(), ok: ek.ok, balance: ek.ok ? ek.balance : null, code: ek.code },
  };
}

/** Backwards-compatible single balance: the configured supplier that funds the shelf. */
export async function getBalance({ force = false } = {}) {
  const all = await getBalances({ force });
  if (all.prodseller.ok) return { ok: true, balance: all.prodseller.balance, currency: 'USD', source: 'prodseller' };
  if (all.eklas.ok) return { ok: true, balance: all.eklas.balance, currency: 'USD', source: 'eklas' };
  return { ok: false, code: 'NOT_CONFIGURED' };
}

/** Public price comparison for ONE product (admin panel / dashboard). */
export async function compareProduct(canonicalId) {
  const cat = await getCatalogue({ force: true });
  const product = cat.products.find((p) => p.id === String(canonicalId));
  if (!product) return { ok: false, code: 'NOT_FOUND' };
  const view = product.chosen ? product : chooseCheapest(product);
  const chosen = view.chosen;
  const other = view.other;
  return {
    ok: true,
    productId: view.id,
    supplier: view.supplier,
    priceUsd: Number.isFinite(chosen.price) ? chosen.price : null,
    other: other
      ? {
          supplier: other.supplier,
          priceUsd: Number.isFinite(other.price) ? other.price : null,
          inStock: inStock(other.product),
        }
      : null,
    savingUsd: other && Number.isFinite(chosen.price) && Number.isFinite(other.price)
      ? Math.max(0, other.price - chosen.price)
      : 0,
    locked: Boolean(view.locked),
  };
}

// ── 3. Checkout (with the safe fallback) ──────────────────────
/**
 * Failures where the supplier CANNOT have created an order — only
 * these may be retried on the other supplier. Anything else (network
 * timeout, 5xx) is ambiguous: the order might already exist there,
 * so we surface it instead of risking a double purchase.
 */
const SAFE_TO_FALLBACK = new Set([
  'OUT_OF_STOCK',
  'NOT_FOUND',
  'INSUFFICIENT_BALANCE',
  'AUTH',
  'NOT_CONFIGURED',
  'RATE_LIMITED',
]);

function failureOrder(merged) {
  const list = [];
  if (merged.chosen) list.push(merged.chosen);
  if (merged.other && !merged.locked) list.push(merged.other);
  if (merged.primary && !list.includes(merged.primary)) list.push(merged.primary);
  return list.filter((c) => c && SUPPLIERS[c.supplier].isConfigured());
}

/**
 * Buy a product on the chosen supplier, falling back to the other one
 * when (and only when) the first failure proves no order was created.
 *
 * @param {{productId:string, quantity?:number, email?:string,
 *          emails?:string[], idempotencyKey:string, clientOrderId?:string,
 *          allowFallback?:boolean}} input
 * @returns {Promise<{ok:boolean, order?:object, supplier?:string,
 *                    code?:string, customerMessage?:string, alert?:boolean,
 *                    tried?:string[]}>}
 */
export async function createOrder(input = {}) {
  const { productId, quantity = 1, email, emails, idempotencyKey, clientOrderId, allowFallback = true } = input;
  if (!isConfigured()) {
    return { ok: false, code: 'NOT_CONFIGURED', customerMessage: prodseller.errorInfo(401).customerMessage, alert: true };
  }
  if (!productId) return { ok: false, code: 'BAD_REQUEST', customerMessage: prodseller.errorInfo(400).customerMessage, alert: false };
  if (!idempotencyKey && !clientOrderId) {
    return { ok: false, code: 'BAD_REQUEST', customerMessage: prodseller.errorInfo(400).customerMessage, alert: false };
  }

  const cat = await getCatalogue({ force: false });
  const merged = cat.products.find((p) => p.id === String(productId));

  const candidates = merged
    ? failureOrder(merged)
    : configuredSuppliers().map((s) => ({ supplier: s, supplierProductId: String(productId), price: NaN }));

  const entry = entryFor(productId);
  const allow = allowFallback && !entry.locked;

  const tried = [];
  let firstFailure = null;

  for (const candidate of candidates) {
    if (!candidate.supplierProductId) continue;
    tried.push(candidate.supplier);
    const res = await buy(candidate, { quantity, email, emails, idempotencyKey, clientOrderId });
    if (res.ok) {
      if (tried.length > 1) {
        log.info({ event: 'catalog.fallback', productId, supplier: candidate.supplier, tried }, 'purchased on the fallback supplier');
      }
      return { ...res, supplier: candidate.supplier, supplierProductId: candidate.supplierProductId, tried };
    }
    const failure = { ...res, supplier: candidate.supplier, tried: tried.slice() };
    if (!allow || !SAFE_TO_FALLBACK.has(res.code)) return failure;
    firstFailure = firstFailure || failure;
  }

  return firstFailure || { ok: false, code: 'NOT_CONFIGURED', customerMessage: prodseller.errorInfo(401).customerMessage, alert: true, tried };
}

async function buy(candidate, opts) {
  const mod = SUPPLIERS[candidate.supplier];
  if (!mod.isConfigured()) {
    return { ok: false, code: 'NOT_CONFIGURED', customerMessage: prodseller.errorInfo(401).customerMessage, alert: true };
  }
  if (candidate.supplier === 'eklas') {
    return mod.createOrder({
      productId: candidate.supplierProductId,
      quantity: opts.quantity,
      email: opts.email,
      emails: opts.emails,
      clientOrderId: opts.clientOrderId || opts.idempotencyKey,
    });
  }
  return mod.createOrder({
    productId: candidate.supplierProductId,
    quantity: opts.quantity,
    email: opts.email,
    emails: opts.emails,
    idempotencyKey: opts.idempotencyKey,
  });
}

/** Stable idempotency token for one Simfly checkout attempt (both suppliers). */
export function idempotencyKeyFor(orderId) {
  return prodseller.idempotencyKeyFor(orderId);
}

/**
 * Poll status for an order on the supplier it was actually placed on.
 * @param {string} supplierOrderId
 * @param {string} [supplier] 'prodseller' | 'eklas' — defaults to prodseller
 *                            so legacy orders keep working.
 */
export async function getOrderStatus(supplierOrderId, supplier = 'prodseller') {
  const mod = SUPPLIERS[supplier] || prodseller;
  if (!mod.isConfigured()) return { ok: false, code: 'NOT_CONFIGURED', supplier };
  const res = await mod.getOrderStatus(supplierOrderId);
  return { ...res, supplier: mod === eklas ? 'eklas' : 'prodseller' };
}

/** Test helper — drop the compare + map caches. */
export function __clearCache() {
  catalogueCache = { at: 0, value: null };
  mapCache = { mtimeMs: -1, doc: null };
  psBalance = null;
  ekBalance = null;
}
