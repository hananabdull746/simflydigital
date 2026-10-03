// ─────────────────────────────────────────────────────────────
// services/binancePay.js
// Thin, signed client for ONE Binance endpoint:
//
//   GET /sapi/v1/pay/transactions   ("Get Pay Trade History", USER_DATA)
//
// Why this endpoint: it hands back the Transaction ID the customer
// typed together with a SIGNED amount and a millisecond timestamp —
// exactly what the verifier needs. No unique-amount games, no
// screenshot OCR, no merchant onboarding (merchant APIs live under
// /binancepay/openapi/* and are deliberately NOT used here).
//
//   • auth = HMAC-SHA256 over the ENCODED query string. Signature
//     rule effective 2026-01-15: percent-encode the payload FIRST,
//     sign the encoded string, THEN append &signature=. buildQuery()
//     / signQuery() are exported so a test can pin that down.
//   • the API key only ever leaves the process inside the
//     X-MBX-APIKEY header; the secret is never logged or echoed
//   • Weight(UID) = 3000 against a 180000/min UID budget, so a few
//     lookups are comfortable — we still throttle (MIN_INTERVAL_MS),
//     honour Retry-After on 429 and cap pagination (MAX_PAGES)
//   • every function NEVER throws: it returns { ok, …, code }
// ─────────────────────────────────────────────────────────────
import crypto from 'node:crypto';
import axios from 'axios';
import { BINANCE_PAY } from '../config.js';
import { logError } from '../lib/logger.js';

export const PATH = '/sapi/v1/pay/transactions';
/** Hard cap on how many pages one lookup may pull (100 rows each). */
export const MAX_PAGES = 3;
/** Minimum gap between two calls to the same endpoint. */
export const MIN_INTERVAL_MS = 250;

/** True when a read-only key + secret are present (the lookup can be signed). */
export const hasKey = () => BINANCE_PAY.hasKey;
/** True when the whole feature (key + Binance Pay ID) is configured. */
export const isConfigured = () => BINANCE_PAY.isConfigured;

// ── Transport (injectable for tests) ──────────────────────────
let transport = async (config) => axios(config);
/** Test hook: replace the HTTP transport. Pass null to restore. */
export function __setTransport(fn) {
  transport = fn || ((config) => axios(config));
}

let sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Test hook: replace the timer used by throttling/backoff. */
export function __setSleep(fn) {
  sleep = fn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

let lastCallAt = 0;
/** Test hook: forget the throttle clock. */
export function __reset() {
  lastCallAt = 0;
}

// ── Signing ───────────────────────────────────────────────────
/** RFC 3986 percent-encoding (Binance rejects `+` and lowercase hex). */
export function rfc3986(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * The percent-encoded query string for `params` (empty values are
 * dropped) — this is the payload that gets SIGNED.
 */
export function buildQuery(params = {}) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .join('&');
}

/**
 * Sign `params`: encode → HMAC-SHA256(secret) → append signature.
 * Returns the full query string ready for the URL.
 */
export function signQuery(params = {}, secret = BINANCE_PAY.apiSecret) {
  const payload = buildQuery(params);
  const signature = crypto.createHmac('sha256', String(secret || '')).update(payload).digest('hex');
  return `${payload}&signature=${signature}`;
}

/** `abc…xyz` for anything customer/admin-facing (never the secret). */
export function maskId(value) {
  const v = String(value || '');
  if (!v) return '';
  if (v.length <= 6) return `${v.slice(0, 2)}${'•'.repeat(Math.max(2, v.length - 2))}`;
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

// ── Normalization ─────────────────────────────────────────────
function firstText(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

function partyName(info) {
  if (!info || typeof info !== 'object') return null;
  return firstText(info.name, info.nickName, info.accountId, info.email, info.phone);
}

/** One API row → the shape the verifier and the admin screen use. */
export function normalizeTx(item = {}) {
  const amount = Number(item.amount);
  const time = Number(item.transactionTime);
  return {
    transactionId: String(item.transactionId || ''),
    orderId: item.orderId === undefined || item.orderId === null ? null : String(item.orderId),
    // Signed string from Binance: "+123.45" = incoming, "-…" = outgoing.
    amount: Number.isFinite(amount) ? amount : 0,
    currency: String(item.currency || ''),
    time: Number.isFinite(time) ? time : null,
    timeIso: Number.isFinite(time) ? new Date(time).toISOString() : null,
    orderType: item.orderType === undefined || item.orderType === null ? null : String(item.orderType),
    walletType: item.walletType ?? null,
    // Not in the documented schema — checked defensively so a note
    // field appearing later starts working with no code change.
    counterpartyNote: firstText(item.note, item.counterpartyNote, item.remarks, item.reference),
    payer: partyName(item.payerInfo),
    receiver: partyName(item.receiverInfo),
    walletTypes: Array.isArray(item.walletTypes) ? item.walletTypes : [],
    fundsDetail: Array.isArray(item.fundsDetail)
      ? item.fundsDetail.map((f) => ({
        currency: String(f?.currency || ''),
        amount: Number(f?.amount) || 0,
        network: f?.network ? String(f.network) : null,
      }))
      : [],
  };
}

// ── Request ───────────────────────────────────────────────────
function header(headers = {}, name) {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

function errorFromStatus(status, body) {
  const msg = String(body?.msg || body?.message || '').slice(0, 200);
  if (status === 401 || status === 403) {
    return { code: 'AUTH', message: 'Binance rejected the API key — check BINANCE_API_KEY / BINANCE_API_SECRET (read-only key, no withdrawal permission).' };
  }
  if (status === 429) return { code: 'RATE_LIMITED', message: msg || 'Binance rate limit hit — backing off.' };
  if (status === 400 || status === 404) return { code: 'BAD_REQUEST', message: msg || `Binance answered ${status}.` };
  return { code: 'UPSTREAM', message: msg || `Binance is unavailable (${status ?? 'network error'}).` };
}

async function throttle() {
  const gap = lastCallAt ? MIN_INTERVAL_MS - (Date.now() - lastCallAt) : 0;
  if (gap > 0) await sleep(gap);
  lastCallAt = Date.now();
}

/**
 * Fire one signed GET.
 * @param {object} params query params (window/limit/timestamp are added)
 * @returns {Promise<{ok:boolean, transactions?:Array, code?:string, message?:string, status?:number}>}
 * Never throws; never returns a raw error object.
 */
export async function getPayTransactions(params = {}) {
  if (!hasKey()) {
    return { ok: false, code: 'NOT_CONFIGURED', message: 'BINANCE_API_KEY / BINANCE_API_SECRET set nahi hain.' };
  }

  const query = signQuery({
    recvWindow: 10_000,
    limit: 100,
    ...params,
    timestamp: Date.now(),
  });
  const url = `${BINANCE_PAY.baseUrl}${PATH}?${query}`;

  await throttle();

  let res = null;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      res = await transport({
        method: 'GET',
        url,
        headers: {
          'X-MBX-APIKEY': BINANCE_PAY.apiKey,
          Accept: 'application/json',
        },
        timeout: BINANCE_PAY.timeoutMs,
      });
    } catch (err) {
      // axios throws for 4xx/5xx too — the body still tells us why.
      const status = Number(err?.response?.status) || 0;
      const body = err?.response?.data || {};
      if (status === 429 && attempt === 1) {
        const retryAfter = Number(header(err?.response?.headers || {}, 'retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 30_000)
          : 2_000);
        continue;
      }
      const info = errorFromStatus(status, body);
      logError('binance.request', new Error(info.code), { status, message: info.message });
      return { ok: false, code: info.code, message: info.message, status: status || 0 };
    }

    const status = Number(res?.status) || 0;
    const body = res?.data || {};

    if (status === 429 && attempt === 1) {
      const retryAfter = Number(header(res?.headers || {}, 'retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 30_000)
        : 2_000);
      continue;
    }

    if (status < 200 || status >= 300) {
      const info = errorFromStatus(status, body);
      return { ok: false, code: info.code, message: info.message, status };
    }

    // Envelope: { code: "000000", message: "success", data: [...] }
    const rows = Array.isArray(body?.data)
      ? body.data
      : (Array.isArray(body) ? body : null);
    if (!rows) {
      // No `data` array → an error envelope or an unexpected shape.
      const message = String(body?.msg || body?.message || '').slice(0, 200);
      const code = String(body?.code ?? body?.msgCode ?? '') || 'BAD_RESPONSE';
      return {
        ok: false,
        code: code === '000000' ? 'BAD_RESPONSE' : code,
        message: message || 'Binance returned an unexpected response.',
        status,
        transactions: [],
      };
    }

    return { ok: true, code: String(body?.code ?? '000000'), status, transactions: rows.map(normalizeTx) };
  }
}

/**
 * All transactions inside a window, paginated by sliding the END of
 * the window backwards (the endpoint has no cursor). Stops at
 * MAX_PAGES so a misbehaving API can never spin.
 * @returns {{ok:boolean, transactions:Array, truncated:boolean, code?:string, message?:string}}
 */
export async function findWindow({ startTime, endTime, maxPages = MAX_PAGES } = {}) {
  const out = [];
  let end = endTime ? Number(endTime) : undefined;
  const start = startTime ? Number(startTime) : undefined;
  let truncated = false;

  for (let page = 0; page < Math.max(1, maxPages); page += 1) {
    const res = await getPayTransactions({ startTime: start, endTime: end, limit: 100 });
    if (!res.ok) return { ok: false, transactions: out, truncated, code: res.code, message: res.message };

    out.push(...res.transactions);
    if (res.transactions.length < 100) return { ok: true, transactions: out, truncated };

    // Full page: slide the window back past the oldest row we saw.
    const times = res.transactions.map((t) => t.time).filter((t) => Number.isFinite(t));
    if (times.length === 0) return { ok: true, transactions: out, truncated: true };
    end = Math.min(...times) - 1;
    if (start !== undefined && end <= start) return { ok: true, transactions: out, truncated: true };
    if (page === maxPages - 1) truncated = true;
  }
  return { ok: true, transactions: out, truncated };
}

/** Find one Transaction ID inside a window (the verifier's lookup). */
export async function findTransactionById(txId, { startTime, endTime } = {}) {
  const id = String(txId || '').trim();
  if (!id) return { ok: false, code: 'BAD_REQUEST', message: 'Transaction ID khaali hai.', transactions: [] };

  const res = await findWindow({ startTime, endTime });
  if (!res.ok) return { ok: false, code: res.code, message: res.message, transactions: res.transactions };

  const hit = res.transactions.find((t) => t.transactionId === id) || null;
  return { ok: true, transaction: hit, truncated: res.truncated, transactions: res.transactions };
}

/** Health/status line for the admin 💳 screen and the dashboard. */
export function status() {
  return {
    configured: isConfigured(),
    hasKey: hasKey(),
    keyMasked: maskId(BINANCE_PAY.apiKey),
    payIdMasked: maskId(BINANCE_PAY.payId),
    mode: BINANCE_PAY.mode,
    rate: BINANCE_PAY.usdtPkrRate,
    windowMinutes: BINANCE_PAY.matchWindowMinutes,
    retryMs: BINANCE_PAY.retryMs,
    maxWaitMs: BINANCE_PAY.maxWaitMs,
    baseUrl: BINANCE_PAY.baseUrl,
  };
}
