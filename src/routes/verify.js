const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');
const { issueCouponForVerifiedReview } = require('./coupons');

// ─────────────────────────────────────────────────────────────────
// POST /api/verify/session  — start a session when user scans QR
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

    // Already reviewed this brand?
    const existing = await query(`
      SELECT vs.id, vs.status, c.code, c.discount, c.status as coupon_status
      FROM verification_sessions vs
      LEFT JOIN coupons c ON c.session_id = vs.id
      WHERE vs.user_id=$1 AND vs.brand_id=$2 AND vs.status='verified'
      ORDER BY vs.verified_at DESC LIMIT 1
    `, [req.user.id, brand_id]);

    if (existing.rows[0]) {
      const prev = existing.rows[0];
      return res.status(409).json({
        error: 'already_reviewed',
        message: 'You already gave a review for this brand!',
        coupon_code: prev.code,
        coupon_discount: prev.discount,
        coupon_status: prev.coupon_status,
      });
    }

    // Expire stale pending sessions
    await query(
      `UPDATE verification_sessions SET status='expired' WHERE user_id=$1 AND brand_id=$2 AND status='pending'`,
      [req.user.id, brand_id]
    );

    // Create session — 10 min window (user has time to post then tap confirm)
    const result = await query(`
      INSERT INTO verification_sessions (brand_id, user_id, user_name, review_text, status, expires_at)
      VALUES ($1,$2,$3,$4,'pending', NOW() + INTERVAL '10 minutes')
      RETURNING id, expires_at, created_at
    `, [brand_id, req.user.id, req.user.name, review_text || '']);

    await query(`INSERT INTO qr_scans (brand_id,user_id) VALUES ($1,$2)`, [brand_id, req.user.id]).catch(()=>{});
    await query(`UPDATE brands SET total_scans=total_scans+1 WHERE id=$1`, [brand_id]);

    res.json({
      session_id:        result.rows[0].id,
      expires_at:        result.rows[0].expires_at,
      google_review_url: `https://search.google.com/local/writereview?placeid=${brand.google_place_id}`,
    });
  } catch(err) {
    console.error('Session error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /api/verify/confirm/:sessionId
// Called when user taps "I've Posted My Review"
// Instantly issues reward — no waiting for Google cache
// Background-verifies against Google Places API asynchronously
// ─────────────────────────────────────────────────────────────────
router.post('/confirm/:sessionId', authenticate, async (req, res) => {
  try {
    const sessRes = await query('SELECT * FROM verification_sessions WHERE id=$1', [req.params.sessionId]);
    const session = sessRes.rows[0];
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    // Already verified — return existing coupon
    if (session.status === 'verified') {
      const couponRes = await query('SELECT * FROM coupons WHERE session_id=$1', [session.id]);
      return res.json({ status: 'verified', coupon: couponRes.rows[0], rewarded: true });
    }

    // Session expired
    if (new Date(session.expires_at) < new Date()) {
      await query(`UPDATE verification_sessions SET status='expired' WHERE id=$1`, [session.id]);
      return res.json({ status: 'expired', message: 'Session expired. Please scan the QR again.' });
    }

    const clientStars = parseInt(req.body.stars) || 5;

    // Low stars — record feedback, no reward
    if (clientStars < 4) {
      await query(`UPDATE verification_sessions SET status='verified',verified_at=NOW(),stars_detected=$1 WHERE id=$2`, [clientStars, session.id]);
      return res.json({ status: 'verified', coupon: null, rewarded: false });
    }

    // ── INSTANT REWARD — trust the user ──────────────────────────
    const userRes = await query('SELECT email FROM users WHERE id=$1', [session.user_id]);
    const userEmail = userRes.rows[0]?.email || '';

    await query(
      `UPDATE verification_sessions SET status='verified',verified_at=NOW(),stars_detected=$1 WHERE id=$2`,
      [clientStars, session.id]
    );
    await query(`
      INSERT INTO reviews (brand_id,user_id,session_id,reviewer_name,reviewer_email,stars,review_text,verified,trust_issued)
      VALUES ($1,$2,$3,$4,$5,$6,$7,true,true) ON CONFLICT DO NOTHING
    `, [session.brand_id, session.user_id, session.id, session.user_name, userEmail, clientStars, session.review_text]);
    await query(`UPDATE brands SET total_reviews=total_reviews+1,updated_at=NOW() WHERE id=$1`, [session.brand_id]);

    const coupon = await issueCouponForVerifiedReview(session.id, session.user_id, session.brand_id, clientStars);
    const bonusPoints = clientStars === 5 ? 75 : 50;
    await query(`UPDATE users SET points=COALESCE(points,0)+$1 WHERE id=$2`, [bonusPoints, session.user_id]);

    console.log(`✅ Instant reward: ${session.user_name} (${userEmail}) ${clientStars}★ → ${coupon?.code}`);

    // ── Background verify against Google (don't block the response) ─
    setImmediate(async () => {
      try {
        const brandRes = await query('SELECT * FROM brands WHERE id=$1', [session.brand_id]);
        const brand = brandRes.rows[0];
        const placesRes = await axios.get('https://maps.googleapis.com/maps/api/place/details/json', {
          params: { place_id: brand.google_place_id, fields: 'reviews', key: process.env.GOOGLE_PLACES_API_KEY, reviews_sort: 'newest' },
          timeout: 8000,
        });
        if (placesRes.data.status === 'OK') {
          const reviews = placesRes.data.result?.reviews || [];
          const normName = s => s.toLowerCase().replace(/[^a-z0-9 ]/g,'').trim();
          const userName = normName(session.user_name || '');
          const nameWords = userName.split(' ').filter(w => w.length > 1);
          const found = reviews.find(r => {
            if (r.rating < 4) return false;
            const gName = normName(r.author_name || '');
            const hits = nameWords.filter(w => gName.includes(w)).length;
            return nameWords.length > 0 && hits / nameWords.length >= 0.5;
          });
          if (found) {
            await query(`UPDATE reviews SET trust_issued=false,google_verified=true WHERE session_id=$1`, [session.id]);
            console.log(`✅ Background verified: ${found.author_name} ${found.rating}★`);
          } else {
            console.log(`ℹ️ Background: review not yet visible on Google (normal — caching delay)`);
          }
        }
      } catch(e) {
        console.log(`ℹ️ Background verify skipped: ${e.message}`);
      }
    });

    return res.json({ status: 'verified', coupon, stars: clientStars, rewarded: true });

  } catch(err) {
    console.error('Confirm error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /api/verify/feedback  — private feedback for 1-3★
// ─────────────────────────────────────────────────────────────────
router.post('/feedback', authenticate, async (req, res) => {
  try {
    const { brand_id, stars, chips, message } = req.body;
    if (!brand_id || !stars) return res.status(400).json({ error: 'brand_id and stars required' });
    await query(`INSERT INTO private_feedback (brand_id,user_id,stars,chips,message) VALUES ($1,$2,$3,$4,$5)`,
      [brand_id, req.user.id, stars, chips||[], message||'']);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
