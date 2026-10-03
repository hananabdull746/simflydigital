// ─────────────────────────────────────────────────────────────
// handlers/ui.js
// Shared UX helpers used by EVERY handler, so no screen can end
// up in a dead-end or go silent while it thinks.
//
//   withNav(buttons, opts)  append the standard navigation
//                           (🏠 Main Menu / 🙋 Talk to Human)
//   withAck(jid, text, fn)  instant "⏳ working…" acknowledgement
//                           + ONE "Almost there…" follow-up if the
//                           work takes longer than ~4s
//   withListNav(sections)   same navigation as LIST rows
// ─────────────────────────────────────────────────────────────
import { sendText } from '../lib/ui.js';

/** Native quick-reply budget we render before nav would overflow. */
export const BUTTON_LIMIT = 6;

const NAV_BUTTONS = {
  menu: { id: 'main_menu', text: '🏠 Main Menu' },
  human: { id: 'human', text: '🙋 Talk to Human' },
};

/** Row versions for LIST messages (welcome / plans / orders). */
export const NAV_ROWS = {
  menu: { id: 'main_menu', title: '🏠 Main Menu', description: 'Wapas menu par jayein' },
  human: { id: 'human', title: '🙋 Talk to Human', description: 'Hamari team se baat karein' },
  lang: { id: 'lang_toggle', title: '🌐 Language', description: 'English / Roman Urdu' },
};

/**
 * Choice-set version of the rows withListNav() appends — keep the
 * two together so the numbered plain-text fallback always maps the
 * nav rows back to the right id.
 */
export const LIST_NAV_CHOICES = [
  { id: 'main_menu', label: NAV_ROWS.menu.title, keywords: ['menu', 'home', 'main menu'] },
  { id: 'human', label: NAV_ROWS.human.title, keywords: ['human', 'agent', 'person', 'team'] },
  { id: 'lang_toggle', label: NAV_ROWS.lang.title, keywords: ['language', 'lang', 'urdu', 'english'] },
];

// The socket currently serving messages — withAck(jid, text, fn)
// follows the spec signature and uses it for the ack sends.
let uiSocket = null;
export function setUiSocket(sock) {
  if (sock) uiSocket = sock;
}

/**
 * Append the standard navigation buttons.
 * @param buttons [{ id, text }] the screen's own buttons
 * @param opts    { menu?: boolean, human?: boolean }
 * @returns a NEW array (never mutates the input), max BUTTON_LIMIT
 */
export function withNav(buttons = [], opts = {}) {
  const { menu = true, human = true } = opts || {};
  const out = (buttons || []).map((b) => ({ ...b }));
  const has = (id) => out.some((b) => b.id === id);
  if (menu && !has(NAV_BUTTONS.menu.id) && out.length < BUTTON_LIMIT) {
    out.push({ ...NAV_BUTTONS.menu });
  }
  if (human && !has(NAV_BUTTONS.human.id) && out.length < BUTTON_LIMIT) {
    out.push({ ...NAV_BUTTONS.human });
  }
  return out;
}

/**
 * Append a "Menu" section of navigation rows to LIST sections
 * (deduped against rows the screen already shows).
 * @param sections [{ title, rows: [{ id, title, description }] }]
 * @param opts     { include?: ['menu'|'human'|'lang'],
 *                   extraRows?: [{id,title,description}],  // e.g. 🔍 Search
 *                   title?: string }                       // section title
 *
 * WhatsApp caps a LIST at MAX_LIST_SECTIONS(10): when the screen is
 * already at the cap the nav rows are folded into the bottom-most
 * section that still has room, instead of overflowing the message.
 */
export const MAX_LIST_SECTIONS = 10;
export const MAX_LIST_ROWS = 10;

export function withListNav(sections = [], opts = {}) {
  const include = opts.include || ['menu', 'human', 'lang'];
  const out = (sections || []).map((s) => ({ ...s, rows: [...(s.rows || [])] }));
  const have = new Set(out.flatMap((s) => s.rows.map((r) => r.id)));

  const nav = include.map((k) => NAV_ROWS[k]).filter((r) => r && !have.has(r.id));
  const extra = (opts.extraRows || []).filter((r) => r && !have.has(r.id));
  const wanted = [...extra, ...nav];
  if (wanted.length === 0) return out;

  // Room for one more section → the classic standalone Menu section.
  if (out.length < MAX_LIST_SECTIONS) {
    out.push({ title: opts.title || 'Menu', rows: wanted });
    return out;
  }

  // At the section cap: fold the nav into the bottom-most section that
  // still has room, dropping the language row first if that is what it
  // takes to stay ≤ MAX_LIST_ROWS.
  for (const candidate of [wanted, wanted.slice(0, -1)]) {
    if (candidate.length === 0) continue;
    for (let i = out.length - 1; i >= 0; i -= 1) {
      if (out[i].rows.length + candidate.length <= MAX_LIST_ROWS) {
        out[i].rows = [...out[i].rows, ...candidate];
        return out;
      }
    }
  }
  // Nothing fits cleanly — append anyway (last resort, one section over).
  out.push({ title: opts.title || 'Menu', rows: wanted });
  return out;
}

/**
 * Choice-set twin of withNav(): appends the SAME navigation ids in
 * the SAME order, so user.choices mirrors the displayed buttons and
 * the numbered plain-text fallback stays aligned.
 */
export function withNavChoices(choices = [], opts = {}) {
  const { menu = true, human = true } = opts || {};
  const out = (choices || []).map((c) => ({ ...c }));
  const has = (id) => out.some((c) => c.id === id);
  if (menu && !has('main_menu') && out.length < BUTTON_LIMIT) {
    out.push({ id: NAV_BUTTONS.menu.id, label: NAV_BUTTONS.menu.text, keywords: ['menu', 'home', 'main menu'] });
  }
  if (human && !has('human') && out.length < BUTTON_LIMIT) {
    out.push({ id: NAV_BUTTONS.human.id, label: NAV_BUTTONS.human.text, keywords: ['human', 'agent', 'person', 'team'] });
  }
  return out;
}

/**
 * Instant processing acknowledgement.
 *   1. sends `text` immediately ("⏳ Checking availability…")
 *   2. if asyncFn is still running after ~4s, sends ONE
 *      "Almost there…" follow-up (never more than one)
 *   3. runs asyncFn; if it resolves to a non-empty string, that
 *      string is sent as the result (otherwise the caller sends
 *      its own richer result message itself)
 *
 * The router already shows "typing…" presence while a handler
 * runs, so no extra presence updates are needed here.
 */
export async function withAck(jid, text, asyncFn) {
  const sock = uiSocket;
  if (sock && text) {
    try {
      await sendText(sock, jid, text);
    } catch (err) {
      console.warn(`[ui] ack failed for ${jid}: ${err.message}`);
    }
  }

  let slowSent = false;
  const timer = setTimeout(() => {
    if (slowSent || !uiSocket) return;
    slowSent = true;
    sendText(uiSocket, jid, '⏳ Almost there… thora sabr.').catch(() => {});
  }, 4000);

  try {
    const result = await asyncFn();
    // Send the result only when it is real message text — handler
    // helpers return their delivery mode ('plain', 'interactive',
    // …) which must never reach the customer.
    if (typeof result === 'string' && result.trim() && uiSocket && !UI_RESULT_TOKENS.has(result)) {
      await sendText(uiSocket, jid, result);
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/** Delivery-mode strings returned by lib/ui send helpers (never messages). */
const UI_RESULT_TOKENS = new Set(['plain', 'interactive', 'text', 'qr+text', 'text+image']);
