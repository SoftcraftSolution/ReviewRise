const express = require('express');
const router  = express.Router();
const { query } = require('../db');
const { authenticate, requireSuperAdmin, requireBrandOwner } = require('../middleware/auth');

// ── REVIEWS ───────────────────────────────────────────────────
router.get('/reviews/brand/:brandId', authenticate, async (req, res) => {
  try {
    const r = await query(`
      SELECT r.*, u.email as user_email, u.avatar_url, u.phone as user_phone,
             c.code as coupon_code, c.discount as coupon_discount, c.status as coupon_status
      FROM reviews r
      LEFT JOIN users u ON r.user_id=u.id
      LEFT JOIN coupons c ON c.session_id=r.session_id
      WHERE r.brand_id=$1 ORDER BY r.created_at DESC
    `, [req.params.brandId]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.patch('/reviews/:id/replied', authenticate, async (req, res) => {
  try { await query('UPDATE reviews SET replied=true WHERE id=$1',[req.params.id]); res.json({success:true}); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PRIVATE FEEDBACK ──────────────────────────────────────────
router.get('/feedback/brand/:brandId', authenticate, async (req, res) => {
  try {
    const r = await query('SELECT * FROM private_feedback WHERE brand_id=$1 ORDER BY created_at DESC',[req.params.brandId]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.patch('/feedback/:id/read', authenticate, async (req, res) => {
  try { await query('UPDATE private_feedback SET is_read=true WHERE id=$1',[req.params.id]); res.json({success:true}); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADS ───────────────────────────────────────────────────────
router.get('/ads', async (req, res) => {
  try {
    const r = await query(`SELECT a.*,b.name as brand_name,b.emoji as brand_emoji FROM ads a JOIN brands b ON a.brand_id=b.id WHERE a.active=true AND b.active=true ORDER BY a.created_at DESC`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.get('/ads/all', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const r = await query(`SELECT a.*,b.name as brand_name,b.emoji as brand_emoji FROM ads a JOIN brands b ON a.brand_id=b.id ORDER BY a.created_at DESC`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.post('/ads', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { brand_id, title, description, image_url, video_url } = req.body;
    if (!brand_id||!title) return res.status(400).json({ error: 'brand_id and title required' });
    const r = await query(`INSERT INTO ads (brand_id,title,description,image_url,video_url,active,views,clicks,created_by) VALUES($1,$2,$3,$4,$5,true,0,0,$6) RETURNING *`,[brand_id,title,description||'',image_url||null,video_url||null,req.user.id]);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.patch('/ads/:id/toggle', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const r = await query('UPDATE ads SET active=NOT active WHERE id=$1 RETURNING *',[req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.post('/ads/:id/view', authenticate, async (req, res) => {
  try {
    // Get the ad and its brand
    const adRes = await query('SELECT * FROM ads WHERE id=$1', [req.params.id]);
    const ad = adRes.rows[0];
    if (!ad) return res.status(404).json({ error: 'Ad not found' });

    await query('UPDATE ads SET views=views+1 WHERE id=$1', [req.params.id]);
    // Record view (ignore duplicate)
    await query('INSERT INTO ad_views (ad_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [req.params.id, req.user.id]).catch(()=>{});

    // Get all active ads for this brand
    const brandAdsRes = await query(
      'SELECT id FROM ads WHERE brand_id=$1 AND active=true', [ad.brand_id]);
    const brandAdIds = brandAdsRes.rows.map(r => r.id);

    // Check how many of THIS brand's ads the user has watched (ever, not just today)
    const watchedRes = await query(
      `SELECT COUNT(DISTINCT ad_id) as c FROM ad_views WHERE user_id=$1 AND ad_id=ANY($2)`,
      [req.user.id, brandAdIds]);
    const watchedCount = parseInt(watchedRes.rows[0].c);
    const totalBrandAds = brandAdIds.length;

    let reward = null;

    // If user has watched ALL ads for this brand → issue coupon for that brand
    if (watchedCount >= totalBrandAds && totalBrandAds > 0) {
      // Check if they already got an ads coupon for this brand
      const existingCpn = await query(
        `SELECT id FROM coupons WHERE user_id=$1 AND brand_id=$2 AND source='ads' AND status='active'`,
        [req.user.id, ad.brand_id]);

      if (!existingCpn.rows[0]) {
        const brandRes = await query('SELECT * FROM brands WHERE id=$1', [ad.brand_id]);
        const brand = brandRes.rows[0];
        if (brand) {
          const code = 'ADS' + Math.random().toString(36).toUpperCase().slice(2,8);
          const discount = brand.reward_offer || '₹50 OFF';
          const minOrder = brand.reward_min_order || 200;
          const couponRes = await query(
            `INSERT INTO coupons(code,brand_id,user_id,user_name,discount,min_order,source,status,expires_at)
             VALUES($1,$2,$3,$4,$5,$6,'ads','active',NOW()+INTERVAL '30 days') RETURNING *`,
            [code, ad.brand_id, req.user.id, req.user.name, discount, minOrder]);
          reward = { ...couponRes.rows[0], brand_name: brand.name, brand_emoji: brand.emoji };
        }
      }
    }

    res.json({
      watched_for_brand: watchedCount,
      total_brand_ads: totalBrandAds,
      all_watched: watchedCount >= totalBrandAds,
      reward
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── BANNERS ───────────────────────────────────────────────────
router.get('/banners', async (req, res) => {
  try {
    const r = await query(`SELECT bn.*,b.name as brand_name,b.emoji as brand_emoji FROM banners bn JOIN brands b ON bn.brand_id=b.id WHERE bn.active=true ORDER BY bn.created_at DESC`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.get('/banners/all', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const r = await query(`SELECT bn.*,b.name as brand_name,b.emoji as brand_emoji FROM banners bn JOIN brands b ON bn.brand_id=b.id ORDER BY bn.created_at DESC`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.post('/banners', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { brand_id, title, subtitle, image_url } = req.body;
    if (!brand_id||!title) return res.status(400).json({ error: 'brand_id and title required' });
    const r = await query('INSERT INTO banners (brand_id,title,subtitle,image_url,active,created_by) VALUES($1,$2,$3,$4,true,$5) RETURNING *',[brand_id,title,subtitle||null,image_url||null,req.user.id]);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.patch('/banners/:id/toggle', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const r = await query('UPDATE banners SET active=NOT active WHERE id=$1 RETURNING *',[req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── COUPONS ───────────────────────────────────────────────────
router.get('/coupons', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const r = await query(`SELECT c.*,b.name as brand_name,b.emoji FROM coupons c JOIN brands b ON c.brand_id=b.id ORDER BY c.issued_at DESC LIMIT 200`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.get('/coupons/my', authenticate, async (req, res) => {
  try {
    const r = await query(`SELECT c.*,b.name as brand_name,b.emoji FROM coupons c JOIN brands b ON c.brand_id=b.id WHERE c.user_id=$1 ORDER BY c.issued_at DESC`,[req.user.id]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.get('/coupons/brand/:brandId', authenticate, async (req, res) => {
  try {
    const r = await query(`SELECT * FROM coupons WHERE brand_id=$1 ORDER BY issued_at DESC LIMIT 100`,[req.params.brandId]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CUSTOMERS ─────────────────────────────────────────────────
router.get('/customers', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const r = await query(`
      SELECT u.id,u.name,u.email,u.points,u.created_at,
        COUNT(DISTINCT bv.brand_id) AS brands_visited,
        COUNT(DISTINCT bv.id)       AS total_visits,
        COUNT(DISTINCT rv.id)       AS total_reviews,
        COUNT(DISTINCT c.id)        AS total_coupons,
        MAX(bv.visited_at)          AS last_visit
      FROM users u
      LEFT JOIN brand_visits bv ON u.id=bv.user_id
      LEFT JOIN reviews      rv ON u.id=rv.user_id
      LEFT JOIN coupons       c ON u.id=c.user_id
      WHERE u.role='customer'
      GROUP BY u.id ORDER BY last_visit DESC NULLS LAST
    `);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── QR CODES ──────────────────────────────────────────────────
router.get('/qr/brand/:brandId', authenticate, async (req, res) => {
  try {
    const r = await query('SELECT * FROM qr_codes WHERE brand_id=$1 ORDER BY created_at DESC',[req.params.brandId]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.post('/qr', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { brand_id, table_label } = req.body;
    if (!brand_id) return res.status(400).json({ error: 'brand_id required' });
    const url = `https://reviewrise-frontend.vercel.app/review?brand=${brand_id}&t=${encodeURIComponent(table_label||'main')}`;
    const r = await query(`INSERT INTO qr_codes (brand_id,table_label,url,scan_count,created_by) VALUES($1,$2,$3,0,$4) RETURNING *`,
      [brand_id, table_label||'Main', url, req.user.id]);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PLATFORM STATS ────────────────────────────────────────────
router.get('/stats/platform', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const [brands,customers,reviews,coupons] = await Promise.all([
      query(`SELECT COUNT(*) as total, COUNT(*) FILTER(WHERE active) as active FROM brands`),
      query(`SELECT COUNT(*) as total FROM users WHERE role='customer'`),
      query(`SELECT COUNT(*) as total FROM reviews WHERE verified=true`),
      query(`SELECT COUNT(*) as total, COUNT(*) FILTER(WHERE status='redeemed') as redeemed FROM coupons`),
    ]);
    res.json({
      brands:    brands.rows[0],
      customers: customers.rows[0],
      reviews:   reviews.rows[0],
      coupons:   coupons.rows[0],
      mrr:       parseInt(brands.rows[0].active) * 1999,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/stats/brand/:brandId/trend', authenticate, async (req, res) => {
  try {
    const r = await query(`
      SELECT DATE_TRUNC('day',created_at)::DATE as day, COUNT(*) as reviews, AVG(stars)::NUMERIC(2,1) as avg_rating
      FROM reviews WHERE brand_id=$1 AND created_at > NOW()-INTERVAL '30 days'
      GROUP BY 1 ORDER BY 1
    `,[req.params.brandId]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

// ── CLEANUP: remove duplicate brands (keep oldest per name) ──
router.delete('/admin/cleanup-duplicates', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const r = await query(`
      DELETE FROM brands WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY LOWER(name) ORDER BY joined_at ASC) as rn
          FROM brands
        ) t WHERE rn > 1
      )
    `)
    res.json({ success:true, message:'Duplicates removed' })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── PROFILE ──────────────────────────────────────────────────────
router.get('/profile', authenticate, async (req, res) => {
  try {
    const r = await query(`SELECT id,name,email,avatar_url,points,role,phone,dob,address,created_at FROM users WHERE id=$1`, [req.user.id]);
    const fb = await query(`SELECT id,stars,chips,message,created_at FROM private_feedback WHERE user_id=$1 ORDER BY created_at DESC`, [req.user.id]);
    res.json({ ...r.rows[0], feedback: fb.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/profile', authenticate, async (req, res) => {
  try {
    const { phone, address, dob } = req.body;
    // DOB cannot be changed once set
    const cur = await query(`SELECT dob FROM users WHERE id=$1`, [req.user.id]);
    const existingDob = cur.rows[0]?.dob;
    const newDob = existingDob ? existingDob : (dob || null); // lock once set
    await query(
      `UPDATE users SET phone=COALESCE($1,phone), address=COALESCE($2,address), dob=COALESCE($3,dob), updated_at=NOW() WHERE id=$4`,
      [phone||null, address||null, newDob, req.user.id]
    );
    const r = await query(`SELECT id,name,email,avatar_url,points,phone,dob,address FROM users WHERE id=$1`, [req.user.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ALL FEEDBACK — superadmin ─────────────────────────────────────
router.get('/feedback/all', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const r = await query(`
      SELECT pf.*, u.name as user_name, u.email as user_email, b.name as brand_name, b.emoji as brand_emoji
      FROM private_feedback pf
      JOIN users u ON pf.user_id = u.id
      JOIN brands b ON pf.brand_id = b.id
      ORDER BY pf.created_at DESC
    `);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ALREADY-REVIEWED check ────────────────────────────────────────
router.get('/verify/history/:brandId', authenticate, async (req, res) => {
  try {
    const r = await query(`
      SELECT vs.status, vs.verified_at, vs.stars_detected, c.code, c.discount, c.status as coupon_status
      FROM verification_sessions vs
      LEFT JOIN coupons c ON c.session_id = vs.id
      WHERE vs.user_id=$1 AND vs.brand_id=$2
      ORDER BY vs.created_at DESC LIMIT 1
    `, [req.user.id, req.params.brandId]);
    res.json(r.rows[0] || null);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── BANNER upload with image_url ──────────────────────────────────
router.put('/banners/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { title, subtitle, image_url, brand_id, active } = req.body;
    const r = await query(
      `UPDATE banners SET title=COALESCE($1,title),subtitle=COALESCE($2,subtitle),image_url=COALESCE($3,image_url),brand_id=COALESCE($4,brand_id),active=COALESCE($5,active),updated_at=NOW() WHERE id=$6 RETURNING *`,
      [title, subtitle||null, image_url||null, brand_id, active, req.params.id]
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── AD update ─────────────────────────────────────────────────────
router.put('/ads/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { title, description, image_url, brand_id, video_url } = req.body;
    const r = await query(
      `UPDATE ads SET title=COALESCE($1,title),description=COALESCE($2,description),image_url=COALESCE($3,image_url),brand_id=COALESCE($4,brand_id),video_url=COALESCE($5,video_url),updated_at=NOW() WHERE id=$6 RETURNING *`,
      [title, description, image_url||null, brand_id, video_url||null, req.params.id]
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── POINTS REDEMPTION ─────────────────────────────────────────────
router.get('/points/tiers', async (req, res) => {
  res.json([
    { points: 200, discount: '₹20 OFF',  min_order: 200,  label: 'Bronze Reward' },
    { points: 500, discount: '₹75 OFF',  min_order: 500,  label: 'Silver Reward' },
    { points: 1000,discount: '₹200 OFF', min_order: 1000, label: 'Gold Reward'   },
  ])
})

router.post('/points/redeem', authenticate, async (req, res) => {
  try {
    const { points_to_spend } = req.body
    const TIERS = [
      { points:200,  discount:'₹20 OFF',  min_order:200  },
      { points:500,  discount:'₹75 OFF',  min_order:500  },
      { points:1000, discount:'₹200 OFF', min_order:1000 },
    ]
    const tier = TIERS.find(t => t.points === parseInt(points_to_spend))
    if (!tier) return res.status(400).json({ error: 'Invalid points amount' })

    const userRes = await query('SELECT points FROM users WHERE id=$1', [req.user.id])
    const userPoints = userRes.rows[0]?.points || 0
    if (userPoints < tier.points) return res.status(400).json({ error: `Need ${tier.points} points, you have ${userPoints}` })

    const code = 'PTS' + Math.random().toString(36).slice(2,8).toUpperCase()
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    const cpn = await query(
      `INSERT INTO coupons (user_id,code,discount,min_order,expires_at,status,source)
       VALUES ($1,$2,$3,$4,$5,'active','points') RETURNING *`,
      [req.user.id, code, tier.discount, tier.min_order, expires]
    )
    await query('UPDATE users SET points=points-$1, points_redeemed=COALESCE(points_redeemed,0)+$1 WHERE id=$2',
      [tier.points, req.user.id])
    await query('INSERT INTO point_redemptions (user_id,points_spent,coupon_id) VALUES ($1,$2,$3)',
      [req.user.id, tier.points, cpn.rows[0].id])

    res.json({ success: true, coupon: cpn.rows[0], remaining_points: userPoints - tier.points })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── IMAGE UPLOAD (base64 → store as URL via data URI or accept external) ─
// For Cloudinary unsigned upload — frontend calls Cloudinary directly
// This endpoint just validates and saves the returned URL
router.post('/upload/verify', authenticate, requireSuperAdmin, async (req, res) => {
  const { url } = req.body
  if (!url) return res.status(400).json({ error: 'url required' })
  // Accept any https URL or data URI
  if (!url.startsWith('https://') && !url.startsWith('http://') && !url.startsWith('data:'))
    return res.status(400).json({ error: 'Invalid URL format' })
  res.json({ url, ok: true })
})
