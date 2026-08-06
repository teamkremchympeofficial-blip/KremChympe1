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

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const store = require('./lib/store');
const telegram = require('./lib/telegram');
const auth = require('./lib/auth');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

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
    `🏕 Camping: ${b.camping ? 'Yes' : 'No'}`,
    '━━━━━━━━━━━━━━━━━━',
    'Selected Services',
    services,
    '━━━━━━━━━━━━━━━━━━',
    `💰 Total Amount: ₹${inr(b.total)}`,
    `⏰ Booking Time: ${b.bookingTime}`,
    '',
    'Payment Status:',
    '🟡 Awaiting Payment Receipt',
  ].join('\n');
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

// Create a booking and silently notify the assigned guide on Telegram.
app.post('/api/bookings', bookingLimiter, async (req, res) => {
  const body = req.body || {};

  const errors = validateBookingInput(body);
  if (errors.length) {
    return res.status(400).json({ error: 'Invalid booking data.', details: errors });
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
    return res.status(200).json({ bookingId: existing.id, duplicate: true });
  }

  const now = new Date();
  const booking = {
    id: generateBookingId(),
    idempotencyKey,
    tourId: tour.id,
    tourName: tour.name,
    name: String(body.name).trim(),
    phone: body.phone ? String(body.phone).trim() : '',
    email: body.email ? String(body.email).trim() : '',
    persons: Number(body.persons),
    date: String(body.date),
    camping: !!body.camping,
    services: Array.isArray(body.services) ? body.services : undefined,
    total: Number(body.total),
    paidNow: Number(body.paidNow) || 0,
    paymentMethod: body.paymentMethod || '',
    bookingTime: formatTimestamp(now),
    createdAt: now.toISOString(),
    status: 'awaiting_receipt',
    notifySent: false,
  };

  await store.saveBooking(booking);

  try {
    await telegram.sendMessage(tour.chatId, formatBookingMessage(booking));
    await store.updateBooking(booking.id, { notifySent: true });
  } catch (err) {
    // We deliberately do NOT fail the booking if the Telegram notification
    // fails — the customer already has a valid booking. We log it so staff
    // can follow up, and the failure is visible in booking status.
    console.error(`[bookings] Telegram notify failed for ${booking.id}:`, err.message);
    await store.updateBooking(booking.id, { notifySent: false, notifyError: err.message });
  }

  res.status(201).json({ bookingId: booking.id });
});

// Upload + forward a payment receipt for an existing booking.
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

// ------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`Booking server listening on port ${PORT}`);
  if (!auth.isConfigured()) {
    console.warn('[startup] ADMIN_PASSWORD_HASH is not set — the admin dashboard cannot be logged into yet.');
  }
});
