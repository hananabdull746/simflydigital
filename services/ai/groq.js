// ─────────────────────────────────────────────────────────────
// services/ai/groq.js
// The analyst call: ONE low-temperature JSON verdict per ambiguous
// payment (Groq chat completions, JSON mode).
//
// This module never decides anything itself — it only fetches a
// model answer and hands it back. services/ai/paymentDecisionEngine.js
// owns the rules (which cases are ambiguous, which invariants win).
//
// Failure policy: every function NEVER throws. No key → NOT_CONFIGURED,
// timeout → TIMEOUT, unparseable → BAD_JSON — the engine turns those
// into an admin escalation, never into a silent "ok".
// ─────────────────────────────────────────────────────────────
import axios from 'axios';
import { AI_VERIFY } from '../../config.js';
import { log } from '../../lib/logger.js';

/** Loose JSON reader: tolerates ``` fences, chatter and trailing commas. */
export function parseJsonLoose(text) {
  if (text == null) return null;
  if (typeof text === 'object') return text;
  const raw = String(text).trim();
  if (!raw) return null;
  const direct = tryParse(raw);
  if (direct) return direct;
  const fenced = raw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
  const fencedParse = tryParse(fenced);
  if (fencedParse) return fencedParse;
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start >= 0 && end > start) return tryParse(fenced.slice(start, end + 1));
  return null;
}

function tryParse(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    try {
      // Trailing commas are a common model slip.
      const value = JSON.parse(String(text).replace(/,\s*([}\]])/g, '$1'));
      return value && typeof value === 'object' ? value : null;
    } catch {
      return null;
    }
  }
}

// ── Transport (injectable for tests) ──────────────────────────
let transport = async (config) => axios(config);
/** Test hook: replace the HTTP transport. Pass null to restore. */
export function __setTransport(fn) {
  transport = fn || (async (config) => axios(config));
}

/** True when the analyst can be called at all. */
export const isReady = () => AI_VERIFY.enabled;

/**
 * Ask the analyst for one JSON verdict.
 *
 * @param {{system: string, user: string, temperature?: number}} args
 * @returns {Promise<{ok:boolean, json?:object|null, text?:string,
 *                    code?:string, error?:string, model?:string,
 *                    latencyMs?:number}>}
 */
export async function analyse({ system, user, temperature = 0.1 } = {}) {
  const startedAt = Date.now();
  if (!AI_VERIFY.groqApiKey) return { ok: false, code: 'NOT_CONFIGURED', error: 'GROQ_API_KEY missing' };
  if (!system || !user) return { ok: false, code: 'BAD_INPUT', error: 'missing prompt' };

  const url = `${AI_VERIFY.groqBaseUrl}/chat/completions`;
  try {
    const res = await transport({
      method: 'post',
      url,
      timeout: AI_VERIFY.timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AI_VERIFY.groqApiKey}`,
      },
      data: {
        model: AI_VERIFY.groqModel,
        temperature,
        max_tokens: 400,
        // JSON mode: the model is forced to answer with an object.
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      },
    });

    const text = res.data?.choices?.[0]?.message?.content ?? '';
    const json = parseJsonLoose(text);
    const latencyMs = Date.now() - startedAt;
    if (!json) {
      log.warn({ event: 'ai.groq', model: AI_VERIFY.groqModel, code: 'BAD_JSON', latencyMs }, 'analyst returned no JSON');
      return { ok: false, code: 'BAD_JSON', text: String(text).slice(0, 400), model: AI_VERIFY.groqModel, latencyMs };
    }
    return { ok: true, json, text: String(text), model: AI_VERIFY.groqModel, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const timedOut = err?.code === 'ECONNABORTED' || /timeout/i.test(String(err?.message || ''));
    const code = timedOut ? 'TIMEOUT' : 'HTTP_ERROR';
    log.warn(
      { event: 'ai.groq', code, model: AI_VERIFY.groqModel, latencyMs, error: String(err?.message || '').slice(0, 200) },
      'analyst call failed',
    );
    return { ok: false, code, error: String(err?.message || err).slice(0, 300), model: AI_VERIFY.groqModel, latencyMs };
  }
}
