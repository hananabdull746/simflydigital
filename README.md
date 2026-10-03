# Simfly Store — WhatsApp eSIM + Digital Commerce Bot ⚡

**Aapki Digital Zaroorat, Ek Store Mein**

A free, self-hosted WhatsApp bot for **Simfly Store**, an eSIM + digital-products
business. It walks a customer from *any* first message all the way to *delivered* —
plan browsing, order ID generation, payment screenshot collection, forwarding to the
admin, and admin-driven fulfilment (auto-purchase from eSIMaccess / ProdSeller / Eklas,
or a manual payload).

Built on **Baileys** (unofficial WhatsApp Web protocol) — **$0 API cost**, no Meta
Cloud API, no paid database (orders live in a local `lowdb` JSON file).

> ### 🔁 Migration note
> Rebranded from **Simfly Pakistan** to **Simfly Store** — update your WhatsApp Channel
> name/description and any external links/bios to match. The bot's name, tagline and
> footer now come from two `.env` vars only: `BRAND_NAME` and `BRAND_TAGLINE`
> (`BOT_DISPLAY_NAME` and `FOOTER_TEXT` are no longer read).

---

> ## ⚠️ IMPORTANT DISCLAIMER — READ FIRST
>
> This project uses the **unofficial WhatsApp Web protocol** via
> [`@itsliaaa/baileys`](https://www.npmjs.com/package/@itsliaaa/baileys), a fork of
> [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys).
> It is **not** Meta's official WhatsApp Business Cloud API, and it is **not**
> endorsed or supported by WhatsApp / Meta.
>
> - Automating a WhatsApp account this way is **against WhatsApp's Terms of Service**.
> - There is a real **risk of your number being temporarily or permanently banned**
>   (often after rapid messaging, bulk broadcasts, or unusual login patterns).
> - **Use a secondary / non-primary WhatsApp number** for testing *and* production.
>   Never run this on the number you personally use for friends and family.
> - Keep message volume human-like. The built-in rate limiter helps, but it is not
>   a guarantee against detection.
>
> You accept these risks by running this software.

---

## Why `@itsliaaa/baileys` (and no extra UI service)?

Putting interactive buttons/lists on top of stock Baileys normally needs either a
separate REST layer (`evolution-api`) or an npm plugin that hand-injects the missing
binary nodes (`malvin-btns`). This project uses neither — the UI is authored natively:

| | `@itsliaaa/baileys` (used here) | `evolution-api` | `malvin-btns` |
|---|---|---|---|
| Architecture | Fork of Baileys itself | Separate self-hosted REST server | In-process npm plugin |
| Extra ports / Docker | None | Yes (API server + webhook receiver) | None |
| Every send goes through | In-process `sendMessage()` | HTTP request → server → Baileys | Direct `relayMessage()` |
| Interactive messages | Built-in (`buttons`, `sections`, `nativeFlow`) | Via HTTP API | Injected at runtime |
| Session/auth | Your existing `auth_info/` folder | Its own separate session store | Your existing `auth_info/` folder |
| Extra maintenance | Fork maintained upstream | Second long-lived process to run | Obfuscated third-party code |

The fork generates `buttonsMessage` / `listMessage` / `interactiveMessage` for you, and
`relayMessage()` then **auto-appends the `biz` binary node** whenever one of those types
is present (`shouldIncludeBizBinaryNode`) — exactly the node the other two approaches
had to bolt on by hand. So the whole bot stays **one `npm start` process** with no extra
services, no open ports and no API cost.

Every interactive message is authored as a modern `nativeFlow` quick-reply button
(`interactiveMessage.nativeFlowMessage.buttons`) with a **brand footer**, and
`lib/ui.js` falls back to a numbered plain-text menu if a send ever fails.

---

## Features

- ✅ QR-code login with a persisted session (`auth_info/`, gitignored — scan once only)
- ✅ Marks every inbound message **seen** (read receipt / blue ticks) *before* replying
- ✅ Shows **"typing…"** while composing, and clears it after every reply
- ✅ Interactive **LIST** messages for menus (never a numbered plain-text wall)
- ✅ Interactive **BUTTON** messages (`nativeFlow` quick replies) for every choice
- ✅ **Footer watermark on every interactive message** — `Simfly Store ⚡ Aapki Digital Zaroorat, Ek Store Mein` (derived from `BRAND_NAME` + `BRAND_TAGLINE`)
- ✅ Spec button-first UX: 📶 *Browse Plans* · 📦 *Track My Order* · 💬 *Support* · ❓ *How eSIM Works*
- ✅ Unique auto-incrementing **Order ID** generator (`SMF-0001`, `SMF-0002`, …) — persisted
- ✅ Per-user order state in a **lowdb JSON store** (`db/orders.json`, survives restarts)
- ✅ **One-time** device gate: **eSIM support → factory unlock** — carrier-locked devices
  are stopped before the payment step, and the answer is stamped
  (`confirmedUnlocked`) so the check never asks again
- ✅ Payment **screenshot auto-forwarded** to your personal WhatsApp number
- ✅ Admin `confirm` / `reject` with **plain text commands** (no buttons needed)
- ✅ `confirm` → **stock check → eSIMaccess purchase → QR delivery** (supplier mode)
- ✅ **Manual mode** when no supplier keys are set — payload from `data/deliveries.json`
- 🛍️ **Second catalogue — Digital Store** (ProdSeller: gift cards, subscriptions, VPN,
  email-activation products) with a **50% default markup** applied in PKR — the USD
  price we pay the supplier is never shown to a customer
- ⚖️ **Second supplier (Eklas)** — with `EKLAS_API_KEY` set, every Eklas product is
  listed too (a duplicate of something already on the shelf is merged into it — never
  shown twice) and each item is sourced from whichever supplier is **cheaper AND in
  stock**, with checkout falling back to the other one when the winner runs out
  (ambiguous failures are never retried, so the wallet can't be charged twice).
  Explicit routing lives in `data/productSupplierMap.json` and always wins
- 📧 **Email-activation products** are sold as *activation*, not instant: the customer
  sees the ETA before paying, and a poll job re-checks ProdSeller until the keys
  arrive (then delivers) or the order fails (then refunds to the wallet)
- 🎟️ **Sale codes** — admin launches a `%`-off deal code (per-day and max-uses limits)
  in the panel; the customer taps *🎟️ Sale code* at the payment step, types it and the
  discounted total shows up before paying (both catalogues, screenshot + wallet paths)
- 🔖 **Price pins** — pin any Digital product to a PKR price; it holds until your
  effective markup falls below `PINNED_MARKUP_FLOOR`, then the live formula takes over
- 🔄 **Daily supplier sync** (`PRICE_SYNC_CRON`, default 06:00) — force-refreshes the
  merged catalogue, pages the admins with a cost/stock diff and a low-balance nudge
  for **both** supplier wallets
- 🎨 **Live branding** — rename the bot + tagline from ⚙️ Bot Settings (no restart,
  no `.env` edit; menus, footers and cards pick it up on the next screen)
- 💰 **Customer Wallet** — prepaid PKR balance verified once at top-up, spendable in
  ONE tap for eSIM plans *and* Digital products (no screenshot at purchase time),
  with instant refunds and a full ledger + audit
- 💳 **Binance Pay auto-verification (USDT)** — a second, *automatic* way to get paid:
  the customer is quoted an exact USDT figure, pays with Binance Pay and answers with a
  **Transaction ID** (no screenshot); the bot looks it up on
  `GET /sapi/v1/pay/transactions`, claims it atomically (one payment can never fulfil two
   orders) and — in `auto` mode — confirms the order by itself. Starts in **shadow** mode:
   matches are *reported* to you, never auto-confirmed
- 🤖 **AI Payment Decision Engine** — an analyst model (Groq) sits *on top of* both
  verifiers: it is asked **only** when the deterministic code says "I cannot tell", its
  `approve` is re-checked against the three invariants (a claimed transaction can never be
  re-claimed / an amount mismatch always escalates / code beats a bad approve) and every
  verdict is logged to `db/aiDecisions.json` + shown on the order card. Optional Gemini
  vision reads the screenshot for evidence. Starts in **shadow** — it reports, it never
  decides
- 🎁 **Purple Cow layer** — ⚡ **Fast Guarantee** (delivered inside `FAST_GUARANTEE_MINUTES`
  or the wallet is credited automatically), 📦 **Digital Unboxing** (paced "it landed"
  beats before the thank-you) and the 🎁 **Referral Loop** (stable invite code, bonus for
  BOTH sides, one credit per new phone · no self-referral · monthly cap)
- 🌐 **Bundled read-only web dashboard** (`DASHBOARD_PORT` + `DASHBOARD_TOKEN`):
  orders, digital catalogue, **WhatsApp Catalog**, wallets, ledger and CSV exports
- 🏪 **WhatsApp Business Catalog auto-post** — local product files in `catalog/`
  pushed to the WA Business catalogue (create / update / delete / full sync), managed
  from the dashboard's **WhatsApp Catalog** tab
- ✅ **15-minute auto-reminder**: customer gets "still processing" + admin gets pinged
- ✅ **Auto plain-text fallback** (numbered menu) when buttons don't render
- ✅ **Rate limiting / anti-spam** (per-user window + menu cooldown)
- 🧠 **Natural pacing** — human-style typing delay, one reply at a time per chat,
  double-tap debounce and a minimum gap between proactive nudges (`services/pacing.js`)
- ✅ Post-order engagement: **thank-you + channel link**, ⭐ **review flow**
  (4–5★ auto-posted to the WhatsApp Channel, ≤3★ forwarded to the admin only)
- ✅ Structured **file logging** (`logs/bot.log`, pino JSON lines)
- ✅ Modular, commented code (`config.js`, `handlers/*`, `lib/*`, `services/*`)

---

## UX features

The full UX batch, all covered by `npm test` / `npm run test:unit`:

1. **Resume interrupted orders** — leave mid-checkout and the next message offers
   *Continue / Start Over / Main Menu* for `SESSION_TTL_HOURS` (default 24 h)
2. **Step progress** — checkout is exactly TWO steps: `Step 1 of 2: Choose & Confirm`
   (device gate the first time + how many eSIMs) then `Step 2 of 2: Pay`. The
   post-checkout *verification pending* screen carries no prefix at all
3. **⏳ Acknowledgements** — `withAck()` replies instantly ("Checking availability…")
   so slow supplier calls never look like a dead bot
4. **Sold-out awareness** — bulk stock cache (`STOCK_CACHE_SECONDS`), sold-out plans stay
   visible with a ❌ row, out-of-stock screens offer **See Other Plans / 🔔 Notify Me**
5. **🔔 Alerts** — restock subscriptions per plan + global price-drop alerts,
   watched by a node-cron job (`ALERTS_CRON`, default every 15 min, 1 alert/subscriber/day)
6. **🔁 One-tap reorder** — from the order card or My Orders, jumps straight to payment
7. **Delivery receipt** — ✅ Delivered / plan / price / order id / date (PKT) sent
   before the QR payload
8. **Loyalty rewards** — every `LOYALTY_ORDERS`th delivery unlocks a
   `LOYALTY_DISCOUNT_PERCENT`% code, applied automatically at the payment step
9. **🌐 Language** — Roman Urdu + English mix (default) ↔ Full English, per customer,
   switchable from the menu
10. **Human handoff** — 🙋 *Talk to Human* confirms instantly, sends ONE context card
    (number, step, plan, last order + reply instructions) to every admin, and keeps
    the bot quiet on free text - while each customer message/media is still mirrored
    to the team, admins reply with `human <number> <msg>`, and both sides get one
    closing note when `HUMAN_MODE_MINUTES` expires (or `bot on <number>` ends it)
11. **Receipt/thank-you engagement** — short thank-you (≤ 4 lines) with the WhatsApp
    Channel link and loyalty progress
12. **Unsupported media never goes silent** — voice/location/etc. get a polite
    "use the menu buttons" fallback
13. **Review broadcast** — a ⭐ rating takes two taps; 4–5★ reviews are posted to the
    channel (first name or "Verified Customer" only — never a phone number),
    ≤3★ go to the admin only
14. **Cancel & Delete on every order** — tapping an order in *My Orders* opens the
    detail with **⛔ Cancel** and **🗑️ Delete** on *every* status: cancel stops an
    open order (admins are alerted at once), delete removes it from the customer's
    list in one short line (the record stays for admin history — deleting a pending
    order cancels it first)

---

## Natural pacing (bot maturity)

Instant, back-to-back replies read like a bot — and a double-tapped button that
advances a flow twice reads like a broken one. All of it lives in one module,
`services/pacing.js`, wired in from `handlers/router.js`:

| Behaviour | What the customer sees | Control (default) |
|---|---|---|
| **Think time** | A believable typing pause before every reply — short question ≈ floor, long paragraph ≈ ceiling, ±15% jitter | `MIN_REPLY_DELAY_MS` / `MAX_REPLY_DELAY_MS` (`700` / `2800`, `0`/`0` = off) |
| **One reply at a time per chat** | A burst of messages is answered in order, never interleaved | always on (per-jid queue in `enqueue()`) |
| **Debounce** | The same words inside the window are one input — a nervous double-tap can't start a flow twice | `DEBOUNCE_WINDOW_MS` (`1500`, `0` = off) |
| **Nudge gap** | Two automated messages (reminder, thank-you, review prompt) never land back-to-back on one number | `BROADCAST_MIN_GAP_MINUTES` (`30`, `0` = off) |
| **Review prompt expiry** | An unanswered ⭐ prompt is dropped after `REVIEW_PROMPT_TIMEOUT_HOURS` and never re-sent | `6` hours |

Notes:

- Media is **never** debounced — a payment screenshot always gets through.
- The nudge gap is per customer: the admin ping for a pending reminder always goes
  out, only the customer-facing message waits for the gap.
- The test suite runs with every one of these switched off (`test/smoke.js`,
  `test/pacing.test.js`), so coverage is unaffected by timing.

---

## Requirements

- **Node.js 20 or newer** (v20.19+ / v22.12+ / v24 recommended) — the code is **ESM-only**
- A WhatsApp account (ideally a *secondary* number) to scan the QR
- Any always-on machine: your PC, a free-tier VPS, or a free PaaS container
- Optional: an [eSIMaccess.com](https://esimaccess.com) API key/secret for automatic purchasing

---

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Create your configuration
#    (Windows PowerShell: Copy-Item .env.example .env)
cp .env.example .env

# 3. Edit .env — at minimum set ADMIN_WHATSAPP_NUMBER and your payment accounts
#    (see "Configuration" below)

# 4. Run it
npm start
```

A QR code is printed in your terminal:

```
[bot] Scan this QR with WhatsApp → Linked Devices:
████ ...
```

Scan it with **WhatsApp → Settings → Linked Devices → Link a Device**.

The session is written to `auth_info/` — **you will not need to scan again** after
restarts, as long as you don't log that device out.

### Automated tests (no WhatsApp needed)

```bash
npm test              # end-to-end smoke test through the real handlers (stub socket)
npm run test:unit     # unit tests for nav helpers, sessions, loyalty, i18n, alerts, stock cache
npm run test:features # two-step checkout (quantity / multi-unit confirm) + the AI decision engine (invariants / fallbacks / log) + the Purple Cow layer (guarantee / unboxing / referral) + Digital Store (pricing/ProdSeller/polls) + dual-supplier + pacing + Wallet + store screens + 💳 Binance Pay
npm run test:all      # smoke + unit + features
npm run probe         # offline check that buttons/lists render in this Baileys build
```

### Test the whole flow live

1. Message your bot number from a second WhatsApp account: `hello`
2. You should receive the **welcome LIST** — tap **📶 Browse Plans**
3. Pick a plan from the list → **BUTTON** message with *Order Now*
4. Confirm eSIM compatibility → confirm the phone is **Factory Unlocked**
   (a carrier-locked device stops the order here; *Not Sure* gets check instructions —
   both questions are asked **once per customer**)
   → pick **how many eSIMs** (1–3 by default) → pick **SadaPay / Binance ID**
5. The bot replies with your account details, a **`SMF-XXXX` Order ID** and the
   quantity (`📦 N eSIMs`), and asks for a screenshot
6. Send a payment **screenshot (image)**
7. **One message** lands in **your own WhatsApp** (the admin number): the
   payment screenshot with the order details and Confirm/Reject buttons on it
8. Reply in that chat: `confirm SMF-0001`
   - **Supplier mode** (ESIMACCESS keys set): the bot checks stock, buys the eSIM and
     sends the real QR / activation code.
   - **Manual mode** (no keys): the bot sends the payload from `data/deliveries.json`.
9. If you don't act within **15 minutes**, the customer gets a "still processing"
   update *and* you get pinged with the exact `confirm` command again.

---

## Configuration (`.env`)

Every variable is documented in [`.env.example`](.env.example). The important ones:

| Variable | Required | What it does |
|---|---|---|
| `BRAND_NAME` / `BRAND_TAGLINE` | Optional | Brand name + tagline everywhere: menus, titles, footers (defaults `Simfly Store` / `Aapki Digital Zaroorat, Ek Store Mein`) |
| `ADMIN_WHATSAPP_NUMBER` | **Yes** | Your personal number that receives screenshots and runs `confirm` / `reject` / `status`. Accepts `0300…`, `92300…` or a full JID. |
| `PAYMENT_SADAPAY_NUMBER` / `PAYMENT_SADAPAY_TITLE` | **Yes** | SadaPay account shown to the customer |
| `PAYMENT_BINANCE_ID` / `PAYMENT_BINANCE_NETWORK` | **Yes** | Binance ID (+ coin/network) shown to the customer |
| `PAYMENT_BANK_DETAILS` | Optional | Bank details as one free-form block (shown verbatim, `\n` = line break) |
| `BINANCE_PAY_ID` | Optional | **Enables the 💳 Binance Pay method** (USDT, auto-verified). Your Binance Pay receive ID (the one customers pay *into*) — different from `PAYMENT_BINANCE_ID` |
| `BINANCE_API_KEY` / `BINANCE_API_SECRET` | With above | Binance API key pair used **only** to read `GET /sapi/v1/pay/transactions` — create it read-only ("Enable Reads" only, never Enable Withdrawals) |
| `BINANCE_VERIFIER_MODE` | Optional | `off` (method hidden from checks) · **`shadow` (default)** — verify + report, you still confirm · `auto` — a clean match confirms the order itself |
| `USDT_PKR_RATE` | Optional | PKR → USDT conversion used for the quoted amount (falls back to `USD_PKR_RATE`, default `278`) |
| `BINANCE_MATCH_WINDOW_MIN` / `BINANCE_RETRY_MS` / `BINANCE_MAX_WAIT_MS` | Optional | How far from "now" a payment counts (default `60`) · retry gap (`20000`) · give-up budget (`300000`) |
| `ESIMACCESS_API_KEY` / `ESIMACCESS_API_SECRET` | Optional | eSIMaccess supplier credentials — enables automatic purchase on `confirm` |
| `ESIMACCESS_BASE_URL` / `ESIMACCESS_TIMEOUT_MS` | Optional | Supplier API base URL + timeout (defaults shown in `.env.example`) |
| `MAX_QTY_ESIM` | Optional | Biggest number of eSIMs one eSIM order may hold (default `3`, min `1`) |
| `AI_VERIFIER_MODE` | Optional | **`shadow` (default)** — call the analyst + report on the card · `auto` — may act when every invariant holds · `off` — no model, no records |
| `GROQ_API_KEY` / `GROQ_MODEL` | Optional | The analyst (Groq chat completions, JSON mode). Unset = no AI at all, everything behaves as before |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | Optional | Vision: reads the payment screenshot. Unset = no screenshot evidence (deterministic check unchanged) |
| `AI_DECISION_TIMEOUT_MS` / `AI_DECISIONS_FILE` | Optional | Model budget (default `8000`) · decision log (default `<DB_DIR>/aiDecisions.json`, last 500) |
| `FAST_GUARANTEE_MINUTES` / `FAST_GUARANTEE_CREDIT_PKR` | Optional | The delivery promise (default `15`) · automatic wallet credit when it is missed (`100`) |
| `UNBOXING_MODE` | Optional | `on` (default) runs the 3 unboxing beats · `off` disables them |
| `REFERRAL_BONUS_PKR` / `REFERRAL_MONTHLY_CAP` | Optional | Bonus for **both** sides (`100`) · monthly cap per referrer (`1000`) |
| `SUPPORT_WHATSAPP_NUMBER` | Optional | Shown on the *Support* card (defaults to the admin number) |
| *(derived)* `BRAND.footer` | — | Watermark on **every** list/button message = `BRAND_NAME ⚡ BRAND_TAGLINE` |
| `WHATSAPP_CHANNEL_LINK` | Recommended | Channel invite link — shown after delivery, used for review broadcasts |
| `WHATSAPP_CHANNEL_JID` | Optional | Direct `120363…@newsletter` jid **or** a bare invite code; leave empty to resolve from the link |
| `AUTO_REMINDER_MINUTES` | Optional | Delay before the "still processing" message + admin ping (default `15`) |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | Optional | Anti-spam window (default 8 msgs / 60 s) |
| `MENU_COOLDOWN_MS` | Optional | Minimum gap between menu triggers (default 5000 ms) |
| `FORCE_PLAIN_TEXT` | Optional | `true` = never send interactive UI, always numbered plain text |
| `LOYALTY_ORDERS` / `LOYALTY_DISCOUNT_PERCENT` | Optional | Reward every Nth delivery with a % discount code (default `5` / `10`) |
| `SESSION_TTL_HOURS` / `HUMAN_MODE_MINUTES` | Optional | Resume window (default `24`) / human-mode silence (default `30`) |
| `STOCK_CACHE_SECONDS` / `ALERTS_CRON` | Optional | Bulk stock cache TTL (default `60`) / restock-watcher cron (default `*/15 * * * *`) |
| `AUTH_DIR` / `DATA_DIR` / `DB_DIR` / `LOG_DIR` / `STORE_FILE` | Optional | Override session / data / order-store / log locations |
| `SESSIONS_FILE` / `USERS_FILE` / `ALERTS_FILE` | Optional | Override the resume-session / profile / alert-subscription files |
| `ADMIN_NUMBERS` / `STAFF_NUMBERS` | Optional | Extra **owners** / limited **staff** for the admin panel (comma-separated numbers) |
| `CONFIRM_TWICE_ABOVE_PKR` | Optional | Orders at/above this price need a second confirm tap (default `3000`) |
| `BROADCAST_MSGS_PER_MINUTE` / `BROADCAST_DAILY_CAP` / `BROADCAST_JITTER_MS` | Optional | Broadcast throttle — **keep low**, mass DMs are the #1 ban risk (defaults `8` / `200` / `3000-9000`) |
| `DASHBOARD_PORT` / `DASHBOARD_TOKEN` | Optional | Starts the **bundled read-only dashboard** on that port (`0`/empty = off); every request must carry the token |
| `DASHBOARD_URL` | Optional | Panel → 🌐 Dashboard row link for an **external** dashboard (overrides the bundled one) |
| `CATALOG_DIR` / `CATALOG_INDEX_FILE` | Optional | 🏪 WhatsApp Catalog local truth: product folders (default `<ROOT>/catalog`) / the `retailerId → WhatsApp id` index (default `<CATALOG_DIR>/catalog.json`) |
| `CATALOG_SYNC_DELAY_MS` / `CATALOG_SYNC_BATCH` | Optional | 🏪 Pause between two catalogue mutations (default `300`) / products pushed per sync run (default `100`) — WA rate-limits `productCreate`/`productUpdate` |
| `PRODSELLER_API_KEY` | Optional | Enables the 🛍️ **Digital Store** (prodseller.com → API Keys); without it the store stays hidden |
| `USD_PKR_RATE` / `DIGITAL_MARKUP_PERCENT` | Optional | Digital pricing: `price × rate × (1 + markup%)` (defaults `278` / `50`) |
| `PRODSELLER_CACHE_SECONDS` | Optional | Digital catalogue cache (default `120`) — protects the 300 req / 15 min rate limit |
| `PINNED_MARKUP_FLOOR` | Optional | Price pins hold while the effective markup stays ≥ this % (default `50`, `0` = pins off) |
| `PRICE_SYNC_ENABLED` / `PRICE_SYNC_CRON` | Optional | Daily supplier price/balance sync + admin diff alert (defaults `true` / `0 6 * * *`) |
| `ACTIVATION_ETA_LABEL` / `ACTIVATION_POLL_MINUTES` / `ACTIVATION_MAX_WAIT_HOURS` | Optional | Email-activation wording + poll job cadence (defaults `usually within 2-6 hours` / `2` / `6`) |
| `PRODSELLER_LOW_BALANCE_USD` | Optional | Admin alert when the **ProdSeller USDT** balance drops to this (default `15`) |
| `EKLAS_API_KEY` / `EKLAS_BASE_URL` / `EKLAS_TIMEOUT_MS` | Optional | Second digital supplier (**Eklas**) — enables price compare + fallback checkout (defaults `https://api.eklas.dev/v1` / `15000`) |
| `PRODUCT_COMPARE_CACHE_SECONDS` | Optional | In-memory catalogue cache used by the price compare (default `120`) |
| `EKLAS_LOW_BALANCE_USD` | Optional | Admin alert when the **Eklas USDT** balance drops to this (default `15`) |
| `MIN_REPLY_DELAY_MS` / `MAX_REPLY_DELAY_MS` | Optional | Random human-style typing delay between replies (defaults `700` / `2800`; `0` / `0` = off) |
| `DEBOUNCE_WINDOW_MS` | Optional | Per-jid window where a repeat tap is swallowed instead of double-processed (default `300`, `0` = off) |
| `REVIEW_PROMPT_TIMEOUT_HOURS` | Optional | Grace period before the ⭐ review prompt is skipped (default `6`) |
| `BROADCAST_MIN_GAP_MINUTES` | Optional | Minimum silence between proactive broadcasts to one number (default `30`, `0` = off) |
| `WALLET_ENABLED` / `WALLET_TOPUP_MIN` / `WALLET_TOPUP_MAX` | Optional | Customer wallet switch + top-up limits (defaults `true` / `100` / `20000`) |
| `WALLET_TOPUP_MAX_ATTEMPTS` / `WALLET_TOPUP_WINDOW_MS` | Optional | Top-up anti-abuse rate limit per customer (defaults `5` / `600000`) |
| `SUPPLIER_LOW_BALANCE_USD` | Optional | Low supplier-balance alert threshold (default `10`) |
| `DAILY_SUMMARY_CRON` / `WEEKLY_SUMMARY_CRON` | Optional | Admin summary schedules in Asia/Karachi (defaults `0 21 * * *` / `0 9 * * 1`) |
| `AUDIT_FILE` / `ADMIN_STATE_FILE` / `PAYMENTS_FILE` / `BROADCAST_FILE` | Optional | Override the admin audit / settings-blocklist / payment-email / broadcast-counter files |

> A payment method is **hidden from the menu** if none of its fields are filled in,
> so only the methods you fill in appear (right now: **SadaPay** + **Binance ID**).
> JazzCash / Easypaisa / Bank Transfer still exist — fill their `PAYMENT_*` (or legacy
> `JAZZCASH_*` / `BANK_*`) values to bring them back.

Restart the bot after editing `.env` — environment variables are read at boot.

---

## Customer flow

```
 any message
     │
     ▼
 ┌──────────────────────────────┐
 │  WELCOME — LIST message      │  📶 Browse Plans
 │  Simfly Store                │  📦 Track My Order
 │  "Aapki Digital Zaroorat…"   │  🛍️ Digital Store · 💰 Wallet
 │                              │  💬 Support · ❓ How eSIM Works
└──────────────────────────────┘
     │  Browse Plans
     ▼
 ┌──────────────────────────────┐
 │  PLANS — LIST message        │  4 real Telenor/Zong 4G plans as rows
 │  (2 sections, no expiry)     │  title = name, description = price
 │                              │  500MB/1GB ship auto guides, 6/10GB manual
 └──────────────────────────────┘
     │  tap a plan
     ▼
 ┌──────────────────────────────┐
 │  PLAN DETAIL — BUTTONS       │  ✅ Order Now
 │  data / validity / price     │  ⬅️ Back to Plans
 └──────────────────────────────┘
     │  Order Now
     ▼
 ┌──────────────────────────────┐
 │  COMPATIBILITY — BUTTONS     │  ✅ Yes, eSIM supported   (asked ONCE per customer)
 │                              │  ❌ Not sure / No → quick check + support link
 └──────────────────────────────┘
     │  Yes
     ▼
 ┌──────────────────────────────┐
 │  FACTORY UNLOCK CHECK        │  ✅ Yes, Factory Unlocked → quantity
 │  "Is your phone/iphone       │  🔒 No, Carrier-Locked → flow STOPS here
 │   Factory Unlocked?"         │  ❓ Not Sure → how to check, then continue
 └──────────────────────────────┘
     │  Yes, Factory Unlocked
     ▼
 ┌──────────────────────────────┐
 │  QUANTITY — LIST             │  1–3 eSIMs (MAX_QTY_ESIM), one QR/code per unit
 │  "Kitne eSIM lene hain?"     │  row tap or typed number (1–3)
 └──────────────────────────────┘
     │  eqty:2   (or type "2")
     ▼
 ┌──────────────────────────────┐
 │  PAYMENT METHOD — BUTTONS    │  SadaPay · Binance ID · 💳 Binance Pay (USDT)
 │                              │  💰 Pay from Wallet (enough balance)
 └──────────────────────────────┘
      │  SadaPay
      ▼
  ┌──────────────────────────────┐
  │  ACCOUNT DETAILS + ORDER ID  │  🎫 SMF-0001  (auto-incrementing)
  │  asks for screenshot         │  💳 Change Method / ⛔ Cancel Order
  └──────────────────────────────┘
     │  screenshot (image)
     ▼
┌──────────────────────────────┐
│  ONE message to ADMIN        │  screenshot + customer, plan,
│  + 15-min reminder armed     │  price + Confirm/Reject buttons
└──────────────────────────────┘
     │  admin: confirm SMF-0001
     ▼
 ┌──────────────────────────────┐
 │  stock check → purchaseEsim  │  supplier mode (ESIMACCESS keys set)
 │        or                    │
 │  data/deliveries.json payload│  manual mode (no keys)
 └──────────────────────────────┘
     │
     ▼
 ┌──────────────────────────────┐
 │  eSIM to customer            │  QR image + activation code,
 │                              │  or the manual activation text
 └──────────────────────────────┘
```

> 💳 **Binance Pay** changes one branch only: instead of *ACCOUNT DETAILS → screenshot*
> the customer gets the exact USDT figure, types a **Transaction ID**, and the bot
> verifies it against Binance in the background (see
> [Binance Pay auto-verification](#-binance-pay-auto-verification-usdt)).

### Two-step checkout

Checkout is **two screens**, not four:

| Step | Screen | What happens |
|---|---|---|
| **1 of 2** | *Choose & Confirm* | Plan detail → Order Now → the device micro-check (**the first time only**) → the **quantity** list (`eqty:1 … eqty:N`, or type `1–MAX_QTY_ESIM`) |
| **2 of 2** | *Pay* | Payment method → account details / USDT screen with `📦 N eSIMs` and the ×N cart total → the proof |
| *after* | *verification pending* | `awaiting_confirmation` — **no `Step X of Y` prefix**, because the order is no longer being built |

Notes:

- **The device gate is one-time.** `compat_yes` + `unlock_yes` stamp
  `confirmedUnlocked` on the profile (`db/users.json`), and every later order jumps
  straight to the quantity list. `unlock_no` still stops the flow before any payment.
- **Quantity = one order, N eSIMs.** Each unit is purchased with its own supplier
  reference (`SMF-0001-1`, `SMF-0001-2`, … — never the bare Order ID twice), stored in
  `order.esims[]` and delivered as its own QR / activation code. `order.qr`,
  `activationCode`, `iccid` and `supplierOrderId` mirror **unit 1** for older tooling.
  A partial supplier failure delivers what it bought, keeps the order
  `pending_admin`, and the next `confirm` purchases **only the missing units**.
- **Resuming after the proof** (`awaiting_confirmation`) never asks for the screenshot
  again — it shows where the order stands (and falls back to the right screen if it
  settled or was rejected in the meantime).
- **Digital Store quantity** is unchanged (`1–10`), and its activation email is folded
  into Step 1 instead of being a step of its own.
- Legacy session ids from the old four-step flow (`plan`, `device`, `email`,
  `product`, `payment`, `screenshot`) are normalized by `normalizeStep()`, so an
  interrupted order still resumes on the right screen.

---

## Admin commands

Type these **in your own chat with the bot** (no buttons needed):

| Command | Effect |
|---|---|
| `confirm SMF-0001` | Stock check → supplier purchase → eSIM/QR to the customer (falls back to the manual payload) |
| `reject SMF-0001 payment not received` | Tells the customer it was rejected, with your reason |
| `status SMF-0001` | Local order status + supplier-side status (when a supplier ref exists) |
| `orders` | Lists orders waiting on your confirmation |
| `all orders` | Last 10 orders with status |
| `admin help` | Shows this list |

The bot also messages *you* first, with the screenshot and the exact `confirm` /
`reject` line pre-written — just tap and send it.

### In-WhatsApp admin panel

Type `admin` (or tap **🙋 Talk to Human → admin**) to open the button-based
panel — no dashboard or laptop needed:

| Row | What it does |
|---|---|
| 🔔 Pending Orders | Cards for every waiting order: **Confirm / Reject / Message customer / Details / Block** |
| 📊 Today's Stats | Orders, revenue, profit (day / week / month) |
| 🔍 Find | Search by order id, mobile number or customer name |
| 📦 Plans & Prices | Change a price or hide/show a plan (writes `data/plans.json` instantly — owner only) |
| 🛍️ Digital Store | ProdSeller catalogue: markup, visibility, rename, refresh, balance, retry/refund actions — plus per-product **✏️ USD price**, **📌 Price pin** and live **💵 USD rate** |
| 🎟️ Sale Codes | Launch a `%`-off code (`CODE, percent[, days[, maxUses]]`), pause/resume, delete, live status — customers type it at checkout |
| 💰 Wallet | Liability, wallet list, pending top-ups, per-customer ledger, ± adjustments, audit |
| 💳 Payments | Parsed NayaPay emails, manual link/unlink, honest verifier status |
| ⭐ Reviews | Review queue — broadcast ≥4★ to the channel, unpublish, never ≤3★ |
| 📢 Broadcast | Audience → compose → preview → throttled send (see safety rules below) |
| 🚫 Blocklist | Block / unblock numbers (blocked customers get no replies) |
| 👥 Admins | Add / remove admins from inside the chat — roles `owner` / `staff` (owner only) |
| 📣 Channel & Group | Set a custom channel link, set the updates group, send an update to both (owner only) |
| ⚙️ Bot Settings | Maintenance, quiet hours, review broadcasts, **brand name + tagline** (live, owner only) |
| 🌐 Dashboard | Opens the bundled dashboard (`DASHBOARD_PORT` + token, tabs incl. **🏪 WhatsApp Catalog**) or `DASHBOARD_URL` |

**Roles** come from the sender's WhatsApp number:

- **Owner** — `ADMIN_WHATSAPP_NUMBER` + `ADMIN_NUMBERS`: everything.
- **Staff** — `STAFF_NUMBERS`: orders, Find, Stats, payments, reviews — *not*
  Settings, price edits, Admins or Channel & Group.
- **Panel-added admins** — added live from **👥 Admins** (persisted in
  `db/admin.json`, audited); `.env` entries stay locked — the panel tells you
  to edit `.env` for those.
- **Everyone else**: the panel never appears for them (it doesn't even exist).

**📣 Channel & Group** keeps two values in `db/admin.json`: a custom channel
link (falls back to `WHATSAPP_CHANNEL_LINK`) and the updates group jid (paste
`chat.whatsapp.com/…` or `1203…@g.us`). *Send update* posts one short message
to the group (make the bot number a **group admin**) and the channel (make it
a **channel member**), then reports back — two sends, never a burst.

Every action (confirm, reject, block, price change, broadcast…) is written to
the **audit log** (`db/audit.json`) with who/what/when. Order buttons carry the
order id **and** a version number, so a stale tap can never deliver the same
order twice, and simultaneous taps are locked per order.

**Broadcast safety** (this bot uses the *unofficial* WhatsApp route):

- recipients = customers who ordered or opted in to alerts; blocked + `STOP`
  numbers are always skipped
- rate limit (`BROADCAST_MSGS_PER_MINUTE`) + random jitter + a hard
  **daily cap**; the preview shows recipients + ETA before anything sends
- a live ⏹️ Stop button cancels a run mid-flight
- no phone numbers, logins or screenshots in broadcasts — prefer the Channel

Typed commands (`confirm`, `reject`, `status`, `orders`, `bot on/off <number>`,
`human <number> <msg>`, `block <number>`, `stats`, `find <q>`, `price <plan> <amount>`) keep working
exactly as before — the panel is an addition, not a replacement.

---

## eSIM supplier (eSIMaccess.com)

All supplier access is isolated in [`services/esimaccess.js`](services/esimaccess.js);
handlers never touch axios or supplier URLs.

- **Configured** (`ESIMACCESS_API_KEY` + `ESIMACCESS_API_SECRET` set):
  `confirm SMF-XXXX` → `checkStock()` → `purchaseEsim()` → QR / activation code /
  ICCID sent to the customer.
- **Not configured**: `purchaseEsim()` returns `NOT_CONFIGURED` and the bot delivers
  the payload from `data/deliveries.json` instead — the whole order flow still works.
- **Supplier errors never crash the bot**: every function returns
  `{ ok: false, ... }`, the order stays `pending`, and you can retry with `confirm`.

> ### ⚠️ Before going live — verify the API contract
> Endpoint paths, the auth scheme and the response field names are marked
> `TODO(VERIFY)` inside `services/esimaccess.js`. Open your eSIMaccess dashboard →
> API / Developer docs and confirm them there — they are deliberately isolated in
> that one file so nothing else needs to change.

---

## Digital Store (ProdSeller + Eklas — the second catalogue)

The bot sells **two catalogues side by side**:

| | 📶 eSIM store | 🛍️ Digital Store |
|---|---|---|
| Supplier | eSIMaccess.com | [prodseller.com](https://prodseller.com) + optional [Eklas](https://docs.eklas.dev) |
| Products | data plans in `data/plans.json` | gift cards, subscriptions, VPN, email-activation accounts (live API) |
| Price | you set it in the JSON | `price_usd × USD_PKR_RATE × (1 + DIGITAL_MARKUP_PERCENT%)`, rounded to clean PKR |
| Delivery | QR / activation code | key(s) in chat, or **email activation** (polled) |
| Code | `services/esimaccess.js` | `services/productCatalog.js` (+ `prodseller.js` / `eklas.js`) · `lib/digital.js` · `handlers/digitalStore.js` |

Rules the code enforces:

- **Nothing is hardcoded** — every price is computed live as
  `USD price × USD_PKR_RATE × (1 + ROI%)`, and all three inputs are switchable:

  | Input | Default (.env) | Admin override (panel → 🛍️ Digital Store) |
  |---|---|---|
  | USD price | supplier's `price` | ✏️ **USD price** per product (`reset` → supplier price) |
  | PKR per USD | `USD_PKR_RATE` | 💵 **USD Rate** (live, applies to all prices) |
  | ROI / markup | `DIGITAL_MARKUP_PERCENT` | ✏️ **Default Markup** (global) · ✏️ **Markup %** (per product) |

- The USD figure (`costUsd`) exists **only on admin views** (panel rows, dashboard,
  `adminProducts()`) — a shopper's view/JSON never carries it, and it never reaches a
  chat, card or log. Only the marked-up PKR price does.
- A product can be hidden (`visible:false`), renamed or re-priced without touching the API.
  Overrides live in `data/digitalProductOverrides.json`
  (`{ markupPercent, costUsd, visible, badge, customName }`).
- The catalogue is cached (`PRODSELLER_CACHE_SECONDS`) with a last-known-good snapshot — a
  supplier outage can never empty the shelf.
- Every documented error code (400/401/402/404/409/429/500) maps to a friendly message;
  401 / 402 / 500 additionally page the owner.
- `Idempotency-Key: simfly_<SMF-ID>` means a retry returns the **first** order — the USDT
  wallet is charged exactly once.

### Browse: ONE list, categories as section titles

The store opens as **one LIST** — categories are *separators inside it*, never a
second menu to walk through:

- **9 fixed categories** (`lib/digital.js → STORE_CATEGORIES`) in screen order —
  🤖 AI Chat & Assistants · 🚀 Code & Automation · 🎨 Design & Creative ·
  ✂️ Video & Editing · 📺 Streaming & Music · 🔐 VPN & Security · 💼 Productivity ·
  📧 Email Accounts · 🎓 Learning & Lifestyle — plus ✨ *More Picks* for anything no
  keyword claims, so nothing ever disappears. Empty categories are not shown.
- Every product sits **directly under its category title** (in-stock first, cheapest
  first) — the first screen already sells, with no "Shop by Category" hop.
- A category with more than 10 items ends in **`➕ N more in <Category>`**, the one
  drill-down there is: it opens the full list chunked as `⚡ Instant 1/2…` with
  🔍 Search and ⬅️ All Categories rows.
- 🔍 Search, 🏠 Main Menu, 🙋 Talk to Human and 🌐 Language ride in a trailing
  **Menu** section (folded into the last section when the 10-section cap is hit, so
  WhatsApp's hard limit is never exceeded). Typing a product name straight into the
  chat still opens its detail card.
- **Names are polished** (`prettifyDigitalName`): listing noise `(FW)`, `(NW)`,
  `W6D`, `(link)`, `panel` goes away and the duration / credits / seats are lifted
  into their own parts → `CapCut Pro · 6 Months`, `Miro Lifetime · 100 Seats`,
  `Lovable Lite · 12 Months · 300 Credits`, `Microsoft 365 · 1 Year`. An admin
  **✏️ rename** (`customName`) always wins.
- **Supplier twins list once**: duplicate detection keys on that *polished* name, so
  `Capcut Pro 7D FW` and `Capcut Pro 7 Days (FW)` share one row (cheaper in-stock
  supplier wins, the other stays a comparable alternate).
- WhatsApp LIST limits hold everywhere: ≤10 sections, ≤10 rows per section (bigger
  categories chunk as `⚡ Instant 1/3`), section titles ≤24, row titles ≤64,
  descriptions ≤72.
- The **numbered plain-text fallback stays honest**: `user.choices` is built *from
  the rendered rows*, so `1`, `2`, … always mean exactly what the customer saw.

### Buy more than one (quantity)

`✅ Order Now` asks **how many** before anything else:

| | |
|---|---|
| Options | LIST rows `1 / 2 / 3 / 5 / 10`, each showing the **running total** (`3 pieces` → `PKR 1,950 · PKR 650 each`) — or any custom number typed in chat (`7`), capped at `QTY_MAX = 10` |
| Bad input | `0`, `11`, `abc` → the allowed range is spelled out and the picker re-opens (never silently clamped) |
| One cart | `handlers/checkout.js` stays the **single** resolver: `price = unit × quantity`, `name` gains a `×4` suffix — payment screen, sale code, wallet one-tap, receipts and admin cards all read that one number |
| Order record | `order.quantity` is stored on both the screenshot path and the wallet path, then `createOrder({ quantity })` buys that many from the supplier (`deliveredKeys` already carries several keys) |
| Activation items | the quantity screen says all of them land on the **same email** |

### Email-activation products are NOT instant

Some products need an email and take hours (default *"usually within 2-6 hours"*,
`ACTIVATION_ETA_LABEL`):

1. the product screen says **activation ETA before the customer pays**
2. checkout asks for + validates the activation email
3. after payment the order parks as `awaiting_supplier_funding` (ProdSeller balance empty)
   or `awaiting_activation`, and a poll job (`services/digitalPolls.js`) re-checks every
   `ACTIVATION_POLL_MINUTES`
4. supplier says `delivered` → keys are sent, receipt, order fulfilled
5. supplier says `failed` → order `refunded`, money back to the wallet, 🔴 owner alert
6. still stuck after `ACTIVATION_MAX_WAIT_HOURS` → 🚨 owner alert with the ProdSeller id

### Admin panel → 🛍️ Digital Store

Catalogue list with stock/visibility · per-product *hide / rename / markup* · global
markup default · 💳 ProdSeller balance + low-balance threshold · 🔁 Refresh (drops the
cache) · masked-key order cards with **Retry purchase** / **Reject + refund** actions.
Text commands: `storebal`, `storeresh`, `storemarkup`, `storemarkupdef`, `storename`,
`storevis`.

### Pricing — one formula, all inputs editable

```
sell PKR = supplier USD price × USD_PKR_RATE × (1 + ROI%)
```

Nothing is hardcoded: the admin panel edits **every** input without touching `.env`.

| Input | Where to change it |
|---|---|
| Supplier USD price | panel → 🛍️ Digital Store → item → **✏️ USD price** (`1.25` = USD, `60%` = set ROI for that item, `reset` = back to supplier price) |
| PKR/USD rate | panel → 🛍️ Digital Store → **💵 USD Rate** (default `USD_PKR_RATE=278`, refreshed live) |
| ROI (markup %) | panel → item → **✏️ Markup** (default `DIGITAL_MARKUP_PERCENT=50`) |
| Pin a PKR price | panel → item → **📌 Price pin** (`800` holds ₨800; `reset` unpins) |

A pin holds while your effective markup stays ≥ `PINNED_MARKUP_FLOOR` (default 50%);
if the supplier cost moves so far that the floor breaks, the formula takes over again
so you never sell below your floor. Cost, override and pin fields exist **only** in the
admin view — a customer's checkout payload never carries them.

### Second supplier (Eklas) — compare & safe fallback

With `EKLAS_API_KEY` set the Digital Store sources from **two** suppliers and picks
the winner per product (`services/productCatalog.js`):

1. **Routing is explicit, never guessed.** `data/productSupplierMap.json` maps each
   canonical product id (a ProdSeller id) to `{ prodseller, eklas, locked }`, and an
   entry always wins — no order is ever routed by matching names.
2. **Every Eklas product is listed too, with duplicates collapsed.** An Eklas item
   carrying the same name as a product already on the shelf becomes *that row's
   alternate* instead of a second row, so the shelf never shows the same thing twice;
   a unique Eklas item gets its own row under `eklas:<sku>`, and an item Eklas lists
   twice under one name appears once.
   **Hand-pinned example — Google Gemini:** the map links ProdSeller's
   `Gemini Pro 18Months (link)` (`6a31035939dc014325da2c66`) with Eklas'
   `Jio Gemini AI Pro 18m` (`9`) under **one** shelf row. ProdSeller is primary, so
   Gemini stays sourced there while it is the cheaper of the two (0.60 vs 0.94 USD
   as of writing) and the compare re-runs on every cache refresh; add
   `"locked": true` to the entry if it should never move to Eklas at all.
3. **Cheapest + in stock wins** (`PRODUCT_COMPARE_CACHE_SECONDS`, default 120 s);
   ties go to the primary supplier. The shopper still sees one PKR price.
4. **Fallback only where it is safe.** If the winner fails *before* any supplier
   order exists (`OUT_OF_STOCK`, `NOT_FOUND`, `INSUFFICIENT_BALANCE`, `AUTH`,
   `NOT_CONFIGURED`, `RATE_LIMITED`) checkout retries the other supplier
   automatically. Ambiguous failures (`NETWORK`, `UPSTREAM`, `BAD_REQUEST`) are
   **never** retried — that is how a double purchase is avoided. `"locked": true`
   entries never leave their supplier at all.
5. **Every order remembers its supplier** (`order.supplier` +
   `order.supplierOrderId`): the activation poller, retry, refunds, admin cards,
   dashboard and daily sync all follow that id back to the right API.
6. **Auth differs per supplier** — ProdSeller `X-API-Key` + `Idempotency-Key`
   header, Eklas `Authorization: Bearer` + `client_order_id` body field.

Admin surface: panel → 🛍️ Digital Store shows both balances and a `Source` line per
product (plus the alternate supplier and the saving), the dashboard has an Eklas
pill + balance card and a **Source** column, and each wallet pages the owner on its
own `PRODSELLER_LOW_BALANCE_USD` / `EKLAS_LOW_BALANCE_USD` threshold. Leave
`EKLAS_API_KEY` empty to run single-supplier exactly as before.

---

## WhatsApp Business Catalog (🏪 auto-post)

The bot keeps a **local catalogue** and mirrors it into the WhatsApp Business
catalogue, so the store is browsable right inside WhatsApp. The socket handed to
the service is the live Baileys connection (`setCatalogSocket` on open, cleared on
close), so pushes only ever run while WhatsApp is actually connected.

**Local truth — `catalog/`** (edit here, never in the WhatsApp Business app):

```
catalog/
├── catalog.json                  retailerId → WhatsApp product id + hash + sync state
└── products/<retailerId>/
    ├── product.json              name · description · price · currency · availability · image
    └── image.jpg                 the product picture (jpg/png/webp ≤ 5MB)
```

- `retailerId` is the stable slug (the folder name, sent as WhatsApp's
  `retailerId`) — that is what create / update / delete / sync all match on.
- `availability` is modelled locally: `in stock` → visible, anything else → hidden
  (the installed Baileys build transmits `isHidden`, not `availability`).
- **Nothing is marked synced until WhatsApp confirms it.** The index is written
  only *after* `productCreate` / `productUpdate` returns; a failed push stores
  `lastStatus: "error"` + `lastError` so the UI can show it, and an edit sets
  `pending` until the next successful push.
- Images are uploaded from the local file; when the picture did not change the
  stored `.whatsapp.net` URL is re-sent instead of re-uploading it.

**Admin surface — dashboard → 🏪 WhatsApp Catalog**: the list with its sync state
(`synced` / `pending` / `error` / `never`), Add / Edit (name, retailer id, price,
currency, availability, description, image upload), per-product **Push**,
**Delete** (always asks for confirmation — removes it from WhatsApp *and* the local
folder) and **Sync WhatsApp Catalog** (read WhatsApp → create what is missing →
update what changed, `CATALOG_SYNC_BATCH` products per run with
`CATALOG_SYNC_DELAY_MS` between mutations). Remote products we do not own are
reported as *remote-only* and are **never** deleted automatically.

**API** (token-auth, same rules as every other dashboard route):

| Route | Does |
|---|---|
| `GET /api/catalog` | connection state + every local product with its sync state |
| `POST /api/catalog` | create a local product (`push: true` also pushes it) |
| `PUT /api/catalog/:retailerId` | partial edit, e.g. `{"price": 250, "push": true}` |
| `DELETE /api/catalog/:retailerId?confirmed=1` | delete on WhatsApp + locally (confirmation required) |
| `POST /api/catalog/:retailerId/image` | multipart upload, field `image` (`?push=0` = store only) |
| `POST /api/catalog/sync` | `{dryRun, limit}` → `{created, updated, unchanged, failed, orphans}` (409 `SYNC_RUNNING` while a run is in flight) |
| `GET /api/catalog/sync/status` | live progress of the run: `{running, total, done, current, last, created, updated, unchanged, failed}` — the UI polls it every 0.7s while syncing |

Failures come back structured (`DISCONNECTED` / `AUTH_EXPIRED` / `RATE_LIMITED` /
`INVALID_IMAGE` / `INVALID_PRICE` / `CONFIRMATION_REQUIRED` / `PRODUCT_NOT_FOUND` /
`REPLY_MISSING_PRODUCT` / …)
with the matching HTTP status (503 / 429 / 400 / 409 / 404), and every push logs a
`[CATALOG]` or `[CATALOG ERROR]` line — credentials and session data are never logged.

If WhatsApp answers a write with a success IQ that carries no product data (a Baileys
`parseProductNode` crash — `reading 'attrs'`), the write is **verified on the catalogue
by retailerId** before anything is marked synced: found → the run continues normally,
missing → the product fails with an actionable `REPLY_MISSING_PRODUCT` and the raw reply
frame is written to the error log.

**Seed it** from the price list and product art you already have:

```bash
node scripts/seedCatalog.js          # products.txt + images/ → catalog/products/
node scripts/seedCatalog.js --force  # rebuild after a price change (WA ids are kept)
```

Tests: `test/wacatalog.test.js` (service behaviour against a mock socket) and
`test/wacatalog-api.test.js` (the HTTP routes + the dashboard tab).

---

## Sale codes (🎟️)

A launch deal code lives in `data/sales.json` and works on **both** catalogues.

- **Create** (panel → 🎟️ Sale Codes → ➕ New) or type `adm:salnew` style flow —
  the bot asks for `CODE, percent[, days[, maxUses]]`, e.g. `EID20, 20, 7, 100`
  (20% off, valid 7 days, first 100 checkouts).
- **Customer side**: on the payment screen they tap *🎟️ Sale code* → types the code →
  the discounted total (`PKR 550 − 110 → PKR 440`) is shown on the very next screen.
  *🎟️ <code> ✕* removes it. `back` returns to payment.
- Screenshot checkout **and** the one-tap wallet debit charge the discounted amount;
  one use is burned per new order (re-picking a payment method doesn't double-count).
- **Loyalty codes** (`LOYALTY_ORDERS` reward) keep working and stack under the same
  rule: a sale code wins at checkout, a loyalty code is consumed on delivery.
- Pause / resume / delete codes from the panel (or type the admin prompts directly).

---

## Customer Wallet (💰)

A prepaid PKR balance each customer can load **once** (the money is verified *at top-up
time*) and then spend in **one tap** — for both catalogues.

- **Top-up** 💰 *Add Money* → quick amount or custom (`WALLET_TOPUP_MIN`–`MAX`) → the
  existing payment flow with a separate **`WTP-XXXX`** reference → NayaPay verifier or
  admin *💰 Confirm Top-up*. Rate-limited per customer.
- **Pay** at the payment step: *💰 Pay from Wallet* → atomic debit → straight to the
  supplier call. **No screenshot, no verification wait.**
- **Shortfall** screen: not enough balance → *➕ Top Up X & Continue* resumes the exact
  checkout where it left off.
- **High-value guard**: orders above `CONFIRM_TWICE_ABOVE_PKR` debit the wallet but wait
  for one admin ✅ before the supplier is charged.
- **Refunds**: any post-payment failure credits the wallet instantly, with a receipt.
- **Safety rules** (`services/wallet.js`): one atomic `adjustBalance()` mutator, a balance
  can never go negative, every movement writes an immutable ledger row, `auditWallets()`
  proves *stored balance == ledger sum*, and the total liability is shown in Stats, the
  daily/weekly summaries and the dashboard.
- **Three separate pots of money**: customer wallet ≠ eSIMaccess balance ≠ ProdSeller
  USDT — each has its own alert threshold (`SUPPLIER_LOW_BALANCE_USD`,
  `PRODSELLER_LOW_BALANCE_USD`).

Admin panel → **💰 Wallet**: liability, wallet list, pending top-ups, per-customer
ledger, `±amount` adjustments (reason required) and a one-tap **Audit**.

---

## 💳 Binance Pay auto-verification (USDT)

A **separate payment method** (`pay_binancepay`, shown as *Binance Pay*) that verifies
itself against Binance instead of waiting for a screenshot. The older *Binance ID*
method (`PAYMENT_BINANCE_ID`) is untouched — customers can pick either.

**Customer side**

1. *Payment method* → **💳 Binance Pay** → they see
   `Pay exactly *5.00 USDT* to our Binance Pay ID: *9988…6655*` (PKR 1,500 ÷ `USDT_PKR_RATE`)
   and the progress line reads `Step 2 of 2: Binance Transaction ID`.
2. They pay in their Binance app, then **type the Transaction ID** (`M_P_71505104267788288`)
   back into the chat — the bot acknowledges instantly and checks in the **background**
   (the chat queue never waits on the API).
3. One ping at half the retry window, then a verdict: `✅ match`, amount/currency/window
   mismatch, already used, or timeout. The order goes to **pending_admin** the moment the
   ID arrives, so you can always act first.

**How the check works** (`services/binancePay.js` + `services/binanceVerifier.js`)

- Signed `GET /sapi/v1/pay/transactions` (HMAC-SHA256 over the **percent-encoded** query,
  read-only key, `recvWindow` + timestamp, `X-MBX-APIKEY` header).
- The endpoint has **no cursor**: pages are taken by sliding the window backwards
  (`MAX_PAGES` = 3), never re-scanning the same range.
- One retry on `429` honouring `Retry-After`, then a typed error (`AUTH` /
  `RATE_LIMITED` / `UPSTREAM` …) — it never throws into the chat flow.
- `classify()` is pure and strict: currency `USDT`, **incoming** amount, within
  `±0.01 USDT` of the quoted figure, inside `±BINANCE_MATCH_WINDOW_MIN` of *now*.
- **Replay protection**: every seen payment is cached in `db/binanceTransactions.json`
  and `claimTransaction()` is an atomic check+write — one Transaction ID can only ever be
  linked to **one** order, even if two customers paste the same one. Rejecting/cancelling
  an order releases the claim so the money can be reused.
- Retry loop: `BINANCE_RETRY_MS` (20 s) apart for up to `BINANCE_MAX_WAIT_MS` (5 min),
  with an injectable clock/sleep so the timing is unit-tested, not hoped for.

**Modes** — `BINANCE_VERIFIER_MODE`:

| Mode | What happens on a clean match |
|---|---|
| `off` | The method stops answering — the ID is saved and the admin card goes out with `mode_off` |
| **`shadow`** (default) | Match is claimed + **reported** on your card (`Shadow mode — match 5.00 USDT…`); **you** still press confirm |
| `auto` | Claimed + the order confirms **itself** (`confirmOrder` → supplier purchase / key delivery / wallet credit), then a `🤖 AUTO-VERIFIED` card |

> Recommended rollout: run `shadow` for a few days, read the reported matches in
> **💳 Payments** + `db/audit.json`, then switch to `auto`.

**Admin surfaces**

- Panel → **💳 Payments**: config health (masked key + Pay ID, mode), the cached rows with
  their claim state, a **🔄 Fetch Binance** button (`adm:btxrescan`) and the existing
  NayaPay inbox list underneath.
- Dashboard → **Payments** tab (`GET /api/payments`, `POST /api/payments/rescan`): the same
  status light + last 20 transactions; the rescan button is audited
  (`dashboard.binance_rescan`). Nothing else on the dashboard can move money.
- Order cards show `💳 Binance Pay: tx \`M_P_…\` · want *5.00 USDT @ 300 PKR*` plus
  `🤖 Verify: *match* … · mode: shadow` — the NayaPay auto-check line is not shown for
  these orders.

**Also works for wallet top-ups** — *➕ Add Money* → 💳 Binance Pay quotes the USDT figure
against the `WTP-XXXX` reference, and an `auto` match credits the ledger by itself.

**Security**

- Create the API key **read-only** ("Enable Reads" only). No withdrawal permission, ever.
- `BINANCE_API_SECRET` is used only for the HMAC and is never logged, echoed or rendered;
  displayed ids go through `maskId()` (`9988…6655`).
- The cache file is a local ledger (`BINANCE_TX_FILE`, default `db/binanceTransactions.json`)
  — treat it like the rest of `db/` (gitignored).

---

## 🧠 AI Payment Decision Engine (Part B)

The verifiers above already decide most payments. This layer sits **on top of them** and
only answers the one question code cannot: *"I have two free payments and no clear
winner — what should I tell the admin?"*

**Rule order (never inverted)**

1. Deterministic code decides first (`services/verifier.js` / `services/binanceVerifier.js`).
2. Hard invariants force the answer — no model may override them.
3. The model is consulted **only** when code says "I cannot tell".
4. Whatever the model answers, the invariants are re-checked.
5. Every decision is written to `db/aiDecisions.json` (last 500).

**The three invariants** (they appear verbatim in `prompts/paymentAnalyst.md`, in the
engine and in `test/ai.test.js`):

- A claimed transaction ID can never be re-claimed.
- Amount mismatch beyond tolerance always escalates.
- Code wins over a bad AI "approve" (downgrade to escalate + log discrepancy).

**Modes** — `AI_VERIFIER_MODE` (default `shadow`):

| Mode | Behaviour |
|---|---|
| `off` | Never call a model, never write a record — the bot behaves exactly as it did before. |
| `shadow` | Call + report on the admin card, **never** change an outcome. |
| `auto` | May act, but only when every invariant holds *and* the verdict came from the model (a fallback `escalate` can never act). |

**What actually reaches the model** — only `no_match` (screenshot) and `time_window`
(Binance) verdicts with something to reason about: a free-transaction candidate list, a
vision-read amount, or a submitted transaction id. `amount_mismatch`, `already_claimed`,
`currency_mismatch`, `outgoing` and `locked` are recorded as a forced `escalate`
(`source: code`) **without a single model call**, and a settled `match` is never
disturbed — even if vision read a different number.

**Vision** — `services/ai/gemini.js` reads the payment screenshot (amount / txn id /
merchant / date) so the analyst has real evidence. Without `GEMINI_API_KEY` the engine
carries no screenshot evidence and the deterministic check runs unchanged; there is no
offline OCR fallback in this repo.

**What you see** — every order card carries an extra line under the code's own:

```
🧠 AI (shadow · llama-3.3-70b-versatile): *escalate* 71% — two payments, no clear winner [ai_time_window]
```

`*` never appears for a case code already settled. The verdict and its flags also land in
`db/aiDecisions.json`, so a week later you can audit exactly what the model said — and
what the invariant did to it.

**Files**: `prompts/paymentAnalyst.md` (system prompt), `services/ai/groq.js` (analyst),
`services/ai/gemini.js` (vision), `services/ai/paymentDecisionEngine.js` (the rules),
`test/ai.test.js` (17 tests: the ambiguity gate, both downgrades, fallbacks, the log cap,
the card line).

---

## 🎁 Purple Cow layer (Part C)

Three things a competitor can copy in a week — and won't:

**⚡ Fast Guarantee** — `FAST_GUARANTEE_MINUTES` (default **15**) is said out loud and
backed with money:

- delivered inside the window → the delivery message carries
  `⚡ Fast Guarantee — delivered in 4 min (promised ≤ 15 min). ✅`
- past it → **`PKR 100` is credited to the customer's wallet automatically**
  (`FAST_GUARANTEE_CREDIT_PKR`), with one honest line about it. No support ticket, no
  asking, no mood.
- it settles **exactly once per order** (`order.guaranteeSettled`), goes through
  `services/wallet.js` (same ledger + audit as a top-up, `type: guarantee`, `actor:
  fast-guarantee`) and still credits even if the chat is in a do-not-disturb window.

**📦 Digital Unboxing** — a digital delivery has no box, so the bot opens one: three
short beats after the receipt and *before* the thank-you, each paced by
`services/pacing.js` (`sendNatural`), so the customer still lands on the thank-you +
review prompt. Respects the proactive-nudge gap exactly like the thank-you does, and
turns off with `UNBOXING_MODE=off`.

**🎁 Referral Loop** — every customer gets one stable code (`SF-XXXXX`, shown under
`🎁 Refer & Earn` on the main menu):

- a **new** customer types it → `REFERRAL_BONUS_PKR` (default **100**) lands in **both**
  wallets, on the same ledger as everything else
- fraud guards, all persisted in `db/referrals.json` so a restart can't forget them:
  1. **one credit per new phone** — an invitee is paid once, ever, and only before
     their first delivered order
  2. **no self-referral** — your own code does nothing
  3. **monthly cap** — `REFERRAL_MONTHLY_CAP` (default **1000**) of bonuses per
     referrer per calendar month
- the screen also hands over a ready-to-forward message with the code + link

| Var | Default | What it does |
|---|---|---|
| `FAST_GUARANTEE_MINUTES` | `15` | The promise. Inside = badge, past = automatic credit |
| `FAST_GUARANTEE_CREDIT_PKR` | `100` | Wallet credit for a missed promise (`0` = badge only) |
| `UNBOXING_MODE` | `on` | `off` disables the unboxing beats |
| `REFERRAL_BONUS_PKR` | `100` | Paid to **both** sides on a valid invite code |
| `REFERRAL_MONTHLY_CAP` | `1000` | Max bonuses one referrer can earn per month |

**Files**: `services/guarantee.js`, `services/unboxing.js`, `services/referral.js`,
`handlers/referral.js`, `test/purplecow.test.js` (14 tests: the verdict, the one-shot
credit, both copy variants, the beats, all three fraud guards, the menu row, the
no-dead-end code screen and the full delivery order).

**Deferred on purpose** (flagged, not built — they need an A/B test before they earn a
place in the code): surprise random bonuses, a bot mascot, and casual humor injected
into routine replies.

---

## Order Fulfillment Flow

How one order travels through the bot (both catalogues):

**eSIM** — pick plan → device gate → payment method → screenshot → order card to you →
`confirm SMF-XXXX` → stock check → eSIMaccess purchase (or `data/deliveries.json` in
manual mode) → receipt + QR → review prompt. A 15-minute reminder nudges both sides
until you act.

**Digital (instant)** — 🛍️ Digital Store → product (marked-up PKR) → payment method →
screenshot → `confirm` → ProdSeller order (idempotency-keyed) → **key(s) delivered in
chat** → fulfilled.

**Digital (email activation)** — same until payment → order parked as
`awaiting_supplier_funding` / `awaiting_activation` → the poll job watches ProdSeller →
keys delivered when the supplier finishes, **or** wallet refund + owner alert if it fails
or times out.

**Wallet-paid orders** skip the screenshot entirely: atomic debit → the same fulfilment
paths as above (high-value ones wait for your ✅ first).

---

## Delivering an eSIM manually (edit `data/deliveries.json`)

Used whenever supplier keys are absent (or as a per-order override). Lookup order:

1. `orders["SMF-XXXX"]` — a one-off payload for that exact order
2. `plans["<planId>"]` — e.g. `"plan_1gb"`
3. `default` — catch-all

```json
{
  "default": {
    "text": "…activation steps…",
    "image": null
  },
  "plans": {
    "plan_1gb": {
      "text": "1GB Activation Guide! 📲\n\n…Eskimo steps… 🔑 SA1GB …",
      "image": null
    },
    "plan_6gb": {
      "manual": true
    }
  },
  "orders": {}
}
```

- `manual: true` — **no automatic message**: the receipt card goes out, then the admin
  sends the details by hand (used for the 6GB / 10GB plans).

- `image` is an optional path (project-relative or absolute) to a QR / activation image.
  Set it to `null` to send text only.
- The file is **re-read on every delivery** — edit it live, no restart needed.

---

## Plan catalogue

All 4 plans live in [`data/plans.json`](data/plans.json) — **Telenor/Zong 4G,
no expiry, PKR pricing**. Edit prices or add plans there and the list menu
updates immediately (network/activation wording is read from the same file).

| # | Plan | Price | Delivery |
|---|---|---|---|
| 1 | Telenor/Zong 500MB | PKR 100 | auto guide (`SD55823`) |
| 2 | Telenor/Zong 1GB | PKR 230 | auto guide (`SA1GB`) |
| 3 | Telenor/Zong 6GB | PKR 1,500 | **manual** — admin sends details |
| 4 | Telenor/Zong 10GB | PKR 2,500 | **manual** — admin sends details |

The two guides live in [`data/deliveries.json`](data/deliveries.json)
(`plan_500mb` / `plan_1gb`); the big packs are flagged `"manual": true` so the
bot sends only the receipt and you deliver the details yourself.

---

## Plain-text fallback (older WhatsApp clients)

Some WhatsApp clients (older Android/iOS builds, WhatsApp Web on old browsers) do not
render native-flow buttons or lists. The bot handles this automatically:

1. **Send failures** — if the interactive send throws (client refused it, unsupported
   format), the message is re-sent as a numbered plain-text menu (`1️⃣ … 2️⃣ …`) with
   the same watermark.
2. **Auto-detection** — if a customer replies with a *number* or types a button's exact
   label instead of tapping, the bot marks that user as "needs plain menus" and sends
   every subsequent menu numbered. Any real tap switches them back to interactive.
3. **Escape hatch** — set `FORCE_PLAIN_TEXT=true` in `.env` to make plain text the
   default for everyone.

Either way the bot accepts **taps, numbers and typed words** for every choice, so the
flow never dead-ends.

---

## Project structure

```
simfly-bot/
├── index.js               connection, QR, event wiring, reconnect, shutdown flush
├── config.js              .env loading, brand, payments, suppliers, paths, UX settings
├── handlers/
│   ├── router.js          inbound message -> correct handler (human/resume/media gates)
│   ├── ui.js              withNav / withNavChoices / withListNav / withAck helpers
│   ├── menu.js            welcome, plans, plan detail, guide, support, orders, resume, language
│   ├── orders.js          checkout, reminders, confirm/reject, receipt, delivery, reorder
│   ├── payments.js        payment method + screenshot verification (withAck + ETA)
│   │                      + 💳 Binance Pay USDT flow (typed Transaction ID)
│   ├── checkout.js        ONE cart resolver: what is this customer buying right now?
│   ├── digitalStore.js    🛍️ store browse/search/detail, digital checkout + fulfilment
│   ├── wallet.js          💰 wallet home, top-ups, pay-from-wallet, refunds
│   ├── reviews.js         thank-you, loyalty line, star review flow, channel broadcast
│   ├── referral.js         🎁 Refer & Earn screen, share text, typed invite code
│   ├── human.js           🙋 Talk to Human handoff (ack + admin context + mirrored chat)
│   ├── notify.js          🔔 Notify Me, Alerts screen, price-drop toggle, unsubscribe
│   ├── admin.js           confirm / reject / status / orders / human reply / help / bot on
│   ├── adminPanel.js      in-WhatsApp panel: rows, order cards, stats, settings, dashboard
│   ├── adminDigital.js    🛍️ store admin: markup, visibility, refresh, balance
│   ├── adminWallet.js     💰 wallet admin: liability, adjustments, audit, customer ledgers
│   └── …                  adminPlans / adminTeam / adminBroadcast (panel sections)
├── services/
│   ├── esimaccess.js      eSIMaccess.com wrapper (stock, purchase, status, bulk cache)
│   ├── prodseller.js      ProdSeller wrapper (catalogue, balance, orders, idempotency)
│   ├── eklas.js           Eklas wrapper (Bearer auth, client_order_id, own caches)
│   ├── productCatalog.js  dual-supplier shelf: compare, routing, safe fallback checkout
│   ├── pacing.js          natural pacing: think time, per-chat queue, debounce, nudge gap
│   ├── digitalPolls.js    activation poll job (awaiting_activation → deliver/refund)
│   ├── wallet.js          atomic balance + ledger + audit + top-up rate limit
│   ├── verifier.js        NayaPay payment auto-verification (shadow / on)
│   ├── ai/groq.js         🧠 the analyst: one JSON verdict per ambiguous payment
│   ├── ai/gemini.js       🧠 vision: payment screenshot → amount / txn / merchant
│   ├── ai/paymentDecisionEngine.js  🧠 ambiguity gate + invariants + decision log
│   ├── guarantee.js        ⚡ Fast Guarantee: badge / automatic wallet credit
│   ├── unboxing.js         📦 the 3 paced "it landed" beats (before the thank-you)
│   ├── referral.js         🎁 invite codes + both-side credits + the 3 fraud guards
│   ├── binancePay.js      💳 signed Binance Pay client (/sapi/v1/pay/transactions)
│   ├── binanceVerifier.js claim ledger + classify() + retry loop (shadow/auto)
│   ├── adminAlerts.js     low-balance, pending, suspicious, daily/weekly summaries
│   ├── priceSync.js       daily catalogue refresh + diff + both supplier balances
│   ├── alertsJob.js       node-cron restock / price-drop watcher
│   └── catalogService.js  🏪 WhatsApp Catalog: catalog/ files + create/update/delete/sync
├── lib/
│   ├── ui.js              LIST + BUTTON senders w/ plain-text fallback & watermark
│   ├── message.js         message parsing + fuzzy choice matching (+ media types)
│   ├── plans.js           reads data/plans.json, builds list sections (sold-out rows)
│   ├── digital.js         PKR pricing/markup, per-product overrides, store sections
│   ├── store.js           lowdb persistence (users, orders, SMF + WTP sequences)
│   ├── sessions.js        resumable order sessions + human mode (db/sessions.json)
│   ├── users.js           per-customer profile: language, loyalty counter, discount
│   ├── alerts.js          alert subscriptions + stock/price snapshot (db/alerts.json)
│   ├── lang.js            t(key, vars, lang) — locales/ur.json + locales/en.json
│   ├── steps.js           ORDER_STEPS = 2 ("Step X of 2") + legacy id normalizeStep()
│   ├── reviews.js         review store (db/reviews.json)
│   ├── channel.js         WhatsApp Channel posting (review broadcasts)
│   ├── logger.js          pino -> logs/bot.log (order/admin/error events)
│   └── ratelimit.js       sliding-window limiter + menu cooldown
├── dashboard/
│   ├── server.js          bundled web dashboard (node:http, DASHBOARD_PORT) + /api/* routes
│   └── index.html         single-file UI: overview / orders / store / catalog / wallets / payments / audit
├── scripts/
│   ├── seedCatalog.js     products.txt + images/ → catalog/products/ (node scripts/seedCatalog.js)
│   ├── exportProducts.js  re-fetch both supplier price lists into products.txt
│   └── reformatProducts.js rewrite products.txt into the pipe layout
├── prompts/
│   └── paymentAnalyst.md   the system prompt (the three invariants live here)
├── locales/
│   ├── ur.json            Roman Urdu + English mix (default)
│   └── en.json            Full English
├── data/
│   ├── plans.json         the real eSIM catalogue (edit freely)
│   ├── deliveries.json    manual eSIM payloads sent on `confirm`
│   ├── digitalProductOverrides.json  per-product hide/rename/markup
│   └── productSupplierMap.json  canonical id → { prodseller, eklas, locked }
├── catalog/
│   ├── catalog.json       retailerId → WhatsApp product id + hash + sync state
│   └── products/<id>/     product.json + image.jpg per product (the local truth)
├── db/*.json              order / wallet / session / referral / aiDecision stores (lowdb, gitignored)
├── logs/bot.log           structured application log (gitignored)
├── assets/                QR / activation images
├── test/smoke.js          end-to-end flow test (npm test)
├── test/unit.test.js      unit tests (npm run test:unit)
├── test/checkout2.test.js two-step checkout: quantity, one-time gate, multi-unit confirm
├── test/ai.test.js       AI decision engine: invariants, fallbacks, log, card line
├── test/purplecow.test.js ⚡ guarantee + 📦 unboxing + 🎁 referral loop
├── test/digital.test.js   Digital Store tests (npm run test:features)
├── test/catalog.test.js   dual-supplier compare + fallback tests
├── test/pacing.test.js    natural pacing / queue / debounce / nudge-gap tests
├── test/sales.test.js     sales / promo code tests
├── test/wallet.test.js    Customer Wallet tests (npm run test:features)
├── test/store.test.js     one-list store, category sections, quantity → cart total, Gemini pin
├── test/binance.test.js   💳 Binance Pay: signing, classify, atomic claim, retry timing, shadow/auto
├── test/wacatalog.test.js 🏪 WhatsApp Catalog service: validation, push/sync, delete confirmation
├── test/wacatalog-api.test.js 🏪 dashboard /api/catalog routes + the catalog tab HTML
├── test/api-probe.js      offline interactive-message check (npm run probe)
├── auth_info/             WhatsApp session (created on first run, gitignored)
└── .env                   your secrets (never commit)
```

---

## Running it 24/7

**Local machine (Windows):**

```powershell
npm start
```

**Linux VPS (recommended):**

```bash
npm install
npm start
# or keep it alive across reboots:
npm install -g pm2
pm2 start index.js --name simfly-bot
pm2 save
pm2 startup
```

**Free-tier note:** most free PaaS containers sleep after inactivity, which drops the
WhatsApp socket. Reconnection is automatic on wake, but a container that stays awake
(you interact with it) behaves best.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `❌ Logged out (code 401)` | Delete the `auth_info/` folder and re-scan the QR. |
| QR never appears | Check your internet connection; WhatsApp Web must be reachable. |
| Buttons appear as plain text | Normal on some clients — see *Plain-text fallback*. Set `FORCE_PLAIN_TEXT=true` if you prefer. |
| No screenshots reach you | Set `ADMIN_WHATSAPP_NUMBER` in `.env` and restart. |
| "no payment method configured" | Fill in `PAYMENT_SADAPAY_*` / `PAYMENT_BINANCE_*` (at least one line each). |
| "eSIM Activation" text but no QR | You're in manual mode — add an entry for the plan/order in `data/deliveries.json`, or set `ESIMACCESS_*` keys. |
| `confirm` says purchase failed | Supplier error — check `logs/bot.log` and your `ESIMACCESS_*` credentials, then retry `confirm SMF-XXXX`. |
| Bot replies slowly / goes quiet | It is being rate-limited or WhatsApp is throttling the number. Slow down. |
| Session dies after a few days | WhatsApp periodically invalidates linked sessions — re-scan. |

---

## Compliance — how to talk about eSIMs

**Read this before you edit any customer-facing copy.**

Keep every customer-facing message about eSIMs **strictly factual**:

- Simfly eSIMs are **data-only travel/roaming plans** — *not* local SIM registrations.
- The distinction is technical: a data-only roaming profile does not require local
  device registration in the same way a physical local SIM card does.
- It does **not** change, affect or determine a device's legal/registration status.
  Never imply otherwise.
- **Never** describe this product with words like *"bypass"*, *"avoid"*, *"evade"*,
  *"get around"*, *"circumvent"* — or any phrasing about getting around PTA /
  device-registration / IMEI rules. Not in the bot, not in chat, not in marketing.
- Only **factory-unlocked** phones work. Carrier-locked devices must stop at the
  unlock check (the bot already enforces this) — don't tell customers otherwise.

Framing it as circumvention is a regulatory risk for the business **and** misleads
customers into thinking their device's registration status has changed, which it has not.

The copy in this repo is deliberately written to stay on the right side of that line —
if you touch `handlers/menu.js` (`sendHowEsim`) or `handlers/orders.js`
(`askUnlockCheck` / `handleUnlock`), keep it that way.

---

## Security notes

- `.env`, `auth_info/`, `db/orders.json` and `logs/` are **gitignored** — never commit
  them. `auth_info/` grants full control of the linked WhatsApp account.
- `db/orders.json` contains customer phone numbers. Treat it as personal data.
- Supplier keys are read only from `.env` — never hardcoded or logged.
- Anyone who can talk to your bot can drive the checkout flow — the admin commands are
  only honoured from `ADMIN_WHATSAPP_NUMBER`.

---

## License

MIT — but see the disclaimer at the top before putting it in front of real customers.
