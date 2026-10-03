// ─────────────────────────────────────────────────────────────
// lib/lang.js
// Tiny i18n layer: t(key, vars, lang).
//
//   locales/ur.json → Roman Urdu + English mix (the bot's default)
//   locales/en.json → Full English
//
// Strings are looked up by flat key with {placeholder} interpolation.
// Missing keys fall back en → ur → the key itself, so a typo is
// visible but never crashes a chat.
//
// A key may hold EITHER a plain string OR an array of 3–4 phrasing
// variants (message variety — see locales/*.json). Variants differ
// only in the conversational wrapper; the FOOTER and core facts are
// identical. The same variant is never picked twice in a row.
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../config.js';

function load(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(PATHS.locales, `${name}.json`), 'utf8'));
  } catch (err) {
    console.warn(`[lang] locales/${name}.json unreadable (${err.message}).`);
    return {};
  }
}

const LOCALES = { en: load('en'), ur: load('ur') };

/** Languages the bot can render (default first). */
export const LANGS = ['ur', 'en'];
export const DEFAULT_LANG = 'ur';

// ── Variant picker ────────────────────────────────────────────
// Last index chosen per `${scope}|${key}` so the SAME variant is
// never shown twice running (even across different callers).
const lastPicked = new Map();

const randomIndex = (n) => Math.floor(Math.random() * n);

// Swappable so tests can pin variant selection (see __setVariantPicker).
let pickIndexImpl = randomIndex;

/** Choose a variant index, avoiding an immediate repeat. */
function chooseIndex(list, scopeKey) {
  const n = list.length;
  if (n <= 1) return 0;
  const previous = lastPicked.get(scopeKey);
  let idx = Math.abs(pickIndexImpl(n)) % n;
  if (previous !== undefined && idx === previous) idx = (idx + 1) % n;
  lastPicked.set(scopeKey, idx);
  return idx;
}

/**
 * Resolve a locale entry that may be a string or a variant array.
 * @param {string|string[]} entry
 * @param {string} key   locale key (used for the no-repeat memory)
 * @param {string} scope optional caller scope (e.g. a JID) so the
 *                       no-repeat memory is per conversation
 */
export function pickVariant(entry, key, scope = '') {
  if (!Array.isArray(entry)) return entry;
  return entry[chooseIndex(entry, `${scope}|${key}`)];
}

export function t(key, vars = {}, lang = DEFAULT_LANG, scope = '') {
  const dict = LOCALES[lang] || LOCALES[DEFAULT_LANG] || {};
  let str = dict[key] ?? LOCALES.en[key] ?? LOCALES.ur[key] ?? key;
  str = pickVariant(str, key, scope);
  for (const [k, v] of Object.entries(vars || {})) {
    str = String(str).split(`{${k}}`).join(String(v));
  }
  return str;
}

/** Test helper — force-reload the dictionaries after an edit. */
export function __reload() {
  LOCALES.en = load('en');
  LOCALES.ur = load('ur');
  lastPicked.clear();
}

/**
 * Test helper — pin the variant picker so assertions are stable.
 * Pass null to restore the random picker.
 */
export function __setVariantPicker(fn) {
  pickIndexImpl = fn || randomIndex;
}
