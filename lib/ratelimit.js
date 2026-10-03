// ─────────────────────────────────────────────────────────────
// ratelimit.js
// Lightweight anti-spam: sliding window per user + a dedicated
// cooldown on the menu command so nobody can spam the welcome.
// ─────────────────────────────────────────────────────────────
const windows = new Map();   // jid -> [timestamps]
const menuAt = new Map();    // jid -> last menu trigger (ms)
const warnedAt = new Map();  // jid -> throttle-warning timestamp

/**
 * Sliding-window limiter.
 * @returns {{ ok: boolean, warn: boolean }} warn=true => send the
 *          "slow down" notice exactly once per window.
 */
export function checkLimit(jid, max, windowMs) {
  const now = Date.now();
  const list = (windows.get(jid) || []).filter((t) => now - t < windowMs);
  const over = list.length >= max;
  const shouldWarn = over && now - (warnedAt.get(jid) || 0) > windowMs;

  if (shouldWarn) warnedAt.set(jid, now);

  if (over) {
    windows.set(jid, list);
    return { ok: false, warn: shouldWarn };
  }

  list.push(now);
  windows.set(jid, list);
  return { ok: true, warn: false };
}

/**
 * Menu cooldown. Returns true when the trigger is allowed.
 * Repeated menu taps inside `ms` are silently dropped.
 */
export function menuCooldown(jid, ms) {
  const now = Date.now();
  const last = menuAt.get(jid) || 0;
  if (now - last < ms) return false;
  menuAt.set(jid, now);
  return true;
}

export function clearRateLimit(jid) {
  windows.delete(jid);
  warnedAt.delete(jid);
}
