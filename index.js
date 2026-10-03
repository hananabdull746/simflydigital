// ─────────────────────────────────────────────────────────────
// index.js — Simfly Store WhatsApp bot entry point
//
//   node index.js      (or: npm start)
//
// Prints a QR code on first run; the session is saved to
// auth_info/ so you never have to scan twice.
// ─────────────────────────────────────────────────────────────
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} from '@itsliaaa/baileys';

import { AUTH_DIR, ADMIN_JID, SETTINGS, BRAND, PAYMENT_METHODS, jidUser, formatPrice } from './config.js';
import { handleMessage } from './handlers/router.js';
import { rearmReminders } from './handlers/orders.js';
import { rearmReviews } from './handlers/reviews.js';
import { startAlertsJob } from './services/alertsJob.js';
import { startAdminJobs, stopAdminJobs } from './services/adminAlerts.js';
import { startPolls, stopPolls } from './services/digitalPolls.js';
import { startPriceSyncJob, stopPriceSyncJob } from './services/priceSync.js';
import { setSocket as setCatalogSocket } from './services/catalogService.js';
import { startDashboard, stopDashboard } from './dashboard/server.js';
import { isConfigured as prodsellerConfigured } from './services/prodseller.js';
import { flush } from './lib/store.js';
import { log, logError } from './lib/logger.js';

const logger = pino({ level: 'warn' });

let socket = null;
let restarting = false;

/** Banner so you can see at a glance what the bot is configured with. */
function printBanner() {
  const rules = '─'.repeat(58);
  console.log(`\n${rules}`);
  console.log(`  ${BRAND.name} ⚡  ${BRAND.tagline}`);
  console.log(rules);
  console.log(`  Mode        : UNOFFICIAL WhatsApp Web (Baileys — no Meta API)`);
  console.log(`  Session     : ${AUTH_DIR}`);
  console.log(`  Admin       : ${ADMIN_JID ? '+' + jidUser(ADMIN_JID) : 'NOT SET (screenshots will NOT be forwarded)'}`);
  console.log(`  Payments    : ${PAYMENT_METHODS.length ? PAYMENT_METHODS.map((m) => m.label).join(', ') : 'NONE CONFIGURED (.env)'}`);
  console.log(`  Digital     : ${prodsellerConfigured() ? `ProdSeller connected (markup ${SETTINGS.digitalMarkupPercent}%, rate ${SETTINGS.usdPkrRate})` : 'ProdSeller API key NOT set (store hidden)'}`);
  console.log(`  Wallet      : ${SETTINGS.walletEnabled ? `enabled (top-up ${formatPrice(SETTINGS.walletTopupMin)}–${formatPrice(SETTINGS.walletTopupMax)})` : 'disabled'}`);
  console.log(`  Plain menus : ${SETTINGS.forcePlain ? 'forced (FORCE_PLAIN_TEXT=true)' : 'auto (falls back when buttons fail)'}`);
  console.log(`  Reminder    : ${SETTINGS.autoReminderMs / 60000} min`);
  console.log(rules);
}

async function resolveVersion() {
  try {
    const { version, isLatest } = await fetchLatestBaileysVersion();
    if (!isLatest) console.log(`[bot] Baileys WA web version is not the latest (${version.join('.')}) — continuing.`);
    return version;
  } catch {
    return undefined; // let Baileys use its bundled version
  }
}

async function startBot() {
  // Drop listeners from a previous socket so a reconnect can't double-fire.
  if (socket) {
    try { socket.ev.removeAllListeners(); } catch { /* old socket already gone */ }
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const version = await resolveVersion();

  socket = makeWASocket({
    auth: state,
    version,
    logger,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    // Baileys asks for history when a message can't be decrypted yet.
    getMessage: async () => ({ conversation: '' }),
  });

  socket.ev.on('creds.update', saveCreds);

  socket.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n[bot] Scan this QR with WhatsApp → Linked Devices:\n');
      qrcode.generate(qr, { small: true });
      console.log(`\n[bot] Session will be saved to ${AUTH_DIR} — no re-scan after this.\n`);
    }

    if (connection === 'open') {
      restarting = false;
      console.log(`[bot] ✅ Connected as ${socket.user?.name || ''} ${socket.user?.id || ''}`);
      log.info({ event: 'connected', user: socket.user?.id || null }, 'connected');
      rearmReminders(socket);
      rearmReviews(socket);
      startAlertsJob(socket); // plan restock / price-drop watcher
      startAdminJobs(socket); // admin alerts + daily/weekly summaries
      startPolls(socket); // Digital Store email-activation poller
      startPriceSyncJob(socket); // daily supplier price/balance sync
      startDashboard(socket); // 🌐 read-only web dashboard (DASHBOARD_PORT)
      setCatalogSocket(socket); // 🏪 WhatsApp Catalog push API
      return;
    }

    if (connection === 'close') {
      setCatalogSocket(null); // catalog API must not use a dead socket
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut || code === DisconnectReason.badSession;

      if (loggedOut) {
        console.error(`[bot] ❌ Logged out (code ${code}). Delete ${AUTH_DIR} and re-scan the QR.`);
        logError('connection.loggedOut', new Error(`disconnect code ${code}`), { dir: AUTH_DIR });
        await flush();
        return;
      }

      if (restarting) return;
      restarting = true;
      console.warn(`[bot] Connection closed (code ${code}) — reconnecting in 2s...`);
      log.warn({ event: 'reconnect', code }, 'connection closed — reconnecting');
      stopPolls(); // jobs are re-armed after the next 'open'
      await flush();
      setTimeout(() => {
        restarting = false;
        startBot().catch((err) => console.error('[bot] Reconnect failed:', err));
      }, 2000);
    }
  });

  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const raw of messages) {
      try {
        await handleMessage(socket, raw);
      } catch (err) {
        console.error(`[bot] Handler error: ${err?.stack || err}`);
        logError('handler', err, { jid: raw?.key?.remoteJid || null });
      }
    }
  });

  return socket;
}

// ── graceful shutdown ───────────────────────────────────────
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log(`\n[bot] ${signal} received — saving state and exiting.`);
    log.info({ event: 'shutdown', signal }, 'shutdown');
    try {
      stopPolls();
      stopDashboard();
      stopAdminJobs();
      stopPriceSyncJob();
      await flush();
    } catch (err) {
      logError('shutdown.flush', err);
    }
    process.exit(0);
  });
}

process.on('unhandledRejection', (err) => {
  console.error('[bot] Unhandled rejection:', err?.stack || err);
  logError('unhandledRejection', err);
});
process.on('uncaughtException', (err) => {
  console.error('[bot] Uncaught exception:', err?.stack || err);
  logError('uncaughtException', err);
});

printBanner();
log.info({ event: 'start', payments: PAYMENT_METHODS.map((m) => m.id) }, 'bot starting');
await startBot();

