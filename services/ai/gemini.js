// ─────────────────────────────────────────────────────────────
// services/ai/gemini.js
// Vision: turn a payment screenshot into structured evidence
// (amount / transaction id / merchant / date).
//
// It replaces a heavyweight offline OCR dependency: without
// GEMINI_API_KEY this module reports NOT_CONFIGURED and the engine
// simply carries no screenshot evidence — the deterministic check
// (services/verifier.js) still runs exactly as before.
//
// Failure policy: NEVER throws. No image → NO_IMAGE, no key →
// NOT_CONFIGURED, slow → TIMEOUT, unreadable → UNREADABLE.
// ─────────────────────────────────────────────────────────────
import axios from 'axios';
import { AI_VERIFY } from '../../config.js';
import { log } from '../../lib/logger.js';
import { parseJsonLoose } from './groq.js';

/** What the model must return for one screenshot. */
const READ_PROMPT = [
  'You read payment screenshots for a Pakistani eSIM store.',
  'Return ONLY a compact JSON object, no markdown:',
  '{"amount": <number|null>, "currency": <"PKR"|null>, "txn": <string|null>,',
  ' "merchant": <string|null>, "date": <string|null>, "note": <string|null>}',
  'amount must be the money the customer SENT (numbers only, no commas).',
  'txn is a transaction/reference id only if it is literally printed on the image.',
  'note is at most 12 words describing what the image shows. If the image is',
  'unreadable, blurred or not a payment at least set every field to null.',
].join(' ');

// ── Transport (injectable for tests) ──────────────────────────
let transport = async (config) => axios(config);
/** Test hook: replace the HTTP transport. Pass null to restore. */
export function __setTransport(fn) {
  transport = fn || (async (config) => axios(config));
}

/** True when screenshot reading is available. */
export const isReady = () => AI_VERIFY.visionEnabled;

/**
 * Read one payment screenshot.
 *
 * @param {Buffer|null} buffer   the downloaded image bytes
 * @param {{mimetype?: string}} [opts]
 * @returns {Promise<{ok:boolean, text?:string, data?:object|null,
 *                    code?:string, error?:string, model?:string,
 *                    latencyMs?:number}>}
 */
export async function readScreenshot(buffer, opts = {}) {
  const startedAt = Date.now();
  if (!buffer || !buffer.length) return { ok: false, code: 'NO_IMAGE' };
  if (!AI_VERIFY.geminiApiKey) return { ok: false, code: 'NOT_CONFIGURED', error: 'GEMINI_API_KEY missing' };

  const mimetype = String(opts.mimetype || 'image/jpeg').split(';')[0] || 'image/jpeg';
  const url = `${AI_VERIFY.geminiBaseUrl}/models/${AI_VERIFY.geminiModel}:generateContent?key=${AI_VERIFY.geminiApiKey}`;
  try {
    const res = await transport({
      method: 'post',
      url,
      timeout: AI_VERIFY.timeoutMs,
      headers: { 'Content-Type': 'application/json' },
      data: {
        contents: [{
          parts: [
            { text: READ_PROMPT },
            { inline_data: { mime_type: mimetype, data: buffer.toString('base64') } },
          ],
        }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' },
      },
    });

    const text = res.data?.candidates?.[0]?.content?.parts
      ?.map((p) => p?.text).filter(Boolean).join('') || '';
    const data = parseJsonLoose(text);
    const latencyMs = Date.now() - startedAt;
    if (!data) {
      log.warn({ event: 'ai.gemini', code: 'UNREADABLE', model: AI_VERIFY.geminiModel, latencyMs }, 'screenshot read produced no JSON');
      return { ok: false, code: 'UNREADABLE', text: String(text).slice(0, 300), model: AI_VERIFY.geminiModel, latencyMs };
    }
    return { ok: true, text: String(text), data: normalize(data), model: AI_VERIFY.geminiModel, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const timedOut = err?.code === 'ECONNABORTED' || /timeout/i.test(String(err?.message || ''));
    const code = timedOut ? 'TIMEOUT' : 'HTTP_ERROR';
    log.warn(
      { event: 'ai.gemini', code, model: AI_VERIFY.geminiModel, latencyMs, error: String(err?.message || '').slice(0, 200) },
      'screenshot read failed',
    );
    return { ok: false, code, error: String(err?.message || err).slice(0, 300), model: AI_VERIFY.geminiModel, latencyMs };
  }
}

/** Coerce whatever the model returned into a typed, safe record. */
export function normalize(raw = {}) {
  const amountRaw = raw?.amount;
  const amount = amountRaw == null || amountRaw === ''
    ? null
    : Number(String(amountRaw).replace(/[^0-9.]/g, ''));
  const currencyRaw = String(raw?.currency || '').toUpperCase();
  return {
    amount: Number.isFinite(amount) && amount > 0 ? amount : null,
    currency: currencyRaw === 'PKR' || currencyRaw === 'USD' || currencyRaw === 'USDT' ? currencyRaw : null,
    txn: cleanToken(raw?.txn),
    merchant: cleanText(raw?.merchant, 60),
    date: cleanText(raw?.date, 32),
    note: cleanText(raw?.note, 120),
    readAt: new Date().toISOString(),
    model: AI_VERIFY.geminiModel,
  };
}

const cleanToken = (value) => {
  const token = String(value ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '');
  return token.length >= 6 && token.length <= 40 ? token : null;
};
const cleanText = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max) || null;
