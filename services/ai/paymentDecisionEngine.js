// ─────────────────────────────────────────────────────────────
// services/ai/paymentDecisionEngine.js
// PART B — the AI Payment Decision Engine.
//
// Rule order (never inverted):
//   1. deterministic code decides first   (verifier / binanceVerifier)
//   2. hard invariants force the answer   (no model may override)
//   3. the model is consulted ONLY when code says "I cannot tell"
//   4. whatever the model answers, the invariants are re-checked
//   5. every decision is written to db/aiDecisions.json
//
// Modes (AI_VERIFIER_MODE):
//   off     never call a model
//   shadow  call + report on the admin card, never change an outcome
//   auto    may act, but only when every invariant holds
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { JSONFilePreset } from 'lowdb/node';
import { AI_VERIFY, PATHS } from '../../config.js';
import { log, logError } from '../../lib/logger.js';
import * as groq from './groq.js';

export const DECISIONS = ['approve', 'escalate', 'reject', 'needs_more_info'];

/** Deterministic verdicts a model may NEVER overturn. */
export const HARD_STATUSES = new Set([
  'amount_mismatch', 'already_claimed', 'currency_mismatch', 'outgoing', 'locked',
]);

/** Verdicts that mean "code could not decide" — the only AI entry points. */
export const AMBIGUOUS_STATUSES = new Set(['no_match', 'time_window']);

/** Kept verbatim for the prompt, the card and the README. */
export const INVARIANTS = [
  'A claimed transaction ID can never be re-claimed.',
  'Amount mismatch beyond tolerance always escalates.',
  'Code wins over a bad AI "approve" (downgrade to escalate + log discrepancy).',
];

export const PROMPT_VERSION = 'paymentAnalyst/1';
/** PKR tolerance for "the same amount" (matches services/verifier.js). */
export const AMOUNT_TOLERANCE = 0.5;

// ── Prompt ────────────────────────────────────────────────────
let promptCache = null;
const FALLBACK_PROMPT = [
  '# Payment Analyst',
  'Return STRICT JSON: {"decision":"approve|escalate|reject|needs_more_info",',
  '"confidence":0.0,"reason":"one sentence","selectedTxn":null,"flags":[]}',
  ...INVARIANTS.map((line) => `- ${line}`),
].join('\n');

/** The system prompt (prompts/paymentAnalyst.md), cached after the first read. */
export function systemPrompt() {
  if (promptCache) return promptCache;
  try {
    promptCache = fs.readFileSync(path.join(PATHS.root, 'prompts', 'paymentAnalyst.md'), 'utf8');
  } catch (err) {
    log.warn({ event: 'ai.prompt', error: String(err.message).slice(0, 120) }, 'prompt file missing — using fallback');
    promptCache = FALLBACK_PROMPT;
  }
  return promptCache;
}

/** Test hook: forget the cached prompt. */
export function __clearPromptCache() {
  promptCache = null;
}

// ── Decision log (db/aiDecisions.json) ────────────────────────
const AI_DEFAULTS = () => ({ decisions: [], meta: { lastAt: null, lastDecision: null } });

function normalizeAi(data) {
  const doc = data && typeof data === 'object' ? data : {};
  doc.decisions = Array.isArray(doc.decisions) ? doc.decisions : [];
  doc.meta = doc.meta && typeof doc.meta === 'object' ? doc.meta : {};
  return doc;
}

async function openAi() {
  fs.mkdirSync(path.dirname(PATHS.aiDecisions), { recursive: true });
  try {
    return await JSONFilePreset(PATHS.aiDecisions, AI_DEFAULTS());
  } catch (err) {
    const backup = `${PATHS.aiDecisions}.corrupt-${Date.now()}`;
    console.warn(`[ai] ${PATHS.aiDecisions} unreadable (${err.message}) — backing up to ${backup}.`);
    try { fs.renameSync(PATHS.aiDecisions, backup); } catch { /* ignore */ }
    return JSONFilePreset(PATHS.aiDecisions, AI_DEFAULTS());
  }
}

let aiDb = null;
let aiState = AI_DEFAULTS();
let aiReady = null;

async function ensureAi() {
  if (aiReady) return aiReady;
  aiReady = (async () => {
    aiDb = await openAi();
    aiState = normalizeAi(aiDb.data);
  })();
  return aiReady;
}
await ensureAi();

let aiTimer = null;
function saveAi() {
  if (aiTimer) return;
  aiTimer = setTimeout(() => {
    aiTimer = null;
    aiDb.write().catch((err) => {
      console.error(`[ai] Failed to persist decisions: ${err.message}`);
      logError('ai.write', err);
    });
  }, 200);
}

/** Append one decision (newest last, capped). Never throws. */
export function recordDecision(entry) {
  try {
    const record = {
      id: `ai-${Date.now().toString(36)}-${aiState.decisions.length}`,
      at: new Date().toISOString(),
      ...entry,
    };
    aiState.decisions.push(record);
    if (aiState.decisions.length > 500) aiState.decisions = aiState.decisions.slice(-500);
    aiState.meta.lastAt = record.at;
    aiState.meta.lastDecision = record.decision;
    saveAi();
    return record;
  } catch (err) {
    logError('ai.record', err);
    return null;
  }
}

/** Newest-first slice for the admin / dashboard. */
export function recentDecisions(limit = 10) {
  return aiState.decisions.slice(-Number(limit) || 10).reverse();
}

/** Everything recorded for one order (newest first). */
export function decisionsFor(orderId) {
  return aiState.decisions.filter((d) => d.orderId === orderId).reverse();
}

/** Test helper — replace the in-memory log. */
export function __resetDecisions(doc = null) {
  aiState = normalizeAi(doc || AI_DEFAULTS());
  saveAi();
}

// ── Is this case even the model's business? ───────────────────
/**
 * True only when the deterministic layer could not decide AND there is
 * something for a model to reason about.
 *
 * @param {{deterministic?: object, evidence?: object}} args
 */
export function isAmbiguous({ deterministic, evidence } = {}) {
  const status = String(deterministic?.status || '');
  if (!status) return false;
  if (HARD_STATUSES.has(status)) return false;
  if (status === 'match' || status === 'matched') return false;
  if (!AMBIGUOUS_STATUSES.has(status)) return false;
  const candidates = Number(evidence?.candidates?.length || 0);
  return candidates > 0 || Boolean(evidence?.screenshot?.amount) || Boolean(evidence?.transaction);
}

// ── Hard invariants ───────────────────────────────────────────
/** Flags a model may never argue away (invariants 1 + 2). */
export const HARD_FLAGS = new Set([
  'code_amount_mismatch', 'code_already_claimed', 'code_currency_mismatch',
  'code_outgoing', 'ocr_amount_mismatch',
]);

/**
 * Everything the model is NOT allowed to undo.
 * @returns {string[]} short snake_case flags
 */
export function hardViolations({ order, deterministic, evidence } = {}) {
  const flags = [];
  const status = String(deterministic?.status || '');
  if (status === 'amount_mismatch') flags.push('code_amount_mismatch');
  if (status === 'already_claimed') flags.push('code_already_claimed');
  if (status === 'currency_mismatch') flags.push('code_currency_mismatch');
  if (status === 'outgoing') flags.push('code_outgoing');

  // Vision read an amount that is not what we are owed (invariant 2).
  const seen = Number(evidence?.screenshot?.amount);
  const want = Number(order?.paidAmount || order?.price || 0);
  if (Number.isFinite(seen) && seen > 0 && want > 0 && Math.abs(seen - want) > AMOUNT_TOLERANCE) {
    flags.push('ocr_amount_mismatch');
  }
  return flags;
}

/** The exact JSON we send the analyst (stable → cheap to test). */
export function buildUserPrompt({ order, deterministic, evidence } = {}) {
  return JSON.stringify({
    order: {
      id: order?.id || null,
      method: order?.paymentLabel || order?.paymentId || null,
      amountDuePkr: Number(order?.paidAmount || order?.price || 0),
      quantity: Math.max(1, Number(order?.quantity) || 1),
      item: order?.planName || null,
    },
    deterministic: {
      status: deterministic?.status || null,
      detail: deterministic?.detail || null,
    },
    evidence: {
      screenshot: evidence?.screenshot || null,
      candidates: (Array.isArray(evidence?.candidates) ? evidence.candidates : []).slice(0, 5),
      transaction: evidence?.transaction || null,
      submittedAt: evidence?.submittedAt || null,
    },
    invariants: INVARIANTS,
  }, null, 2);
}

/** Race a model call against the budget — the timer never holds the process. */
function withTimeout(promise, ms) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('AI decision timeout');
      err.code = 'TIMEOUT';
      reject(err);
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

const clamp = (value, fallback = 0.5) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
};

const uniqueFlags = (list) => [...new Set((Array.isArray(list) ? list : [])
  .map((f) => String(f).trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_|_$/g, ''))
  .filter(Boolean))].slice(0, 8);

/**
 * THE decision point.
 *
 * @param {{order, kind?, deterministic, evidence?, deps?}} args
 * @returns {Promise<null|{decision, confidence, reason, flags, source,
 *          model, mayAct, latencyMs, orderId, kind, aiCalled}>}
 *          null → the engine had nothing to add (code stays in charge).
 */
export async function decide({ order, kind = 'payment', deterministic, evidence = {}, deps = {} } = {}) {
  // 0. Engine off → never call a model, never write a record.
  if (AI_VERIFY.mode === 'off' || !AI_VERIFY.groqApiKey) return null;

  const orderId = order?.id || null;
  const status = String(deterministic?.status || '');
  const settled = status === 'match' || status === 'matched';
  const flags = hardViolations({ order, deterministic, evidence });
  const detail = deterministic?.detail || '';

  // 1. Invariant 1 + 2: a forced verdict is not a conversation. It is
  //    still recorded so the admin card can say WHY the model stayed
  //    out — but never against a case the code already settled.
  if (flags.length > 0 && !settled) {
    return finish({
      order, kind, orderId, decision: 'escalate', confidence: 1,
      reason: detail || 'hard invariant', flags, source: 'code',
      model: null, aiCalled: false, latencyMs: 0, deterministic, evidence,
    });
  }

  // 2. Only ambiguous cases reach the model.
  if (!isAmbiguous({ deterministic, evidence })) return null;

  // 3. Ask the analyst.
  const analyse = deps.analyse || groq.analyse;
  let res = null;
  let latencyMs = 0;
  try {
    res = await withTimeout(
      Promise.resolve(analyse({
        system: systemPrompt(),
        user: buildUserPrompt({ order, deterministic, evidence }),
      })),
      AI_VERIFY.timeoutMs,
    );
    latencyMs = Number(res?.latencyMs) || 0;
  } catch (err) {
    res = { ok: false, code: err?.code === 'TIMEOUT' ? 'TIMEOUT' : 'THREW', error: String(err?.message || err).slice(0, 200) };
  }

  if (!res?.ok || !res?.json) {
    // 4. Unusable answer → the admin gets it, never a guess.
    const code = String(res?.code || 'NO_ANSWER');
    return finish({
      order, kind, orderId, decision: 'escalate', confidence: 0,
      reason: `analyst unavailable (${code.toLowerCase()}) — needs a human`,
      flags: uniqueFlags([...flags, `ai_${code.toLowerCase()}`]),
      source: 'fallback', model: res?.model || AI_VERIFY.groqModel,
      aiCalled: true, latencyMs, deterministic, evidence,
    });
  }

  const raw = res.json || {};
  const asked = DECISIONS.includes(raw.decision) ? raw.decision : null;
  if (!asked) {
    return finish({
      order, kind, orderId, decision: 'escalate', confidence: 0,
      reason: 'analyst returned an unknown verdict — needs a human',
      flags: uniqueFlags([...flags, 'ai_bad_schema']),
      source: 'fallback', model: res?.model || AI_VERIFY.groqModel,
      aiCalled: true, latencyMs, deterministic, evidence,
    });
  }

  const answerFlags = uniqueFlags([...flags, ...(raw.flags || [])]);
  const confidence = clamp(raw.confidence, 0.5);
  let decision = asked;
  let downgraded = false;

  // 5. Re-check the invariants against the model's answer.
  if (decision === 'approve') {
    const conflict = invariantConflict({ order, evidence, raw, flags: answerFlags });
    if (conflict) {
      decision = 'escalate';
      downgraded = true;
      answerFlags.push('ai_code_conflict');
      log.warn(
        { event: 'ai.conflict', orderId, model: res?.model, asked, reason: String(raw.reason || '').slice(0, 160) },
        'AI approve downgraded by an invariant',
      );
    }
  }

  return finish({
    order, kind, orderId,
    decision,
    confidence: decision === 'approve' ? confidence : Math.min(confidence, 0.99),
    reason: String(raw.reason || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    flags: uniqueFlags(answerFlags),
    source: 'ai',
    model: res?.model || AI_VERIFY.groqModel,
    aiCalled: true,
    latencyMs,
    downgraded,
    deterministic,
    evidence,
    raw: { selectedTxn: raw.selectedTxn || null, amountSeen: raw.amountSeen ?? null },
  });
}

/** Invariant 3: the picked transaction must exist, be free, and be the right money. */
function invariantConflict({ order, evidence, raw, flags }) {
  if (flags.some((f) => HARD_FLAGS.has(f))) return true;
  const selected = String(raw?.selectedTxn || '').trim();
  if (!selected) return false;
  const candidates = Array.isArray(evidence?.candidates) ? evidence.candidates : [];
  if (candidates.length === 0) return false; // nothing to contradict
  const found = candidates.find((c) => String(c?.txn || c?.id || '') === selected);
  if (!found) return true; // invented id
  if (found.status === 'claimed' && found.matchedOrder && found.matchedOrder !== order?.id) return true;
  // Invariant 2 — the picked payment must be the money we are owed.
  const want = Number(order?.paidAmount || order?.price || 0);
  const got = Number(found.amount);
  if (want > 0 && Number.isFinite(got) && Math.abs(got - want) > AMOUNT_TOLERANCE) return true;
  return false;
}

/** Stamp, persist and return the record. */
function finish({
  order, kind, orderId, decision, confidence, reason, flags, source,
  model, aiCalled, latencyMs = 0, downgraded = false, deterministic, evidence, raw,
}) {
  const result = {
    decision,
    confidence: clamp(confidence, decision === 'approve' ? 0.6 : 0.5),
    reason: String(reason || '').slice(0, 200),
    flags: uniqueFlags(flags),
    source,
    model: model || null,
    mode: AI_VERIFY.mode,
    mayAct: decision === 'approve' && AI_VERIFY.mode === 'auto' && source !== 'fallback',
    aiCalled: Boolean(aiCalled),
    downgraded,
    latencyMs,
    orderId,
    kind,
    picked: raw?.selectedTxn || null,
    promptVersion: PROMPT_VERSION,
  };
  recordDecision({
    ...result,
    status: deterministic?.status || null,
    candidates: (evidence?.candidates || []).length,
    picked: raw?.selectedTxn || null,
  });
  if (order) stampDecision(order, result);
  return result;
}

/** Put the verdict on the order so the admin card can show it. */
export function stampDecision(order, result) {
  if (!order || !result) return order;
  order.aiDecision = {
    decision: result.decision,
    confidence: result.confidence,
    reason: result.reason,
    flags: result.flags,
    source: result.source,
    model: result.model,
    mode: result.mode,
    mayAct: Boolean(result.mayAct),
    at: new Date().toISOString(),
  };
  return order;
}

/** One line for the admin order card (null when nothing to say). */
export function cardLine(order) {
  const d = order?.aiDecision;
  if (!d?.decision) return null;
  const pct = Math.round(clamp(d.confidence, 0) * 100);
  const flagText = Array.isArray(d.flags) && d.flags.length ? ` · [${d.flags.slice(0, 3).join(', ')}]` : '';
  const who = d.source === 'ai' ? (d.model || 'ai') : d.source;
  return `🧠 AI (${d.mode} · ${who}): *${d.decision}* ${pct}% — ${String(d.reason || '').slice(0, 90)}${flagText}`;
}
