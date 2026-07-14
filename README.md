# ResearchPro — Research Writing Business Platform

A complete, production-ready platform for a research writing business with:
- **Client accounts** — register, login, submit orders
- **Monnify payment integration** — pay per page (₦1,500/page)
- **Real-time chat** — Socket.io powered support chat
- **Admin dashboard** — manage orders and reply to clients

---

## 🛠 Prerequisites

| Requirement | Version |
|---|---|
| Node.js | **v22 or later** (required for `node:sqlite`) |
| npm | v10+ |

Check your version:
```bash
node --version   # must be v22.x.x or higher
npm --version
```

If you need Node v22, download it from https://nodejs.org or use a version manager:
```bash
# Using nvm (recommended)
nvm install 22
nvm use 22
```

---

## 🚀 Quick Start

### 1. Download & install dependencies
```bash
cd research-writing
npm install
```

### 2. Create your `.env` file
```bash
cp .env.example .env
```

Open `.env` and fill in your values (see Monnify setup below).

### 3. Start the server
```bash
npm start
```

Visit **http://localhost:3000**

---

## 🔑 Monnify Setup (Test Mode)

1. Sign up at https://app.monnify.com (free)
2. Go to **Settings → API Keys & Webhooks**
3. Copy your:
   - **API Key** → `MONNIFY_API_KEY`
   - **Secret Key** → `MONNIFY_SECRET_KEY`
   - **Contract Code** → `MONNIFY_CONTRACT_CODE` (found in Settings → Merchant Settings)
4. Set webhook URL (when deploying publicly):
   - `https://your-domain.com/webhook/monnify`
5. Keep `MONNIFY_BASE_URL=https://sandbox.monnify.com` for testing

**Test card numbers for sandbox:**
- Card: `5061 4600 0200 0000 000` | Expiry: any future date | CVV: `000` | OTP: `000000`

---

## 👤 Default Admin Account

| Field | Value |
|---|---|
| Email | admin@example.com |
| Password | admin123 |

**Change this password** in production by editing `app.js` line with `bcrypt.hashSync`.

---

## 📁 File Structure

```
research-writing/
├── app.js              # Main server (Express + Socket.io + SQLite)
├── package.json
├── .env.example        # Environment variable template
├── data.db             # SQLite database (auto-created on first run)
├── views/
│   ├── login.html
│   ├── register.html
│   ├── dashboard.html  # Client dashboard
│   └── admin.html      # Admin panel
└── public/
    ├── css/style.css
    └── js/chat.js      # Client chat widget logic
```

---

## ⚙️ Environment Variables

```env
PORT=3000                             # Server port
SESSION_SECRET=<long random string>   # Session signing secret
MONNIFY_API_KEY=MK_TEST_...          # From Monnify dashboard
MONNIFY_SECRET_KEY=...               # From Monnify dashboard
MONNIFY_CONTRACT_CODE=...            # From Monnify merchant settings
MONNIFY_BASE_URL=https://sandbox.monnify.com
APP_BASE_URL=http://localhost:3000   # Your public URL (for payment redirect)
```

---

## 💳 Payment Flow

1. Client submits an order → status: **pending**
2. Client clicks **Pay Now** → server initializes Monnify transaction
3. Client is redirected to Monnify checkout page
4. After payment, Monnify redirects to `/payment/verify?ref=...`
5. Server verifies with Monnify API → status updated to **paid**
6. Monnify also sends a webhook to `/webhook/monnify` as a backup

---

## 💬 Chat Flow

- Every logged-in client sees a chat widget (bottom-right)
- Messages are stored in SQLite and persist between sessions
- Admin logs in → goes to "Support Chat" tab → sees all client threads
- Admin can reply in real-time; client receives the message instantly

---

## 🚢 Deploying to Production

1. Set `APP_BASE_URL` to your real domain (e.g., `https://researchpro.ng`)
2. Change `MONNIFY_BASE_URL` to `https://api.monnify.com` (live mode)
3. Use live Monnify API keys
4. Use a process manager:
   ```bash
   npm install -g pm2
   pm2 start app.js --name researchpro
   pm2 save
   ```
5. Set up Nginx reverse proxy to port 3000
6. Use HTTPS (Let's Encrypt / Certbot)
7. Add Monnify HMAC signature verification in the `/webhook/monnify` handler

---

## ❓ Troubleshooting

**`node:sqlite` not found**
→ You need Node.js v22+. Run `node --version` and upgrade if needed.

**Payment gateway error**
→ Check that your `.env` Monnify credentials are correct and not empty.

**Port already in use**
→ Change `PORT=3001` in `.env` or stop the other process.

**Cannot connect to localhost after `npm start`**
→ Make sure you see `🚀 ResearchPro is running at http://localhost:3000` in the terminal.
