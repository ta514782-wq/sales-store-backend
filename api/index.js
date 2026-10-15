const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const app = express();
app.use(cors());
app.use(express.json());

// dashboard key -> database view (whitelist) + optional row limit
const DASHBOARDS = {
  overview: { view: 'v_overview' },
  top_products: { view: 'v_top_products', limit: 5 },
  cancelled_products: { view: 'v_cancelled_products', limit: 10 },
  top_customers: { view: 'v_top_customers', limit: 5 },
  revenue_by_category: { view: 'v_revenue_by_category' },
  cancel_return_rate: { view: 'v_cancel_return_rate' },
  payment_modes: { view: 'v_payment_modes' },
  age_behavior: { view: 'v_age_behavior' },
  monthly_sales: { view: 'v_monthly_sales' },
  gender_category: { view: 'v_gender_category' },
  peak_hours: { view: 'v_peak_hours' },
  order_status: { view: 'v_order_status' },
  lost_revenue: { view: 'v_lost_revenue' },
  inventory_status: { view: 'v_inventory_status' },
  low_stock: { view: 'v_low_stock' },
};

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  });

function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  try {
    req.user = jwt.verify(t, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Please log in' });
  }
}
const superOnly = (req, res, next) =>
  req.user.role === 'super_admin' ? next() : res.status(403).json({ error: 'Super admin only' });

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const { rows } = await pool.query(
    `SELECT u.user_id, u.full_name, u.password_hash, u.is_active, r.role_id, r.role_name
     FROM users u JOIN roles r USING (role_id) WHERE lower(u.email) = lower($1)`,
    [email || '']
  );
  const u = rows[0];
  if (!u || !u.is_active || !(await bcrypt.compare(password || '', u.password_hash)))
    return res.status(401).json({ error: 'Wrong email or password' });
  const token = jwt.sign(
    { id: u.user_id, role_id: u.role_id, role: u.role_name, name: u.full_name },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );
  res.json({ token, user: { name: u.full_name, role: u.role_name } });
}));

// who am I + which dashboards can I open
app.get('/api/me', auth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT dashboard_key FROM role_dashboards WHERE role_id = $1 ORDER BY 1',
    [req.user.role_id]
  );
  res.json({ name: req.user.name, role: req.user.role, dashboards: rows.map((r) => r.dashboard_key) });
}));

// data for one dashboard (only if this role is allowed)
app.get('/api/dashboard/:key', auth, wrap(async (req, res) => {
  const d = DASHBOARDS[req.params.key];
  if (!d) return res.status(404).json({ error: 'Unknown dashboard' });
  const ok = await pool.query(
    'SELECT 1 FROM role_dashboards WHERE role_id = $1 AND dashboard_key = $2',
    [req.user.role_id, req.params.key]
  );
  if (!ok.rowCount) return res.status(403).json({ error: 'Your role cannot open this dashboard' });
  const sql = `SELECT * FROM ${d.view}` + (d.limit ? ` LIMIT ${d.limit}` : '');
  const { rows } = await pool.query(sql);
  res.json({ key: req.params.key, rows });
}));

// user management (super admin only)
app.get('/api/users', auth, superOnly, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.user_id, u.full_name, u.email, r.role_name, u.is_active
     FROM users u JOIN roles r USING (role_id) ORDER BY u.user_id`
  );
  res.json(rows);
}));

app.post('/api/users', auth, superOnly, wrap(async (req, res) => {
  const { full_name, email, password, role_name } = req.body || {};
  if (!full_name || !email || !password || password.length < 8 || !role_name)
    return res.status(400).json({ error: 'Name, email, role and a password of 8+ characters are required' });
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    `INSERT INTO users (full_name, email, password_hash, role_id)
     SELECT $1, $2, $3, role_id FROM roles WHERE role_name = $4
     ON CONFLICT (email) DO NOTHING RETURNING user_id`,
    [full_name, email, hash, role_name]
  );
  if (!rows.length) return res.status(400).json({ error: 'Email already used or role not found' });
  res.status(201).json({ user_id: rows[0].user_id });
}));

// ---------- daily operations ----------
const allow = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Your role cannot do this' });
const STATUSES = ['pending', 'delivered', 'cancelled', 'returned'];
const PAY = ['Cash', 'UPI', 'EMI', 'Debit Card', 'Credit Card'];
const NEXT = { pending: ['delivered', 'cancelled'], delivered: ['returned'] }; // allowed status changes
const dbMsg = (e, res) => {
  if (e.code === 'P0001') return res.status(400).json({ error: e.message }); // message raised by our DB rules
  console.error(e);
  res.status(500).json({ error: 'Server error' });
};

app.get('/api/products', auth, allow('super_admin', 'store_manager', 'inventory'), wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.product_id, p.product_name, c.category_name, COALESCE(i.stock_qty,0) AS stock_qty
     FROM products p JOIN categories c USING (category_id) LEFT JOIN inventory i USING (product_id)
     ORDER BY c.category_name, p.product_name`
  );
  res.json(rows);
}));

app.get('/api/customers', auth, allow('super_admin', 'store_manager'), wrap(async (req, res) => {
  const q = '%' + (req.query.q || '') + '%';
  const { rows } = await pool.query(
    `SELECT customer_id, customer_name FROM customers
     WHERE customer_id ILIKE $1 OR customer_name ILIKE $1 ORDER BY customer_name LIMIT 15`,
    [q]
  );
  res.json(rows);
}));

app.get('/api/orders', auth, allow('super_admin', 'store_manager', 'logistics'), wrap(async (req, res) => {
  const st = STATUSES.includes(req.query.status) ? req.query.status : null;
  const q = '%' + (req.query.q || '') + '%';
  const { rows } = await pool.query(
    `SELECT o.transaction_id, cu.customer_name, p.product_name, o.quantity, o.total_price,
            o.status, o.purchase_date, o.purchase_time
     FROM orders o LEFT JOIN customers cu USING (customer_id) JOIN products p USING (product_id)
     WHERE ($1::text IS NULL OR o.status = $1) AND o.transaction_id ILIKE $2
     ORDER BY o.purchase_date DESC NULLS LAST, o.purchase_time DESC NULLS LAST LIMIT 30`,
    [st, q]
  );
  res.json(rows);
}));

app.post('/api/orders', auth, allow('super_admin', 'store_manager'), wrap(async (req, res) => {
  const { customer_id, product_id, quantity, total_price, payment_mode } = req.body || {};
  if (!customer_id || !Number.isInteger(product_id) || !Number.isInteger(quantity) || quantity < 1 ||
      typeof total_price !== 'number' || !(total_price >= 0) || !PAY.includes(payment_mode))
    return res.status(400).json({ error: 'Fill customer, product, quantity (1+), total price and payment mode' });
  const id = 'TXN' + (100000 + Math.floor(Math.random() * 900000));
  try {
    const { rows } = await pool.query(
      `INSERT INTO orders (transaction_id, customer_id, product_id, quantity, total_price, payment_mode,
                           purchase_date, purchase_time, status)
       VALUES ($1,$2,$3,$4,$5,$6,(now() AT TIME ZONE 'Asia/Karachi')::date,
               (now() AT TIME ZONE 'Asia/Karachi')::time(0),'pending')
       ON CONFLICT DO NOTHING RETURNING transaction_id`,
      [id, customer_id, product_id, quantity, total_price, payment_mode]
    );
    if (!rows.length) return res.status(409).json({ error: 'Please try again' });
    res.status(201).json({ transaction_id: rows[0].transaction_id });
  } catch (e) {
    if (e.code === '23503') return res.status(400).json({ error: 'Customer or product not found' });
    throw e;
  }
}));

// change order status (rules: pending -> delivered/cancelled, delivered -> returned)
app.patch('/api/orders/:id/status', auth, allow('super_admin', 'store_manager', 'logistics'), async (req, res) => {
  const { status } = req.body || {};
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const cur = await c.query('SELECT status FROM orders WHERE transaction_id = $1 FOR UPDATE', [req.params.id]);
    if (!cur.rowCount) { await c.query('ROLLBACK'); return res.status(404).json({ error: 'Order not found' }); }
    const from = cur.rows[0].status;
    if (!(NEXT[from] || []).includes(status)) {
      await c.query('ROLLBACK');
      return res.status(400).json({ error: `A ${from} order cannot become ${status}` });
    }
    await c.query('UPDATE orders SET status = $1 WHERE transaction_id = $2', [status, req.params.id]);
    await c.query(
      `UPDATE audit_log SET user_id = $1 WHERE audit_id =
         (SELECT max(audit_id) FROM audit_log WHERE action = 'status_change' AND record_id = $2)`,
      [req.user.id, req.params.id]
    );
    await c.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    dbMsg(e, res);
  } finally {
    c.release();
  }
});

app.post('/api/restock', auth, allow('super_admin', 'inventory'), async (req, res) => {
  const { product_id, quantity } = req.body || {};
  if (!Number.isInteger(product_id) || !Number.isInteger(quantity) || quantity < 1)
    return res.status(400).json({ error: 'Choose a product and a quantity of 1 or more' });
  try {
    const { rows } = await pool.query('SELECT fn_restock($1,$2,$3) AS new_stock', [product_id, quantity, req.user.id]);
    res.json({ new_stock: rows[0].new_stock });
  } catch (e) {
    dbMsg(e, res);
  }
});

module.exports = app;
           
