const jwt  = require('jsonwebtoken');
const { query } = require('../db');

const authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer '))
      return res.status(401).json({ error: 'No token provided' });

    const token   = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // JWT is signed with { id, email, role, name } — use decoded.id
    const userId = decoded.id || decoded.userId; // handle both formats
    if (!userId) return res.status(401).json({ error: 'Invalid token format' });

    const result = await query('SELECT * FROM users WHERE id=$1', [userId]);
    if (!result.rows[0]) return res.status(401).json({ error: 'User not found' });

    req.user = result.rows[0];
    next();
  } catch(err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

const requireSuperAdmin = (req, res, next) => {
  if (req.user?.role !== 'superadmin')
    return res.status(403).json({ error: 'Super admin access required' });
  next();
};

const requireBrandOwner = (req, res, next) => {
  if (!['brand_owner','superadmin'].includes(req.user?.role))
    return res.status(403).json({ error: 'Brand owner access required' });
  next();
};

const generateToken = (userId) =>
  jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '30d',
  });

module.exports = { authenticate, requireSuperAdmin, requireBrandOwner, generateToken };
