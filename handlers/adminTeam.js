// ─────────────────────────────────────────────────────────────
// handlers/adminTeam.js
// 👥 Admins + 📣 Channel & Group screens of the admin panel
// (owner only — both rows are hidden from staff).
//
//   • add / remove admins at runtime (persisted in db/admin.json,
//     .env-configured admins stay locked)
//   • channel link — panel override of WHATSAPP_CHANNEL_LINK
//     (welcome / thank-you / review posts pick it up live)
//   • updates group — paste the invite link or …@g.us jid, then
//     "Send Update" posts the text to the group AND the channel
//     (bot number must be admin in both).
// ─────────────────────────────────────────────────────────────
import { jidUser } from '../config.js';
import { sendText } from '../lib/ui.js';
import { getUser, setUser } from '../lib/store.js';
import {
  addAdmin, adminName, appendAudit, getChannelLink, getGroupJid,
  listAdmins, removeAdmin, roleFor, setSettings,
} from '../lib/admins.js';
import { clearChannelCache, postToChannel } from '../lib/channel.js';
import { adminScreen } from './adminPanel.js';
import { logError } from '../lib/logger.js';

const ownerOnly = (jid) => roleFor(jid) === 'owner';

const lockedNote = (sock, jid) => adminScreen(sock, jid, {
  title: '🔒 Owner only',
  text: 'Yeh sirf *owner* ke liye hai (staff nahi).',
  buttons: [{ id: 'adm:menu', text: '⬅️ Admin Menu' }],
});

// ── 👥 Admins ─────────────────────────────────────────────────

/** Admin list: every admin, add row, remove-by-tap. */
export async function openTeam(sock, jid, note) {
  if (!ownerOnly(jid)) return lockedNote(sock, jid);

  const admins = listAdmins();
  const rows = admins.map((a) => ({
    id: `adm:team:rm:${a.number}`,
    title: `${a.role === 'owner' ? '🧭' : '🧑‍💻'} +${a.number} — ${a.role}`,
    description: a.source === 'env' ? '.env se (locked)' : `Added${a.by ? ` by ${a.by}` : ''}`,
    keywords: ['remove', 'delete', 'admin', a.number],
  }));
  rows.push({
    id: 'adm:team:add',
    title: '➕ Add Admin',
    description: 'Number bhejein (default role: staff)',
    keywords: ['add', 'new', 'staff', 'owner'],
  });

  return adminScreen(sock, jid, {
    title: '👥 Admins',
    text: [
      `*${admins.length}* admin — owner = sab kuch, staff = orders/customers/support.`,
      '',
      ...admins.map((a) => `${a.role === 'owner' ? '🧭' : '🧑‍💻'} +${a.number} — ${a.source === 'env' ? '.env' : 'added'}`),
      '',
      'Row tap = remove (added admins) • ➕ se naya admin.',
    ].join('\n'),
    list: { buttonText: 'Admin', sections: [{ title: 'Admins', rows }] },
    note,
  });
}

function promptAddAdmin(sock, jid, note) {
  setUser(jid, { adminInput: 'add_admin', adminPayload: null, flow: 'admin' });
  return adminScreen(sock, jid, {
    title: '➕ Add Admin',
    text: [
      'Number bhejein — e.g. `03001234567` (default role *staff*).',
      'Owner banane ke liye `owner 03001234567` likhein.',
      '`cancel` = chhod dein.',
    ].join('\n'),
    buttons: [{ id: 'adm:team', text: '⬅️ Admins' }],
    note,
  });
}

async function confirmRemove(sock, jid, number) {
  const current = listAdmins().find((a) => a.number === number);
  if (!current) return openTeam(sock, jid, `❌ +${number} admin list me nahi hai.`);
  return adminScreen(sock, jid, {
    title: `🗑️ Remove +${number}?`,
    text: `*+${number}* ke admin rights hata dein?\n\nRole: ${current.role} • source: ${current.source}`,
    buttons: [
      { id: `adm:team:rmyes:${number}`, text: '✅ Yes, remove' },
      { id: 'adm:team', text: '⬅️ Back' },
    ],
    choices: [
      { id: `adm:team:rmyes:${number}`, label: '✅ Yes, remove', keywords: ['yes', 'remove', 'confirm'] },
      { id: 'adm:team', label: '⬅️ Back', keywords: ['back', 'no'] },
    ],
  });
}

/** adm:team[:add|rm:<num>|rmyes:<num>] */
export async function handleTeamId(sock, jid, user, id) {
  const parts = id.split(':');
  const sub = parts[2] || '';
  const value = parts.slice(3).join(':');

  if (sub === 'add') return promptAddAdmin(sock, jid);
  if (sub === 'rm') return confirmRemove(sock, jid, value);
  if (sub === 'rmyes') {
    const res = removeAdmin(value);
    appendAudit({
      actor: jidUser(jid), role: roleFor(jid),
      action: res.ok ? 'admin.remove' : 'admin.remove.failed',
      target: value, detail: res.message.slice(0, 80),
    });
    return openTeam(sock, jid, res.message);
  }
  return openTeam(sock, jid);
}

// ── 📣 Channel & Group ────────────────────────────────────────

export async function openComms(sock, jid, note) {
  if (!ownerOnly(jid)) return lockedNote(sock, jid);

  const link = getChannelLink();
  const group = getGroupJid();
  return adminScreen(sock, jid, {
    title: '📣 Channel & Group',
    text: [
      '*Channel link* (welcome, thank-you, review posts):',
      `🔗 ${link || '— set nahi —'}`,
      '',
      '*Updates group* (bot ko group ka admin banayein):',
      `👥 ${group || '— set nahi —'}`,
      '',
      '✏️ Link badlein • Group set karein • Update type karke DONO ko bhejein.',
    ].join('\n'),
    buttons: [
      { id: 'adm:comms:chset', text: '🔗 Set Channel Link' },
      { id: 'adm:comms:grset', text: '👥 Set Group' },
      { id: 'adm:comms:upd', text: '📣 Send Update' },
    ],
    choices: [
      { id: 'adm:comms:chset', label: '🔗 Set Channel Link', keywords: ['channel', 'link'] },
      { id: 'adm:comms:grset', label: '👥 Set Group', keywords: ['group'] },
      { id: 'adm:comms:upd', label: '📣 Send Update', keywords: ['update', 'send', 'post'] },
    ],
    note,
  });
}

/** adm:comms[:chset|grset|upd] */
export async function handleCommsId(sock, jid, user, id) {
  const parts = id.split(':');
  const sub = parts[2] || '';

  if (sub === 'chset') {
    setUser(jid, { adminInput: 'channel_link', adminPayload: null, flow: 'admin' });
    return adminScreen(sock, jid, {
      title: '🔗 Channel link',
      text: [
        `Abhi: ${getChannelLink() || '— set nahi —'}`,
        '',
        'Naya link paste karein — e.g. `https://whatsapp.com/channel/120363…`',
        '`cancel` = chhod dein.',
      ].join('\n'),
      buttons: [{ id: 'adm:comms', text: '⬅️ Back' }],
    });
  }

  if (sub === 'grset') {
    setUser(jid, { adminInput: 'group_jid', adminPayload: null, flow: 'admin' });
    return adminScreen(sock, jid, {
      title: '👥 Updates group',
      text: [
        `Abhi: ${getGroupJid() || '— set nahi —'}`,
        '',
        'Group ki *invite link* (`https://chat.whatsapp.com/…`) ya seedha jid (`120363…@g.us`) paste karein.',
        'Dono par bot admin hona chahiye.',
        '`cancel` = chhod dein.',
      ].join('\n'),
      buttons: [{ id: 'adm:comms', text: '⬅️ Back' }],
    });
  }

  if (sub === 'upd') {
    if (!getGroupJid() && !getChannelLink()) {
      return openComms(sock, jid, '⚠️ Pehle channel link ya group set karein — update kahan bhejna hai?');
    }
    setUser(jid, { adminInput: 'group_update', adminPayload: null, flow: 'admin' });
    return adminScreen(sock, jid, {
      title: '📣 Send Update',
      text: [
        'Update ka text type bhejein — group AND channel dono me jayega.',
        '',
        '`cancel` = chhod dein.',
      ].join('\n'),
      buttons: [{ id: 'adm:comms', text: '⬅️ Back' }],
    });
  }

  return openComms(sock, jid);
}

// ── Typed input modes (adminPanel delegates here) ─────────────

const CANCEL = /^(cancel|stop|back)$/i;

export async function handleTeamInput(sock, jid, user, text) {
  const mode = user.adminInput;
  const raw = String(text || '').trim();
  if (!raw) return true;

  if (CANCEL.test(raw)) {
    setUser(jid, { adminInput: null, adminPayload: null });
    if (mode === 'add_admin') return openTeam(sock, jid, '❌ Cancelled.');
    return openComms(sock, jid, '❌ Cancelled.');
  }

  // ── add admin ─────────────────────────────────────────────
  if (mode === 'add_admin') {
    const wantsOwner = /^owner\b/i.test(raw);
    const number = raw.replace(/^(owner|staff)\b/i, '').trim();
    const res = addAdmin(number, wantsOwner ? 'owner' : 'staff', adminName(jid, getUser(jid).pushName));
    appendAudit({
      actor: jidUser(jid), role: roleFor(jid),
      action: res.ok ? 'admin.add' : 'admin.add.failed',
      target: res.number || number, detail: res.message.slice(0, 80),
    });
    setUser(jid, { adminInput: null, adminPayload: null });
    if (!res.ok) return promptAddAdmin(sock, jid, res.message);
    return openTeam(sock, jid, `${res.message} Ab woh banda bot ko *admin* likhkar panel khol sakta hai.`);
  }

  // ── channel link ──────────────────────────────────────────
  if (mode === 'channel_link') {
    if (!/^https?:\/\/(?:www\.)?whatsapp\.com\/channel\//i.test(raw)) {
      return sendText(sock, jid, '❌ Link `https://whatsapp.com/channel/…` wala hona chahiye — dobara bhejein (ya `cancel`).');
    }
    setSettings({ channelLink: raw });
    clearChannelCache(); // resolved channel JID may belong to the old link
    appendAudit({ actor: jidUser(jid), role: roleFor(jid), action: 'settings.channel_link', detail: raw.slice(0, 80) });
    setUser(jid, { adminInput: null, adminPayload: null });
    return openComms(sock, jid, '✅ Channel link update ho gayi — welcome/thank-you ab isi use karenge.');
  }

  // ── updates group (invite link OR …@g.us jid) ─────────────
  if (mode === 'group_jid') {
    let groupJid = null;

    if (/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i.test(raw)) {
      const code = raw.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i)[1];
      try {
        if (typeof sock?.groupGetInviteInfo !== 'function') throw new Error('groupGetInviteInfo not available');
        const meta = await sock.groupGetInviteInfo(code);
        groupJid = meta?.id || null;
      } catch (err) {
        logError('comms.group_invite', err, { code });
        return sendText(sock, jid, '❌ Invite link resolve nahi hui — seedha jid (`120363…@g.us`) bhejein (ya `cancel`).');
      }
    } else if (/[A-Za-z0-9_-]+@g\.us$/.test(raw)) {
      groupJid = raw;
    }

    if (!groupJid) {
      return sendText(sock, jid, '❌ Samajh nahi aaya — `https://chat.whatsapp.com/…` link ya `120363…@g.us` jid bhejein (ya `cancel`).');
    }
    setSettings({ groupJid });
    appendAudit({ actor: jidUser(jid), role: roleFor(jid), action: 'settings.group', detail: groupJid });
    setUser(jid, { adminInput: null, adminPayload: null });
    return openComms(sock, jid, `✅ Group set: ${groupJid} — ab "Send Update" se dono ko bhej sakte hain.`);
  }

  // ── compose + send the update (group AND channel) ─────────
  if (mode === 'group_update') {
    setUser(jid, { adminInput: null, adminPayload: null, flow: 'admin' });
    const results = [];

    const group = getGroupJid();
    if (group) {
      try {
        await sock.sendMessage(group, { text: raw });
        results.push('✅ Group me bhej diya.');
      } catch (err) {
        logError('comms.group_send', err, { group });
        results.push(`❌ Group fail: ${err.message}`);
      }
    } else {
      results.push('⚠️ Group set nahi hai — skip.');
    }

    const ch = await postToChannel(sock, raw);
    results.push(ch.ok ? '✅ Channel me post ho gaya.' : `❌ Channel: ${ch.error}`);

    appendAudit({
      actor: jidUser(jid), role: roleFor(jid), action: 'broadcast.update',
      detail: raw.slice(0, 80),
    });
    return sendText(sock, jid, `📣 *Update bheja:*\n${results.join('\n')}`);
  }

  setUser(jid, { adminInput: null, adminPayload: null });
  return false;
}
