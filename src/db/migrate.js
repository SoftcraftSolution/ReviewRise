require('dotenv').config();
const { query, pool } = require('./index');

async function migrate() {
  console.log('🔧 Running migrations...\n');

  // ── Users ──────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name          VARCHAR(255) NOT NULL,
      email         VARCHAR(255) UNIQUE NOT NULL,
      google_id     VARCHAR(255) UNIQUE,
      avatar_url    TEXT,
      points        INTEGER DEFAULT 0,
      role          VARCHAR(20) DEFAULT 'customer',  -- 'customer' | 'brand_owner' | 'superadmin'
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✅ users table');

  // ── Brands ─────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS brands (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id            UUID REFERENCES users(id) ON DELETE SET NULL,
      name                VARCHAR(255) NOT NULL,
      category            VARCHAR(100),
      emoji               VARCHAR(10) DEFAULT '🏪',
      location            TEXT,
      plan                VARCHAR(20) DEFAULT 'Starter',   -- 'Starter' | 'Pro'
      active              BOOLEAN DEFAULT true,
      google_place_id     VARCHAR(255),
      gmb_account_id      VARCHAR(255),
      gmb_location_id     VARCHAR(255),
      gmb_access_token    TEXT,
      gmb_refresh_token   TEXT,
      google_rating       NUMERIC(2,1) DEFAULT 0,
      total_reviews       INTEGER DEFAULT 0,
      total_scans         INTEGER DEFAULT 0,
      reward_offer        VARCHAR(100) DEFAULT '20% OFF',
      reward_min_order    INTEGER DEFAULT 500,
      coupon_validity_days INTEGER DEFAULT 30,
      owner_name          VARCHAR(255),
      owner_email         VARCHAR(255),
      owner_phone         VARCHAR(20),
      joined_at           TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✅ brands table');

  // ── QR Codes ───────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS qr_codes (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      brand_id      UUID REFERENCES brands(id) ON DELETE CASCADE,
      table_label   VARCHAR(50),
      url           TEXT NOT NULL,
      scan_count    INTEGER DEFAULT 0,
      created_by    UUID REFERENCES users(id),   -- must be superadmin
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✅ qr_codes table');

  // ── QR Scans (each individual scan) ───────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS qr_scans (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      qr_id         UUID REFERENCES qr_codes(id) ON DELETE CASCADE,
      brand_id      UUID REFERENCES brands(id) ON DELETE CASCADE,
      user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
      scanned_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✅ qr_scans table');

  // ── Verification Sessions ──────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS verification_sessions (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      brand_id        UUID REFERENCES brands(id) ON DELETE CASCADE,
      user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
      user_name       VARCHAR(255) NOT NULL,
      review_text     TEXT,
      status          VARCHAR(20) DEFAULT 'pending',  -- 'pending'|'verified'|'expired'|'failed'
      poll_count      INTEGER DEFAULT 0,
      matched_review_id VARCHAR(255),
      stars_detected  INTEGER,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      verified_at     TIMESTAMPTZ,
      expires_at      TIMESTAMPTZ DEFAULT NOW() + INTERVAL '10 minutes'
    );
  `);
  console.log('✅ verification_sessions table');

  // ── Reviews (verified Google reviews) ─────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      brand_id        UUID REFERENCES brands(id) ON DELETE CASCADE,
      user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
      session_id      UUID REFERENCES verification_sessions(id),
      reviewer_name   VARCHAR(255),
      stars           INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
      review_text     TEXT,
      google_review_id VARCHAR(255),
      verified        BOOLEAN DEFAULT true,
      replied         BOOLEAN DEFAULT false,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✅ reviews table');

  // ── Private Feedback (1-3 stars, never public) ────────────
  await query(`
    CREATE TABLE IF NOT EXISTS private_feedback (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      brand_id    UUID REFERENCES brands(id) ON DELETE CASCADE,
      user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
      stars       INTEGER CHECK (stars BETWEEN 1 AND 3),
      chips       TEXT[],               -- array of complaint tags
      message     TEXT,
      is_read     BOOLEAN DEFAULT false,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✅ private_feedback table');

  // ── Coupons ────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS coupons (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code            VARCHAR(20) UNIQUE NOT NULL,
      brand_id        UUID REFERENCES brands(id) ON DELETE CASCADE,
      user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
      user_name       VARCHAR(255),
      user_email      VARCHAR(255),
      discount        VARCHAR(100) NOT NULL,
      min_order       INTEGER DEFAULT 0,
      source          VARCHAR(20) DEFAULT 'review',  -- 'review'|'ads'|'manual'
      status          VARCHAR(20) DEFAULT 'active',  -- 'active'|'redeemed'|'expired'
      redeemed_at     TIMESTAMPTZ,
      redeemed_by     VARCHAR(255),   -- cashier name
      issued_at       TIMESTAMPTZ DEFAULT NOW(),
      expires_at      TIMESTAMPTZ NOT NULL,
      session_id      UUID REFERENCES verification_sessions(id) ON DELETE SET NULL
    );
  `);
  console.log('✅ coupons table');

  // ── Ads ────────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS ads (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      brand_id    UUID REFERENCES brands(id) ON DELETE CASCADE,
      title       VARCHAR(255) NOT NULL,
      description TEXT,
      image_url   TEXT,
      active      BOOLEAN DEFAULT true,
      views       INTEGER DEFAULT 0,
      clicks      INTEGER DEFAULT 0,
      created_by  UUID REFERENCES users(id),   -- superadmin only
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✅ ads table');

  // ── Ad Views (track who watched what) ─────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS ad_views (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ad_id       UUID REFERENCES ads(id) ON DELETE CASCADE,
      user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
      watched_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(ad_id, user_id)
    );
  `);
  console.log('✅ ad_views table');

  // ── Banners ────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS banners (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      brand_id    UUID REFERENCES brands(id) ON DELETE CASCADE,
      title       VARCHAR(255) NOT NULL,
      image_url   TEXT,
      active      BOOLEAN DEFAULT true,
      created_by  UUID REFERENCES users(id),
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✅ banners table');

  // ── Customer Brand Visits ──────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS brand_visits (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
      brand_id    UUID REFERENCES brands(id) ON DELETE CASCADE,
      visited_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✅ brand_visits table');

  // ── Indexes for performance ────────────────────────────────
  await query(`CREATE INDEX IF NOT EXISTS idx_coupons_code     ON coupons(code);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_coupons_brand    ON coupons(brand_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_coupons_user     ON coupons(user_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_reviews_brand    ON reviews(brand_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_feedback_brand   ON private_feedback(brand_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_sessions_user    ON verification_sessions(user_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_sessions_brand   ON verification_sessions(brand_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_scans_brand      ON qr_scans(brand_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_visits_user      ON brand_visits(user_id);`);
  console.log('✅ indexes');

  console.log('\n🎉 All migrations complete!');
  await pool.end();
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
