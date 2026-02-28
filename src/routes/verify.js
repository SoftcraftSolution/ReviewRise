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

    // ENFORCE: only 4-5 stars can get a verification session
    if (stars && parseInt(stars) < 4) {
      return res.status(400).json({ error: 'Only 4-5 star reviews qualify for rewards' });
    }

    const brandRes = await query('SELECT * FROM brands WHERE id=$1', [brand_id]);
    const brand = brandRes.rows[0];
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    // Expire previous pending sessions for this user+brand
    await query(`UPDATE verification_sessions SET status='expired'
      WHERE user_id=$1 AND brand_id=$2 AND status='pending'`, [req.user.id, brand_id]);

    const result = await query(`
      INSERT INTO verification_sessions (brand_id,user_id,user_name,review_text,status,expires_at)
      VALUES ($1,$2,$3,$4,'pending',NOW()+INTERVAL '15 minutes')
      RETURNING id, expires_at
    `, [brand_id, req.user.id, req.user.name, review_text||'']);

    await query(`INSERT INTO qr_scans (brand_id,user_id) VALUES ($1,$2)`, [brand_id, req.user.id]).catch(()=>{});
    await query(`UPDATE brands SET total_scans=total_scans+1 WHERE id=$1`, [brand_id]);

    const googleReviewUrl = brand.google_place_id
      ? `https://search.google.com/local/writereview?placeid=${brand.google_place_id}`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(brand.name)}`;

    res.json({
      session_id: result.rows[0].id,
      expires_at: result.rows[0].expires_at,
      google_review_url: googleReviewUrl,
      place_id: brand.google_place_id,
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
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

    if (session.status === 'expired' || new Date(session.expires_at) < new Date()) {
      await query(`UPDATE verification_sessions SET status='expired' WHERE id=$1`, [session.id]);
      return res.json({ status: 'expired' });
    }

    await query(`UPDATE verification_sessions SET poll_count=poll_count+1 WHERE id=$1`, [session.id]);

    const brandRes = await query('SELECT * FROM brands WHERE id=$1', [session.brand_id]);
    const brand = brandRes.rows[0];

    let verified = false;
    let matchedReview = null;

    // ── Real GMB API — ONLY real verification ──────────────────
    if (brand.gmb_access_token && brand.gmb_account_id && brand.gmb_location_id) {
      try {
        const gmbBase = process.env.GMB_API_BASE || 'https://mybusiness.googleapis.com/v4';
        const gmbRes = await axios.get(
          `${gmbBase}/accounts/${brand.gmb_account_id}/locations/${brand.gmb_location_id}/reviews`,
          { headers: { Authorization: `Bearer ${brand.gmb_access_token}` } }
        );
        const reviews = gmbRes.data.reviews || [];
        const windowMs = new Date(session.created_at).getTime() - 120_000;

        matchedReview = reviews.find(r => {
          const reviewTime = new Date(r.createTime).getTime();
          const nameMatch  = r.reviewer?.displayName?.toLowerCase()
                              .includes(session.user_name.split(' ')[0].toLowerCase());
          const timeMatch  = reviewTime >= windowMs;
          const starMatch  = ['FOUR','FIVE'].includes(r.starRating); // ONLY 4-5 stars
          return nameMatch && timeMatch && starMatch;
        });
        if (matchedReview) verified = true;
      } catch(gmbErr) {
        console.error('GMB API error:', gmbErr.message);
        // Don't auto-verify on GMB error — return pending
      }
    } else {
      // No GMB connected — return pending with instructions
      // NO auto-verification — coupon only issued after real Google review
      console.log(`Brand ${brand.name} has no GMB connected. Waiting for GMB setup.`);
    }

    if (verified && matchedReview) {
      const stars = { ONE:1, TWO:2, THREE:3, FOUR:4, FIVE:5 }[matchedReview.starRating] || 5;
      if (stars < 4) return res.json({ status:'pending', reason:'low_rating', poll:session.poll_count });

      await query(`UPDATE verification_sessions SET status='verified',verified_at=NOW(),stars_detected=$1 WHERE id=$2`, [stars, session.id]);
      await query(`INSERT INTO reviews (brand_id,user_id,session_id,reviewer_name,stars,review_text,verified)
        VALUES ($1,$2,$3,$4,$5,$6,true) ON CONFLICT DO NOTHING`,
        [session.brand_id, session.user_id, session.id, session.user_name, stars, session.review_text]);
      await query(`UPDATE brands SET total_reviews=total_reviews+1,updated_at=NOW() WHERE id=$1`, [session.brand_id]);

      const coupon = await issueCouponForVerifiedReview(session.id, session.user_id, session.brand_id, stars);
      await query(`UPDATE users SET points=points+50 WHERE id=$1`, [session.user_id]);
      return res.json({ status:'verified', coupon, stars });
    }

    res.json({ status:'pending', poll:session.poll_count, gmb_connected: !!(brand.gmb_access_token) });
  } catch(err) {
    console.error('Poll error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/verify/feedback — private feedback for 1-3 stars
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
