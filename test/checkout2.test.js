// Part A — the TWO-step checkout:
//   Step 1 "Choose & Confirm" (device micro-check ONCE + quantity)
//   Step 2 "Pay"  →  post-checkout step `awaiting_confirmation`
//
// Covers: the eSIM quantity picker, MAX_QTY_ESIM clamping, the
// one-time confirmedUnlocked stamp, multi-unit confirmOrder
// (distinct supplier refs, partial failure + retry) and the
// resume-after-proof screen that never demands a screenshot twice.
//
// Run with:  node --test test/checkout2.test.js
//
// Env overrides MUST run before any project module loads.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.STORE_FILE = 'test/.tmp-c2-store.json';
process.env.SESSIONS_FILE = 'test/.tmp-c2-sessions.json';
process.env.USERS_FILE = 'test/.tmp-c2-users.json';
process.env.ADMIN_STATE_FILE = 'test/.tmp-c2-admin.json';
process.env.AUDIT_FILE = 'test/.tmp-c2-audit.json';
process.env.PAYMENTS_FILE = 'test/.tmp-c2-payments.json';
process.env.BINANCE_TX_FILE = 'test/.tmp-c2-binance.json';
process.env.WALLETS_FILE = 'test/.tmp-c2-wallets.json';
process.env.WALLET_TX_FILE = 'test/.tmp-c2-wallettx.json';
process.env.ALERTS_FILE = 'test/.tmp-c2-alerts.json';
process.env.BROADCAST_FILE = 'test/.tmp-c2-broadcast.json';
process.env.ADMIN_WHATSAPP_NUMBER = '030011122233';
process.env.MAX_QTY_ESIM = '3';
process.env.PAYMENT_SADAPAY_NUMBER = '03001234567';
process.env.PAYMENT_SADAPAY_TITLE = 'Simfly Test';
process.env.MIN_REPLY_DELAY_MS = '0';
process.env.MAX_REPLY_DELAY_MS = '0';
process.env.DEBOUNCE_WINDOW_MS = '0';
// The supplier is CONFIGURED on purpose: purchaseEsim must really run
// (against the injected transport) so the multi-unit loop is exercised.
process.env.ESIMACCESS_API_KEY = 'esim-test-key-do-not-log';
process.env.ESIMACCESS_API_SECRET = 'esim-test-secret-do-not-log';
process.env.ESIMACCESS_BASE_URL = 'https://esimaccess.test';
delete process.env.DASHBOARD_PORT;

try {
  for (const f of [
    '.tmp-c2-store.json', '.tmp-c2-sessions.json', '.tmp-c2-users.json',
    '.tmp-c2-admin.json', '.tmp-c2-audit.json', '.tmp-c2-payments.json',
    '.tmp-c2-binance.json', '.tmp-c2-wallets.json', '.tmp-c2-wallettx.json',
    '.tmp-c2-alerts.json', '.tmp-c2-broadcast.json',
  ]) {
    fs.rmSync(new URL(`./${f}`, import.meta.url), { force: true });
  }
} catch { /* ignore */ }

const steps = await import('../lib/steps.js');
const store = await import('../lib/store.js');
const users = await import('../lib/users.js');
const sessions = await import('../lib/sessions.js');
const plans = await import('../lib/plans.js');
const orders = await import('../handlers/orders.js');
const reviews = await import('../handlers/reviews.js');
const payments = await import('../handlers/payments.js');
const { checkoutItem, QTY_MAX_ESIM } = await import('../handlers/checkout.js');
const esim = await import('../services/esimaccess.js');
const { formatPrice } = await import('../config.js');

const JID = (n) => `92300900000${n}@s.whatsapp.net`;
const bodyOf = (m) => String(m?.content?.text ?? m?.content?.caption ?? '');

after(() => {
  esim.__setTransport(null);
  orders.__clearReminders();
  reviews.__clearReviewTimers();
});

/** Cheap recording socket — asserts read `sent`. */
function stubSock(sent) {
  return {
    sendMessage: async (jid, content) => {
      sent.push({ jid, content });
      return { key: { id: `m${sent.length}`, remoteJid: jid } };
    },
  };
}

/** The last LIST message captured (interactive list shape). */
function lastList(sent) {
  for (let i = sent.length - 1; i >= 0; i -= 1) {
    if (Array.isArray(sent[i].content?.sections)) return sent[i].content;
  }
  return null;
}
const renderedIds = (list) => list.sections.flatMap((s) => s.rows || []).map((r) => r.rowId);
const rowsOf = (list) => list.sections.flatMap((s) => s.rows || []);

/** Drive Step 1 up to the quantity picker (device NOT yet confirmed). */
async function toQuantity(sent, sock, jid, planId = 'plan_1gb') {
  await orders.startOrder(sock, jid, planId);
  await orders.handleCompat(sock, jid, 'compat_yes');
  await orders.handleUnlock(sock, jid, 'unlock_yes');
  return lastList(sent);
}

// ── Step 1: quantity picker ───────────────────────────────────
test('Step 1 ends on the quantity picker with MAX_QTY_ESIM rows', async () => {
  const sent = [];
  const sock = stubSock(sent);
  const jid = JID(1);

  const list = await toQuantity(sent, sock, jid);
  assert.ok(list, 'the quantity screen is a LIST');
  assert.deepEqual(renderedIds(list).filter((id) => id.startsWith('eqty:')),
    ['eqty:1', 'eqty:2', 'eqty:3'], 'rows run 1..MAX_QTY_ESIM');
  assert.equal(store.getUser(jid).flow, 'esim_qty');
  assert.equal(sessions.getSession(jid)?.step, steps.STEP_PRODUCT_QTY,
    'still Step 1 — payment has not started');

  // Each row carries the running TOTAL and the unit price.
  const plan = plans.getPlan('plan_1gb');
  const row2 = rowsOf(list).find((r) => r.rowId === 'eqty:2');
  assert.ok(row2.description.includes(formatPrice(plan.price * 2)), row2.description);
  assert.ok(row2.description.includes(formatPrice(plan.price)), row2.description);
  assert.ok(list.text.includes('ek order me') && list.text.includes(String(QTY_MAX_ESIM())),
    `the cap is spelled out: ${list.text.slice(0, 200)}`);

  // choices mirror the rendered rows (typed answers stay aligned).
  assert.deepEqual(store.getUser(jid).choices.slice(0, renderedIds(list).length).map((c) => c.id),
    renderedIds(list));
  assert.equal(users.deviceConfirmed(jid), true, 'the answer was stamped');
  assert.ok(users.getProfile(jid).confirmedUnlocked, 'confirmedUnlocked persisted');
});

test('a quantity outside 1..MAX_QTY_ESIM re-asks instead of clamping', async () => {
  const sent = [];
  const sock = stubSock(sent);
  const jid = JID(2);
  await toQuantity(sent, sock, jid);

  const before = sent.length;
  await orders.handlePlanQuantity(sock, jid, '99');
  assert.equal(store.getUser(jid).planQty, null, 'nothing was stored');
  assert.equal(store.getUser(jid).flow, 'esim_qty', 'the picker stays up');
  const refused = sent[before]?.content?.text || sent[before]?.content?.caption || '';
  assert.ok(/ke beech/.test(refused) && refused.includes(String(QTY_MAX_ESIM())),
    `the customer is told the allowed range: ${refused}`);
  assert.ok(lastList(sent), 'the quantity screen is re-sent');

  // …and typed junk is rejected the same way.
  const junk = sent.length;
  await orders.handlePlanQuantity(sock, jid, 'abc');
  const refused2 = sent[junk]?.content?.text || '';
  assert.ok(/ke beech/.test(refused2), refused2);
  assert.equal(store.getUser(jid).planQty, null);
});

// ── Step 1 → Step 2 handoff ──────────────────────────────────
test('picking a quantity opens Step 2 with the ×N cart total', async () => {
  const sent = [];
  const sock = stubSock(sent);
  const jid = JID(3);
  await toQuantity(sent, sock, jid);

  await orders.handlePlanQuantity(sock, jid, '3');
  assert.equal(store.getUser(jid).planQty, 3);
  assert.equal(store.getUser(jid).flow, 'choose_payment');

  await payments.sendPaymentDetails(sock, jid, 'pay_sadapay');
  const order = store.getOrder(store.getUser(jid).orderId);
  const plan = plans.getPlan('plan_1gb');

  assert.equal(order.quantity, 3, 'the order remembers how many');
  assert.equal(order.price, plan.price * 3, 'the cart total is unit × quantity');
  assert.equal(order.paidAmount, plan.price * 3);

  const last = sent.at(-1);
  assert.match(bodyOf(last), /Step 2 of 2: Pay/, 'progress line is Step 2');
  assert.match(bodyOf(last), /📦 3 eSIMs/, 'the payment screen says how many');
  assert.equal(sessions.getSession(jid)?.step, steps.STEP_PAYMENT);

  // The cart resolver clamps — a store row can never exceed the cap.
  const item = await checkoutItem(jid);
  assert.equal(item.quantity, 3);
  assert.equal(item.unitPrice, plan.price);
  assert.equal(item.price, plan.price * 3);
});

test('checkoutItem clamps planQty to MAX_QTY_ESIM (never divides a cart)', async () => {
  const jid = JID(4);
  store.setUser(jid, { planId: 'plan_6gb', planQty: 99, dpId: null });
  const item = await checkoutItem(jid);
  assert.equal(item.quantity, QTY_MAX_ESIM(), 'over-cap quantity is clamped, not rejected');
  assert.equal(item.price, item.unitPrice * item.quantity);

  store.setUser(jid, { planQty: null });
  assert.equal((await checkoutItem(jid)).quantity, 1, 'no pick → a single eSIM');

  store.setUser(jid, { planQty: 0 });
  assert.equal((await checkoutItem(jid)).quantity, 1, 'zero is never a real quantity');
});

// ── one-time device check ─────────────────────────────────────
test('the device micro-check runs ONCE — the next order jumps to quantity', async () => {
  const sent = [];
  const sock = stubSock(sent);
  const jid = JID(5);
  const offerIds = () => (store.getUser(jid).choices || []).map((c) => c.id);

  await orders.startOrder(sock, jid, 'plan_500mb');
  assert.ok(offerIds().includes('compat_yes'), `first order asks: ${offerIds()}`);
  await orders.handleCompat(sock, jid, 'compat_yes');
  await orders.handleUnlock(sock, jid, 'unlock_yes');
  assert.equal(users.deviceConfirmed(jid), true);

  // Second order: no compatibility / unlock screen at all.
  const mark = sent.length;
  await orders.startOrder(sock, jid, 'plan_6gb');
  const fresh = sent.slice(mark);
  assert.ok(!fresh.some((m) => /Factory Unlock|Compatibility Check/i.test(bodyOf(m))),
    `device check asked again: ${JSON.stringify(fresh.map((m) => bodyOf(m).slice(0, 60)))}`);
  assert.ok(!offerIds().some((id) => id === 'compat_yes' || id === 'unlock_yes'),
    `still offering the gate: ${offerIds()}`);
  assert.ok(lastList(fresh), 'straight to the quantity picker');
  assert.equal(store.getUser(jid).flow, 'esim_qty');
  assert.equal(store.getUser(jid).planId, 'plan_6gb', 'the new plan is the one on offer');
});

// ── multi-unit fulfilment ─────────────────────────────────────
/** A paid order waiting for the admin, with a chosen quantity. */
async function paidOrder(sock, jid, quantity) {
  const plan = plans.getPlan('plan_1gb');
  store.setUser(jid, { planId: plan.id, planQty: quantity, dpId: null, orderId: null });
  await payments.sendPaymentDetails(sock, jid, 'pay_sadapay');
  const order = store.getOrder(store.getUser(jid).orderId);
  order.status = 'pending_admin';
  store.putOrder(order);
  store.flush();
  assert.equal(order.quantity, quantity);
  assert.equal(order.price, plan.price * quantity);
  return order;
}

/** Supplier stub: every purchase succeeds and echoes the reference. */
function stubSupplier(state = {}) {
  state.refs = state.refs || [];
  esim.__setTransport(async (cfg) => {
    if (cfg.method === 'get') return { status: 200, data: { stock: 25 }, headers: {} };
    const ref = cfg.data?.reference;
    state.refs.push(ref);
    if (state.failAt && state.refs.length === state.failAt) {
      const err = new Error('supplier exploded');
      err.response = { status: 500, data: { error: 'boom' } };
      throw err;
    }
    return {
      status: 200,
      data: {
        data: {
          orderId: `SUP-${ref}`,
          qr: `https://qr.invalid/${ref}.png`,
          activationCode: `CODE-${ref}`,
          iccid: `ICCID-${ref}`,
        },
      },
      headers: {},
    };
  });
  return state;
}

test('confirmOrder buys ONE eSIM per unit with distinct references', async () => {
  const jid = JID(6);
  const sent = [];
  const sock = stubSock(sent);

  const order = await paidOrder(sock, jid, 3);
  const state = stubSupplier();

  const res = await orders.confirmOrder(sock, order.id, { actor: 'test-admin' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(state.refs, [`${order.id}-1`, `${order.id}-2`, `${order.id}-3`],
    'the bare Order ID is NEVER used twice');

  const live = store.getOrder(order.id);
  assert.equal(live.status, 'fulfilled');
  assert.equal(live.esims.length, 3, 'all three units recorded');
  assert.equal(live.supplierOrderId, `SUP-${order.id}-1`, 'unit 1 mirrors to the legacy field');
  assert.equal(live.qr, `https://qr.invalid/${order.id}-1.png`);
  assert.equal(live.activationCode, `CODE-${order.id}-1`);
  assert.equal(live.iccid, `ICCID-${order.id}-1`);

  const bodies = sent.filter((m) => m.jid === jid).map((m) => bodyOf(m));
  assert.ok(bodies.some((b) => /Quantity: 3 eSIMs/.test(b)), 'receipt says how many');
  for (let i = 1; i <= 3; i += 1) {
    assert.ok(bodies.some((b) => b.includes(`eSIM ${i} of 3`)),
      `unit ${i} delivered separately: ${JSON.stringify(bodies.slice(-4))}`);
    assert.ok(bodies.some((b) => b.includes(`CODE-${order.id}-${i}`)),
      `unit ${i} has its own activation code`);
  }
  assert.match(res.message, /3 eSIMs/, 'the admin sees the unit count');
  const delivered = store.getUser(jid);
  assert.equal(delivered.planId, null, 'the customer profile is reset after delivery');
  assert.equal(delivered.flow, 'review_pending', 'post-order flow takes over');
});

test('a partial failure delivers what it bought, then a retry completes the rest', async () => {
  const jid = JID(7);
  const sent = [];
  const sock = stubSock(sent);

  const order = await paidOrder(sock, jid, 3);
  const state = stubSupplier({ failAt: 2 });

  const first = await orders.confirmOrder(sock, order.id, { actor: 'test-admin' });
  assert.equal(first.ok, false, 'partial is NOT a success');
  assert.match(first.message, /3 me se/, first.message);
  assert.match(first.message, /reh gayi/, first.message);

  let live = store.getOrder(order.id);
  assert.equal(live.status, 'pending_admin', 'still open for the admin');
  assert.equal(live.esims.length, 1, 'the bought unit is kept');
  assert.deepEqual(state.refs, [`${order.id}-1`, `${order.id}-2`],
    'unit 2 was attempted at the supplier and failed there');

  // The customer already got unit 1.
  const bodies = sent.filter((m) => m.jid === jid).map((m) => bodyOf(m));
  assert.ok(bodies.some((b) => b.includes(`eSIM 1 of 3`)), bodies.slice(-3).join('\n'));

  // Second confirm: only the MISSING units are purchased.
  state.failAt = null;
  const second = await orders.confirmOrder(sock, order.id, { actor: 'test-admin' });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(state.refs.filter((r) => r === `${order.id}-1`).length, 1,
    'unit 1 was never re-bought');
  assert.equal(state.refs.at(-1), `${order.id}-3`, 'the last missing unit was purchased');
  assert.equal(state.refs.filter((r) => r === `${order.id}-3`).length, 1);

  live = store.getOrder(order.id);
  assert.equal(live.status, 'fulfilled');
  assert.equal(live.esims.length, 3);
  const after = sent.filter((m) => m.jid === jid).map((m) => bodyOf(m));
  assert.ok(after.some((b) => b.includes('eSIM 3 of 3')), 'the last unit arrived');
});

test('a single-unit order still uses the bare Order ID as the supplier ref', async () => {
  const jid = JID(8);
  const sent = [];
  const sock = stubSock(sent);

  const order = await paidOrder(sock, jid, 1);
  const state = stubSupplier();

  const res = await orders.confirmOrder(sock, order.id, { actor: 'test-admin' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(state.refs, [order.id], 'qty 1 keeps the legacy single reference');
  const bodies = sent.filter((m) => m.jid === jid).map((m) => bodyOf(m));
  assert.ok(bodies.some((b) => b.includes('eSIM Delivered')), 'no "i of N" caption for one');
  assert.ok(!bodies.some((b) => b.includes('Quantity: 1 eSIMs')),
    'the receipt never brags about one unit');
});

// ── resume after the proof ───────────────────────────────────
test('resuming `awaiting_confirmation` never asks for the screenshot again', async () => {
  const jid = JID(9);
  const sent = [];
  const sock = stubSock(sent);

  const order = await paidOrder(sock, jid, 2);
  sessions.saveSession(jid, {
    step: steps.STEP_AWAITING, orderId: order.id, selectedPlanId: order.planId,
  });
  assert.equal(steps.normalizeStep(steps.STEP_AWAITING), steps.STEP_AWAITING);

  await payments.resumeAwaiting(sock, jid);
  const body = bodyOf(sent.at(-1));
  assert.ok(!/screenshot chahiye/i.test(body), `demanded proof twice: ${body.slice(0, 200)}`);
  assert.match(body, new RegExp(order.id), 'the customer is told where it stands');
  assert.match(body, /verification pending|pending/i);
  assert.equal(sessions.getSession(jid)?.step, steps.STEP_AWAITING);
  assert.equal(store.getUser(jid).flow, 'pending_admin');

  // A settled order answers with the settled status instead of a loop.
  const settled = store.getOrder(order.id);
  settled.status = 'fulfilled';
  store.putOrder(settled);
  store.flush();
  const mark = sent.length;
  await payments.resumeAwaiting(sock, jid);
  assert.match(bodyOf(sent.at(-1)), /settle/i);
  assert.ok(sent.length - mark >= 1);

  // An order that still owes proof DOES get the proof screen back.
  const owed = store.getOrder(order.id);
  owed.status = 'await_screenshot';
  store.putOrder(owed);
  store.flush();
  const mark2 = sent.length;
  await payments.resumeAwaiting(sock, jid);
  assert.match(bodyOf(sent.at(-1)), /screenshot chahiye/i,
    'proof still owed → the proof step re-opens');
});

test('legacy four-step session ids resume onto the two-step machine', () => {
  const jid = JID(10);
  sessions.saveSession(jid, { step: 'screenshot', selectedPlanId: 'plan_1gb', orderId: null });
  assert.equal(sessions.resumableSession(jid).step, 'screenshot', 'stored as written');
  assert.equal(steps.normalizeStep('screenshot'), steps.STEP_PAYMENT);
  assert.equal(steps.normalizeStep('device'), steps.STEP_PRODUCT_QTY);
  sessions.__resetSession(jid);
});
