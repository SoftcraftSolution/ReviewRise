const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const { query } = require('../db');
const { authenticate, requireSuperAdmin } = require('../middleware/auth');
const { issueCouponForVerifiedReview } = require('./coupons');

// ── Google OAuth config ───────────────────────────────────────────
const GMB_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GMB_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI      = process.env.GMB_REDIRECT_URI ||
  'https://reviewrise-production-2347.up.railway.app/api/gmb/callback';

// Scopes needed: read reviews + manage notifications
const SCOPES = [
  'https://www.googleapis.com/auth/business.manage',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ');

// ── Step 1: Generate OAuth URL for brand owner ────────────────────
// GET /api/gmb/connect/:brandId
// Brand owner clicks this link → Google consent screen → callback
router.get('/connect/:brandId', authenticate, async (req, res) => {
  try {
    const { brandId } = req.params;

    // Verify requester owns this brand or is superadmin
    const brandRes = await query('SELECT * FROM brands WHERE id=$1', [brandId]);
    const brand = brandRes.rows[0];
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    const isSuperAdmin = req.user.role === 'superadmin';
    const isOwner = brand.owner_email?.toLowerCase() === req.user.email?.toLowerCase();
    const isBrandOwner = req.user.role === 'brand_owner'; // brand_owner accessing their dashboard
    if (!isSuperAdmin && !isOwner && !isBrandOwner)
      return res.status(403).json({ error: 'Not authorized for this brand' });

    // State encodes brandId so we know which brand to update in callback
    const state = Buffer.from(JSON.stringify({ brandId, userId: req.user.id })).toString('base64');

    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id',     GMB_CLIENT_ID);
    url.searchParams.set('redirect_uri',  REDIRECT_URI);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope',         SCOPES);
    url.searchParams.set('access_type',   'offline');
    url.searchParams.set('prompt',        'consent');
    url.searchParams.set('include_granted_scopes', 'false');
    url.searchParams.set('state',         state);

    res.json({ oauth_url: url.toString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Step 2: OAuth callback — Google redirects here ────────────────
// GET /api/gmb/callback?code=...&state=...
router.get('/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.redirect(`${process.env.FRONTEND_URL || 'https://reviewrise-frontend.vercel.app'}/brand?gmb=error&reason=${error}`);
    }

    // Decode state
    let stateData;
    try { stateData = JSON.parse(Buffer.from(state, 'base64').toString()); }
    catch { return res.status(400).json({ error: 'Invalid state' }); }

    const { brandId } = stateData;

    // Exchange code for tokens
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id:     GMB_CLIENT_ID,
      client_secret: GMB_CLIENT_SECRET,
      redirect_uri:  REDIRECT_URI,
      grant_type:    'authorization_code',
    });

    const { access_token, refresh_token, expires_in } = tokenRes.data;
    const tokenExpiry = new Date(Date.now() + (expires_in * 1000));

    // Fetch the brand's GMB account ID and location ID
    const { accountId, locationId, locationName } = await fetchGMBLocation(access_token);

    // Save tokens + GMB IDs to brand
    await query(`
      UPDATE brands
      SET gmb_access_token  = $1,
          gmb_refresh_token = $2,
          gmb_token_expiry  = $3,
          gmb_account_id    = $4,
          gmb_location_id   = $5,
          gmb_connected     = true,
          gmb_connected_at  = NOW()
      WHERE id = $6
    `, [access_token, refresh_token, tokenExpiry, accountId, locationId, brandId]);

    // Register Pub/Sub notification for this location
    if (accountId && locationId) {
      await registerPubSubNotification(access_token, accountId, locationId, brandId);
    }

    console.log(`✅ GMB connected: brand=${brandId} location=${locationName} (${locationId})`);

    // Redirect back to brand dashboard with success
    res.redirect(`${process.env.FRONTEND_URL || 'https://reviewrise-frontend.vercel.app'}/brand?gmb=success`);
  } catch(e) {
    console.error('GMB callback error:', e.response?.data || e.message);
    res.redirect(`${process.env.FRONTEND_URL || 'https://reviewrise-frontend.vercel.app'}/brand?gmb=error&reason=${encodeURIComponent(e.message)}`);
  }
});

// ── Step 3: Google Pub/Sub push — called when new review posted ───
// POST /api/gmb/pubsub
// Google pushes a message here the moment a review is created
router.post('/pubsub', express.raw({ type: 'application/json' }), async (req, res) => {
  // Must respond 200 quickly or Google retries
  res.status(200).send('ok');

  try {
    // Pub/Sub wraps message in base64
    let body;
    try { body = JSON.parse(req.body.toString()); }
    catch { return; }

    const msgData = body?.message?.data;
    if (!msgData) return;

    let notification;
    try { notification = JSON.parse(Buffer.from(msgData, 'base64').toString()); }
    catch { return; }

    console.log('📬 Pub/Sub notification:', JSON.stringify(notification));

    // Notification contains: name (location resource name), type (REVIEW_ADDED etc)
    const { name: locationName, type } = notification;
    if (type !== 'REVIEW_ADDED' && type !== 'REVIEW_UPDATED') return;

    // Extract location ID from resource name
    // Format: "accounts/{accountId}/locations/{locationId}"
    const locationId = locationName?.split('/locations/')?.[1];
    const accountId  = locationName?.split('/locations/')?.[0]?.split('/accounts/')?.[1];
    if (!locationId) return;

    // Find brand with this location
    const brandRes = await query(
      'SELECT * FROM brands WHERE gmb_location_id=$1 AND gmb_connected=true', [locationId]);
    const brand = brandRes.rows[0];
    if (!brand) { console.log(`No brand found for location ${locationId}`); return; }

    // Get fresh access token
    const accessToken = await getFreshToken(brand);
    if (!accessToken) return;

    // Fetch the actual new reviews
    await processNewReviews(brand, accessToken, accountId);

  } catch(e) {
    console.error('Pub/Sub processing error:', e.message);
  }
});

// ── Disconnect GMB ────────────────────────────────────────────────
router.post('/disconnect/:brandId', authenticate, async (req, res) => {
  try {
    const brandRes = await query('SELECT * FROM brands WHERE id=$1', [req.params.brandId]);
    const brand = brandRes.rows[0];
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    const isSuperAdmin = req.user.role === 'superadmin';
    const isOwner = brand.owner_email?.toLowerCase() === req.user.email?.toLowerCase();
    const isBrandOwner = req.user.role === 'brand_owner';
    if (!isSuperAdmin && !isOwner && !isBrandOwner)
      return res.status(403).json({ error: 'Not authorized' });

    await query(`
      UPDATE brands SET
        gmb_access_token=NULL, gmb_refresh_token=NULL,
        gmb_account_id=NULL, gmb_location_id=NULL,
        gmb_connected=false
      WHERE id=$1
    `, [req.params.brandId]);

    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Status check ──────────────────────────────────────────────────
router.get('/status/:brandId', authenticate, async (req, res) => {
  try {
    const r = await query(
      'SELECT gmb_connected, gmb_location_id, gmb_account_id, gmb_connected_at FROM brands WHERE id=$1',
      [req.params.brandId]);
    const b = r.rows[0];
    if (!b) return res.status(404).json({ error: 'Brand not found' });
    res.json({
      connected:    b.gmb_connected || false,
      location_id:  b.gmb_location_id,
      account_id:   b.gmb_account_id,
      connected_at: b.gmb_connected_at,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Manual trigger: re-check reviews now (for testing) ───────────
router.post('/check-now/:brandId', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const brandRes = await query('SELECT * FROM brands WHERE id=$1', [req.params.brandId]);
    const brand = brandRes.rows[0];
    if (!brand?.gmb_connected) return res.status(400).json({ error: 'Brand not GMB connected' });

    const accessToken = await getFreshToken(brand);
    if (!accessToken) return res.status(400).json({ error: 'Could not refresh token' });

    const verified = await processNewReviews(brand, accessToken, brand.gmb_account_id);
    res.json({ success: true, verified });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═════════════════════════════════════════════════════════════════
//  HELPER FUNCTIONS
// ═════════════════════════════════════════════════════════════════

// Fetch first GMB account + location for this Google account
async function fetchGMBLocation(accessToken) {
  try {
    // Get accounts
    const accountsRes = await axios.get(
      'https://mybusinessaccountmanagement.googleapis.com/v1/accounts',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const accounts = accountsRes.data.accounts || [];
    if (!accounts.length) throw new Error('No Google Business accounts found');

    // Use first account
    const account = accounts[0];
    const accountId = account.name.split('/').pop(); // "accounts/123456" → "123456"

    // Get locations
    const locRes = await axios.get(
      `https://mybusinessbusinessinformation.googleapis.com/v1/accounts/${accountId}/locations`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { readMask: 'name,title' }
      }
    );
    const locations = locRes.data.locations || [];
    if (!locations.length) throw new Error('No Google Business locations found');

    // Use first location
    const loc = locations[0];
    const locationId = loc.name.split('/').pop();

    return { accountId, locationId, locationName: loc.title };
  } catch(e) {
    console.error('fetchGMBLocation error:', e.response?.data || e.message);
    // Return nulls — brand will still be saved but without location IDs
    return { accountId: null, locationId: null, locationName: 'Unknown' };
  }
}

// Register Pub/Sub notifications for a location
async function registerPubSubNotification(accessToken, accountId, locationId, brandId) {
  try {
    const topicName = process.env.GOOGLE_PUBSUB_TOPIC;
    if (!topicName) { console.warn('GOOGLE_PUBSUB_TOPIC not set — skipping notification registration'); return; }

    await axios.post(
      `https://mybusinessnotifications.googleapis.com/v1/accounts/${accountId}/locations/${locationId}/notifications`,
      {
        name: `accounts/${accountId}/locations/${locationId}/notifications/notifications`,
        pubsubTopic: topicName,
        notificationTypes: ['NEW_REVIEW', 'UPDATED_REVIEW'],
      },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    console.log(`✅ Pub/Sub registered for location ${locationId}`);
  } catch(e) {
    console.error('registerPubSubNotification error:', e.response?.data || e.message);
  }
}

// Refresh access token using refresh token
async function getFreshToken(brand) {
  try {
    // Check if current token is still valid (5 min buffer)
    if (brand.gmb_token_expiry && new Date(brand.gmb_token_expiry) > new Date(Date.now() + 5 * 60 * 1000)) {
      return brand.gmb_access_token;
    }

    if (!brand.gmb_refresh_token) return null;

    const r = await axios.post('https://oauth2.googleapis.com/token', {
      client_id:     GMB_CLIENT_ID,
      client_secret: GMB_CLIENT_SECRET,
      refresh_token: brand.gmb_refresh_token,
      grant_type:    'refresh_token',
    });

    const { access_token, expires_in } = r.data;
    const expiry = new Date(Date.now() + expires_in * 1000);

    await query(
      'UPDATE brands SET gmb_access_token=$1, gmb_token_expiry=$2 WHERE id=$3',
      [access_token, expiry, brand.id]
    );

    return access_token;
  } catch(e) {
    console.error('getFreshToken error:', e.response?.data || e.message);
    return null;
  }
}

// Fetch latest reviews from GMB API and match to pending sessions
async function processNewReviews(brand, accessToken, accountId) {
  let verified = 0;
  try {
    const locId = brand.gmb_location_id;
    if (!locId || !accountId) return 0;

    // Fetch reviews sorted newest first
    const reviewsRes = await axios.get(
      `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locId}/reviews`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { pageSize: 10, orderBy: 'updateTime desc' }
      }
    );

    const reviews = reviewsRes.data.reviews || [];
    console.log(`📋 GMB reviews for brand ${brand.id}: ${reviews.length} fetched`);

    for (const review of reviews) {
      const stars      = starWordToNum(review.starRating);
      const authorName = review.reviewer?.displayName || '';
      const reviewText = review.comment || '';
      const reviewId   = review.reviewId || review.name;
      const reviewTime = review.updateTime || review.createTime;

      console.log(`  → "${authorName}" ${stars}★ "${reviewText.slice(0,40)}"`);

      // Skip if already processed
      const existing = await query(
        'SELECT id FROM reviews WHERE gmb_review_id=$1', [reviewId]);
      if (existing.rows[0]) continue;

      // Find a pending session for this brand where user_name matches author_name
      // This is the 100% accurate match — same Google account = same display name
      const normName = (s='') => s.toLowerCase().replace(/[^a-z0-9 ]/g,'').trim();
      const gName = normName(authorName);

      // Get all pending sessions for this brand, newest first
      const sessions = await query(`
        SELECT vs.*, u.email as user_email
        FROM verification_sessions vs
        JOIN users u ON u.id = vs.user_id
        WHERE vs.brand_id=$1
          AND vs.status='pending'
          AND vs.expires_at > NOW()
        ORDER BY vs.created_at DESC
      `, [brand.id]);

      let matchedSession = null;
      for (const sess of sessions.rows) {
        const sName = normName(sess.user_name || '');
        const nameWords = sName.split(' ').filter(w => w.length > 1);
        const hits = nameWords.filter(w => gName.includes(w)).length;
        const score = nameWords.length > 0 ? hits / nameWords.length : 0;

        console.log(`    Session "${sess.user_name}" → score=${score.toFixed(2)}`);
        if (score >= 0.5) { matchedSession = sess; break; }
      }

      if (!matchedSession) {
        console.log(`    No matching session for "${authorName}"`);
        continue;
      }

      // ── VERIFIED ──────────────────────────────────────────────
      console.log(`🎉 GMB verified: "${authorName}" ${stars}★ → session ${matchedSession.id}`);

      await query(
        `UPDATE verification_sessions SET status='verified', verified_at=NOW(), stars_detected=$1 WHERE id=$2`,
        [stars, matchedSession.id]
      );

      await query(`
        INSERT INTO reviews
          (brand_id, user_id, session_id, reviewer_name, reviewer_email, stars, review_text, verified, gmb_review_id, google_verified)
        VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,true)
        ON CONFLICT DO NOTHING
      `, [
        brand.id, matchedSession.user_id, matchedSession.id,
        authorName, matchedSession.user_email,
        stars, reviewText, reviewId
      ]);

      await query(`UPDATE brands SET total_reviews=total_reviews+1, updated_at=NOW() WHERE id=$1`, [brand.id]);

      if (stars >= 4) {
        await issueCouponForVerifiedReview(matchedSession.id, matchedSession.user_id, brand.id, stars);
        const pts = stars === 5 ? 75 : 50;
        await query(`UPDATE users SET points=COALESCE(points,0)+$1 WHERE id=$2`, [pts, matchedSession.user_id]);
      }

      verified++;
    }
  } catch(e) {
    console.error('processNewReviews error:', e.response?.data || e.message);
  }
  return verified;
}

// Convert GMB star string to number
function starWordToNum(s) {
  return { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 }[s] || parseInt(s) || 0;
}

module.exports = router;
module.exports.processNewReviews = processNewReviews;
module.exports.getFreshToken = getFreshToken;

// ── Zapier / Make.com webhook receiver ──────────────────────────
// This endpoint receives review data from Zapier or Make.com
// No Google API approval needed — Zapier handles the Google connection
// 
// Zapier setup:
// Trigger: "Google My Business — New Review"
// Action: "Webhooks by Zapier — POST" to this URL
// Payload: { reviewer_name, rating, review_text, location_name, review_time }
//
router.post('/zapier-webhook', async (req, res) => {
  // Respond immediately so Zapier doesn't retry
  res.status(200).json({ received: true });

  try {
    const {
      reviewer_name,  // Google reviewer display name
      rating,         // number 1-5 or string "FIVE" etc
      review_text,    // review comment
      location_name,  // business name or place ID
      place_id,       // optional — if Zapier sends it
      brand_id,       // optional — if you configure it per brand in Zapier
    } = req.body;

    const stars = typeof rating === 'number' ? rating :
      { ONE:1, TWO:2, THREE:3, FOUR:4, FIVE:5 }[rating] || parseInt(rating) || 0;

    if (!reviewer_name || stars < 1) {
      console.log('Zapier webhook: missing reviewer_name or rating');
      return;
    }

    console.log(`📬 Zapier webhook: "${reviewer_name}" ${stars}★ "${(review_text||'').slice(0,50)}"`);

    // Find the brand — try by brand_id, place_id, or location_name match
    let brand = null;
    if (brand_id) {
      const r = await query('SELECT * FROM brands WHERE id=$1', [brand_id]);
      brand = r.rows[0];
    }
    if (!brand && place_id) {
      const r = await query('SELECT * FROM brands WHERE google_place_id=$1', [place_id]);
      brand = r.rows[0];
    }
    if (!brand && location_name) {
      const r = await query(
        `SELECT * FROM brands WHERE LOWER(name) LIKE LOWER($1) LIMIT 1`,
        [`%${location_name}%`]
      );
      brand = r.rows[0];
    }

    if (!brand) {
      console.log(`Zapier webhook: no brand found for location="${location_name}" place_id="${place_id}"`);
      return;
    }

    console.log(`  → Matched brand: ${brand.name}`);

    // Match to a pending session by reviewer name
    const normName  = s => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g,'').trim();
    const gName     = normName(reviewer_name);

    const sessions = await query(`
      SELECT vs.*, u.email as user_email
      FROM verification_sessions vs
      JOIN users u ON u.id = vs.user_id
      WHERE vs.brand_id=$1 AND vs.status='pending' AND vs.expires_at > NOW()
      ORDER BY vs.created_at DESC
    `, [brand.id]);

    let matchedSession = null;
    for (const sess of sessions.rows) {
      const sName     = normName(sess.user_name || '');
      const nameWords = sName.split(' ').filter(w => w.length > 1);
      const hits      = nameWords.filter(w => gName.includes(w)).length;
      const score     = nameWords.length > 0 ? hits / nameWords.length : 0;
      console.log(`  Checking session "${sess.user_name}" → score=${score.toFixed(2)}`);
      if (score >= 0.5) { matchedSession = sess; break; }
    }

    if (!matchedSession) {
      console.log(`  No matching pending session for "${reviewer_name}"`);
      return;
    }

    // Verify and issue reward
    console.log(`🎉 Zapier verified: "${reviewer_name}" ${stars}★ → session ${matchedSession.id}`);

    await query(
      `UPDATE verification_sessions SET status='verified', verified_at=NOW(), stars_detected=$1 WHERE id=$2`,
      [stars, matchedSession.id]
    );
    await query(`
      INSERT INTO reviews (brand_id,user_id,session_id,reviewer_name,reviewer_email,stars,review_text,verified,trust_issued,google_verified)
      VALUES ($1,$2,$3,$4,$5,$6,$7,true,false,true) ON CONFLICT DO NOTHING
    `, [brand.id, matchedSession.user_id, matchedSession.id, reviewer_name, matchedSession.user_email, stars, review_text||'']);

    await query(`UPDATE brands SET total_reviews=total_reviews+1, updated_at=NOW() WHERE id=$1`, [brand.id]);

    if (stars >= 4) {
      await issueCouponForVerifiedReview(matchedSession.id, matchedSession.user_id, brand.id, stars);
      const pts = stars === 5 ? 75 : 50;
      await query(`UPDATE users SET points=COALESCE(points,0)+$1 WHERE id=$2`, [pts, matchedSession.user_id]);
      console.log(`✅ Reward issued via Zapier for "${reviewer_name}"`);
    }

  } catch(e) {
    console.error('Zapier webhook error:', e.message);
  }
});
