// Part C — the Purple Cow layer:
//   ⚡ Fast Guarantee   (promise + automatic wallet credit when missed)
//   📦 Digital Unboxing (paced beats BEFORE the thank-you)
//   🎁 Referral Loop    (stable code, both sides credited, 3 fraud guards)
//
// Run with:  node --test test/purplecow.test.js
//
// Env overrides MUST run before any project module loads.
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.STORE_FILE = 'test/.tmp-pc-store.json';
process.env.SESSIONS_FILE = 'test/.tmp-pc-sessions.json';
process.env.USERS_FILE = 'test/.tmp-pc-users.json';
process.env.ADMIN_STATE_FILE = 'test/.tmp-pc-admin.json';
process.env.AUDIT_FILE = 'test/.tmp-pc-audit.json';
process.env.PAYMENTS_FILE = 'test/.tmp-pc-payments.json';
process.env.BINANCE_TX_FILE = 'test/.tmp-pc-binance.json';
process.env.WALLETS_FILE = 'test/.tmp-pc-wallets.json';
process.env.WALLET_TX_FILE = 'test/.tmp-pc-wallettx.json';
process.env.BROADCAST_FILE = 'test/.tmp-pc-broadcast.json';
process.env.AI_DECISIONS_FILE = 'test/.tmp-pc-aidecisions.json';
process.env.REFERRALS_FILE = 'test/.tmp-pc-referrals.json';
process.env.REVIEWS_FILE = 'test/.tmp-pc-reviews.json';
process.env.ALERTS_FILE = 'test/.tmp-pc-alerts.json';
process.env.ADMIN_WHATSAPP_NUMBER = '030011122233';
process.env.FAST_GUARANTEE_MINUTES = '15';
process.env.FAST_GUARANTEE_CREDIT_PKR = '100';
process.env.REFERRAL_BONUS_PKR = '100';
process.env.REFERRAL_MONTHLY_CAP = '1000';
process.env.UNBOXING_MODE = 'on';
process.env.BROADCAST_MIN_GAP_MINUTES = '0';
process.env.MIN_REPLY_DELAY_MS = '0';
process.env.MAX_REPLY_DELAY_MS = '0';
process.env.DEBOUNCE_WINDOW_MS = '0';
delete process.env.DASHBOARD_PORT;

try {
  for (const f of [
    'pc-store.json', 'pc-sessions.json', 'pc-users.json', 'pc-admin.json',
    'pc-audit.json', 'pc-payments.json', 'pc-binance.json', 'pc-wallets.json',
    'pc-wallettx.json', 'pc-broadcast.json', 'pc-aidecisions.json',
    'pc-referrals.json', 'pc-reviews.json', 'pc-alerts.json',
  ]) {
    fs.rmSync(new URL(`./.tmp-${f}`, import.meta.url), { force: true });
  }
} catch { /* ignore */ }

const guarantee = await import('../services/guarantee.js');
const unboxing = await import('../services/unboxing.js');
const referral = await import('../services/referral.js');
const wallet = await import('../services/wallet.js');
const menu = await import('../handlers/menu.js');
const reviews = await import('../handlers/reviews.js');
const referralHandler = await import('../handlers/referral.js');
const { SETTINGS } = await import('../config.js');

const JID = (n) => `${n}@s.whatsapp.net`;

function stubSock(sent) {
  return {
    sendMessage: async (jid, content) => {
      sent.push({ jid, content });
      return { key: { id: `m${sent.length}`, remoteJid: jid } };
    },
  };
}
const texts = (sent) => sent.map((s) => s.content?.text).filter(Boolean);
const lastList = (sent) => [...sent].reverse().find((s) => Array.isArray(s.content?.sections))?.content || null;
const renderedIds = (list) => list.sections.flatMap((s) => s.rows || []).map((r) => r.rowId);

const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const deliveredOrder = (jid, { took = 4, id = 'SMF-9001', quantity = 1 } = {}) => ({
  id,
  jid,
  planName: 'Pakistan 30GB',
  planId: 'plan_30gb',
  quantity,
  price: 1500,
  status: 'delivered',
  createdAt: iso(took + 5),
  confirmedAt: iso(took),
  deliveredAt: iso(0),
});

// ── ⚡ Fast Guarantee ──────────────────────────────────────────
test('the guarantee verdict is pure: fast / missed / unknown', () => {
  assert.equal(guarantee.guaranteeResult(deliveredOrder(JID(101), { took: 4 })).status, 'fast');
  assert.equal(guarantee.guaranteeResult(deliveredOrder(JID(101), { took: 15 })).status, 'fast', 'boundary counts as fast');
  assert.equal(guarantee.guaranteeResult(deliveredOrder(JID(101), { took: 16 })).status, 'missed');
  const unknown = guarantee.guaranteeResult({ id: 'SMF-X', jid: JID(101) });
  assert.equal(unknown.status, 'unknown');
  assert.equal(guarantee.guaranteeResult(deliveredOrder(JID(101), { took: 4 })).limitMinutes, 15);
});

test('a missed guarantee credits the wallet ONCE and stamps the order', async () => {
  const jid = JID(102);
  const order = deliveredOrder(jid, { took: 42, id: 'SMF-9002' });
  assert.equal(wallet.getBalance(jid), 0);

  const stamp = await guarantee.settleGuarantee(order);
  assert.equal(stamp.status, 'missed');
  assert.equal(stamp.credited, true);
  assert.equal(stamp.credit, 100);
  assert.equal(wallet.getBalance(jid), 100, 'PKR 100 lands in the wallet, no questions asked');
  assert.equal(order.guaranteeSettled, true);

  // Second call (re-delivery, restart, double handler run) → no payout.
  const again = await guarantee.settleGuarantee(order);
  assert.equal(again.credited, true, 'the stamp is reused, not re-paid');
  assert.equal(wallet.getBalance(jid), 100, 'the credit can never fire twice');

  const tx = wallet.ledgerFor(jid, 5)[0];
  assert.equal(tx.type, 'guarantee');
  assert.equal(tx.actor, 'fast-guarantee');
  assert.equal(tx.relatedOrderId, 'SMF-9002');
});

test('guarantee copy: a badge when we were fast, an honest note when we were not', async () => {
  const fast = deliveredOrder(JID(103), { took: 3 });
  await guarantee.settleGuarantee(fast);
  const badge = guarantee.guaranteeBadge(fast, 'en');
  assert.match(badge, /Fast Guarantee/);
  assert.match(badge, /3 min/);
  assert.equal(guarantee.guaranteeMessage(fast, 'en'), null, 'no apology for a fast delivery');

  const missed = deliveredOrder(JID(104), { took: 30, id: 'SMF-9003' });
  await guarantee.settleGuarantee(missed);
  assert.equal(guarantee.guaranteeBadge(missed, 'en'), null);
  const note = guarantee.guaranteeMessage(missed, 'en');
  assert.match(note, /PKR 100/);
  assert.match(note, /30 min/);

  const unknown = { id: 'SMF-9004', jid: JID(105) };
  assert.equal(await guarantee.settleGuarantee(unknown), null, 'nothing promised without timestamps');
  assert.equal(guarantee.guaranteeBadge(unknown, 'en'), null);
});

// ── 📦 Digital Unboxing ───────────────────────────────────────
test('the unboxing is 3 paced beats carrying the plan + quantity', () => {
  const beats = unboxing.unboxingBeats(deliveredOrder(JID(106), { quantity: 3 }), 'en');
  assert.equal(beats.length, 3);
  assert.match(beats[0], /Unboxing time/);
  assert.ok(beats.every((b) => b.includes('Pakistan 30GB')));
  assert.ok(beats.some((b) => b.includes('3 ×')), 'multi-unit orders say how many');
});

test('runUnboxing sends the beats — and none at all when switched off', async () => {
  const on = [];
  const sentOn = await unboxing.runUnboxing(stubSock(on), deliveredOrder(JID(107)), 'en');
  assert.equal(sentOn, 3);
  assert.equal(texts(on).length, 3);

  const off = [];
  const saved = SETTINGS.unboxing;
  SETTINGS.unboxing = false;
  try {
    assert.equal(await unboxing.runUnboxing(stubSock(off), deliveredOrder(JID(107)), 'en'), 0);
  } finally {
    SETTINGS.unboxing = saved;
  }
  assert.equal(off.length, 0, 'UNBOXING_MODE=off means silence');
});

// ── 🎁 Referral Loop ──────────────────────────────────────────
test('every customer gets ONE stable invite code', () => {
  const jid = JID(108);
  const first = referral.referralCodeFor(jid);
  assert.match(first, /^SF-/);
  assert.equal(referral.referralCodeFor(jid), first, 'stable across calls');
  assert.notEqual(referral.referralCodeFor(JID(109)), first, 'different phone, different code');
});

test('a NEW customer redeeming a code credits BOTH wallets', async () => {
  const referrer = JID(110);
  const invitee = JID(111);
  const code = referral.referralCodeFor(referrer);

  const res = await referral.redeem(invitee, code);
  assert.equal(res.ok, true);
  assert.equal(res.bonusPkr, 100);
  assert.equal(wallet.getBalance(invitee), 100, 'the invitee is paid');
  assert.equal(wallet.getBalance(referrer), 100, 'the referrer is paid too');
  assert.equal(referral.invitedBy(referrer), 1);
  assert.equal(referral.creditedFor(referrer), 100);
  assert.ok((await import('../lib/users.js')).getProfile(invitee).referredBy, 'the profile remembers who invited them');
});

test('the three fraud guards hold', async () => {
  // 1. one credit per new phone — a second redeem is refused
  const referrer = JID(112);
  const invitee = JID(113);
  const code = referral.referralCodeFor(referrer);
  assert.equal((await referral.redeem(invitee, code)).ok, true);
  const second = await referral.redeem(invitee, code);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'already');
  assert.equal(wallet.getBalance(invitee), 100, 'paid exactly once');

  // 2. no self-referral
  const self = await referral.redeem(referrer, referral.referralCodeFor(referrer));
  assert.equal(self.ok, false);
  assert.equal(self.reason, 'self');
  assert.equal(wallet.getBalance(referrer), 100, 'only the referral bonus, nothing extra');

  // 3. unknown codes are just unknown
  assert.equal((await referral.redeem(JID(114), 'SF-NOPE9')).reason, 'invalid');
  assert.equal(wallet.getBalance(JID(114)), 0);
});

test('a customer who already bought here cannot ride the invite code', async () => {
  const users = await import('../lib/users.js');
  const referrer = JID(115);
  const veteran = JID(116);
  users.setProfile(veteran, { completed: 3 });

  const res = await referral.redeem(veteran, referral.referralCodeFor(referrer));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not_new');
  assert.equal(wallet.getBalance(veteran), 0);
});

test('the monthly cap stops a referrer from farming bonuses', async () => {
  const referrer = JID(117);
  const saved = SETTINGS.referralMonthlyCapPkr;
  SETTINGS.referralMonthlyCapPkr = 150; // one bonus (100) fits, two do not
  try {
    const code = referral.referralCodeFor(referrer);
    assert.equal((await referral.redeem(JID(118), code)).ok, true);
    const capped = await referral.redeem(JID(119), code);
    assert.equal(capped.ok, false);
    assert.equal(capped.reason, 'cap');
    assert.equal(wallet.getBalance(referrer), 100, 'exactly one bonus inside the cap');
    assert.equal(referral.referralStats(referrer).remainingThisMonth, 50);
  } finally {
    SETTINGS.referralMonthlyCapPkr = saved;
  }
});

// ── 🎁 the screens ────────────────────────────────────────────
test('the welcome menu carries the Refer & Earn row (rendered AND typed)', async () => {
  const sent = [];
  const sock = stubSock(sent);
  const jid = JID(120);
  await menu.sendWelcome(sock, jid);

  const list = lastList(sent);
  assert.ok(list, 'welcome is a LIST');
  assert.ok(renderedIds(list).includes('refer'), '🎁 row is on the menu');

  const choices = (await import('../lib/store.js')).getUser(jid).choices;
  assert.ok(choices.some((c) => c.id === 'refer'), 'typed input mirrors the row');
  assert.ok(choices.find((c) => c.id === 'refer').keywords.includes('invite'));
});

test('the referral screen shows the code, and a bad code never dead-ends', async () => {
  const sent = [];
  const sock = stubSock(sent);
  const jid = JID(121);

  await referralHandler.sendReferral(sock, jid);
  const screen = texts(sent).at(-1);
  assert.match(screen, /SF-/);
  assert.match(screen, /PKR 100/);

  await referralHandler.askReferralCode(sock, jid);
  assert.equal((await import('../lib/store.js')).getUser(jid).flow, 'refer_enter');

  await referralHandler.handleReferralCode(sock, jid, 'SF-WRONG1');
  const after = texts(sent);
  assert.match(after.at(-2) || '', /not found|milan? nahi/i, 'the error is explained');
  assert.equal((await import('../lib/store.js')).getUser(jid).flow, 'refer_enter', 'still asking, never stuck');

  const code = referral.referralCodeFor(JID(122));
  await referralHandler.handleReferralCode(sock, jid, code);
  assert.equal((await import('../lib/store.js')).getUser(jid).flow, 'menu', 'success returns to the menu');
  assert.equal(wallet.getBalance(jid), 100);
});

// ── the whole thing, in order ─────────────────────────────────
test('delivery ends: guarantee → unboxing → thank-you (last, still ≤4 lines)', async () => {
  const sent = [];
  const sock = stubSock(sent);
  const jid = JID(123);
  const order = deliveredOrder(jid, { took: 5, id: 'SMF-9010' });

  await reviews.startPostOrder(sock, order);

  const all = texts(sent);
  const thankYou = all.at(-1);
  assert.ok(thankYou, 'something was said');
  assert.match(thankYou, /Shukriya/, 'the LAST message is still the thank-you');
  assert.ok(thankYou.split('\n').length <= 4, `thank-you stayed short (${thankYou.split('\n').length} lines)`);
  assert.ok(all.some((t) => /Fast Guarantee/.test(t)), 'the ⚡ badge is on');
  assert.ok(all.some((t) => /Unboxing time/.test(t)), 'the 📦 beat is on');
  assert.ok(all.length >= 4, 'badge + beats + thank-you');
  assert.equal((await import('../lib/store.js')).getUser(jid).flow, 'review_pending', 'review still armed');
  assert.equal(order.guaranteeSettled, true);

  // Nothing above may ever break the review prompt: clearing the
  // armed timer keeps the process from hanging.
  reviews.__clearReviewTimers();
});

test('a missed delivery pays the credit even when the chat stays quiet', async () => {
  const sent = [];
  const sock = stubSock(sent);
  const jid = JID(124);
  const order = deliveredOrder(jid, { took: 45, id: 'SMF-9011' });

  await reviews.startPostOrder(sock, order);

  assert.equal(wallet.getBalance(jid), 100, 'money moves regardless of pacing');
  assert.equal(order.guarantee.status, 'missed');
  const all = texts(sent);
  assert.ok(all.some((t) => /PKR 100/.test(t)), 'the customer is told');
  reviews.__clearReviewTimers();
});

beforeEach(() => {
  // keep every test's proactive window open (BROADCAST_MIN_GAP=0 anyway)
});

after(async () => {
  reviews.__clearReviewTimers();
  await referral.__resetReferrals();
  await new Promise((r) => setTimeout(r, 260));
  for (const f of [
    'pc-store.json', 'pc-sessions.json', 'pc-users.json', 'pc-admin.json',
    'pc-audit.json', 'pc-payments.json', 'pc-binance.json', 'pc-wallets.json',
    'pc-wallettx.json', 'pc-broadcast.json', 'pc-aidecisions.json',
    'pc-referrals.json', 'pc-reviews.json', 'pc-alerts.json',
  ]) {
    fs.rmSync(new URL(`./.tmp-${f}`, import.meta.url), { force: true });
  }
});
