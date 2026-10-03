// ─────────────────────────────────────────────────────────────
// lib/steps.js
// The order-flow state machine, in ONE place.
//
// CHECKOUT IS TWO STEPS now (it used to be four):
//   Step 1 — Choose & Confirm  plan / product + quantity, the
//            one-time device micro-check (eSIM support + factory
//            unlock) and the activation email when a digital
//            product needs one.
//   Step 2 — Pay               payment method, account details and
//            the proof (payment screenshot / Binance Transaction
//            ID).
//
// After the proof is sent the session moves to
// `awaiting_confirmation` — that is an admin / auto-verifier
// decision, NOT a checkout step, so it never gets a
// "Step X of Y" prefix (stepPrefix() returns '' for it).
//
// Both catalogues share the SAME two steps, so the counter never
// jumps around between them or between payment methods:
//   eSIM     → product_qty → payment
//   digital  → product_qty → payment
// 💳 Binance Pay keeps both steps but relabels the second one —
// it wants a Transaction ID, not a screenshot: pass { binance:true }.
// ─────────────────────────────────────────────────────────────

/** The two steps of a checkout, in order. */
export const CHECKOUT_STEPS = [
  { id: 'product_qty', label: 'Choose & Confirm' },
  { id: 'payment', label: 'Pay' },
];

/** Back-compat aliases (both catalogues are identical now). */
export const ORDER_STEPS = CHECKOUT_STEPS;
export const DIGITAL_STEPS = CHECKOUT_STEPS;

/** Canonical session `step` values. */
export const STEP_PRODUCT_QTY = 'product_qty';
export const STEP_PAYMENT = 'payment';
export const STEP_AWAITING = 'awaiting_confirmation';
export const CHECKOUT_STEP_IDS = [STEP_PRODUCT_QTY, STEP_PAYMENT];
/** Steps that exist AFTER checkout — rendered without a prefix. */
export const POST_CHECKOUT_STEPS = [STEP_AWAITING];

/** Label swap applied when { binance: true } is passed to withStep. */
const BINANCE_LABEL = { payment: 'Binance Transaction ID' };

/**
 * Old four-step ids still sitting in db/sessions.json map onto the
 * new two-step machine so an interrupted order keeps resuming.
 *   plan | device | product | email  →  step 1
 *   payment                          →  step 2
 *   screenshot                       →  step 2 (proof still owed)
 */
const LEGACY_STEPS = {
  plan: STEP_PRODUCT_QTY,
  device: STEP_PRODUCT_QTY,
  product: STEP_PRODUCT_QTY,
  email: STEP_PRODUCT_QTY,
  payment: STEP_PAYMENT,
  screenshot: STEP_PAYMENT,
  product_qty: STEP_PRODUCT_QTY,
  awaiting_confirmation: STEP_AWAITING,
};

/** Map any (including pre-refactor) step id onto the current machine. */
export function normalizeStep(step) {
  if (!step) return null;
  return LEGACY_STEPS[step] || null;
}

/** True when this step still sits inside the two-step checkout. */
export function isCheckoutStep(step) {
  return CHECKOUT_STEP_IDS.includes(normalizeStep(step));
}

/** Steps for one checkout ({ binance:boolean }). */
function stepsFor(opts) {
  const list = CHECKOUT_STEPS;
  if (opts && opts.binance) {
    return list.map((s) => (BINANCE_LABEL[s.id] ? { ...s, label: BINANCE_LABEL[s.id] } : s));
  }
  return list;
}

/** 0-based index of a step id (-1 when unknown / post-checkout). */
export function stepIndex(id, opts) {
  return stepsFor(opts).findIndex((s) => s.id === normalizeStep(id));
}

/** "Step 2 of 2: Pay" — "" for an unknown or post-checkout step id. */
export function stepPrefix(id, opts) {
  const list = stepsFor(opts);
  const i = list.findIndex((s) => s.id === normalizeStep(id));
  if (i < 0) return '';
  return `Step ${i + 1} of ${list.length}: ${list[i].label}`;
}

/**
 * Prepend the progress line to a multi-line body (or return it as-is).
 * @param opts { binance?: boolean }
 */
export function withStep(id, body, opts) {
  const prefix = stepPrefix(id, opts);
  if (!prefix) return body;
  return `${prefix}\n${body}`;
}
