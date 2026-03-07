require('dotenv').config();
const { query, pool } = require('./index');
const bcrypt = require('bcryptjs');

async function seed() {
  console.log('🌱 Seeding super admin only...\n');

  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`).catch(()=>{});

  const adminEmail = process.env.SUPERADMIN_EMAIL || 'admin@softcraftsolutions.in';
  const adminPass  = process.env.SUPERADMIN_PASSWORD || 'Admin@123';
  const aHash = await bcrypt.hash(adminPass, 10);

  await query(`
    INSERT INTO users (name, email, password_hash, role)
    VALUES ('SoftCraft Admin', LOWER($1), $2, 'superadmin')
    ON CONFLICT (email) DO UPDATE
      SET password_hash=EXCLUDED.password_hash, role='superadmin', name=EXCLUDED.name
  `, [adminEmail, aHash]);

  console.log('✅ Super admin ready');
  console.log('\n═══════════════════════════════════════════');
  console.log('🔐 SUPER ADMIN  →  /admin');
  console.log(`   Email:    ${adminEmail}`);
  console.log(`   Password: ${adminPass}`);
  console.log('═══════════════════════════════════════════\n');

  await pool.end();
}

seed().catch(err => { console.error('❌', err.message); process.exit(1); });
