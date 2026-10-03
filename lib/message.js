// ─────────────────────────────────────────────────────────────
// message.js
// Turns a raw Baileys WAMessage into { text, command, channel,
// media } and provides fuzzy choice matching so the bot works
// whether the user TAPPED a button, picked a list row, or typed
// a number / plain word (the plain-text fallback path).
// ─────────────────────────────────────────────────────────────

/** Peel ephemeral / view-once wrappers to reach the real content. */
function unwrap(message) {
  let cur = message;
  for (let i = 0; i < 5 && cur; i++) {
    const inner =
      cur.ephemeralMessage?.message ||
      cur.viewOnceMessage?.message ||
      cur.viewOnceMessageV2?.message ||
      cur.viewOnceMessageV2Extension?.message ||
      cur.documentWithCaptionMessage?.message;
    if (!inner) break;
    cur = inner;
  }
  return cur || {};
}

/** Safely JSON.parse — returns null instead of throwing. */
function tryJson(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const MEDIA_TYPES = [
  ['imageMessage', 'image'],
  ['videoMessage', 'video'],
  ['audioMessage', 'audio'],
  ['stickerMessage', 'sticker'],
  ['documentMessage', 'document'],
  // Anything else non-text (never ignored silently — the router
  // answers with the "I can't process that" menu fallback).
  ['locationMessage', 'location'],
  ['liveLocationMessage', 'location'],
  ['contactMessage', 'contact'],
  ['contactsArrayMessage', 'contacts'],
  ['pollCreationMessage', 'poll'],
  ['productMessage', 'product'],
];

/**
 * Normalise an incoming message.
 *
 * channel:
 *   'interactive' — user tapped a button / list row (structured reply)
 *   'text'        — free-typed text (or a button id delivered as text)
 */
export function parseIncoming(msg) {
  const body = unwrap(msg?.message);
  const out = {
    body,
    text: '',
    command: null,
    channel: 'text',
    media: null,
    isStatus: false,
  };

  // ── structured interactive replies ────────────────────────
  const buttons = body.buttonsResponseMessage;
  const list = body.listResponseMessage;
  const template = body.templateButtonReplyMessage;
  const interactive = body.interactiveResponseMessage;

  if (buttons) {
    out.channel = 'interactive';
    out.command = buttons.selectedButtonId || null;
    out.text = buttons.selectedDisplayText || out.command || '';
  } else if (list) {
    out.channel = 'interactive';
    out.command = list.singleSelectReply?.selectedRowId || null;
    out.text = list.title || out.command || '';
  } else if (template) {
    out.channel = 'interactive';
    out.command = template.selectedId || null;
    out.text = template.selectedDisplayText || out.command || '';
  } else if (interactive) {
    out.channel = 'interactive';
    const params = tryJson(interactive.nativeFlowResponseMessage?.paramsJson);
    out.command =
      params?.id ??
      params?.selectedId ??
      params?.event ??
      interactive.body?.text ??
      null;
    out.text = params?.selectedDisplayText || params?.title || interactive.body?.text || out.command || '';
  }

  // ── plain text / captions ─────────────────────────────────
  if (!out.text) {
    out.text =
      body.conversation ||
      body.extendedTextMessage?.text ||
      body.imageMessage?.caption ||
      body.videoMessage?.caption ||
      body.documentMessage?.caption ||
      '';
  }
  out.text = String(out.text || '').trim();

  // If nothing structured matched, treat plain text as the command too.
  if (!out.command && out.text) out.command = out.text;

  // ── media ─────────────────────────────────────────────────
  for (const [key, type] of MEDIA_TYPES) {
    if (body[key]) {
      out.media = { type, mimetype: body[key].mimetype || '', msg: body[key], key };
      break;
    }
  }

  out.isStatus = msg?.key?.remoteJid === 'status@broadcast';
  return out;
}

/** Remove emoji / variation selectors so labels can be compared as text. */
function stripEmoji(value) {
  return String(value ?? '')
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Match free-form user input against the choices the bot is
 * currently offering.
 *
 * choices: [{ id, label, keywords? }]
 * Returns { choice, via } where via is one of
 *   'id' | 'number' | 'label' | 'keyword' | null
 *
 * 'number' is what powers the numbered plain-text fallback menu.
 */
export function matchChoice(input, choices) {
  if (!input || !Array.isArray(choices) || choices.length === 0) return null;
  const raw = String(input).trim();
  const lower = raw.toLowerCase();

  // 1. exact command id (button / list row id)
  let hit = choices.find((c) => String(c.id).toLowerCase() === lower);
  if (hit) return { choice: hit, via: 'id' };

  // 2. numbered fallback: "1", "2", ...
  if (/^\d{1,2}$/.test(raw)) {
    const index = Number(raw) - 1;
    if (index >= 0 && index < choices.length) {
      return { choice: choices[index], via: 'number' };
    }
  }

  // 3. exact display label (emoji-insensitive)
  hit = choices.find((c) => stripEmoji(c.label) && stripEmoji(c.label) === stripEmoji(raw));
  if (hit) return { choice: hit, via: 'label' };

  // 4. keyword / loose match
  for (const c of choices) {
    for (const kw of c.keywords || []) {
      const k = String(kw).toLowerCase();
      if (k && (lower === k || lower.includes(k))) return { choice: c, via: 'keyword' };
    }
  }

  return null;
}

/** True when the input arrived as a real tap (not typed text). */
export function wasTapped(channel) {
  return channel === 'interactive';
}
