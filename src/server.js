require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const morgan  = require('morgan');
const { query } = require('./db');

const app = express();
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(morgan('dev'));

// ── Health ─────────────────────────────────────────────────────
app.get('/health', (req, res) =>
  res.json({ status: 'ok', service: 'ReviewRise API', v: '11.0', time: new Date().toISOString() })
);

// ─────────────────────────────────────────────────────────────────
// RESET ALL — defined DIRECTLY on app BEFORE any router/middleware
// This guarantees it is never intercepted by /api catch-all routers
// ─────────────────────────────────────────────────────────────────
app.post('/api/admin/reset-all', async (req, res) => {
  try {
    const { secret } = req.body || {};
    if (secret !== (process.env.RESET_SECRET || 'softcraft-reset-2024')) {
      return res.status(403).json({ error: 'Wrong secret' });
    }
    const tables = [
      'ad_views', 'qr_scans', 'verification_sessions', 'coupons',
      'private_feedback', 'reviews', 'brand_visits', 'qr_codes',
      'banners', 'ads', 'brands'
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

// ── Mount routers AFTER reset-all ─────────────────────────────
app.use('/api/auth',    require('./routes/auth'));
app.use('/api/brands',  require('./routes/brands'));
app.use('/api/coupons', require('./routes/coupons'));
app.use('/api/verify',  require('./routes/verify'));
app.use('/api',         require('./routes/misc'));

app.use((req, res) => res.status(404).json({ error: `${req.method} ${req.path} not found` }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: err.message }); });

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => console.log(`\n⭐ ReviewRise v11 running on port ${PORT}\n`));
module.exports = app;
