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

// Dashboards that support date + category filters. They read from CTE "f" (filtered orders).
const FILTER_CTE = `WITH f AS (
  SELECT o.*, p.product_name, c.category_name, cu.customer_name, cu.age, cu.gender
  FROM orders o
  JOIN products p USING (product_id)
  JOIN categories c USING (category_id)
  LEFT JOIN customers cu USING (customer_id)
  WHERE ($1::date IS NULL OR o.purchase_date >= $1::date)
    AND ($2::date IS NULL OR o.purchase_date <= $2::date)
    AND ($3::text IS NULL OR c.category_name = $3)
) `;
const Q = {
  overview: `SELECT count(*) AS total_orders,
    count(*) FILTER (WHERE status='delivered') AS delivered_orders,
    COALESCE(sum(total_price) FILTER (WHERE status='delivered'),0) AS revenue,
    round(avg(total_price) FILTER (WHERE status='delivered'),2) AS avg_order_value,
    count(DISTINCT customer_id) AS customers,
    round(100.0*count(*) FILTER (WHERE status IN ('cancelled','returned'))/NULLIF(count(*),0),2) AS cancel_return_pct
    FROM f`,
  top_products: `SELECT product_name, category_name, sum(quantity) AS units_sold, sum(total_price) AS revenue
    FROM f WHERE status='delivered' GROUP BY 1,2 ORDER BY units_sold DESC LIMIT 5`,
  cancelled_products: `SELECT product_name, category_name, count(*) AS cancelled_orders
    FROM f WHERE status='cancelled' GROUP BY 1,2 ORDER BY cancelled_orders DESC LIMIT 10`,
  top_customers: `SELECT customer_id, customer_name, count(*) AS orders, sum(total_price) AS total_spent
    FROM f WHERE status='delivered' AND customer_id IS NOT NULL GROUP BY 1,2 ORDER BY total_spent DESC LIMIT 5`,
  revenue_by_category: `SELECT category_name, sum(total_price) AS revenue, sum(quantity) AS units
    FROM f WHERE status='delivered' GROUP BY 1 ORDER BY revenue DESC`,
  cancel_return_rate: `SELECT category_name, count(*) AS total_orders,
    count(*) FILTER (WHERE status='cancelled') AS cancelled,
    count(*) FILTER (WHERE status='returned') AS returned,
    round(100.0*count(*) FILTER (WHERE status IN ('cancelled','returned'))/count(*),2) AS cancel_return_pct
    FROM f GROUP BY 1 ORDER BY cancel_return_pct DESC`,
  payment_modes: `SELECT payment_mode, count(*) AS orders,
    round(100.0*count(*)/sum(count(*)) OVER (),2) AS pct
    FROM f WHERE payment_mode IS NOT NULL GROUP BY 1 ORDER BY orders DESC`,
  age_behavior: `SELECT CASE WHEN age<=25 THEN '18-25' WHEN age<=35 THEN '26-35'
      WHEN age<=45 THEN '36-45' ELSE '46-60' END AS age_group,
    count(*) AS orders,
    COALESCE(sum(total_price) FILTER (WHERE status='delivered'),0) AS revenue,
    round(avg(total_price),2) AS avg_order_value
    FROM f WHERE age IS NOT NULL GROUP BY 1 ORDER BY 1`,
  monthly_sales: `SELECT to_char(date_trunc('month', purchase_date),'YYYY-MM') AS month, count(*) AS orders,
    COALESCE(sum(total_price) FILTER (WHERE status='delivered'),0) AS revenue
    FROM f WHERE purchase_date IS NOT NULL GROUP BY 1 ORDER BY 1`,
  gender_category: `SELECT gender, category_name, count(*) AS orders, sum(quantity) AS units
    FROM f WHERE gender IS NOT NULL GROUP BY 1,2 ORDER BY 2,1`,
  peak_hours: `SELECT EXTRACT(HOUR FROM purchase_time)::int AS hour_of_day, count(*) AS orders
    FROM f WHERE purchase_time IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`,
  order_status: `SELECT status, count(*) AS orders, sum(total_price) AS value
    FROM f GROUP BY 1 ORDER BY orders DESC`,
  lost_revenue: `SELECT to_char(date_trunc('month', purchase_date),'YYYY-MM') AS month,
    COALESCE(sum(total_price) FILTER (WHERE status='cancelled'),0) AS cancelled_value,
    COALESCE(sum(total_price) FILTER (WHERE status='returned'),0) AS returned_value
    FROM f WHERE purchase_date IS NOT NULL GROUP BY 1 ORDER BY 1`,
};
// stock dashboards (no date filter) read straight from views
const VIEWS = { inventory_status: 'v_inventory_status', low_stock: 'v_low_stock' };

const cleanDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);

function csvText(rows) {
  if (!rows.length) return '';
  const keys = Object.keys(rows[0]);
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) v = v.toISOString().slice(0, 10);
    v = String(v);
    if (/^[=+@]/.test(v)) v = "'" + v;
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  return [keys.join(','), ...rows.map((r) => keys.map((k) => cell(r[k])).join(','))].join('\n');
}

// Next-month forecast: straight-line trend (least squares) on the last 12 complete months
const T95 = { 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228 };
function buildForecast(hist) {
  const n = hist.length;
  const ys = hist.map((h) => Number(h.revenue));
  const xs = ys.map((_, i) => i + 1);
  const xb = xs.reduce((a, b) => a + b, 0) / n;
  const yb = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  xs.forEach((x, i) => { sxx += (x - xb) ** 2; sxy += (x - xb) * (ys[i] - yb); syy += (ys[i] - yb) ** 2; });
  const b = sxy / sxx;
  const a = yb - b * xb;
  const sse = ys.reduce((s, y, i) => s + (y - (a + b * xs[i])) ** 2, 0);
  const se = Math.sqrt(sse / (n - 2));
  const r2 = syy ? 1 - sse / syy : 0;
  const x0 = n + 1;
  const linear = Math.max(0, a + b * x0);
  const half = (T95[n - 2] || 2.2) * se * Math.sqrt(1 + 1 / n + (x0 - xb) ** 2 / sxx);
  const ma3 = ys.slice(-3).reduce((s, y) => s + y, 0) / Math.min(3, n);
  const [yy, mm] = hist[n - 1].month.split('-').map(Number);
  const nm = mm === 12 ? [yy + 1, 1] : [yy, mm + 1];
  const next_month = nm[0] + '-' + String(nm[1]).padStart(2, '0');
  const R = Math.round;
  return {
    n, first: hist[0].month, last: hist[n - 1].month, next_month,
    linear: R(linear), ma3: R(ma3), low: R(Math.max(0, linear - half)), high: R(linear + half),
    r2: Math.round(r2 * 100) / 100, slope: R(b),
  };
}

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
    `SELECT u.user_id, u.full_name, u.password_hash, u.is_active, u.failed_attempts, u.locked_until,
            r.role_id, r.role_name
     FROM users u JOIN roles r USING (role_id) WHERE lower(u.email) = lower($1)`,
    [email || '']
  );
  const u = rows[0];
  if (u && u.locked_until && new Date(u.locked_until) > new Date()) {
    const mins = Math.ceil((new Date(u.locked_until) - new Date()) / 60000);
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${mins} minute(s).` });
  }
  const ok = u && u.is_active && (await bcrypt.compare(password || '', u.password_hash));
  if (!ok) {
    if (u) {
      // 5 wrong passwords in a row -> lock the account for 15 minutes
      const r = await pool.query(
        `UPDATE users SET
           locked_until = CASE WHEN failed_attempts + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END,
           failed_attempts = CASE WHEN failed_attempts + 1 >= 5 THEN 0 ELSE failed_attempts + 1 END
         WHERE user_id = $1 RETURNING failed_attempts, locked_until`,
        [u.user_id]
      );
      if (r.rows[0].failed_attempts === 0 && r.rows[0].locked_until) {
        await pool.query(
          `INSERT INTO audit_log (user_id, action, table_name, record_id) VALUES ($1, 'account_locked', 'users', $1::text)`,
          [u.user_id]
        );
      }
    }
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  if (u.failed_attempts > 0 || u.locked_until)
    await pool.query('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE user_id = $1', [u.user_id]);
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

app.get('/api/categories', auth, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT category_name FROM categories ORDER BY 1');
  res.json(rows.map((r) => r.category_name));
}));

app.post('/api/change-password', auth, wrap(async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password || new_password.length < 8)
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  if (new_password === current_password)
    return res.status(400).json({ error: 'New password must be different from the current one' });
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE user_id = $1', [req.user.id]);
  if (!rows[0] || !(await bcrypt.compare(current_password, rows[0].password_hash)))
    return res.status(400).json({ error: 'Current password is wrong' });
  const hash = await bcrypt.hash(new_password, 10);
  await pool.query('UPDATE users SET password_hash = $1 WHERE user_id = $2', [hash, req.user.id]);
  await pool.query(
    `INSERT INTO audit_log (user_id, action, table_name, record_id) VALUES ($1, 'password_change', 'users', $1::text)`,
    [req.user.id]
  );
  res.json({ ok: true });
}));

// data for one dashboard (only if this role is allowed). Optional: ?from=&to=&category=&format=csv
app.get('/api/dashboard/:key', auth, wrap(async (req, res) => {
  const key = req.params.key;
  if (!Q[key] && !VIEWS[key] && key !== 'sales_forecast') return res.status(404).json({ error: 'Unknown dashboard' });
  const ok = await pool.query(
    'SELECT 1 FROM role_dashboards WHERE role_id = $1 AND dashboard_key = $2',
    [req.user.role_id, key]
  );
  if (!ok.rowCount) return res.status(403).json({ error: 'Your role cannot open this dashboard' });

  const from = cleanDate(req.query.from);
  const to = cleanDate(req.query.to);
  const cat = req.query.category ? String(req.query.category) : null;
  let payload;
  try {
    if (key === 'sales_forecast') {
      const { rows } = await pool.query(
        `SELECT to_char(date_trunc('month', o.purchase_date),'YYYY-MM') AS month,
           COALESCE(sum(o.total_price) FILTER (WHERE o.status='delivered' AND ($1::text IS NULL OR c.category_name=$1)),0) AS revenue,
           count(*) FILTER (WHERE $1::text IS NULL OR c.category_name=$1) AS orders
         FROM orders o JOIN products p USING (product_id) JOIN categories c USING (category_id)
         WHERE o.purchase_date IS NOT NULL
         GROUP BY 1 HAVING count(*) >= 30
         ORDER BY 1 DESC LIMIT 12`,
        [cat]
      );
      const hist = rows.reverse();
      if (hist.length < 4) return res.status(400).json({ error: 'Not enough monthly history to forecast' });
      const f = buildForecast(hist);
      const out = hist.map((h) => ({ month: h.month, type: 'actual', revenue: Number(h.revenue), orders: Number(h.orders), low: null, high: null }));
      out.push({ month: f.next_month, type: 'forecast (trend)', revenue: f.linear, orders: null, low: f.low, high: f.high });
      out.push({ month: f.next_month, type: 'forecast (3-month avg)', revenue: f.ma3, orders: null, low: null, high: null });
      payload = { key, rows: out, forecast: f };
    } else if (Q[key]) {
      const { rows } = await pool.query(FILTER_CTE + Q[key], [from, to, cat]);
      payload = { key, rows };
    } else {
      const { rows } = await pool.query(`SELECT * FROM ${VIEWS[key]}`);
      payload = { key, rows };
    }
  } catch (e) {
    if (String(e.code).startsWith('22')) return res.status(400).json({ error: 'Invalid date' });
    throw e;
  }
  if (req.query.format === 'csv') {
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${key}.csv"`);
    return res.send('\ufeff' + csvText(payload.rows));
  }
  res.json(payload);
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
    
