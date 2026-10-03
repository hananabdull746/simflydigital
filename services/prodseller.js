// ─────────────────────────────────────────────────────────────
// services/prodseller.js
// Isolated wrapper around the ProdSeller Public API v1
// (https://prodseller.com/v1 — docs: prodseller.com/api-docs).
//
// This is the SECOND supplier of the bot (eSIMaccess is the first).
// Handlers never touch axios or the ProdSeller URLs directly —
// everything goes through this module so:
//
//   • the API key only ever leaves the process inside the
//     X-API-Key header, pointed at prodseller.com
//   • every documented error code (400/401/402/404/409/429/500)
//     is translated to a friendly customer message — a raw API
//     error can NEVER reach a chat
//   • 401 / 402 / 500 additionally flag an admin alert
//   • 429 backs off using the X-RateLimit-* headers (one retry
//     only, never a hammer-loop)
//   • the product catalogue is cached for PRODSELLER_CACHE_SECONDS
//     and falls back to the last-known-good snapshot, so a supplier
//     outage can never render the store completely blank
//
// Failure policy: every function NEVER throws — it returns
// { ok, … , code, customerMessage, alert }.
// ─────────────────────────────────────────────────────────────
import axios from 'axios';
import { PRODSELLER, SETTINGS } from '../config.js';
import { log } from '../lib/logger.js';

const ENDPOINTS = {
  products: '/products',
  product: (id) => `/products/${encodeURIComponent(id)}`,
  balance: '/balance',
  orders: '/orders',
  order: (id) => `/orders/${encodeURIComponent(id)}`,
};

/** True when a ProdSeller API key is present in .env. */
export const isConfigured = () => PRODSELLER.isConfigured;

// ── Error catalogue (documented codes only) ───────────────────
// customerMessage = what a shopper may read; alert = page an owner.
const ERRORS = {
  400: {
    code: 'BAD_REQUEST',
    customerMessage: '❌ Is order ki detail theek nahi lag rahi — wapas ja kar dobara try karein.',
    alert: false,
  },
  401: {
    code: 'AUTH',
    customerMessage: '⚠️ Digital Store abhi temporarily unavailable hai — thori der baad dobara check karein ya *support* likhein.',
    alert: true,
  },
  402: {
    code: 'INSUFFICIENT_BALANCE',
    customerMessage: '⏳ Aapka order process ho raha hai — thanks for your patience, hum jald message karenge.',
    alert: true,
  },
  404: {
    code: 'NOT_FOUND',
    customerMessage: '❌ Yeh product abhi available nahi — doosra product dekhein.',
    alert: false,
  },
  409: {
    code: 'OUT_OF_STOCK',
    customerMessage: '❌ Yeh item abhi out of stock aa gaya hai — maazrat.',
    alert: false,
  },
  429: {
    code: 'RATE_LIMITED',
    customerMessage: '⏳ Bohat zyada load hai — 1 minute me dobara try karein.',
    alert: false,
  },
  500: {
    code: 'UPSTREAM',
    customerMessage: '⏳ Aapka order safe hai — supplier ki taraf se thori der me ready ho jayega.',
    alert: true,
  },
  502: {
    code: 'UPSTREAM',
    customerMessage: '⏳ Aapka order safe hai — supplier ki taraf se thori der me ready ho jayega.',
    alert: true,
  },
  503: {
    code: 'UPSTREAM',
    customerMessage: '⏳ Aapka order safe hai — supplier ki taraf se thori der me ready ho jayega.',
    alert: true,
  },
};

const GENERIC = {
  code: 'UNAVAILABLE',
  customerMessage: '⚠️ Digital Store abhi temporarily unavailable hai — *support* likhein toh hum dekh lete hain.',
  alert: false,
};

/** Friendly, non-technical text for an HTTP status (never throws). */
export function errorInfo(status, serverMessage = '') {
  const known = ERRORS[status] || GENERIC;
  return { ...known, status: Number.isFinite(status) ? status : null, serverMessage: String(serverMessage || '').slice(0, 200) };
}

// ── Transport (injectable for tests) ──────────────────────────
let transport = async (config) => axios(config);
/** Test hook: replace the HTTP transport. Pass null to restore. */
export function __setTransport(fn) {
  transport = fn || ((config) => axios(config));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Backoff for a 429, honouring X-RateLimit-* / Retry-After. */
function rateLimitDelay(headers = {}) {
  const get = (name) => {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
    return key ? headers[key] : undefined;
  };
  const reset = Number(get('x-ratelimit-reset'));
  const retryAfter = Number(get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 30_000);
  if (Number.isFinite(reset) && reset > 0) {
    // Seconds- or milliseconds-epoch — both are common.
    const ms = reset > 1e12 ? reset : reset * 1000;
    const delta = ms - Date.now();
    if (delta > 0) return Math.min(delta, 30_000);
  }
  const remaining = Number(get('x-ratelimit-remaining'));
  if (Number.isFinite(remaining) && remaining > 0) return 1_000;
  return 2_000; // fixed short delay when the headers are absent
}

/**
 * Fire one ProdSeller request.
 *   • 429 → back off, retry ONCE
 *   • 5xx → transient, retry ONCE after a short pause
 * Never throws; never returns a raw error to the caller.
 */
async function request(method, path, { body, idempotencyKey, retry = true } = {}) {
  const url = `${PRODSELLER.baseUrl}${path}`;
  const headers = {
    'X-API-Key': PRODSELLER.apiKey,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  // Max 100 chars per the docs — a stable key per checkout attempt
  // means a retry can never double-charge the wallet.
  if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey).slice(0, 100);

  const startedAt = Date.now();
  try {
    const res = await transport({
      method,
      url,
      data: body,
      headers,
      timeout: PRODSELLER.timeoutMs,
      validateStatus: () => true, // we translate every status ourselves
    });
    const status = res.status;
    const ms = Date.now() - startedAt;

    if (status >= 200 && status < 300) {
      log.info({ event: 'prodseller', method, path, status, ms }, 'prodseller call');
      return { ok: true, data: res.data ?? {}, status };
    }

    const serverMessage = res.data?.error ?? res.data?.message ?? '';
    if (status === 429 && retry) {
      const delay = rateLimitDelay(res.headers);
      log.warn({ event: 'prodseller', method, path, status, ms, delay }, 'rate limited — backing off once');
      await sleep(delay);
      return request(method, path, { body, idempotencyKey, retry: false });
    }
    if (status >= 500 && retry) {
      await sleep(1_000);
      return request(method, path, { body, idempotencyKey, retry: false });
    }

    const info = errorInfo(status, serverMessage);
    log.warn({ event: 'prodseller', method, path, status, ms, code: info.code }, 'prodseller call failed');
    return { ok: false, status, code: info.code, error: info.serverMessage || `HTTP ${status}`, ...info };
  } catch (err) {
    const ms = Date.now() - startedAt;
    if (retry) {
      await sleep(1_000);
      return request(method, path, { body, idempotencyKey, retry: false });
    }
    log.warn({ event: 'prodseller', method, path, ms, error: err.message }, 'prodseller transport error');
    const info = errorInfo(null, err.message);
    return {
      ok: false,
      status: null,
      code: 'NETWORK',
      error: err.message,
      customerMessage: info.customerMessage,
      alert: false,
      serverMessage: '',
    };
  }
}

// ── 1. Catalogue (cached + last-known-good fallback) ──────────
let productCache = { at: 0, products: null };
let lastGood = { at: 0, products: null };

const cacheTtlMs = () => Math.max(1, SETTINGS.productCacheSeconds) * 1000;

function normalizeProduct(p) {
  if (!p || typeof p !== 'object') return null;
  return {
    id: String(p.id ?? p._id ?? ''),
    name: String(p.name ?? p.title ?? 'Untitled'),
    description: String(p.description ?? ''),
    price: Number(p.price),                    // what WE are charged (USD)
    publicPrice: p.publicPrice === undefined ? null : Number(p.publicPrice),
    imageUrl: p.imageUrl || null,
    delivery: p.delivery && typeof p.delivery === 'object' ? p.delivery : { type: 'instant' },
    sold: Number.isFinite(Number(p.sold)) ? Number(p.sold) : null,
    stock: p.stock === undefined ? null : (p.stock === null ? null : Number(p.stock)),
    inStock: p.inStock !== undefined ? p.inStock !== false : true,
    requiresEmailActivation: Boolean(p.requiresEmailActivation),
  };
}

/**
 * All active products. Cached for PRODSELLER_CACHE_SECONDS; on an
 * API failure the last-known-good snapshot is returned (flagged
 * `stale`) so the store never goes fully blank.
 *
 * @returns {Promise<{ok:boolean, products:Array, stale:boolean,
 *                    code?:string, customerMessage?:string, alert?:boolean}>}
 */
export async function getProducts({ force = false } = {}) {
  if (!isConfigured()) {
    return { ok: false, products: lastGood.products || [], stale: true, code: 'NOT_CONFIGURED', configured: false };
  }
  if (!force && productCache.products && Date.now() - productCache.at < cacheTtlMs()) {
    return { ok: true, products: productCache.products, stale: false, cached: true };
  }

  const res = await request('get', ENDPOINTS.products);
  if (res.ok) {
    const list = Array.isArray(res.data?.products)
      ? res.data.products
      : Array.isArray(res.data)
        ? res.data
        : Array.isArray(res.data?.data)
          ? res.data.data
          : [];
    const products = list.map(normalizeProduct).filter((p) => p && p.id);
    if (products.length > 0) {
      productCache = { at: Date.now(), products };
      lastGood = { at: Date.now(), products };
      return { ok: true, products, stale: false };
    }
  }

  // API failed / empty -> last-known-good keeps the shelves stocked.
  if (lastGood.products) {
    const info = res.ok ? errorInfo(500, 'empty catalogue') : res;
    return {
      ok: true,
      products: lastGood.products,
      stale: true,
      staleAgeMs: Date.now() - lastGood.at,
      code: info.code,
      customerMessage: info.customerMessage,
      alert: info.alert,
    };
  }

  const info = res.ok ? errorInfo(500, 'empty catalogue') : res;
  return { ok: false, products: [], stale: false, ...info };
}

/** Live stock/price for ONE product — always hits the API (no cache). */
export async function getProduct(id) {
  if (!isConfigured()) return { ok: false, code: 'NOT_CONFIGURED', products: null };
  const res = await request('get', ENDPOINTS.product(id));
  if (!res.ok) return { ok: false, ...res };
  const product = normalizeProduct(res.data?.data || res.data);
  if (!product || !product.id) return { ok: false, code: 'BAD_RESPONSE', error: 'unparseable product payload' };
  return { ok: true, product };
}

// ── 2. Balance (USDT) ─────────────────────────────────────────
let balanceCache = { at: 0, value: null };

/**
 * The ProdSeller wallet — SEPARATE from the eSIMaccess wallet.
 * Cached for PRODSELLER_CACHE_SECONDS (same TTL as the catalogue)
 * so a browse storm doesn't burn the 300-requests/15-min quota.
 * @param {{force?:boolean}} opts
 * @returns {Promise<{ok:boolean, balance?:number, membership?:string, code?:string}>}
 */
export async function getBalance({ force = false } = {}) {
  if (!isConfigured()) return { ok: false, code: 'NOT_CONFIGURED' };
  if (!force && balanceCache.value && Date.now() - balanceCache.at < cacheTtlMs()) {
    return { ok: true, ...balanceCache.value, cached: true };
  }
  const res = await request('get', ENDPOINTS.balance);
  if (!res.ok) return { ok: false, ...res };
  const data = res.data?.data || res.data || {};
  const balance = Number(data.balance);
  if (!Number.isFinite(balance)) return { ok: false, code: 'UNPARSEABLE', error: 'balance missing in response' };
  const payload = { balance, currency: 'USD', membership: data.membership || null, username: data.username || null };
  balanceCache = { at: Date.now(), value: payload };
  return { ok: true, ...payload };
}

// ── 3. Create order ───────────────────────────────────────────
/**
 * Stable Idempotency-Key for one Simfly checkout attempt.
 * Retrying the SAME order id therefore returns the first order and
 * can never charge the ProdSeller wallet twice.
 * (Docs: max 100 characters.)
 */
export function idempotencyKeyFor(orderId) {
  const raw = String(orderId || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  return `simfly_${raw}`.slice(0, 100);
}

/**
 * Buy a product (deducts from the USDT balance).
 * @param {{productId:string, quantity?:number, email?:string,
 *          emails?:string[], idempotencyKey:string}} input
 * @returns {Promise<{ok:boolean, order?:object, code?:string,
 *                    customerMessage?:string, alert?:boolean}>}
 */
export async function createOrder(input = {}) {
  const { productId, quantity = 1, email, emails, idempotencyKey } = input;
  if (!isConfigured()) {
    return { ok: false, code: 'NOT_CONFIGURED', customerMessage: errorInfo(401).customerMessage, alert: true };
  }
  if (!productId) return { ok: false, code: 'BAD_REQUEST', customerMessage: errorInfo(400).customerMessage, alert: false };
  if (!idempotencyKey) {
    return { ok: false, code: 'BAD_REQUEST', customerMessage: errorInfo(400).customerMessage, alert: false };
  }

  const body = { productId, quantity: Number(quantity) || 1 };
  if (Array.isArray(emails) && emails.length) body.emails = emails;
  else if (email) body.email = String(email).trim();

  const res = await request('post', ENDPOINTS.orders, { body, idempotencyKey });
  if (!res.ok) return { ok: false, ...res };

  const data = res.data?.data || res.data || {};
  if (data.error && !data.orderId) {
    return { ok: false, code: 'BAD_REQUEST', error: String(data.error).slice(0, 200), ...errorInfo(400, data.error) };
  }
  return { ok: true, order: normalizeOrder(data) };
}

function normalizeOrder(data = {}) {
  return {
    orderId: String(data.orderId ?? data.id ?? ''),
    status: String(data.status ?? '').toLowerCase(),
    product: data.product || null,
    quantity: Number(data.quantity) || 1,
    amount: Number.isFinite(Number(data.amount)) ? Number(data.amount) : null,
    deliveredKey: data.deliveredKey ?? null,
    deliveredKeys: Array.isArray(data.deliveredKeys) ? data.deliveredKeys : null,
    activation: data.activation || null,
    createdAt: data.createdAt || null,
  };
}

// ── 4. Poll an order (email-activation products) ──────────────
/**
 * @returns {Promise<{ok:boolean, status?:string, order?:object, code?:string}>}
 *   status: pending | paid | delivered | failed
 */
export async function getOrderStatus(orderId) {
  if (!isConfigured()) return { ok: false, code: 'NOT_CONFIGURED' };
  if (!orderId) return { ok: false, code: 'BAD_REQUEST', customerMessage: errorInfo(400).customerMessage };
  const res = await request('get', ENDPOINTS.order(orderId));
  if (!res.ok) return { ok: false, ...res };
  const order = normalizeOrder(res.data?.data || res.data);
  return { ok: true, status: order.status, order };
}

// ── 5. Order history (admin reconciliation) ───────────────────
export async function listOrders({ page = 1, limit = 50, status = '' } = {}) {
  if (!isConfigured()) return { ok: false, code: 'NOT_CONFIGURED', orders: [] };
  const query = new URLSearchParams({ page: String(page), limit: String(Math.min(200, Math.max(1, Number(limit) || 50))) });
  if (status) query.set('status', String(status));
  const res = await request('get', `${ENDPOINTS.orders}?${query.toString()}`);
  if (!res.ok) return { ok: false, ...res, orders: [] };
  const list = Array.isArray(res.data?.orders) ? res.data.orders : Array.isArray(res.data?.data) ? res.data.data : [];
  return {
    ok: true,
    orders: list.map(normalizeOrder),
    pagination: res.data?.pagination || null,
  };
}

/** Test helper — drop the catalogue + balance caches. */
export function __clearCache() {
  productCache = { at: 0, products: null };
  lastGood = { at: 0, products: null };
  balanceCache = { at: 0, value: null };
}

/** Test helper — seed the last-known-good snapshot. */
export function __seedLastGood(products) {
  lastGood = { at: Date.now(), products };
}
