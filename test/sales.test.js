// Unit tests for 🎟️ admin sale codes (lib/sales.js):
//   create/validate → lifecycle (pause/expiry/max uses) → the ONE
//   checkout resolver used by BOTH payment paths.
//
// Run with:  node --test test/sales.test.js
//
// Env overrides MUST run before any project module loads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.STORE_FILE = 'test/.tmp-sales-store.json';
process.env.SESSIONS_FILE = 'test/.tmp-sales-sessions.json';
process.env.USERS_FILE = 'test/.tmp-sales-users.json';
process.env.ADMIN_STATE_FILE = 'test/.tmp-sales-admin.json';
process.env.AUDIT_FILE = 'test/.tmp-sales-audit.json';
process.env.WALLETS_FILE = 'test/.tmp-sales-wallets.json';
process.env.WALLET_TX_FILE = 'test/.tmp-sales-wallet-tx.json';
process.env.DIGITAL_OVERRIDES_FILE = 'test/.tmp-sales-overrides.json';
process.env.DIGITAL_POLLS_FILE = 'test/.tmp-sales-polls.json';
process.env.PAYMENTS_FILE = 'test/.tmp-sales-payments.json';
process.env.BINANCE_TX_FILE = 'test/.tmp-sales-binance.json';
process.env.SALES_FILE = 'test/.tmp-sales-sales.json';
process.env.USD_PKR_RATE = '278';
process.env.DIGITAL_MARKUP_PERCENT = '50';
process.env.ADMIN_WHATSAPP_NUMBER = '030011122233';

try {
  for (const f of [
    '.tmp-sales-store.json', '.tmp-sales-sessions.json', '.tmp-sales-users.json',
    '.tmp-sales-admin.json', '.tmp-sales-audit.json', '.tmp-sales-wallets.json',
    '.tmp-sales-wallet-tx.json', '.tmp-sales-overrides.json', '.tmp-sales-polls.json',
    '.tmp-sales-payments.json', '.tmp-sales-sales.json', '.tmp-sales-binance.json',
  ]) {
    fs.rmSync(new URL(`./${f}`, import.meta.url), { force: true });
  }
} catch { /* ignore */ }

const sales = await import('../lib/sales.js');
const users = await import('../lib/users.js');
const { PATHS } = await import('../config.js');

const JID = '9230011122233@s.whatsapp.net';

function writeCodes(codes) {
  fs.writeFileSync(PATHS.sales, JSON.stringify({ codes }, null, 2), 'utf8');
}

// ── Create + validation ──────────────────────────────────────
test('createSale validates the code and the percent', () => {
  assert.equal(sales.createSale({ code: '!!', percentOff: 20 }).ok, false);
  assert.equal(sales.createSale({ code: 'OKCODE', percentOff: 0 }).ok, false);
  assert.equal(sales.createSale({ code: 'OKCODE', percentOff: 95 }).ok, false);

  const ok = sales.createSale({ code: ' eid20 ', percentOff: 20.4, maxUses: 0 });
  assert.equal(ok.ok, true);
  assert.equal(ok.code, 'EID20'); // normalised
  assert.equal(ok.sale.percentOff, 20);
  assert.equal(ok.sale.active, true);
  assert.equal(ok.sale.uses, 0);
  assert.equal(ok.sale.maxUses, 1000); // default
  assert.equal(ok.sale.endsAt, null); // no `days` → no expiry

  const dated = sales.createSale({ code: 'WEEKLY', percentOff: 15, days: 7 });
  assert.equal(dated.ok, true);
  assert.ok(Date.parse(dated.sale.endsAt) > Date.now());
});

test('getSale / allSales read back what was written', () => {
  assert.equal(sales.getSale('eid20')?.percentOff, 20); // case-insensitive
  assert.equal(sales.getSale('nope'), null);
  assert.ok(sales.allSales().some((s) => s.code === 'EID20'));
});

// ── Lifecycle ────────────────────────────────────────────────
test('saleState walks every failure reason', () => {
  writeCodes([
    { code: 'OFF', percentOff: 25, active: true, uses: 0, maxUses: 10, endsAt: null },
    { code: 'PAUSED', percentOff: 25, active: false, uses: 0, maxUses: 10, endsAt: null },
    { code: 'SOON', percentOff: 25, active: true, uses: 0, maxUses: 10, startsAt: new Date(Date.now() + 60_000).toISOString(), endsAt: null },
    { code: 'GONE', percentOff: 25, active: true, uses: 0, maxUses: 10, endsAt: new Date(Date.now() - 1000).toISOString() },
    { code: 'FULL', percentOff: 25, active: true, uses: 10, maxUses: 10, endsAt: null },
  ]);

  assert.deepEqual(
    { ok: sales.saleState('OFF').ok, percent: sales.saleState('OFF').percentOff },
    { ok: true, percent: 25 }
  );
  assert.equal(sales.saleState('MISSING').reason, 'not_found');
  assert.equal(sales.saleState('PAUSED').reason, 'disabled');
  assert.equal(sales.saleState('SOON').reason, 'not_started');
  assert.equal(sales.saleState('GONE').reason, 'expired');
  assert.equal(sales.saleState('FULL').reason, 'maxed');
  assert.ok(sales.saleReasonText('expired').length > 0);
  assert.ok(sales.saleReasonText('whatever').includes('valid')); // fallback
});

test('toggleSale pauses, deleteSale removes', () => {
  const paused = sales.toggleSale('OFF');
  assert.equal(paused.active, false);
  assert.equal(sales.saleState('OFF').reason, 'disabled');
  assert.equal(sales.toggleSale('OFF').active, true);

  assert.equal(sales.deleteSale('GONE'), true);
  assert.equal(sales.deleteSale('GONE'), false); // already gone
  assert.equal(sales.saleState('GONE').reason, 'not_found');
  writeCodes([]);
});

// ── Redemption ───────────────────────────────────────────────
test('redeemSale burns uses until the cap hits maxed', () => {
  sales.createSale({ code: 'ONCE', percentOff: 10, maxUses: 1 });
  assert.equal(sales.saleState('ONCE').ok, true);

  assert.equal(sales.redeemSale('ONCE'), true);
  assert.equal(sales.getSale('ONCE').uses, 1);
  assert.equal(sales.saleState('ONCE').reason, 'maxed');
  assert.equal(sales.redeemSale('NOSUCH'), false);
});

test('discountAmount rounds and refuses nonsense', () => {
  assert.equal(sales.discountAmount(500, 20), 100);
  assert.equal(sales.discountAmount(230, 33), 76); // 75.9 → 76
  assert.equal(sales.discountAmount(100, 0), 0);
  assert.equal(sales.discountAmount(0, 20), 0);
  assert.equal(sales.discountAmount(-5, 20), 0);
});

// ── The one checkout resolver ────────────────────────────────
test('promo session round-trips through set/current/clear', () => {
  assert.equal(sales.currentPromo(JID), null);
  sales.setPromo(JID, ' eid20 ');
  assert.equal(sales.currentPromo(JID), 'EID20');
  sales.clearPromo(JID);
  assert.equal(sales.currentPromo(JID), null);
});

test('discountFor prefers the sale code over loyalty (both catalogues)', () => {
  sales.createSale({ code: 'EID20', percentOff: 20 });
  sales.setPromo(JID, 'EID20');
  // The customer also holds a 10% loyalty reward.
  users.setProfile(JID, { discount: { code: 'LOYAL10', percent: 10, used: false, expiry: Date.now() + 86_400_000 } });

  const esim = sales.discountFor(JID, { catalog: 'esim', pricePkr: 500 });
  assert.deepEqual(esim, { code: 'EID20', percent: 20, amount: 100, source: 'sale' });

  const digital = sales.discountFor(JID, { catalog: 'digital', pricePkr: 500 });
  assert.deepEqual(digital, { code: 'EID20', percent: 20, amount: 100, source: 'sale' });
});

test('without a sale code: loyalty applies to eSIM only', () => {
  sales.clearPromo(JID);
  users.setProfile(JID, { discount: { code: 'LOYAL10', percent: 10, used: false, expiry: Date.now() + 86_400_000 } });

  const esim = sales.discountFor(JID, { catalog: 'esim', pricePkr: 500 });
  assert.deepEqual(esim, { code: 'LOYAL10', percent: 10, amount: 50, source: 'loyalty' });
  assert.equal(sales.discountFor(JID, { catalog: 'digital', pricePkr: 500 }), null);
});

test('a stale promo is dropped instead of silently ignored', () => {
  sales.setPromo(JID, 'DELETEDCODE');
  assert.equal(sales.discountFor(JID, { catalog: 'digital', pricePkr: 500 }), null);
  assert.equal(sales.currentPromo(JID), null); // cleared
  users.setProfile(JID, { discount: null });
});

test('no discount → null, never 0 or NaN', () => {
  assert.equal(sales.discountFor(JID, { catalog: 'esim', pricePkr: 500 }), null);
  assert.equal(sales.discountAmount(500, undefined), 0);
});
