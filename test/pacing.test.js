// Bot maturity / natural pacing tests (services/pacing.js):
//   human think-time · per-chat serial queue · debounce · nudge gap
// Run with:  node --test test/pacing.test.js
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.MIN_REPLY_DELAY_MS = '700';
process.env.MAX_REPLY_DELAY_MS = '2800';
process.env.DEBOUNCE_WINDOW_MS = '1500';
process.env.BROADCAST_MIN_GAP_MINUTES = '30';

const pacing = await import('../services/pacing.js');
const { SETTINGS } = await import('../config.js');

const JID = '923001111111@s.whatsapp.net';

beforeEach(() => {
  pacing.__reset();
  pacing.__setSleep(null);
  SETTINGS.minReplyDelayMs = 700;
  SETTINGS.maxReplyDelayMs = 2800;
  SETTINGS.debounceWindowMs = 1500;
  SETTINGS.broadcastMinGapMinutes = 30;
});

after(() => {
  pacing.__reset();
  pacing.__setSleep(null);
});

const now = () => Date.now();

// ── humanDelay ────────────────────────────────────────────────
test('humanDelay is 0 when pacing is switched off', () => {
  SETTINGS.minReplyDelayMs = 0;
  SETTINGS.maxReplyDelayMs = 0;
  assert.equal(pacing.humanDelay('a very long message here'), 0);
  assert.equal(pacing.humanDelay(''), 0);
});

test('humanDelay grows with the message and stays inside [min, max]', () => {
  // Jitter is ±15% of the headroom, so each length band has a
  // provable ceiling/floor — assert those instead of exact values.
  const short = pacing.humanDelay('hi');                       // factor ≈ 0.01
  const medium = pacing.humanDelay('a'.repeat(80));             // factor ≈ 0.27
  const long = pacing.humanDelay('a'.repeat(600));              // factor = 1.0

  assert.ok(short >= 700 && short <= 1100, `short=${short}`);
  assert.ok(medium >= 900 && medium <= 1600, `medium=${medium}`);
  assert.ok(long >= 2400 && long <= 2800, `long=${long}`);
  // Clearly separated bands → longer input really does read slower.
  assert.ok(long > medium && medium > short);
});

test('humanDelay never drops below MIN no matter the jitter', () => {
  for (let i = 0; i < 40; i += 1) {
    const d = pacing.humanDelay('');
    assert.ok(d >= 700, `delay ${d} below MIN`);
  }
});

test('humanPause actually sleeps through the injectable timer', async () => {
  const seen = [];
  pacing.__setSleep(async (ms) => { seen.push(ms); });
  const ms = await pacing.humanPause('hello there');
  assert.deepEqual(seen, [ms]);
  assert.ok(ms >= 700 && ms <= 2800);
});

test('humanPause short-circuits when the delay is 0', async () => {
  SETTINGS.minReplyDelayMs = 0;
  SETTINGS.maxReplyDelayMs = 0;
  let slept = false;
  pacing.__setSleep(async () => { slept = true; });
  const ms = await pacing.humanPause('anything');
  assert.equal(ms, 0);
  assert.equal(slept, false);
});

// ── sendNatural ───────────────────────────────────────────────
test('sendNatural delays first, then sends once', async () => {
  const events = [];
  pacing.__setSleep(async (ms) => { events.push(`sleep:${ms >= 700}`); });
  const out = await pacing.sendNatural({}, JID, async () => {
    events.push('send');
    return 'ok';
  }, { text: 'hello' });

  assert.equal(events[0].startsWith('sleep:'), true, 'must wait before sending');
  assert.equal(events.filter((e) => e === 'send').length, 1);
  assert.equal(out, 'ok');
});

test('sendNatural with a non-function send is a no-op', async () => {
  assert.equal(await pacing.sendNatural({}, JID, null), undefined);
});

// ── per-chat serial queue ─────────────────────────────────────
test('enqueue serialises replies per chat and preserves order', async () => {
  const order = [];
  const task = (n) => async () => {
    order.push(`start${n}`);
    await new Promise((r) => setTimeout(r, 8));
    order.push(`end${n}`);
    return n;
  };

  const results = await Promise.all([
    pacing.enqueue(JID, task(1)),
    pacing.enqueue(JID, task(2)),
    pacing.enqueue(JID, task(3)),
  ]);

  assert.deepEqual(results, [1, 2, 3]);
  assert.deepEqual(order, ['start1', 'end1', 'start2', 'end2', 'start3', 'end3'],
    'replies to ONE chat must never interleave');
  assert.equal(pacing.queueDepth(JID), 0, 'queue drains when idle');
});

test('a queued task sees depth while it is still behind another', async () => {
  let depthInsideFirst = -1;
  const p1 = pacing.enqueue(JID, async () => {
    depthInsideFirst = pacing.queueDepth(JID);
    await new Promise((r) => setTimeout(r, 10));
  });
  const p2 = pacing.enqueue(JID, async () => 'second');
  await Promise.all([p1, p2]);
  assert.ok(depthInsideFirst >= 1, `expected ≥1 queued behind the first, got ${depthInsideFirst}`);
  assert.equal(pacing.queueDepth(JID), 0);
  assert.equal(pacing.isBusy(JID), false);
});

test('a failing task never poisons the queue behind it', async () => {
  const bad = pacing.enqueue(JID, async () => { throw new Error('boom'); });
  const good = pacing.enqueue(JID, async () => 'still works');

  await assert.rejects(bad, /boom/);
  assert.equal(await good, 'still works');
  assert.equal(pacing.queueDepth(JID), 0);
});

test('different chats run independently (no global lock)', async () => {
  const other = '923009999999@s.whatsapp.net';
  const events = [];

  const slow = pacing.enqueue(JID, async () => {
    events.push('a-start');
    await new Promise((r) => setTimeout(r, 25));
    events.push('a-end');
  });
  const fast = pacing.enqueue(other, async () => { events.push('b-run'); });

  await Promise.all([slow, fast]);
  assert.ok(events.includes('b-run'), 'chat B must not wait for chat A');
  assert.ok(events.indexOf('b-run') < events.indexOf('a-end'),
    'B ran while A was still thinking');
});

// ── debounce ──────────────────────────────────────────────────
test('the same words inside the window are one message, not two', () => {
  assert.equal(pacing.noteArrival(JID, 'menu').duplicate, false, 'first tap always lands');
  assert.equal(pacing.noteArrival(JID, 'menu').duplicate, true, 'immediate double-tap swallowed');
  assert.equal(pacing.noteArrival(JID, '  menu  ').duplicate, true, 'whitespace-insensitive');
});

test('different words are never debounced', () => {
  assert.equal(pacing.noteArrival(JID, 'menu').duplicate, false);
  assert.equal(pacing.noteArrival(JID, 'orders').duplicate, false);
});

test('media / empty text is never debounced (screenshots must land)', () => {
  assert.equal(pacing.noteArrival(JID, '').duplicate, false);
  assert.equal(pacing.noteArrival(JID, '').duplicate, false, 'two blank messages both pass');
  assert.equal(pacing.noteArrival(JID, undefined).duplicate, false);
});

test('a tap outside the window is a fresh message', async () => {
  SETTINGS.debounceWindowMs = 1;
  assert.equal(pacing.noteArrival(JID, 'menu').duplicate, false);
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(pacing.noteArrival(JID, 'menu').duplicate, false, 'window elapsed → allowed again');
});

test('DEBOUNCE_WINDOW_MS = 0 disables the rule entirely', () => {
  SETTINGS.debounceWindowMs = 0;
  assert.equal(pacing.noteArrival(JID, 'menu').duplicate, false);
  assert.equal(pacing.noteArrival(JID, 'menu').duplicate, false);
});

test('each chat has its own debounce record', () => {
  const other = '923008888888@s.whatsapp.net';
  assert.equal(pacing.noteArrival(JID, 'menu').duplicate, false);
  assert.equal(pacing.noteArrival(other, 'menu').duplicate, false, 'different chat, first tap');
  assert.equal(pacing.noteArrival(JID, 'menu').duplicate, true);
});

// ── proactive nudge gap ───────────────────────────────────────
test('a second nudge inside the gap is held back with a wait time', () => {
  assert.equal(pacing.allowProactive(JID), true, 'first nudge goes out');
  assert.equal(pacing.allowProactive(JID), false, 'second one is suppressed');
  const wait = pacing.proactiveWait(JID);
  assert.ok(wait > 0 && wait <= 30 * 60_000, `wait=${wait}`);
});

test('once the gap has elapsed the nudge is allowed again', () => {
  pacing.allowProactive(JID);
  pacing.__setNudge(JID, 31 * 60_000); // pretend 31 minutes passed
  assert.equal(pacing.proactiveWait(JID), 0);
  assert.equal(pacing.allowProactive(JID), true);
});

test('BROADCAST_MIN_GAP_MINUTES = 0 disables the rule', () => {
  SETTINGS.broadcastMinGapMinutes = 0;
  assert.equal(pacing.allowProactive(JID), true);
  assert.equal(pacing.allowProactive(JID), true);
  assert.equal(pacing.proactiveWait(JID), 0);
});

test('nudge clocks are per chat', () => {
  const other = '923007777777@s.whatsapp.net';
  assert.equal(pacing.allowProactive(JID), true);
  assert.equal(pacing.allowProactive(other), true, 'other customer was never nudged');
  assert.equal(pacing.allowProactive(JID), false);
  // …and that first nudge started ONLY its own clock.
  assert.equal(pacing.allowProactive(other), false, 'now inside its own gap');
  assert.equal(pacing.proactiveWait(other) > 0, true, 'its clock is running');
  assert.equal(pacing.queueDepth(JID), 0, 'silence unused bundle refs');
});

test('__reset clears queue, debounce and nudge state', () => {
  pacing.allowProactive(JID);
  pacing.noteArrival(JID, 'menu');
  pacing.__reset();
  assert.equal(pacing.__lastNudge(JID), null);
  assert.equal(pacing.noteArrival(JID, 'menu').duplicate, false);
  assert.equal(pacing.queueDepth(JID), 0);
  // silence the unused import lint-style warnings
  assert.equal(typeof now, 'function');
});
