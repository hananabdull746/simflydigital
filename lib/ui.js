// ─────────────────────────────────────────────────────────────
// lib/ui.js
// The single place that renders interactive content for
// @itsliaaa/baileys.
//
// BUTTONS use the modern interactive format — an array of
// { name, buttonParamsJson } items (quick_reply / cta_url) that
// the package turns into a proto interactiveMessage:
//
//   interactiveButtons  -> authoring array (spec shape)
//   nativeFlow          -> the key @itsliaaa/baileys actually
//                          reads to build interactiveMessage
//
// LISTS use the package's native list/section shape
// (text + title + buttonText + sections[{rows[{rowId}]}]).
//
// Every send is wrapped so a client/protocol failure degrades to
// a numbered plain-text menu instead of dying silently.
// ─────────────────────────────────────────────────────────────
import { BRAND, SETTINGS } from '../config.js';
import { getUser } from './store.js';

// ── THE single footer helper ─────────────────────────────────
// Every list / button / plain-text fallback renders its watermark
// through BRAND.footer, which is itself derived from the two .env
// vars:  "{BRAND_NAME} ⚡ {BRAND_TAGLINE}".
// Read at SEND time so a live rebrand (lib/admins.js applyBranding)
// shows up immediately — and so no other file ever hardcodes a
// footer string.
const footer = () => `\n\n\u2014 ${BRAND.footer}`;

/** Should this JID receive numbered plain text instead of interactive UI? */
export function shouldUsePlain(jid) {
  if (SETTINGS.forcePlain) return true;
  return getUser(jid).seesButtons === false;
}

/** Numbered plain-text list — the fallback for old clients. */
function plainList({ title, text, sections }) {
  const lines = [];
  if (title) lines.push(`*${title}*`);
  if (text) lines.push(text);
  lines.push('');

  let n = 0;
  for (const section of sections || []) {
    if (section.title) lines.push(`\u25B8 ${section.title}`);
    for (const row of section.rows || []) {
      n += 1;
      lines.push(`${n}\uFE0F\u20E3 ${row.title}`);
      if (row.description) lines.push(`\u00A0\u00A0\u00A0\u00A0\u2514 ${row.description}`);
    }
    lines.push('');
  }
  lines.push(`Reply with the number (1\u2013${n}).`);
  return lines.join('\n').trimEnd() + footer();
}

/** Numbered plain-text buttons — the fallback for old clients. */
function plainButtons({ title, text, buttons }) {
  const lines = [];
  if (title) lines.push(`*${title}*`);
  if (text) lines.push(text);
  lines.push('');
  (buttons || []).forEach((b, i) => lines.push(`${i + 1}\uFE0F\u20E3 ${b.text}`));
  lines.push('');
  lines.push(`Reply with the number (1\u2013${buttons?.length || 1}).`);
  return lines.join('\n').trimEnd() + footer();
}

/** Body = screen title + body (interactiveMessage has no header on text bodies). */
const withHeading = (title, text) =>
  title ? `*${title}*\n${text ? `\n${text}` : ''}` : (text || '');

/**
 * Build the modern interactive button array.
 * Each button is { id | url | call, text }:
 *   { id }   -> quick_reply  (tap returns the id to the router)
 *   { url }  -> cta_url      (opens the link)
 */
export function buildInteractiveButtons(buttons = []) {
  return buttons.map((b) => {
    if (b.url) {
      return {
        name: 'cta_url',
        buttonParamsJson: JSON.stringify({
          display_text: b.text || '🌐 Open',
          url: b.url,
          merchant_url: b.url,
        }),
      };
    }
    if (b.call) {
      return {
        name: 'cta_call',
        buttonParamsJson: JSON.stringify({
          display_text: b.text || '📞 Call',
          phone_number: b.call,
        }),
      };
    }
    return {
      name: 'quick_reply',
      buttonParamsJson: JSON.stringify({
        display_text: b.text || 'OK',
        id: b.id || b.text,
      }),
    };
  });
}

// listMessage rows use `rowId`; our internal rows use `id`.
const toListSections = (sections = []) =>
  sections.map((s) => ({
    ...(s.title ? { title: s.title } : {}),
    rows: (s.rows || []).map((r) => ({
      rowId: r.id,
      title: r.title,
      ...(r.description ? { description: r.description } : {}),
    })),
  }));

/**
 * Send a LIST (single-select) message with an automatic
 * numbered plain-text fallback.
 */
export async function sendList(sock, jid, { title, text, buttonText, sections }) {
  if (shouldUsePlain(jid)) {
    return sock.sendMessage(jid, { text: plainList({ title, text, sections }) }).then(() => 'plain');
  }

  try {
    await sock.sendMessage(
      jid,
      {
        text,
        title,
        buttonText: buttonText || title || 'Select an option',
        footer: BRAND.footer,
        sections: toListSections(sections),
      },
      { quoted: null }
    );
    return 'interactive';
  } catch (err) {
    console.warn(`[ui] list send failed for ${jid} (${err.message}) \u2192 plain-text fallback`);
    await sock.sendMessage(jid, { text: plainList({ title, text, sections }) });
    return 'plain';
  }
}

/**
 * Send a BUTTON (quick-reply) message in the modern interactive
 * format with an automatic numbered plain-text fallback.
 *
 * @param buttons [{ id, text }]         quick replies
 *                 [{ url, text }]       open-URL button
 *                 [{ call, text }]      tap-to-call button
 */
export async function sendButtons(sock, jid, { title, text, buttons }) {
  if (shouldUsePlain(jid)) {
    return sock.sendMessage(jid, { text: plainButtons({ title, text, buttons }) }).then(() => 'plain');
  }

  // The authoring array (spec shape) …
  const interactiveButtons = buildInteractiveButtons(buttons);
  const interactiveMessage = {
    text: withHeading(title, text),
    title: BRAND.name,
    footer: BRAND.footer,
    interactiveButtons,
    // … and the key @itsliaaa/baileys reads to emit
    // proto interactiveMessage.nativeFlowMessage.
    nativeFlow: interactiveButtons,
  };

  try {
    await sock.sendMessage(jid, interactiveMessage, { quoted: null });
    return 'interactive';
  } catch (err) {
    console.warn(`[ui] button send failed for ${jid} (${err.message}) \u2192 plain-text fallback`);
    await sock.sendMessage(jid, { text: plainButtons({ title, text, buttons }) });
    return 'plain';
  }
}

/** Plain text helper — plain messages don't need a footer suffix. */
export async function sendText(sock, jid, text, quoted) {
  await sock.sendMessage(jid, { text }, quoted ? { quoted } : undefined);
}
