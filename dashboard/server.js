// ─────────────────────────────────────────────────────────────
// dashboard/server.js
// 🌐 The bundled, READ-ONLY web dashboard (Phase 2 — it now ships).
//
//   • zero dependencies: node:http + a static HTML file
//   • DASHBOARD_PORT=0 (default) → off; set e.g. 8787 to enable
//   • DASHBOARD_TOKEN=…          → every request must carry it
//                                  (?token= for the HTML page,
//                                   Bearer header for /api/*)
//   • it only READS the same JSON stores the bot writes — it can
//     never confirm an order or move money, so exposing it behind
//     a token + a firewall is safe. The ONE exception is
//     POST /api/payments/rescan, which pulls Binance trade history
//     into the local cache (db/binanceTransactions.json) and
//     changes nothing else.
//
// Tabs: Overview · Orders · Digital Store · WhatsApp Catalog · Wallets
//       · Payments · Audit  (+ CSV export of orders / ledger)
// ─────────────────────────────────────────────────────────────
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND, SETTINGS, formatPrice } from '../config.js';
import { allOrders } from '../lib/store.js';
import { allWallets, totalLiability, recentLedger, auditWallets } from '../services/wallet.js';
import { getBalance as getProdSellerBalance, isConfigured } from '../services/prodseller.js';
import {
  getProducts as getMergedProducts, getBalances, isConfigured as anySupplierConfigured, supplierLabel,
} from '../services/productCatalog.js';
import { adminProducts, allOverrides } from '../lib/digital.js';
import { activePolls } from '../services/digitalPolls.js';
import { recentAudit, getSettings } from '../lib/admins.js';
import { recentPayments, scanStatus } from '../services/verifier.js';
import * as catalog from '../services/catalogService.js';
import {
  recentTransactions as recentBinanceTx, rescan as binanceRescan, storeStatus as binanceStoreStatus,
} from '../services/binanceVerifier.js';
import { logAdmin, logError } from '../lib/logger.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let server = null;

// ── helpers ──────────────────────────────────────────────────
const maskPhone = (phone) => {
  const s = String(phone || '');
  if (s.length < 8) return s;
  return `+${s.slice(0, 4)}${'*'.repeat(Math.max(3, s.length - 7))}${s.slice(-3)}`;
};
const maskKey = (key) => {
  const s = String(key || '');
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : `${s.slice(0, 3)}…`;
};

function authorized(req, url) {
  if (!SETTINGS.dashboardToken) return true;
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const token = url.searchParams.get('token') || bearer || '';
  // Timing-safe compare for the (short) token.
  const a = Buffer.from(String(token));
  const b = Buffer.from(String(SETTINGS.dashboardToken));
  return a.length === b.length && cryptoSafeEqual(a, b);
}
function cryptoSafeEqual(a, b) {
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function csv(res, filename, header, rows) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [header.join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n');
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// ── request bodies (zero-dependency: raw buffer + minimal multipart) ─
function readBody(req, limit) {
  const max = Number(limit) || 12 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) {
        req.destroy();
        reject(Object.assign(new Error('payload too large'), { code: 'PAYLOAD_TOO_LARGE' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function jsonBody(req) {
  const buf = await readBody(req, 1024 * 1024);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw Object.assign(new Error('body is not valid JSON'), { code: 'BAD_JSON' });
  }
}

/** Pull the `image` file part out of a multipart/form-data body. */
function multipartImage(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  if (!m) return null;
  const boundary = Buffer.from(`--${(m[1] || m[2]).trim()}`);
  const parts = [];
  let start = buffer.indexOf(boundary);
  while (start !== -1) {
    start += boundary.length;
    const end = buffer.indexOf(boundary, start);
    if (end === -1) break;
    parts.push(buffer.subarray(start, end));
    start = end;
  }
  for (let part of parts) {
    if (part[0] === 0x0d && part[1] === 0x0a) part = part.subarray(2); // leading CRLF
    const sep = part.indexOf('\r\n\r\n');
    if (sep === -1) continue;
    const headers = part.subarray(0, sep).toString('utf8');
    if (!/name="image"/i.test(headers)) continue;
    let body = part.subarray(sep + 4);
    // trailing CRLF before the next boundary
    if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
      body = body.subarray(0, body.length - 2);
    }
    const fn = /filename="([^"]*)"/i.exec(headers);
    return { buffer: body, filename: (fn && fn[1]) || 'image.jpg' };
  }
  return null;
}

/** Catalog error code → HTTP status (spec §12). */
function statusFor(code) {
  if (code === 'NOT_FOUND' || code === 'PRODUCT_NOT_FOUND') return 404;
  if (code === 'RATE_LIMITED') return 429;
  if (code === 'DISCONNECTED' || code === 'AUTH_EXPIRED' || code === 'CATALOG_UNAVAILABLE') return 503;
  if (code === 'CONFIRMATION_REQUIRED' || code === 'SYNC_RUNNING') return 409;
  if (String(code || '').startsWith('INVALID_') || code === 'BAD_JSON' || code === 'PAYLOAD_TOO_LARGE') return 400;
  return 502;
}

// ── read models (the ONLY place the dashboard touches data) ──
async function overview() {
  const orders = allOrders();
  const fulfilled = orders.filter((o) => o.status === 'fulfilled');
  const revenue = fulfilled.reduce((s, o) => s + Number(o.price || 0), 0);
  const [ps, balances] = await Promise.all([
    getProdSellerBalance().catch(() => null),
    getBalances().catch(() => null),
  ]);
  const audit = auditWallets();
  const settings = getSettings();
  const ek = balances?.eklas ?? null;
  const psBal = balances?.prodseller ?? null;

  return {
    now: new Date().toISOString(),
    brand: BRAND.name || 'Simfly Store',
    orders: {
      total: orders.length,
      pending: orders.filter((o) => ['pending_admin', 'awaiting_supplier_funding'].includes(o.status)).length,
      awaitingScreenshot: orders.filter((o) => o.status === 'await_screenshot').length,
      activating: orders.filter((o) => o.status === 'awaiting_activation').length,
      delivered: fulfilled.length,
      rejected: orders.filter((o) => o.status === 'rejected').length,
      cancelled: orders.filter((o) => o.status === 'cancelled').length,
      refunded: orders.filter((o) => o.status === 'refunded').length,
      revenue,
      topups: orders.filter((o) => o.catalogType === 'wallet_topup').length,
      digital: orders.filter((o) => o.catalogType === 'digital').length,
    },
    wallet: {
      enabled: Boolean(SETTINGS.walletEnabled),
      liability: totalLiability(),
      wallets: allWallets().length,
      pendingTopups: orders.filter((o) => o.catalogType === 'wallet_topup' && ['await_screenshot', 'pending_admin'].includes(o.status)).length,
      auditOk: audit.ok,
      auditIssues: audit.issues.length,
    },
    prodseller: {
      configured: isConfigured(),
      balanceUsd: ps?.ok ? ps.balance : null,
      lowThresholdUsd: SETTINGS.prodsellerLowBalanceUsd,
      low: ps?.ok ? Number(ps.balance) <= SETTINGS.prodsellerLowBalanceUsd : false,
      activePolls: activePolls().length,
      markupPercent: Number.isFinite(Number(settings.digitalMarkupPercent))
        ? Number(settings.digitalMarkupPercent)
        : SETTINGS.digitalMarkupPercent,
      usdPkrRate: settings.usdPkrRate ?? SETTINGS.usdPkrRate,
    },
    eklas: {
      configured: ek?.configured ?? false,
      balanceUsd: ek?.ok ? ek.balance : null,
      lowThresholdUsd: SETTINGS.eklasLowBalanceUsd,
      low: ek?.ok ? Number(ek.balance) <= SETTINGS.eklasLowBalanceUsd : false,
    },
    suppliers: {
      active: anySupplierConfigured(),
      dual: Boolean(psBal?.configured && ek?.configured),
      balances: {
        prodseller: psBal?.balance ?? null,
        eklas: ek?.balance ?? null,
      },
      compareCacheSeconds: SETTINGS.productCompareCacheSeconds,
      labels: { prodseller: supplierLabel('prodseller'), eklas: supplierLabel('eklas') },
    },
    verifier: { auto: settings.autoVerifier || 'off' },
    // 💳 Binance Pay auto-verification — the status light + health.
    binance: (() => {
      const s = binanceStoreStatus();
      return {
        configured: s.configured,
        hasKey: s.hasKey,
        payIdMasked: s.payIdMasked,
        keyMasked: s.keyMasked,
        mode: s.mode,
        rate: s.rate,
        count: s.count,
        claimed: s.claimed,
        unclaimed: s.unclaimed,
        lastFetch: s.lastFetch,
        lastOk: s.lastOk,
        lastError: s.lastError,
        matched: s.matched,
        shadowed: s.shadowed,
        blocked: s.blocked,
      };
    })(),
  };
}

async function orderRows({ status = '', q = '', limit = 200 } = {}) {
  const needle = String(q || '').toLowerCase().trim();
  let list = allOrders();
  if (status) list = list.filter((o) => o.status === status);
  if (needle) {
    list = list.filter((o) =>
      String(o.id).toLowerCase().includes(needle)
      || String(o.planName || '').toLowerCase().includes(needle)
      || String(o.phone || '').includes(needle.replace(/\D/g, '')));
  }
  return list
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, Math.min(500, Number(limit) || 200))
    .map((o) => ({
      id: o.id,
      status: o.status,
      type: o.catalogType || 'esim',
      name: o.planName,
      price: Number(o.price || 0),
      paidBy: o.paidBy || 'screenshot',
      payment: o.paymentLabel,
      phone: maskPhone(o.phone),
      email: o.activationEmail || null,
      prodsellerOrderId: o.prodsellerOrderId || null,
      supplier: o.supplier || (o.prodsellerOrderId ? 'prodseller' : null),
      supplierOrderId: o.supplierOrderId || null,
      keys: (o.deliveredKeys || []).map(maskKey),
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
    }));
}

async function productRows() {
  const res = await getMergedProducts().catch(() => ({ products: [] }));
  const overrides = allOverrides();
  const rate = Number(getSettings().usdPkrRate ?? SETTINGS.usdPkrRate);
  const list = adminProducts(res.products || [], {
    overrides,
    rate,
    markupPercent: Number.isFinite(Number(getSettings().digitalMarkupPercent))
      ? Number(getSettings().digitalMarkupPercent)
      : SETTINGS.digitalMarkupPercent,
  });
  const rawById = new Map((res.products || []).map((p) => [String(p.id), p]));
  return list.map((p) => {
    // Admin's costUsd override wins over the supplier price.
    const raw = rawById.get(String(p.id));
    const costUsd = Number(p.costUsd ?? raw?.price ?? 0);
    const costPkr = Math.round(costUsd * rate);
    return {
      id: p.id,
      name: p.name,
      pricePkr: p.pricePkr,
      costUsd,
      costPkr,
      marginPkr: p.pricePkr - costPkr,
      markupPercent: p.markupPercent,
      stock: p.inStock,
      visible: !p.hidden,
      activation: Boolean(p.requiresEmailActivation),
      badge: p.badge || null,
      // Dual-supplier routing: which supplier funds this row right now,
      // whether the other one carries it, and what choosing it saves.
      supplier: raw?.supplier ? supplierLabel(raw.supplier) : supplierLabel('prodseller'),
      alternateSupplier: raw?.other?.supplier ? supplierLabel(raw.other.supplier) : null,
      savingUsd: raw?.other && Number.isFinite(raw.chosen?.price) && Number.isFinite(raw.other.price)
        ? Math.max(0, raw.other.price - raw.chosen.price)
        : 0,
      locked: Boolean(raw?.locked),
    };
  });
}

// ── routes ───────────────────────────────────────────────────
async function handleApi(req, res, url) {
  const route = url.pathname;

  if (route === '/api/overview') return json(res, 200, await overview());
  if (route === '/api/orders') {
    return json(res, 200, await orderRows({
      status: url.searchParams.get('status') || '',
      q: url.searchParams.get('q') || '',
      limit: url.searchParams.get('limit') || 200,
    }));
  }
  if (route === '/api/products') return json(res, 200, await productRows());
  // 💳 Payments: read model for the Payments tab.
  if (route === '/api/payments') {
    return json(res, 200, {
      binance: binanceStoreStatus(),
      transactions: recentBinanceTx(20),
      nayapay: { status: scanStatus(), emails: recentPayments(10) },
      verifierAuto: getSettings().autoVerifier || 'off',
    });
  }
  // The ONE non-read endpoint: it only pulls Binance trade history
  // into the local cache — it never confirms an order or moves money.
  if (route === '/api/payments/rescan') {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    const out = await binanceRescan().catch((err) => ({ ok: false, message: err?.message || 'fetch failed' }));
    logAdmin('dashboard.binance_rescan', { ok: Boolean(out.ok), scanned: out.scanned ?? 0, message: String(out.message || '').slice(0, 120) });
    return json(res, out.ok ? 200 : 502, out);
  }
  if (route === '/api/wallets') {
    return json(res, 200, {
      liability: totalLiability(),
      wallets: allWallets(),
      pendingTopups: allOrders().filter((o) => o.catalogType === 'wallet_topup' && ['await_screenshot', 'pending_admin'].includes(o.status)).map((o) => ({
        id: o.id, price: o.price, phone: maskPhone(o.phone), status: o.status, createdAt: o.createdAt,
      })),
      audit: auditWallets(),
    });
  }
  if (route === '/api/ledger') {
    return json(res, 200, recentLedger(Number(url.searchParams.get('limit')) || 100));
  }
  if (route === '/api/audit') {
    return json(res, 200, recentAudit(Number(url.searchParams.get('limit')) || 50));
  }
  if (route === '/api/export/orders.csv') {
    const rows = await orderRows({ limit: 500 });
    return csv(res, 'simfly-orders.csv',
      ['id', 'status', 'type', 'name', 'price_pkr', 'paid_by', 'payment', 'phone', 'email', 'prodseller_order', 'created_at'],
      rows.map((o) => [o.id, o.status, o.type, o.name, o.price, o.paidBy, o.payment, o.phone, o.email || '', o.prodsellerOrderId || '', o.createdAt]));
  }
  if (route === '/api/export/ledger.csv') {
    return csv(res, 'simfly-wallet-ledger.csv',
      ['tx_id', 'customer', 'type', 'amount_pkr', 'balance_after', 'related_order', 'created_at', 'note'],
      recentLedger(1000).map((t) => [t.id, t.customerId, t.type, t.amountPkr, t.balanceAfter, t.relatedOrderId || '', t.createdAt, t.note || '']));
  }
  // 🏪 WhatsApp Catalog — local products + the push to WA (spec §9).
  if (route === '/api/catalog') {
    if (req.method === 'GET') {
      return json(res, 200, {
        connected: catalog.isReady(),
        code: catalog.isReady() ? undefined : 'DISCONNECTED',
        products: catalog.getProducts(),
      });
    }
    if (req.method === 'POST') {
      let body;
      try { body = await jsonBody(req); } catch (err) { return json(res, 400, { error: err.message }); }
      const saved = catalog.saveLocal(body.retailerId, body);
      if (!saved.ok) return json(res, statusFor(saved.code), saved);
      // push=false → save locally only, sync later.
      const whatsapp = body.push === false ? null : await catalog.createProduct(saved.retailerId);
      return json(res, 201, { ok: true, product: catalog.getLocalProduct(saved.retailerId), whatsapp });
    }
    return json(res, 405, { error: 'GET or POST only' });
  }

  // Live sync progress — the UI polls this while POST /sync is in flight.
  if (route === '/api/catalog/sync/status') {
    if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });
    return json(res, 200, catalog.syncProgress());
  }

  if (route === '/api/catalog/sync') {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    // One run at a time — the second click must not fork the batch.
    if (catalog.syncProgress().running) {
      return json(res, 409, { ...catalog.syncProgress(), ok: false, code: 'SYNC_RUNNING', message: 'a sync is already running' });
    }
    let body = {};
    try { body = await jsonBody(req); } catch (err) { return json(res, 400, { error: err.message }); }
    const summary = await catalog.syncCatalog({
      dryRun: Boolean(body.dryRun),
      limit: Number(body.limit) || 0,
    });
    logAdmin('dashboard.catalog_sync', {
      ok: Boolean(summary.ok), dryRun: Boolean(body.dryRun),
      created: summary.created?.length ?? 0, updated: summary.updated?.length ?? 0,
      failed: summary.failed?.length ?? 0,
    });
    return json(res, summary.ok ? 200 : statusFor(summary.code), summary);
  }

  const cat = route.match(/^\/api\/catalog\/([^/]+)(\/image)?$/);
  if (cat) {
    const retailerId = decodeURIComponent(cat[1]);

    if (cat[2]) {
      // POST /api/catalog/:retailerId/image — multipart/form-data, field "image".
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      let upload;
      try {
        const buf = await readBody(req, 12 * 1024 * 1024);
        upload = multipartImage(buf, req.headers['content-type']);
      } catch (err) {
        return json(res, err.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, { error: err.message });
      }
      if (!upload) return json(res, 400, { error: 'send multipart/form-data with an "image" file part' });
      const saved = catalog.saveImage(retailerId, upload.buffer, upload.filename);
      if (!saved.ok) return json(res, statusFor(saved.code), saved);
      const whatsapp = url.searchParams.get('push') === '0'
        ? null
        : await catalog.updateProduct(retailerId, { force: true });
      return json(res, 200, { ok: true, ...saved, product: catalog.getLocalProduct(retailerId), whatsapp });
    }

    if (req.method === 'GET') {
      const product = catalog.getLocalProduct(retailerId);
      return product ? json(res, 200, product) : json(res, 404, { error: 'not found' });
    }
    if (req.method === 'PUT') {
      let body;
      try { body = await jsonBody(req); } catch (err) { return json(res, 400, { error: err.message }); }
      const saved = catalog.saveLocal(retailerId, body);
      if (!saved.ok) return json(res, statusFor(saved.code), saved);
      const whatsapp = body.push === false ? null : await catalog.updateProduct(retailerId, { force: true });
      return json(res, 200, { ok: true, product: catalog.getLocalProduct(retailerId), whatsapp });
    }
    if (req.method === 'DELETE') {
      // spec §7 — deletion must be confirmed explicitly.
      const confirmed = url.searchParams.get('confirmed') === '1' || url.searchParams.get('confirmed') === 'true';
      const out = await catalog.deleteProduct(retailerId, { confirmed });
      return json(res, out.ok ? 200 : statusFor(out.code), out);
    }
    return json(res, 405, { error: 'method not allowed' });
  }

  return json(res, 404, { error: 'not found' });
}

// ── server ───────────────────────────────────────────────────
export function startDashboard() {
  if (!SETTINGS.dashboardPort) return null;
  if (server) return server;

  const htmlPath = path.join(HERE, 'index.html');
  const readHtml = () => fs.readFileSync(htmlPath, 'utf8');

  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

      if (url.pathname.startsWith('/api/')) {
        if (!authorized(req, url)) return json(res, 401, { error: 'unauthorized' });
        return await handleApi(req, res, url);
      }

      if (url.pathname === '/' || url.pathname === '/index.html') {
        if (!authorized(req, url)) {
          res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('Unauthorized — add ?token=YOUR_DASHBOARD_TOKEN');
        }
        const html = readHtml();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (err) {
      logError('dashboard.request', err, { url: req.url });
      try { json(res, 500, { error: 'server error' }); } catch { /* headers sent */ }
    }
  });

  server.on('error', (err) => {
    logError('dashboard.listen', err, { port: SETTINGS.dashboardPort });
    console.error(`[dashboard] Could not start on :${SETTINGS.dashboardPort} — ${err.message}`);
    server = null;
  });

  server.listen(SETTINGS.dashboardPort, () => {
    const token = SETTINGS.dashboardToken ? 'token required' : '⚠️ NO TOKEN (set DASHBOARD_TOKEN)';
    console.log(`[dashboard] 🌐 http://localhost:${SETTINGS.dashboardPort} — ${token}`);
    if (!SETTINGS.dashboardToken && String(SETTINGS.dashboardPort) !== '80') {
      console.warn('[dashboard] ⚠️ DASHBOARD_TOKEN is empty — anyone who can reach this port can read orders. Set it in .env.');
    }
  });
  return server;
}

export function stopDashboard() {
  if (!server) return;
  try { server.close(); } catch { /* already closed */ }
  server = null;
}

/** The link the admin panel's 🌐 row opens. */
export function dashboardUrl() {
  if (!SETTINGS.dashboardPort) return SETTINGS.dashboardUrl || '';
  const base = SETTINGS.dashboardUrl || `http://localhost:${SETTINGS.dashboardPort}`;
  if (!SETTINGS.dashboardToken) return base;
  return `${base}?token=${encodeURIComponent(SETTINGS.dashboardToken)}`;
}

/** Test helper: is the dashboard listening? */
export const __isListening = () => Boolean(server);
