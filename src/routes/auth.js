require('dotenv').config();
const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const https   = require('https');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');

const JWT_SECRET = process.env.JWT_SECRET || 'reviewrise-secret-key-change-in-prod';
const sign = (u) => jwt.sign({ id:u.id, email:u.email, role:u.role, name:u.name }, JWT_SECRET, { expiresIn:'30d' });

// Helper: fetch URL as JSON
const fetchJSON = (url, headers={}) => new Promise((resolve, reject) => {
  https.get(url, { headers }, (r) => {
    let d = ''; r.on('data', c => d += c);
    r.on('end', () => { try { resolve(JSON.parse(d)) } catch(e) { reject(e) } });
  }).on('error', reject);
});

// Upsert Google user in DB
const upsertGoogleUser = async (name, email, avatar) => {
  const r = await query(`
    INSERT INTO users (name, email, avatar_url, role, points)
    VALUES ($1, LOWER($2), $3, 'customer', 0)
    ON CONFLICT (email) DO UPDATE SET
      name=EXCLUDED.name, avatar_url=EXCLUDED.avatar_url, updated_at=NOW()
    RETURNING *
  `, [name || email.split('@')[0], email, avatar || '']);
  return r.rows[0];
};

// ── GET /api/auth/me ──────────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  try {
    const r = await query('SELECT id,name,email,role,avatar_url,points FROM users WHERE id=$1',[req.user.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/auth/login — email/password ─────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const r = await query('SELECT * FROM users WHERE LOWER(email)=LOWER($1)', [email.trim()]);
    const u = r.rows[0];
    if (!u)          return res.status(401).json({ error: 'No account found with this email' });
    if (u.role === 'customer') return res.status(403).json({ error: 'Customers use Google login (scan QR code)' });
    if (!u.password_hash)      return res.status(401).json({ error: 'Password not set. Contact admin.' });
    if (!await bcrypt.compare(password, u.password_hash)) return res.status(401).json({ error: 'Wrong password' });

    let brand = null;
    if (u.role === 'brand_owner') {
      const br = await query('SELECT * FROM brands WHERE owner_id=$1',[u.id]);
      brand = br.rows[0] || null;
    }
    res.json({ token: sign(u), user: { id:u.id, name:u.name, email:u.email, role:u.role, avatar_url:u.avatar_url }, brand });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/auth/google — OAuth2 access_token flow ─────────
router.post('/google', async (req, res) => {
  try {
    const { token, user_info } = req.body;
    if (!token && !user_info) return res.status(400).json({ error: 'Token required' });
    let gUser = user_info;
    if (!gUser) {
      gUser = await fetchJSON('https://www.googleapis.com/oauth2/v3/userinfo', { Authorization: `Bearer ${token}` });
    }
    if (!gUser?.email) return res.status(401).json({ error: 'Could not get email from Google' });
    const u = await upsertGoogleUser(gUser.name, gUser.email, gUser.picture);
    res.json({ token: sign(u), user: { id:u.id, name:u.name, email:u.email, role:u.role, avatar_url:u.avatar_url, points:u.points } });
  } catch(e) { console.error('Google auth:', e.message); res.status(500).json({ error: 'Google auth failed: ' + e.message }); }
});

// ── POST /api/auth/google-id-token — One Tap JWT flow ────────
// Google One Tap sends a signed JWT (id_token) instead of access_token
router.post('/google-id-token', async (req, res) => {
  try {
    const { id_token } = req.body;
    if (!id_token) return res.status(400).json({ error: 'id_token required' });

    // Decode the JWT payload (Google signs it — we verify via Google's endpoint)
    const parts = id_token.split('.');
    if (parts.length !== 3) return res.status(400).json({ error: 'Invalid JWT format' });
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));

    if (!payload.email) return res.status(401).json({ error: 'No email in token' });

    // Verify token with Google tokeninfo endpoint
    const info = await fetchJSON(`https://oauth2.googleapis.com/tokeninfo?id_token=${id_token}`);
    if (info.error) return res.status(401).json({ error: 'Invalid Google token: ' + info.error });

    const u = await upsertGoogleUser(info.name || payload.name, info.email || payload.email, info.picture || payload.picture);
    res.json({ token: sign(u), user: { id:u.id, name:u.name, email:u.email, role:u.role, avatar_url:u.avatar_url, points:u.points } });
  } catch(e) { console.error('ID token auth:', e.message); res.status(500).json({ error: 'Google ID token auth failed: ' + e.message }); }
});

// ── POST /api/auth/register-brand ────────────────────────────
router.post('/register-brand', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Super admin only' });
    const { name, email, password, brand_id } = req.body;
    if (!name||!email||!password) return res.status(400).json({ error: 'name, email, password required' });
    const hash = await bcrypt.hash(password, 10);
    const r = await query(`INSERT INTO users (name,email,password_hash,role) VALUES($1,LOWER($2),$3,'brand_owner') ON CONFLICT(email) DO UPDATE SET password_hash=EXCLUDED.password_hash RETURNING *`,[name,email.trim(),hash]);
    if (brand_id) await query('UPDATE brands SET owner_id=$1 WHERE id=$2',[r.rows[0].id, brand_id]);
    res.status(201).json({ success:true, user:{ id:r.rows[0].id, name:r.rows[0].name, email:r.rows[0].email } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
