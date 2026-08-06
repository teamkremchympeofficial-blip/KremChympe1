# Book Adventure With US — Telegram Bot Edition

WhatsApp has been fully removed. Booking notifications and payment receipts
are now sent through a Telegram Bot from the backend. Customers are never
redirected to Telegram or WhatsApp — everything happens silently server-side.

## What's in here

```
public/index.html          Customer-facing booking site (same design/pricing/UI)
public/admin/dashboard.html Hidden admin dashboard (not linked anywhere in the nav)
server.js                  Express backend + Telegram Bot API integration
lib/telegram.js            sendMessage / sendPhoto / sendDocument wrapper
lib/store.js                JSON-file store for tours (chat IDs) + bookings
lib/auth.js                 Admin login/session handling
data/tours.json             Tour list + assigned Telegram chat IDs (edited at runtime)
data/bookings.json          Booking log (created/updated at runtime)
scripts/hash-password.js    CLI helper to generate the admin passcode hash
```

**Important:** this needs to run on a Node.js server — it can't be hosted as
a static site (GitHub Pages, plain S3, etc.), because the Bot Token must
stay server-side and the admin dashboard needs a backend to authenticate
against. Any Node host works (Render, Railway, Fly.io, a VPS, etc.).

## 1. Install

```bash
npm install
```

## 2. Get a Telegram Bot Token

Message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`,
follow the prompts. You'll get a **Bot Token** — keep it secret.

## 3. Run setup and start

```bash
npm run setup
```

It'll ask you to paste the bot token and choose an admin passcode, then
writes `.env` for you automatically (including hashing the passcode — the
plaintext is never stored). Then:

```bash
npm start
```

Visit `http://localhost:3000` for the booking site.

*(If you'd rather edit `.env` by hand instead of using the prompt, copy
`.env.example` to `.env` and fill it in yourself — `npm run hash-password --
"your passcode"` generates just the passcode hash if you need it standalone.)*

## 4. Set each tour's Chat ID

Add the bot to the guide's chat (or a group chat), send any message, then
open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser and
read the `chat.id` field. Group chat IDs are negative numbers (e.g.
`-100123456789`). Set it either by editing `data/tours.json` directly, or
from the admin dashboard once the server is running (see below) — no
redeploy needed either way.

## 5. Hidden Admin Dashboard

Go to `/admin/dashboard.html` (not linked from the site — bookmark or share
the URL directly with whoever manages chat IDs). Log in with the passcode
you hashed in step 3.

From there the admin can, per tour:
- View the current Telegram Chat ID
- ✏️ Change it — future bookings for that tour go to the new chat immediately
- 🗑 Remove it — future bookings for that tour stop being sent to Telegram
  until a new Chat ID is added (existing bookings/history are untouched)

The dashboard **cannot** view or edit the Bot Token, bot username, API
settings, or message templates — those only exist in `.env` and
`server.js`/`lib/telegram.js` on the server.

## How a booking flows

1. Customer fills out the existing form and submits → the backend saves the
   booking, generates a Booking ID, and sends a formatted text notification
   to the assigned tour's Telegram chat via `sendMessage`. Nothing opens on
   the customer's device.
2. Customer uploads a payment receipt (JPG/PNG/WEBP/PDF, max 10 MB) and
   taps **Confirm Payment** → the backend forwards it to the same Telegram
   chat via `sendPhoto` (images) or `sendDocument` (PDF), captioned with the
   booking details and Booking ID.
3. The customer sees "✅ Booking Submitted Successfully" and then
   "✅ Payment Receipt Sent Successfully" — no Telegram app ever opens for
   them.

## Security notes

- The Bot Token is read only from `process.env.TELEGRAM_BOT_TOKEN` inside
  `lib/telegram.js` and is never included in any API response or frontend
  file.
- The admin passcode is stored as a bcrypt hash; sessions are httpOnly
  cookies, and login attempts are rate-limited.
- Uploaded receipts are validated by MIME type (JPG/PNG/WEBP/PDF only) and
  size (≤10 MB) before being forwarded to Telegram.
- Booking submissions carry an idempotency key from the browser so a
  double-tap on Submit can't create duplicate bookings/notifications.
- Failed Telegram sends are retried with backoff and logged to the server
  console; a notification failure never blocks the customer's booking from
  being recorded.

## Persistence caveat

`data/tours.json` and `data/bookings.json` are plain files on disk, which is
what lets the admin dashboard change a Chat ID with zero redeploys. If you
deploy somewhere with an **ephemeral filesystem** that wipes local files on
every restart/deploy (common on some free hosting tiers), attach a
persistent volume/disk to the `data/` folder, or swap `lib/store.js` for a
real database — nothing else in the app needs to change.
