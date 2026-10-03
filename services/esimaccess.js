// ─────────────────────────────────────────────────────────────
// services/esimaccess.js
// Isolated wrapper around the eSIMaccess.com supplier API.
//
// Everything the bot knows about buying eSIMs goes through this
// module — handlers never touch axios or supplier URLs directly.
//
// ⚠️  BEFORE GOING LIVE: open your eSIMaccess dashboard → API /
//     Developer docs and verify the marked spots below (endpoint
//     paths, auth scheme and response field names). They are
//     isolated here on purpose, so the rest of the bot keeps
//     working against this interface no matter how the real API
//     is shaped.
//
// Failure policy: every function NEVER throws. On any error the
// bot falls back to the local catalogue / manual delivery so a
// supplier outage can never take the whole bot down.
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs';
import axios from 'axios';
import { ESIMACCESS, PATHS, SETTINGS } from '../config.js';
import { log } from '../lib/logger.js';

// ── Endpoints ───────────────────────────────────────────────
// TODO(VERIFY): confirm these paths against the eSIMaccess API
// documentation — they are the only place URL shapes are defined.
const ENDPOINTS = {
  plans: '/api/v1/plans',                        // GET  live catalogue + stock
  stock: (planId) => `/api/v1/stock/${planId}`,  // GET  availability for one plan
  purchase: '/api/v1/orders',                    // POST buy an eSIM
  order: (orderId) => `/api/v1/orders/${orderId}`, // GET supplier-side order status
  balance: '/api/v1/balance',                    // GET supplier wallet balance (USD)
};

const PLAN_CACHE_MS = 60_000; // live plan/stock cache
let planCache = { at: 0, plans: null };

/** True when real supplier credentials are present in .env. */
export const isConfigured = () => ESIMACCESS.isConfigured;

/**
 * Shared axios instance (timeout + base URL from .env).
 * TODO(VERIFY): auth scheme — confirm how eSIMaccess authenticates
 * requests. The common variants are:
 *    • Authorization: Bearer <API_SECRET>
 *    • dedicated apiKey / apiSecret headers (assumed below)
 *    • ?apiKey=…&apiSecret=… query parameters
 * Adjust `headers()` only — nothing else needs to change.
 */
const client = () =>
  axios.create({
    baseURL: ESIMACCESS.baseUrl,
    timeout: ESIMACCESS.timeoutMs,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      apiKey: ESIMACCESS.apiKey,
      apiSecret: ESIMACCESS.apiSecret,
    },
  });

/** Fire one supplier request; returns { ok, data, error } and never throws. */
async function request(method, url, body) {
  const startedAt = Date.now();
  try {
    const res = await transport({ method, url, data: body });
    log.info({ event: 'esimaccess', method, url, status: res.status, ms: Date.now() - startedAt }, 'supplier call');
    return { ok: true, data: res.data };
  } catch (err) {
    const status = err.response?.status;
    const error = err.response?.data || err.message;
    log.warn(
      { event: 'esimaccess', method, url, status, ms: Date.now() - startedAt, error: typeof error === 'string' ? error : JSON.stringify(error) },
      'supplier call failed'
    );
    return { ok: false, status, error };
  }
}

// ── Transport (injectable for tests) ──────────────────────────
let transport = (config) => client().request(config);
/** Test hook: replace the HTTP transport. Pass null to restore. */
export function __setTransport(fn) {
  transport = fn || ((config) => client().request(config));
}

/** Local catalogue (data/plans.json) — the guaranteed fallback. */function localPlans() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PATHS.plans, 'utf8'));
    return (parsed.plans || []).map((p) => ({ ...p, source: 'local', stock: null }));
  } catch {
    return [];
  }
}

// ── 1. Live plan / stock catalogue ─────────────────────────
/**
 * Live plans from eSIMaccess, falling back to data/plans.json when
 * the API is unavailable so the bot never goes fully down.
 *
 * @returns {Promise<Array<{id, name, price, stock, source}>>}
 *          normalized plan list (identical shape from both sources)
 */
export async function getAvailablePlans() {
  if (planCache.plans && Date.now() - planCache.at < PLAN_CACHE_MS) {
    return planCache.plans;
  }

  let plans = null;
  if (isConfigured()) {
    const res = await request('get', ENDPOINTS.plans);
    if (res.ok) {
      const list = Array.isArray(res.data) ? res.data : res.data?.plans || res.data?.data || [];
      // TODO(VERIFY): map the supplier's field names to ours.
      plans = list.map((p) => ({
        id: p.id ?? p.planId ?? p.sku,
        name: p.name ?? p.title ?? p.planName,
        price: p.price ?? p.retailPrice ?? p.retail_price ?? null,
        stock: p.stock ?? p.quantity ?? p.available ?? null,
        supplierPlanId: p.planId ?? p.id ?? null,
        source: 'supplier',
      }));
      if (plans.length === 0) plans = null;
    }
  }

  if (!plans) plans = localPlans(); // API down / unconfigured / empty

  planCache = { at: Date.now(), plans };
  return plans;
}

// ── 2. Stock check before confirming an order ──────────────
/**
 * Verify a plan can still be bought.
 * Unconfigured supplier or an unverifiable response degrades to
 * `{ ok: true, source: 'unverified' }` so a network blip never
 * blocks an otherwise valid order.
 *
 * @returns {Promise<{ok: boolean, stock: number|null, source: string}>}
 */
export async function checkStock(planId) {
  if (!isConfigured()) return { ok: true, stock: null, source: 'local' };

  const res = await request('get', ENDPOINTS.stock(planId));
  if (!res.ok) return { ok: true, stock: null, source: 'unverified', error: String(res.error?.message || res.error || '') };

  const data = res.data?.data || res.data || {};
  const stock = Number(data.stock ?? data.quantity ?? data.available ?? 0);
  return { ok: stock > 0, stock: Number.isFinite(stock) ? stock : null, source: 'supplier' };
}

// ── 3. Purchase (runs after the admin confirms the order) ──
/**
 * Buy the eSIM for a confirmed order and pull back the QR /
 * activation code we send to the customer.
 *
 * @param {string} planId   our plan id (e.g. plan_10gb_30d)
 * @param {string} orderId  our Order ID (e.g. SMF-0042)
 * @returns {Promise<{ok: boolean, code?: string, qr?: string|null,
 *                    activationCode?: string|null, iccid?: string|null,
 *                    supplierOrderId?: string|null, error?: string}>}
 *   code: 'NOT_CONFIGURED' -> run manual delivery (data/deliveries.json)
 *         'SUPPLIER_ERROR' -> tell the admin, keep the order pending
 */
export async function purchaseEsim(planId, orderId) {
  if (!isConfigured()) return { ok: false, code: 'NOT_CONFIGURED' };

  const body = {
    // TODO(VERIFY): confirm the purchase payload shape in the docs.
    planId,
    reference: orderId,        // our Order ID, echoed by the supplier
    quantity: 1,
  };

  const res = await request('post', ENDPOINTS.purchase, body);
  if (!res.ok) {
    return { ok: false, code: 'SUPPLIER_ERROR', error: typeof res.error === 'string' ? res.error : JSON.stringify(res.error) };
  }

  const data = res.data?.data || res.data || {};
  // TODO(VERIFY): confirm the response field names (qr / activation
  // code / ICCID) — normalize whatever the docs call them.
  return {
    ok: true,
    qr: data.qr ?? data.qrCode ?? data.qr_code ?? data.qrUrl ?? data.qr_url ?? null,
    activationCode: data.activationCode ?? data.activation_code ?? data.code ?? data.lpa ?? null,
    iccid: data.iccid ?? data.sim?.iccid ?? null,
    supplierOrderId: data.orderId ?? data.id ?? null,
    raw: data,
  };
}

// ── 4. Supplier-side order status ──────────────────────────
/**
 * Poll the supplier for an order we already placed.
 * @returns {Promise<{ok: boolean, status: string, source: string, error?: string}>}
 *   status: 'pending' | 'processing' | 'completed' | 'failed' | 'unknown'
 */
export async function getOrderStatus(supplierOrderId) {
  if (!supplierOrderId) return { ok: false, status: 'unknown', source: 'local', error: 'no supplier order id' };
  if (!isConfigured()) return { ok: false, status: 'unknown', source: 'local', error: 'supplier not configured' };

  const res = await request('get', ENDPOINTS.order(supplierOrderId));
  if (!res.ok) return { ok: false, status: 'unknown', source: 'supplier', error: String(res.error?.message || res.error || '') };

  const raw = String(res.data?.status ?? res.data?.data?.status ?? '').toLowerCase();
  const status =
    /complete|success|deliver|activ/i.test(raw) ? 'completed' :
    /process|pend|wait/i.test(raw) ? 'processing' :
    /fail|error|cancel|reject/i.test(raw) ? 'failed' :
    'unknown';

  return { ok: true, status, source: 'supplier', raw };
}

/** Test helper — drop the 60s live-plan cache. */
export function clearPlanCache() {
  planCache = { at: 0, plans: null };
}

// ── 5. Bulk stock snapshot (plan list rendering + alerts) ───
// One call answers "is every plan available?" for the whole
// catalogue, cached for STOCK_CACHE_SECONDS (default 60s) so the
// list screen never hammers the supplier API.
let stockCache = { at: 0, byId: null, hits: 0 };
const stockTtlMs = () => Math.max(1, SETTINGS.stockCacheSeconds) * 1000;

/**
 * Stock for every known plan, keyed by our plan id:
 *   { [planId]: { ok: boolean, stock: number|null, source } }
 * Unconfigured / failed supplier => every plan reported local/ok
 * (the bot must never block ordering on an API outage).
 * @returns {Promise<Object<string, {ok, stock, source}>>}
 */
export async function checkAllStock() {
  const now = Date.now();
  if (stockCache.byId && now - stockCache.at < stockTtlMs()) {
    stockCache.hits += 1;
    return stockCache.byId;
  }

  const byId = {};
  if (isConfigured()) {
    const res = await request('get', ENDPOINTS.plans);
    if (res.ok) {
      const list = Array.isArray(res.data) ? res.data : res.data?.plans || res.data?.data || [];
      for (const p of list) {
        const id = p.id ?? p.planId ?? p.sku;
        if (!id) continue;
        const stock = Number(p.stock ?? p.quantity ?? p.available ?? 0);
        byId[String(id)] = {
          ok: Number.isFinite(stock) ? stock > 0 : true,
          stock: Number.isFinite(stock) ? stock : null,
          source: 'supplier',
        };
      }
    }
  }

  // Local catalogue fills every gap (and IS the answer when unconfigured).
  for (const plan of localPlans()) {
    if (!byId[plan.id]) byId[plan.id] = { ok: true, stock: null, source: 'local' };
  }

  stockCache = { at: now, byId, hits: 0 };
  return byId;
}

/** Cache introspection (unit tests + ops). */
export function stockCacheMeta() {
  return {
    cached: Boolean(stockCache.byId),
    ageMs: stockCache.byId ? Date.now() - stockCache.at : -1,
    hits: stockCache.hits,
    ttlMs: stockTtlMs(),
  };
}

/** Test helper — drop the bulk stock cache. */
export function clearStockCache() {
  stockCache = { at: 0, byId: null, hits: 0 };
}

/**
 * Supplier wallet balance for the SUPPLIER_LOW_BALANCE_USD alert.
 * Honest result: { ok:false, code:'NOT_CONFIGURED' } without
 * credentials, { ok:false } when the endpoint is missing/down —
 * callers must treat anything unverifiable as "no alert".
 */
export async function getBalance() {
  if (!isConfigured()) return { ok: false, code: 'NOT_CONFIGURED' };
  const res = await request('get', ENDPOINTS.balance);
  if (!res.ok) return { ok: false, code: 'UNAVAILABLE', error: String(res.error?.message || res.error || '') };
  const data = res.data;
  const raw = data?.balance ?? data?.wallet ?? data?.amount ?? data?.data?.balance;
  const balance = Number(raw);
  if (!Number.isFinite(balance)) return { ok: false, code: 'UNPARSEABLE' };
  return { ok: true, balance, currency: data?.currency || data?.data?.currency || 'USD' };
}
