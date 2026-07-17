'use strict';
require('dotenv').config();

const http        = require('http');
const path        = require('path');
const { randomUUID } = require('crypto');

const express     = require('express');
const session     = require('express-session');
const { Server }  = require('socket.io');
const bcrypt      = require('bcryptjs');
const axios       = require('axios');
const nodemailer  = require('nodemailer');
const multer      = require('multer');
const fs          = require('fs');

const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(path.join(__dirname, 'data.db'));

// ─── PRICE MAPPING (NGN only) ──────────────────────────────────────────────
const PRICE_MAP = {
  'undergraduate': 60000,
  'masters': 80000,
  'pgd': 120000,
  'phd': 250000,
  'assignment': 10000,
  'term_paper': 30000
};

// ─── MULTER CONFIGURATION ────────────────────────────────────────────────────
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only PDF, DOC, DOCX, and TXT files are allowed'), false);
  }
};

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: fileFilter
});

// ─── DATABASE BOOTSTRAP ──────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT    NOT NULL,
    email     TEXT    NOT NULL UNIQUE,
    password  TEXT    NOT NULL,
    role      TEXT    NOT NULL DEFAULT 'client',
    created_at TEXT   DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
    title         TEXT    NOT NULL,
    subject       TEXT    NOT NULL,
    deadline      TEXT    NOT NULL,
    pages         INTEGER NOT NULL,
    description   TEXT,
    amount        REAL    NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'pending',
    payment_ref   TEXT,
    created_at    TEXT    DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    sender     TEXT    NOT NULL,
    body       TEXT    NOT NULL,
    created_at TEXT    DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS writer_applications (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    email         TEXT    NOT NULL UNIQUE,
    qualifications TEXT   NOT NULL,
    resume_url    TEXT,
    status        TEXT    NOT NULL DEFAULT 'pending',
    applied_at    TEXT    DEFAULT (datetime('now')),
    reviewed_at   TEXT,
    reviewed_by   INTEGER,
    FOREIGN KEY (reviewed_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS writer_assignments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id      INTEGER NOT NULL,
    writer_id     INTEGER NOT NULL,
    assigned_at   TEXT    DEFAULT (datetime('now')),
    completed_at  TEXT,
    file_path     TEXT,
    file_name     TEXT,
    status        TEXT    DEFAULT 'assigned',
    notes         TEXT,
    FOREIGN KEY (order_id) REFERENCES orders(id),
    FOREIGN KEY (writer_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS order_files (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id      INTEGER NOT NULL,
    uploaded_by   INTEGER NOT NULL,
    uploader_role TEXT    NOT NULL,
    file_path     TEXT    NOT NULL,
    file_name     TEXT    NOT NULL,
    file_size     INTEGER,
    description   TEXT,
    uploaded_at   TEXT    DEFAULT (datetime('now')),
    FOREIGN KEY (order_id) REFERENCES orders(id),
    FOREIGN KEY (uploaded_by) REFERENCES users(id)
  );
`);

// ─── MIGRATE ORDERS TABLE ────────────────────────────────────────────────────
try { db.exec('ALTER TABLE orders ADD COLUMN order_type TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE orders ADD COLUMN paid_amount REAL DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE orders ADD COLUMN total_amount REAL'); } catch(e) {}
db.exec('UPDATE orders SET total_amount = amount WHERE total_amount IS NULL AND amount IS NOT NULL');
db.exec('UPDATE orders SET paid_amount = 0 WHERE paid_amount IS NULL');

// ─── SEED ACCOUNTS ────────────────────────────────────────────────────────────
// Admin
const adminExists = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@example.com');
if (!adminExists) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (name,email,password,role) VALUES (?,?,?,?)').run('Admin', 'admin@example.com', hash, 'admin');
  console.log('Admin account created → admin@example.com / admin123');
}

// Writer
const writerExists = db.prepare('SELECT id FROM users WHERE email = ?').get('writer@example.com');
if (!writerExists) {
  const hash = bcrypt.hashSync('writer123', 10);
  db.prepare('INSERT INTO users (name,email,password,role) VALUES (?,?,?,?)').run('Staff Writer', 'writer@example.com', hash, 'writer');
  console.log('Writer account created → writer@example.com / writer123');
}

// Support
const supportExists = db.prepare('SELECT id FROM users WHERE email = ?').get('support@example.com');
if (!supportExists) {
  const hash = bcrypt.hashSync('support123', 10);
  db.prepare('INSERT INTO users (name,email,password,role) VALUES (?,?,?,?)').run('Support Rep', 'support@example.com', hash, 'support');
  console.log('Support account created → support@example.com / support123');
}

// ─── EMAIL TRANSPORTER ───────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: parseInt(process.env.EMAIL_PORT),
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  socketTimeout: 30000,        // 30 seconds
  connectionTimeout: 30000,    // 30 seconds
});

// Verify transporter connection (optional, prints success/failure)
transporter.verify((error, success) => {
  if (error) {
    console.error('⚠️ Email transporter error:', error);
  } else {
    console.log('✅ Email transporter is ready');
  }
});

// ─── EMAIL HELPER FUNCTION ──────────────────────────────────────────────────
async function sendEmail(to, subject, html) {
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to,
      subject,
      html,
    });
    console.log(`📧 Email sent to ${to}`);
    return true;
  } catch (err) {
    console.error(`❌ Email failed to ${to}:`, err.message);
    return false;
  }
}

// ─── EXPRESS APP ─────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.set('view engine', 'html');
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
});
app.use(sessionMiddleware);
io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

// ─── AUTH HELPERS ─────────────────────────────────────────────────────────────
function requireLogin(req, res, next) {
  if (req.session.userId) return next();
  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
}
function requireAdmin(req, res, next) {
  if (req.session.role === 'admin') return next();
  res.status(403).json({ error: 'Forbidden' });
}

// ─── MONNIFY HELPERS ──────────────────────────────────────────────────────────
async function getMonnifyToken() {
  const credentials = Buffer.from(`${process.env.MONNIFY_API_KEY}:${process.env.MONNIFY_SECRET_KEY}`).toString('base64');
  const { data } = await axios.post(`${process.env.MONNIFY_BASE_URL}/api/v1/auth/login`, {}, { headers: { Authorization: `Basic ${credentials}` } });
  return data.responseBody.accessToken;
}

async function initMonnifyTransaction({ amount, ref, email, name, description }) {
  const token = await getMonnifyToken();
  const { data } = await axios.post(`${process.env.MONNIFY_BASE_URL}/api/v1/merchant/transactions/init-transaction`, {
    amount,
    customerName: name,
    customerEmail: email,
    paymentReference: ref,
    paymentDescription: description,
    currencyCode: 'NGN',
    contractCode: process.env.MONNIFY_CONTRACT_CODE,
    redirectUrl: `${process.env.APP_BASE_URL}/payment/verify?ref=${ref}`,
    paymentMethods: ['CARD', 'ACCOUNT_TRANSFER']
  }, { headers: { Authorization: `Bearer ${token}` } });
  return data.responseBody;
}

async function verifyMonnifyPayment(ref) {
  const token = await getMonnifyToken();
  const encodedRef = encodeURIComponent(ref);
  const { data } = await axios.get(`${process.env.MONNIFY_BASE_URL}/api/v1/merchant/transactions/query?paymentReference=${encodedRef}`, { headers: { Authorization: `Bearer ${token}` } });
  return data.responseBody;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES – PUBLIC PAGES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'views/index.html')));
app.get('/about',   (_req, res) => res.sendFile(path.join(__dirname, 'views/about.html')));
app.get('/contact', (_req, res) => res.sendFile(path.join(__dirname, 'views/contact.html')));
app.get('/login',    (_req, res) => res.sendFile(path.join(__dirname, 'views/login.html')));
app.get('/register', (_req, res) => res.sendFile(path.join(__dirname, 'views/register.html')));
app.get('/apply',   (_req, res) => res.sendFile(path.join(__dirname, 'views/apply.html')));

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES – AUTH API
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.json({ ok: false, msg: 'All fields are required.' });
  const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if (existing) return res.json({ ok: false, msg: 'Email already registered.' });
  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (name,email,password) VALUES (?,?,?)').run(name, email, hash);
  req.session.userId = result.lastInsertRowid;
  req.session.name   = name;
  req.session.email  = email;
  req.session.role   = 'client';

  // Send welcome email (async, non-blocking)
  (async () => {
    await sendEmail(
      email,
      'Welcome to DBRAM Research',
      `<h2>Hello ${name},</h2>
       <p>Thank you for registering with DBRAM Research.</p>
       <p>You can now <a href="${process.env.APP_BASE_URL}/login">log in</a> and start placing orders.</p>
       <p>Best regards,<br>DBRAM Research Team</p>`
    );
  })();

  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password)) return res.json({ ok: false, msg: 'Invalid email or password.' });
  req.session.userId = user.id;
  req.session.name   = user.name;
  req.session.email  = user.email;
  req.session.role   = user.role;

  let redirect = '/dashboard';
  if (user.role === 'admin') redirect = '/admin';
  else if (user.role === 'writer') redirect = '/writer';
  else if (user.role === 'support') redirect = '/support';
  else redirect = '/dashboard';

  res.json({ ok: true, role: user.role, redirect });
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES – DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/dashboard', requireLogin, (req, res) => {
  if (req.session.role === 'admin') return res.sendFile(path.join(__dirname, 'views/admin.html'));
  if (req.session.role === 'writer') return res.sendFile(path.join(__dirname, 'views/writer.html'));
  if (req.session.role === 'support') return res.sendFile(path.join(__dirname, 'views/support.html'));
  res.sendFile(path.join(__dirname, 'views/dashboard.html'));
});

app.get('/writer', requireLogin, (req, res) => {
  if (req.session.role !== 'writer') return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'views/writer.html'));
});
app.get('/support', requireLogin, (req, res) => {
  if (req.session.role !== 'support') return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'views/support.html'));
});
app.get('/admin', requireLogin, (req, res) => {
  if (req.session.role !== 'admin') return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'views/admin.html'));
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES – ORDERS API
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/price', (req, res) => {
  const { orderType } = req.body;
  const price = PRICE_MAP[orderType];
  if (!price) return res.json({ ok: false, msg: 'Invalid order type' });
  res.json({ ok: true, price });
});

app.post('/api/orders', requireLogin, (req, res) => {
  const { title, subject, orderType, deadline, pages, description } = req.body;
  if (!title || !subject || !orderType || !deadline || !pages) return res.json({ ok: false, msg: 'All required fields must be filled.' });
  const totalAmount = PRICE_MAP[orderType];
  if (!totalAmount) return res.json({ ok: false, msg: 'Invalid order type' });
  const result = db.prepare(`
    INSERT INTO orders (user_id, title, subject, order_type, deadline, pages, description, total_amount, amount)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(req.session.userId, title, subject, orderType, deadline, pages, description || '', totalAmount, totalAmount);
  res.json({ ok: true, orderId: result.lastInsertRowid, totalAmount });
});

app.get('/api/orders', requireLogin, (req, res) => {
  let orders;
  if (req.session.role === 'admin' || req.session.role === 'writer' || req.session.role === 'support') {
    orders = db.prepare(`
      SELECT o.*, u.name as client_name, u.email as client_email
      FROM orders o JOIN users u ON o.user_id=u.id
      ORDER BY o.created_at DESC
    `).all();
  } else {
    orders = db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC').all(req.session.userId);
  }
  res.json(orders);
});

app.patch('/api/orders/:id/status', requireLogin, async (req, res) => {
  const { status } = req.body;
  const orderId = req.params.id;
  const role = req.session.role;

  // Permission check
  if (role === 'admin') {
    db.prepare('UPDATE orders SET status=? WHERE id=?').run(status, orderId);
    // If status is 'completed', notify client
    if (status === 'completed') {
      const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(order.user_id);
      if (user && user.email) {
        await sendEmail(
          user.email,
          'Order Completed – Order #' + order.id,
          `<h2>Your Order is Complete</h2>
           <p>Your order "${order.title}" has been marked as completed.</p>
           <p>You can now download the final file from your dashboard.</p>
           <p>Thank you for using DBRAM Research.</p>`
        );
      }
    }
    return res.json({ ok: true });
  }
  if (role === 'writer' && (status === 'in_progress' || status === 'completed')) {
    db.prepare('UPDATE orders SET status=? WHERE id=?').run(status, orderId);
    return res.json({ ok: true });
  }
  res.status(403).json({ ok: false, msg: 'Not allowed to change status to ' + status });
});

app.delete('/api/orders/:id', requireLogin, requireAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM orders WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch(err) {
    res.status(500).json({ ok: false });
  }
});

app.get('/api/me', requireLogin, (req, res) => {
  res.json({ id: req.session.userId, name: req.session.name, email: req.session.email, role: req.session.role });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES – PAYMENTS
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/pay/:orderId', requireLogin, async (req, res) => {
  const { percentage } = req.body;
  const order = db.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(req.params.orderId, req.session.userId);
  if (!order) return res.json({ ok: false, msg: 'Order not found.' });

  let amountToPay = 0, newStatus = order.status;
  if (percentage === '60') {
    if (order.paid_amount >= order.total_amount * 0.6) return res.json({ ok: false, msg: 'Already paid 60% or more.' });
    amountToPay = order.total_amount * 0.6;
    newStatus = 'partially_paid';
  } else if (percentage === '100') {
    const remaining = order.total_amount - order.paid_amount;
    if (remaining <= 0) return res.json({ ok: false, msg: 'Order already fully paid.' });
    amountToPay = remaining;
    newStatus = 'paid';
  } else {
    return res.json({ ok: false, msg: 'Invalid payment percentage.' });
  }

  const ref = `RW-${order.id}-${randomUUID().split('-')[0].toUpperCase()}`;
  db.prepare('UPDATE orders SET payment_ref=? WHERE id=?').run(ref, order.id);

  try {
    const txn = await initMonnifyTransaction({
      amount: amountToPay,
      ref,
      email: req.session.email,
      name: req.session.name,
      description: `Payment for: ${order.title} (${percentage}%)`
    });
    if (!global.pendingPayments) global.pendingPayments = new Map();
    global.pendingPayments.set(ref, { orderId: order.id, amountToPay, newStatus, userId: req.session.userId });
    res.json({ ok: true, checkoutUrl: txn.checkoutUrl, ref });
  } catch (err) {
    console.error('Monnify init error:', err?.response?.data || err.message);
    res.json({ ok: false, msg: 'Payment gateway error. Check your Monnify credentials.' });
  }
});

app.get('/payment/verify', async (req, res) => {
  const { ref } = req.query;
  if (!ref) return res.redirect('/dashboard?payment=failed');
  try {
    const txn = await verifyMonnifyPayment(ref);
    if (txn && txn.paymentStatus === 'PAID') {
      const pending = global.pendingPayments?.get(ref);
      let orderId, newStatus;
      if (pending) {
        orderId = pending.orderId;
        newStatus = pending.newStatus;
        const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
        const newPaidAmount = order.paid_amount + pending.amountToPay;
        db.prepare('UPDATE orders SET paid_amount=?, status=? WHERE id=?').run(newPaidAmount, newStatus, orderId);
        global.pendingPayments.delete(ref);
      } else {
        // fallback: mark as paid
        const order = db.prepare('SELECT * FROM orders WHERE payment_ref=?').get(ref);
        if (order) {
          orderId = order.id;
          newStatus = 'paid';
          db.prepare("UPDATE orders SET status='paid' WHERE payment_ref=?").run(ref);
        }
      }
      // Send payment confirmation email to client
      if (orderId) {
        const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
        const user = db.prepare('SELECT * FROM users WHERE id=?').get(order.user_id);
        if (user && user.email) {
          await sendEmail(
            user.email,
            'Payment Confirmation – Order #' + order.id,
            `<h2>Payment Received</h2>
             <p>Your payment for order "${order.title}" has been confirmed.</p>
             <p>Total paid: ₦${order.total_amount}</p>
             <p>We'll begin working on your order shortly.</p>`
          );
        }
      }
      return res.redirect('/dashboard?payment=success');
    }
    res.redirect('/dashboard?payment=failed');
  } catch (err) {
    console.error('Verify error:', err?.response?.data || err.message);
    res.redirect('/dashboard?payment=failed');
  }
});

app.post('/webhook/monnify', express.json(), async (req, res) => {
  const body = req.body;
  if (body?.eventData?.paymentStatus === 'PAID') {
    const ref = body.eventData.paymentReference;
    const pending = global.pendingPayments?.get(ref);
    let orderId, newStatus;
    if (pending) {
      orderId = pending.orderId;
      newStatus = pending.newStatus;
      const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
      const newPaidAmount = order.paid_amount + pending.amountToPay;
      db.prepare('UPDATE orders SET paid_amount=?, status=? WHERE id=?').run(newPaidAmount, newStatus, orderId);
      global.pendingPayments.delete(ref);
    } else {
      const order = db.prepare('SELECT * FROM orders WHERE payment_ref=?').get(ref);
      if (order) {
        orderId = order.id;
        newStatus = 'paid';
        db.prepare("UPDATE orders SET status='paid' WHERE payment_ref=?").run(ref);
      }
    }
    // Send payment confirmation email to client via webhook
    if (orderId) {
      const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(order.user_id);
      if (user && user.email) {
        await sendEmail(
          user.email,
          'Payment Confirmation – Order #' + order.id,
          `<h2>Payment Received</h2>
           <p>Your payment for order "${order.title}" has been confirmed.</p>
           <p>Total paid: ₦${order.total_amount}</p>
           <p>We'll begin working on your order shortly.</p>`
        );
      }
    }
    console.log(`Webhook: order updated for ref ${ref}`);
  }
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES – CHAT (including client history access)
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/chat/messages', requireLogin, (req, res) => {
  const role = req.session.role;
  const userId = req.session.userId;
  let targetUserId = req.query.userId;

  // If admin or support, they can view any user's messages (or if no target, return empty)
  if (role === 'admin' || role === 'support') {
    if (!targetUserId) return res.json([]);
  } else {
    // Client can only view their own messages
    targetUserId = userId;
  }

  const rows = db.prepare('SELECT * FROM messages WHERE user_id=? ORDER BY created_at ASC').all(targetUserId);
  res.json(rows);
});

app.get('/api/chat/threads', requireLogin, (req, res) => {
  if (req.session.role !== 'admin' && req.session.role !== 'support') {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const threads = db.prepare(`
    SELECT u.id, u.name, u.email,
           COUNT(m.id) as msg_count,
           MAX(m.created_at) as last_msg
    FROM users u
    LEFT JOIN messages m ON m.user_id=u.id
    WHERE u.role='client'
    GROUP BY u.id
    ORDER BY last_msg DESC NULLS LAST
  `).all();
  res.json(threads);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES – WRITER PORTAL
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/writer/apply', async (req, res) => {
  const { name, email, qualifications } = req.body;
  if (!name || !email || !qualifications) {
    return res.json({ ok: false, msg: 'All fields are required.' });
  }
  try {
    const existing = db.prepare('SELECT id FROM writer_applications WHERE email = ?').get(email);
    if (existing) return res.json({ ok: false, msg: 'You have already applied.' });

    db.prepare(`
      INSERT INTO writer_applications (name, email, qualifications)
      VALUES (?, ?, ?)
    `).run(name, email, qualifications);

    res.json({ ok: true, msg: 'Application submitted successfully!' });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, msg: 'Database error.' });
  }
});

app.get('/api/admin/writer-applications', requireLogin, requireAdmin, (req, res) => {
  const apps = db.prepare(`
    SELECT wa.*, u.name as reviewer_name
    FROM writer_applications wa
    LEFT JOIN users u ON wa.reviewed_by = u.id
    ORDER BY wa.applied_at DESC
  `).all();
  res.json(apps);
});

app.post('/api/admin/writer-applications/:id/review', requireLogin, requireAdmin, async (req, res) => {
  const { status } = req.body;
  const appId = req.params.id;
  const reviewerId = req.session.userId;

  if (!['approved', 'rejected'].includes(status)) {
    return res.json({ ok: false, msg: 'Invalid status.' });
  }

  try {
    const app = db.prepare('SELECT * FROM writer_applications WHERE id = ?').get(appId);
    if (!app) return res.json({ ok: false, msg: 'Application not found.' });

    db.prepare(`
      UPDATE writer_applications
      SET status = ?, reviewed_at = datetime('now'), reviewed_by = ?
      WHERE id = ?
    `).run(status, reviewerId, appId);

    if (status === 'approved') {
      const tempPassword = Math.random().toString(36).slice(-8);
      const hash = bcrypt.hashSync(tempPassword, 10);
      db.prepare(`
        INSERT INTO users (name, email, password, role)
        VALUES (?, ?, ?, 'writer')
      `).run(app.name, app.email, hash);

      // Send email to writer with credentials
      await sendEmail(
        app.email,
        'Welcome to DBRAM Research – Writer Account Created',
        `<h2>Hello ${app.name},</h2>
         <p>Your writer application has been <strong>approved</strong>!</p>
         <p><strong>Your login credentials:</strong><br>
         Email: ${app.email}<br>
         Password: ${tempPassword}</p>
         <p><a href="${process.env.APP_BASE_URL}/writer">Click here to log in</a></p>
         <p>After logging in, please change your password.</p>
         <br>
         <p>Best regards,<br>DBRAM Research Team</p>`
      );
    }

    res.json({ ok: true, msg: `Application ${status}.` });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, msg: 'Database error.' });
  }
});

app.post('/api/admin/assign-order', requireLogin, requireAdmin, async (req, res) => {
  const { orderId, writerId } = req.body;
  if (!orderId || !writerId) {
    return res.json({ ok: false, msg: 'Order and writer are required.' });
  }

  try {
    const existing = db.prepare("SELECT id FROM writer_assignments WHERE order_id = ? AND status != 'submitted'").get(orderId);
    if (existing) return res.json({ ok: false, msg: 'This order is already assigned to a writer.' });

    const writer = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'writer'").get(writerId);
    if (!writer) return res.json({ ok: false, msg: 'Writer not found.' });

    db.prepare(`
      INSERT INTO writer_assignments (order_id, writer_id, status)
      VALUES (?, ?, 'assigned')
    `).run(orderId, writerId);

    // Send email to writer
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    const writerUser = db.prepare('SELECT * FROM users WHERE id=?').get(writerId);
    if (writerUser && writerUser.email) {
      await sendEmail(
        writerUser.email,
        'New Order Assigned – Order #' + order.id,
        `<h2>New Assignment</h2>
         <p>You have been assigned to work on order: "${order.title}".</p>
         <p>Please log in to your <a href="${process.env.APP_BASE_URL}/writer">writer dashboard</a> to view details.</p>`
      );
    }

    res.json({ ok: true, msg: 'Order assigned to writer.' });
  } catch (err) {
    console.error('Assign error:', err);
    res.json({ ok: false, msg: 'Database error: ' + err.message });
  }
});

app.get('/api/writer/jobs', requireLogin, (req, res) => {
  if (req.session.role !== 'writer') {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const writerId = req.session.userId;
  const jobs = db.prepare(`
    SELECT wa.*, o.title, o.subject, o.deadline, o.pages, o.description, u.name as client_name
    FROM writer_assignments wa
    JOIN orders o ON wa.order_id = o.id
    JOIN users u ON o.user_id = u.id
    WHERE wa.writer_id = ?
    ORDER BY wa.assigned_at DESC
  `).all(writerId);
  res.json(jobs);
});

app.patch('/api/writer/jobs/:id/status', requireLogin, (req, res) => {
  if (req.session.role !== 'writer') {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const { status } = req.body;
  const jobId = req.params.id;
  const writerId = req.session.userId;

  const job = db.prepare('SELECT * FROM writer_assignments WHERE id = ? AND writer_id = ?').get(jobId, writerId);
  if (!job) return res.status(404).json({ ok: false, msg: 'Job not found.' });

  db.prepare('UPDATE writer_assignments SET status = ? WHERE id = ?').run(status, jobId);
  res.json({ ok: true });
});

app.post('/api/writer/jobs/:id/upload', requireLogin, upload.single('file'), async (req, res) => {
  if (req.session.role !== 'writer') {
    return res.status(403).json({ ok: false, msg: 'Unauthorized' });
  }

  const jobId = req.params.id;
  const writerId = req.session.userId;

  const job = db.prepare('SELECT * FROM writer_assignments WHERE id = ? AND writer_id = ?').get(jobId, writerId);
  if (!job) return res.status(404).json({ ok: false, msg: 'Job not found.' });

  if (!req.file) {
    return res.json({ ok: false, msg: 'No file uploaded.' });
  }

  try {
    db.prepare(`
      UPDATE writer_assignments
      SET file_path = ?, file_name = ?, status = 'submitted', completed_at = datetime('now')
      WHERE id = ?
    `).run(req.file.path, req.file.originalname, jobId);

    // Notify client and admin
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(job.order_id);
    const client = db.prepare('SELECT * FROM users WHERE id=?').get(order.user_id);
    const admin = db.prepare('SELECT * FROM users WHERE role = "admin" LIMIT 1').get();

    if (client && client.email) {
      await sendEmail(
        client.email,
        'File Uploaded for Your Order #' + order.id,
        `<h2>Writer Has Submitted a File</h2>
         <p>The writer has uploaded a file for your order: "${order.title}".</p>
         <p>Log in to your dashboard to view the file.</p>`
      );
    }
    if (admin && admin.email) {
      await sendEmail(
        admin.email,
        'Writer Submitted File for Order #' + order.id,
        `<h2>File Uploaded</h2>
         <p>Writer has uploaded a file for order "${order.title}" by client ${client?.name || 'Unknown'}.</p>`
      );
    }

    res.json({ ok: true, msg: 'File uploaded successfully!', file: req.file.originalname });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, msg: 'Database error.' });
  }
});

app.get('/api/admin/assignments', requireLogin, requireAdmin, (req, res) => {
  const assignments = db.prepare(`
    SELECT wa.*, o.title as order_title, u.name as writer_name, u.email as writer_email
    FROM writer_assignments wa
    JOIN orders o ON wa.order_id = o.id
    JOIN users u ON wa.writer_id = u.id
    ORDER BY wa.assigned_at DESC
  `).all();
  res.json(assignments);
});

app.get('/api/admin/download/:assignmentId', requireLogin, requireAdmin, (req, res) => {
  const assignment = db.prepare('SELECT file_path, file_name FROM writer_assignments WHERE id = ?').get(req.params.assignmentId);
  if (!assignment || !assignment.file_path) {
    return res.status(404).json({ error: 'File not found.' });
  }

  if (!fs.existsSync(assignment.file_path)) {
    return res.status(404).json({ error: 'File not found on server.' });
  }

  res.download(assignment.file_path, assignment.file_name);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES – FILE MANAGEMENT (Client/Writer/Admin)
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/orders/:orderId/files', requireLogin, upload.single('file'), async (req, res) => {
  const orderId = req.params.orderId;
  const userId = req.session.userId;
  const userRole = req.session.role;
  const { description } = req.body;

  let order;
  if (userRole === 'admin') {
    order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  } else if (userRole === 'writer') {
    const assignment = db.prepare('SELECT * FROM writer_assignments WHERE order_id = ? AND writer_id = ?').get(orderId, userId);
    if (assignment) {
      order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    }
  } else {
    order = db.prepare('SELECT * FROM orders WHERE user_id = ? AND id = ?').get(userId, orderId);
  }
  if (!order) return res.status(404).json({ ok: false, msg: 'Order not found.' });

  if (!req.file) {
    return res.json({ ok: false, msg: 'No file uploaded.' });
  }

  try {
    db.prepare(`
      INSERT INTO order_files (order_id, uploaded_by, uploader_role, file_path, file_name, file_size, description)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(orderId, userId, userRole, req.file.path, req.file.originalname, req.file.size, description || '');

    res.json({ ok: true, msg: 'File uploaded successfully.', file: req.file.originalname });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, msg: 'Database error.' });
  }
});

app.get('/api/orders/:orderId/files', requireLogin, (req, res) => {
  const orderId = req.params.orderId;
  const userId = req.session.userId;
  const userRole = req.session.role;

  let hasAccess = false;
  if (userRole === 'admin') {
    hasAccess = true;
  } else if (userRole === 'writer') {
    const assignment = db.prepare('SELECT * FROM writer_assignments WHERE order_id = ? AND writer_id = ?').get(orderId, userId);
    if (assignment) hasAccess = true;
  } else {
    const order = db.prepare('SELECT * FROM orders WHERE user_id = ? AND id = ?').get(userId, orderId);
    if (order) hasAccess = true;
  }

  if (!hasAccess) {
    return res.status(403).json({ ok: false, msg: 'You do not have access to this order.' });
  }

  let query = `
    SELECT of.*, u.name as uploader_name
    FROM order_files of
    JOIN users u ON of.uploaded_by = u.id
    WHERE of.order_id = ?
  `;

  if (userRole === 'client') {
    query += ` AND (of.uploader_role = 'client' OR of.uploader_role = 'admin')`;
  } else if (userRole === 'writer') {
    query += ` AND of.uploader_role = 'admin'`;
  }

  query += ` ORDER BY of.uploaded_at DESC`;

  const files = db.prepare(query).all(orderId);
  res.json(files);
});

app.get('/api/files/:fileId/download', requireLogin, (req, res) => {
  const fileId = req.params.fileId;
  const userId = req.session.userId;
  const userRole = req.session.role;

  const file = db.prepare(`
    SELECT of.*, o.user_id as client_id
    FROM order_files of
    JOIN orders o ON of.order_id = o.id
    WHERE of.id = ?
  `).get(fileId);

  if (!file) return res.status(404).json({ error: 'File not found.' });

  let canDownload = false;

  if (userRole === 'admin') {
    canDownload = true;
  } else if (userRole === 'writer') {
    if (file.uploader_role === 'admin') {
      canDownload = true;
    }
  } else if (userRole === 'client') {
    if (file.uploaded_by === userId || file.uploader_role === 'admin') {
      canDownload = true;
    }
  }

  if (!canDownload) {
    return res.status(403).json({ error: 'You do not have permission to download this file.' });
  }

  if (!fs.existsSync(file.file_path)) {
    return res.status(404).json({ error: 'File not found on server.' });
  }

  res.download(file.file_path, file.file_name);
});

app.delete('/api/files/:fileId', requireLogin, requireAdmin, (req, res) => {
  const fileId = req.params.fileId;
  try {
    const file = db.prepare('SELECT * FROM order_files WHERE id = ?').get(fileId);
    if (!file) return res.status(404).json({ ok: false, msg: 'File not found.' });

    if (fs.existsSync(file.file_path)) {
      fs.unlinkSync(file.file_path);
    }

    db.prepare('DELETE FROM order_files WHERE id = ?').run(fileId);
    res.json({ ok: true, msg: 'File deleted.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, msg: 'Database error.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES – USER MANAGEMENT (Admin)
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/users', requireLogin, requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, name, email, role FROM users ORDER BY role, name').all();
  res.json(users);
});

app.post('/api/admin/users', requireLogin, requireAdmin, async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || !role) {
    return res.json({ ok: false, msg: 'All fields are required.' });
  }
  if (!['writer', 'support', 'admin'].includes(role)) {
    return res.json({ ok: false, msg: 'Invalid role.' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.json({ ok: false, msg: 'Email already exists.' });

  const hash = bcrypt.hashSync(password, 10);
  try {
    db.prepare('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)').run(name, email, hash, role);

    await sendEmail(
      email,
      `Your ${role} account on DBRAM Research`,
      `<h2>Hello ${name},</h2>
       <p>An admin has created a ${role} account for you on DBRAM Research.</p>
       <p><strong>Your login credentials:</strong><br>
       Email: ${email}<br>
       Password: ${password}</p>
       <p><a href="${process.env.APP_BASE_URL}/login">Click here to log in</a></p>
       <p>Best regards,<br>DBRAM Research Team</p>`
    );

    res.json({ ok: true, msg: `User ${email} (${role}) created successfully.` });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, msg: 'Database error.' });
  }
});

app.delete('/api/admin/users/:userId', requireLogin, requireAdmin, (req, res) => {
  const userId = req.params.userId;
  try {
    db.prepare('DELETE FROM messages WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM orders WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    res.json({ ok: true, msg: 'User and all associated data deleted.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, msg: 'Database error.' });
  }
});

app.delete('/api/me', requireLogin, (req, res) => {
  const userId = req.session.userId;
  try {
    db.prepare('DELETE FROM messages WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM orders WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    req.session.destroy(() => {
      res.json({ ok: true, msg: 'Your account has been deleted.' });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, msg: 'Database error.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SOCKET.IO – CHAT
// ═══════════════════════════════════════════════════════════════════════════════

io.on('connection', (socket) => {
  const sess = socket.request.session;
  if (!sess?.userId) return socket.disconnect(true);
  const userId = sess.userId;
  const role = sess.role;

  socket.on('join_room', (targetUserId) => {
    if (role === 'admin' || role === 'support' || targetUserId === userId) {
      socket.join(`chat_${targetUserId}`);
    }
  });

  socket.on('send_message', ({ body, targetUserId }) => {
    const roomUserId = (role === 'admin' || role === 'support') ? targetUserId : userId;
    if (!body?.trim()) return;
    const sender = (role === 'admin' || role === 'support') ? 'support' : 'client';
    const stmt = db.prepare('INSERT INTO messages (user_id,sender,body) VALUES (?,?,?)');
    const result = stmt.run(roomUserId, sender, body.trim());
    const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(result.lastInsertRowid);
    io.to(`chat_${roomUserId}`).emit('new_message', msg);
  });
});

app.get('/test-email', async (req, res) => {
  try {
    await sendEmail(
      'dbramgroupsltd@gmail.com',
      'Test Email from DBRAM Research',
      '<p>If you receive this, email is working! 🎉</p>'
    );
    res.send('✅ Test email sent! Check your inbox.');
  } catch (err) {
    res.send('❌ Email failed: ' + err.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀  DBRAM Research is running at http://localhost:${PORT}`);
  console.log(`📧  Admin login: admin@example.com / admin123`);
  console.log(`✍️  Writer login: writer@example.com / writer123`);
  console.log(`💬  Support login: support@example.com / support123`);
});