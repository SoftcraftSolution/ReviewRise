const express = require('express');
const router  = express.Router();
const { query } = require('../db');
const { authenticate, requireSuperAdmin, requireBrandOwner } = require('../middleware/auth');

// ── REVIEWS ───────────────────────────────────────────────────
router.get('/reviews/brand/:brandId', authenticate, async (req, res) => {
  try {
    const r = await query(`SELECT r.*, u.avatar_url FROM reviews r LEFT JOIN users u ON r.user_id=u.id WHERE r.brand_id=$1 ORDER BY r.created_at DESC`, [req.params.brandId]);
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
    const { brand_id, title, description } = req.body;
    if (!brand_id||!title) return res.status(400).json({ error: 'brand_id and title required' });
    const r = await query(`INSERT INTO ads (brand_id,title,description,active,views,clicks,created_by) VALUES($1,$2,$3,true,0,0,$4) RETURNING *`,[brand_id,title,description||'',req.user.id]);
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
    await query('UPDATE ads SET views=views+1 WHERE id=$1',[req.params.id]);
    await query('INSERT INTO ad_views (ad_id,user_id) VALUES($1,$2)',[req.params.id,req.user.id]);
    // Count how many ads this user watched today
    const countRes = await query(`SELECT COUNT(*) as c FROM ad_views WHERE user_id=$1 AND created_at > NOW()-INTERVAL '1 day'`,[req.user.id]);
    const count = parseInt(countRes.rows[0].c);
    let reward = null;
    if (count >= 3) {
      // Issue a coupon - pick a random active brand
      const brandRes = await query('SELECT id FROM brands WHERE active=true ORDER BY RANDOM() LIMIT 1');
      if (brandRes.rows[0]) {
        const code = 'ADS' + Math.random().toString(36).toUpperCase().slice(2,8);
        const couponRes = await query(`INSERT INTO coupons(code,brand_id,user_id,user_name,discount,min_order,source,status,expires_at) VALUES($1,$2,$3,$4,'₹50 OFF',200,'ads','active',NOW()+INTERVAL '30 days') RETURNING *`,
          [code, brandRes.rows[0].id, req.user.id, req.user.name]);
        reward = couponRes.rows[0];
      }
    }
    res.json({ watched: count, reward });
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
    const { brand_id, title } = req.body;
    if (!brand_id||!title) return res.status(400).json({ error: 'brand_id and title required' });
    const r = await query('INSERT INTO banners (brand_id,title,active,created_by) VALUES($1,$2,true,$3) RETURNING *',[brand_id,title,req.user.id]);
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
