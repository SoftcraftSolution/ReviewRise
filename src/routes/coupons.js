const express = require('express');
const router  = express.Router();
const { query } = require('../db');
const { authenticate, requireBrandOwner, requireSuperAdmin } = require('../middleware/auth');

// GET /api/coupons — super admin: all coupons
router.get('/', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const r = await query(`
      SELECT c.*, b.name as brand_name, b.emoji as brand_emoji
      FROM coupons c JOIN brands b ON c.brand_id=b.id
      ORDER BY c.issued_at DESC LIMIT 200
    `);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/coupons/my — customer: their coupons
router.get('/my', authenticate, async (req, res) => {
  try {
    const r = await query(`
      SELECT c.*, b.name as brand_name, b.emoji as brand_emoji
      FROM coupons c JOIN brands b ON c.brand_id=b.id
      WHERE c.user_id=$1 ORDER BY c.issued_at DESC
    `, [req.user.id]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/coupons/brand/:brandId — brand owner: their coupons
router.get('/brand/:brandId', authenticate, async (req, res) => {
  try {
    if (req.user.role === 'brand_owner') {
      const check = await query('SELECT id FROM brands WHERE id=$1 AND owner_id=$2', [req.params.brandId, req.user.id]);
      if (!check.rows[0]) return res.status(403).json({ error: 'Not your brand' });
    }
    const r = await query(`SELECT * FROM coupons WHERE brand_id=$1 ORDER BY issued_at DESC`, [req.params.brandId]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/coupons/verify — brand owner verifies a coupon code at cashier
// FIX: authenticate only (brand_id is read from the coupon itself, not the request)
router.post('/verify', authenticate, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Coupon code required' });

    // Expire old coupons
    await query(`UPDATE coupons SET status='expired' WHERE expires_at < NOW() AND status='active'`);

    const result = await query(`
      SELECT c.*, b.name as brand_name, b.emoji as brand_emoji, b.reward_offer, b.owner_id
      FROM coupons c JOIN brands b ON c.brand_id=b.id
      WHERE UPPER(TRIM(c.code)) = UPPER(TRIM($1))
    `, [code]);

    const coupon = result.rows[0];
    if (!coupon) return res.json({ valid: false, reason: 'Coupon code not found' });

    // If brand_owner: verify they own this coupon's brand
    if (req.user.role === 'brand_owner' && coupon.owner_id !== req.user.id) {
      return res.json({ valid: false, reason: 'This coupon belongs to a different brand' });
    }

    if (coupon.status === 'redeemed') return res.json({ valid: false, reason: 'Already redeemed on ' + new Date(coupon.redeemed_at).toLocaleDateString('en-IN'), coupon });
    if (coupon.status === 'expired')  return res.json({ valid: false, reason: 'Coupon has expired', coupon });

    res.json({
      valid: true,
      coupon: {
        id:         coupon.id,
        code:       coupon.code,
        discount:   coupon.discount,
        min_order:  coupon.min_order,
        user_name:  coupon.user_name,
        user_email: coupon.user_email,
        source:     coupon.source,
        brand_name: coupon.brand_name,
        expires_at: coupon.expires_at,
        issued_at:  coupon.issued_at,
        stars:      coupon.stars_at_issue,
      }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/coupons/redeem — mark coupon as used
router.post('/redeem', authenticate, async (req, res) => {
  try {
    const { coupon_id, cashier_name } = req.body;
    if (!coupon_id) return res.status(400).json({ error: 'coupon_id required' });

    // If brand_owner: ensure they own this coupon's brand
    if (req.user.role === 'brand_owner') {
      const check = await query(`
        SELECT c.id FROM coupons c JOIN brands b ON c.brand_id=b.id
        WHERE c.id=$1 AND b.owner_id=$2`, [coupon_id, req.user.id]);
      if (!check.rows[0]) return res.status(403).json({ error: 'Not your brand coupon' });
    }

    const r = await query(`
      UPDATE coupons SET status='redeemed', redeemed_at=NOW(), redeemed_by=$1
      WHERE id=$2 AND status='active' RETURNING *
    `, [cashier_name || req.user.name || 'Cashier', coupon_id]);

    if (!r.rows[0]) return res.status(400).json({ error: 'Coupon already redeemed or not found' });
    res.json({ success: true, coupon: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/coupons/generate — brand owner generates manual coupon
router.post('/generate', authenticate, requireBrandOwner, async (req, res) => {
  try {
    const { brand_id, discount, min_order, validity_days, for_user_name, for_user_email } = req.body;
    if (!brand_id || !discount) return res.status(400).json({ error: 'brand_id and discount required' });

    if (req.user.role === 'brand_owner') {
      const check = await query('SELECT id FROM brands WHERE id=$1 AND owner_id=$2', [brand_id, req.user.id]);
      if (!check.rows[0]) return res.status(403).json({ error: 'Not your brand' });
    }

    const brand = await query('SELECT * FROM brands WHERE id=$1', [brand_id]);
    const b = brand.rows[0];
    const prefix = (b?.name||'RR').replace(/[^a-zA-Z]/g,'').toUpperCase().slice(0,3)||'RRW';
    const code = prefix + Math.random().toString(36).toUpperCase().slice(2,8);
    const days = parseInt(validity_days) || 30;

    const r = await query(`
      INSERT INTO coupons (code,brand_id,user_name,user_email,discount,min_order,source,status,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,'manual','active',NOW()+INTERVAL '${days} days') RETURNING *
    `, [code, brand_id, for_user_name||'Manual Coupon', for_user_email||'', discount, parseInt(min_order)||0]);

    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Internal: issue coupon after verification
const issueCouponForVerifiedReview = async (sessionId, userId, brandId, stars) => {
  const brand = (await query('SELECT * FROM brands WHERE id=$1', [brandId])).rows[0];
  if (!brand) throw new Error('Brand not found');
  const user  = (await query('SELECT * FROM users WHERE id=$1', [userId])).rows[0];

  // Prevent duplicate coupons within 30 days
  const recent = await query(`
    SELECT id FROM coupons WHERE user_id=$1 AND brand_id=$2 AND source='review'
    AND issued_at > NOW() - INTERVAL '30 days'
  `, [userId, brandId]);
  if (recent.rows[0]) return { alreadyIssued: true, ...recent.rows[0] };

  const prefix = (brand.name||'RR').replace(/[^a-zA-Z]/g,'').toUpperCase().slice(0,3)||'RRW';
  const code = prefix + Math.random().toString(36).toUpperCase().slice(2,8);

  const r = await query(`
    INSERT INTO coupons (
      code, brand_id, user_id, user_name, user_email,
      discount, min_order, source, status, session_id, expires_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,'review','active',$8, NOW()+INTERVAL '${brand.coupon_validity_days||30} days')
    RETURNING *
  `, [code, brandId, userId, user?.name||'Customer', user?.email||'', brand.reward_offer, brand.reward_min_order, sessionId]);

  return r.rows[0];
};

module.exports = router;
module.exports.issueCouponForVerifiedReview = issueCouponForVerifiedReview;
