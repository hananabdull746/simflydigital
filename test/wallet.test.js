// Unit tests for the Customer Wallet:
//   services/wallet.js (atomic balance + ledger + audit + rate limit)
//   → handlers/wallet.js flows (top-up credit/reject, refunds,
//     one-tap wallet payment with a double-tap guard)
//
// Run with:  node --test test/wallet.test.js
//
// Env overrides MUST run before any project module loads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.STORE_FILE = 'test/.tmp-wallet-store.json';
process.env.SESSIONS_FILE = 'test/.tmp-wallet-sessions.json';
process.env.USERS_FILE = 'test/.tmp-wallet-users.json';
process.env.ADMIN_STATE_FILE = 'test/.tmp-wallet-admin.json';
process.env.AUDIT_FILE = 'test/.tmp-wallet-audit.json';
process.env.WALLETS_FILE = 'test/.tmp-wallet-wallets.json';
process.env.WALLET_TX_FILE = 'test/.tmp-wallet-tx.json';
process.env.DIGITAL_OVERRIDES_FILE = 'test/.tmp-wallet-overrides.json';
process.env.DIGITAL_POLLS_FILE = 'test/.tmp-wallet-polls.json';
process.env.PAYMENTS_FILE = 'test/.tmp-wallet-payments.json';
process.env.BINANCE_TX_FILE = 'test/.tmp-wallet-binance.json';
process.env.USD_PKR_RATE = '278';
process.env.DIGITAL_MARKUP_PERCENT = '50';
process.env.PRODSELLER_API_KEY = 'test-key-do-not-log';
process.env.PRODSELLER_BASE_URL = 'https://prodseller.test/v1';
process.env.ADMIN_WHATSAPP_NUMBER = '030011122233';
process.env.CONFIRM_TWICE_ABOVE_PKR = '100';
process.env.WALLET_TOPUP_MIN = '100';
process.env.WALLET_TOPUP_MAX = '20000';
process.env.WALLET_TOPUP_MAX_ATTEMPTS = '5';
process.env.WALLET_TOPUP_WINDOW_MS = '600000';
delete process.env.ESIMACCESS_API_KEY;
delete process.env.ESIMACCESS_API_SECRET;
delete process.env.DASHBOARD_PORT;

try {
  for (const f of [
    '.tmp-wallet-store.json', '.tmp-wallet-sessions.json', '.tmp-wallet-users.json',
    '.tmp-wallet-admin.json', '.tmp-wallet-audit.json', '.tmp-wallet-wallets.json',
    '.tmp-wallet-tx.json', '.tmp-wallet-overrides.json', '.tmp-wallet-polls.json',
    '.tmp-wallet-payments.json', '.tmp-wallet-binance.json',
  ]) {
    fs.rmSync(new URL(`./${f}`, import.meta.url), { force: true });
  }
} catch { /* ignore */ }

const wallet = await import('../services/wallet.js');
const store = await import('../lib/store.js');
const walletHandlers = await import('../handlers/wallet.js');
const ps = await import('../services/prodseller.js');
const sessions = await import('../lib/sessions.js');
const { repromptScreenshot, askPaymentMethod } = await import('../handlers/payments.js');
const { SETTINGS, PAYMENT_METHODS } = await import('../config.js');

const now = () => new Date().toISOString();

/** Cheap recording socket — asserts read `sent`. */
function stubSock(sent) {
  return {
    sendMessage: async (jid, content) => {
      sent.push({ jid, content });
      return { key: { id: `m${sent.length}`, remoteJid: jid } };
    },
  };
}

const CID_A = '923001000001'; // ledger semantics
const CID_B = '923001000002'; // top-up credit / reject
const CID_C = '923001000003'; // wallet payment
const CID_D = '923001000004'; // chained shortfall top-up → resume
const CID_E = '923001000005'; // top-up credited with no checkout behind it
const CID_F = '923001000006'; // stale WTP reference must not be reused
const JID_C = `${CID_C}@s.whatsapp.net`;

/** One fake ProdSeller catalogue: prod-1 costs 625 PKR after markup. */
function stubDigitalCatalog() {
  ps.__setTransport(async (cfg) => {
    if (cfg.url.includes('/products/prod-1')) {
      return { status: 200, data: { data: { id: 'prod-1', name: 'Netflix 1 Month', price: 1.5, stock: 3, inStock: true } }, headers: {} };
    }
    if (cfg.url.includes('/balance')) return { status: 200, data: { data: { balance: 50 } }, headers: {} };
    if (cfg.url.includes('/products')) {
      return { status: 200, data: { products: [{ id: 'prod-1', name: 'Netflix 1 Month', price: 1.5, stock: 3, inStock: true }] }, headers: {} };
    }
    return { status: 404, data: {}, headers: {} };
  });
  ps.__clearCache();
}

/** `askTopupMethod` skips the details screen when only ONE method exists. */
async function runTopupToScreenshotStep(sock, jid, amount) {
  await walletHandlers.askTopupMethodPublic(sock, jid, amount);
  if (store.getUser(jid).flow !== 'await_screenshot') {
    await walletHandlers.sendTopupDetails(sock, jid, PAYMENT_METHODS[0].id);
  }
}

test('adjustBalance credits/debits atomically and mirrors the ledger', async () => {
  const up = await wallet.adjustBalance(CID_A, 1000, 'topup', { note: 'seed' });
  assert.equal(up.ok, true);
  assert.equal(up.balance, 1000);
  assert.equal(up.tx.balanceAfter, 1000);

  const down = await wallet.adjustBalance(CID_A, -400, 'order_payment', { relatedOrderId: 'SMF-0001' });
  assert.equal(down.ok, true);
  assert.equal(down.balance, 600);

  const rows = wallet.ledgerFor(CID_A);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].amountPkr, -400, 'newest row first');
  assert.equal(rows[0].balanceAfter, 600);
  assert.equal(wallet.getBalance(CID_A), 600);
});

test('a balance can NEVER go negative', async () => {
  const nope = await wallet.adjustBalance(CID_A, -999, 'order_payment');
  assert.equal(nope.ok, false);
  assert.equal(nope.code, 'INSUFFICIENT_FUNDS');
  assert.equal(nope.balance, 600, 'balance untouched');
  assert.equal(wallet.ledgerFor(CID_A).length, 2, 'no ledger row for a rejected debit');

  const bad = await wallet.adjustBalance(CID_A, 0, 'topup');
  assert.equal(bad.code, 'BAD_AMOUNT');
  const badId = await wallet.adjustBalance('', 100, 'topup');
  assert.equal(badId.code, 'BAD_CUSTOMER');
});

test('audit: stored balance always equals the ledger sum', async () => {
  const audit = wallet.auditWallets();
  assert.equal(audit.ok, true, JSON.stringify(audit.issues));
  assert.ok(audit.checked >= 1);
  assert.equal(wallet.totalLiability(), wallet.getBalance(CID_A));
});

test('top-up attempts are rate-limited per customer', () => {
  wallet.__resetTopupAttempts();
  assert.equal(wallet.topupAllowed(CID_A, 3, 600_000), true);
  wallet.recordTopupAttempt(CID_A);
  wallet.recordTopupAttempt(CID_A);
  wallet.recordTopupAttempt(CID_A);
  assert.equal(wallet.topupAllowed(CID_A, 3, 600_000), false, 'third attempt used up the window');
  assert.equal(wallet.topupAllowed('923009999999', 3, 600_000), true, 'other customers unaffected');
  wallet.__resetTopupAttempts();
  assert.equal(wallet.topupAllowed(CID_A, 3, 600_000), true);
});

test('nextTopupId hands out WTP-XXXX (separate from SMF orders)', () => {
  const a = store.nextTopupId();
  const b = store.nextTopupId();
  assert.match(a, /^WTP-\d{4}$/);
  assert.match(b, /^WTP-\d{4}$/);
  assert.notEqual(a, b);
});

test('admin credits a verified top-up → balance + fulfilled order', async () => {
  const sent = [];
  const sock = stubSock(sent);

  const id = store.nextTopupId();
  store.putOrder({
    id,
    jid: `${CID_B}@s.whatsapp.net`,
    phone: CID_B,
    catalogType: 'wallet_topup',
    planName: 'Wallet Top-up',
    price: 500,
    paymentLabel: '💸 JazzCash',
    status: 'pending_admin',
    paidBy: null,
    createdAt: now(),
    updatedAt: now(),
  });
  store.flush();

  const res = await walletHandlers.creditTopup(sock, id, 'test-admin');
  assert.equal(res.ok, true, res.message);
  assert.equal(wallet.getBalance(CID_B), 500);

  const order = store.getOrder(id);
  assert.equal(order.status, 'fulfilled');
  assert.equal(order.paidBy, 'topup');
  assert.equal(order.walletCredited, true);
  assert.equal(order.confirmedBy, 'test-admin');

  const row = wallet.ledgerFor(CID_B)[0];
  assert.equal(row.type, 'topup');
  assert.equal(row.relatedOrderId, id);
  assert.equal(row.actor, 'test-admin');

  // Customer was told the new balance.
  assert.ok(sent.some((m) => m.jid === `${CID_B}@s.whatsapp.net`));

  // Second tap must NOT credit twice.
  const again = await walletHandlers.creditTopup(sock, id, 'test-admin');
  assert.equal(again.ok, false);
  assert.equal(wallet.getBalance(CID_B), 500, 'credited exactly once');
});

test('rejecting a top-up moves NO money', async () => {
  const sent = [];
  const sock = stubSock(sent);
  const before = wallet.getBalance(CID_B);

  const id = store.nextTopupId();
  store.putOrder({
    id,
    jid: `${CID_B}@s.whatsapp.net`,
    phone: CID_B,
    catalogType: 'wallet_topup',
    planName: 'Wallet Top-up',
    price: 1500,
    paymentLabel: '💳 Easypaisa',
    status: 'pending_admin',
    createdAt: now(),
    updatedAt: now(),
  });
  store.flush();

  const res = await walletHandlers.rejectTopup(sock, id, 'screenshot not verified', 'test-admin');
  assert.equal(res.ok, true);
  assert.equal(store.getOrder(id).status, 'rejected');
  assert.equal(wallet.getBalance(CID_B), before, 'balance unchanged');
  assert.equal(wallet.ledgerFor(CID_B).length, 1, 'no new ledger row');
});

test('a failed paid order refunds straight back to the wallet', async () => {
  const sent = [];
  const sock = stubSock(sent);
  const before = wallet.getBalance(CID_A); // 600

  const order = {
    id: 'SMF-0002',
    jid: `${CID_A}@s.whatsapp.net`,
    phone: CID_A,
    catalogType: 'digital',
    planName: 'Netflix 1 Month',
    price: 300,
    paidBy: 'wallet',
    status: 'failed',
    createdAt: now(),
    updatedAt: now(),
  };
  store.putOrder(order);
  store.flush();

  const res = await walletHandlers.refundOrderToWallet(sock, `${CID_A}@s.whatsapp.net`, 'SMF-0002');
  assert.ok(String(res.message || res).includes('refund'), JSON.stringify(res));
  assert.equal(wallet.getBalance(CID_A), before + 300);
  assert.equal(store.getOrder('SMF-0002').status, 'refunded');
  assert.equal(store.getOrder('SMF-0002').refundedVia, 'wallet');
  assert.equal(wallet.ledgerFor(CID_A)[0].type, 'refund');

  // Customer got the refund receipt.
  assert.ok(sent.some((m) => m.jid === `${CID_A}@s.whatsapp.net`));

  // Refunding the same order twice must not double-credit.
  const sentBefore = sent.length;
  await walletHandlers.refundOrderToWallet(sock, `${CID_A}@s.whatsapp.net`, 'SMF-0002');
  assert.match(JSON.stringify(sent.slice(sentBefore)), /pehle hi wallet me refund/i);
  assert.equal(wallet.getBalance(CID_A), before + 300);
});

test('walletCheckoutInfo reports the shortfall when the balance is low', async () => {
  const sent = [];
  const sock = stubSock(sent);

  // Fake ProdSeller catalogue: one product worth 625 PKR after markup.
  ps.__setTransport(async (cfg) => {
    if (cfg.url.includes('/products/prod-1')) {
      return { status: 200, data: { data: { id: 'prod-1', name: 'Netflix 1 Month', price: 1.5, stock: 3, inStock: true } }, headers: {} };
    }
    if (cfg.url.includes('/balance')) return { status: 200, data: { data: { balance: 50 } }, headers: {} };
    if (cfg.url.includes('/products')) {
      return { status: 200, data: { products: [{ id: 'prod-1', name: 'Netflix 1 Month', price: 1.5, stock: 3, inStock: true }] }, headers: {} };
    }
    return { status: 404, data: {}, headers: {} };
  });
  ps.__clearCache();

  store.setUser(JID_C, { dpId: 'prod-1', planId: null, orderId: null, flow: null });
  const info = await walletHandlers.walletCheckoutInfo(JID_C);
  assert.equal(info.enabled, true);
  assert.equal(info.item.catalog, 'digital');
  assert.equal(info.item.price, 625); // 1.5 × 278 × 1.50 → roundPkr
  assert.equal(info.balancePkr, 0);
  assert.equal(info.enough, false);
  assert.equal(info.shortfallPkr, 625);

  // The not-enough screen offers a "top up & continue" shortcut.
  await walletHandlers.payFromWallet(sock, JID_C);
  assert.ok(sent.some((m) => JSON.stringify(m.content).includes('Wallet balance kam')));
  assert.ok(sent.some((m) => JSON.stringify(m.content).includes('wallet_short:625')));
});

test('one-tap wallet payment: atomic debit, double-tap deducted ONCE', async () => {
  const sent = [];
  const sock = stubSock(sent);

  // Fund the wallet well above the product price.
  await wallet.adjustBalance(CID_C, 2000, 'topup', { note: 'seed for payment test' });
  const before = wallet.getBalance(CID_C);

  const first = await walletHandlers.confirmWalletPay(sock, JID_C);
  assert.equal(first?.ok, true, JSON.stringify(first));
  assert.equal(wallet.getBalance(CID_C), before - 625, 'deducted exactly once');

  const user = store.getUser(JID_C);
  assert.ok(user.orderId, 'an order id was minted');
  const order = store.getOrder(user.orderId);
  assert.equal(order.paidBy, 'wallet');
  assert.equal(order.status, 'pending_admin', 'high value → waits for admin ✅');
  assert.equal(order.catalogType, 'digital');
  assert.equal(order.productId, 'prod-1');
  assert.equal(order.price, 625);

  // The debit is a real ledger row tied to the order.
  const row = wallet.ledgerFor(CID_C)[0];
  assert.equal(row.type, 'order_payment');
  assert.equal(row.amountPkr, -625);
  assert.equal(row.relatedOrderId, order.id);

  // Admin was notified (payment already done — no screenshot).
  assert.ok(sent.some((m) => m.jid.includes('9230011122233')), 'admin card sent');

  // Second tap: no second deduction, no second order.
  const ordersBefore = store.allOrders().length;
  await walletHandlers.confirmWalletPay(sock, JID_C);
  assert.equal(wallet.getBalance(CID_C), before - 625, 'second tap deducted nothing');
  assert.equal(store.allOrders().length, ordersBefore, 'no duplicate order');
  assert.ok(sent.some((m) => JSON.stringify(m.content).includes('pehle se process')));

  // Cleanup so later runs start from a clean cart.
  store.setUser(JID_C, { dpId: null, planId: null, orderId: null, flow: null });
  store.flush();
  ps.__setTransport(null);
  ps.__clearCache();
});

test('liability label + wallet screen expose the money owed', async () => {
  const sent = [];
  const sock = stubSock(sent);
  await walletHandlers.sendWallet(sock, `${CID_A}@s.whatsapp.net`);
  assert.ok(sent.some((m) => m.jid === `${CID_A}@s.whatsapp.net`));
  assert.ok(walletHandlers.liabilityLabel().includes('PKR'));
  assert.ok(wallet.totalLiability() > 0);
  assert.equal(wallet.auditWallets().ok, true, 'screens never drift from the ledger');
});

// ── Regression: "pay through wallet but it keeps asking for a
//    SadaPay screenshot" ─────────────────────────────────────────

test('a chained shortfall top-up resumes checkout instead of demanding another screenshot', async () => {
  assert.ok(PAYMENT_METHODS.length, 'a payment method is configured');
  const sent = [];
  const sock = stubSock(sent);
  const JID_D = `${CID_D}@s.whatsapp.net`;
  stubDigitalCatalog();

  store.setUser(JID_D, { dpId: 'prod-1', planId: null, orderId: null, flow: null, choices: null });

  // The shopper lands on the payment screen with an empty wallet.
  await askPaymentMethod(sock, JID_D);
  await walletHandlers.payFromWallet(sock, JID_D);
  const short = (store.getUser(JID_D).choices || []).find((c) => c.id.startsWith('wallet_short:'));
  assert.ok(short, 'shortfall choice offered');
  assert.equal(wallet.getBalance(CID_D), 0);

  await walletHandlers.startTopup(sock, JID_D, { shortfall: Number(short.id.slice('wallet_short:'.length)) });
  assert.equal(sessions.getSession(JID_D)?.resumeAfterTopup, true, 'the checkout is remembered');

  await runTopupToScreenshotStep(sock, JID_D, 700);
  const topup = store.allOrders().filter((o) => o.jid === JID_D && o.catalogType === 'wallet_topup').pop();
  assert.ok(topup, 'top-up order created');

  // Admin verifies the money → the customer must land back on the
  // payment screen, NOT on the top-up's screenshot step.
  const before = sent.length;
  const res = await walletHandlers.creditTopup(sock, topup.id, 'test-admin');
  assert.equal(res.ok, true, res.message);
  const after = sent.slice(before);
  assert.ok(after.some((m) => JSON.stringify(m.content).includes('Payment Method')),
    'back at the payment screen');
  assert.ok(!after.some((m) => JSON.stringify(m.content).includes('screenshot chahiye')),
    `never demands a screenshot again: ${JSON.stringify(after.map((m) => m.content))}`);
  assert.equal(store.getUser(JID_D).flow, 'choose_payment');
  assert.equal(store.getUser(JID_D).orderId, null, 'the WTP reference was released');
  assert.equal(sessions.getSession(JID_D)?.step, 'payment');
  assert.equal(wallet.getBalance(CID_D), 700);

  // …and the very next tap pays from the wallet.
  const paid = await walletHandlers.confirmWalletPay(sock, JID_D);
  assert.equal(paid?.ok, true, JSON.stringify(paid));
  const order = store.getOrder(store.getUser(JID_D).orderId);
  assert.equal(order.paidBy, 'wallet');
  assert.equal(wallet.getBalance(CID_D), 700 - 625);
  assert.equal(store.getOrder(topup.id).catalogType, 'wallet_topup',
    'the purchase never overwrites the top-up record');

  store.setUser(JID_D, { dpId: null, planId: null, orderId: null, flow: null });
  store.flush();
  ps.__setTransport(null);
  ps.__clearCache();
});

test('a top-up credited with no checkout behind it releases the screenshot step', async () => {
  assert.ok(PAYMENT_METHODS.length, 'a payment method is configured');
  const sent = [];
  const sock = stubSock(sent);
  const JID_E = `${CID_E}@s.whatsapp.net`;

  store.setUser(JID_E, { flow: null, orderId: null, choices: null });
  await walletHandlers.startTopup(sock, JID_E, { skipGuard: true });
  await runTopupToScreenshotStep(sock, JID_E, 500);
  assert.equal(store.getUser(JID_E).flow, 'await_screenshot');

  const topup = store.allOrders().filter((o) => o.jid === JID_E && o.catalogType === 'wallet_topup').pop();
  const credited = await walletHandlers.creditTopup(sock, topup.id, 'test-admin');
  assert.equal(credited.ok, true, credited.message);

  assert.notEqual(store.getUser(JID_E).flow, 'await_screenshot', 'left the screenshot step');
  assert.equal(store.getUser(JID_E).orderId, null);
  assert.equal(wallet.getBalance(CID_E), 500);

  // Even a direct re-ask must not loop on a top-up that is settled.
  sent.length = 0;
  await repromptScreenshot(sock, JID_E);
  assert.ok(!JSON.stringify(sent).includes('screenshot chahiye'),
    JSON.stringify(sent.map((m) => m.content)));
});

test('a leftover top-up reference is never reused as the purchase Order ID', async () => {
  const sent = [];
  const sock = stubSock(sent);
  const JID_F = `${CID_F}@s.whatsapp.net`;
  stubDigitalCatalog();

  const wtp = store.nextTopupId();
  store.putOrder({
    id: wtp,
    jid: JID_F,
    phone: CID_F,
    catalogType: 'wallet_topup',
    planName: 'Wallet Top-up',
    price: 500,
    status: 'fulfilled',
    paidBy: 'topup',
    createdAt: now(),
    updatedAt: now(),
  });
  store.flush();
  store.setUser(JID_F, { dpId: 'prod-1', planId: null, orderId: wtp, flow: null, choices: null });
  await wallet.adjustBalance(CID_F, 3000, 'topup', { note: 'seed for stale-ref test' });

  const res = await walletHandlers.confirmWalletPay(sock, JID_F);
  assert.equal(res?.ok, true, JSON.stringify(res));
  assert.notEqual(store.getUser(JID_F).orderId, wtp, 'minted a fresh Order ID');
  assert.equal(store.getOrder(wtp).catalogType, 'wallet_topup', 'the credit record survived');
  assert.equal(store.getOrder(wtp).status, 'fulfilled');
  assert.equal(wallet.getBalance(CID_F), 3000 - 625);

  store.setUser(JID_F, { dpId: null, planId: null, orderId: null, flow: null });
  store.flush();
  ps.__setTransport(null);
  ps.__clearCache();
});
