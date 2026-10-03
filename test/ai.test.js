// Part B — the AI Payment Decision Engine.
//
//   1. deterministic code decides first  2. hard invariants force the answer
//   3. the model sees ONLY ambiguity     4. invariants re-checked after the model
//   5. every decision is logged
//
// Covers: ambiguity gate, forced escalations (no model call), the two
// downgrades (claimed txn / wrong amount), fallbacks (bad JSON, timeout,
// unknown verdict), the mayAct rule across modes, the decision log cap,
// the admin card line and the vision reader.
//
// Run with:  node --test test/ai.test.js
//
// Env overrides MUST run before any project module loads.
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.STORE_FILE = 'test/.tmp-ai-store.json';
process.env.SESSIONS_FILE = 'test/.tmp-ai-sessions.json';
process.env.USERS_FILE = 'test/.tmp-ai-users.json';
process.env.ADMIN_STATE_FILE = 'test/.tmp-ai-admin.json';
process.env.AUDIT_FILE = 'test/.tmp-ai-audit.json';
process.env.PAYMENTS_FILE = 'test/.tmp-ai-payments.json';
process.env.BINANCE_TX_FILE = 'test/.tmp-ai-binance.json';
process.env.WALLETS_FILE = 'test/.tmp-ai-wallets.json';
process.env.WALLET_TX_FILE = 'test/.tmp-ai-wallettx.json';
process.env.BROADCAST_FILE = 'test/.tmp-ai-broadcast.json';
process.env.AI_DECISIONS_FILE = 'test/.tmp-ai-decisions.json';
process.env.GROQ_API_KEY = 'gsk_test_key_do_not_log';
process.env.GEMINI_API_KEY = 'ai_test_key_do_not_log';
process.env.AI_VERIFIER_MODE = 'shadow';
process.env.ADMIN_WHATSAPP_NUMBER = '030011122233';
process.env.MIN_REPLY_DELAY_MS = '0';
process.env.MAX_REPLY_DELAY_MS = '0';
process.env.DEBOUNCE_WINDOW_MS = '0';
delete process.env.DASHBOARD_PORT;

try {
  for (const f of [
    'ai-store.json', 'ai-sessions.json', 'ai-users.json', 'ai-admin.json',
    'ai-audit.json', 'ai-payments.json', 'ai-binance.json', 'ai-wallets.json',
    'ai-wallettx.json', 'ai-broadcast.json', 'ai-decisions.json',
  ]) {
    fs.rmSync(new URL(`./.tmp-${f}`, import.meta.url), { force: true });
  }
} catch { /* ignore */ }

const engine = await import('../services/ai/paymentDecisionEngine.js');
const groq = await import('../services/ai/groq.js');
const gemini = await import('../services/ai/gemini.js');
const config = await import('../config.js');

const {
  decide, isAmbiguous, hardViolations, stampDecision, cardLine,
  recordDecision, recentDecisions, decisionsFor, __resetDecisions,
  systemPrompt, buildUserPrompt, __clearPromptCache, INVARIANTS, HARD_STATUSES,
} = engine;

// ── fixtures ──────────────────────────────────────────────────
const order = (over = {}) => ({
  id: 'S1001',
  price: 1500,
  paidAmount: 1500,
  quantity: 1,
  paymentId: 'pay_sadapay',
  paymentLabel: 'SadaPay',
  planName: 'GB 30',
  ...over,
});

/** analyse() stub: records every call, replies with `payload`. */
const stubAnalyse = (payload) => {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    if (payload instanceof Error || payload?.code === 'THROWS') {
      throw payload instanceof Error ? payload : new Error('network died');
    }
    return typeof payload === 'function' ? payload(args) : payload;
  };
  fn.calls = calls;
  return fn;
};

const ok = (json) => ({ ok: true, json, text: JSON.stringify(json), model: 'stub-model', latencyMs: 5 });
const approve = (over = {}) => ok({
  decision: 'approve', confidence: 0.93, reason: 'only one free payment matches', selectedTxn: null, ...over,
});

beforeEach(() => {
  __resetDecisions();
  process.env.AI_VERIFIER_MODE = 'shadow';
});

after(async () => {
  process.env.AI_VERIFIER_MODE = 'shadow';
  __resetDecisions();
  // The engine debounces its 200ms write — let it drain, then clean up.
  await new Promise((r) => setTimeout(r, 260));
  for (const f of [
    'ai-store.json', 'ai-sessions.json', 'ai-users.json', 'ai-admin.json',
    'ai-audit.json', 'ai-payments.json', 'ai-binance.json', 'ai-wallets.json',
    'ai-wallettx.json', 'ai-broadcast.json', 'ai-decisions.json',
  ]) {
    fs.rmSync(new URL(`./.tmp-${f}`, import.meta.url), { force: true });
  }
});

// ── 1. the ambiguity gate ─────────────────────────────────────
test('a clean code verdict never reaches the model', async () => {
  const analyse = stubAnalyse(ok({ decision: 'approve' }));
  const out = await decide({
    order: order(),
    deterministic: { status: 'matched', detail: 'exact amount match' },
    evidence: {
      candidates: [{ txn: 'T1', amount: 1500, status: 'unclaimed' }],
      // Even a contradictory OCR read must not disturb a settled code verdict.
      screenshot: { amount: 999, currency: 'PKR' },
    },
    deps: { analyse },
  });
  assert.equal(out, null);
  assert.equal(analyse.calls.length, 0);
  assert.equal(decisionsFor('S1001').length, 0);
});

test('no_match with no evidence is not ambiguous', async () => {
  assert.equal(isAmbiguous({ deterministic: { status: 'no_match' }, evidence: {} }), false);
  assert.equal(isAmbiguous({ deterministic: { status: 'time_window' }, evidence: { transaction: 'T1' } }), true);
  assert.equal(isAmbiguous({ deterministic: { status: 'amount_mismatch' }, evidence: { candidates: [{}] } }), false);
  HARD_STATUSES.forEach((s) => assert.equal(isAmbiguous({ deterministic: { status: s } }), false));

  const analyse = stubAnalyse(ok({ decision: 'approve' }));
  const out = await decide({
    order: order(),
    deterministic: { status: 'no_match' },
    evidence: {},
    deps: { analyse },
  });
  assert.equal(out, null);
  assert.equal(analyse.calls.length, 0);
});

// ── 2. hard invariants: code speaks, the model stays quiet ────
test('amount mismatch escalates without a single model call', async () => {
  const analyse = stubAnalyse(ok({ decision: 'approve' }));
  const out = await decide({
    order: order(),
    deterministic: { status: 'amount_mismatch', detail: 'paid 900, wanted 1500' },
    evidence: { candidates: [{ txn: 'T1', amount: 900, status: 'unclaimed' }] },
    deps: { analyse },
  });
  assert.equal(analyse.calls.length, 0);
  assert.equal(out.decision, 'escalate');
  assert.equal(out.source, 'code');
  assert.equal(out.aiCalled, false);
  assert.equal(out.mayAct, false);
  assert.ok(out.flags.includes('code_amount_mismatch'));
  assert.ok(hardViolations({ deterministic: { status: 'amount_mismatch' } }).includes('code_amount_mismatch'));
});

test('OCR amount that is not what we owe forces an escalation too', async () => {
  const analyse = stubAnalyse(ok({ decision: 'approve' }));
  const out = await decide({
    order: order(),
    deterministic: { status: 'no_match', detail: '2 free payments, none matched' },
    evidence: {
      screenshot: { amount: 999, currency: 'PKR' },
      candidates: [
        { txn: 'T1', amount: 1400, status: 'unclaimed' },
        { txn: 'T2', amount: 1500, status: 'claimed', matchedOrder: 'S0900' },
      ],
    },
    deps: { analyse },
  });
  assert.equal(analyse.calls.length, 0);
  assert.equal(out.decision, 'escalate');
  assert.equal(out.source, 'code');
  assert.ok(out.flags.includes('ocr_amount_mismatch'));
});

// ── 3. an ambiguous case that DOES reach the analyst ──────────
test('shadow mode reports a verdict without acting on it', async () => {
  const analyse = stubAnalyse(approve({ selectedTxn: 'T1' }));
  const out = await decide({
    order: order(),
    deterministic: { status: 'no_match', detail: '2 free payments, none matched' },
    evidence: { candidates: [{ txn: 'T1', amount: 1500, status: 'unclaimed' }] },
    deps: { analyse },
  });
  assert.equal(analyse.calls.length, 1);
  assert.ok(analyse.calls[0].system.includes(INVARIANTS[0]));
  assert.equal(out.decision, 'approve');
  assert.equal(out.source, 'ai');
  assert.equal(out.model, 'stub-model');
  assert.equal(out.mayAct, false, 'shadow must never act');
  assert.equal(out.picked, 'T1');
});

test('auto mode may act — but only for an approve from the model', async () => {
  process.env.AI_VERIFIER_MODE = 'auto';
  const evidence = { candidates: [{ txn: 'T1', amount: 1500, status: 'unclaimed' }] };

  const good = await decide({
    order: order(),
    deterministic: { status: 'no_match' },
    evidence,
    deps: { analyse: stubAnalyse(approve({ selectedTxn: 'T1' })) },
  });
  assert.equal(good.mayAct, true);
  assert.equal(good.decision, 'approve');

  const escalate = await decide({
    order: order(),
    deterministic: { status: 'no_match' },
    evidence,
    deps: { analyse: stubAnalyse(ok({ decision: 'escalate', reason: 'not sure', confidence: 0.4 })) },
  });
  assert.equal(escalate.mayAct, false);
});

test('auto mode still refuses to act when the verdict came from a fallback', async () => {
  process.env.AI_VERIFIER_MODE = 'auto';
  const out = await decide({
    order: order(),
    deterministic: { status: 'time_window', detail: 'just outside the window' },
    evidence: { transaction: { txId: 'BIN-1', amount: 4.98, currency: 'USDT' } },
    deps: { analyse: stubAnalyse({ ok: false, code: 'BAD_JSON' }) },
  });
  assert.equal(out.decision, 'escalate');
  assert.equal(out.source, 'fallback');
  assert.equal(out.mayAct, false);
  assert.ok(out.flags.includes('ai_bad_json'));
});

// ── 4. invariants re-checked AFTER the model answers ──────────
test('approve naming a claimed transaction is downgraded (invariant 1 + 3)', async () => {
  process.env.AI_VERIFIER_MODE = 'auto';
  const analyse = stubAnalyse(approve({ selectedTxn: 'T1', confidence: 0.99 }));
  const out = await decide({
    order: order(),
    deterministic: { status: 'no_match' },
    evidence: { candidates: [{ txn: 'T1', amount: 1500, status: 'claimed', matchedOrder: 'S0900' }] },
    deps: { analyse },
  });
  assert.equal(analyse.calls.length, 1, 'the model is consulted, then corrected');
  assert.equal(out.decision, 'escalate');
  assert.equal(out.downgraded, true);
  assert.equal(out.mayAct, false);
  assert.ok(out.flags.includes('ai_code_conflict'));
});

test('approve naming the wrong amount is downgraded (invariant 2)', async () => {
  process.env.AI_VERIFIER_MODE = 'auto';
  const out = await decide({
    order: order(),
    deterministic: { status: 'no_match' },
    evidence: { candidates: [{ txn: 'T1', amount: 1200, status: 'unclaimed' }] },
    deps: { analyse: stubAnalyse(approve({ selectedTxn: 'T1' })) },
  });
  assert.equal(out.decision, 'escalate');
  assert.equal(out.downgraded, true);
  assert.ok(out.flags.includes('ai_code_conflict'));
  assert.equal(out.mayAct, false);
});

test('approve naming a transaction that is not on the list is downgraded', async () => {
  process.env.AI_VERIFIER_MODE = 'auto';
  const out = await decide({
    order: order(),
    deterministic: { status: 'no_match' },
    evidence: { candidates: [{ txn: 'T1', amount: 1500, status: 'unclaimed' }] },
    deps: { analyse: stubAnalyse(approve({ selectedTxn: 'GHOST-999' })) },
  });
  assert.equal(out.decision, 'escalate');
  assert.equal(out.downgraded, true);
});

// ── 5. model failure always means "a human decides" ───────────
test('timeout, bad schema and off mode all leave the admin in charge', async () => {
  process.env.AI_VERIFIER_MODE = 'auto';
  const evidence = { transaction: { txId: 'BIN-1' } };
  const base = () => ({
    order: order(),
    deterministic: { status: 'time_window', detail: 'outside window' },
    evidence,
  });

  const timedOut = await decide({
    ...base(),
    deps: { analyse: stubAnalyse(Object.assign(new Error('model hung'), { code: 'TIMEOUT' })) },
  });
  assert.equal(timedOut.decision, 'escalate');
  assert.equal(timedOut.source, 'fallback');
  assert.ok(timedOut.flags.includes('ai_timeout'));

  const weird = await decide({
    ...base(),
    deps: { analyse: stubAnalyse(ok({ decision: 'banana' })) },
  });
  assert.equal(weird.decision, 'escalate');
  assert.ok(weird.flags.includes('ai_bad_schema'));

  process.env.AI_VERIFIER_MODE = 'off';
  const off = await decide({
    ...base(),
    deps: { analyse: stubAnalyse(approve()) },
  });
  assert.equal(off, null);
});

// ── 6. every decision is logged ───────────────────────────────
test('the decision log records, slices and caps', async () => {
  const out = await decide({
    order: order(),
    deterministic: { status: 'no_match' },
    evidence: { candidates: [{ txn: 'T1', amount: 1500, status: 'unclaimed' }] },
    deps: { analyse: stubAnalyse(approve({ selectedTxn: 'T1' })) },
  });
  const mine = decisionsFor('S1001');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].decision, out.decision);
  assert.equal(mine[0].kind, 'payment');
  assert.ok(recentDecisions(5)[0].at);

  for (let i = 0; i < 501; i += 1) recordDecision({ decision: 'escalate', orderId: 'X', source: 'code' });
  assert.equal(recentDecisions(1000).length, 500, 'the log is capped at 500');
  __resetDecisions();
  assert.equal(recentDecisions(1000).length, 0);
});

// ── 7. what the admin actually sees ───────────────────────────
test('cardLine renders the verdict and disappears without one', async () => {
  assert.equal(cardLine(order()), null);
  assert.equal(cardLine({ aiDecision: {} }), null);

  const o = order();
  stampDecision(o, {
    decision: 'escalate', confidence: 0.71, reason: 'two payments, no clear winner',
    flags: ['ai_time_window'], source: 'ai', model: 'stub-model', mode: 'auto', mayAct: false,
  });
  const line = cardLine(o);
  assert.match(line, /^🧠 AI \(auto · stub-model\): \*escalate\* 71%/);
  assert.ok(line.includes('ai_time_window'));
  assert.ok(line.includes('two payments, no clear winner'));
  assert.equal(o.aiDecision.mayAct, false);
});

test('the prompt carries the three invariants verbatim', async () => {
  const prompt = systemPrompt();
  for (const line of INVARIANTS) assert.ok(prompt.includes(line), `prompt must state: ${line}`);
  assert.equal(INVARIANTS[0], 'A claimed transaction ID can never be re-claimed.');
  assert.equal(INVARIANTS[1], 'Amount mismatch beyond tolerance always escalates.');
  assert.equal(INVARIANTS[2], 'Code wins over a bad AI "approve" (downgrade to escalate + log discrepancy).');

  const user = buildUserPrompt({
    order: order({ quantity: 2 }),
    deterministic: { status: 'no_match', detail: 'x' },
    evidence: { candidates: [{ txn: 'T1', amount: 1500, status: 'unclaimed' }] },
  });
  const parsed = JSON.parse(user);
  assert.equal(parsed.order.amountDuePkr, 1500);
  assert.equal(parsed.order.quantity, 2);
  assert.deepEqual(parsed.invariants, INVARIANTS);

  __clearPromptCache();
  assert.ok(systemPrompt().length > 0);
});

// ── 8. the two transport modules ──────────────────────────────
test('groq parses fenced / chatty JSON and reports clean failures', async () => {
  assert.deepEqual(groq.parseJsonLoose('{"a":1}'), { a: 1 });
  assert.deepEqual(groq.parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(groq.parseJsonLoose('Sure! {"a": 1,} hope that helps'), { a: 1 });
  assert.equal(groq.parseJsonLoose('no json here'), null);

  assert.equal((await groq.analyse({ system: '', user: 'x' })).code, 'BAD_INPUT');

  let sent = null;
  groq.__setTransport(async (cfg) => {
    sent = cfg;
    return { data: { choices: [{ message: { content: '{"decision":"escalate"}' } }] } };
  });
  try {
    const res = await groq.analyse({ system: 'sys', user: 'usr' });
    assert.equal(res.ok, true);
    assert.equal(res.json.decision, 'escalate');
    assert.equal(sent.data.response_format.type, 'json_object');
    assert.equal(sent.data.temperature, 0.1);

    groq.__setTransport(async () => ({ data: { choices: [{ message: { content: 'I cannot decide today' } }] } }));
    assert.equal((await groq.analyse({ system: 's', user: 'u' })).code, 'BAD_JSON');

    groq.__setTransport(async () => {
      const err = new Error('timeout of 1ms exceeded');
      err.code = 'ECONNABORTED';
      throw err;
    });
    assert.equal((await groq.analyse({ system: 's', user: 'u' })).code, 'TIMEOUT');
  } finally {
    groq.__setTransport(null);
  }
});

test('gemini turns an image into typed evidence (or says why it could not)', async () => {
  assert.equal((await gemini.readScreenshot(null)).code, 'NO_IMAGE');

  const normalized = gemini.normalize({
    amount: 'PKR 1,500', currency: 'pkr', txn: 'TX-12345', merchant: '  Naya   Pay ',
    date: null, note: 'a receipt',
  });
  assert.equal(normalized.amount, 1500);
  assert.equal(normalized.currency, 'PKR');
  assert.equal(normalized.txn, 'TX-12345');
  assert.equal(normalized.merchant, 'Naya Pay');
  assert.equal(gemini.normalize({ amount: 'n/a', txn: '12' }).amount, null);
  assert.equal(gemini.normalize({ amount: '12', txn: '12' }).txn, null, 'ids shorter than 6 are dropped');

  gemini.__setTransport(async () => ({
    data: { candidates: [{ content: { parts: [{ text: '{"amount":"1500","currency":"PKR","txn":"TX-12345"}' }] } }] },
  }));
  try {
    const read = await gemini.readScreenshot(Buffer.from('fake-image'), { mimetype: 'image/png' });
    assert.equal(read.ok, true);
    assert.equal(read.data.amount, 1500);
    assert.equal(read.data.model, config.AI_VERIFY.geminiModel);

    gemini.__setTransport(async () => ({ data: { candidates: [{ content: { parts: [{ text: 'blurry' }] } }] } }));
    assert.equal((await gemini.readScreenshot(Buffer.from('x'))).code, 'UNREADABLE');
  } finally {
    gemini.__setTransport(null);
  }
});

test('the engine is wired to the config modes it advertises', () => {
  assert.ok(['off', 'shadow', 'auto'].includes(config.AI_VERIFY.mode));
  process.env.AI_VERIFIER_MODE = 'auto';
  assert.equal(config.AI_VERIFY.mode, 'auto');
  process.env.AI_VERIFIER_MODE = 'nonsense';
  assert.equal(config.AI_VERIFY.mode, 'shadow');
  process.env.AI_VERIFIER_MODE = 'shadow';
  assert.equal(config.AI_VERIFY.enabled, true);
});
