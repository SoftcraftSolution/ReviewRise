/**
 * ReviewRise Smart Verification Engine v2
 * Aggressive polling:
 * - 0-5 min old   → every 10 seconds
 * - 5-15 min old  → every 30 seconds
 * - 15-30 min old → every 60 seconds
 * Per-brand cache: one Places API call per brand per cycle
 */

const axios = require('axios');
const { query } = require('./db');
const { issueCouponForVerifiedReview } = require('./routes/coupons');

const brandLastChecked = {};
const ENGINE_INTERVAL_MS = 10 * 1000;

async function runVerificationEngine() {
  try {
    const now = Date.now();

    const sessRes = await query(`
      SELECT vs.*,
             u.email as user_email,
             b.google_place_id,
             b.name  as brand_name,
             EXTRACT(EPOCH FROM (NOW() - vs.created_at)) as age_seconds
      FROM verification_sessions vs
      JOIN users  u ON u.id  = vs.user_id
      JOIN brands b ON b.id  = vs.brand_id
      WHERE vs.status = 'pending' AND vs.expires_at > NOW()
      ORDER BY vs.created_at ASC
    `);

    const sessions = sessRes.rows;
    if (!sessions.length) return;

    // Filter sessions due for a check
    const due = sessions.filter(s => {
      const age     = parseFloat(s.age_seconds);
      const elapsed = (now - (brandLastChecked[s.brand_id] || 0)) / 1000;
      const interval = age < 300 ? 10 : age < 900 ? 30 : 60;
      return elapsed >= interval;
    });

    if (!due.length) return;
    console.log(`\n🔄 Engine: ${due.length} session(s) due | ${sessions.length} total pending`);

    // Group by brand — one API call per brand
    const byBrand = due.reduce((acc, s) => {
      if (!acc[s.brand_id]) acc[s.brand_id] = [];
      acc[s.brand_id].push(s);
      return acc;
    }, {});

    for (const [brandId, brandSessions] of Object.entries(byBrand)) {
      brandLastChecked[brandId] = now;
      const info = brandSessions[0];

      if (!info.google_place_id || !process.env.GOOGLE_PLACES_API_KEY) continue;

      // One Places API call for this brand
      let reviews = [];
      try {
        const res = await axios.get(
          'https://maps.googleapis.com/maps/api/place/details/json',
          {
            params: {
              place_id:     info.google_place_id,
              fields:       'reviews',
              key:          process.env.GOOGLE_PLACES_API_KEY,
              reviews_sort: 'newest',
            },
            timeout: 8000,
          }
        );
        if (res.data.status !== 'OK') {
          console.log(`  ⚠️  ${info.brand_name}: Places API ${res.data.status}`);
          continue;
        }
        reviews = res.data.result?.reviews || [];
        const age = Math.round(parseFloat(info.age_seconds));
        console.log(`  📍 ${info.brand_name}: ${reviews.length} reviews (session ${age}s old)`);
      } catch(e) {
        console.log(`  ⚠️  ${info.brand_name}: ${e.message}`);
        continue;
      }

      // Check each pending session for this brand
      for (const session of brandSessions) {
        const matched = findMatch(session, reviews);
        if (matched) {
          await issueReward(session, matched);
        } else {
          console.log(`  ⏳ "${session.user_name}" not found yet on ${info.brand_name}`);
        }
      }

      await new Promise(r => setTimeout(r, 300));
    }

  } catch(e) {
    console.error('Engine error:', e.message);
  }
}

function findMatch(session, reviews) {
  const norm      = s => (s||'').toLowerCase().replace(/[^a-z0-9 ]/g,'').trim();
  const userName  = norm(session.user_name);
  const words     = userName.split(' ').filter(w => w.length > 1);
  const windowMs  = new Date(session.created_at).getTime() - (10 * 60 * 1000);

  // Pass 1 — name match
  for (const r of reviews) {
    if (r.rating < 4) continue;
    const gName = norm(r.author_name);
    const hits  = words.filter(w => gName.includes(w)).length;
    const score = words.length > 0 ? hits / words.length : 0;
    if (score >= 0.5) {
      console.log(`  ✅ Name match: "${r.author_name}" ${r.rating}★`);
      return r;
    }
  }

  // Pass 2 — newest 4★+ within window
  const newest = reviews
    .filter(r => r.rating >= 4)
    .sort((a, b) => (b.time||0) - (a.time||0))[0];

  if (newest) {
    const t = newest.time ? newest.time * 1000 : Date.now();
    if (!newest.time || t >= windowMs) {
      console.log(`  ✅ Newest match: "${newest.author_name}" ${newest.rating}★`);
      return newest;
    }
  }

  return null;
}

async function issueReward(session, matched) {
  const stars = matched.rating;
  console.log(`🎉 VERIFIED: "${session.user_name}" ${stars}★ → ${session.brand_name}`);

  await query(
    `UPDATE verification_sessions SET status='verified', verified_at=NOW(), stars_detected=$1 WHERE id=$2`,
    [stars, session.id]
  );

  await query(`
    INSERT INTO reviews
      (brand_id,user_id,session_id,reviewer_name,reviewer_email,stars,review_text,verified,trust_issued,google_verified)
    VALUES ($1,$2,$3,$4,$5,$6,$7,true,false,true) ON CONFLICT DO NOTHING
  `, [session.brand_id, session.user_id, session.id,
      matched.author_name, session.user_email, stars, session.review_text||'']);

  await query(`UPDATE brands SET total_reviews=total_reviews+1, updated_at=NOW() WHERE id=$1`, [session.brand_id]);

  if (stars >= 4) {
    await issueCouponForVerifiedReview(session.id, session.user_id, session.brand_id, stars);
    const pts = stars === 5 ? 75 : 50;
    await query(`UPDATE users SET points=COALESCE(points,0)+$1 WHERE id=$2`, [pts, session.user_id]);
    console.log(`✅ Coupon issued → ${session.user_email}`);
  }
}

function startEngine() {
  console.log(`\n⚙️  Smart Verification Engine started`);
  console.log(`   0-5 min sessions  → check every 10s`);
  console.log(`   5-15 min sessions → check every 30s`);
  console.log(`   15-30 min sessions → check every 60s\n`);
  runVerificationEngine();
  setInterval(runVerificationEngine, ENGINE_INTERVAL_MS);
}

module.exports = { startEngine };
