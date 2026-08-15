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
const multer      = require('multer');
const fs          = require('fs');

// ─── ADMIN NOTIFICATION EMAIL ──────────────────────────────────────────────
const ADMIN_EMAIL = 'customerservice@dbramglobal.com';

// ─── SUPABASE POSTGRESQL ─────────────────────────────────────────────────────
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result;
  } finally {
    client.release();
  }
}

// ─── PRICE MAPPING (NGN) ──────────────────────────────────────────────────
const PRICE_MAP = {
  'undergraduate': 60000,
  'masters': 80000,
  'pgd': 120000,
  'phd': 250000,
  'assignment': 10000,
  'term_paper': 30000
};

// ─── INTERNATIONAL PRICING (USD) ──────────────────────────────────────────
const PRICE_MAP_USD = {
  'assignment': 75,
  'term_paper': 100,
  'undergraduate': 150,
  'masters': 300,
  'pgd': 300,
  'phd': 600
};

// ─── MULTER CONFIGURATION ──────────────────────────────────────────────────
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

// ─── EMAIL SETUP (Brevo) ──────────────────────────────────────────────────
const SibApiV3Sdk = require('sib-api-v3-sdk');

const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;

const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

async function sendEmail(to, subject, html) {
  try {
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.sender = {
      email: 'info@dbramglobal.com',
      name: 'DBRAM Research'
    };
    sendSmtpEmail.to = [{ email: to }];
    sendSmtpEmail.subject = subject;
    sendSmtpEmail.htmlContent = html;

    await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log(`📧 Email sent to ${to}`);
    return true;
  } catch (err) {
    console.error('❌ Email failed:', err.message);
    return false;
  }
}

// ─── EXPRESS APP ────────────────────────────────────────────────────────────
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

// ─── AUTH HELPERS ──────────────────────────────────────────────────────────
function requireLogin(req, res, next) {
  if (req.session.userId) return next();
  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
}
function requireAdmin(req, res, next) {
  if (req.session.role === 'admin') return next();
  res.status(403).json({ error: 'Forbidden' });
}

// ─── MONNIFY HELPERS ──────────────────────────────────────────────────────
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

// ─── PAYSTACK HELPERS ──────────────────────────────────────────────────────

async function verifyPaystackPayment(reference) {
  const { data } = await axios.get(
    `https://api.paystack.co/transaction/verify/${reference}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
      }
    }
  );
  return data.data;
}

// ════════════════════════════════════════════════════════════════════════════
// ROUTES – PUBLIC PAGES
// ════════════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'views/index.html')));
app.get('/about',   (_req, res) => res.sendFile(path.join(__dirname, 'views/about.html')));
app.get('/contact', (_req, res) => res.sendFile(path.join(__dirname, 'views/contact.html')));
app.get('/login',    (_req, res) => res.sendFile(path.join(__dirname, 'views/login.html')));
app.get('/register', (_req, res) => res.sendFile(path.join(__dirname, 'views/register.html')));
app.get('/apply',   (_req, res) => res.sendFile(path.join(__dirname, 'views/apply.html')));
app.get('/international', (_req, res) => {
  res.sendFile(path.join(__dirname, 'views/international.html'));
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTES – AUTH API
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/register', async (req, res) => {
  const { name, email, password, currency } = req.body;
  
  if (!name || !email || !password) return res.json({ ok: false, msg: 'All fields are required.' });
  
  const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) return res.json({ ok: false, msg: 'Email already registered.' });
  
  const hash = bcrypt.hashSync(password, 10);
  const result = await query(
    'INSERT INTO users (name, email, password, preferred_currency) VALUES ($1, $2, $3, $4) RETURNING id',
    [name, email, hash, currency || 'NGN']
  );
  const userId = result.rows[0].id;
  
  req.session.userId = userId;
  req.session.name   = name;
  req.session.email  = email;
  req.session.role   = 'client';
  req.session.currency = currency || 'NGN';

  // Send welcome email to client
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

  // Send notification to admin
  (async () => {
    await sendEmail(
      ADMIN_EMAIL,
      '🔔 New Client Registration',
      `<h2>New Client Registered</h2>
       <p><strong>Name:</strong> ${name}</p>
       <p><strong>Email:</strong> ${email}</p>
       <p><strong>Preferred Currency:</strong> ${currency || 'NGN'}</p>
       <p><strong>Registered:</strong> ${new Date().toLocaleString()}</p>
       <br>
       <p><a href="${process.env.APP_BASE_URL}/admin">View in Admin Dashboard</a></p>`
    );
  })();

  res.json({ ok: true });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const result = await query('SELECT * FROM users WHERE email = $1', [email]);
  const user = result.rows[0];
  
  if (!user || !bcrypt.compareSync(password, user.password)) return res.json({ ok: false, msg: 'Invalid email or password.' });
  
  req.session.userId = user.id;
  req.session.name   = user.name;
  req.session.email  = user.email;
  req.session.role   = user.role;
  req.session.currency = user.preferred_currency || 'NGN';

  let redirect = '/dashboard';
  if (user.role === 'admin') redirect = '/admin';
  else if (user.role === 'writer') redirect = '/writer';
  else if (user.role === 'support') redirect = '/support';

  res.json({ ok: true, role: user.role, redirect });
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

// ════════════════════════════════════════════════════════════════════════════
// ROUTES – DASHBOARD
// ════════════════════════════════════════════════════════════════════════════

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

// ════════════════════════════════════════════════════════════════════════════
// ROUTES – ORDERS API
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/price', (req, res) => {
  const { orderType } = req.body;
  const price = PRICE_MAP[orderType];
  if (!price) return res.json({ ok: false, msg: 'Invalid order type' });
  res.json({ ok: true, price });
});

app.post('/api/orders', requireLogin, async (req, res) => {
  const { title, subject, orderType, deadline, pages, description, currency } = req.body;
  
  if (!title || !subject || !orderType || !deadline || !pages) {
    return res.json({ ok: false, msg: 'All required fields must be filled.' });
  }
  
  const userCurrency = currency || req.session.currency || 'NGN';
  
  let totalAmount;
  if (userCurrency === 'USD') {
    totalAmount = PRICE_MAP_USD[orderType];
  } else {
    totalAmount = PRICE_MAP[orderType];
  }
  
  if (!totalAmount) {
    return res.json({ ok: false, msg: 'Invalid order type or currency.' });
  }
  
  const result = await query(`
    INSERT INTO orders (user_id, title, subject, order_type, deadline, pages, description, total_amount, amount, currency)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id
  `, [req.session.userId, title, subject, orderType, deadline, pages, description || '', totalAmount, totalAmount, userCurrency]);
  
  const orderId = result.rows[0].id;
  const currencySymbol = userCurrency === 'USD' ? '$' : '₦';

  (async () => {
    const userResult = await query('SELECT name, email FROM users WHERE id = $1', [req.session.userId]);
    const user = userResult.rows[0];
    
    await sendEmail(
      ADMIN_EMAIL,
      '📦 New Order Placed',
      `<h2>New Order Placed</h2>
       <p><strong>Order ID:</strong> #${orderId}</p>
       <p><strong>Client:</strong> ${user.name} (${user.email})</p>
       <p><strong>Title:</strong> ${title}</p>
       <p><strong>Subject:</strong> ${subject}</p>
       <p><strong>Type:</strong> ${orderType}</p>
       <p><strong>Pages:</strong> ${pages}</p>
       <p><strong>Deadline:</strong> ${deadline}</p>
       <p><strong>Amount:</strong> ${currencySymbol}${totalAmount.toLocaleString()}</p>
       <p><strong>Currency:</strong> ${userCurrency}</p>
       <br>
       <p><a href="${process.env.APP_BASE_URL}/admin">View in Admin Dashboard</a></p>`
    );
  })();

  res.json({ ok: true, orderId, totalAmount, currency: userCurrency });
});

app.get('/api/orders', requireLogin, async (req, res) => {
  let orders;
  if (req.session.role === 'admin' || req.session.role === 'writer' || req.session.role === 'support') {
    const result = await query(`
      SELECT o.*, u.name as client_name, u.email as client_email
      FROM orders o JOIN users u ON o.user_id = u.id
      ORDER BY o.created_at DESC
    `);
    orders = result.rows;
  } else {
    const result = await query('SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC', [req.session.userId]);
    orders = result.rows;
  }
  res.json(orders);
});

app.patch('/api/orders/:id/status', requireLogin, async (req, res) => {
  const { status } = req.body;
  const orderId = req.params.id;
  const role = req.session.role;

  if (role === 'admin') {
    await query('UPDATE orders SET status = $1 WHERE id = $2', [status, orderId]);
    if (status === 'completed') {
      const orderResult = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
      const order = orderResult.rows[0];
      const userResult = await query('SELECT * FROM users WHERE id = $1', [order.user_id]);
      const user = userResult.rows[0];
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
    await query('UPDATE orders SET status = $1 WHERE id = $2', [status, orderId]);
    return res.json({ ok: true });
  }
  res.status(403).json({ ok: false, msg: 'Not allowed to change status to ' + status });
});

app.delete('/api/orders/:id', requireLogin, requireAdmin, async (req, res) => {
  try {
    await query('DELETE FROM orders WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch(err) {
    res.status(500).json({ ok: false });
  }
});

app.get('/api/me', requireLogin, (req, res) => {
  res.json({ id: req.session.userId, name: req.session.name, email: req.session.email, role: req.session.role });
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTES – PAYSTACK PAYMENTS
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/paystack/initiate/:orderId', requireLogin, async (req, res) => {
  const { percentage } = req.body;
  const orderResult = await query('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [req.params.orderId, req.session.userId]);
  const order = orderResult.rows[0];
  if (!order) return res.json({ ok: false, msg: 'Order not found.' });
  
  if (order.status === 'paid' || order.status === 'completed') {
    return res.json({ ok: false, msg: 'Order already paid.' });
  }

  let amountToPay = 0;
  let newStatus = order.status;

  if (percentage === 60) {
    const sixtyPercent = order.total_amount * 0.6;
    if (order.paid_amount >= sixtyPercent) {
      return res.json({ ok: false, msg: 'Already paid 60% or more.' });
    }
    amountToPay = sixtyPercent;
    newStatus = 'partially_paid';
  } else {
    const remaining = order.total_amount - order.paid_amount;
    if (remaining <= 0) return res.json({ ok: false, msg: 'Order already fully paid.' });
    amountToPay = remaining;
    newStatus = 'paid';
  }

  const reference = `DBRAM-${order.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  try {
    const currency = order.currency || 'NGN';
    let paystackAmount;
    let paystackCurrency;

    if (currency === 'USD') {
      paystackAmount = Math.round(amountToPay * 100);
      paystackCurrency = 'USD';
    } else {
      paystackAmount = Math.round(amountToPay * 100);
      paystackCurrency = 'NGN';
    }

    console.log('🔍 Paystack Request:', { amount: paystackAmount, currency: paystackCurrency, email: req.session.email, reference });

    const result = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        amount: paystackAmount,
        email: req.session.email,
        reference,
        currency: paystackCurrency,
        callback_url: `${process.env.APP_BASE_URL}/paystack/verify?reference=${reference}`,
        metadata: {
          order_id: order.id,
          user_id: req.session.userId,
          percentage: percentage || 100,
          currency: currency,
          custom_fields: [
            { display_name: "Order Title", variable_name: "order_title", value: order.title }
          ]
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!global.pendingPaystackPayments) global.pendingPaystackPayments = new Map();
    global.pendingPaystackPayments.set(reference, {
      orderId: order.id,
      amountToPay,
      newStatus
    });

    res.json({ ok: true, authorization_url: result.data.data.authorization_url, reference });
  } catch (err) {
    console.error('❌ Paystack init error:', err?.response?.data || err.message);
    if (err.response) {
      console.error('📦 Full error response:', JSON.stringify(err.response.data, null, 2));
    }
    res.json({ ok: false, msg: 'Payment initialization failed. Please try again.' });
  }
});

app.get('/paystack/verify', async (req, res) => {
  const { reference } = req.query;
  if (!reference) return res.redirect('/dashboard?payment=failed');

  try {
    const result = await verifyPaystackPayment(reference);
    
    if (result.status === 'success') {
      const pending = global.pendingPaystackPayments?.get(reference);
      if (pending) {
        const { orderId, amountToPay, newStatus } = pending;
        const orderResult = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
        const order = orderResult.rows[0];
        if (order) {
          const newPaidAmount = order.paid_amount + amountToPay;
          await query('UPDATE orders SET paid_amount = $1, status = $2 WHERE id = $3', [newPaidAmount, newStatus, orderId]);
          
          const userResult = await query('SELECT * FROM users WHERE id = $1', [order.user_id]);
          const user = userResult.rows[0];
          if (user && user.email) {
            await sendEmail(
              user.email,
              'Payment Confirmation – Order #' + order.id,
              `<h2>Payment Received</h2>
               <p>Your payment for order "${order.title}" has been confirmed.</p>
               <p>Amount paid: ${order.currency === 'USD' ? '$' : '₦'}${amountToPay.toLocaleString()}</p>
               <p>Total paid so far: ${order.currency === 'USD' ? '$' : '₦'}${newPaidAmount.toLocaleString()}</p>
               <p>We'll begin working on your order shortly.</p>`
            );
          }
          await sendEmail(
            ADMIN_EMAIL,
            '💰 New Payment via Paystack – Order #' + order.id,
            `<h2>Payment Received</h2>
             <p><strong>Order ID:</strong> #${order.id}</p>
             <p><strong>Client:</strong> ${user?.name || 'Unknown'} (${user?.email || 'N/A'})</p>
             <p><strong>Amount:</strong> ${order.currency === 'USD' ? '$' : '₦'}${amountToPay.toLocaleString()}</p>
             <p><strong>Payment Method:</strong> Paystack</p>
             <p><strong>Order Status Updated to:</strong> ${newStatus}</p>
             <br>
             <p><a href="${process.env.APP_BASE_URL}/admin">View in Admin Dashboard</a></p>`
          );
        }
        global.pendingPaystackPayments.delete(reference);
      } else {
        const metadata = result.metadata || {};
        const orderId = metadata.order_id;
        if (orderId) {
          await query("UPDATE orders SET status = 'paid' WHERE id = $1", [orderId]);
        }
      }
      
      return res.redirect('/dashboard?payment=success');
    }
    
    res.redirect('/dashboard?payment=failed');
  } catch (err) {
    console.error('Paystack verify error:', err);
    res.redirect('/dashboard?payment=failed');
  }
});

app.post('/webhook/paystack', express.json(), async (req, res) => {
  const event = req.body;
  
  if (event.event === 'charge.success') {
    const data = event.data;
    const reference = data.reference;
    const pending = global.pendingPaystackPayments?.get(reference);
    if (pending) {
      const { orderId, amountToPay, newStatus } = pending;
      const orderResult = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
      const order = orderResult.rows[0];
      if (order && order.status !== 'paid' && order.status !== 'completed') {
        const newPaidAmount = order.paid_amount + amountToPay;
        await query('UPDATE orders SET paid_amount = $1, status = $2 WHERE id = $3', [newPaidAmount, newStatus, orderId]);
        console.log(`Paystack webhook: Order ${orderId} updated to ${newStatus}.`);
      }
      global.pendingPaystackPayments.delete(reference);
    } else {
      const metadata = data.metadata || {};
      const orderId = metadata.order_id;
      if (orderId) {
        await query("UPDATE orders SET status = 'paid' WHERE id = $1", [orderId]);
      }
    }
  }
  
  res.sendStatus(200);
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTES – CHAT
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/chat/messages', requireLogin, async (req, res) => {
  const role = req.session.role;
  const userId = req.session.userId;
  let targetUserId = req.query.userId;

  if (role === 'admin' || role === 'support') {
    if (!targetUserId) return res.json([]);
  } else {
    targetUserId = userId;
  }

  const result = await query('SELECT * FROM messages WHERE user_id = $1 ORDER BY created_at ASC', [targetUserId]);
  res.json(result.rows);
});

app.get('/api/chat/threads', requireLogin, async (req, res) => {
  if (req.session.role !== 'admin' && req.session.role !== 'support') {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const result = await query(`
    SELECT u.id, u.name, u.email,
           COUNT(m.id) as msg_count,
           MAX(m.created_at) as last_msg
    FROM users u
    LEFT JOIN messages m ON m.user_id = u.id
    WHERE u.role = 'client'
    GROUP BY u.id
    ORDER BY last_msg DESC NULLS LAST
  `);
  res.json(result.rows);
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTES – WRITER PORTAL
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/writer/apply', async (req, res) => {
  const { name, email, qualifications } = req.body;
  if (!name || !email || !qualifications) {
    return res.json({ ok: false, msg: 'All fields are required.' });
  }
  try {
    const existing = await query('SELECT id FROM writer_applications WHERE email = $1', [email]);
    if (existing.rows.length > 0) return res.json({ ok: false, msg: 'You have already applied.' });

    await query(`
      INSERT INTO writer_applications (name, email, qualifications)
      VALUES ($1, $2, $3)
    `, [name, email, qualifications]);

    res.json({ ok: true, msg: 'Application submitted successfully!' });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, msg: 'Database error.' });
  }
});

app.get('/api/admin/writer-applications', requireLogin, requireAdmin, async (req, res) => {
  const result = await query(`
    SELECT wa.*, u.name as reviewer_name
    FROM writer_applications wa
    LEFT JOIN users u ON wa.reviewed_by = u.id
    ORDER BY wa.applied_at DESC
  `);
  res.json(result.rows);
});

app.post('/api/admin/writer-applications/:id/review', requireLogin, requireAdmin, async (req, res) => {
  const { status } = req.body;
  const appId = req.params.id;
  const reviewerId = req.session.userId;

  if (!['approved', 'rejected'].includes(status)) {
    return res.json({ ok: false, msg: 'Invalid status.' });
  }

  try {
    const appResult = await query('SELECT * FROM writer_applications WHERE id = $1', [appId]);
    const app = appResult.rows[0];
    if (!app) return res.json({ ok: false, msg: 'Application not found.' });

    await query(`
      UPDATE writer_applications
      SET status = $1, reviewed_at = NOW(), reviewed_by = $2
      WHERE id = $3
    `, [status, reviewerId, appId]);

    if (status === 'approved') {
      const tempPassword = Math.random().toString(36).slice(-8);
      const hash = bcrypt.hashSync(tempPassword, 10);
      await query(`
        INSERT INTO users (name, email, password, role)
        VALUES ($1, $2, $3, 'writer')
      `, [app.name, app.email, hash]);

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
    const existing = await query("SELECT id FROM writer_assignments WHERE order_id = $1 AND status != 'submitted'", [orderId]);
    if (existing.rows.length > 0) return res.json({ ok: false, msg: 'This order is already assigned to a writer.' });

    const writerResult = await query("SELECT id FROM users WHERE id = $1 AND role = 'writer'", [writerId]);
    if (writerResult.rows.length === 0) return res.json({ ok: false, msg: 'Writer not found.' });

    await query(`
      INSERT INTO writer_assignments (order_id, writer_id, status)
      VALUES ($1, $2, 'assigned')
    `, [orderId, writerId]);

    const orderResult = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
    const order = orderResult.rows[0];
    const writerUserResult = await query('SELECT * FROM users WHERE id = $1', [writerId]);
    const writerUser = writerUserResult.rows[0];
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

app.get('/api/writer/jobs', requireLogin, async (req, res) => {
  if (req.session.role !== 'writer') {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const writerId = req.session.userId;
  const result = await query(`
    SELECT wa.*, o.title, o.subject, o.deadline, o.pages, o.description, u.name as client_name
    FROM writer_assignments wa
    JOIN orders o ON wa.order_id = o.id
    JOIN users u ON o.user_id = u.id
    WHERE wa.writer_id = $1
    ORDER BY wa.assigned_at DESC
  `, [writerId]);
  res.json(result.rows);
});

app.patch('/api/writer/jobs/:id/status', requireLogin, async (req, res) => {
  if (req.session.role !== 'writer') {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const { status } = req.body;
  const jobId = req.params.id;
  const writerId = req.session.userId;

  const jobResult = await query('SELECT * FROM writer_assignments WHERE id = $1 AND writer_id = $2', [jobId, writerId]);
  if (jobResult.rows.length === 0) return res.status(404).json({ ok: false, msg: 'Job not found.' });

  await query('UPDATE writer_assignments SET status = $1 WHERE id = $2', [status, jobId]);
  res.json({ ok: true });
});

app.post('/api/writer/jobs/:id/upload', requireLogin, upload.single('file'), async (req, res) => {
  if (req.session.role !== 'writer') {
    return res.status(403).json({ ok: false, msg: 'Unauthorized' });
  }

  const jobId = req.params.id;
  const writerId = req.session.userId;

  const jobResult = await query('SELECT * FROM writer_assignments WHERE id = $1 AND writer_id = $2', [jobId, writerId]);
  const job = jobResult.rows[0];
  if (!job) return res.status(404).json({ ok: false, msg: 'Job not found.' });

  if (!req.file) {
    return res.json({ ok: false, msg: 'No file uploaded.' });
  }

  try {
    await query(`
      UPDATE writer_assignments
      SET file_path = $1, file_name = $2, status = 'submitted', completed_at = NOW()
      WHERE id = $3
    `, [req.file.path, req.file.originalname, jobId]);

    const orderResult = await query('SELECT * FROM orders WHERE id = $1', [job.order_id]);
    const order = orderResult.rows[0];
    const clientResult = await query('SELECT * FROM users WHERE id = $1', [order.user_id]);
    const client = clientResult.rows[0];
    const adminResult = await query("SELECT * FROM users WHERE role = 'admin' LIMIT 1");
    const admin = adminResult.rows[0];

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

app.get('/api/admin/assignments', requireLogin, requireAdmin, async (req, res) => {
  const result = await query(`
    SELECT wa.*, o.title as order_title, u.name as writer_name, u.email as writer_email
    FROM writer_assignments wa
    JOIN orders o ON wa.order_id = o.id
    JOIN users u ON wa.writer_id = u.id
    ORDER BY wa.assigned_at DESC
  `);
  res.json(result.rows);
});

app.get('/api/admin/download/:assignmentId', requireLogin, requireAdmin, async (req, res) => {
  const assignmentResult = await query('SELECT file_path, file_name FROM writer_assignments WHERE id = $1', [req.params.assignmentId]);
  const assignment = assignmentResult.rows[0];
  if (!assignment || !assignment.file_path) {
    return res.status(404).json({ error: 'File not found.' });
  }
  if (!fs.existsSync(assignment.file_path)) {
    return res.status(404).json({ error: 'File not found on server.' });
  }
  res.download(assignment.file_path, assignment.file_name);
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTES – FILE MANAGEMENT
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/orders/:orderId/files', requireLogin, upload.single('file'), async (req, res) => {
  const orderId = req.params.orderId;
  const userId = req.session.userId;
  const userRole = req.session.role;
  const { description } = req.body;

  let orderResult;
  if (userRole === 'admin') {
    orderResult = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
  } else if (userRole === 'writer') {
    const assignmentResult = await query('SELECT * FROM writer_assignments WHERE order_id = $1 AND writer_id = $2', [orderId, userId]);
    if (assignmentResult.rows.length > 0) {
      orderResult = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
    }
  } else {
    orderResult = await query('SELECT * FROM orders WHERE user_id = $1 AND id = $2', [userId, orderId]);
  }
  const order = orderResult?.rows[0];
  if (!order) return res.status(404).json({ ok: false, msg: 'Order not found.' });

  if (!req.file) {
    return res.json({ ok: false, msg: 'No file uploaded.' });
  }

  try {
    await query(`
      INSERT INTO order_files (order_id, uploaded_by, uploader_role, file_path, file_name, file_size, description)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [orderId, userId, userRole, req.file.path, req.file.originalname, req.file.size, description || '']);

    res.json({ ok: true, msg: 'File uploaded successfully.', file: req.file.originalname });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, msg: 'Database error.' });
  }
});

app.get('/api/orders/:orderId/files', requireLogin, async (req, res) => {
  const orderId = req.params.orderId;
  const userId = req.session.userId;
  const userRole = req.session.role;

  let hasAccess = false;
  if (userRole === 'admin') {
    hasAccess = true;
  } else if (userRole === 'writer') {
    const assignmentResult = await query('SELECT * FROM writer_assignments WHERE order_id = $1 AND writer_id = $2', [orderId, userId]);
    if (assignmentResult.rows.length > 0) hasAccess = true;
  } else {
    const orderResult = await query('SELECT * FROM orders WHERE user_id = $1 AND id = $2', [userId, orderId]);
    if (orderResult.rows.length > 0) hasAccess = true;
  }

  if (!hasAccess) {
    return res.status(403).json({ ok: false, msg: 'You do not have access to this order.' });
  }

  let queryStr = `
    SELECT of.*, u.name as uploader_name
    FROM order_files of
    JOIN users u ON of.uploaded_by = u.id
    WHERE of.order_id = $1
  `;

  if (userRole === 'client') {
    queryStr += ` AND (of.uploader_role = 'client' OR of.uploader_role = 'admin')`;
  } else if (userRole === 'writer') {
    queryStr += ` AND of.uploader_role = 'admin'`;
  }

  queryStr += ` ORDER BY of.uploaded_at DESC`;

  const result = await query(queryStr, [orderId]);
  res.json(result.rows);
});

app.get('/api/files/:fileId/download', requireLogin, async (req, res) => {
  const fileId = req.params.fileId;
  const userId = req.session.userId;
  const userRole = req.session.role;

  const fileResult = await query(`
    SELECT of.*, o.user_id as client_id
    FROM order_files of
    JOIN orders o ON of.order_id = o.id
    WHERE of.id = $1
  `, [fileId]);
  const file = fileResult.rows[0];

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

app.delete('/api/files/:fileId', requireLogin, requireAdmin, async (req, res) => {
  const fileId = req.params.fileId;
  try {
    const fileResult = await query('SELECT * FROM order_files WHERE id = $1', [fileId]);
    const file = fileResult.rows[0];
    if (!file) return res.status(404).json({ ok: false, msg: 'File not found.' });

    if (fs.existsSync(file.file_path)) {
      fs.unlinkSync(file.file_path);
    }

    await query('DELETE FROM order_files WHERE id = $1', [fileId]);
    res.json({ ok: true, msg: 'File deleted.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, msg: 'Database error.' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTES – USER MANAGEMENT (Admin)
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/users', requireLogin, requireAdmin, async (req, res) => {
  const result = await query('SELECT id, name, email, role, preferred_currency FROM users ORDER BY role, name');
  res.json(result.rows);
});

app.post('/api/admin/users', requireLogin, requireAdmin, async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || !role) {
    return res.json({ ok: false, msg: 'All fields are required.' });
  }
  if (!['writer', 'support', 'admin'].includes(role)) {
    return res.json({ ok: false, msg: 'Invalid role.' });
  }
  const existingResult = await query('SELECT id FROM users WHERE email = $1', [email]);
  if (existingResult.rows.length > 0) return res.json({ ok: false, msg: 'Email already exists.' });

  const hash = bcrypt.hashSync(password, 10);
  try {
    await query('INSERT INTO users (name, email, password, role) VALUES ($1, $2, $3, $4)', [name, email, hash, role]);

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

app.delete('/api/admin/users/:userId', requireLogin, requireAdmin, async (req, res) => {
  const userId = req.params.userId;
  try {
    await query('DELETE FROM messages WHERE user_id = $1', [userId]);
    await query('DELETE FROM orders WHERE user_id = $1', [userId]);
    await query('DELETE FROM users WHERE id = $1', [userId]);
    res.json({ ok: true, msg: 'User and all associated data deleted.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, msg: 'Database error.' });
  }
});

app.delete('/api/me', requireLogin, async (req, res) => {
  const userId = req.session.userId;
  try {
    await query('DELETE FROM messages WHERE user_id = $1', [userId]);
    await query('DELETE FROM orders WHERE user_id = $1', [userId]);
    await query('DELETE FROM users WHERE id = $1', [userId]);
    req.session.destroy(() => {
      res.json({ ok: true, msg: 'Your account has been deleted.' });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, msg: 'Database error.' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTES – REVIEWS
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/reviews', async (req, res) => {
  const { client_name, email, rating, review_text, order_id } = req.body;
  
  if (!client_name || !review_text) {
    return res.json({ ok: false, msg: 'Name and review are required.' });
  }
  
  try {
    const result = await query(
      `INSERT INTO reviews (client_name, email, rating, review_text, order_id, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING id`,
      [client_name, email || null, rating || 5, review_text, order_id || null]
    );
    
    res.json({ ok: true, msg: 'Review submitted successfully! It will appear once approved.' });
  } catch (err) {
    console.error('Review submit error:', err);
    res.json({ ok: false, msg: 'Database error.' });
  }
});

app.get('/api/reviews/approved', async (req, res) => {
  try {
    const result = await query(
      `SELECT client_name, rating, review_text, created_at
       FROM reviews
       WHERE status = 'approved'
       ORDER BY created_at DESC
       LIMIT 20`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.json([]);
  }
});

app.get('/api/admin/reviews', requireLogin, requireAdmin, async (req, res) => {
  try {
    const result = await query(
      `SELECT r.*, o.title as order_title
       FROM reviews r
       LEFT JOIN orders o ON r.order_id = o.id
       ORDER BY r.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.json([]);
  }
});

app.patch('/api/admin/reviews/:id', requireLogin, requireAdmin, async (req, res) => {
  const { status } = req.body;
  const reviewId = req.params.id;
  
  if (!['approved', 'rejected', 'deleted'].includes(status)) {
    return res.json({ ok: false, msg: 'Invalid status.' });
  }
  
  try {
    if (status === 'deleted') {
      await query('DELETE FROM reviews WHERE id = $1', [reviewId]);
      res.json({ ok: true, msg: 'Review deleted.' });
    } else {
      await query('UPDATE reviews SET status = $1, updated_at = NOW() WHERE id = $2', [status, reviewId]);
      res.json({ ok: true, msg: `Review ${status}.` });
    }
  } catch (err) {
    console.error(err);
    res.json({ ok: false, msg: 'Database error.' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// SOCKET.IO – CHAT
// ════════════════════════════════════════════════════════════════════════════

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

  socket.on('send_message', async ({ body, targetUserId }) => {
    const roomUserId = (role === 'admin' || role === 'support') ? targetUserId : userId;
    if (!body?.trim()) return;
    const sender = (role === 'admin' || role === 'support') ? 'support' : 'client';
    const result = await query('INSERT INTO messages (user_id, sender, body) VALUES ($1, $2, $3) RETURNING *', [roomUserId, sender, body.trim()]);
    const msg = result.rows[0];
    io.to(`chat_${roomUserId}`).emit('new_message', msg);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// START SERVER
// ════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀  DBRAM Research is running at http://localhost:${PORT}`);
  console.log(`📧  Admin login: admin@example.com / admin123`);
  console.log(`✍️  Writer login: writer@example.com / writer123`);
  console.log(`💬  Support login: support@example.com / support123`);
  console.log(`💳  Paystack is LIVE!`);
});