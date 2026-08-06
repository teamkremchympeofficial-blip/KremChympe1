# Book Adventure With US — WhatsApp + Live Telegram Confirmation

Visitors book on the site, pay, and upload their payment screenshot right
there. Tapping **Submit** silently sends the full booking (name, contact,
date, package, amount paid, balance) *and* the receipt image to the tour
guide on Telegram — with **Confirm / Cancel** buttons attached to that
message. Whatever the guide taps updates the visitor's screen automatically,
live, with no refresh needed. A **Chat with Tour Guide on WhatsApp** button
appears on the same screen once the receipt has been submitted.

## What's in here

```
public/index.html            Customer-facing booking site (WhatsApp-branded UI)
public/admin/dashboard.html  Hidden admin dashboard (add/edit/remove tours + chat IDs)
server.js                    Express backend + Telegram Bot API integration
lib/telegram.js              sendMessage / sendPhoto / editMessageCaption / webhook helpers
lib/store.js                 JSON-file store for tours (chat IDs) + bookings
lib/auth.js                  Admin login/session handling
data/tours.json              Tour list + assigned Telegram chat IDs (edited at runtime)
data/bookings.json           Booking log incl. live status (created/updated at runtime)
uploads/                     Saved payment receipt images (git-ignored, kept on disk)
scripts/hash-password.js     CLI helper to generate the admin passcode hash
```

**Important:** this needs to run on a Node.js server (e.g. Render, which you're
already using) — it can't be hosted as a static site, because the Bot Token
must stay server-side and Telegram needs a real HTTPS endpoint to call back
into.

## 1. Install

```bash
npm install
```

## 2. Get a Telegram Bot Token

Message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`,
follow the prompts. You'll get a **Bot Token** — keep it secret.

## 3. Configure environment variables

On Render (Dashboard → your service → Environment), set:

| Variable | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | from BotFather |
| `ADMIN_PASSWORD_HASH` | run `npm run hash-password -- "your passcode"` locally and paste the output |
| `NODE_ENV` | `production` |
| `PUBLIC_URL` | your Render URL, e.g. `https://your-app.onrender.com` |
| `TELEGRAM_WEBHOOK_SECRET` | any random string, e.g. output of `openssl rand -hex 24` |

`PUBLIC_URL` + `TELEGRAM_WEBHOOK_SECRET` are what make the guide's
Confirm/Cancel buttons work — on every boot the server registers itself with
Telegram at `<PUBLIC_URL>/api/telegram/webhook`, so there's no manual step
after that; just redeploy once these are set.

Locally, copy `.env.example` to `.env` and fill in the same values instead.

## 4. Set each tour's Chat ID

Add the bot to the guide's chat (or a group chat), send any message, then
open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser and
read the `chat.id` field. Group chat IDs are negative numbers (e.g.
`-100123456789`). Set it from the admin dashboard (see below) — no redeploy
needed.

## 5. Hidden Admin Dashboard

Go to `/admin/dashboard.html` (not linked from the site — bookmark or share
the URL directly with whoever manages chat IDs). Log in with the passcode
you hashed in step 3.

From there the admin can:
- View, ✏️ change, or 🗑 remove any tour's Telegram Chat ID — takes effect
  on the very next booking, no redeploy
- **+ Add New Tour** — add a brand-new tour with its own guide/chat ID
- **Delete Tour** — remove a tour entirely (past bookings are unaffected)

The dashboard **cannot** view or edit the Bot Token, bot username, API
settings, or message templates — those only exist in `.env` and
`server.js`/`lib/telegram.js` on the server.

## How a booking flows

1. Visitor fills the form, picks a payment method, enters the amount paid,
   and **uploads their payment receipt screenshot** (JPG/PNG/WEBP, max 10 MB).
2. Tapping **Submit** sends everything — booking details + receipt — to the
   backend in one request. The backend saves the receipt, generates a
   Booking ID, and sends it all to the assigned guide's Telegram chat as a
   photo with a caption (full breakdown: name, contact, date, package,
   total, paid, balance) and two buttons: **✅ Confirm Booking** / **❌ Cancel**.
3. The visitor is shown a "⏳ Waiting Confirmation" screen immediately —
   this never waits on the guide. The **Chat with Tour Guide on WhatsApp**
   button appears here too.
4. The moment the guide taps a button in Telegram, the visitor's screen
   updates automatically (polling every ~4s): **Confirm** → "✅ Booking
   Confirmed" plus a **Download Receipt** link; **Cancel** → the screen goes
   back to "Waiting Confirmation" so the guide can ask for a corrected
   receipt without the visitor needing to do anything on their end.

## Security notes

- The Bot Token is read only from `process.env.TELEGRAM_BOT_TOKEN` and is
  never included in any API response or frontend file.
- The `/api/telegram/webhook` endpoint only accepts calls carrying the exact
  `TELEGRAM_WEBHOOK_SECRET`, which Telegram echoes back on every real
  webhook request — anything else gets a 401.
- The admin passcode is stored as a bcrypt hash; sessions are httpOnly
  cookies, and login attempts are rate-limited.
- Uploaded receipts are validated by MIME type (JPG/PNG/WEBP only) and size
  (≤10 MB) before being saved and forwarded to Telegram.
- Booking submissions carry an idempotency key from the browser so a
  double-tap on Submit can't create duplicate bookings/notifications.
- Failed Telegram sends are retried with backoff and logged to the server
  console; a notification failure never blocks the receipt from being saved.

## Persistence caveat

`data/tours.json`, `data/bookings.json`, and everything under `uploads/` are
plain files on disk. If you deploy somewhere with an **ephemeral
filesystem** that wipes local files on every restart/redeploy (this
includes Render's free tier disk), attach a persistent disk to the app, or
swap `lib/store.js` (and the upload path in `server.js`) for real storage —
nothing else in the app needs to change.
