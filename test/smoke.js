// End-to-end smoke test: drives the whole customer + admin flow
// through the real handlers using a stub WhatsApp socket.
// Run with:  npm test
// Spec variable names (PAYMENT_*) — legacy JAZZCASH_*/BANK_* still work.
process.env.ADMIN_WHATSAPP_NUMBER = '030011122233';
process.env.BRAND_NAME = 'Simfly Store';
process.env.BRAND_TAGLINE = 'Aapki Digital Zaroorat, Ek Store Mein';
process.env.PAYMENT_SADAPAY_NUMBER = '030011122233';
process.env.PAYMENT_SADAPAY_TITLE = 'Simfly Pakistan';
process.env.PAYMENT_BINANCE_ID = '123456789';
process.env.PAYMENT_BINANCE_NETWORK = 'USDT (TRC20)';
process.env.AUTO_REMINDER_MINUTES = '10';
// eSIMaccess must stay UNCONFIGURED for this test: manual delivery path.
// (Pin with '' — a delete would let dotenv refill them from a real .env.)
process.env.ESIMACCESS_API_KEY = '';
process.env.ESIMACCESS_API_SECRET = '';
// Keep test state out of the real db/ files
process.env.STORE_FILE = 'test/.tmp-store.json';
process.env.REVIEWS_FILE = 'test/.tmp-reviews.json';
process.env.SESSIONS_FILE = 'test/.tmp-sessions.json';
process.env.USERS_FILE = 'test/.tmp-users.json';
process.env.ALERTS_FILE = 'test/.tmp-alerts.json';
// Admin system — tmp stores + deterministic roles / broadcast valves.
process.env.AUDIT_FILE = 'test/.tmp-audit.json';
process.env.ADMIN_STATE_FILE = 'test/.tmp-admin.json';
process.env.PAYMENTS_FILE = 'test/.tmp-payments.json';
process.env.BROADCAST_FILE = 'test/.tmp-broadcast.json';
process.env.STAFF_NUMBERS = '030098765432';
process.env.ADMIN_NUMBERS = '';
process.env.BROADCAST_MSGS_PER_MINUTE = '60000';
process.env.BROADCAST_JITTER_MS = '0-0';
process.env.BROADCAST_DAILY_CAP = '200';
// UX batch — deterministic values for tests.
process.env.LOYALTY_ORDERS = '5';
process.env.LOYALTY_DISCOUNT_PERCENT = '10';
process.env.SESSION_TTL_HOURS = '24';
process.env.HUMAN_MODE_MINUTES = '30';
process.env.STOCK_CACHE_SECONDS = '60';
process.env.NAYAPAY_AUTO_VERIFY = '';
// Post-order engagement (thank-you + review broadcast) under test.
// Explicit values keep results deterministic even when a real .env exists.
process.env.WHATSAPP_CHANNEL_LINK = 'https://whatsapp.com/channel/TEST123';
process.env.WHATSAPP_CHANNEL_JID = '';
process.env.ORDER_LINK = 'https://wa.me/923000000000';
process.env.REVIEW_DELAY_MINUTES = '2';
// Natural pacing must be OFF in tests: zero think-time, no debounce
// (a test taps the same button twice on purpose).
process.env.MIN_REPLY_DELAY_MS = '0';
process.env.MAX_REPLY_DELAY_MS = '0';
process.env.DEBOUNCE_WINDOW_MS = '0';
// …and no proactive-nudge gap: every thank-you / reminder / review
// prompt must land immediately in tests.
process.env.BROADCAST_MIN_GAP_MINUTES = '0';

import fs from 'node:fs';
try {
  for (const f of [
    '.tmp-store.json', '.tmp-reviews.json', '.tmp-sessions.json', '.tmp-users.json',
    '.tmp-alerts.json', '.tmp-audit.json', '.tmp-admin.json', '.tmp-payments.json',
    '.tmp-broadcast.json',
  ]) {
    fs.rmSync(new URL(`./${f}`, import.meta.url), { force: true });
  }
} catch { /* ignore */ }

const { handleMessage } = await import('../handlers/router.js');
const { flush, getUser, setUser, getOrder, putOrder } = await import('../lib/store.js');
const { clearRateLimit } = await import('../lib/ratelimit.js');
const { allSubsFor } = await import('../lib/alerts.js');
const { allReviews } = await import('../lib/reviews.js');
const { isBlocked, getSettings, recentAudit, roleFor, getChannelLink, getGroupJid } = await import('../lib/admins.js');

const CUSTOMER = '923009999999@s.whatsapp.net';
const ADMIN = '9230011122233@s.whatsapp.net';

const sent = [];
const timeline = [];   // interleaved log of read-receipts vs sends
let seq = 0;

const sock = {
  user: { id: '923000000000:1@s.whatsapp.net' },
  readMessages: async (keys) => {
    timeline.push({ evt: 'read', keys });
  },
  sendPresenceUpdate: async (type, jid) => {
    timeline.push({ evt: 'presence', type, jid });
  },
  relayMessage: async (jid, message) => {
    sent.push({ jid, kind: 'interactive', body: JSON.stringify(message) });
    timeline.push({ evt: 'send', jid, kind: 'interactive' });
  },
  sendMessage: async (jid, content) => {
    // @itsliaaa/baileys builds buttonsMessage / listMessage inside
    // sendMessage(), so interactive payloads arrive here too.
    const interactive = !!(content.buttons || content.sections || content.nativeFlow);
    const kind = interactive ? 'interactive' : 'text';
    const body = interactive
      ? JSON.stringify(content)
      : (content.text || content.caption || `[media ${content.image ? 'image' : ''}]`);
    sent.push({ jid, kind, body });
    timeline.push({ evt: 'send', jid, kind });
    return { key: { id: `out${seq++}` } };
  },
  updateMediaMessage: async (m) => m,
  // Newsletter/channel API — resolves WHATSAPP_CHANNEL_LINK for broadcasts.
  newsletterMetadata: async (type, key) => ({
    id: '120363999999999999@newsletter',
    name: 'Simfly Store Channel',
    type,
    key,
  }),
};

const base = () => ({ remoteJid: CUSTOMER, fromMe: false, id: `in${seq++}` });
const txt = (text) => ({ key: base(), message: { conversation: text } });
const tapButton = (id) => ({ key: base(), message: { buttonsResponseMessage: { selectedButtonId: id, selectedDisplayText: id } } });
const tapRow = (id) => ({ key: base(), message: { listResponseMessage: { singleSelectReply: { selectedRowId: id }, title: 'row' } } });
const image = () => ({ key: base(), message: { imageMessage: { mimetype: 'image/jpeg', fileLength: '1024' } } });

let inbound = 0;
const drive = async (msg) => { inbound++; await handleMessage(sock, msg); return sent[sent.length - 1]; };
const last = () => sent[sent.length - 1];
const count = () => sent.length;

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label} ${detail}`);
  }
}

console.log('\n─── 1. Welcome (any message -> interactive LIST) ───');
await drive(txt('hello'));
check('list sent to customer', last().jid === CUSTOMER && last().kind === 'interactive', last().body);
check('footer watermark present', last().body.includes('Simfly Store') && last().body.includes('Aapki Digital Zaroorat'));
check('has 4 menu rows', ['menu:plans', 'menu:orders', 'menu:support', 'menu:how'].every((r) => last().body.includes(r)));
check('spec welcome labels', ['📶 Browse Plans', '📦 Track My Order', '💬 Support', '❓ How eSIM Works'].every((l) => last().body.includes(l)));
check('welcome carries quiet channel line', last().body.includes('Updates: https://whatsapp.com/channel/TEST123'), last().body.slice(0, 200));

const firstRead = timeline.findIndex((e) => e.evt === 'read');
const firstSend = timeline.findIndex((e) => e.evt === 'send');
check('message is marked SEEN before the reply', firstRead !== -1 && firstRead < firstSend, `read@${firstRead} send@${firstSend}`);
check('read receipt targets the inbound message', timeline[firstRead]?.keys?.[0]?.remoteJid === CUSTOMER);
check('every inbound so far was marked seen', timeline.filter((e) => e.evt === 'read').length === 1, `${timeline.filter((e) => e.evt === 'read').length} receipts`);

const firstFour = timeline.slice(0, 4).map((e) => (e.evt === 'presence' ? `presence:${e.type}` : e.evt));
check('order is seen -> typing -> reply -> stop typing',
  JSON.stringify(firstFour) === JSON.stringify(['read', 'presence:composing', 'send', 'presence:paused']),
  JSON.stringify(firstFour));
check('typing indicator targets the same chat', timeline[1]?.jid === CUSTOMER);

console.log('\n─── 2. View Plans -> LIST with all 4 real plans ───');
await drive(tapRow('menu:plans'));
const plansMsg = last();
const planIds = ['plan_500mb','plan_1gb','plan_6gb','plan_10gb'];
check('all 4 plan rows present', planIds.every((p) => plansMsg.body.includes(p)));
check('real prices present', ['PKR 100','PKR 230','PKR 1,500','PKR 2,500'].every((p) => plansMsg.body.includes(p)));
check('custom section titles from plans.json',
  plansMsg.body.includes('500MB & 1GB') && plansMsg.body.includes('6GB & 10GB'), plansMsg.body.slice(0, 300));

console.log('\n─── 3. Select plan -> BUTTONS (Order Now / Back) ───');
await drive(tapRow('plan:plan_1gb'));
check('plan detail is a button message', last().body.includes('order_now') && last().body.includes('back_plans'));
check('plan card shows data/validity/price', last().body.includes('1GB') && last().body.includes('No Expiry') && last().body.includes('PKR 230'));
check('plan detail shows Step 1 of 2', last().body.includes('Step 1 of 2: Choose & Confirm'), last().body.slice(0, 120));

console.log('\n─── 4. Order Now -> compatibility, then quantity, then payment ───');
await drive(tapButton('order_now'));
check('compat question asked', last().body.includes('compat_yes') && last().body.includes('compat_no'));
check('compat screen shows Step 1 of 2 (still Step 1)', last().body.includes('Step 1 of 2: Choose & Confirm'), last().body.slice(0, 120));

await drive(tapButton('compat_yes'));
check('factory-unlock question asked',
  ['unlock_yes', 'unlock_no', 'unlock_unsure'].every((p) => last().body.includes(p)) && last().body.includes('Factory Unlocked'),
  last().body.slice(0, 200));

await drive(tapButton('unlock_yes'));
check('Step 1 ends on the quantity picker', last().body.includes('eqty:1') && last().body.includes('Quantity'), last().body.slice(0, 200));
check('quantity is capped at MAX_QTY_ESIM (3)', last().body.includes('eqty:3') && !last().body.includes('eqty:4'), last().body.slice(0, 200));
await drive(tapRow('eqty:1'));
check('payment buttons offered', ['pay_sadapay', 'pay_binance'].every((p) => last().body.includes(p)));
check('payment screen shows Step 2 of 2 + ETA', last().body.includes('Step 2 of 2: Pay') && last().body.includes('Usually confirmed'), last().body.slice(0, 160));

console.log('\n─── 5. Payment chosen -> account details + unique Order ID ───');
await drive(tapButton('pay_sadapay'));
const payMsg = last();
check('order id generated', /SMF-\d{4}/.test(payMsg.body), payMsg.body.slice(0, 200));
check('sadapay account details from env', payMsg.body.includes('030011122233') && payMsg.body.includes('Simfly Pakistan'));
check('asks for screenshot', payMsg.body.toLowerCase().includes('screenshot'));
check('details show Step 2 of 2', payMsg.body.includes('Step 2 of 2: Pay'), payMsg.body.slice(0, 160));
const orderId = payMsg.body.match(/SMF-\d{4}/)[0];

console.log('\n─── 6. Screenshot -> ONE admin message (image + details + buttons) ───');
const before = count();
await drive(image());
await new Promise((r) => setTimeout(r, 25)); // any straggler settles
const adminMsgs = sent.slice(before).filter((m) => m.jid === ADMIN);
check('admin gets EXACTLY ONE message for the screenshot', adminMsgs.length === 1, `got ${adminMsgs.length}: ${adminMsgs.map((m) => m.kind).join(',')}`);
const alert6 = adminMsgs[0] || {};
check('alert carries order id + plan', String(alert6.body).includes(orderId) && String(alert6.body).includes('Telenor/Zong 1GB'), String(alert6.body).slice(0, 200));
check('alert shows the legacy confirm command', String(alert6.body).includes(`confirm ${orderId}`), String(alert6.body).slice(0, 200));
check('notice + card + Confirm button share the ONE message',
  String(alert6.body).includes(`NEW ORDER — ${orderId}`) && /adm:conf:SMF-\d{4}:v\d+/.test(String(alert6.body)),
  String(alert6.body).slice(0, 240));
check('screenshot embed (or folded download-failure note) rides along',
  String(alert6.body).includes('"image"') || String(alert6.body).includes('download nahi ho saka'),
  String(alert6.body).slice(0, 240));
const custAck6 = [...sent].reverse().find((m) => m.jid === CUSTOMER && String(m.body).includes('Screenshot mil gaya'));
check('customer got acknowledgement', Boolean(custAck6), String(last().body).slice(0, 140));
const receipt6 = [...sent].reverse().find((m) => m.jid === CUSTOMER && m.kind === 'interactive' && String(m.body).includes(orderId));
check('receipt card offers a Cancel button', Boolean(receipt6) && receipt6.body.includes('cancel_order'),
  receipt6 ? String(receipt6.body).slice(0, 200) : 'no receipt card');

console.log('\n─── 6b. Screenshot reaches the team whatever is going on around it ───');
// (a) An ADMIN buying their own product. The admin panel used to run
//     before the screenshot handler and swallowed the image
//     (adminInput / relay), so the team alert — image included —
//     never went out.
{
  const adminSave = { ...getUser(ADMIN) };
  putOrder({
    id: 'SMF-9001', jid: ADMIN, status: 'await_screenshot', price: 230,
    planName: 'Telenor/Zong 1GB', payment: 'SadaPay', paymentLabel: 'SadaPay',
    catalogType: 'eSIM', createdAt: new Date().toISOString(),
  });
  await flush();
  setUser(ADMIN, { flow: 'await_screenshot', orderId: 'SMF-9001', choices: null, adminRelay: 'SMF-0001' });
  clearRateLimit(ADMIN);
  const b6b = count();
  inbound++;
  await handleMessage(sock, {
    key: { remoteJid: ADMIN, fromMe: false, id: `as${seq++}` },
    message: { imageMessage: { mimetype: 'image/jpeg', fileLength: '1024' } },
  });
  await new Promise((r) => setTimeout(r, 25));
  const msgs6b = sent.slice(b6b);
  const dump6b = JSON.stringify(msgs6b.map((m) => [m.jid, String(m.body).slice(0, 70)]));
  check('admin mid-checkout: the screenshot still reaches the team',
    msgs6b.some((m) => m.jid === ADMIN && String(m.body).includes('SMF-9001') && /confirm/i.test(String(m.body))),
    dump6b);
  check('admin mid-checkout: the panel did not swallow it',
    !msgs6b.some((m) => String(m.body).includes("I can't process that")), dump6b);
  setUser(ADMIN, adminSave);
}

// (b) The customer's `flow` drifted off the screenshot step (menu tap,
//     stray back, resume prompt) while the order is still waiting for
//     a screenshot: it used to fall through to "🎙️ Unsupported" and
//     the proof never reached anybody.
{
  const STRAY = '923001111111@s.whatsapp.net';
  putOrder({
    id: 'SMF-9002', jid: STRAY, status: 'await_screenshot', price: 230,
    planName: 'Telenor/Zong 1GB', payment: 'SadaPay', paymentLabel: 'SadaPay',
    catalogType: 'eSIM', createdAt: new Date().toISOString(),
  });
  await flush();
  setUser(STRAY, { flow: null, orderId: 'SMF-9002', choices: null });
  clearRateLimit(STRAY);
  const c6b = count();
  inbound++;
  await handleMessage(sock, {
    key: { remoteJid: STRAY, fromMe: false, id: `s${seq++}` },
    message: { imageMessage: { mimetype: 'image/jpeg', fileLength: '1024' } },
  });
  await new Promise((r) => setTimeout(r, 25));
  const msgs6c = sent.slice(c6b);
  const dump6c = JSON.stringify(msgs6c.map((m) => [m.jid, String(m.body).slice(0, 70)]));
  check('drifted screenshot still reaches the admin',
    msgs6c.some((m) => m.jid === ADMIN && String(m.body).includes('SMF-9002') && /confirm/i.test(String(m.body))),
    dump6c);
  check('drifted screenshot is not dropped as "Unsupported"',
    !msgs6c.some((m) => String(m.body).includes("I can't process that")), dump6c);
  check('drifted screenshot still gets the customer receipt',
    msgs6c.some((m) => m.jid === STRAY && /Screenshot mil gaya/.test(String(m.body))), dump6c);
  putOrder({ ...getOrder('SMF-9001'), status: 'cancelled' });
  putOrder({ ...getOrder('SMF-9002'), status: 'cancelled' });
  await flush();
}

console.log('\n─── 7. Admin confirms -> eSIM delivered to customer ───');
await drive({ key: { remoteJid: ADMIN, fromMe: false, id: `adm${seq++}` }, message: { conversation: `confirm ${orderId}` } });
check('admin got success ack', last().jid === ADMIN && last().body.includes('delivered'), last().body.slice(0, 200));
const custMsgs = sent.filter((m) => m.jid === CUSTOMER);
const delivery = [...custMsgs].reverse().find((m) => m.body.includes('Activation Guide'));
check('customer received eSIM activation payload', Boolean(delivery), custMsgs.at(-1)?.body?.slice(0, 120));
const receipt = custMsgs.find((m) => m.body.includes('✅ Delivered') && m.body.includes(orderId) && m.body.includes('PKT'));
check('delivery receipt sent before the QR', Boolean(receipt) && sent.indexOf(receipt) < sent.indexOf(delivery), receipt?.body?.slice(0, 160) || 'no receipt');
const thankYou = custMsgs.at(-1);
check('post-order thank-you sent with channel link',
  thankYou.body.includes('Shukriya for choosing Simfly Store') && thankYou.body.includes('whatsapp.com/channel/TEST123'),
  thankYou.body.slice(0, 200));
check('thank-you stays short (<= 4 lines)', thankYou.body.split('\n').length <= 4, `${thankYou.body.split('\n').length} lines`);
check('thank-you carries loyalty progress', thankYou.body.includes('4 more orders to unlock 10% off'), thankYou.body.slice(0, 200));
check('thank-you arms review flow', getUser(CUSTOMER).flow === 'review_pending');

console.log('\n─── 8. Plain-text fallback (typed number, no buttons) ───');
const CUST2 = '923007777777@s.whatsapp.net';
const t2 = (text) => ({ key: { remoteJid: CUST2, fromMe: false, id: `x${seq++}` }, message: { conversation: text } });
const drive2 = async (m) => { inbound++; await handleMessage(sock, m); return sent[sent.length - 1]; };

await drive2(t2('salam'));
check('welcome to user 2', last().jid === CUST2 && last().kind === 'interactive');
await drive2(t2('1'));   // "View Plans" via numbered fallback
check('user 2 switched to numbered plain-text list', last().kind === 'text' && last().body.includes('1️⃣') && last().body.includes('2️⃣'), last().body.slice(0, 160));
check('numbered list still has all sections', last().body.includes('500MB & 1GB') && last().body.includes('6GB & 10GB'));
check('plain fallback carries watermark', last().body.includes('Simfly Store'));

console.log('\n─── 9. My Orders + How eSIM + Support (typed commands) ───');
await drive2(t2('orders'));
check('orders screen renders', last().body.includes('My Orders'), last().body.slice(0, 160));
await drive2(t2('how esim'));
const howMsg = last().body;
check('guide states data-only roaming vs local SIM', howMsg.includes('data-only') && howMsg.includes('not local SIM registrations'), howMsg.slice(0, 200));
check('guide states factory-unlocked requirement', howMsg.includes('FACTORY UNLOCKED') && howMsg.includes('carrier-locked iPhones'), howMsg.slice(0, 200));
check('guide avoids bypass/circumvention framing', !/\b(bypass|bypasses|circumvent|circumvents|get around|evade|pta pass)\b/i.test(howMsg), howMsg.slice(0, 200));
await drive2(t2('support'));
check('support card renders', last().body.includes('Support'), last().body.slice(0, 160));

console.log('\n─── 10. Supplier fallback (eSIMaccess unconfigured) ───');
const esim = await import('../services/esimaccess.js');
check('supplier is NOT configured', esim.isConfigured() === false);
const livePlans = await esim.getAvailablePlans();
check('getAvailablePlans falls back to local catalogue (4)', livePlans.length === 4, `got ${livePlans.length}`);
const purchase = await esim.purchaseEsim('plan_1gb', 'SMF-0000');
check('purchaseEsim degrades to NOT_CONFIGURED', purchase.ok === false && purchase.code === 'NOT_CONFIGURED', JSON.stringify(purchase));

console.log('\n─── 11. Admin: status / reject / help ───');
const CUST4 = '923005555555@s.whatsapp.net';
const adminSay = async (text) => {
  inbound++;
  await handleMessage(sock, { key: { remoteJid: ADMIN, fromMe: false, id: `a${seq++}` }, message: { conversation: text } });
  return sent[sent.length - 1];
};
const cust4Say = async (message) => {
  inbound++;
  await handleMessage(sock, { key: { remoteJid: CUST4, fromMe: false, id: `c${seq++}` }, message });
  return sent[sent.length - 1];
};

// Starts straight from the plans list (no "hi") to stay inside the
// 8-per-minute rate limit with all the new unlock-check steps.
await cust4Say({ listResponseMessage: { singleSelectReply: { selectedRowId: 'menu:plans' }, title: 'row' } });
await cust4Say({ listResponseMessage: { singleSelectReply: { selectedRowId: 'plan:plan_500mb' }, title: 'row' } });
await cust4Say({ buttonsResponseMessage: { selectedButtonId: 'order_now', selectedDisplayText: 'Order Now' } });
await cust4Say({ buttonsResponseMessage: { selectedButtonId: 'compat_yes', selectedDisplayText: 'Yes' } });
await cust4Say({ buttonsResponseMessage: { selectedButtonId: 'unlock_unsure', selectedDisplayText: 'Not Sure' } });
check('unlock self-check instructions shown', last().body.includes('Carrier Lock') && last().body.includes('Settings > General > About'), last().body.slice(0, 200));
await cust4Say({ buttonsResponseMessage: { selectedButtonId: 'unlock_yes', selectedDisplayText: 'Yes, Factory Unlocked' } });
check('one-time device check leads to the quantity picker', last().body.includes('eqty:1'), last().body.slice(0, 160));
await cust4Say({ listResponseMessage: { singleSelectReply: { selectedRowId: 'eqty:1' }, title: 'row' } });
check('checkout continues after confirming unlocked', last().body.includes('pay_binance'), last().body.slice(0, 160));
await cust4Say({ buttonsResponseMessage: { selectedButtonId: 'pay_binance', selectedDisplayText: 'Binance ID' } });
const order4 = (last().body.match(/SMF-\d{4}/) || [])[0];
check('second order created via Binance', Boolean(order4), last().body.slice(0, 160));

await cust4Say({ imageMessage: { mimetype: 'image/jpeg', fileLength: '1024' } });
await new Promise((r) => setTimeout(r, 25)); // background forward settles
const cust4Ack = [...sent].reverse().find((m) => m.jid === CUST4 && String(m.body).includes('Screenshot mil gaya'));
check('screenshot acknowledged', Boolean(cust4Ack), String(last().body).slice(0, 160));

let r = await adminSay(`status ${order4}`);
check('status works while pending', r.jid === ADMIN && r.body.includes(order4) && r.body.includes('confirmation'), r.body.slice(0, 200));

r = await adminSay(`reject ${order4} price mismatch`);
check('admin reject ack', r.jid === ADMIN && r.body.includes('rejected'), r.body.slice(0, 200));
const cust4Last = sent.filter((m) => m.jid === CUST4).pop();
check('customer informed with reason', cust4Last.body.includes('reject') && cust4Last.body.includes('price mismatch'), cust4Last.body.slice(0, 200));

r = await adminSay(`status ${order4}`);
check('status after reject shows rejected', r.body.includes('rejected'), r.body.slice(0, 200));

r = await adminSay('admin help');
check('admin help lists status command', r.body.includes('status SMF-0001'));

console.log('\n─── 12. Carrier-Locked device stops the order ───');
const CUST5 = '923004444444@s.whatsapp.net';
const cust5Say = async (message) => {
  inbound++;
  await handleMessage(sock, { key: { remoteJid: CUST5, fromMe: false, id: `d${seq++}` }, message });
  return sent[sent.length - 1];
};

await cust5Say({ conversation: 'hi' });
await cust5Say({ listResponseMessage: { singleSelectReply: { selectedRowId: 'menu:plans' }, title: 'row' } });
await cust5Say({ listResponseMessage: { singleSelectReply: { selectedRowId: 'plan:plan_1gb' }, title: 'row' } });
await cust5Say({ buttonsResponseMessage: { selectedButtonId: 'order_now', selectedDisplayText: 'Order Now' } });
await cust5Say({ buttonsResponseMessage: { selectedButtonId: 'compat_yes', selectedDisplayText: 'Yes' } });
await cust5Say({ buttonsResponseMessage: { selectedButtonId: 'unlock_no', selectedDisplayText: 'No, Carrier-Locked' } });

check('locked device told the eSIM will NOT work', last().body.includes('activate nahi hogi'), last().body.slice(0, 200));
check('order flow stopped (state reset)', getUser(CUST5).flow === 'menu' && !getUser(CUST5).orderId, JSON.stringify(getUser(CUST5)));
check('no payment step ever reached', !sent.filter((m) => m.jid === CUST5).some((m) => m.body.includes('pay_binance')));
check('stopped state offers support instead of checkout', last().body.includes('menu:support') && last().body.includes('back_menu'), last().body.slice(0, 160));

// Per-jid message builders for the UX-batch sections.
const sayTo = async (jid, message, tag) => {
  inbound++;
  await handleMessage(sock, { key: { remoteJid: jid, fromMe: false, id: `${tag}${seq++}` }, message });
  return sent[sent.length - 1];
};
const btn = (id) => ({ buttonsResponseMessage: { selectedButtonId: id, selectedDisplayText: id } });
const row = (id) => ({ listResponseMessage: { singleSelectReply: { selectedRowId: id }, title: 'row' } });
const say = (text) => ({ conversation: text });

console.log('\n─── 13. Interrupted order -> resume prompt (feature 3) ───');
const CUST7 = '923002222222@s.whatsapp.net';
await sayTo(CUST7, say('hello'), 'r');
await sayTo(CUST7, row('menu:plans'), 'r');
await sayTo(CUST7, row('plan:plan_1gb'), 'r');
await sayTo(CUST7, btn('order_now'), 'r');
await sayTo(CUST7, btn('back_menu'), 'r');
check('welcome offers to resume the order',
  last().body.includes('Continue your *Telenor/Zong 1GB* order (PKR 230)?') &&
    ['resume_continue', 'resume_start', 'resume_menu'].every((b) => last().body.includes(b)),
  last().body.slice(0, 200));
await sayTo(CUST7, btn('resume_continue'), 'r');
check('resume continues at the device step',
  last().body.includes('compat_yes') && last().body.includes('Step 1 of 2: Choose & Confirm'),
  last().body.slice(0, 200));
await sayTo(CUST7, btn('compat_yes'), 'r');
check('resumed checkout reaches unlock question', last().body.includes('Factory Unlocked'), last().body.slice(0, 160));
clearRateLimit(CUST7);
await sayTo(CUST7, btn('back_menu'), 'r');
check('resume prompt again after leaving mid-flow', last().body.includes('Continue your'), last().body.slice(0, 160));
await sayTo(CUST7, btn('resume_menu'), 'r');
check('start-over clears the pending order',
  last().body.includes('Assalam-o-Alaikum') && !last().body.includes('Continue your'),
  last().body.slice(0, 160));

console.log('\n─── 14. Language switch (feature 9) + media fallback (feature 12) ───');
const CUST8 = '923001234567@s.whatsapp.net';
await sayTo(CUST8, say('hey'), 'g');
check('default screen is Roman Urdu', last().body.includes('Neeche se option choose karein'), last().body.slice(0, 160));
await sayTo(CUST8, row('lang_toggle'), 'g');
check('language screen shows current + options',
  last().body.includes('Language: *Roman Urdu*') && last().body.includes('lang_en') && last().body.includes('lang_ur'),
  last().body.slice(0, 200));
await sayTo(CUST8, btn('lang_en'), 'g');
check('switching to English confirmed', last().body.includes('Language: *English*'), last().body.slice(0, 160));
await sayTo(CUST8, btn('back_menu'), 'g');
check('welcome re-rendered in English', last().body.includes('Pick an option below'), last().body.slice(0, 160));
await sayTo(CUST8, row('lang_toggle'), 'g');
check('language screen follows the new language', last().body.includes('Pick your preference'), last().body.slice(0, 160));
await sayTo(CUST8, btn('lang_ur'), 'g');
check('back to Roman Urdu', last().body.includes('Language: *Roman Urdu*'), last().body.slice(0, 160));
await sayTo(CUST8, { audioMessage: { mimetype: 'audio/ogg' } }, 'g');
check('unsupported media gets a polite menu fallback',
  last().body.includes("I can't process that") && last().body.includes('back_menu'),
  last().body.slice(0, 200));

console.log('\n─── 15. Talk to Human (feature 11) ───');
const CUST9 = '923009000000@s.whatsapp.net';
await sayTo(CUST9, say('hi'), 'h');
// pushName lives on the raw message, not inside .message
inbound++;
await handleMessage(sock, { key: { remoteJid: CUST9, fromMe: false, id: `h${seq++}` }, message: { conversation: 'salam' }, pushName: 'Ali Khan' });
await sayTo(CUST9, say('human'), 'h');
const c9last = [...sent].reverse().find((m) => m.jid === CUST9);
check('customer gets an instant human confirmation', Boolean(c9last) && c9last.body.includes('Connecting you to our team'), c9last?.body?.slice(0, 160) || 'no reply');
const humanAdmin = [...sent].reverse().find((m) => m.jid === ADMIN && m.body.includes('HUMAN REQUEST'));
check('admin gets the full handoff context',
  Boolean(humanAdmin) && humanAdmin.body.includes('+923009000000') && humanAdmin.body.includes('Ali Khan') && humanAdmin.body.includes('bot on 923009000000'),
  humanAdmin?.body?.slice(0, 240) || 'no admin msg');
const c9before = sent.filter((m) => m.jid === CUST9).length;
await sayTo(CUST9, say('aur bhai jawab do'), 'h');
check('free text stays silent while human mode is on', sent.filter((m) => m.jid === CUST9).length === c9before,
  `${c9before} -> ${sent.filter((m) => m.jid === CUST9).length}`);
// …but it is NOT dropped: the human handling the chat must see it.
const humanFwd = [...sent].reverse().find((m) => m.jid === ADMIN && String(m.body).includes('aur bhai jawab do'));
check('customer reply during human mode is mirrored to the admin',
  Boolean(humanFwd) && humanFwd.body.includes('+923009000000'),
  humanFwd ? humanFwd.body.slice(0, 160) : 'not forwarded');
check('handoff teaches the admin the reply command',
  Boolean(humanAdmin) && humanAdmin.body.includes('human 923009000000'),
  humanAdmin?.body?.slice(0, 240) || 'no admin msg');
// Re-tapping must not flood the team with duplicate handoffs.
const hreqBefore = sent.filter((m) => m.jid === ADMIN && m.body.includes('HUMAN REQUEST')).length;
const retap = await sayTo(CUST9, say('human'), 'h');
const hreqAfter = sent.filter((m) => m.jid === ADMIN && m.body.includes('HUMAN REQUEST')).length;
check('re-tapping Talk to Human does not spam the team',
  hreqAfter === hreqBefore && /already/i.test(String(retap.body)),
  `${hreqBefore} -> ${hreqAfter}; customer: ${String(retap.body).slice(0, 120)}`);
// The awaited payment screenshot must still be processed while a
// human is handling the chat (regression: the image used to fall
// through to human mode's silent return and disappear).
setUser(CUST9, { flow: 'await_screenshot', orderId: 'SMF-0002' });
clearRateLimit(CUST9);
const hImg = count();
await sayTo(CUST9, { imageMessage: { mimetype: 'image/jpeg', fileLength: '1024' } }, 'h');
const hMsgs = sent.slice(hImg);
check('screenshot still processes while a human is handling',
  getUser(CUST9).flow === 'pending_admin' &&
    hMsgs.some((m) => m.jid === CUST9 && m.body.includes('SMF-0002') && /received/i.test(m.body)),
  JSON.stringify(hMsgs.map((m) => [m.jid, String(m.body).slice(0, 60)])));
check('screenshot in human mode still alerts the admins',
  hMsgs.some((m) => m.jid === ADMIN && m.body.includes('SMF-0002') && /confirm/i.test(m.body)),
  JSON.stringify(hMsgs.filter((m) => m.jid === ADMIN).map((m) => String(m.body).slice(0, 60))));
// Any OTHER media in human mode pings the admin instead of vanishing.
const hImg2 = count();
await sayTo(CUST9, { imageMessage: { mimetype: 'image/jpeg', fileLength: '1024' } }, 'h');
const hMsgs2 = sent.slice(hImg2);
check('other media in human mode notifies the admin',
  hMsgs2.some((m) => m.jid === ADMIN && /human mode/.test(m.body)),
  JSON.stringify(hMsgs2.map((m) => [m.jid, String(m.body).slice(0, 60)])));
check('customer hears nothing for human-mode media',
  !hMsgs2.some((m) => m.jid === CUST9), JSON.stringify(hMsgs2.map((m) => m.jid)));
r = await adminSay('bot on 923009000000');
check('admin can hand the chat back to the bot', r.jid === ADMIN && r.body.includes('Bot wapas active'), r.body.slice(0, 160));
await sayTo(CUST9, btn('back_menu'), 'h');
check('bot replies again after bot-on', last().jid === CUST9 && last().body.includes('Assalam-o-Alaikum'), last().body.slice(0, 160));
// The admin's own reply loop: `human <number> <message>`.
clearRateLimit(ADMIN);
r = await adminSay('human');
check('human command without a message shows usage',
  r.jid === ADMIN && r.body.includes('Format'), r.body.slice(0, 140));
r = await adminSay('human 923009000000 theek hai, abhi check kar rahe hain');
check('admin human reply accepted',
  r.jid === ADMIN && r.body.includes('Reply') && r.body.includes('+923009000000'), r.body.slice(0, 160));
const custHumanReply = [...sent].reverse().find((m) => m.jid === CUST9 && String(m.body).includes('theek hai, abhi check kar rahe hain'));
check('the reply reaches the customer', Boolean(custHumanReply),
  custHumanReply ? String(custHumanReply.body).slice(0, 120) : 'not delivered');
r = await adminSay('bot on 923009000000');
check('window closed again after the reply', r.body.includes('Bot wapas active'), r.body.slice(0, 140));

console.log('\n─── 16. 🔔 Notify Me + Alerts (feature 8) ───');
const CUST10 = '923001000000@s.whatsapp.net';
await sayTo(CUST10, say('salam'), 'n');
await sayTo(CUST10, btn('notify_me:plan_1gb'), 'n');
check('restock subscription confirmed', last().body.includes('wapas stock me aayega') && last().body.includes('See Plan'), last().body.slice(0, 200));
await sayTo(CUST10, btn('alerts'), 'n');
check('alerts screen lists restock + price state',
  last().body.includes('Plan Alerts') && last().body.includes('1 plan(s)') && last().body.includes('Price drop alerts: OFF'),
  last().body.slice(0, 240));
await sayTo(CUST10, btn('alerts_price_on'), 'n');
check('price alerts toggled on', last().body.includes('Price drop alerts: ON') && last().body.includes('alerts_price_off'), last().body.slice(0, 240));
const subs10 = allSubsFor(CUST10);
check('subscriptions persisted in memory', subs10.some((s) => s.type === 'restock' && s.planId === 'plan_1gb') && subs10.some((s) => s.type === 'price'),
  JSON.stringify(subs10));
const restock10 = subs10.find((s) => s.type === 'restock');
await sayTo(CUST10, btn(`unsub:${restock10.id}`), 'n');
check('per-alert unsubscribe works', last().body.includes('Alert band kar diya gaya'), last().body.slice(0, 160));
const afterUnsub = allSubsFor(CUST10);
check('restock removed, price kept', !afterUnsub.some((s) => s.type === 'restock') && afterUnsub.some((s) => s.type === 'price'),
  JSON.stringify(afterUnsub));

console.log('\n─── 17. 5★ review -> auto-broadcast to the channel ───');
clearRateLimit(CUSTOMER);
await drive(txt('hello'));
check('review request offers star buttons',
  ['review_5', 'review_4', 'review_3', 'review_low'].every((b) => last().body.includes(b)) &&
    last().body.includes('How was your Simfly Store experience'),
  last().body.slice(0, 240));
await drive(tapButton('review_5'));
check('comment step after a great rating', last().body.includes('review_skip') && last().body.includes('quick comment'), last().body.slice(0, 200));
await drive(txt('Bohat fast delivery, shukriya!'));
check('name choice offered', last().body.includes('review_name_yes') && last().body.includes('review_name_no'), last().body.slice(0, 200));
const newsBefore = sent.filter((m) => m.jid.endsWith('@newsletter')).length;
await drive(tapButton('review_name_no'));
const newsPosts = sent.filter((m) => m.jid.endsWith('@newsletter'));
check('review broadcast posted to channel', newsPosts.length === newsBefore + 1, `${newsBefore} -> ${newsPosts.length}`);
const post = newsPosts.at(-1);
check('broadcast has stars + comment, no customer number',
  Boolean(post) && post.body.includes('⭐⭐⭐⭐⭐') && post.body.includes('Bohat fast delivery') &&
    !post.body.includes('923009999999') && !post.body.includes('030099999999'),
  (post?.body || 'NO POST').slice(0, 240));
check('customer told the review is live', last().jid === CUSTOMER && last().body.includes('post ho gaya'), last().body.slice(0, 160));
check('review stored as posted (5★)', allReviews().some((rv) => rv.broadcast === 'posted' && rv.stars === 5 && rv.orderId === 'SMF-0001'));
check('flow returns to menu after the review', getUser(CUSTOMER).flow === 'menu');

console.log('\n─── 18. ≤3★ review -> ADMIN ONLY, never broadcast ───');
const CUST6 = '923003333333@s.whatsapp.net';
setUser(CUST6, {
  flow: 'review_pending',
  choices: [],
  review: { orderId: 'SMF-0001', planId: 'plan_1gb', planName: 'Telenor/Zong 1GB', stars: null, comment: null },
});
const newsCount = () => sent.filter((m) => m.jid.endsWith('@newsletter')).length;
const beforeNews = newsCount();
await sayTo(CUST6, say('hi'), 'l');
check('low path starts at the rating screen', last().body.includes('review_low'), last().body.slice(0, 160));
await sayTo(CUST6, btn('review_low'), 'l');
check('low path asks what went wrong', last().body.includes('What went wrong'), last().body.slice(0, 160));
await sayTo(CUST6, say('Delivery 2 din late thi'), 'l');
check('customer gets a low-review ack', last().jid === CUST6 && last().body.includes('rabta karein ge'), last().body.slice(0, 160));
const lowAdmin = [...sent].reverse().find((m) => m.jid === ADMIN && m.body.includes('LOW REVIEW'));
check('admin alerted with the comment',
  Boolean(lowAdmin) && lowAdmin.body.includes('Delivery 2 din late thi') && lowAdmin.body.includes('POST nahi'),
  lowAdmin?.body?.slice(0, 240) || 'no admin msg');
check('NO channel post for ≤3★', newsCount() === beforeNews, `${beforeNews} -> ${newsCount()}`);
check('review stored as admin_only (2★)',
  allReviews().some((rv) => rv.broadcast === 'admin_only' && rv.stars === 2 && rv.comment === 'Delivery 2 din late thi'));
check('low flow returns to menu', getUser(CUST6).flow === 'menu');

console.log('\n─── 19. Anti-spam (menu + general rate limit) ───');
const CUST3 = '923006666666@s.whatsapp.net';
const t3 = (text) => ({ key: { remoteJid: CUST3, fromMe: false, id: `y${seq++}` }, message: { conversation: text } });
// A real checkout first, so this customer is sitting on "send your
// screenshot" right when the anti-spam window blows.
await sayTo(CUST3, row('menu:plans'), 'k1');
await sayTo(CUST3, row('plan:plan_1gb'), 'k2');
await sayTo(CUST3, btn('order_now'), 'k3');
await sayTo(CUST3, btn('compat_yes'), 'k4');
await sayTo(CUST3, btn('unlock_yes'), 'k5');
await sayTo(CUST3, row('eqty:1'), 'k5b');
await sayTo(CUST3, btn('pay_binance'), 'k6');
const shotOrder = (last().body.match(/SMF-\d{4}/) || [])[0];
check('rate-limit scenario: order waiting for screenshot', Boolean(shotOrder), String(last().body).slice(0, 140));
const before2 = count();
for (let i = 0; i < 20; i++) { inbound++; await handleMessage(sock, t3('hello')); }
const burst = count() - before2;
check('20 rapid menu triggers produced <= 3 replies', burst <= 3, `got ${burst}`);
check('every inbound message was marked seen', timeline.filter((e) => e.evt === 'read').length === inbound,
  `${timeline.filter((e) => e.evt === 'read').length} receipts / ${inbound} inbound`);
const composing = timeline.filter((e) => e.evt === 'presence' && e.type === 'composing').length;
const paused = timeline.filter((e) => e.evt === 'presence' && e.type === 'paused').length;
check('"typing…" is always cleared', composing === paused, `${composing} composing / ${paused} paused`);
// Even with the window exhausted, the screenshot WE asked for lands.
// (The burst's welcome reset the flow — put the customer back at the
// screenshot screen, exactly where a real buyer would be.)
setUser(CUST3, { flow: 'await_screenshot', orderId: shotOrder });
const k7 = count();
await sayTo(CUST3, { imageMessage: { mimetype: 'image/jpeg', fileLength: '1024' } }, 'k7');
const k7msgs = sent.slice(k7);
check('awaited screenshot beats the rate limit',
  getOrder(shotOrder)?.status === 'pending_admin', String(getOrder(shotOrder)?.status));
check('customer still gets the screenshot receipt',
  k7msgs.some((m) => m.jid === CUST3 && m.body.includes(shotOrder) && /received/i.test(m.body)),
  JSON.stringify(k7msgs.map((m) => [m.jid, String(m.body).slice(0, 50)])));
check('admins still get the order card',
  k7msgs.some((m) => m.jid === ADMIN && m.body.includes(shotOrder) && /confirm/i.test(m.body)),
  JSON.stringify(k7msgs.filter((m) => m.jid === ADMIN).map((m) => String(m.body).slice(0, 50))));

// ─────────────────────────────────────────────────────────────
const STAFF = '9230098765432@s.whatsapp.net';
const PANEL_C = '923007777777@s.whatsapp.net';
const REJ_C = '923004444000@s.whatsapp.net';
const pSay = async (m, tag) => { clearRateLimit(ADMIN); return sayTo(ADMIN, m, tag); };
const BODIES = (slice) => slice.map((m) => String(m.body)).join('\n');
const msgsSince = (n) => sent.slice(n);

// ── Customer cancels while the screenshot awaits verification ─
console.log('\n─── 19b. Customer cancels a pending order -> admins alerted ───');
const CANCEL_C = '9230066665555@s.whatsapp.net';
clearRateLimit(CANCEL_C);
await sayTo(CANCEL_C, row('menu:plans'), 'z1');
await sayTo(CANCEL_C, row('plan:plan_1gb'), 'z2');
await sayTo(CANCEL_C, btn('order_now'), 'z3');
await sayTo(CANCEL_C, btn('compat_yes'), 'z4');
await sayTo(CANCEL_C, btn('unlock_yes'), 'z5');
await sayTo(CANCEL_C, row('eqty:1'), 'z5b');
await sayTo(CANCEL_C, btn('pay_binance'), 'z6');
const orderX = (last().body.match(/SMF-\d{4}/) || [])[0];
check('cancel-scenario order created', Boolean(orderX), String(last().body).slice(0, 140));
await sayTo(CANCEL_C, { imageMessage: { mimetype: 'image/jpeg', fileLength: '1024' } }, 'z7');
await new Promise((r) => setTimeout(r, 25)); // background forward settles
check('order waits for admin verification', getOrder(orderX)?.status === 'pending_admin', String(getOrder(orderX)?.status));

// Tap the order in My Orders → detail must offer BOTH actions.
clearRateLimit(CANCEL_C);
const z10 = count();
await sayTo(CANCEL_C, say('orders'), 'z10');
const z10o = BODIES(msgsSince(z10));
check('order detail offers Cancel AND Delete (pending)',
  z10o.includes('cancel_order') && z10o.includes('delete_order') && z10o.includes(orderX),
  z10o.slice(0, 300));

let zb = count();
await sayTo(CANCEL_C, btn('cancel_order'), 'z8');
let zo = BODIES(msgsSince(zb));
check('customer cancel marks the order cancelled', getOrder(orderX)?.status === 'cancelled', String(getOrder(orderX)?.status));
check('customer sees the cancellation ack', zo.includes('Order cancelled'), zo.slice(0, 200));
check('admins are told the order was cancelled',
  msgsSince(zb).some((m) => m.jid === ADMIN && String(m.body).includes(orderX) && /cancel/i.test(String(m.body))),
  zo.slice(0, 240));
zb = count();
await pSay(say(`confirm ${orderX}`), 'z9');
zo = BODIES(msgsSince(zb));
check('stale confirm of a cancelled order is refused',
  /cancel/i.test(zo) && !/delivered by/.test(zo), zo.slice(0, 240));

// Finished order: both buttons still there; cancel = ONE line,
// delete hides it from the list without flooding messages.
clearRateLimit(CANCEL_C);
zb = count();
await sayTo(CANCEL_C, say('orders'), 'z11');
zo = BODIES(msgsSince(zb));
check('finished order still shows Cancel AND Delete',
  zo.includes('cancel_order') && zo.includes('delete_order'), zo.slice(0, 300));

zb = count();
await sayTo(CANCEL_C, btn('cancel_order'), 'z12');
zo = BODIES(msgsSince(zb));
check('cancel on a finished order = exactly one polite line',
  msgsSince(zb).length === 1 && /already|pehle hi/i.test(zo), `${msgsSince(zb).length} msg: ${zo.slice(0, 160)}`);

zb = count();
await sayTo(CANCEL_C, btn('delete_order'), 'z13');
zo = BODIES(msgsSince(zb));
check('delete removes the order from the customer view',
  getOrder(orderX)?.hidden === true && zo.includes('hata diya'), zo.slice(0, 240));
check('delete keeps the record for the admin', Boolean(getOrder(orderX)), '');
check('delete does not flood the customer (<= 2 messages)',
  msgsSince(zb).length <= 2, `${msgsSince(zb).length}`);

clearRateLimit(CANCEL_C);
zb = count();
await sayTo(CANCEL_C, say('orders'), 'z14');
zo = BODIES(msgsSince(zb));
check('My Orders now shows the empty state (order gone)',
  zo.includes('My Orders') && !zo.includes(orderX), zo.slice(0, 240));

console.log('\n─── 20. Admin panel: roles, order cards, actions ───');
// Roles: identity is the sender JID number, nothing else.
clearRateLimit(STAFF);
let rr = await sayTo(STAFF, say('admin'), 'sf');
check('staff opens the panel as Staff (orders/support role)',
  String(rr.body).includes('Admin Panel') && String(rr.body).includes('Staff'), String(rr.body).slice(0, 200));
check('staff does NOT get the owner-only rows (Settings / Admins / Channel)',
  !String(rr.body).includes('Bot Settings') && !String(rr.body).includes('👥 Admins') && !String(rr.body).includes('Channel & Group'),
  String(rr.body).slice(0, 300));
check('staff is still a role', roleFor(STAFF) === 'staff', String(roleFor(STAFF)));

clearRateLimit(PANEL_C);
rr = await sayTo(PANEL_C, say('admin'), 'nx');
check('regular customer never sees the admin menu', !String(rr.body).includes('Admin Panel') && !String(rr.body).includes('Pending Orders'), String(rr.body).slice(0, 160));

// Owner opens the panel.
clearRateLimit(ADMIN);
rr = await pSay( say('admin'), 'pa');
check('owner opens the panel LIST with a pending badge',
  String(rr.body).includes('Admin Panel') && /Pending Orders \(\d+\)/.test(String(rr.body)),
  String(rr.body).slice(0, 220));
check('panel lists every admin row',
  ['Pending Orders', 'Stats', 'Find', 'Plans', 'Payments', 'Reviews', 'Broadcast', 'Blocklist', 'Admins', 'Channel & Group', 'Settings', 'Dashboard']
    .every((k) => String(rr.body).includes(k)),
  String(rr.body).slice(0, 400));

// ── @lid (privacy) senders: admin keyword still opens the list ──
// Fast path: baileys' local lid → number store resolves the lid.
sock.signalRepository = {
  lidMapping: {
    getPNForLID: async (lid) =>
      String(lid).split('@')[0].split(':')[0] === '215499988877777'
        ? '9230011122233:2@s.whatsapp.net'
        : null,
    getLIDForPN: async () => null,
  },
};
const LID_ADMIN = '215499988877777@lid';
clearRateLimit(LID_ADMIN);
rr = await sayTo(LID_ADMIN, say('admin'), 'l1');
check('admin behind an @lid sender opens the same panel LIST',
  String(rr.body).includes('Admin Panel') && String(rr.body).includes('Owner'),
  String(rr.body).slice(0, 240));
check('lid maps to the owner in roleFor', roleFor(LID_ADMIN) === 'owner', String(roleFor(LID_ADMIN)));

// Fallback path: local store misses, USync asks for the admin's LID.
sock.signalRepository.lidMapping = {
  getPNForLID: async () => null,
  getLIDForPN: async (pn) =>
    String(pn).startsWith('9230011122233') ? '2154111222333:1@lid' : null,
};
const LID_ADMIN2 = '2154111222333@lid';
clearRateLimit(LID_ADMIN2);
rr = await sayTo(LID_ADMIN2, say('admin'), 'l2');
check('usync lid fallback also opens the panel for the owner',
  String(rr.body).includes('Admin Panel') && roleFor(LID_ADMIN2) === 'owner',
  String(rr.body).slice(0, 240));
delete sock.signalRepository;

// The keyword always wins — it used to be forwarded by a pending
// relay or swallowed by an input prompt instead of opening the list.
setUser(ADMIN, { adminRelay: 'SMF-0001', adminInput: null, flow: 'admin' });
const relMark = sent.length;
clearRateLimit(ADMIN);
rr = await pSay(say('admin'), 'pk1');
check('`admin` opens the panel even while a relay is pending',
  String(rr.body).includes('Admin Panel') && !String(rr.body).includes('Relay band'),
  String(rr.body).slice(0, 240));
check('relay does not swallow the keyword (only the panel reply goes out)',
  sent.length > relMark && sent.slice(relMark).every((m) => m.jid === ADMIN),
  JSON.stringify(sent.slice(relMark).map((m) => [m.jid, String(m.body).slice(0, 40)])));

setUser(ADMIN, { adminInput: 'find', adminPayload: null, flow: 'admin' });
clearRateLimit(ADMIN);
rr = await pSay(say('admin'), 'pk2');
check('`admin` opens the panel even while an input prompt is pending',
  String(rr.body).includes('Admin Panel') && !getUser(ADMIN).adminInput,
  String(rr.body).slice(0, 240));
check('panel is the fresh LIST after breaking out', /Pending Orders \(\d+\)/.test(String(rr.body)),
  String(rr.body).slice(0, 240));

// ── 👥 Add / remove admin (owner only, typed `admin` panel) ───
let tb = count();
await pSay(btn('adm:team'), 'tm');
let to = BODIES(msgsSince(tb));
check('Admins screen lists every admin + Add row',
  to.includes('+9230011122233') && to.includes('+9230098765432') && to.includes('Add Admin'), to.slice(0, 300));

tb = count();
await pSay(btn('adm:team:add'), 'ta');
to = BODIES(msgsSince(tb));
check('add-admin prompt explains staff vs owner', to.includes('03001234567') && to.includes('owner'), to.slice(0, 240));

const NEW_STAFF = '9230077000111@s.whatsapp.net';
tb = count();
await pSay(say('030077000111'), 'tn');
to = BODIES(msgsSince(tb));
check('new admin added as staff', roleFor(NEW_STAFF) === 'staff' && to.includes('Staff'), to.slice(0, 240));
check('admin.add written to the audit log',
  recentAudit(20).some((e) => e.action === 'admin.add' && e.target === '9230077000111'),
  JSON.stringify(recentAudit(3)[0]));

clearRateLimit(NEW_STAFF);
const newAdminPanel = await sayTo(NEW_STAFF, say('admin'), 'tp');
check('new admin opens the panel right away',
  String(newAdminPanel.body).includes('Admin Panel') && String(newAdminPanel.body).includes('Staff'),
  String(newAdminPanel.body).slice(0, 200));

tb = count();
await pSay(btn('adm:team:rm:9230077000111'), 'tr');
to = BODIES(msgsSince(tb));
check('remove asks for confirmation', to.includes('Remove') && to.includes('9230077000111'), to.slice(0, 240));
const rmYes = (to.match(/adm:team:rmyes:\d+/) || [])[0];
check('confirm row carries the number', Boolean(rmYes), to.slice(0, 240));

tb = count();
await pSay(btn(rmYes), 'tr2');
to = BODIES(msgsSince(tb));
check('added admin removed (role gone)', roleFor(NEW_STAFF) === null && to.includes('hata diye'), to.slice(0, 240));

tb = count();
await pSay(btn('adm:team:rm:9230098765432'), 'tl');
to = BODIES(msgsSince(tb));
check('.env staff is locked in the panel', /env/i.test(to) && roleFor(STAFF) === 'staff', to.slice(0, 240));

// ── 📣 Channel link + group updates sender ───────────────────
tb = count();
await pSay(btn('adm:comms'), 'cm');
to = BODIES(msgsSince(tb));
check('Channel & Group screen shows link + group + send',
  to.includes('Channel link') && to.includes('Set Group') && to.includes('Send Update'), to.slice(0, 300));

tb = count();
await pSay(btn('adm:comms:chset'), 'ch');
to = BODIES(msgsSince(tb));
check('channel-link prompt shown', to.includes('whatsapp.com/channel'), to.slice(0, 240));
tb = count();
await pSay(say('https://whatsapp.com/channel/NEWS456'), 'ch2');
to = BODIES(msgsSince(tb));
check('channel link saved', getChannelLink() === 'https://whatsapp.com/channel/NEWS456' && to.includes('✅'),
  to.slice(0, 240));

tb = count();
await pSay(btn('adm:comms:grset'), 'gr');
to = BODIES(msgsSince(tb));
check('group prompt accepts invite link or jid', to.includes('chat.whatsapp.com') || to.includes('@g.us'), to.slice(0, 240));
tb = count();
await pSay(say('120363000000000000@g.us'), 'gr2');
to = BODIES(msgsSince(tb));
check('updates group saved', getGroupJid() === '120363000000000000@g.us' && to.includes('✅'), to.slice(0, 240));

tb = count();
await pSay(btn('adm:comms:upd'), 'up');
to = BODIES(msgsSince(tb));
check('update composer opened', to.includes('Send Update') && to.includes('group AND channel'), to.slice(0, 240));
tb = count();
await pSay(say('📦 30-Day packs wapas aa gaye!'), 'up2');
to = BODIES(msgsSince(tb));
const groupPost = msgsSince(tb).find((m) => m.jid === '120363000000000000@g.us' && m.body.includes('30-Day packs'));
const chanPost = msgsSince(tb).find((m) => m.jid.endsWith('@newsletter') && m.body.includes('30-Day packs'));
check('update sent to the group', Boolean(groupPost), to.slice(0, 240));
check('update posted to the channel too', Boolean(chanPost), to.slice(0, 240));
check('send report shown to the admin', to.includes('Update bheja') && to.includes('✅'), to.slice(0, 240));

// ── Order card + Confirm button ─────────────────────────────
clearRateLimit(PANEL_C);
await sayTo(PANEL_C, row('menu:plans'), 'k1');
await sayTo(PANEL_C, row('plan:plan_1gb'), 'k2');
await sayTo(PANEL_C, btn('order_now'), 'k3');
await sayTo(PANEL_C, btn('compat_yes'), 'k4');
await sayTo(PANEL_C, btn('unlock_yes'), 'k5');
await sayTo(PANEL_C, row('eqty:1'), 'k5b');
await sayTo(PANEL_C, btn('pay_binance'), 'k6');
const order10 = (last().body.match(/SMF-\d{4}/) || [])[0];
check('order created for the panel test', Boolean(order10), String(last().body).slice(0, 140));
await sayTo(PANEL_C, { imageMessage: { mimetype: 'image/jpeg', fileLength: '1024' } }, 'k7');

const alerts10 = [...sent].reverse().filter((m) => m.jid === ADMIN && String(m.body).includes(order10));
const card10 = alerts10[0];
check('order alert reaches the admin', Boolean(card10), 'alert not found');
check('admin gets EXACTLY ONE message for the order', alerts10.length === 1, `${alerts10.length}`);
check('notice, card and Confirm button share the ONE message',
  Boolean(card10) && String(card10.body).includes(`NEW ORDER — ${order10}`) && /adm:conf:SMF-\d{4}:v\d+/.test(String(card10.body)),
  String(card10?.body).slice(0, 240));
check('alert keeps the legacy typed-command hint',
  Boolean(card10) && card10.body.includes(`confirm ${order10}`) && card10.body.includes(`reject ${order10}`),
  String(card10?.body).slice(0, 240));
const confId10 = (String(card10?.body).match(/adm:conf:SMF-\d{4}:v\d+/) || [])[0];
check('Confirm button carries order id + version', Boolean(confId10), String(card10?.body).slice(-260));
check('alert shows the auto-check line', String(card10?.body).includes('Auto-check'), String(card10?.body).slice(0, 300));
check('alert masks the customer number', !String(card10?.body).includes(PANEL_C.split('@')[0]) && String(card10?.body).includes('*'),
  String(card10?.body).slice(0, 300));

// The same alert with a REAL image: screenshot header + caption +
// buttons must still go out as ONE message.
const imgMark = count();
const { notifyNewOrder } = await import('../handlers/adminPanel.js');
await notifyNewOrder(sock, getOrder(order10), Buffer.from([137, 80, 78, 71]));
const imgMsgs = msgsSince(imgMark).filter((m) => m.jid === ADMIN);
check('image alert is ONE message (image + caption + buttons)',
  imgMsgs.length === 1 &&
    String(imgMsgs[0]?.body).includes('"image"') &&
    String(imgMsgs[0]?.body).includes(order10) &&
    /adm:conf:/.test(String(imgMsgs[0]?.body)),
  JSON.stringify(imgMsgs.map((m) => String(m.body).slice(0, 100))));

let ab = count();
await pSay( btn(confId10), 'cf');
let ao = BODIES(msgsSince(ab));
check('button confirm delivers and names the admin',
  /delivered by/.test(ao) && ao.includes(order10), ao.slice(0, 240));
check('order flipped to fulfilled', getOrder(order10)?.status === 'fulfilled', String(getOrder(order10)?.status));
check('confirmedBy stored on the order', Boolean(getOrder(order10)?.confirmedBy), String(getOrder(order10)?.confirmedBy));
check('audit log recorded the confirm',
  recentAudit(30).some((a) => a.action === 'order.confirm' && a.target === order10),
  JSON.stringify(recentAudit(3)[0]));

// Idempotency: the SAME (stale) tap must never deliver twice.
ab = count();
await pSay( btn(confId10), 'cf2');
ao = BODIES(msgsSince(ab));
check('stale confirm tap cannot double-deliver', /already/i.test(ao), ao.slice(0, 200));
check('still exactly one fulfilment', getOrder(order10)?.status === 'fulfilled', String(getOrder(order10)?.status));

// ── Reject flow: quick reasons + customer notification ─────
clearRateLimit(REJ_C);
await sayTo(REJ_C, row('menu:plans'), 'm1');
await sayTo(REJ_C, row('plan:plan_500mb'), 'm2');
await sayTo(REJ_C, btn('order_now'), 'm3');
await sayTo(REJ_C, btn('compat_yes'), 'm4');
await sayTo(REJ_C, btn('unlock_yes'), 'm5');
await sayTo(REJ_C, row('eqty:1'), 'm5b');
await sayTo(REJ_C, btn('pay_binance'), 'm6');
const order12 = (last().body.match(/SMF-\d{4}/) || [])[0];
await sayTo(REJ_C, { imageMessage: { mimetype: 'image/jpeg', fileLength: '1024' } }, 'm7');

const card12 = [...sent].reverse().find((m) => m.jid === ADMIN && String(m.body).includes(order12) && String(m.body).includes('Reject'));
const rejId12 = (String(card12?.body).match(/adm:rej:SMF-\d{4}:v\d+/) || [])[0];
check('Reject button present on the card', Boolean(rejId12), String(card12?.body).slice(-260));

ab = count();
await pSay( btn(rejId12), 'rj');
ao = BODIES(msgsSince(ab));
check('reject opens the quick-reason LIST', ao.includes('Amount mismatch') && ao.includes('Custom reason'), ao.slice(0, 260));
const rejDo = (ao.match(/adm:rejdo:SMF-\d{4}:\w+/) || [])[0];
check('reason rows carry the order id', Boolean(rejDo), ao.slice(0, 260));

ab = count();
await pSay( btn(rejDo), 'rj2');
ao = BODIES(msgsSince(ab));
check('admin sees reason + who applied it',
  ao.includes('Rejected: Amount mismatch by'), ao.slice(0, 240));
check('order rejected with the reason', getOrder(order12)?.status === 'rejected' && getOrder(order12)?.note === 'Amount mismatch',
  `${getOrder(order12)?.status} / ${getOrder(order12)?.note}`);
const cust12Reject = [...sent].reverse().find((m) => m.jid === REJ_C && String(m.body).includes('Amount mismatch'));
check('customer gets the reason + retry button',
  Boolean(cust12Reject) && cust12Reject.body.includes('retry_payment'), String(cust12Reject?.body).slice(0, 240));

// ── Message Customer relay ──────────────────────────────────
ab = count();
await pSay( btn(`adm:msg:${order12}`), 'rl');
ao = BODIES(msgsSince(ab));
check('relay screen explains "Simfly Team"', ao.includes('Simfly Store Team'), ao.slice(0, 240));

ab = count();
await pSay( say('Aapka refund process ho raha hai'), 'rl2');
check('relay forwards to the customer',
  msgsSince(ab).some((m) => m.jid === REJ_C && String(m.body).includes('Simfly Store Team') && String(m.body).includes('refund process')),
  BODIES(msgsSince(ab)).slice(0, 240));

ab = count();
await pSay( btn('adm:end'), 'rl3');
check('End chat closes the relay', BODIES(msgsSince(ab)).includes('band'), BODIES(msgsSince(ab)).slice(0, 200));

// ── Blocklist ───────────────────────────────────────────────
ab = count();
await pSay( say('block 923004444000'), 'bk');
ao = BODIES(msgsSince(ab));
check('block asks for confirmation', ao.includes('923004444000') && ao.includes('block'), ao.slice(0, 240));
const blockYes = (ao.match(/adm:blockyes:\d+/) || [])[0];
await pSay( btn(blockYes), 'bk2');
check('customer is blocked', isBlocked(REJ_C), String(isBlocked(REJ_C)));

const c12before = sent.filter((m) => m.jid === REJ_C).length;
await sayTo(REJ_C, say('hello?'), 'bk3');
check('blocked customer gets NO reply', sent.filter((m) => m.jid === REJ_C).length === c12before,
  `${c12before} -> ${sent.filter((m) => m.jid === REJ_C).length}`);

await pSay( say('unblock 923004444000'), 'bk4');
check('unblock restores service', !isBlocked(REJ_C), String(isBlocked(REJ_C)));

// ── Stats + Settings + Dashboard ────────────────────────────
ab = count();
await pSay( say('stats'), 'st');
ao = BODIES(msgsSince(ab));
check('stats screen shows revenue + delivery lines',
  ao.includes('Revenue') && ao.includes('Delivered') && ao.includes('Top plan'), ao.slice(0, 300));

ab = count();
await pSay( btn('adm:settings'), 'se');
ao = BODIES(msgsSince(ab));
check('settings LIST opens', ao.includes('Maintenance mode') && ao.includes('Quiet hours'), ao.slice(0, 300));

ab = count();
await pSay( btn('adm:set:maintenance'), 'se2');
ao = BODIES(msgsSince(ab));
check('toggle asks for confirmation first', ao.includes('Yes, apply') && ao.includes('Customers ko ye message'), ao.slice(0, 300));
const applyMaint = (ao.match(/adm:setdo:maintenance/) || [])[0];
await pSay( btn(applyMaint), 'se3');
check('maintenance mode toggled ON', getSettings().maintenance === true, String(getSettings().maintenance));

clearRateLimit(PANEL_C);
await sayTo(PANEL_C, say('koi hai?'), 'mt');
check('customers see the maintenance reply',
  String(last().body).toLowerCase().includes('maintenance'), String(last().body).slice(0, 200));
check('admins bypass maintenance',
  (await pSay( say('pending'), 'mt2')).body !== getSettings().maintenanceMsg);

await pSay( btn('adm:settings'), 'se4');
await pSay( btn('adm:set:maintenance'), 'se5');
await pSay( btn(((sent[sent.length - 1].body.match(/adm:setdo:maintenance/) || [])[0] ?? 'adm:setdo:maintenance')), 'se6');
check('maintenance mode back OFF', getSettings().maintenance === false, String(getSettings().maintenance));

ab = count();
await pSay( btn('adm:dashboard'), 'dw');
{
  // With the bundled dashboard ON the row shows the live URL; with it
  // OFF it explains how to set DASHBOARD_URL — either is correct.
  const dashMsg = BODIES(msgsSince(ab));
  check('dashboard row links the dashboard (or explains DASHBOARD_URL)',
    dashMsg.includes('DASHBOARD_URL') || /https?:\/\/\S+/.test(dashMsg),
    dashMsg.slice(0, 260));
}

// ── Broadcast: throttle valves, opt-out, cap ────────────────
ab = count();
await pSay( btn('adm:bc'), 'bc');
ao = BODIES(msgsSince(ab));
check('broadcast opens the audience LIST', ao.includes('All customers') && ao.includes('Alert subscribers'), ao.slice(0, 300));
const audId = (ao.match(/adm:bca:\w+/) || [])[0];
await pSay( btn(audId), 'bc1');
check('compose prompt shown', BODIES(sent.slice(-1)).includes('message likhein'), BODIES(sent.slice(-1)).slice(0, 220));

await pSay( say('Weekend sale — 10% off today!'), 'bc2');
ao = BODIES(sent.slice(-1));
check('preview shows recipients + estimate + Send',
  ao.includes('Estimated recipients') && ao.includes('Estimated time') && ao.includes('✅ Send'), ao.slice(0, 400));

// One customer opts out first.
clearRateLimit(CUSTOMER);
rr = await sayTo(CUSTOMER, say('STOP'), 'so');
check('STOP = broadcast opt-out', String(rr.body).includes('hata diye'), String(rr.body).slice(0, 200));

ab = count();
await pSay( btn('adm:bcgo'), 'bc3');
ao = BODIES(msgsSince(ab));
check('broadcast finishes with a summary', /Sent: \*?\d+\**/.test(ao), ao.slice(0, 300));
check('subscribed customer received the broadcast',
  sent.filter((m) => m.jid === PANEL_C).some((m) => String(m.body).includes('Weekend sale')), 'no DM');
check('opted-out customer received NOTHING',
  !sent.filter((m) => m.jid === CUSTOMER).some((m) => String(m.body).includes('Weekend sale')), 'leaked to STOP user');
check('daily counter incremented',
  (await import('../handlers/adminBroadcast.js')).broadcastUsage() > 0, 'usage=0');

console.log('\n─── 21. Admin: plans price edit (writes data/plans.json) ───');
const plansBefore = JSON.parse(fs.readFileSync(new URL('../data/plans.json', import.meta.url), 'utf8'));
const targetPlan = plansBefore.plans[0];
ab = count();
await pSay( btn('adm:plans'), 'pl');
ao = BODIES(msgsSince(ab));
check('plans LIST shows every plan', ao.includes(targetPlan.name), ao.slice(0, 220));

await pSay( btn(`adm:plan:${targetPlan.id}`), 'pl2');
ao = BODIES(sent.slice(-1));
check('plan detail shows price / cost / visibility',
  ao.includes('Sell:') && ao.includes('Cost:') && ao.includes('Visible:'), ao.slice(0, 300));

await pSay( btn(`adm:planprice:${targetPlan.id}`), 'pl3');
check('price edit asks for a number', String(last().body).includes('naya price'), String(last().body).slice(0, 200));
await pSay( say(String(targetPlan.price + 10)), 'pl4');
ao = BODIES(sent.slice(-1));
check('old -> new confirmation shown',
  ao.includes('Old:') && ao.includes('New:') && ao.includes('Yes, apply'), ao.slice(0, 300));
const applyPriceId = (ao.match(/adm:planapply:[^":]+:\d+/) || [])[0];
await pSay( btn(applyPriceId), 'pl5');
const plansAfter = JSON.parse(fs.readFileSync(new URL('../data/plans.json', import.meta.url), 'utf8'));
check('new price written to data/plans.json instantly',
  plansAfter.plans.find((p) => p.id === targetPlan.id).price === targetPlan.price + 10,
  `${targetPlan.price} -> ${plansAfter.plans.find((p) => p.id === targetPlan.id).price}`);
check('price edit is in the audit log',
  recentAudit(30).some((a) => a.action === 'plan.price' && a.target === targetPlan.id),
  JSON.stringify(recentAudit(2)[0]));
// restore the real catalogue price for anyone re-running the repo test
plansAfter.plans.find((p) => p.id === targetPlan.id).price = targetPlan.price;
fs.writeFileSync(new URL('../data/plans.json', import.meta.url), JSON.stringify(plansAfter, null, 2));

await flush();
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED ✅' : `${failures} CHECK(S) FAILED ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
