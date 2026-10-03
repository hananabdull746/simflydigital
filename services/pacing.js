// ─────────────────────────────────────────────────────────────
// services/pacing.js
// Bot maturity: natural pacing for every reply the bot sends.
//
// Three things live here so no handler has to reimplement them:
//
//   humanDelay(text)   how long a real person would "type" before
//                      answering THIS message — length-proportional
//                      and clamped to MIN_REPLY_DELAY_MS..MAX_REPLY_DELAY_MS
//                      (0/0 = off, which is what the test suite uses)
//
//   enqueue(jid, task) ONE reply at a time per chat. Two messages
//                      landing together are answered in order, never
//                      interleaved — this is what turns a burst into
//                      a batch instead of a race.
//
//   noteArrival(jid,   debounce: an identical message inside
//            text)     DEBOUNCE_WINDOW_MS of the last one is a double
//                      tap and is dropped, so a nervous customer can
//                      never advance (or re-run) a flow twice.
//                      Media (empty text) is never debounced — a
//                      payment screenshot must always get through.
//
//   sendNatural(...)   wait the human delay, then send — used for the
//                      reply itself so the "typing…" indicator stays
//                      up for a believable amount of time.
//
// Every timer is injectable (__setSleep) so tests run instantly.
// ─────────────────────────────────────────────────────────────
import { SETTINGS } from '../config.js';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let sleep = defaultSleep;

/** Test hook: replace the timer. Pass null to restore the real one. */
export function __setSleep(fn) {
  sleep = fn || defaultSleep;
}

/** Test hook: forget every queue + debounce + nudge record. */
export function __reset() {
  tails.clear();
  pending.clear();
  arrivals.clear();
  lastNudge.clear();
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * Think-time before replying to `text`.
 * Short messages sit near the floor, a long paragraph approaches the
 * ceiling; ±15% jitter keeps consecutive replies from looking metronomic.
 * @returns {number} milliseconds (0 when pacing is switched off)
 */
export function humanDelay(text = '') {
  const min = Math.max(0, Number(SETTINGS.minReplyDelayMs) || 0);
  const max = Math.max(min, Number(SETTINGS.maxReplyDelayMs) || 0);
  if (max <= 0) return 0;

  const len = String(text || '').length;
  const factor = clamp(len / 300, 0, 1);
  const base = min + (max - min) * factor;
  const span = (max - min) * 0.15;
  const jitter = span * (Math.random() * 2 - 1);
  return Math.round(clamp(base + jitter, min, max));
}

/** Wait out one natural think-time. Resolves with the delay used. */
export async function humanPause(text = '') {
  const ms = humanDelay(text);
  if (ms > 0) await sleep(ms);
  return ms;
}

/**
 * Natural send: pause (typing indicator stays up), then run `send`.
 * @param {object} sock   the WhatsApp socket (kept for signature symmetry)
 * @param {string} jid    chat the message is going to
 * @param {Function} send  () => Promise — the actual send
 * @param {{text?:string}} opts  `text` drives the length-proportional delay
 */
export async function sendNatural(sock, jid, send, opts = {}) {
  if (typeof send !== 'function') return undefined;
  await humanPause(opts.text ?? '');
  return send(sock, jid);
}

// ── Per-chat serial queue ─────────────────────────────────────
const tails = new Map();
const pending = new Map();

/**
 * Run `task` after everything already queued for `jid`.
 * The returned promise settles when THIS task settles, so callers
 * can await a full reply. A failed task never poisons the chain.
 */
export function enqueue(jid, task) {
  const key = String(jid || '');
  const prev = tails.get(key) || Promise.resolve();
  pending.set(key, (pending.get(key) || 0) + 1);
  const run = prev.then(
    () => (typeof task === 'function' ? task() : task),
    () => (typeof task === 'function' ? task() : task),
  );
  const settle = () => {
    const left = (pending.get(key) || 1) - 1;
    if (left <= 0) {
      pending.delete(key);
      if (tails.get(key) === tail) tails.delete(key);
    } else {
      pending.set(key, left);
    }
  };
  const tail = run.then(settle, settle);
  tails.set(key, tail);
  return run;
}

/** How many replies are queued (including the one in flight) for this chat. */
export function queueDepth(jid) {
  return pending.get(String(jid || '')) || 0;
}

/** True while a reply for this chat is on the wire. */
export function isBusy(jid) {
  return (pending.get(String(jid || '')) || 0) > 0;
}

// ── Debounce (double-tap protection) ──────────────────────────
const arrivals = new Map();

/**
 * Record an inbound message. Returns `{ duplicate: true }` when the
 * SAME text already arrived for this chat inside DEBOUNCE_WINDOW_MS
 * (and the window is switched on). Empty text (media) is never a
 * duplicate — buttons/screenshots must always be processed.
 */
export function noteArrival(jid, text = '') {
  const key = String(jid || '');
  const body = String(text || '').trim();
  const windowMs = Math.max(0, Number(SETTINGS.debounceWindowMs) || 0);
  const now = Date.now();
  const prev = arrivals.get(key);

  if (body && windowMs > 0 && prev && prev.text === body && now - prev.at < windowMs) {
    // Keep the clock on the ORIGINAL so a held-down button stays
    // debounced for the whole window, not for 1.5s per press.
    return { duplicate: true, ageMs: now - prev.at };
  }

  if (body) arrivals.set(key, { at: now, text: body });
  else arrivals.delete(key);
  return { duplicate: false, ageMs: 0 };
}

/** Test helper — read the debounce record for one chat. */
export function __arrival(jid) {
  return arrivals.get(String(jid || '')) || null;
}

// ── Proactive nudge gap ───────────────────────────────────────
const lastNudge = new Map();

const nudgeGapMs = () => Math.max(0, Number(SETTINGS.broadcastMinGapMinutes) || 0) * 60_000;

/**
 * Milliseconds this customer still has to wait before the next
 * proactive nudge may go out (0 = allowed now).
 */
export function proactiveWait(jid) {
  const gapMs = nudgeGapMs();
  if (gapMs <= 0) return 0;
  const last = lastNudge.get(String(jid || ''));
  if (last === undefined) return 0;
  const left = gapMs - (Date.now() - last);
  return left > 0 ? left : 0;
}

/** Record that a proactive nudge just went out to this customer. */
export function markProactive(jid) {
  lastNudge.set(String(jid || ''), Date.now());
}

/**
 * A proactive message (reminder, thank-you, review prompt) may go out
 * only if this customer has not been nudged inside
 * BROADCAST_MIN_GAP_MINUTES. The first nudge is always allowed and
 * starts the clock; a `0` gap means the rule is off.
 *
 * @returns {boolean} true → send it (and the clock has started)
 */
export function allowProactive(jid) {
  if (proactiveWait(jid) > 0) return false;
  markProactive(jid);
  return true;
}

/** Test helper — how long since this customer's last nudge (ms), null if never. */
export function __lastNudge(jid) {
  const last = lastNudge.get(String(jid || ''));
  return last === undefined ? null : Date.now() - last;
}

/** Test hook — forget the nudge clock. */
export function __resetNudges() {
  lastNudge.clear();
}

/** Test hook — back-date the last nudge (ms ago) so a test can cross the gap. */
export function __setNudge(jid, msAgo) {
  if (msAgo === null || msAgo === undefined) lastNudge.delete(String(jid || ''));
  else lastNudge.set(String(jid || ''), Date.now() - Number(msAgo));
}
