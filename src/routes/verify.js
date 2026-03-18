const express = require('express');
const router  = express.Router();
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');
const { issueCouponForVerifiedReview } = require('./coupons');

// ─────────────────────────────────────────────────────────────────
// POST /api/verify/session — start verification when user opens QR
// ─────────────────────────────────────────────────────────────────
router.post('/session', authenticate, async (req, res) => {
  try {
    const { brand_id, review_text } = req.body;
    if (!brand_id) return res.status(400).json({ error: 'brand_id required' });

    const brandRes = await query('SELECT * FROM brands WHERE id=$1', [brand_id]);
    const brand = brandRes.rows[0];
    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    if (!brand.google_place_id)
      return res.status(400).json({ error: 'Brand has no Google Place ID configured' });

    // Already has a GOOGLE-VERIFIED review for this brand? Block.
    const existing = await query(`
      SELECT vs.id, c.code, c.discount, c.status as coupon_status
      FROM verification_sessions vs
      LEFT JOIN coupons c ON c.session_id = vs.id
      LEFT JOIN reviews r ON r.session_id = vs.id
      WHERE vs.user_id=$1 AND vs.brand_id=$2
        AND vs.status='verified'
        AND r.google_verified=true
      ORDER BY vs.verified_at DESC LIMIT 1
    `, [req.user.id, brand_id]);

    if (existing.rows[0]) {
      const prev = existing.rows[0];
      return res.status(409).json({
        error:           'already_reviewed',
        message:         'You already gave a verified review for this brand!',
        coupon_code:     prev.code,
        coupon_discount: prev.discount,
        coupon_status:   prev.coupon_status,
      });
    }

    // Expire any old pending sessions
    await query(
      `UPDATE verification_sessions SET status='expired'
       WHERE user_id=$1 AND brand_id=$2 AND status='pending'`,
      [req.user.id, brand_id]
    );

    // 30-minute window — background engine checks every 30 seconds
    const result = await query(`
      INSERT INTO verification_sessions
        (brand_id, user_id, user_name, review_text, status, expires_at)
      VALUES ($1,$2,$3,$4,'pending', NOW() + INTERVAL '30 minutes')
      RETURNING id, expires_at, created_at
    `, [brand_id, req.user.id, req.user.name, review_text || '']);

    await query(
      `INSERT INTO qr_scans (brand_id,user_id) VALUES ($1,$2)`,
      [brand_id, req.user.id]
    ).catch(()=>{});
    await query(
      `UPDATE brands SET total_scans=total_scans+1 WHERE id=$1`,
      [brand_id]
    );

    res.json({
      session_id:        result.rows[0].id,
      expires_at:        result.rows[0].expires_at,
      google_review_url: `https://search.google.com/local/writereview?placeid=${brand.google_place_id}`,
      gmb_connected:     brand.gmb_connected || false,
    });
  } catch(err) {
    console.error('Session error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /api/verify/poll/:sessionId
// Frontend polls this — returns verified immediately when engine finds review
// ─────────────────────────────────────────────────────────────────
router.get('/poll/:sessionId', authenticate, async (req, res) => {
  try {
    const sessRes = await query(
      'SELECT * FROM verification_sessions WHERE id=$1',
      [req.params.sessionId]
    );
    const session = sessRes.rows[0];
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    // Engine verified it — return reward
    if (session.status === 'verified') {
      const couponRes = await query(
        'SELECT * FROM coupons WHERE session_id=$1', [session.id]);
      const revRes = await query(
        'SELECT stars FROM reviews WHERE session_id=$1 LIMIT 1', [session.id]);
      const stars = revRes.rows[0]?.stars || session.stars_detected || 5;
      return res.json({
        status:   'verified',
        coupon:   couponRes.rows[0],
        stars,
        rewarded: stars >= 4,
      });
    }

    // Expired
    if (session.status === 'expired' || new Date(session.expires_at) < new Date()) {
      await query(
        `UPDATE verification_sessions SET status='expired' WHERE id=$1`,
        [session.id]
      );
      return res.json({
        status:  'expired',
        message: 'Review not detected in 30 minutes. Please try again.',
      });
    }

    const secsLeft = Math.max(
      0, Math.round((new Date(session.expires_at) - new Date()) / 1000)
    );
    return res.json({ status: 'pending', seconds_left: secsLeft });

  } catch(err) {
    console.error('Poll error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /api/verify/feedback — private 1-3★ feedback
// ─────────────────────────────────────────────────────────────────
router.post('/feedback', authenticate, async (req, res) => {
  try {
    const { brand_id, stars, chips, message } = req.body;
    if (!brand_id || !stars)
      return res.status(400).json({ error: 'brand_id and stars required' });
    await query(
      `INSERT INTO private_feedback (brand_id,user_id,stars,chips,message)
       VALUES ($1,$2,$3,$4,$5)`,
      [brand_id, req.user.id, stars, chips||[], message||'']
    );
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
