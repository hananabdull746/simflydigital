// ─────────────────────────────────────────────────────────────
// lib/channel.js
// Posts review broadcasts to the Simfly WhatsApp Channel
// (newsletter) using Baileys' built-in newsletter support.
//
// Resolution order for the channel JID:
//   1. WHATSAPP_CHANNEL_JID as a full jid (120363…@newsletter)
//   2. newsletterMetadata('invite', <code>) where <code> is the
//      last path segment of WHATSAPP_CHANNEL_LINK
//      (https://whatsapp.com/channel/<code>) — or a BARE invite
//      code pasted into WHATSAPP_CHANNEL_JID (no '@').
//
// NEVER throws: a failed broadcast is reported to the caller,
// which records it on the review and moves on.
// ─────────────────────────────────────────────────────────────
import { log, logError } from './logger.js';
import { getChannelLink } from './admins.js';

let cachedJid = null;

/** Raw WHATSAPP_CHANNEL_JID — a full jid OR a bare invite code. */
function rawChannelJid() {
  return String(process.env.WHATSAPP_CHANNEL_JID || '').trim();
}

/** Invite code from the ACTIVE channel link ("" when none configured). */
export function channelInviteCode() {
  const link = getChannelLink();
  const match = String(link).match(/channel\/([^/?#]+)/i);
  if (match) return match[1];
  const bare = rawChannelJid();
  if (bare && !bare.includes('@')) return bare;
  return '';
}

/** Resolve + cache the channel/newsletter JID (best-effort). */
export async function resolveChannelJid(sock) {
  const explicit = rawChannelJid();
  if (explicit.includes('@')) return explicit;
  if (cachedJid) return cachedJid;

  const code = channelInviteCode();
  if (!code || typeof sock?.newsletterMetadata !== 'function') return null;

  try {
    const meta = await sock.newsletterMetadata('invite', code);
    const jid = meta?.id || null;
    if (jid) {
      cachedJid = jid;
      log.info({ event: 'channel.resolved', jid }, 'channel jid resolved from invite link');
      return jid;
    }
  } catch (err) {
    logError('channel.resolve', err, { code });
  }
  return null;
}

/**
 * Post one message to the channel.
 * @returns {Promise<{ok: boolean, jid: string|null, error?: string}>}
 */
export async function postToChannel(sock, text) {
  if (!getChannelLink() && !rawChannelJid()) {
    return { ok: false, jid: null, error: 'WHATSAPP_CHANNEL_LINK not set' };
  }

  const jid = await resolveChannelJid(sock);
  if (!jid) return { ok: false, jid: null, error: 'could not resolve channel jid' };

  try {
    const sent = await sock.sendMessage(jid, { text });
    log.info({ event: 'channel.post', jid }, 'message posted to channel');
    // key = message id, so the admin panel can 🗑️ unpublish later.
    return { ok: true, jid, key: sent?.key?.id || null };
  } catch (err) {
    logError('channel.post', err, { jid });
    return { ok: false, jid, error: err?.message || String(err) };
  }
}

/** Test helper — drop the cached channel JID. */
export function clearChannelCache() {
  cachedJid = null;
}
