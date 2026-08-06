// lib/store.js
//
// Very small JSON-file-backed data store.
//
// Why a JSON file instead of a database? This project is intentionally
// dependency-light. The important property the spec asks for is: the admin
// can change/remove a tour guide's Telegram Chat ID and it takes effect
// immediately, with NO code change and NO redeploy. A file on disk that the
// server reads/writes at runtime satisfies that.
//
// CAVEAT: if you deploy on a host with an ephemeral filesystem (e.g. most
// free-tier PaaS dynos that wipe local disk on every deploy/restart), this
// file's contents won't survive a redeploy. Mount a persistent volume, or
// swap this module for a real database (Postgres/SQLite/etc.) — the rest of
// the app only talks to the functions exported below, so that's a localized
// change.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TOURS_FILE = path.join(DATA_DIR, 'tours.json');
const BOOKINGS_FILE = path.join(DATA_DIR, 'bookings.json');

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    console.error(`[store] Failed to read ${file}:`, err.message);
    return fallback;
  }
}

// Writes are serialized behind a promise chain so concurrent requests can't
// interleave and corrupt the file. Writes go to a temp file then rename
// (atomic on POSIX), so a crash mid-write can't leave a half-written file.
let writeQueue = Promise.resolve();
function writeJsonAtomic(file, data) {
  writeQueue = writeQueue.then(() => new Promise((resolve, reject) => {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFile(tmp, JSON.stringify(data, null, 2), (err) => {
      if (err) return reject(err);
      fs.rename(tmp, file, (err2) => {
        if (err2) return reject(err2);
        resolve();
      });
    });
  })).catch((err) => {
    console.error(`[store] Failed to write ${file}:`, err.message);
  });
  return writeQueue;
}

// ---------------------------------------------------------------- Tours ---

function getTours() {
  return readJson(TOURS_FILE, []);
}

function getTourById(id) {
  return getTours().find((t) => t.id === id) || null;
}

async function setChatId(id, chatId) {
  const tours = getTours();
  const tour = tours.find((t) => t.id === id);
  if (!tour) return null;
  tour.chatId = chatId;
  await writeJsonAtomic(TOURS_FILE, tours);
  return tour;
}

async function removeChatId(id) {
  return setChatId(id, '');
}

function slugify(name) {
  const base = String(name || 'tour')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'tour';
  return base;
}

// Adds a brand-new tour (its own guide + Telegram chat id). The id is
// derived from the name, with a numeric suffix if that id is already taken.
async function addTour({ name, guideLabel, chatId }) {
  const tours = getTours();
  const base = slugify(name);
  let id = base;
  let n = 2;
  while (tours.some((t) => t.id === id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  const tour = {
    id,
    name: String(name).trim(),
    guideLabel: guideLabel ? String(guideLabel).trim() : String(name).trim(),
    chatId: chatId ? String(chatId).trim() : '',
  };
  tours.push(tour);
  await writeJsonAtomic(TOURS_FILE, tours);
  return tour;
}

// Deletes a tour entirely (not just its chat id). Existing bookings that
// reference this tour id are left untouched in bookings.json.
async function deleteTour(id) {
  const tours = getTours();
  const idx = tours.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  const [removed] = tours.splice(idx, 1);
  await writeJsonAtomic(TOURS_FILE, tours);
  return removed;
}

// -------------------------------------------------------------- Bookings --

function getBookings() {
  return readJson(BOOKINGS_FILE, []);
}

function getBookingById(id) {
  return getBookings().find((b) => b.id === id) || null;
}

function findRecentDuplicate(idempotencyKey, windowMs = 5 * 60 * 1000) {
  if (!idempotencyKey) return null;
  const cutoff = Date.now() - windowMs;
  return getBookings().find(
    (b) => b.idempotencyKey === idempotencyKey && new Date(b.createdAt).getTime() > cutoff
  ) || null;
}

async function saveBooking(booking) {
  const bookings = getBookings();
  bookings.push(booking);
  await writeJsonAtomic(BOOKINGS_FILE, bookings);
  return booking;
}

async function updateBooking(id, patch) {
  const bookings = getBookings();
  const idx = bookings.findIndex((b) => b.id === id);
  if (idx === -1) return null;
  bookings[idx] = { ...bookings[idx], ...patch };
  await writeJsonAtomic(BOOKINGS_FILE, bookings);
  return bookings[idx];
}

module.exports = {
  getTours,
  getTourById,
  setChatId,
  removeChatId,
  addTour,
  deleteTour,
  getBookings,
  getBookingById,
  findRecentDuplicate,
  saveBooking,
  updateBooking,
};
