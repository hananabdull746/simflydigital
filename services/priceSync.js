// ─────────────────────────────────────────────────────────────
// services/priceSync.js
// Daily supplier price / balance sync (PRICE_SYNC_CRON, default
// 06:00): force-refreshes the MERGED ProdSeller + Eklas product
// cache, diffs the USD costs against the previous run and pages the
// admins when anything moved (cost up/down, stock in/out, product
// added/removed) plus a balance line for BOTH supplier wallets
// (top-up nudge when either is low).
//
// Sell prices themselves are never written back — they are derived
// on every view from (cost × rate × ROI), and per-product overrides
// live in data/digitalProductOverrides.json. This job only REFRESHES
// the cost inputs and reports the effect.
// ─────────────────────────────────────────────────────────────
import cron from 'node-cron';
import fs from 'node:fs';
import { SETTINGS, BRAND, PATHS } from '../config.js';
import { getProducts, getBalances, isConfigured, supplierLabel } from './productCatalog.js';
import { alertAdmins } from './adminAlerts.js';
import { logError, logAdmin } from '../lib/logger.js';

let task = null;

// Last run's supplier snapshot: { at, balanceUsd, products: { id: { name, price, inStock } } }
function readSnapshot() {
  try {
    if (!fs.existsSync(PATHS.priceSync)) return null;
    const raw = JSON.parse(fs.readFileSync(PATHS.priceSync, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

function writeSnapshot(snap) {
  try {
    fs.mkdirSync(PATHS.dataDir, { recursive: true });
    fs.writeFileSync(PATHS.priceSync, JSON.stringify(snap, null, 2), 'utf8');
  } catch (err) {
    logError('pricesync.snapshot', err, { file: PATHS.priceSync });
  }
}

function usd(n) {
  const v = Number(n);
  return Number.isFinite(v) ? `$${v.toFixed(2)}` : '—';
}

/**
 * One sync pass. Exported so tests / admin triggers can run it directly.
 * @returns {Promise<{ok:boolean, baseline?:boolean, changes?:string[],
 *                    products?:number, balanceUsd?:number|null, stale?:boolean}>}
 */
export async function runPriceSyncOnce(sock) {
  if (!isConfigured()) return { ok: false, code: 'NOT_CONFIGURED' };

  const res = await getProducts({ force: true });
  if (!res.ok) return { ok: false, code: res.code || 'FETCH_FAILED' };

  const prev = readSnapshot();
  const baseline = !prev?.products || Object.keys(prev.products).length === 0;

  const now = new Date().toISOString();
  const nextProducts = {};
  const changes = [];

  for (const p of res.products) {
    const before = prev?.products?.[p.id];
    nextProducts[p.id] = { name: p.name, price: p.price, inStock: p.inStock };
    if (!before) {
      if (!baseline) changes.push(`➕ New: ${p.name} @ ${usd(p.price)}`);
      continue;
    }
    if (Number(before.price) !== Number(p.price)) {
      const dir = p.price > before.price ? '⬆️' : '⬇️';
      changes.push(`${dir} ${p.name}: ${usd(before.price)} → ${usd(p.price)}`);
    }
    if (Boolean(before.inStock) !== Boolean(p.inStock)) {
      changes.push(`${p.inStock ? '🟢' : '🔴'} ${p.name}: ${p.inStock ? 'back in stock' : 'out of stock'}`);
    }
  }
  for (const [id, b] of Object.entries(prev?.products || {})) {
    if (!nextProducts[id]) changes.push(`➖ Removed: ${b.name} (${usd(b.price)})`);
  }

  let balanceUsd = null;
  let balanceLow = false;
  const balances = { prodseller: null, eklas: null };
  const lowSuppliers = [];
  try {
    const all = await getBalances({ force: true });
    for (const [id, b] of Object.entries(all)) {
      if (b.ok && Number.isFinite(Number(b.balance))) balances[id] = Number(b.balance);
    }
    balanceUsd = balances.prodseller ?? balances.eklas ?? null;
    const thresholds = { prodseller: SETTINGS.prodsellerLowBalanceUsd, eklas: SETTINGS.eklasLowBalanceUsd };
    for (const [id, bal] of Object.entries(balances)) {
      if (bal !== null && bal < Number(thresholds[id] || 0)) lowSuppliers.push(id);
    }
    balanceLow = lowSuppliers.length > 0;
  } catch (err) {
    logError('pricesync.balance', err);
  }

  writeSnapshot({ at: now, balanceUsd, products: nextProducts });

  const balanceLine = Object.entries(balances)
    .filter(([, v]) => v !== null)
    .map(([id, v]) => `${supplierLabel(id)} ${usd(v)}`)
    .join(' · ');

  // First run (or after a wipe): seed quietly, no admin paging.
  if (baseline) {
    logAdmin('pricesync', { baseline: true, products: res.products.length, balanceUsd, balances });
    return { ok: true, baseline: true, changes: [], products: res.products.length, balanceUsd, balances, stale: Boolean(res.stale) };
  }

  if (changes.length || balanceLow) {
    const lines = [
      '🔄 *Daily supplier sync*',
      `📦 ${res.products.length} products · ${balanceLine || 'balance —'}`,
      ...(res.stale ? ['⚠️ API stale — serving last known good catalogue.'] : []),
      '',
      ...changes.slice(0, 8),
      changes.length > 8 ? `… +${changes.length - 8} more` : '',
      ...lowSuppliers.map((id) => {
        const threshold = id === 'eklas' ? SETTINGS.eklasLowBalanceUsd : SETTINGS.prodsellerLowBalanceUsd;
        return `\n🔴 ${supplierLabel(id)} balance ${usd(balances[id])} is below ${usd(threshold)} — its orders will fail with 402 until topped up.`;
      }),
      '',
      'Sell prices follow automatically (cost × rate × ROI) unless a product is price-pinned in the admin panel.',
    ].filter(Boolean).join('\n');

    await alertAdmins(sock, lines, { title: `${BRAND.name} · Price sync`, critical: balanceLow });
    logAdmin('pricesync', { changes: changes.length, balanceUsd, balances, low: lowSuppliers });
    return { ok: true, changes, products: res.products.length, balanceUsd, balances, stale: Boolean(res.stale) };
  }

  logAdmin('pricesync', { changes: 0, products: res.products.length, balanceUsd, balances });
  return { ok: true, changes: [], products: res.products.length, balanceUsd, balances, stale: Boolean(res.stale) };
}

/** Start the cron sync (idempotent). Returns the cron task or null. */
export function startPriceSyncJob(sock) {
  if (task) return task;
  if (!SETTINGS.priceSyncEnabled) {
    console.log('[pricesync] Disabled (PRICE_SYNC_ENABLED=false).');
    return null;
  }
  if (!cron.validate(SETTINGS.priceSyncCron)) {
    console.warn(`[pricesync] Invalid PRICE_SYNC_CRON "${SETTINGS.priceSyncCron}" — job not started.`);
    return null;
  }
  task = cron.schedule(SETTINGS.priceSyncCron, () => {
    runPriceSyncOnce(sock)
      .then((r) => {
        if (r.ok && r.changes?.length) console.log(`[pricesync] ${r.changes.length} change(s).`);
      })
      .catch((err) => logError('pricesync.job', err));
  });
  console.log(`[pricesync] Supplier price sync scheduled: ${SETTINGS.priceSyncCron}`);
  return task;
}

export function stopPriceSyncJob() {
  if (task) {
    try { task.stop(); } catch { /* already stopped */ }
    task = null;
  }
}
