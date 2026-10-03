// Unit tests for 💳 Binance Pay auto-verification:
//   services/binancePay.js     signed request building + normalization
//   services/binanceVerifier.js claim ledger, classify(), retry timing
//   handlers/payments.js       USDT screen, typed Transaction ID flow,
//                              shadow vs auto outcomes
//
// Run with:  node --test test/binance.test.js
//
// Env overrides MUST run before any project module loads.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

process.env.STORE_FILE = 'test/.tmp-bin-store.json';
process.env.SESSIONS_FILE = 'test/.tmp-bin-sessions.json';
process.env.USERS_FILE = 'test/.tmp-bin-users.json';
process.env.ADMIN_STATE_FILE = 'test/.tmp-bin-admin.json';
process.env.AUDIT_FILE = 'test/.tmp-bin-audit.json';
process.env.PAYMENTS_FILE = 'test/.tmp-bin-payments.json';
process.env.BROADCAST_FILE = 'test/.tmp-bin-broadcast.json';
process.env.BINANCE_TX_FILE = 'test/.tmp-bin-binance.json';
process.env.WALLETS_FILE = 'test/.tmp-bin-wallets.json';
process.env.WALLET_TX_FILE = 'test/.tmp-bin-wallettx.json';
process.env.BINANCE_API_KEY = 'test-api-key-do-not-log';
process.env.BINANCE_API_SECRET = 'test-api-secret-do-not-log';
process.env.BINANCE_PAY_ID = '9988776655';
process.env.BINANCE_VERIFIER_MODE = 'shadow';
process.env.USDT_PKR_RATE = '300';
process.env.BINANCE_RETRY_MS = '10';
process.env.BINANCE_MAX_WAIT_MS = '30';
process.env.BINANCE_MATCH_WINDOW_MIN = '60';
process.env.ADMIN_WHATSAPP_NUMBER = '030011122233';
process.env.MIN_REPLY_DELAY_MS = '0';
process.env.MAX_REPLY_DELAY_MS = '0';
process.env.DEBOUNCE_WINDOW_MS = '0';
delete process.env.ESIMACCESS_API_KEY;
delete process.env.ESIMACCESS_API_SECRET;
delete process.env.DASHBOARD_PORT;

try {
  for (const f of [
    '.tmp-bin-store.json', '.tmp-bin-sessions.json', '.tmp-bin-users.json',
    '.tmp-bin-admin.json', '.tmp-bin-audit.json', '.tmp-bin-payments.json',
    '.tmp-bin-broadcast.json', '.tmp-bin-binance.json', '.tmp-bin-wallets.json',
    '.tmp-bin-wallettx.json',
  ]) {
    fs.rmSync(new URL(`./${f}`, import.meta.url), { force: true });
  }
} catch { /* ignore */ }

const pay = await import('../services/binancePay.js');
const ver = await import('../services/binanceVerifier.js');
const payments = await import('../handlers/payments.js');
const store = await import('../lib/store.js');
const steps = await import('../lib/steps.js');
const orders = await import('../handlers/orders.js');
const adminPanel = await import('../handlers/adminPanel.js');
const wallet = await import('../handlers/wallet.js');
const walletSvc = await import('../services/wallet.js');
const ui = await import('../handlers/ui.js');
const { BINANCE_PAY, PAYMENT_METHODS, ADMIN_JID, jidUser } = await import('../config.js');

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

const bodyOf = (sent, i = sent.length - 1) =>
  String(sent[i]?.content?.text ?? sent[i]?.content?.caption ?? '');

/** Everything one chat received, joined. */
const said = (sent, jid) =>
  sent.filter((s) => s.jid === jid).map((s) => bodyOf(sent, sent.indexOf(s))).join('\n');

/** Binance API row (as /sapi/v1/pay/transactions returns it). */
function apiRow(overrides = {}) {
  return {
    orderType: 'PAYMENT',
    transactionId: 'M_P_1',
    transactionTime: Date.now(),
    amount: '5.00000000',
    currency: 'USDT',
    walletType: 'PAY',
    ...overrides,
  };
}

/** Envelope + transport stub that always answers `rows`. */
function stubTransport(rows, state = {}) {
  pay.__setTransport(async (cfg) => {
    state.calls = (state.calls || 0) + 1;
    state.lastUrl = cfg.url;
    return { status: 200, data: { code: '000000', message: 'success', data: rows }, headers: {} };
  });
}

/** One checkout sitting on the USDT screen (plan_6gb = PKR 1,500). */
async function checkout(sock, jid) {
  store.setUser(jid, { planId: 'plan_6gb', dpId: null, orderId: null });
  await payments.sendPaymentDetails(sock, jid, 'pay_binancepay');
  const user = store.getUser(jid);
  return store.getOrder(user.orderId);
}

const JID_A = '923002000001@s.whatsapp.net'; // shadow flow
const JID_B = '923002000002@s.whatsapp.net'; // auto flow (wallet top-up)
const JID_C = '923002000003@s.whatsapp.net'; // mismatch
const JID_D = '923002000004@s.whatsapp.net'; // screen assertions

after(() => {
  pay.__setTransport(null);
  pay.__setSleep(null);
  pay.__reset();
  ver.__setSleep(null);
  ver.__resetVerifying();
  orders.__clearReminders();
  BINANCE_PAY.mode = 'shadow';
});

// ── signing ───────────────────────────────────────────────────
test('signQuery percent-encodes the payload BEFORE signing it', () => {
  const q = pay.signQuery({ startTime: 1700000000000, note: 'a b' }, 'secret');
  const [payload, signature] = q.split('&signature=');
  assert.equal(payload, 'startTime=1700000000000&note=a%20b', 'RFC 3986 encoding, never +');
  assert.ok(!payload.includes('+'), 'spaces must not become +');
  const expected = crypto.createHmac('sha256', 'secret').update(payload).digest('hex');
  assert.equal(signature, expected, 'HMAC is computed over the ENCODED string');
});

test('rfc3986 escapes !\'()* and drops empty params', () => {
  assert.equal(pay.rfc3986("!'()*"), '%21%27%28%29%2A');
  assert.equal(pay.rfc3986('a b'), 'a%20b');
  assert.equal(pay.buildQuery({ a: 1, b: '', c: null, d: 'x' }), 'a=1&d=x');
});

test('a 429 backs off (Retry-After) and retries exactly once', async () => {
  pay.__reset();
  const slept = [];
  pay.__setSleep(async (ms) => { slept.push(ms); });
  let calls = 0;
  pay.__setTransport(async () => {
    calls += 1;
    if (calls === 1) {
      const err = new Error('rate limited');
      err.response = { status: 429, headers: { 'retry-after': '1' }, data: { msg: 'slow down' } };
      throw err;
    }
    return { status: 200, data: { code: '000000', message: 'success', data: [apiRow()] }, headers: {} };
  });

  const res = await pay.getPayTransactions({ startTime: 1, endTime: 2 });
  assert.equal(res.ok, true);
  assert.equal(calls, 2, 'one retry after the 429');
  assert.deepEqual(slept, [1000], 'Retry-After: 1s → 1000ms, nothing else');

  pay.__setTransport(null);
  pay.__setSleep(null);
  pay.__reset();
});

test('a full page slides the window back instead of stopping at 100', async () => {
  pay.__reset();
  const base = Date.now();
  const page1 = Array.from({ length: 100 }, (_, i) => apiRow({
    transactionId: `M_P_P1_${i}`,
    transactionTime: base - (i + 1) * 1000,
  }));
  const page2 = [apiRow({ transactionId: 'M_P_P2_0', transactionTime: base - 200_000 })];
  let calls = 0;
  pay.__setTransport(async () => {
    calls += 1;
    return {
      status: 200,
      data: { code: '000000', message: 'success', data: calls === 1 ? page1 : page2 },
      headers: {},
    };
  });

  const res = await pay.findWindow({ startTime: base - 3600_000, endTime: base });
  assert.equal(res.ok, true);
  assert.equal(res.truncated, false);
  assert.equal(res.transactions.length, 101);
  assert.equal(calls, 2, 'second page requested with a narrower window');
  pay.__setTransport(null);
  pay.__reset();
});

test('normalizeTx keeps the signed amount, ms timestamp and note field', () => {
  const inn = pay.normalizeTx(apiRow({ amount: '+10.50000000', note: 'rent' }));
  assert.equal(inn.amount, 10.5, 'the + sign from Binance becomes a plain number');
  assert.equal(inn.currency, 'USDT');
  assert.ok(Number.isFinite(inn.time), 'transactionTime survives as epoch ms');
  assert.equal(inn.counterpartyNote, 'rent', 'note/counterpartyNote read defensively');

  const out = pay.normalizeTx(apiRow({ amount: '-3.25', note: undefined }));
  assert.equal(out.amount, -3.25, 'outgoing money keeps its minus sign');
  assert.equal(out.counterpartyNote, null);
  assert.equal(pay.maskId('9988776655'), '9988…6655', 'ids are masked for display');
});

// ── classification ────────────────────────────────────────────
test('expectedUsdt rounds PKR → USDT to 2 dp at the configured rate', () => {
  assert.equal(ver.expectedUsdt({ paidAmount: 3000 }), 10);
  assert.equal(ver.expectedUsdt({ paidAmount: 1000 }), 3.33, '1000/300 rounds down');
  assert.equal(ver.expectedUsdt({ paidAmount: 1004 }), 3.35, 'half-up rounding at the 3rd dp');
  assert.equal(ver.expectedUsdt({ paidAmount: 0 }), 0, 'no payable amount → 0');
  assert.equal(ver.roundUsdt(3.3351), 3.34);
});

test('classify() covers match / amount / currency / outgoing / window / claimed', () => {
  const order = { id: 'SMF-CLF', paidAmount: 1500 }; // 5.00 USDT
  const t0 = Date.now();
  const clean = (patch = {}) => ({
    transactionId: 'M_P_CLF',
    amount: 5,
    currency: 'USDT',
    time: t0,
    ...patch,
  });

  assert.equal(ver.classify({ order, transaction: clean(), now: t0 }).status, 'match');
  assert.equal(ver.classify({ order, transaction: clean({ amount: 5.005 }), now: t0 }).status, 'match',
    '±0.01 USDT of rounding tolerance is a match');
  assert.equal(ver.classify({ order, transaction: clean({ amount: 5.02 }), now: t0 }).status, 'amount_mismatch');
  assert.equal(ver.classify({ order, transaction: clean({ currency: 'BTC' }), now: t0 }).status, 'currency_mismatch');
  assert.equal(ver.classify({ order, transaction: clean({ amount: -5 }), now: t0 }).status, 'outgoing');
  assert.equal(ver.classify({ order, transaction: clean({ time: t0 - 4 * 3600_000 }), now: t0 }).status, 'time_window');
  assert.equal(ver.classify({ order, transaction: null, now: t0 }).status, 'not_found');
  assert.equal(ver.classify({ order, transaction: clean({ amount: 0 }), now: t0 }).status, 'outgoing');

  // Already used by another order.
  ver.upsertSeen(clean());
  assert.equal(ver.claimTransaction('M_P_CLF', 'SMF-OTHER', 'test').ok, true);
  const taken = ver.classify({ order, transaction: clean(), now: t0 });
  assert.equal(taken.status, 'already_claimed');
  assert.equal(taken.claimedBy, 'SMF-OTHER');
});

test('one payment can only ever be claimed by ONE order', () => {
  const tx = {
    transactionId: 'M_P_CLAIM_1',
    amount: 5,
    currency: 'USDT',
    time: Date.now(),
  };
  ver.upsertSeen(tx);

  assert.equal(ver.claimTransaction('M_P_CLAIM_1', 'SMF-CLAIM-A', 'auto').ok, true);
  const again = ver.claimTransaction('M_P_CLAIM_1', 'SMF-CLAIM-B', 'auto');
  assert.equal(again.ok, false, 'a second order can never take the same payment');
  assert.equal(again.reason, 'already_claimed');
  assert.equal(again.orderId, 'SMF-CLAIM-A');
  // Re-claiming your own order is idempotent.
  assert.equal(ver.claimTransaction('M_P_CLAIM_1', 'SMF-CLAIM-A', 'auto').ok, true);

  // A later refresh from Binance must NOT wipe the claim.
  ver.upsertSeen({ ...tx, amount: 5, counterpartyNote: 'refreshed' });
  assert.equal(ver.getTransaction('M_P_CLAIM_1').orderId, 'SMF-CLAIM-A');
  assert.equal(ver.getTransaction('M_P_CLAIM_1').status, 'claimed');

  assert.equal(ver.releaseTransaction('M_P_CLAIM_1'), true);
  assert.equal(ver.getTransaction('M_P_CLAIM_1').status, 'unclaimed');
  assert.equal(ver.claimTransaction('M_P_CLAIM_1', 'SMF-CLAIM-C', 'test').ok, true);
});

// ── retry loop ────────────────────────────────────────────────
test('retry: not_found is retried on schedule, pings ONCE, then gives up', async () => {
  const sleeps = [];
  let pings = 0;
  const out = await ver.verifyWithRetry({
    order: { id: 'SMF-T1', paidAmount: 1500 },
    txId: 'M_P_T1',
    onProgress: async (kind) => { if (kind === 'still') pings += 1; },
    deps: {
      retryMs: 10,
      maxWaitMs: 30,
      sleep: async (ms) => { sleeps.push(ms); },
      lookup: async () => ({ ok: true, transaction: null }),
    },
  });

  assert.equal(out.status, 'timeout');
  assert.equal(out.attempts, 4, 'immediate + one per 10ms until the 30ms budget is spent');
  assert.deepEqual(sleeps, [10, 10, 10]);
  assert.equal(out.waitedMs, 30);
  assert.equal(pings, 1, 'exactly one "still checking" message');
});

test('retry: settles on the third attempt once Binance catches up', async () => {
  const order = { id: 'SMF-T2', paidAmount: 1500 };
  const tx = { transactionId: 'M_P_T2', amount: 5, currency: 'USDT', time: Date.now() };
  let calls = 0;
  const out = await ver.verifyWithRetry({
    order,
    txId: 'M_P_T2',
    deps: {
      retryMs: 1,
      maxWaitMs: 5_000,
      sleep: async () => {},
      lookup: async () => {
        calls += 1;
        return calls < 3 ? { ok: true, transaction: null } : { ok: true, transaction: tx };
      },
    },
  });

  assert.equal(out.status, 'match');
  assert.equal(out.attempts, 3);
  assert.equal(calls, 3);
  assert.equal(ver.getTransaction('M_P_T2').status, 'unclaimed', 'seen, but not claimed yet');
});

test('a terminal failure stops retrying immediately', async () => {
  let calls = 0;
  const out = await ver.verifyWithRetry({
    order: { id: 'SMF-T3', paidAmount: 1500 },
    txId: 'M_P_T3',
    deps: {
      retryMs: 10,
      maxWaitMs: 5_000,
      sleep: async () => { throw new Error('must not sleep'); },
      lookup: async () => {
        calls += 1;
        return { ok: true, transaction: { transactionId: 'M_P_T3', amount: 9, currency: 'USDT', time: Date.now() } };
      },
    },
  });
  assert.equal(out.status, 'amount_mismatch');
  assert.equal(calls, 1, 'an amount mismatch can never fix itself');
  assert.equal(out.waitedMs, 0);
});

test('the lookup is skipped entirely without an API key', async () => {
  const key = BINANCE_PAY.apiKey;
  BINANCE_PAY.apiKey = '';
  let calls = 0;
  const out = await ver.verifyWithRetry({
    order: { id: 'SMF-T4', paidAmount: 1500 },
    txId: 'M_P_T4',
    deps: { sleep: async () => { calls += 1; }, lookup: async () => { calls += 1; return { ok: true, transaction: null }; } },
  });
  BINANCE_PAY.apiKey = key;
  assert.equal(out.status, 'not_configured');
  assert.equal(out.attempts, 0);
  assert.equal(calls, 0, 'no API call, no sleeping');
  assert.equal(pay.isConfigured(), true, 'pay id + key restored');
});

// ── checkout screen ───────────────────────────────────────────
test('the method only appears when BINANCE_PAY_ID is set', () => {
  assert.ok(PAYMENT_METHODS.some((m) => m.id === 'pay_binancepay'), 'configured in this test env');
  assert.equal(pay.isConfigured(), true);
  const id = BINANCE_PAY.payId;
  BINANCE_PAY.payId = '';
  assert.equal(pay.isConfigured(), false, 'no Pay ID → not configured');
  BINANCE_PAY.payId = id;
});

test('the USDT screen shows the Pay ID and amount, never PKR', async () => {
  const sent = [];
  const sock = stubSock(sent);
  const order = await checkout(sock, JID_D);

  assert.equal(order.paymentId, 'pay_binancepay');
  assert.equal(order.binance.expectedUsdt, 5, 'PKR 1,500 @ 300 = 5.00 USDT');
  assert.equal(order.binance.payId, BINANCE_PAY.payId);
  assert.equal(order.status, 'await_screenshot', 'still waiting for payment proof');
  assert.equal(store.getUser(JID_D).flow, 'await_binance_tx');

  const text = bodyOf(sent);
  assert.match(text, /Pay exactly \*5\.00 USDT\*/);
  assert.ok(text.includes(BINANCE_PAY.payId), 'the Pay ID customers pay INTO');
  assert.ok(text.includes('Binance Transaction ID'), 'tells them what to send back');
  assert.ok(text.includes('Step 2 of 2: Binance Transaction ID'), 'progress line relabelled');
  assert.ok(!text.includes('PKR'), 'this method is quoted in USDT only');

  const choices = store.getUser(JID_D).choices.map((c) => c.id);
  assert.ok(choices.includes('change_payment'));
  assert.ok(choices.includes('cancel_order'), 'the standard exits stay available');
});

test('typed junk on the USDT screen is NOT mistaken for a transaction id', () => {
  assert.equal(payments.extractTxId('M_P_71505104267788288'), 'M_P_71505104267788288');
  assert.equal(payments.extractTxId('  M_P_71505104267788288 '), 'M_P_71505104267788288');
  assert.equal(payments.extractTxId('Transaction ID: M_P_123456789012345'), 'M_P_123456789012345');
  assert.equal(payments.extractTxId('my txid is 71505104267788288 ok'), null,
    'a whole sentence is never squashed into one fake id');
  assert.equal(payments.extractTxId('menu'), null, 'a command is never an id');
  assert.equal(payments.extractTxId('change payment'), null);
  assert.equal(payments.extractTxId('03001234567'), null, 'an 11-digit phone number is not an id');
  assert.equal(payments.extractTxId(''), null);
  assert.equal(payments.extractTxId('cancel'), null);
});

test('only the binance flow relabels the payment step', () => {
  assert.equal(steps.withStep('payment', 'x'), 'Step 2 of 2: Pay\nx');
  assert.equal(steps.withStep('payment', 'x', { binance: true }), 'Step 2 of 2: Binance Transaction ID\nx');
  assert.equal(steps.withStep('product_qty', 'x', { binance: true }), 'Step 1 of 2: Choose & Confirm\nx');
  assert.equal(steps.stepPrefix('payment'), 'Step 2 of 2: Pay');
  assert.equal(steps.stepPrefix('payment', { binance: true }), 'Step 2 of 2: Binance Transaction ID');
});

// ── the flow itself ───────────────────────────────────────────
test('shadow mode: a clean match is claimed, reported, and left for the admin', async () => {
  const sent = [];
  const sock = stubSock(sent);
  const order = await checkout(sock, JID_A);
  stubTransport([apiRow({ transactionId: 'M_P_SHADOW_1', amount: '5.00000000' })]);
  BINANCE_PAY.mode = 'shadow';

  const taken = await payments.handleBinanceTx(sock, JID_A, 'M_P_SHADOW_1');
  assert.notEqual(taken, false, 'a real id is consumed by the flow');
  await payments.pendingVerification(order.id);

  const live = store.getOrder(order.id);
  assert.equal(live.status, 'pending_admin', 'shadow mode NEVER fulfils on its own');
  assert.equal(live.binance.txId, 'M_P_SHADOW_1');
  assert.equal(live.binance.verdict, 'match');
  assert.equal(live.binance.mode, 'shadow');
  assert.equal(store.getUser(JID_A).flow, 'pending_admin');

  const claim = ver.getTransaction('M_P_SHADOW_1');
  assert.equal(claim.status, 'claimed');
  assert.equal(claim.orderId, order.id);

  const customer = said(sent, JID_A);
  assert.ok(customer.includes('5.00 USDT'), 'customer is told the payment matched');
  const card = said(sent, ADMIN_JID);
  assert.ok(card, 'the admin gets the order card');
  assert.ok(card.includes(order.id));
  assert.ok(card.includes('Shadow mode'), 'the verdict rides along with the card');
  assert.ok(!card.includes('Screenshot image download nahi ho saka'), 'no bogus screenshot warning');

  // The admin card itself carries the tx + amount + verdict.
  const cardText = adminPanel.orderCard(store.getOrder(order.id));
  assert.ok(cardText.includes('M_P_SHADOW_1'));
  assert.ok(cardText.includes('match'));
  assert.ok(cardText.includes('5.00 USDT @ 300'), 'shows what we asked for');
  assert.ok(!cardText.includes('Auto-check'), 'NayaPay auto-check is not shown for Binance orders');

  pay.__setTransport(null);
});

test('auto mode: a clean match claims the payment and credits the order', async () => {
  const sent = [];
  const sock = stubSock(sent);
  const jid = JID_B;
  const id = store.nextOrderId();
  store.putOrder({
    id,
    jid,
    phone: '923002000002',
    name: 'Auto Test',
    catalogType: 'wallet_topup',
    planId: null,
    planName: 'Wallet Top-up',
    productId: null,
    quantity: 1,
    activationEmail: null,
    requiresEmailActivation: false,
    data: null,
    validity: null,
    price: 1500,
    discount: null,
    paidAmount: 1500,
    paymentId: 'pay_binancepay',
    paymentLabel: 'Binance Pay',
    binance: {
      txId: null,
      expectedUsdt: ver.expectedUsdt({ paidAmount: 1500 }),
      rate: BINANCE_PAY.usdtPkrRate,
      payId: BINANCE_PAY.payId,
      verdict: null,
      checkedAt: null,
    },
    paidBy: null,
    status: 'await_screenshot',
    screenshot: null,
    note: '',
    supplierOrderId: null,
    prodsellerOrderId: null,
    reminderAt: null,
    reminderSent: false,
    createdAt: now(),
    updatedAt: now(),
  });
  store.flush();
  store.setUser(jid, { flow: 'await_binance_tx', orderId: id, planId: null, dpId: null });

  stubTransport([apiRow({ transactionId: 'M_P_AUTO_1', amount: '5.00000000' })]);
  BINANCE_PAY.mode = 'auto';

  await payments.handleBinanceTx(sock, jid, 'M_P_AUTO_1');
  await payments.pendingVerification(id);

  const live = store.getOrder(id);
  assert.equal(live.status, 'fulfilled', 'auto mode settles a clean match by itself');
  assert.equal(live.binance.verdict, 'match');
  assert.equal(ver.getTransaction('M_P_AUTO_1').orderId, id);
  assert.equal(ver.getTransaction('M_P_AUTO_1').status, 'claimed');

  const auditText = JSON.stringify(store.allOrders().find((o) => o.id === id));
  assert.ok(auditText.includes('M_P_AUTO_1'));

  BINANCE_PAY.mode = 'shadow';
  pay.__setTransport(null);
});

test('a wrong amount NEVER auto-confirms — it falls back to the admin', async () => {
  const sent = [];
  const sock = stubSock(sent);
  const jid = JID_C;
  const order = await checkout(sock, jid); // wants 5.00 USDT
  stubTransport([apiRow({ transactionId: 'M_P_MISMATCH_1', amount: '7.00000000' })]);
  BINANCE_PAY.mode = 'auto';

  await payments.handleBinanceTx(sock, jid, 'M_P_MISMATCH_1');
  await payments.pendingVerification(order.id);

  const live = store.getOrder(order.id);
  assert.equal(live.status, 'pending_admin', 'the admin still has to decide');
  assert.equal(live.binance.verdict, 'amount_mismatch');
  const seen = ver.getTransaction('M_P_MISMATCH_1');
  assert.equal(seen.status, 'unclaimed', 'a rejected payment is never claimed');
  assert.equal(seen.orderId, null);

  const customer = said(sent, jid);
  assert.match(customer, /match nahi hua|Amount match/i);
  assert.ok(customer.includes('5.00'), 'the customer is told what we expected');

  BINANCE_PAY.mode = 'shadow';
  pay.__setTransport(null);
});

test('mode=off goes straight to the admin without calling Binance', async () => {
  const sent = [];
  const sock = stubSock(sent);
  const order = await checkout(sock, JID_D);
  let calls = 0;
  pay.__setTransport(async () => { calls += 1; return { status: 200, data: { data: [] }, headers: {} }; });
  BINANCE_PAY.mode = 'off';

  await payments.handleBinanceTx(sock, JID_D, 'M_P_OFF_1');
  await payments.pendingVerification(order.id);

  const live = store.getOrder(order.id);
  assert.equal(live.status, 'pending_admin');
  assert.equal(live.binance.verdict, 'mode_off');
  assert.equal(calls, 0, 'off means OFF — zero API traffic');
  assert.ok(sent.some((s) => s.jid === ADMIN_JID), 'the admin card still goes out');

  BINANCE_PAY.mode = 'shadow';
  pay.__setTransport(null);
});

test('the wallet top-up follows the same USDT flow and credits on match', async () => {
  const sent = [];
  const sock = stubSock(sent);
  const jid = '923002000005@s.whatsapp.net';

  store.setUser(jid, { topupAmount: 1500, flow: 'wallet_topup_method', orderId: null });
  await wallet.sendTopupDetails(sock, jid, 'pay_binancepay');

  const refId = store.getUser(jid).orderId;
  assert.ok(/^WTP-/.test(refId), 'top-ups keep their own WTP reference');
  assert.equal(store.getUser(jid).flow, 'await_binance_tx');
  let order = store.getOrder(refId);
  assert.equal(order.paymentId, 'pay_binancepay');
  assert.equal(order.catalogType, 'wallet_topup');
  assert.equal(order.binance.expectedUsdt, 5);

  const screen = said(sent, jid);
  assert.match(screen, /Pay exactly \*5\.00 USDT\*/);
  assert.ok(screen.includes(refId));
  assert.ok(screen.includes('Step 2 of 2: Binance Transaction ID'), 'relabelled here too');
  assert.ok(!screen.includes('PKR'), 'quoted in USDT, like the order checkout');

  // A command on this screen is still a command, never a payment.
  assert.equal(await payments.handleBinanceTx(sock, jid, 'menu'), false);

  stubTransport([apiRow({ transactionId: 'M_P_TOPUP_1', amount: '5.00000000' })]);
  BINANCE_PAY.mode = 'auto';
  await payments.handleBinanceTx(sock, jid, 'M_P_TOPUP_1');
  await payments.pendingVerification(refId);

  order = store.getOrder(refId);
  assert.equal(order.status, 'fulfilled', 'a clean match credits the top-up by itself');
  assert.equal(order.binance.verdict, 'match');
  assert.equal(order.confirmedBy, 'auto-binance-verifier');
  assert.equal(walletSvc.getBalance(jidUser(jid)), 1500, 'the ledger went up by the amount asked for');

  BINANCE_PAY.mode = 'shadow';
  pay.__setTransport(null);
});

test('the admin 💳 screen shows the Binance block and can fetch history', async () => {
  const sent = [];
  const sock = stubSock(sent);
  ui.setUiSocket(sock);

  await adminPanel.handleAdminId(sock, ADMIN_JID, { flow: 'admin' }, 'adm:pay');
  const screen = said(sent, ADMIN_JID);
  assert.ok(screen.includes('💳 *Payments*'), 'the payments screen opens');
  assert.ok(screen.includes('— 💳 Binance Pay —'), 'its own Binance block');
  assert.ok(screen.includes('9988…6655'), 'the Pay ID is masked');
  assert.ok(screen.includes('mode: *shadow*'), 'the rollout mode is visible');
  assert.ok(JSON.stringify(sent[sent.length - 1].content).includes('adm:btxrescan'), 'the fetch button is offered');
  assert.ok(store.getUser(ADMIN_JID).choices.some((c) => c.id === 'adm:btxrescan'), 'and typed as a choice');
  assert.ok(!screen.includes('test-api-key-do-not-log'), 'the API key never reaches the screen');

  stubTransport([apiRow({ transactionId: 'M_P_ADM_1', amount: '5.00000000' })]);
  await adminPanel.handleAdminId(sock, ADMIN_JID, { flow: 'admin' }, 'adm:btxrescan');
  const after = said(sent, ADMIN_JID);
  assert.ok(after.includes('✅ 1 transaction fetch hue'), `fetch result shown: ${after.slice(0, 200)}`);
  assert.ok(after.includes('M_P_ADM_1'), 'the fetched row is listed');
  assert.equal(ver.getTransaction('M_P_ADM_1').status, 'unclaimed');

  ui.setUiSocket(null);
  pay.__setTransport(null);
});
