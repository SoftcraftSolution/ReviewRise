# ⭐ ReviewRise Backend — Setup & Deployment Guide

## What's included
```
reviewrise-backend/
├── src/
│   ├── server.js              ← Express entry point
│   ├── db/
│   │   ├── index.js           ← PostgreSQL connection pool
│   │   ├── migrate.js         ← Creates all 12 tables
│   │   └── seed.js            ← Demo data + admin account
│   ├── middleware/
│   │   └── auth.js            ← JWT verify + role guards
│   └── routes/
│       ├── auth.js            ← Google OAuth + email login
│       ├── brands.js          ← Brand CRUD
│       ├── coupons.js         ← Verify / redeem / generate
│       ├── verify.js          ← GMB polling engine (THE CORE)
│       └── misc.js            ← Reviews, feedback, ads, banners, customers, QR, stats
├── package.json
├── .env.example
└── README.md
```

---

## 🚀 Option A — Local Development (5 minutes)

### 1. Install PostgreSQL locally
```bash
# macOS
brew install postgresql && brew services start postgresql

# Ubuntu/Debian
sudo apt install postgresql && sudo service postgresql start

# Windows: Download from https://www.postgresql.org/download/windows/
```

### 2. Create database
```bash
psql -U postgres
CREATE DATABASE reviewrise;
\q
```

### 3. Install & configure
```bash
cd reviewrise-backend
npm install

# Copy and fill in your .env
cp .env.example .env
```

Edit `.env`:
```
DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/reviewrise
JWT_SECRET=generate_a_64_char_random_string_here
SUPERADMIN_EMAIL=admin@softcraftsolutions.in
SUPERADMIN_PASSWORD=YourStrongPassword@123
```

### 4. Run migrations + seed
```bash
npm run db:reset
```

### 5. Start server
```bash
npm run dev    # development (auto-restarts)
npm start      # production
```

### 6. Test it's working
```bash
curl http://localhost:3001/health
# → {"status":"ok","service":"ReviewRise API",...}
```

---

## 🌐 Option B — Deploy to Railway (FREE, 10 minutes)

Railway gives you a free PostgreSQL + Node.js server.

### Step 1 — Sign up
Go to https://railway.app → Sign up with GitHub

### Step 2 — Create project
Click **New Project** → **Deploy from GitHub repo**
(Push this backend folder to a GitHub repo first)

### Step 3 — Add PostgreSQL
In your Railway project → **New** → **Database** → **PostgreSQL**
Copy the `DATABASE_URL` from the Variables tab

### Step 4 — Set environment variables
In your Railway service → **Variables** → add all from `.env.example`:
```
DATABASE_URL=<from railway postgres>
JWT_SECRET=<generate random 64 chars>
NODE_ENV=production
SUPERADMIN_EMAIL=admin@softcraftsolutions.in
SUPERADMIN_PASSWORD=YourStrongPassword@123
GOOGLE_CLIENT_ID=<from google console>
FRONTEND_URL=https://your-frontend.vercel.app
```

### Step 5 — Run migrations
In Railway terminal or locally with the Railway DB URL:
```bash
DATABASE_URL=<railway_url> npm run db:migrate
DATABASE_URL=<railway_url> npm run db:seed
```

### Step 6 — Done!
Railway gives you a URL like `https://reviewrise-backend.railway.app`

---

## 🔑 Google OAuth Setup (Required for customer login)

1. Go to https://console.cloud.google.com
2. Create a new project called "ReviewRise"
3. Enable APIs: **Google Identity**, **My Business API**, **Places API**
4. Go to **Credentials** → **Create OAuth 2.0 Client ID**
5. Application type: **Web application**
6. Add authorized redirect URIs:
   - `http://localhost:3000` (dev)
   - `https://your-frontend.vercel.app` (prod)
7. Copy **Client ID** → paste in `.env` as `GOOGLE_CLIENT_ID`

---

## 🏢 Google My Business API Setup (Required for review verification)

This is what makes verification real. Each brand connects their GMB account once.

1. In Google Cloud Console → **Enable "My Business Business Information API"**
2. Each brand owner visits: `https://your-domain.com/api/auth/gmb-connect?brandId=xxx`
   (You'll build this OAuth flow later — for now dev mode auto-verifies after 3 polls)
3. After they authorize, you get `access_token` + `refresh_token`
4. Store in `brands.gmb_access_token` + `brands.gmb_refresh_token`
5. Get their `account_id` and `location_id` from GMB API and store in brands table

> **Dev Mode:** Until GMB is connected, the server auto-verifies after 3 polls (45 seconds).
> This lets you test the full flow without GMB. Search for "DEV MODE" in `verify.js` to remove it.

---

## 🔗 Connecting the Frontend (React apps)

Replace the simulated API calls in your React apps with real fetch calls:

### Example: Customer login
```javascript
// In CustomerReviewFlow.jsx — replace handleGoogleLogin
const handleGoogleLogin = async () => {
  // 1. Get Google token using Google Identity Services
  const googleToken = await getGoogleToken(); // your OAuth implementation

  // 2. Send to your backend
  const res = await fetch('https://your-api.railway.app/api/auth/google', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: googleToken }),
  });
  const { token, user } = await res.json();

  // 3. Store JWT
  localStorage.setItem('rr_token', token);
  setUser(user);
};
```

### Example: Create verification session
```javascript
const startVerification = async (brandId, reviewText) => {
  const res = await fetch('/api/verify/session', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${localStorage.getItem('rr_token')}`,
    },
    body: JSON.stringify({ brand_id: brandId, review_text: reviewText }),
  });
  return res.json(); // { session_id, expires_at, google_review_url }
};
```

### Example: Poll for verification
```javascript
const pollVerification = async (sessionId) => {
  const res = await fetch(`/api/verify/poll/${sessionId}`, {
    headers: { 'Authorization': `Bearer ${localStorage.getItem('rr_token')}` },
  });
  return res.json(); // { status: 'pending'|'verified'|'expired', coupon? }
};
```

### Example: Verify coupon (cashier)
```javascript
const verifyCoupon = async (code) => {
  const res = await fetch('/api/coupons/verify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${localStorage.getItem('rr_token')}`,
    },
    body: JSON.stringify({ code }),
  });
  return res.json(); // { valid: true|false, coupon?: {...} }
};
```

---

## 📋 Full API Reference

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| POST | `/api/auth/google` | None | Customer Google login |
| POST | `/api/auth/login` | None | Admin/Brand email login |
| GET | `/api/auth/me` | JWT | Get current user |
| GET | `/api/brands` | None | All active brands (public) |
| GET | `/api/brands/all` | SuperAdmin | All brands |
| POST | `/api/brands` | SuperAdmin | Register new brand |
| PUT | `/api/brands/:id` | Owner | Update brand |
| DELETE | `/api/brands/:id` | SuperAdmin | Remove brand |
| GET | `/api/brands/:id/stats` | Owner | Brand analytics |
| POST | `/api/verify/session` | Customer | Start verification |
| GET | `/api/verify/poll/:id` | Customer | Poll GMB for review |
| POST | `/api/verify/feedback` | Customer | Submit private feedback |
| POST | `/api/coupons/verify` | BrandOwner | Verify coupon code |
| POST | `/api/coupons/redeem` | BrandOwner | Mark coupon redeemed |
| POST | `/api/coupons/generate` | BrandOwner | Generate manual coupon |
| GET | `/api/coupons/my` | Customer | Customer's own coupons |
| GET | `/api/ads` | None | Active ads (public) |
| POST | `/api/ads` | SuperAdmin | Create ad |
| PATCH | `/api/ads/:id/toggle` | SuperAdmin | Pause/resume ad |
| POST | `/api/ads/:id/view` | Customer | Record ad view, earn reward |
| GET | `/api/banners` | None | Active banners (public) |
| POST | `/api/banners` | SuperAdmin | Add banner |
| PATCH | `/api/banners/:id/toggle` | SuperAdmin | Show/hide banner |
| GET | `/api/customers` | SuperAdmin | All customers + activity |
| GET | `/api/customers/:id/activity` | SuperAdmin | Full customer activity log |
| POST | `/api/qr` | SuperAdmin | Generate QR code |
| GET | `/api/stats/platform` | SuperAdmin | Platform-wide stats |
| GET | `/api/stats/brand/:id/trend` | Owner | Review trend data |

---

## 🗄️ Database Schema Summary

| Table | Purpose |
|-------|---------|
| `users` | All users (customers, brand owners, superadmin) |
| `brands` | Registered businesses |
| `qr_codes` | QR codes per brand/table (superadmin only) |
| `qr_scans` | Each individual scan event |
| `verification_sessions` | Pending/verified review sessions |
| `reviews` | Verified Google reviews |
| `private_feedback` | 1-3 star feedback (never public) |
| `coupons` | All issued coupons (review, ads, manual) |
| `ads` | Ad campaigns |
| `ad_views` | Who watched what ad |
| `banners` | Promotional banners |
| `brand_visits` | Customer visit history per brand |

---

## 🔐 Default Login Credentials (after seed)

| Role | Email | Password |
|------|-------|----------|
| Super Admin | admin@softcraftsolutions.in | (from .env) |
| Brand Owner | spice@gmail.com | BrandOwner@123 |
| Customer | rahul@gmail.com | Google OAuth |

---

## 📞 Next Steps

1. ✅ Deploy backend to Railway
2. ✅ Connect Google OAuth
3. → Connect GMB API per brand
4. → Deploy frontend to Vercel
5. → Replace simulated API calls with real fetch calls
6. → Set up WhatsApp notifications via Twilio/WATI
7. → Add Razorpay for subscription billing

**SoftCraft Solutions · ReviewRise v1.0**
