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
app.use(express.json({ limit: '3mb' }));

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
    AND o.store_id = $4
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
    // store users are tied to their own store; the platform admin chooses one with the X-Store-Id header
    if (req.user.role === 'platform_admin') {
      const sid = parseInt(req.headers['x-store-id'], 10);
      req.storeId = Number.isInteger(sid) ? sid : null;
    } else {
      req.storeId = req.user.store_id || null;
    }
    next();
  } catch {
    res.status(401).json({ error: 'Please log in' });
  }
}
const superOnly = (req, res, next) =>
  ['super_admin', 'platform_admin'].includes(req.user.role) ? next() : res.status(403).json({ error: 'Store admin only' });
const platformOnly = (req, res, next) =>
  req.user.role === 'platform_admin' ? next() : res.status(403).json({ error: 'Platform admin only' });
// every store-scoped route runs this: the store must exist and be active
async function store(req, res, next) {
  try {
    if (!req.storeId) return res.status(400).json({ error: 'Choose a store first' });
    const r = await pool.query('SELECT 1 FROM stores WHERE store_id = $1 AND is_active', [req.storeId]);
    if (!r.rowCount) return res.status(403).json({ error: 'Store not available' });
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const { rows } = await pool.query(
    `SELECT u.user_id, u.full_name, u.password_hash, u.is_active, u.failed_attempts, u.locked_until, u.store_id,
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
    { id: u.user_id, role_id: u.role_id, role: u.role_name, name: u.full_name, store_id: u.store_id },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );
  res.json({ token, user: { name: u.full_name, role: u.role_name } });
}));

// who am I + which dashboards can I open
app.get('/api/me', auth, wrap(async (req, res) => {
  const d = await pool.query('SELECT dashboard_key FROM role_dashboards WHERE role_id = $1 ORDER BY 1', [req.user.role_id]);
  const out = { name: req.user.name, role: req.user.role, dashboards: d.rows.map((r) => r.dashboard_key), store: null };
  if (req.user.role === 'platform_admin') {
    out.stores = (await pool.query('SELECT store_id, store_name FROM stores WHERE is_active ORDER BY store_id')).rows;
  } else if (req.user.store_id) {
    const x = await pool.query('SELECT store_id, store_name FROM stores WHERE store_id = $1', [req.user.store_id]);
    if (x.rows[0]) out.store = { id: x.rows[0].store_id, name: x.rows[0].store_name };
  }
  res.json(out);
}));

app.get('/api/categories', auth, store, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT category_name FROM categories WHERE store_id = $1 ORDER BY 1', [req.storeId]);
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
app.get('/api/dashboard/:key', auth, store, wrap(async (req, res) => {
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
         WHERE o.purchase_date IS NOT NULL AND o.store_id = $2
         GROUP BY 1 HAVING count(*) >= 30
         ORDER BY 1 DESC LIMIT 12`,
        [cat, req.storeId]
      );
      const hist = rows.reverse();
      if (hist.length < 4) return res.status(400).json({ error: 'Not enough monthly history to forecast' });
      const f = buildForecast(hist);
      const out = hist.map((h) => ({ month: h.month, type: 'actual', revenue: Number(h.revenue), orders: Number(h.orders), low: null, high: null }));
      out.push({ month: f.next_month, type: 'forecast (trend)', revenue: f.linear, orders: null, low: f.low, high: f.high });
      out.push({ month: f.next_month, type: 'forecast (3-month avg)', revenue: f.ma3, orders: null, low: null, high: null });
      payload = { key, rows: out, forecast: f };
    } else if (Q[key]) {
      const { rows } = await pool.query(FILTER_CTE + Q[key], [from, to, cat, req.storeId]);
      payload = { key, rows };
    } else {
      const { rows } = await pool.query(`SELECT * FROM ${VIEWS[key]} WHERE store_id = $1`, [req.storeId]);
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

// user management (store admin: own store; platform admin: the selected store)
app.get('/api/users', auth, store, superOnly, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.user_id, u.full_name, u.email, r.role_name, u.is_active
     FROM users u JOIN roles r USING (role_id) WHERE u.store_id = $1 ORDER BY u.user_id`,
    [req.storeId]
  );
  res.json(rows);
}));

app.post('/api/users', auth, store, superOnly, wrap(async (req, res) => {
  const { full_name, email, password, role_name } = req.body || {};
  if (!full_name || !email || !password || password.length < 8 || !role_name)
    return res.status(400).json({ error: 'Name, email, role and a password of 8+ characters are required' });
  if (role_name === 'platform_admin') return res.status(403).json({ error: 'Not allowed' });
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    `INSERT INTO users (full_name, email, password_hash, role_id, store_id)
     SELECT $1, $2, $3, role_id, $5 FROM roles WHERE role_name = $4
     ON CONFLICT (email) DO NOTHING RETURNING user_id`,
    [full_name, email, hash, role_name, req.storeId]
  );
  if (!rows.length) return res.status(400).json({ error: 'Email already used or role not found' });
  res.status(201).json({ user_id: rows[0].user_id });
}));

// ---------- stores (platform admin) ----------
app.get('/api/stores', auth, platformOnly, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.store_id, s.store_name, s.city,
       (SELECT count(*) FROM orders o WHERE o.store_id = s.store_id) AS orders,
       (SELECT COALESCE(sum(o.total_price),0) FROM orders o WHERE o.store_id = s.store_id AND o.status = 'delivered') AS revenue,
       (SELECT count(*) FROM users u WHERE u.store_id = s.store_id) AS users
     FROM stores s WHERE s.is_active ORDER BY s.store_id`
  );
  res.json(rows);
}));

app.post('/api/stores', auth, platformOnly, async (req, res) => {
  const { store_name, city, admin_name, admin_email, admin_password, copy_from } = req.body || {};
  if (!store_name || !admin_name || !admin_email || !admin_password || admin_password.length < 8)
    return res.status(400).json({ error: 'Store name, admin name, admin email and an 8+ character password are required' });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const s1 = await c.query('SELECT fn_create_store($1, $2, $3) AS sid', [store_name.trim(), city || null, Number.isInteger(copy_from) ? copy_from : null]);
    const sid = s1.rows[0].sid;
    const hash = await bcrypt.hash(admin_password, 10);
    const u = await c.query(
      `INSERT INTO users (full_name, email, password_hash, role_id, store_id)
       SELECT $1, $2, $3, role_id, $4 FROM roles WHERE role_name = 'super_admin'
       ON CONFLICT (email) DO NOTHING RETURNING user_id`,
      [admin_name, admin_email, hash, sid]
    );
    if (!u.rowCount) { await c.query('ROLLBACK'); return res.status(400).json({ error: 'That admin email is already used' }); }
    await c.query('COMMIT');
    res.status(201).json({ store_id: sid });
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') return res.status(400).json({ error: 'A store with that name already exists' });
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  } finally {
    c.release();
  }
});

// ---------- daily operations (all scoped to one store) ----------
const allow = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) || req.user.role === 'platform_admin'
    ? next()
    : res.status(403).json({ error: 'Your role cannot do this' });
const STATUSES = ['pending', 'delivered', 'cancelled', 'returned'];
const PAY = ['Cash', 'UPI', 'EMI', 'Debit Card', 'Credit Card'];
const NEXT = { pending: ['delivered', 'cancelled'], delivered: ['returned'] }; // allowed status changes
const dbMsg = (e, res) => {
  if (e.code === 'P0001') return res.status(400).json({ error: e.message }); // message raised by our DB rules
  console.error(e);
  res.status(500).json({ error: 'Server error' });
};

const cleanText = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
const pick = (r, names) => {
  for (const n of names) if (r[n] !== undefined && r[n] !== null && String(r[n]).trim() !== '') return String(r[n]).trim();
  return '';
};
const MAX_ROWS = 2000;
async function ensureCategory(c, storeId, name) {
  const r = await c.query('SELECT category_id FROM categories WHERE store_id = $1 AND lower(category_name) = lower($2)', [storeId, name]);
  if (r.rowCount) return r.rows[0].category_id;
  const n = await c.query('INSERT INTO categories (store_id, category_name) VALUES ($1,$2) RETURNING category_id', [storeId, name]);
  return n.rows[0].category_id;
}
const importAudit = (c, req, action, details) =>
  c.query(`INSERT INTO audit_log (store_id, user_id, action, table_name, details) VALUES ($1,$2,$3,'import',$4)`,
    [req.storeId, req.user.id, action, JSON.stringify(details)]);
const importRows = (req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : null;
  if (!rows || !rows.length) { res.status(400).json({ error: 'No data rows found. The file needs a header line and at least one data line.' }); return null; }
  if (rows.length > MAX_ROWS) { res.status(400).json({ error: `Too many rows (maximum ${MAX_ROWS} per import)` }); return null; }
  return rows;
};
const importFail = (res, errs) =>
  res.status(400).json({ error: `Fix ${errs.length} problem(s) and try again. Nothing was imported.`, errors: errs.slice(0, 20) });

// ----- prices, products, tax -----
app.get('/api/products', auth, store, allow('super_admin', 'store_manager', 'inventory'), wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.product_id, p.product_name, c.category_name, p.unit_price,
            COALESCE(i.stock_qty,0) AS stock_qty, st.tax_rate
     FROM products p
     JOIN categories c ON c.category_id = p.category_id
     JOIN stores st ON st.store_id = p.store_id
     LEFT JOIN inventory i ON i.product_id = p.product_id AND i.store_id = p.store_id
     WHERE p.store_id = $1 AND p.is_active ORDER BY c.category_name, p.product_name`,
    [req.storeId]
  );
  res.json(rows);
}));

app.get('/api/store-settings', auth, store, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT store_name, city, tax_rate FROM stores WHERE store_id = $1', [req.storeId]);
  res.json(rows[0]);
}));

app.patch('/api/store-settings', auth, store, allow('super_admin'), wrap(async (req, res) => {
  const t = Number(req.body && req.body.tax_rate);
  if (!(t >= 0 && t <= 100)) return res.status(400).json({ error: 'Tax rate must be between 0 and 100' });
  await pool.query('UPDATE stores SET tax_rate = $1 WHERE store_id = $2', [t, req.storeId]);
  res.json({ ok: true });
}));

app.post('/api/products', auth, store, allow('super_admin', 'inventory'), wrap(async (req, res) => {
  const b = req.body || {};
  const name = cleanText(b.product_name), cat = cleanText(b.category);
  const price = Number(b.unit_price);
  const stock = b.opening_stock === undefined || b.opening_stock === '' ? 0 : Number(b.opening_stock);
  if (!name || name.length > 120 || !cat || cat.length > 60 || !(price >= 0 && price <= 1e9) || !Number.isInteger(stock) || stock < 0)
    return res.status(400).json({ error: 'Enter a name, a category, a price (0 or more) and a whole-number opening stock' });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const cid = await ensureCategory(c, req.storeId, cat);
    const ins = await c.query(
      `INSERT INTO products (store_id, product_name, category_id, unit_price) VALUES ($1,$2,$3,$4)
       ON CONFLICT (store_id, product_name) DO NOTHING RETURNING product_id`,
      [req.storeId, name, cid, price]
    );
    if (!ins.rowCount) { await c.query('ROLLBACK'); return res.status(400).json({ error: 'A product with that name already exists' }); }
    const pid = ins.rows[0].product_id;
    if (stock > 0) {
      await c.query('UPDATE inventory SET stock_qty = $1, last_updated = now() WHERE store_id = $2 AND product_id = $3', [stock, req.storeId, pid]);
      await c.query(`INSERT INTO stock_movements (store_id, product_id, change_qty, reason, created_by) VALUES ($1,$2,$3,'opening_stock',$4)`,
        [req.storeId, pid, stock, req.user.id]);
    }
    await c.query('COMMIT');
    res.status(201).json({ product_id: pid });
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}));

app.patch('/api/products/:id', auth, store, allow('super_admin', 'inventory'), wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { unit_price, is_active } = req.body || {};
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad product' });
  const sets = [], vals = [];
  if (unit_price !== undefined) {
    const p = Number(unit_price);
    if (!(p >= 0 && p <= 1e9)) return res.status(400).json({ error: 'Price must be 0 or more' });
    vals.push(p); sets.push('unit_price = $' + vals.length);
  }
  if (is_active !== undefined) { vals.push(!!is_active); sets.push('is_active = $' + vals.length); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });
  vals.push(id, req.storeId);
  const r = await pool.query(`UPDATE products SET ${sets.join(', ')} WHERE product_id = $${vals.length - 1} AND store_id = $${vals.length}`, vals);
  if (!r.rowCount) return res.status(404).json({ error: 'Product not found' });
  res.json({ ok: true });
}));

// ----- CSV imports (all or nothing: one bad row cancels the whole import) -----
app.post('/api/import/products', auth, store, allow('super_admin', 'inventory'), wrap(async (req, res) => {
  const rows = importRows(req, res); if (!rows) return;
  const errs = [], seen = new Set(), items = [];
  rows.forEach((r, i) => {
    const n = 'Row ' + (i + 1);
    const name = cleanText(pick(r, ['product_name', 'name', 'product']));
    const cat = cleanText(pick(r, ['category', 'category_name']));
    const priceRaw = pick(r, ['unit_price', 'price']);
    const stockRaw = pick(r, ['opening_stock', 'stock', 'quantity']);
    const reoRaw = pick(r, ['reorder_level', 'reorder']);
    const price = Number(priceRaw), stock = stockRaw === '' ? 0 : Number(stockRaw), reorder = reoRaw === '' ? null : Number(reoRaw);
    if (!name) errs.push(`${n}: product name is empty`);
    else if (name.length > 120) errs.push(`${n}: product name is too long`);
    else if (seen.has(name.toLowerCase())) errs.push(`${n}: "${name}" appears twice in the file`);
    seen.add(name.toLowerCase());
    if (!cat || cat.length > 60) errs.push(`${n}: category is empty or too long`);
    if (priceRaw === '' || !(price >= 0 && price <= 1e9)) errs.push(`${n}: price must be a number, 0 or more`);
    if (!Number.isInteger(stock) || stock < 0) errs.push(`${n}: opening stock must be a whole number, 0 or more`);
    if (reorder !== null && (!Number.isInteger(reorder) || reorder < 0)) errs.push(`${n}: reorder level must be a whole number`);
    items.push({ name, cat, price, stock, reorder });
  });
  if (errs.length) return importFail(res, errs);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // reuse existing category and product names (any capital letters), create the rest
    const ec = await c.query('SELECT category_name FROM categories WHERE store_id = $1', [req.storeId]);
    const catMap = new Map(ec.rows.map((r) => [r.category_name.toLowerCase(), r.category_name]));
    const ep = await c.query('SELECT product_name FROM products WHERE store_id = $1', [req.storeId]);
    const prodMap = new Map(ep.rows.map((r) => [r.product_name.toLowerCase(), r.product_name]));
    const newCats = new Set();
    items.forEach((it) => {
      const ck = it.cat.toLowerCase();
      if (catMap.has(ck)) it.cat = catMap.get(ck); else { catMap.set(ck, it.cat); newCats.add(it.cat); }
      const pk = it.name.toLowerCase();
      if (prodMap.has(pk)) it.name = prodMap.get(pk);
    });
    if (newCats.size)
      await c.query('INSERT INTO categories (store_id, category_name) SELECT $1, x FROM unnest($2::text[]) x ON CONFLICT (store_id, category_name) DO NOTHING', [req.storeId, [...newCats]]);
    const up = await c.query(
      `INSERT INTO products (store_id, product_name, category_id, unit_price, is_active)
       SELECT $1, t.name, c.category_id, t.price, TRUE
       FROM unnest($2::text[], $3::text[], $4::numeric[]) AS t(name, cat, price)
       JOIN categories c ON c.store_id = $1 AND c.category_name = t.cat
       ON CONFLICT (store_id, product_name)
       DO UPDATE SET unit_price = EXCLUDED.unit_price, category_id = EXCLUDED.category_id, is_active = TRUE
       RETURNING product_id, product_name, (xmax = 0) AS inserted`,
      [req.storeId, items.map((x) => x.name), items.map((x) => x.cat), items.map((x) => x.price)]
    );
    const byName = new Map(items.map((i) => [i.name, i]));
    const created = up.rows.filter((r) => r.inserted);
    const ids = [], stk = [], reo = [];
    created.forEach((r) => {
      const it = byName.get(r.product_name);
      ids.push(r.product_id); stk.push(it.stock); reo.push(it.reorder === null ? 100 : it.reorder);
    });
    if (ids.length) {
      await c.query(
        `UPDATE inventory i SET stock_qty = t.stk, reorder_level = t.reo, last_updated = now()
         FROM unnest($2::int[], $3::int[], $4::int[]) AS t(pid, stk, reo)
         WHERE i.store_id = $1 AND i.product_id = t.pid`,
        [req.storeId, ids, stk, reo]
      );
      await c.query(
        `INSERT INTO stock_movements (store_id, product_id, change_qty, reason, created_by)
         SELECT $1, t.pid, t.stk, 'opening_stock', $4 FROM unnest($2::int[], $3::int[]) AS t(pid, stk) WHERE t.stk > 0`,
        [req.storeId, ids, stk, req.user.id]
      );
    }
    await importAudit(c, req, 'import_products', { rows: items.length, created: created.length, updated: up.rows.length - created.length });
    await c.query('COMMIT');
    res.json({ created: created.length, updated: up.rows.length - created.length });
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}));

app.post('/api/import/customers', auth, store, allow('super_admin', 'store_manager'), wrap(async (req, res) => {
  const rows = importRows(req, res); if (!rows) return;
  const errs = [], names = [], ages = [], genders = [];
  rows.forEach((r, i) => {
    const n = 'Row ' + (i + 1);
    const name = cleanText(pick(r, ['customer_name', 'name']));
    const age = Number(pick(r, ['age']));
    const g = pick(r, ['gender', 'sex']).toLowerCase();
    const gender = ['m', 'male'].includes(g) ? 'Male' : ['f', 'female'].includes(g) ? 'Female' : null;
    if (!name || name.length > 120) errs.push(`${n}: name is empty or too long`);
    if (!Number.isInteger(age) || age < 10 || age > 100) errs.push(`${n}: age must be a whole number from 10 to 100`);
    if (!gender) errs.push(`${n}: gender must be Male or Female`);
    names.push(name); ages.push(age); genders.push(gender);
  });
  if (errs.length) return importFail(res, errs);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `INSERT INTO customers (customer_id, customer_name, age, gender, store_id)
       SELECT 'CUST' || nextval('customer_seq'), t.name, t.age, t.gender, $1
       FROM unnest($2::text[], $3::int[], $4::text[]) AS t(name, age, gender)`,
      [req.storeId, names, ages, genders]
    );
    await importAudit(c, req, 'import_customers', { rows: names.length });
    await c.query('COMMIT');
    res.json({ created: names.length });
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}));

app.post('/api/import/stock', auth, store, allow('super_admin', 'inventory'), wrap(async (req, res) => {
  const rows = importRows(req, res); if (!rows) return;
  const prods = await pool.query('SELECT product_id, product_name FROM products WHERE store_id = $1 AND is_active', [req.storeId]);
  const idByName = new Map(prods.rows.map((p) => [p.product_name.toLowerCase(), p.product_id]));
  const errs = [], add = new Map();
  rows.forEach((r, i) => {
    const n = 'Row ' + (i + 1);
    const name = cleanText(pick(r, ['product_name', 'name', 'product']));
    const q = Number(pick(r, ['quantity', 'qty', 'stock']));
    const pid = idByName.get(name.toLowerCase());
    if (!pid) errs.push(`${n}: product "${name}" was not found in this store`);
    if (!Number.isInteger(q) || q < 1) errs.push(`${n}: quantity must be a whole number, 1 or more`);
    if (pid && Number.isInteger(q) && q >= 1) add.set(pid, (add.get(pid) || 0) + q);
  });
  if (errs.length) return importFail(res, errs);
  const ids = [...add.keys()], qty = ids.map((k) => add.get(k));
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `UPDATE inventory i SET stock_qty = i.stock_qty + t.q, last_updated = now()
       FROM unnest($2::int[], $3::int[]) AS t(pid, q) WHERE i.store_id = $1 AND i.product_id = t.pid`,
      [req.storeId, ids, qty]
    );
    await c.query(
      `INSERT INTO stock_movements (store_id, product_id, change_qty, reason, created_by)
       SELECT $1, t.pid, t.q, 'restock', $4 FROM unnest($2::int[], $3::int[]) AS t(pid, q)`,
      [req.storeId, ids, qty, req.user.id]
    );
    await importAudit(c, req, 'import_stock', { products: ids.length });
    await c.query('COMMIT');
    res.json({ updated: ids.length });
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}));

// ----- customers and orders -----
app.get('/api/customers', auth, store, allow('super_admin', 'store_manager'), wrap(async (req, res) => {
  const q = '%' + (req.query.q || '') + '%';
  const { rows } = await pool.query(
    `SELECT customer_id, customer_name FROM customers
     WHERE store_id = $2 AND (customer_id ILIKE $1 OR customer_name ILIKE $1)
     ORDER BY customer_name LIMIT 15`,
    [q, req.storeId]
  );
  res.json(rows);
}));

app.post('/api/customers', auth, store, allow('super_admin', 'store_manager'), wrap(async (req, res) => {
  const { customer_name, age, gender } = req.body || {};
  const name = cleanText(customer_name);
  if (!name || name.length > 120 || !Number.isInteger(age) || age < 10 || age > 100 || !['Male', 'Female'].includes(gender))
    return res.status(400).json({ error: 'Enter a name, an age (10-100) and a gender' });
  const { rows } = await pool.query(
    `INSERT INTO customers (customer_id, customer_name, age, gender, store_id)
     VALUES ('CUST' || nextval('customer_seq')::text, $1, $2, $3, $4) RETURNING customer_id, customer_name`,
    [name, age, gender, req.storeId]
  );
  res.status(201).json(rows[0]);
}));

app.get('/api/orders', auth, store, allow('super_admin', 'store_manager', 'logistics'), wrap(async (req, res) => {
  const st = STATUSES.includes(req.query.status) ? req.query.status : null;
  const q = '%' + (req.query.q || '') + '%';
  const { rows } = await pool.query(
    `SELECT o.transaction_id, cu.customer_name, p.product_name, o.quantity, o.total_price,
            o.status, o.purchase_date, o.purchase_time
     FROM orders o LEFT JOIN customers cu USING (customer_id) JOIN products p USING (product_id)
     WHERE o.store_id = $3 AND ($1::text IS NULL OR o.status = $1) AND o.transaction_id ILIKE $2
     ORDER BY o.purchase_date DESC NULLS LAST, o.purchase_time DESC NULLS LAST LIMIT 30`,
    [st, q, req.storeId]
  );
  res.json(rows);
}));

// one order with full price breakdown (for the receipt)
app.get('/api/orders/:id', auth, store, allow('super_admin', 'store_manager', 'logistics'), wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.transaction_id, o.status, o.purchase_date, o.purchase_time, o.quantity, o.subtotal, o.discount,
            o.tax, o.total_price, o.payment_mode, cu.customer_name, p.product_name, s.store_name, s.city,
            CASE WHEN o.subtotal IS NOT NULL THEN round(o.subtotal / o.quantity, 2) END AS unit_price
     FROM orders o JOIN stores s ON s.store_id = o.store_id
     JOIN products p ON p.product_id = o.product_id
     LEFT JOIN customers cu ON cu.customer_id = o.customer_id
     WHERE o.transaction_id = $1 AND o.store_id = $2`,
    [req.params.id, req.storeId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Order not found' });
  res.json(rows[0]);
}));

// the price is calculated by the database (fn_place_order), not sent by the browser
app.post('/api/orders', auth, store, allow('super_admin', 'store_manager'), async (req, res) => {
  const { customer_id, product_id, quantity, discount_pct, payment_mode } = req.body || {};
  const disc = discount_pct === undefined || discount_pct === '' ? 0 : Number(discount_pct);
  if (!customer_id || !Number.isInteger(product_id) || !Number.isInteger(quantity) || quantity < 1 ||
      !(disc >= 0 && disc <= 100) || !PAY.includes(payment_mode))
    return res.status(400).json({ error: 'Fill customer, product, quantity (1+), discount (0-100) and payment mode' });
  try {
    const r = await pool.query('SELECT fn_place_order($1,$2,$3,$4,$5,$6) AS tid',
      [req.storeId, customer_id, product_id, quantity, disc, payment_mode]);
    const o = await pool.query('SELECT transaction_id, subtotal, discount, tax, total_price FROM orders WHERE transaction_id = $1', [r.rows[0].tid]);
    res.status(201).json(o.rows[0]);
  } catch (e) {
    dbMsg(e, res);
  }
});

// change order status (rules: pending -> delivered/cancelled, delivered -> returned)
app.post('/api/orders', auth, store, allow('super_admin', 'store_manager'), async (req, res) => {
  const { customer_id, product_id, quantity, discount_pct, payment_mode } = req.body || {};
  const disc = discount_pct === undefined || discount_pct === '' ? 0 : Number(discount_pct);
  if (!customer_id || !Number.isInteger(product_id) || !Number.isInteger(quantity) || quantity < 1 ||
      !(disc >= 0 && disc <= 100) || !PAY.includes(payment_mode))
    return res.status(400).json({ error: 'Fill customer, product, quantity (1+), discount (0-100) and payment mode' });
  try {
    const r = await pool.query('SELECT fn_place_order($1,$2,$3,$4,$5,$6) AS tid',
      [req.storeId, customer_id, product_id, quantity, disc, payment_mode]);
    const o = await pool.query('SELECT transaction_id, subtotal, discount, tax, total_price FROM orders WHERE transaction_id = $1', [r.rows[0].tid]);
    res.status(201).json(o.rows[0]);
  } catch (e) {
    dbMsg(e, res);
  }
});

// change order status (rules: pending -> delivered/cancelled, delivered -> returned)
app.patch('/api/orders/:id/status', auth, store, allow('super_admin', 'store_manager', 'logistics'), async (req, res) => {
  const { status } = req.body || {};
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const cur = await c.query(
      'SELECT status FROM orders WHERE transaction_id = $1 AND store_id = $2 FOR UPDATE',
      [req.params.id, req.storeId]
    );
    if (!cur.rowCount) { await c.query('ROLLBACK'); return res.status(404).json({ error: 'Order not found' }); }
    const from = cur.rows[0].status;
    if (!(NEXT[from] || []).includes(status)) {
      await c.query('ROLLBACK');
      return res.status(400).json({ error: `A ${from} order cannot become ${status}` });
    }
    await c.query('UPDATE orders SET status = $1 WHERE transaction_id = $2 AND store_id = $3', [status, req.params.id, req.storeId]);
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

app.post('/api/restock', auth, store, allow('super_admin', 'inventory'), async (req, res) => {
  const { product_id, quantity } = req.body || {};
  if (!Number.isInteger(product_id) || !Number.isInteger(quantity) || quantity < 1)
    return res.status(400).json({ error: 'Choose a product and a quantity of 1 or more' });
  try {
    const { rows } = await pool.query('SELECT fn_restock($1,$2,$3,$4) AS new_stock', [req.storeId, product_id, quantity, req.user.id]);
    res.json({ new_stock: rows[0].new_stock });
  } catch (e) {
    dbMsg(e, res);
  }
});

module.exports = app;
                                            
