// ─────────────────────────────────────────────────────────────
// lib/reviews.js
// Local review log (db/reviews.json, lowdb). Every captured review
// lands here — both the ones auto-broadcast to the WhatsApp Channel
// (4–5★) and the low-rating ones only forwarded to the admin.
//
// Privacy: entries never contain a customer phone number or JID —
// only the Order ID, plan, rating, comment and the name choice.
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { JSONFilePreset } from 'lowdb/node';
import { PATHS } from '../config.js';
import { logError } from './logger.js';

const DEFAULTS = () => ({ seq: 0, reviews: [] });

function normalize(data) {
  const doc = data && typeof data === 'object' ? data : {};
  doc.seq = Number.isFinite(doc.seq) ? doc.seq : 0;
  doc.reviews = Array.isArray(doc.reviews) ? doc.reviews : [];
  return doc;
}

async function openReviews() {
  fs.mkdirSync(path.dirname(PATHS.reviews), { recursive: true });
  try {
    return await JSONFilePreset(PATHS.reviews, DEFAULTS());
  } catch (err) {
    const backup = `${PATHS.reviews}.corrupt-${Date.now()}`;
    console.warn(`[reviews] ${PATHS.reviews} unreadable (${err.message}) — backing up to ${backup}.`);
    try { fs.renameSync(PATHS.reviews, backup); } catch { /* ignore */ }
    return JSONFilePreset(PATHS.reviews, DEFAULTS());
  }
}

const db = await openReviews();

const state = normalize(db.data);

/** All captured reviews, oldest first. */
export function allReviews() {
  return state.reviews;
}

/** One review by id (REV-0001 …). */
export function getReview(id) {
  return state.reviews.find((r) => r.id === id) || null;
}

/** Patch + persist one review (admin panel: broadcast state …). */
export async function updateReview(id, patch) {
  const record = getReview(id);
  if (!record) return null;
  Object.assign(record, patch);
  try {
    await db.write();
  } catch (err) {
    console.error(`[reviews] Failed to persist ${PATHS.reviews}: ${err.message}`);
    logError('reviews.write', err, { reviewId: id });
  }
  return record;
}

/**
 * Append one review and persist immediately (reviews are rare).
 * @returns {Promise<object>} the stored record (with id + createdAt)
 */
export async function addReview(entry) {
  state.seq = (state.seq || 0) + 1;
  const record = {
    ...entry,
    id: `REV-${String(state.seq).padStart(4, '0')}`,
    createdAt: new Date().toISOString(),
  };
  state.reviews.push(record);
  try {
    await db.write();
  } catch (err) {
    console.error(`[reviews] Failed to persist ${PATHS.reviews}: ${err.message}`);
    logError('reviews.write', err, { reviewId: record.id });
  }
  return record;
}
