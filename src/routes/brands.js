const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const { query } = require('../db');
const { authenticate, requireSuperAdmin } = require('../middleware/auth');

// GET /api/brands  — public
router.get('/', async (req, res) => {
  try {
    const r = await query(`SELECT id,name,category,emoji,location,plan,active,google_rating,total_reviews,total_scans,reward_offer,reward_min_order,coupon_validity_days FROM brands WHERE active=true ORDER BY joined_at DESC`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/brands/all — superadmin
router.get('/all', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const r = await query(`SELECT b.*, u.email as owner_login_email FROM brands b LEFT JOIN users u ON b.owner_id=u.id ORDER BY b.joined_at DESC`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/brands/:id — public
router.get('/:id', async (req, res) => {
  try {
    const r = await query(`SELECT id,name,category,emoji,location,google_rating,total_reviews,reward_offer,reward_min_order,coupon_validity_days,google_place_id FROM brands WHERE id=$1`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Brand not found' });
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/brands — superadmin creates brand + owner login
router.post('/', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { name, category, emoji, location, plan, google_place_id, reward_offer, reward_min_order, coupon_validity_days, owner_name, owner_email, owner_phone, owner_password } = req.body;
    if (!name || !owner_email) return res.status(400).json({ error: 'Brand name and owner email are required' });

    const hash = await bcrypt.hash(owner_password || 'Brand@123', 10);
    const uRes = await query(`
      INSERT INTO users (name, email, password_hash, role)
      VALUES ($1, LOWER($2), $3, 'brand_owner')
      ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, name=EXCLUDED.name, role='brand_owner'
      RETURNING id
    `, [owner_name || 'Brand Owner', owner_email.trim(), hash]);
    const ownerId = uRes.rows[0].id;

    const bRes = await query(`
      INSERT INTO brands (owner_id, name, category, emoji, location, plan, google_place_id, reward_offer, reward_min_order, coupon_validity_days, owner_name, owner_email, owner_phone)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,LOWER($12),$13) RETURNING *
    `, [ownerId, name, category||'General', emoji||'🏪', location||'', plan||'Starter', google_place_id||'', reward_offer||'20% OFF', parseInt(reward_min_order)||500, parseInt(coupon_validity_days)||30, owner_name||'', owner_email.trim(), owner_phone||'']);

    res.status(201).json({ brand: bRes.rows[0], owner_credentials: { email: owner_email.trim(), password: owner_password||'Brand@123', login_url:'/brand' } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/brands/:id
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { name,category,emoji,location,plan,google_place_id,reward_offer,reward_min_order,coupon_validity_days,active } = req.body;
    const r = await query(`UPDATE brands SET name=COALESCE($1,name),category=COALESCE($2,category),emoji=COALESCE($3,emoji),location=COALESCE($4,location),plan=COALESCE($5,plan),google_place_id=COALESCE($6,google_place_id),reward_offer=COALESCE($7,reward_offer),reward_min_order=COALESCE($8,reward_min_order),coupon_validity_days=COALESCE($9,coupon_validity_days),active=COALESCE($10,active),updated_at=NOW() WHERE id=$11 RETURNING *`,
      [name,category,emoji,location,plan,google_place_id,reward_offer,reward_min_order,coupon_validity_days,active,req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/brands/:id — cascade delete everything
router.delete('/:id', authenticate, requireSuperAdmin, async (req, res) => {
  const id = req.params.id;
  try {
    await query('DELETE FROM ad_views WHERE ad_id IN (SELECT id FROM ads WHERE brand_id=$1)', [id]);
    await query('DELETE FROM qr_scans WHERE brand_id=$1', [id]);
    await query('DELETE FROM verification_sessions WHERE brand_id=$1', [id]);
    await query('DELETE FROM coupons WHERE brand_id=$1', [id]);
    await query('DELETE FROM private_feedback WHERE brand_id=$1', [id]);
    await query('DELETE FROM reviews WHERE brand_id=$1', [id]);
    await query('DELETE FROM brand_visits WHERE brand_id=$1', [id]);
    await query('DELETE FROM qr_codes WHERE brand_id=$1', [id]);
    await query('DELETE FROM banners WHERE brand_id=$1', [id]);
    await query('DELETE FROM ads WHERE brand_id=$1', [id]);
    await query('DELETE FROM brands WHERE id=$1', [id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/brands/:id/stats
router.get('/:id/stats', authenticate, async (req, res) => {
  try {
    const [rev,fb,cp] = await Promise.all([
      query(`SELECT COUNT(*) total, COALESCE(AVG(stars),0)::NUMERIC(2,1) avg_rating FROM reviews WHERE brand_id=$1`, [req.params.id]),
      query(`SELECT COUNT(*) total, COUNT(*) FILTER(WHERE is_read=false) unread FROM private_feedback WHERE brand_id=$1`, [req.params.id]),
      query(`SELECT COUNT(*) total, COUNT(*) FILTER(WHERE status='active') active, COUNT(*) FILTER(WHERE status='redeemed') redeemed FROM coupons WHERE brand_id=$1`, [req.params.id]),
    ]);
    res.json({ reviews:rev.rows[0], feedback:fb.rows[0], coupons:cp.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
