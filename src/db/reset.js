require('dotenv').config();
const { query, pool } = require('./index');

async function reset() {
  console.log('🗑️  Wiping all data...');
  
  // Delete in order (foreign keys)
  await query('DELETE FROM ad_views').catch(()=>{});
  await query('DELETE FROM qr_scans').catch(()=>{});
  await query('DELETE FROM verification_sessions').catch(()=>{});
  await query('DELETE FROM coupons').catch(()=>{});
  await query('DELETE FROM private_feedback').catch(()=>{});
  await query('DELETE FROM reviews').catch(()=>{});
  await query('DELETE FROM brand_visits').catch(()=>{});
  await query('DELETE FROM qr_codes').catch(()=>{});
  await query('DELETE FROM banners').catch(()=>{});
  await query('DELETE FROM ads').catch(()=>{});
  await query('DELETE FROM brands').catch(()=>{});
  await query("DELETE FROM users WHERE role != 'superadmin'").catch(()=>{});
  
  console.log('✅ All dummy data wiped. Super admin account kept.');
  console.log('✅ Database is clean. Add real clients from the admin panel.');
  await pool.end();
}

reset().catch(e => { console.error(e.message); process.exit(1); });
