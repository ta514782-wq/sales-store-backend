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

module.exports = app;
  
