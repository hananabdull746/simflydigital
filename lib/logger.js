// ─────────────────────────────────────────────────────────────
// lib/logger.js
// pino logger that writes every order / admin / connection event
// to logs/bot.log (git-ignored). Console output stays pretty; the
// file gets structured JSON lines you can grep or pipe anywhere.
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { PATHS } from '../config.js';

let stream = null;
try {
  // mkdir the PARENT (logs/) — not the log file itself.
  fs.mkdirSync(path.dirname(PATHS.log), { recursive: true });
  // sync writes: log volume is tiny and we never want to lose the
  // last line when the process exits.
  stream = pino.destination({ dest: PATHS.log, sync: true, append: true });
} catch (err) {
  console.warn(`[logger] Cannot open ${PATHS.log} (${err.message}) — file logging disabled.`);
}

export const log = stream
  ? pino({ level: process.env.LOG_LEVEL || 'info' }, stream)
  : pino({ level: 'silent' });

/** Order lifecycle: created / screenshot / reminder / confirmed / rejected / delivered. */
export const logOrder = (event, order, extra = {}) =>
  log.info({ event, orderId: order?.id, plan: order?.planName, status: order?.status, ...extra }, `order:${event}`);

/** Admin commands + supplier purchase results. */
export const logAdmin = (event, extra = {}) => log.info({ event, ...extra }, `admin:${event}`);

/** Connection + startup problems (still mirrored to the console). */
export const logError = (scope, err, extra = {}) =>
  log.error({ scope, err: err?.message || String(err), ...extra }, `error:${scope}`);
