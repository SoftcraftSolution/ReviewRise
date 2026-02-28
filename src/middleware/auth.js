const jwt = require('jsonwebtoken');
const { query } = require('../db');

// ── Verify JWT token ──────────────────────────────────────────
const authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const result = await query('SELECT * FROM users WHERE id = $1', [decoded.userId]);
    if (!result.rows[0]) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.user = result.rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// ── Role guards ───────────────────────────────────────────────
const requireSuperAdmin = (req, res, next) => {
  if (req.user?.role !== 'superadmin') {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
};

const requireBrandOwner = (req, res, next) => {
  if (!['brand_owner', 'superadmin'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'Brand owner access required' });
  }
  next();
};

// ── Generate tokens ───────────────────────────────────────────
const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
};

module.exports = { authenticate, requireSuperAdmin, requireBrandOwner, generateToken };
