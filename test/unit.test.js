// Unit tests for the UX-batch libraries.
// Run with:  npm run test:unit   (or: node --test test/unit.test.js)
//
// Env overrides MUST run before any project module loads — config.js
// reads process.env at import time, so every project import below is
// dynamic and happens after the overrides.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.STORE_FILE = 'test/.tmp-unit-store.json';
process.env.REVIEWS_FILE = 'test/.tmp-unit-reviews.json';
process.env.SESSIONS_FILE = 'test/.tmp-unit-sessions.json';
process.env.USERS_FILE = 'test/.tmp-unit-users.json';
process.env.ALERTS_FILE = 'test/.tmp-unit-alerts.json';
// Admin system — tmp stores + deterministic roles / broadcast valves.
process.env.AUDIT_FILE = 'test/.tmp-unit-audit.json';
process.env.ADMIN_STATE_FILE = 'test/.tmp-unit-admin.json';
process.env.PAYMENTS_FILE = 'test/.tmp-unit-payments.json';
process.env.BINANCE_TX_FILE = 'test/.tmp-unit-binance.json';
process.env.BROADCAST_FILE = 'test/.tmp-unit-broadcast.json';
process.env.ADMIN_WHATSAPP_NUMBER = '030011122233';
process.env.STAFF_NUMBERS = '030098765432';
delete process.env.ADMIN_NUMBERS;
process.env.BROADCAST_MSGS_PER_MINUTE = '60000';
process.env.BROADCAST_JITTER_MS = '0-0';
process.env.LOYALTY_ORDERS = '5';
process.env.LOYALTY_DISCOUNT_PERCENT = '10';
process.env.SESSION_TTL_HOURS = '24';
process.env.HUMAN_MODE_MINUTES = '30';
process.env.STOCK_CACHE_SECONDS = '60';
delete process.env.NAYAPAY_AUTO_VERIFY;
delete process.env.ESIMACCESS_API_KEY;
delete process.env.ESIMACCESS_API_SECRET;

try {
  for (const f of [
    '.tmp-unit-store.json', '.tmp-unit-reviews.json', '.tmp-unit-sessions.json',
    '.tmp-unit-users.json', '.tmp-unit-alerts.json',
    '.tmp-unit-audit.json', '.tmp-unit-admin.json', '.tmp-unit-payments.json',
    '.tmp-unit-broadcast.json', '.tmp-unit-binance.json',
  ]) {
    fs.rmSync(new URL(`./${f}`, import.meta.url), { force: true });
  }
} catch { /* ignore */ }

const ui = await import('../handlers/ui.js');
const steps = await import('../lib/steps.js');
const sessions = await import('../lib/sessions.js');
const users = await import('../lib/users.js');
const lang = await import('../lib/lang.js');
const plans = await import('../lib/plans.js');
const alerts = await import('../lib/alerts.js');
const esim = await import('../services/esimaccess.js');
const admins = await import('../lib/admins.js');
const verifier = await import('../services/verifier.js');
const adminBroadcast = await import('../handlers/adminBroadcast.js');
const store = await import('../lib/store.js');
const { SETTINGS } = await import('../config.js');

const HOUR = 60 * 60 * 1000;

// ── handlers/ui.js: navigation helpers ────────────────────────
test('withNav appends menu + human and never exceeds the limit', () => {
  const two = ui.withNav([{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }]);
  assert.deepEqual(two.map((b) => b.id), ['a', 'b', 'main_menu', 'human']);

  // Budget minus one: the menu still fits, the human button has to go.
  const almost = Array.from({ length: ui.BUTTON_LIMIT - 1 }, (_, i) => ({ id: `b${i + 1}`, text: `B${i + 1}` }));
  const capped = ui.withNav(almost);
  assert.equal(capped.length, ui.BUTTON_LIMIT);
  assert.deepEqual(capped.map((b) => b.id), [...almost.map((b) => b.id), 'main_menu']);
  assert.ok(!capped.some((b) => b.id === 'human'), 'human dropped when the limit is reached');

  // Over budget already: nothing is appended (never truncates a screen).
  const over = ui.withNav(Array.from({ length: ui.BUTTON_LIMIT + 2 }, (_, i) => ({ id: `x${i}`, text: 'X' })));
  assert.equal(over.length, ui.BUTTON_LIMIT + 2);
  assert.ok(!over.some((b) => b.id === 'main_menu'));
});

test('withNav never mutates its input', () => {
  const input = [{ id: 'a', text: 'A' }];
  const out = ui.withNav(input);
  assert.equal(input.length, 1);
  assert.notEqual(out, input);
  assert.notEqual(out[0], input[0]);
});

test('withNav skips ids the screen already shows', () => {
  const out = ui.withNav([{ id: 'human', text: 'H' }]);
  assert.equal(out.filter((b) => b.id === 'human').length, 1);
  assert.ok(out.some((b) => b.id === 'main_menu'));
});

test('withNavChoices mirrors withNav ids in the same order', () => {
  const own = [{ id: 'review_5', text: '5' }, { id: 'review_4', text: '4' }, { id: 'review_3', text: '3' }, { id: 'review_low', text: 'low' }];
  const buttons = ui.withNav(own);
  const choices = ui.withNavChoices(own.map((b) => ({ id: b.id, label: b.text, keywords: [] })));
  assert.deepEqual(choices.map((c) => c.id), buttons.map((b) => b.id));
  assert.equal(choices.length, ui.BUTTON_LIMIT);
});

test('withListNav appends one Menu section, deduped against screen rows', () => {
  const sections = [{ title: 'Packs', rows: [{ id: 'plan_x', title: 'X', description: '' }] }];
  const out = ui.withListNav(sections);
  assert.equal(out.length, 2);
  assert.equal(out[1].title, 'Menu');
  assert.deepEqual(out[1].rows.map((r) => r.id), ['main_menu', 'human', 'lang_toggle']);

  const withMenu = ui.withListNav([{ title: 'P', rows: [{ id: 'main_menu', title: 'M', description: '' }] }]);
  assert.deepEqual(withMenu.at(-1).rows.map((r) => r.id), ['human', 'lang_toggle']);
});

test('LIST_NAV_CHOICES ids line up with the Menu rows', () => {
  const out = ui.withListNav([]);
  assert.deepEqual(ui.LIST_NAV_CHOICES.map((c) => c.id), out.at(-1).rows.map((r) => r.id));
});

test('withListNav can carry screen rows (e.g. 🔍 Search) into the Menu section', () => {
  const out = ui.withListNav(
    [{ title: 'A', rows: [{ id: 'dp:x', title: 'X', description: '' }] }],
    { extraRows: [{ id: 'dp_search', title: '🔍 Search products', description: '' }] },
  );
  assert.equal(out.length, 2, 'still only ONE nav section');
  assert.deepEqual(out.at(-1).rows.map((r) => r.id),
    ['dp_search', 'main_menu', 'human', 'lang_toggle']);
});

test('withListNav never exceeds the 10-section LIST cap', () => {
  const full = Array.from({ length: 10 }, (_, i) => ({
    title: `S${i}`,
    rows: [{ id: `r${i}`, title: 'x', description: '' }, { id: `q${i}`, title: 'y', description: '' }],
  }));
  const out = ui.withListNav(full);
  assert.equal(out.length, 10, 'nav is folded in, never an 11th section');
  assert.equal(out.at(-1).rows.map((r) => r.id).join(','),
    'r9,q9,main_menu,human,lang_toggle');
  assert.ok(out.every((s) => s.rows.length <= ui.MAX_LIST_ROWS));
});

// ── handlers/ui.js: withAck ───────────────────────────────────
function stubSock() {
  const sends = [];
  return {
    sends,
    sendMessage: async (jid, content) => {
      sends.push({ jid, text: content.text || '' });
      return { key: { id: `s${sends.length}` } };
    },
  };
}

test('withAck sends the ack first, then real text results', async () => {
  const sock = stubSock();
  ui.setUiSocket(sock);
  const result = await ui.withAck('someone@s.whatsapp.net', '⏳ Working…', async () => 'All done');
  assert.equal(result, 'All done');
  assert.deepEqual(sock.sends.map((s) => s.text), ['⏳ Working…', 'All done']);
});

test('withAck swallows UI delivery-mode tokens (never leaks "plain")', async () => {
  const sock = stubSock();
  ui.setUiSocket(sock);
  await ui.withAck('someone@s.whatsapp.net', '⏳ Working…', async () => 'plain');
  assert.deepEqual(sock.sends.map((s) => s.text), ['⏳ Working…']);
});

// ── lib/steps.js ──────────────────────────────────────────────
test('order steps render a correct progress prefix', () => {
  assert.equal(steps.ORDER_STEPS.length, 2, 'checkout is TWO steps');
  assert.equal(steps.stepPrefix('product_qty'), 'Step 1 of 2: Choose & Confirm');
  assert.equal(steps.stepPrefix('payment'), 'Step 2 of 2: Pay');
  assert.equal(steps.stepPrefix('awaiting_confirmation'), '', 'post-checkout carries no prefix');
  assert.equal(steps.stepPrefix('nope'), '');
  assert.equal(steps.withStep('payment', 'body'), 'Step 2 of 2: Pay\nbody');
  assert.equal(steps.withStep('awaiting_confirmation', 'body'), 'body');
  assert.equal(steps.withStep('nope', 'body'), 'body');
});

test('legacy four-step ids still land on the two-step machine', () => {
  assert.equal(steps.normalizeStep('plan'), 'product_qty');
  assert.equal(steps.normalizeStep('device'), 'product_qty');
  assert.equal(steps.normalizeStep('product'), 'product_qty');
  assert.equal(steps.normalizeStep('email'), 'product_qty');
  assert.equal(steps.normalizeStep('payment'), 'payment');
  assert.equal(steps.normalizeStep('screenshot'), 'payment');
  assert.equal(steps.normalizeStep('nonsense'), null);
  assert.equal(steps.normalizeStep(null), null);

  assert.equal(steps.stepPrefix('plan'), 'Step 1 of 2: Choose & Confirm');
  assert.equal(steps.stepPrefix('device'), 'Step 1 of 2: Choose & Confirm');
  assert.equal(steps.stepPrefix('email'), 'Step 1 of 2: Choose & Confirm');
  assert.equal(steps.stepPrefix('screenshot'), 'Step 2 of 2: Pay');
  assert.equal(steps.isCheckoutStep('screenshot'), true);
  assert.equal(steps.isCheckoutStep('awaiting_confirmation'), false);
});

// ── lib/sessions.js ───────────────────────────────────────────
test('sessions resume within the TTL and expire after it', () => {
  const jid = 'unit-resume@s.whatsapp.net';
  sessions.saveSession(jid, { step: 'device', selectedPlanId: 'plan_1gb', orderId: null });
  assert.ok(sessions.resumableSession(jid), 'fresh session is resumable');
  assert.equal(sessions.resumableSession(jid, Date.now() + 25 * HOUR), null, 'expired after 25h');
  assert.equal(sessions.getSession(jid, Date.now() + 25 * HOUR), null);
  sessions.clearSession(jid);
  assert.equal(sessions.resumableSession(jid), null);
});

test('a session without a step/plan is not resumable', () => {
  const jid = 'unit-nostep@s.whatsapp.net';
  sessions.saveSession(jid, { step: null, selectedPlanId: null, orderId: null });
  assert.equal(sessions.resumableSession(jid), null);
  sessions.clearSession(jid);
});

test('human mode expires and clearSession keeps it', () => {
  const jid = 'unit-human@s.whatsapp.net';
  sessions.setHuman(jid);
  assert.equal(sessions.humanActive(jid), true);
  assert.equal(sessions.humanActive(jid, Date.now() + 31 * 60 * 1000), false, 'expires after 30 min');

  sessions.saveSession(jid, { step: 'payment', selectedPlanId: 'plan_1gb' });
  sessions.clearSession(jid);
  assert.equal(sessions.resumableSession(jid), null, 'order part dropped');
  assert.equal(sessions.humanActive(jid), true, 'human marker survives');
  assert.equal(sessions.clearHuman(jid), true);
  assert.equal(sessions.humanActive(jid), false);
  sessions.__resetSession(jid);
});

test('human minutes + exact deadline helpers', () => {
  const jid = 'unit-human2@s.whatsapp.net';
  assert.equal(sessions.humanMinutes(), 30, 'pinned HUMAN_MODE_MINUTES');
  assert.equal(sessions.humanUntil(jid), 0, 'no window yet');
  sessions.setHuman(jid);
  const until = sessions.humanUntil(jid);
  assert.ok(until > Date.now(), 'deadline is in the future');
  assert.equal(sessions.humanUntil(jid), until, 'stable while active');
  assert.ok(until - Date.now() > 29 * 60 * 1000, 'window is the configured 30 min');
  sessions.clearHuman(jid);
  assert.equal(sessions.humanUntil(jid), 0, 'gone once cleared');
  sessions.__resetSession(jid);
});

// ── lib/users.js: language + loyalty ──────────────────────────
test('language preference round-trips with a safe fallback', () => {
  const jid = 'unit-lang@s.whatsapp.net';
  assert.equal(users.getLang(jid), 'ur');
  users.setLang(jid, 'en');
  assert.equal(users.getLang(jid), 'en');
  users.setLang(jid, 'xx');
  assert.equal(users.getLang(jid), 'ur');
  users.__clearProfile(jid);
});

test('loyalty counter unlocks a 10% code on the 5th order', () => {
  const jid = 'unit-loyal@s.whatsapp.net';
  users.__clearProfile(jid);

  const first = users.recordCompletedOrder(jid);
  assert.deepEqual(first, { completed: 1, remaining: 4, reward: null });

  users.recordCompletedOrder(jid);
  users.recordCompletedOrder(jid);
  users.recordCompletedOrder(jid);
  const fifth = users.recordCompletedOrder(jid);
  assert.equal(fifth.completed, 5);
  assert.equal(fifth.reward?.percent, 10);
  assert.match(fifth.reward?.code || '', /^SIMFLY10-/);

  const disc = users.validDiscount(jid);
  assert.ok(disc && disc.used === false, 'fresh code is valid');
  assert.equal(users.consumeDiscount(jid), true);
  assert.equal(users.validDiscount(jid), null, 'code is single-use');
  assert.equal(users.consumeDiscount(jid), false);
  users.__clearProfile(jid);
});

// ── lib/lang.js ───────────────────────────────────────────────
test('t() interpolates vars, falls back across locales, and survives typos', () => {
  assert.equal(lang.t('no_such_key_anywhere'), 'no_such_key_anywhere');
  const ur = lang.t('row_plans', { n: 13, from: 'PKR 111' }, 'ur');
  assert.ok(ur.includes('13') && ur.includes('PKR 111'), ur);
  assert.notEqual(lang.t('orders_none', {}, 'en'), lang.t('orders_none', {}, 'ur'));
  assert.ok(lang.LANGS.includes(lang.DEFAULT_LANG));
});

// ── lib/plans.js: sold-out rows ───────────────────────────────
test('planSections marks sold-out plans with ❌ but keeps them visible', () => {
  const clean = plans.planSections(null, 'ur');
  const flat = clean.flatMap((s) => s.rows);
  assert.equal(flat.length, 4);
  assert.ok(flat.every((r) => !r.title.startsWith('❌')));
  assert.ok(clean.some((s) => s.title.includes('500MB & 1GB')), 'custom section titles from plans.json');
  assert.ok(clean.some((s) => s.title.includes('6GB & 10GB')), 'second custom section title');

  const stock = { plan_1gb: { ok: false, stock: 0, source: 'supplier' } };
  const withStock = plans.planSections(stock, 'ur').flatMap((s) => s.rows);
  const soldOut = withStock.find((r) => r.id === 'plan:plan_1gb');
  assert.ok(soldOut.title.startsWith('❌'), soldOut.title);
  assert.equal(soldOut.description, 'Temporarily unavailable');
  assert.equal(withStock.length, 4, 'sold-out rows are never hidden');
});

// ── lib/alerts.js ─────────────────────────────────────────────
test('restock subscriptions dedupe, unsubscribe by id, and are listable', () => {
  const jid = 'unit-alerts@s.whatsapp.net';
  const a = alerts.subscribe(jid, 'restock', 'plan_1gb');
  const b = alerts.subscribe(jid, 'restock', 'plan_1gb');
  assert.equal(a.id, b.id, 'same subscription returned, not duplicated');
  assert.equal(alerts.allSubsFor(jid).length, 1);

  alerts.subscribe(jid, 'price', null);
  assert.equal(alerts.allSubsFor(jid).length, 2);
  assert.equal(alerts.findSubscription(jid, 'price', null)?.id, alerts.allSubsFor(jid).find((s) => s.type === 'price').id);

  const removed = alerts.unsubscribeById(a.id);
  assert.equal(removed?.id, a.id);
  assert.equal(alerts.findSubscription(jid, 'restock', 'plan_1gb'), null);
  assert.equal(alerts.allSubsFor(jid).length, 1);
  assert.equal(alerts.unsubscribeById('ALR-9999'), null);
  for (const s of alerts.allSubsFor(jid)) alerts.unsubscribeById(s.id);
  assert.equal(alerts.allSubsFor(jid).length, 0);
});

test('at most ONE alert per subscriber per day', () => {
  const entry = { lastAlertDay: null };
  assert.equal(alerts.alertAllowed(entry), true);
  alerts.markAlerted('does-not-exist'); // no-op must not throw
  const jid = 'unit-daily@s.whatsapp.net';
  const sub = alerts.subscribe(jid, 'restock', 'plan_1gb');
  assert.equal(alerts.markAlerted(sub.id).lastAlertDay, alerts.dayKey());
  assert.equal(alerts.alertAllowed(alerts.findSubscription(jid, 'restock', 'plan_1gb')), false);
  assert.equal(alerts.alertAllowed({ lastAlertDay: '2000-01-01' }), true);
  alerts.unsubscribeById(sub.id);
});

test('stock/price snapshot round-trips', () => {
  alerts.setSnapshot({ plan_1gb: 5 });
  assert.deepEqual(alerts.getSnapshot(), { plan_1gb: 5 });
  alerts.setSnapshot(null);
  assert.deepEqual(alerts.getSnapshot(), {});
});

// ── services/esimaccess.js: bulk stock cache ──────────────────
test('bulk stock falls back to the local catalogue and caches for 60s', async () => {
  esim.clearStockCache();
  const first = await esim.checkAllStock();
  assert.equal(Object.keys(first).length, 4);
  assert.ok(Object.values(first).every((s) => s.ok === true && s.source === 'local'));

  const meta = esim.stockCacheMeta();
  assert.equal(meta.cached, true);
  assert.equal(meta.ttlMs, 60000);
  assert.ok(meta.ageMs >= 0 && meta.ageMs < 5000);

  await esim.checkAllStock();
  assert.equal(esim.stockCacheMeta().hits >= 1, true, 'second call served from cache');

  esim.clearStockCache();
  assert.equal(esim.stockCacheMeta().cached, false);
});

// ── lib/admins.js: roles / audit / settings ──────────────────
const OWNER = '9230011122233@s.whatsapp.net';
const STAFF = '9230098765432@s.whatsapp.net';
const OUTSIDER = '9230000000001@s.whatsapp.net';

test('roles come from the sender JID number only', () => {
  assert.equal(admins.roleFor(OWNER), 'owner');
  assert.equal(admins.roleFor(STAFF), 'staff');
  assert.equal(admins.roleFor(OUTSIDER), null);
  assert.ok(admins.isOwner(OWNER) && !admins.isOwner(STAFF));
  assert.ok(admins.isStaff(STAFF) && !admins.isStaff(OWNER));
  assert.ok(admins.isAdminJid(STAFF) && !admins.isAdminJid(OUTSIDER));
  assert.ok(admins.allAdminJids().includes(OWNER) && admins.allAdminJids().includes(STAFF));
  assert.ok(admins.ownerJids().includes(OWNER) && !admins.ownerJids().includes(STAFF));
  assert.ok(!admins.allAdminJids().includes(OUTSIDER));
});

test('@lid senders resolve to their phone number before the role check', async () => {
  // rememberLid — the mapping seam roleFor() consults.
  admins.rememberLid('2154555000111', '9230011122233');
  assert.equal(admins.roleFor('2154555000111@lid'), 'owner');
  assert.equal(admins.roleFor('2154555000111:2@lid'), 'owner', 'device suffix kept');
  admins.rememberLid('2154555000222', '9230000000000');
  assert.equal(admins.roleFor('2154555000222@lid'), null, 'mapped non-admin stays a customer');
  assert.equal(admins.roleFor('2154555000333@lid'), null, 'unresolved lid is nobody');

  // linkLidAdmin — fast path: baileys' local lid → number store.
  await admins.linkLidAdmin(
    { signalRepository: { lidMapping: {
      getPNForLID: async (lid) =>
        String(lid).startsWith('2154666000111') ? '9230011122233:2@s.whatsapp.net' : null,
      getLIDForPN: async () => null,
    } } },
    '2154666000111@lid');
  assert.equal(admins.roleFor('2154666000111@lid'), 'owner', 'local mapping recognised the owner');

  // linkLidAdmin — fallback: ask for each admin's own LID (USync).
  await admins.linkLidAdmin(
    { signalRepository: { lidMapping: {
      getPNForLID: async () => null,
      getLIDForPN: async (pn) =>
        String(pn).startsWith('9230011122233') ? '2154666000222:1@lid' : null,
    } } },
    '2154666000222@lid');
  assert.equal(admins.roleFor('2154666000222@lid'), 'owner', 'usync fallback recognised the owner');

  // No mapper on the socket → no crash, sender stays unknown.
  await admins.linkLidAdmin({}, '2154666000333@lid');
  assert.equal(admins.roleFor('2154666000333@lid'), null);
});

test('audit entries carry actor/role/action/target and are debounced to disk', async () => {
  admins.appendAudit({
    actor: '9230000000001', role: 'owner', action: 'order.confirm',
    target: 'SMF-9001', detail: 'unit',
  });
  const rows = admins.recentAudit(5);
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].action, 'order.confirm');
  assert.equal(rows[0].target, 'SMF-9001');
  assert.equal(rows[0].role, 'owner');
  assert.ok(rows[0].at && !Number.isNaN(Date.parse(rows[0].at)));
  await new Promise((r) => setTimeout(r, 350)); // 200ms debounce
  assert.ok(fs.existsSync(new URL('./.tmp-unit-audit.json', import.meta.url)), 'audit file flushed');
});

test('settings patch, maintenance flag, and broadcast valves from env', () => {
  admins.setSettings({ maintenance: true });
  assert.equal(admins.isMaintenance(), true);
  assert.equal(admins.acceptsOrders(), true); // independent flag
  admins.setSettings({ maintenance: false });
  assert.equal(admins.isMaintenance(), false);

  assert.deepEqual(SETTINGS.broadcastJitterMs, [0, 0], 'BROADCAST_JITTER_MS=0-0');
  assert.equal(SETTINGS.broadcastPerMinute, 60000);
  assert.ok(SETTINGS.confirmTwiceAbove > 0);
});

// ── lib/admins.js: blocklist + broadcast opt-out ─────────────
test('blocklist and STOP opt-out are independent flags', () => {
  admins.blockJid(OUTSIDER, 'unit-test');
  assert.ok(admins.isBlocked(OUTSIDER));
  assert.ok(admins.allBlocked().some((e) => (e.jid || e) === OUTSIDER), 'allBlocked lists the jid');
  admins.unblockJid(OUTSIDER);
  assert.ok(!admins.isBlocked(OUTSIDER));

  admins.optOut(OUTSIDER);
  assert.ok(admins.isOptedOut(OUTSIDER));
  assert.ok(admins.allOptedOut().some((e) => (e.jid || e) === OUTSIDER), 'allOptedOut lists the jid');
  admins.optIn(OUTSIDER);
  assert.ok(!admins.isOptedOut(OUTSIDER));
});

// ── handlers/adminBroadcast.js: audience rules ───────────────
test('resolveAudience dedupes and drops blocked/STOP customers', () => {
  const stamp = new Date().toISOString();
  store.putOrder({ id: 'SMF-9101', jid: OUTSIDER, price: 111, status: 'fulfilled', createdAt: stamp, planName: 'x' });
  store.putOrder({ id: 'SMF-9102', jid: OUTSIDER, price: 111, status: 'fulfilled', createdAt: stamp, planName: 'x' });
  store.putOrder({ id: 'SMF-9103', jid: '9230000000002@s.whatsapp.net', price: 111, status: 'fulfilled', createdAt: stamp, planName: 'x' });

  const all = adminBroadcast.resolveAudience('all');
  assert.equal(all.filter((j) => j === OUTSIDER).length, 1, 'deduped across orders');

  admins.blockJid(OUTSIDER, 'unit-test');
  assert.ok(!adminBroadcast.resolveAudience('all').includes(OUTSIDER), 'blocked dropped');
  admins.unblockJid(OUTSIDER);

  admins.optOut(OUTSIDER);
  assert.ok(!adminBroadcast.resolveAudience('all').includes(OUTSIDER), 'STOP dropped');
  admins.optIn(OUTSIDER);
});

test('broadcastUsage starts from a clean daily counter', () => {
  assert.equal(adminBroadcast.broadcastUsage(), 0);
});

// ── services/verifier.js: payment emails + auto-check ────────
test('autoCheck: no_match -> matched by amount -> amount_mismatch by reference', () => {
  verifier.__resetPayments([]);
  const order = { id: 'SMF-9201', price: 111 };
  assert.equal(verifier.autoCheck(order).status, 'no_match');

  verifier.addPaymentEmail({ txn: 'UNITTXN01', reference: '', amount: 111, currency: 'PKR' });
  assert.equal(verifier.autoCheck(order).status, 'matched');
  assert.equal(verifier.unclaimedPayments().length, 1);

  const order2 = { id: 'SMF-9202', price: 500 };
  verifier.addPaymentEmail({ txn: 'UNITTXN02', reference: 'SMF-9202', amount: 400, currency: 'PKR' });
  const bad = verifier.autoCheck(order2);
  assert.equal(bad.status, 'amount_mismatch');
  assert.equal(bad.payment.txn, 'UNITTXN02');
});

test('linkPayment claims a txn once and unlinkPayment releases it', () => {
  const link = verifier.linkPayment('UNITTXN01', 'SMF-9201', 'unit');
  assert.equal(link.ok, true);
  const again = verifier.linkPayment('UNITTXN01', 'SMF-9299', 'unit');
  assert.equal(again.ok, false, 'already claimed');
  assert.equal(verifier.unlinkPayment('UNITTXN01'), true);
  assert.ok(verifier.unclaimedPayments().some((p) => p.txn === 'UNITTXN01'));
  verifier.__resetPayments([]);
});

// ── lib/admins.js: panel-added admins + channel/group ─────────
test('panel-added admins get roles, env admins stay locked', () => {
  const jid = '9230077000111@s.whatsapp.net';
  const add = admins.addAdmin('030077000111', 'staff', 'unit');
  assert.equal(add.ok, true);
  assert.equal(admins.roleFor(jid), 'staff');
  assert.ok(admins.allAdminJids().includes(jid));
  assert.ok(admins.listAdmins().some((a) => a.number === '9230077000111' && a.source === 'added'));

  const own = admins.addAdmin('030077000222', 'owner', 'unit');
  assert.equal(own.ok, true);
  assert.equal(admins.roleFor('9230077000222@s.whatsapp.net'), 'owner');
  assert.ok(admins.ownerJids().includes('9230077000222@s.whatsapp.net'));

  assert.equal(admins.addAdmin('030077000111', 'staff', 'unit').ok, false, 'duplicate refused');

  const locked = admins.removeAdmin('030098765432'); // STAFF_NUMBERS in .env
  assert.equal(locked.ok, false, '.env admins are locked');
  assert.match(locked.message, /env/i);
  assert.equal(admins.roleFor('9230098765432@s.whatsapp.net'), 'staff');

  assert.equal(admins.removeAdmin('030077000111').ok, true);
  assert.equal(admins.roleFor(jid), null, 'removed admin loses the role');
  assert.equal(admins.removeAdmin('030077000222').ok, true);
  assert.equal(admins.roleFor('9230077000222@s.whatsapp.net'), null);
});

test('channel link override and updates group round-trip', () => {
  const envLink = admins.getChannelLink();
  admins.setSettings({ channelLink: 'https://whatsapp.com/channel/UNIT123' });
  assert.equal(admins.getChannelLink(), 'https://whatsapp.com/channel/UNIT123');
  admins.setSettings({ channelLink: '' });
  assert.equal(admins.getChannelLink(), envLink, 'empty override falls back to env');

  admins.setSettings({ groupJid: '120363000000000099@g.us' });
  assert.equal(admins.getGroupJid(), '120363000000000099@g.us');
  admins.setSettings({ groupJid: '' });
  assert.equal(admins.getGroupJid(), '');
});

test('ordersFor hides customer-deleted orders but keeps the record', () => {
  const jid = '92300777000555@s.whatsapp.net';
  const stamp = new Date().toISOString();
  store.putOrder({ id: 'SMF-9301', jid, price: 111, status: 'fulfilled', createdAt: stamp, planName: 'a' });
  store.putOrder({ id: 'SMF-9302', jid, price: 111, status: 'fulfilled', hidden: true, createdAt: stamp, planName: 'b' });

  const visible = store.ordersFor(jid).map((o) => o.id);
  assert.ok(visible.includes('SMF-9301'));
  assert.ok(!visible.includes('SMF-9302'), 'hidden order gone from the customer view');
  assert.ok(store.allOrders().some((o) => o.id === 'SMF-9302'), 'record kept for admin history');

  delete store.state.orders['SMF-9301'];
  delete store.state.orders['SMF-9302'];
});

test('channel JID setting: bare invite code and full jid both resolve', async () => {
  const ch = await import('../lib/channel.js');
  const savedLink = admins.getChannelLink();
  const savedJid = process.env.WHATSAPP_CHANNEL_JID;
  admins.setSettings({ channelLink: 'https://example.com/no-code' });
  process.env.WHATSAPP_CHANNEL_JID = 'UNITBARE123';
  const sock = { newsletterMetadata: async () => ({ id: '120363111111111111@newsletter' }) };
  try {
    assert.equal(ch.channelInviteCode(), 'UNITBARE123', 'bare code used when the link carries no code');
    ch.clearChannelCache();
    assert.equal(await ch.resolveChannelJid(sock), '120363111111111111@newsletter', 'resolved via newsletterMetadata');
    ch.clearChannelCache();

    process.env.WHATSAPP_CHANNEL_JID = '120363222222222222@newsletter';
    assert.equal(await ch.resolveChannelJid(sock), '120363222222222222@newsletter', 'full jid used directly');
  } finally {
    ch.clearChannelCache();
    if (savedJid === undefined) delete process.env.WHATSAPP_CHANNEL_JID;
    else process.env.WHATSAPP_CHANNEL_JID = savedJid;
    admins.setSettings({ channelLink: '' });
  }
  assert.equal(admins.getChannelLink(), savedLink, 'channel link setting restored');
});
