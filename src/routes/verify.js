const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');
const { issueCouponForVerifiedReview } = require('./coupons');

// POST /api/verify/session
router.post('/session', authenticate, async (req, res) => {
  try {
    const { brand_id, review_text, stars } = req.body;
    if (!brand_id) return res.status(400).json({ error: 'brand_id required' });
    if (stars && parseInt(stars) < 4)
      return res.status(400).json({ error: 'Only 4 or 5 star reviews qualify for rewards' });

    const brandRes = await query('SELECT * FROM brands WHERE id=$1', [brand_id]);
    const brand = brandRes.rows[0];
    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    if (!brand.google_place_id)
      return res.status(400).json({ error: 'Brand has no Google Place ID configured' });

    // ── Check if user already has a verified review + active coupon ──
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
        error:        'already_reviewed',
        message:      'You already gave a review for this brand!',
        coupon_code:  prev.code,
        coupon_discount: prev.discount,
        coupon_status:   prev.coupon_status,
      });
    }

    // Expire any stale pending sessions
    await query(
      `UPDATE verification_sessions SET status='expired' WHERE user_id=$1 AND brand_id=$2 AND status='pending'`,
      [req.user.id, brand_id]
    );

    // 2-minute session window
    const result = await query(`
      INSERT INTO verification_sessions (brand_id, user_id, user_name, review_text, status, expires_at)
      VALUES ($1,$2,$3,$4,'pending', NOW() + INTERVAL '2 minutes')
      RETURNING id, expires_at, created_at
    `, [brand_id, req.user.id, req.user.name, review_text || '']);

    await query(`INSERT INTO qr_scans (brand_id,user_id) VALUES ($1,$2)`, [brand_id, req.user.id]).catch(()=>{});
    await query(`UPDATE brands SET total_scans=total_scans+1 WHERE id=$1`, [brand_id]);

    res.json({
      session_id: result.rows[0].id,
      expires_at: result.rows[0].expires_at,
      google_review_url: `https://search.google.com/local/writereview?placeid=${brand.google_place_id}`,
    });
  } catch(err) {
    console.error('Session error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/verify/poll/:sessionId
router.get('/poll/:sessionId', authenticate, async (req, res) => {
  try {
    const sessRes = await query('SELECT * FROM verification_sessions WHERE id=$1', [req.params.sessionId]);
    const session = sessRes.rows[0];
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    if (session.status === 'verified') {
      const couponRes = await query('SELECT * FROM coupons WHERE session_id=$1', [session.id]);
      return res.json({ status: 'verified', coupon: couponRes.rows[0] });
    }

    // 2-minute expiry check
    if (session.status === 'expired' || new Date(session.expires_at) < new Date()) {
      await query(`UPDATE verification_sessions SET status='expired' WHERE id=$1`, [session.id]);
      return res.json({ status: 'expired', message: 'Review not received within 2 minutes. Please try again.' });
    }

    const pollCount = ((session.poll_count || 0) + 1);
    await query(`UPDATE verification_sessions SET poll_count=$1 WHERE id=$2`, [pollCount, session.id]);

    const brandRes = await query('SELECT * FROM brands WHERE id=$1', [session.brand_id]);
    const brand = brandRes.rows[0];

    if (!process.env.GOOGLE_PLACES_API_KEY)
      return res.status(500).json({ error: 'GOOGLE_PLACES_API_KEY not configured' });

    // ── Fetch latest reviews from Places API ────────────────────
    let placesReviews = [];
    try {
      const placesRes = await axios.get(
        'https://maps.googleapis.com/maps/api/place/details/json',
        {
          params: {
            place_id:     brand.google_place_id,
            fields:       'reviews',
            key:          process.env.GOOGLE_PLACES_API_KEY,
            reviews_sort: 'newest',
          },
          timeout: 8000,
        }
      );

      if (placesRes.data.status !== 'OK') {
        console.error('Places API:', placesRes.data.status);
        return res.json({ status: 'pending', api_status: placesRes.data.status, poll: pollCount });
      }
      placesReviews = placesRes.data.result?.reviews || [];
    } catch(e) {
      console.error('Places API error:', e.message);
      return res.json({ status: 'pending', error: 'places_api_error', poll: pollCount });
    }

    // ── Match: text + time + 4-5 stars ──────────────────────────
    const sessionTimeMs = new Date(session.created_at).getTime() - (15 * 60 * 1000);
    const sessionText   = (session.review_text || '').trim().toLowerCase();
    const sessionWords  = sessionText.split(/\s+/).filter(w => w.length > 2);

    let matched = null;
    for (const r of placesReviews) {
      if (r.rating < 4) continue;
      const gTimeMs = r.time ? r.time * 1000 : Date.now();
      if (gTimeMs < sessionTimeMs) continue;

      const gText = (r.text || '').trim().toLowerCase();
      let score = 0;

      if (sessionText.length > 0 && gText === sessionText) {
        score = 1.0;
      } else if (sessionWords.length > 0 && gText.length > 0) {
        const hits = sessionWords.filter(w => gText.includes(w)).length;
        score = hits / sessionWords.length;
      } else if (sessionWords.length <= 2) {
        score = 0.7; // very short review — rely on time + stars
      }

      console.log(`  ${r.author_name} | ${r.rating}★ | score=${score.toFixed(2)}`);
      if (score >= 0.5) { matched = r; break; }
    }

    if (!matched) {
      const secsLeft = Math.max(0, Math.round((new Date(session.expires_at) - new Date()) / 1000));
      return res.json({ status: 'pending', poll: pollCount, reviews_found: placesReviews.length, seconds_left: secsLeft });
    }

    const stars = matched.rating;
    if (stars < 4) return res.json({ status: 'pending', reason: 'low_rating' });

    // ── Verified ────────────────────────────────────────────────
    await query(`UPDATE verification_sessions SET status='verified',verified_at=NOW(),stars_detected=$1 WHERE id=$2`, [stars, session.id]);
    await query(`
      INSERT INTO reviews (brand_id,user_id,session_id,reviewer_name,stars,review_text,verified)
      VALUES ($1,$2,$3,$4,$5,$6,true) ON CONFLICT DO NOTHING
    `, [session.brand_id, session.user_id, session.id, matched.author_name, stars, session.review_text]);
    await query(`UPDATE brands SET total_reviews=total_reviews+1,updated_at=NOW() WHERE id=$1`, [session.brand_id]);

    const coupon = await issueCouponForVerifiedReview(session.id, session.user_id, session.brand_id, stars);
    await query(`UPDATE users SET points=COALESCE(points,0)+50 WHERE id=$1`, [session.user_id]);

    console.log(`🎉 ${matched.author_name} ${stars}★ → ${coupon?.code}`);
    return res.json({ status: 'verified', coupon, stars, reviewer: matched.author_name });

  } catch(err) {
    console.error('Poll error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/verify/feedback
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
