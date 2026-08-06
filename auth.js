// lib/auth.js
//
// Admin authentication for the hidden Telegram Chat ID dashboard.
//
// The admin password is never stored in plaintext or in frontend code — it
// lives server-side as a bcrypt hash in the ADMIN_PASSWORD_HASH env var.
// See .env.example and README.md for how to generate that hash.
//
// Sessions are simple random tokens kept in memory (a Map) and handed to
// the browser as an httpOnly cookie. That means restarting the server logs
// admins out, which is a fine tradeoff for a low-traffic single-admin
// dashboard; swap in a persistent session store if you need otherwise.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const SESSION_COOKIE = 'admin_session';
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

const sessions = new Map(); // token -> expiresAt

function isConfigured() {
  return !!process.env.ADMIN_PASSWORD_HASH;
}

async function verifyPassword(password) {
  if (!isConfigured()) {
    console.error('[auth] ADMIN_PASSWORD_HASH is not set — admin login is disabled.');
    return false;
  }
  if (typeof password !== 'string' || !password) return false;
  return bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH);
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function destroySession(token) {
  sessions.delete(token);
}

function isValidSession(token) {
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    sessions.delete(token);
    return false;
  }
  return true;
}

// Periodically sweep expired sessions so the Map doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [token, expiresAt] of sessions) {
    if (now > expiresAt) sessions.delete(token);
  }
}, 15 * 60 * 1000).unref();

function requireAdmin(req, res, next) {
  const token = req.cookies && req.cookies[SESSION_COOKIE];
  if (!isValidSession(token)) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  next();
}

module.exports = {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  isConfigured,
  verifyPassword,
  createSession,
  destroySession,
  requireAdmin,
};
