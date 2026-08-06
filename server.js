// server.js
//
// Backend for the booking site. Responsibilities:
//   1. Accept a booking submission and notify the assigned tour guide on
//      Telegram (text message, formatted per spec).
//   2. Accept a payment receipt (image or PDF) and forward it to the same
//      Telegram chat, captioned with the booking details.
//   3. Provide a password-protected admin API for viewing/changing/removing
//      each tour's Telegram Chat ID, with changes taking effect immediately
//      and without a redeploy.
//
// The customer's browser never talks to Telegram directly and is never
// redirected to Telegram or WhatsApp — every Telegram API call happens
// here, server-side, using a bot token that is only ever read from the
// environment.

require('dotenv').config();

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const store = require('./lib/store');
const telegram = require('./lib/telegram');
const receipt = require('./lib/receipt');
const auth = require('./lib/auth');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const UPLOADS_DIR = path.join(__dirname, 'uploads');

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Static site (public/index.html = customer booking page,
// public/admin/dashboard.html = hidden admin dashboard — not linked from
// anywhere in the site's navigation).
app.use(express.static(path.join(__dirname, 'public')));

// -------------------------------------------------------------- Uploads --

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter(req, file, cb) {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error('UNSUPPORTED_FILE_TYPE'));
    }
    cb(null, true);
  },
});

// The main booking+receipt submission only ever takes an image (the
// visitor's payment screenshot) — no PDFs here.
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const EXT_BY_MIME = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

const uploadReceiptImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter(req, file, cb) {
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      return cb(new Error('UNSUPPORTED_FILE_TYPE'));
    }
    cb(null, true);
  },
});

// -------------------------------------------------------- rate limiting --

// Booking submissions: generous but bounded, to blunt basic spam/abuse.
const bookingLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many booking attempts. Please try again later.' },
});

// Admin login: tight, since it's the one thing guarding the dashboard.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' },
});

// Status polling: the confirmation page checks every ~4s while waiting on
// the guide, so this needs to be generous for a single visitor's session.
const statusLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 150,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again shortly.' },
});

// ------------------------------------------------------------- helpers --

function generateBookingId() {
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const randPart = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `BK-${datePart}-${randPart}`;
}

function formatTimestamp(date) {
  return date.toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  });
}

function inr(amount) {
  const n = Number(amount) || 0;
  return n.toLocaleString('en-IN');
}

// Builds the exact booking notification format requested.
function formatBookingMessage(b) {
  const services = (b.services && b.services.length ? b.services : ['Guide', 'Jeep', 'Activities', 'Food'])
    .map((s) => `• ${s}`)
    .join('\n');

  return [
    '📥 NEW BOOKING',
    '━━━━━━━━━━━━━━━━━━',
    `🆔 Booking ID: ${b.id}`,
    `🏞 Tour: ${b.tourName}`,
    `👤 Customer Name: ${b.name}`,
    `📱 Phone: ${b.phone || '-'}`,
    `📧 Email: ${b.email || '-'}`,
    `👥 Number of Persons: ${b.persons}`,
    `📅 Tour Date: ${b.date}`,
    '━━━━━━━━━━━━━━━━━━',
    'Selected Services',
    services,
    '━━━━━━━━━━━━━━━━━━',
    `💰 Total Amount: ₹${inr(b.total)}`,
    `✅ Amount Paid Now: ₹${inr(b.paidNow)}`,
    `⏳ Balance Due: ₹${inr(Math.max((Number(b.total) || 0) - (Number(b.paidNow) || 0), 0))}`,
    `💳 Payment Method: ${b.paymentMethod || '-'}`,
    `⏰ Booking Time: ${b.bookingTime}`,
  ].join('\n');
}

// Telegram photo captions are capped at 1024 characters.
function clampCaption(text) {
  return text.length > 1024 ? `${text.slice(0, 1000)}\n…` : text;
}

function formatReceiptCaption(b) {
  return [
    '📎 PAYMENT RECEIPT',
    `🆔 Booking ID: ${b.id}`,
    `🏞 Tour: ${b.tourName}`,
    `👤 Customer Name: ${b.name}`,
    `💰 Amount Paid Now: ₹${inr(b.paidNow)}`,
    `📅 Tour Date: ${b.date}`,
  ].join('\n');
}

function validateBookingInput(body) {
  const errors = [];
  const required = ['tourId', 'name', 'date', 'persons', 'total'];
  for (const field of required) {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      errors.push(`Missing field: ${field}`);
    }
  }
  if (body.persons !== undefined && (!Number.isFinite(Number(body.persons)) || Number(body.persons) <= 0)) {
    errors.push('persons must be a positive number');
  }
  if (body.total !== undefined && (!Number.isFinite(Number(body.total)) || Number(body.total) < 0)) {
    errors.push('total must be a non-negative number');
  }
  return errors;
}

// ----------------------------------------------------------- public API --

// Create a booking: accepts the booking details AND the payment receipt
// image together (multipart/form-data), and silently sends both to the
// assigned guide on Telegram as one message with Confirm/Cancel buttons.
app.post('/api/bookings', bookingLimiter, uploadReceiptImage.single('receipt'), async (req, res) => {
  const body = req.body || {};

  const errors = validateBookingInput(body);
  if (errors.length) {
    return res.status(400).json({ error: 'Invalid booking data.', details: errors });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'A payment receipt image is required.' });
  }

  const tour = store.getTourById(body.tourId);
  if (!tour) {
    return res.status(400).json({ error: 'Unknown tour.' });
  }

  // Idempotency: the frontend sends a per-form-session key so that a
  // double-tap on "Submit" (double click, slow network + retry, etc.)
  // doesn't create two bookings / send two Telegram notifications.
  const idempotencyKey = req.get('Idempotency-Key') || body.idempotencyKey || null;
  const existing = store.findRecentDuplicate(idempotencyKey);
  if (existing) {
    return res.status(200).json({ bookingId: existing.id, duplicate: true, status: existing.status });
  }

  let services;
  if (typeof body.services === 'string') {
    try { services = JSON.parse(body.services); } catch (_) { services = undefined; }
  } else if (Array.isArray(body.services)) {
    services = body.services;
  }

  const now = new Date();
  const bookingId = generateBookingId();
  const ext = EXT_BY_MIME[req.file.mimetype] || '.jpg';
  const receiptFilename = `${bookingId}${ext}`;

  const booking = {
    id: bookingId,
    idempotencyKey,
    tourId: tour.id,
    tourName: tour.name,
    name: String(body.name).trim(),
    phone: body.phone ? String(body.phone).trim() : '',
    email: body.email ? String(body.email).trim() : '',
    persons: Number(body.persons),
    date: String(body.date),
    camping: !!(body.camping === true || body.camping === 'true'),
    services: Array.isArray(services) ? services : undefined,
    total: Number(body.total),
    paidNow: Number(body.paidNow) || 0,
    paymentMethod: body.paymentMethod || '',
    bookingTime: formatTimestamp(now),
    createdAt: now.toISOString(),
    status: 'pending', // pending | confirmed | cancelled — driven live by the guide's Telegram button tap
    receiptFilename,
    notifySent: false,
  };

  try {
    await fsp.mkdir(UPLOADS_DIR, { recursive: true });
    await fsp.writeFile(path.join(UPLOADS_DIR, receiptFilename), req.file.buffer);
  } catch (err) {
    console.error(`[bookings] failed to save receipt for ${booking.id}:`, err.message);
    return res.status(500).json({ error: 'Could not save your receipt. Please try again.' });
  }

  await store.saveBooking(booking);

  try {
    const caption = clampCaption(formatBookingMessage(booking));
    const replyMarkup = {
      inline_keyboard: [[
        { text: '✅ Confirm Booking', callback_data: `confirm:${booking.id}` },
        { text: '❌ Cancel', callback_data: `cancel:${booking.id}` },
      ]],
    };
    const result = await telegram.sendPhoto(tour.chatId, req.file.buffer, receiptFilename, caption, replyMarkup);
    const telegramChatId = result && result.result && result.result.chat && result.result.chat.id;
    const telegramMessageId = result && result.result && result.result.message_id;
    await store.updateBooking(booking.id, { notifySent: true, telegramChatId, telegramMessageId });
  } catch (err) {
    // We deliberately do NOT fail the booking if the Telegram notification
    // fails — the customer's receipt is already safely saved. We log it so
    // staff can follow up, and the failure is visible in booking status.
    console.error(`[bookings] Telegram notify failed for ${booking.id}:`, err.message);
    await store.updateBooking(booking.id, { notifySent: false, notifyError: err.message });
  }

  res.status(201).json({ bookingId: booking.id, status: booking.status });
});

// Lightweight status check, polled by the confirmation page while it waits
// for the guide to confirm or cancel from Telegram.
app.get('/api/bookings/:id/status', statusLimiter, (req, res) => {
  const booking = store.getBookingById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });
  res.json({ bookingId: booking.id, status: booking.status });
});

// Generates and returns a fresh, booking-specific PDF receipt (Booking ID,
// submitted date/time, and the actual advance amount the visitor entered).
// Only ever available once the guide has confirmed the booking on
// Telegram — this is enforced here on the server, not just hidden in the
// UI, so the URL can't be used to see receipt details early.
app.get('/api/bookings/:id/receipt', async (req, res) => {
  const booking = store.getBookingById(req.params.id);
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found.' });
  }
  if (booking.status !== 'confirmed') {
    return res.status(403).json({ error: 'Receipt is available once your booking is confirmed by the guide.' });
  }

  try {
    const tour = store.getTourById(booking.tourId);
    const pdfBuffer = await receipt.generateReceiptPdf(booking, tour);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="receipt-${booking.id}.pdf"`,
      'Content-Length': pdfBuffer.length,
    });
    res.send(pdfBuffer);
  } catch (err) {
    console.error(`[receipt] failed to generate PDF for ${booking.id}:`, err.message);
    res.status(500).json({ error: 'Could not generate receipt. Please try again.' });
  }
});

// Lets the visitor download the raw receipt image they submitted as
// payment proof (kept around for the guide/admin's own reference — the
// customer-facing "Download Receipt" button now uses the generated PDF
// receipt above instead).
app.get('/api/bookings/:id/receipt-file', async (req, res) => {
  const booking = store.getBookingById(req.params.id);
  if (!booking || !booking.receiptFilename) {
    return res.status(404).json({ error: 'Receipt not found.' });
  }
  const filePath = path.join(UPLOADS_DIR, booking.receiptFilename);
  try {
    await fsp.access(filePath, fs.constants.R_OK);
  } catch (_) {
    return res.status(404).json({ error: 'Receipt file not found.' });
  }
  res.download(filePath, `receipt-${booking.id}${path.extname(booking.receiptFilename)}`);
});

// Telegram calls this when the guide taps Confirm/Cancel under the booking
// message. Protected by a shared secret Telegram sends back on every
// webhook request (see .env.example: TELEGRAM_WEBHOOK_SECRET).
app.post('/api/telegram/webhook', async (req, res) => {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expectedSecret) {
    console.warn('[telegram webhook] TELEGRAM_WEBHOOK_SECRET is not set — rejecting webhook call.');
    return res.status(501).end();
  }
  if (req.get('X-Telegram-Bot-Api-Secret-Token') !== expectedSecret) {
    return res.status(401).end();
  }

  // Always ack fast — Telegram doesn't need us to finish processing first.
  res.status(200).end();

  try {
    const callback = req.body && req.body.callback_query;
    if (!callback || typeof callback.data !== 'string') return;

    const [action, bookingId] = callback.data.split(':');
    if (action !== 'confirm' && action !== 'cancel') return;

    const booking = store.getBookingById(bookingId);
    if (!booking) {
      return telegram.answerCallbackQuery(callback.id, 'Booking not found.');
    }
    if (booking.status !== 'pending') {
      return telegram.answerCallbackQuery(callback.id, `Already ${booking.status}.`);
    }

    const newStatus = action === 'confirm' ? 'confirmed' : 'cancelled';
    await store.updateBooking(booking.id, { status: newStatus, decidedAt: new Date().toISOString() });

    await telegram.answerCallbackQuery(
      callback.id,
      action === 'confirm' ? 'Marked as confirmed ✅' : 'Marked as cancelled — visitor will see "waiting confirmation".'
    );

    const chatId = callback.message && callback.message.chat && callback.message.chat.id;
    const messageId = callback.message && callback.message.message_id;
    const decisionLine = action === 'confirm' ? '✅ CONFIRMED by guide' : '❌ CANCELLED by guide';
    const baseCaption = clampCaption(formatBookingMessage(booking));
    if (chatId && messageId) {
      await telegram.editMessageCaption(chatId, messageId, `${baseCaption}\n\n${decisionLine}`);
    }
  } catch (err) {
    console.error('[telegram webhook] error handling callback:', err.message);
  }
});

// Upload + forward a payment receipt for an existing booking. Kept for
// compatibility with the alternate in-site receipt-upload flow — the main
// booking page above now sends the receipt together with the booking, so
// this route is no longer used by it.
app.post('/api/bookings/:id/receipt', upload.single('receipt'), async (req, res) => {
  const booking = store.getBookingById(req.params.id);
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded, or file type/size was rejected.' });
  }

  const tour = store.getTourById(booking.tourId);
  const chatId = tour && tour.chatId;
  if (!chatId) {
    return res.status(503).json({
      error: 'This tour currently has no Telegram chat configured. Please contact us directly.',
    });
  }

  const caption = formatReceiptCaption(booking);
  const filename = req.file.originalname || 'receipt';

  try {
    if (req.file.mimetype === 'application/pdf') {
      await telegram.sendDocument(chatId, req.file.buffer, filename, caption);
    } else {
      await telegram.sendPhoto(chatId, req.file.buffer, filename, caption);
    }
  } catch (err) {
    console.error(`[receipt] Telegram send failed for ${booking.id}:`, err.message);
    return res.status(502).json({ error: 'Could not send the receipt right now. Please try again shortly.' });
  }

  await store.updateBooking(booking.id, { status: 'receipt_sent' });
  res.json({ success: true });
});

// Multer errors (bad file type / too large) land here.
app.use((err, req, res, next) => {
  if (err && err.message === 'UNSUPPORTED_FILE_TYPE') {
    return res.status(400).json({ error: 'Only JPG, PNG, WEBP, and PDF files are allowed.' });
  }
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'File is too large. Maximum size is 10 MB.' });
  }
  next(err);
});

// ------------------------------------------------------------ admin API --

app.post('/api/admin/login', loginLimiter, async (req, res) => {
  const { password } = req.body || {};
  const ok = await auth.verifyPassword(password);
  if (!ok) {
    return res.status(401).json({ error: 'Incorrect passcode.' });
  }
  const token = auth.createSession();
  res.cookie(auth.SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: IS_PROD,
    maxAge: auth.SESSION_TTL_MS,
  });
  res.json({ success: true });
});

app.post('/api/admin/logout', (req, res) => {
  const token = req.cookies && req.cookies[auth.SESSION_COOKIE];
  auth.destroySession(token);
  res.clearCookie(auth.SESSION_COOKIE);
  res.json({ success: true });
});

app.get('/api/admin/session', (req, res) => {
  const token = req.cookies && req.cookies[auth.SESSION_COOKIE];
  res.json({ authenticated: auth.isValidSession(token) });
});

// Tours + their chat IDs. This intentionally returns ONLY the chat id per
// tour — never the bot token, never bot settings, never message templates.
app.get('/api/admin/tours', auth.requireAdmin, (req, res) => {
  const tours = store.getTours().map((t) => ({
    id: t.id,
    name: t.name,
    guideLabel: t.guideLabel || t.name,
    chatId: t.chatId || '',
  }));
  res.json({ tours });
});

const CHAT_ID_PATTERN = /^-?\d{5,15}$/;

app.put('/api/admin/tours/:id/chatid', auth.requireAdmin, async (req, res) => {
  const { chatId } = req.body || {};
  if (typeof chatId !== 'string' || !CHAT_ID_PATTERN.test(chatId.trim())) {
    return res.status(400).json({ error: 'Chat ID must look like a Telegram chat id, e.g. -100123456789.' });
  }
  const updated = await store.setChatId(req.params.id, chatId.trim());
  if (!updated) return res.status(404).json({ error: 'Tour not found.' });
  res.json({ tour: updated });
});

app.delete('/api/admin/tours/:id/chatid', auth.requireAdmin, async (req, res) => {
  const updated = await store.removeChatId(req.params.id);
  if (!updated) return res.status(404).json({ error: 'Tour not found.' });
  res.json({ tour: updated });
});

// Add a brand-new tour (its own guide + Telegram chat id). Chat id is
// optional at creation time — it can be filled in afterwards from the same
// dashboard, same as any other tour.
app.post('/api/admin/tours', auth.requireAdmin, async (req, res) => {
  const { name, guideLabel, chatId } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Tour name is required.' });
  }
  if (chatId && (typeof chatId !== 'string' || !CHAT_ID_PATTERN.test(chatId.trim()))) {
    return res.status(400).json({ error: 'Chat ID must look like a Telegram chat id, e.g. -100123456789.' });
  }
  const tour = await store.addTour({ name, guideLabel, chatId });
  res.status(201).json({ tour });
});

// Delete a tour entirely. This does not touch past bookings — it only
// stops the tour from being selectable/notified going forward.
app.delete('/api/admin/tours/:id', auth.requireAdmin, async (req, res) => {
  const removed = await store.deleteTour(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Tour not found.' });
  res.json({ success: true });
});

// ------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`Booking server listening on port ${PORT}`);
  if (!auth.isConfigured()) {
    console.warn('[startup] ADMIN_PASSWORD_HASH is not set — the admin dashboard cannot be logged into yet.');
  }

  // Registers the Telegram webhook (for the guide's Confirm/Cancel button
  // taps) against this deployment's public URL. Safe to run on every boot.
  const publicUrl = process.env.PUBLIC_URL;
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (publicUrl && webhookSecret) {
    telegram.setWebhook(publicUrl, webhookSecret)
      .then(() => console.log(`[startup] Telegram webhook registered at ${publicUrl}/api/telegram/webhook`))
      .catch((err) => console.warn('[startup] Could not register Telegram webhook:', err.message));
  } else {
    console.warn(
      '[startup] PUBLIC_URL and/or TELEGRAM_WEBHOOK_SECRET not set — the guide\'s ' +
      'Confirm/Cancel buttons in Telegram will not work until both are configured. See .env.example.'
    );
  }
});
