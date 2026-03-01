require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const morgan  = require('morgan');
const { query } = require('./db');

const app = express();
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(morgan('dev'));

// ── Auto-patch DB schema on startup ────────────────────────────
// Safely adds any columns missing from the production database
(async () => {
  const patches = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS points INTEGER DEFAULT 0`,
    `ALTER TABLE brands ADD COLUMN IF NOT EXISTS gmb_access_token TEXT`,
    `ALTER TABLE brands ADD COLUMN IF NOT EXISTS gmb_refresh_token TEXT`,
    `ALTER TABLE brands ADD COLUMN IF NOT EXISTS gmb_account_id VARCHAR(255)`,
    `ALTER TABLE brands ADD COLUMN IF NOT EXISTS gmb_location_id VARCHAR(255)`,
    `ALTER TABLE brands ADD COLUMN IF NOT EXISTS owner_name VARCHAR(255)`,
    `ALTER TABLE brands ADD COLUMN IF NOT EXISTS owner_email VARCHAR(255)`,
    `ALTER TABLE brands ADD COLUMN IF NOT EXISTS owner_phone VARCHAR(20)`,
    `ALTER TABLE verification_sessions ADD COLUMN IF NOT EXISTS stars_detected INTEGER`,
    `ALTER TABLE verification_sessions ADD COLUMN IF NOT EXISTS poll_count INTEGER DEFAULT 0`,
  ];
  for (const sql of patches) {
    try { await query(sql) } catch(e) { /* ignore — column exists or table not yet created */ }
  }
  console.log('✅ DB schema auto-patched');

  // ── Ensure superadmin account always exists with password ──
  // Runs on every startup — safe, uses ON CONFLICT DO NOTHING for create
  // then explicitly sets password_hash if it's NULL (the bug we're fixing)
  try {
    const bcrypt = require('bcryptjs');
    const ADMIN_EMAIL    = (process.env.SUPERADMIN_EMAIL    || 'admin@softcraftsolutions.in').toLowerCase().trim();
    const ADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD  || 'Admin@123';
    const ADMIN_NAME     = 'SoftCraft Admin';
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);

    // Create if doesn't exist
    await query(`
      INSERT INTO users (name, email, password_hash, role)
      VALUES ($1, $2, $3, 'superadmin')
      ON CONFLICT (email) DO NOTHING
    `, [ADMIN_NAME, ADMIN_EMAIL, hash]);

    // Always fix NULL password_hash for superadmin (the actual bug)
    const updated = await query(`
      UPDATE users
      SET password_hash = $1, name = $2, updated_at = NOW()
      WHERE LOWER(email) = $3
        AND role = 'superadmin'
        AND (password_hash IS NULL OR password_hash = '')
      RETURNING id, email
    `, [hash, ADMIN_NAME, ADMIN_EMAIL]);

    if (updated.rows.length > 0) {
      console.log('✅ Superadmin password_hash was NULL — fixed for:', updated.rows[0].email);
    } else {
      console.log('✅ Superadmin account OK:', ADMIN_EMAIL);
    }
  } catch(e) {
    console.error('❌ Superadmin seed error:', e.message);
  }
})();

// ── Health ─────────────────────────────────────────────────────
app.get('/health', (req, res) =>
  res.json({ status: 'ok', service: 'ReviewRise API', v: '11.2', time: new Date().toISOString() })
);

// ── RESET ALL — BEFORE all routers ────────────────────────────
app.post('/api/admin/reset-all', async (req, res) => {
  try {
    const { secret } = req.body || {};
    if (secret !== (process.env.RESET_SECRET || 'softcraft-reset-2024')) {
      return res.status(403).json({ error: 'Wrong secret' });
    }
    const tables = [
      'ad_views','qr_scans','verification_sessions','coupons',
      'private_feedback','reviews','brand_visits','qr_codes',
      'banners','ads','brands'
    ];
    for (const t of tables) {
      try { await query(`DELETE FROM ${t}`) } catch(e) { console.warn('skip', t, e.message) }
    }
    try { await query(`DELETE FROM users WHERE role != 'superadmin'`) } catch(e) {}
    console.log('✅ Reset all complete');
    res.json({ success: true, message: 'All data wiped. Super admin kept.' });
  } catch(e) {
    console.error('Reset error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Emergency: fix superadmin password via HTTP (secret required) ───
app.post('/api/admin/fix-superadmin', async (req, res) => {
  try {
    const { secret, password } = req.body || {}
    if (secret !== (process.env.RESET_SECRET || 'softcraft-reset-2024'))
      return res.status(403).json({ error: 'Wrong secret' })
    const bcrypt = require('bcryptjs')
    const newPass = password || process.env.SUPERADMIN_PASSWORD || 'Admin@123'
    const email   = (process.env.SUPERADMIN_EMAIL || 'admin@softcraftsolutions.in').toLowerCase()
    const hash    = await bcrypt.hash(newPass, 10)
    const r = await query(
      `UPDATE users SET password_hash=$1, updated_at=NOW() WHERE LOWER(email)=$2 AND role='superadmin' RETURNING id,email`,
      [hash, email]
    )
    if (!r.rows[0]) return res.status(404).json({ error: 'Superadmin not found', email })
    res.json({ success: true, email: r.rows[0].email, message: 'Password updated. Login with: ' + newPass })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Debug: verify token → confirm user exists ─────────────────
app.get('/api/debug/me', async (req, res) => {
  try {
    const header = req.headers.authorization || ''
    if (!header.startsWith('Bearer ')) return res.status(400).json({ error: 'Pass Authorization: Bearer <token>' })
    const jwt     = require('jsonwebtoken')
    const decoded = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET)
    const userId  = decoded.id || decoded.userId
    const r = await query('SELECT id,email,name,role FROM users WHERE id=$1', [userId])
    res.json({ decoded_id: userId, user: r.rows[0] || null, found: !!r.rows[0] })
  } catch(e) { res.status(401).json({ error: e.message }) }
})

// ── API Routers ────────────────────────────────────────────────
app.use('/api/auth',    require('./routes/auth'));
app.use('/api/brands',  require('./routes/brands'));
app.use('/api/coupons', require('./routes/coupons'));
app.use('/api/verify',  require('./routes/verify'));
app.use('/api',         require('./routes/misc'));

app.use((req, res) => res.status(404).json({ error: `${req.method} ${req.path} not found` }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: err.message }); });

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => console.log(`\n⭐ ReviewRise v11.3 running on port ${PORT}\n`));
module.exports = app;
