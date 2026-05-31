require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// Database
// ============================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ============================================================
// Auto-init schema
// ============================================================
async function initSchema() {
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS branches (
        id SERIAL PRIMARY KEY,
        code VARCHAR(10) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        address TEXT,
        phone VARCHAR(20),
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      INSERT INTO branches (code, name) VALUES
        ('TB',   'สาขาตลาดสดธนบุรี บรมราชชนนี'),
        ('OM',   'สาขาทิวลิปแสควร์ อ้อมน้อย'),
        ('16KA', 'สาขาเดอะมอลล์ บางแค')
      ON CONFLICT (code) DO NOTHING
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS roles (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) UNIQUE NOT NULL,
        description TEXT
      )
    `);

    await pool.query(`
      INSERT INTO roles (name, description) VALUES
        ('owner',   'เจ้าของ — เห็นทุกอย่างรวมถึงราคาต้นทุน'),
        ('admin',   'แอดมิน — สิทธิ์เทียบเท่าเจ้าของ'),
        ('manager', 'ผู้จัดการร้าน — ไม่เห็นราคาต้นทุน'),
        ('cashier', 'แคชเชียร์ — ขายได้อย่างเดียว'),
        ('stock',   'สต๊อก — รับ/โอนสินค้าได้'),
        ('viewer',  'ดูรายงานได้อย่างเดียว')
      ON CONFLICT (name) DO NOTHING
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        full_name VARCHAR(100) NOT NULL,
        role_id INTEGER REFERENCES roles(id),
        branch_id INTEGER REFERENCES branches(id),
        phone VARCHAR(20),
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_login TIMESTAMPTZ
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS product_categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        type VARCHAR(20) DEFAULT 'egg',
        active BOOLEAN DEFAULT true
      )
    `);

    await pool.query(`
      INSERT INTO product_categories (name, type) VALUES
        ('ไข่ไก่', 'egg'),
        ('ของชำ', 'grocery'),
        ('บรรจุภัณฑ์', 'other')
      ON CONFLICT DO NOTHING
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        category_id INTEGER REFERENCES product_categories(id),
        code VARCHAR(30) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        unit VARCHAR(20) DEFAULT 'ฟอง',
        is_egg BOOLEAN DEFAULT false,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS product_prices (
        id SERIAL PRIMARY KEY,
        product_id INTEGER REFERENCES products(id),
        branch_id INTEGER REFERENCES branches(id),
        customer_type VARCHAR(20) NOT NULL,
        qty INTEGER NOT NULL,
        price NUMERIC(10,2) NOT NULL,
        active BOOLEAN DEFAULT true,
        UNIQUE(product_id, branch_id, customer_type, qty)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS stock (
        id SERIAL PRIMARY KEY,
        product_id INTEGER REFERENCES products(id),
        branch_id INTEGER REFERENCES branches(id),
        qty_unit INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(product_id, branch_id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS stock_receipts (
        id SERIAL PRIMARY KEY,
        branch_id INTEGER REFERENCES branches(id),
        receipt_date DATE NOT NULL DEFAULT CURRENT_DATE,
        supplier TEXT,
        note TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        created_by INTEGER REFERENCES users(id),
        priced_by INTEGER REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS stock_receipt_items (
        id SERIAL PRIMARY KEY,
        receipt_id INTEGER REFERENCES stock_receipts(id),
        product_id INTEGER REFERENCES products(id),
        qty_unit INTEGER NOT NULL,
        qty_tray INTEGER,
        cost_per_unit NUMERIC(10,4),
        total_cost NUMERIC(10,2)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS stock_transfers (
        id SERIAL PRIMARY KEY,
        from_branch_id INTEGER REFERENCES branches(id),
        to_branch_id INTEGER REFERENCES branches(id),
        transfer_date DATE NOT NULL DEFAULT CURRENT_DATE,
        status VARCHAR(20) DEFAULT 'pending',
        note TEXT,
        created_by INTEGER REFERENCES users(id),
        approved_by INTEGER REFERENCES users(id),
        approved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS stock_transfer_items (
        id SERIAL PRIMARY KEY,
        transfer_id INTEGER REFERENCES stock_transfers(id),
        product_id INTEGER REFERENCES products(id),
        qty_sent INTEGER NOT NULL,
        qty_received INTEGER
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS stock_adjustments (
        id SERIAL PRIMARY KEY,
        branch_id INTEGER REFERENCES branches(id),
        product_id INTEGER REFERENCES products(id),
        qty_change INTEGER NOT NULL,
        reason VARCHAR(50) NOT NULL,
        note TEXT,
        photo_url TEXT,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        code VARCHAR(20) UNIQUE,
        name VARCHAR(100) NOT NULL,
        customer_type VARCHAR(20) NOT NULL,
        phone VARCHAR(20),
        address TEXT,
        tax_id VARCHAR(20),
        company_name VARCHAR(150),
        credit_days INTEGER DEFAULT 0,
        points INTEGER DEFAULT 0,
        total_eggs_bought INTEGER DEFAULT 0,
        branch_id INTEGER REFERENCES branches(id),
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sales (
        id SERIAL PRIMARY KEY,
        sale_no VARCHAR(30) UNIQUE NOT NULL,
        branch_id INTEGER REFERENCES branches(id),
        customer_id INTEGER REFERENCES customers(id),
        customer_type VARCHAR(20) NOT NULL,
        cashier_id INTEGER REFERENCES users(id),
        sale_date DATE NOT NULL DEFAULT CURRENT_DATE,
        subtotal NUMERIC(10,2) NOT NULL DEFAULT 0,
        discount NUMERIC(10,2) DEFAULT 0,
        total NUMERIC(10,2) NOT NULL DEFAULT 0,
        payment_method VARCHAR(20),
        status VARCHAR(20) DEFAULT 'completed',
        void_reason TEXT,
        voided_by INTEGER REFERENCES users(id),
        note TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sale_items (
        id SERIAL PRIMARY KEY,
        sale_id INTEGER REFERENCES sales(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id),
        qty_set INTEGER NOT NULL,
        unit_size INTEGER NOT NULL,
        qty_unit INTEGER NOT NULL,
        price_per_set NUMERIC(10,2) NOT NULL,
        subtotal NUMERIC(10,2) NOT NULL
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id SERIAL PRIMARY KEY,
        invoice_no VARCHAR(30) UNIQUE NOT NULL,
        sale_id INTEGER REFERENCES sales(id),
        customer_id INTEGER REFERENCES customers(id),
        branch_id INTEGER REFERENCES branches(id),
        issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
        due_date DATE,
        total NUMERIC(10,2) NOT NULL,
        paid_amount NUMERIC(10,2) DEFAULT 0,
        status VARCHAR(20) DEFAULT 'unpaid',
        note TEXT,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS invoice_payments (
        id SERIAL PRIMARY KEY,
        invoice_id INTEGER REFERENCES invoices(id),
        paid_date DATE NOT NULL DEFAULT CURRENT_DATE,
        amount NUMERIC(10,2) NOT NULL,
        method VARCHAR(20),
        note TEXT,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS promotions (
        id SERIAL PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        branch_id INTEGER REFERENCES branches(id),
        promo_type VARCHAR(20) NOT NULL,
        product_id INTEGER REFERENCES products(id),
        min_qty INTEGER DEFAULT 1,
        discount_value NUMERIC(10,2),
        free_product_id INTEGER REFERENCES products(id),
        free_qty INTEGER,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        active BOOLEAN DEFAULT true,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS expense_categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL
      )
    `);

    await pool.query(`
      INSERT INTO expense_categories (name) VALUES
        ('ค่าแรงพนักงาน'), ('ค่าน้ำมัน'), ('ค่าเช่าร้าน'),
        ('ค่าบรรจุภัณฑ์'), ('ค่าสาธารณูปโภค'), ('อื่นๆ')
      ON CONFLICT DO NOTHING
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id SERIAL PRIMARY KEY,
        branch_id INTEGER REFERENCES branches(id),
        category_id INTEGER REFERENCES expense_categories(id),
        amount NUMERIC(10,2) NOT NULL,
        expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
        note TEXT,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS damage_photos (
        id SERIAL PRIMARY KEY,
        branch_id INTEGER REFERENCES branches(id),
        product_id INTEGER REFERENCES products(id),
        photo_url TEXT NOT NULL,
        photo_date DATE NOT NULL DEFAULT CURRENT_DATE,
        note TEXT,
        uploaded_by INTEGER REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // สร้าง admin user เริ่มต้น ถ้ายังไม่มี
    const userCheck = await pool.query(`SELECT id FROM users WHERE username = 'admin'`);
    if (userCheck.rows.length === 0) {
      const hash = await bcrypt.hash('password', 10);
      await pool.query(`
        INSERT INTO users (username, password_hash, full_name, role_id, branch_id)
        VALUES ('admin', $1, 'เจ้าของร้าน', 1, NULL)
      `, [hash]);
      console.log('✅ สร้าง admin user เริ่มต้นแล้ว (password: password)');
    }

    console.log('✅ Database schema พร้อมใช้งาน');
  } catch (err) {
    console.error('❌ Schema init error:', err.message);
  }
}

// ============================================================
// Middleware
// ============================================================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// Upload
const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });
app.use('/uploads', express.static(uploadDir));

// ============================================================
// Auth Middleware
// ============================================================
function authMiddleware(req, res, next) {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token ไม่ถูกต้องหรือหมดอายุ' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role))
      return res.status(403).json({ error: 'ไม่มีสิทธิ์ใช้งานส่วนนี้' });
    next();
  };
}

// ============================================================
// AUTH ROUTES
// ============================================================
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });
  try {
    const result = await pool.query(`
      SELECT u.*, r.name AS role, b.code AS branch_code, b.name AS branch_name
      FROM users u
      JOIN roles r ON u.role_id = r.id
      LEFT JOIN branches b ON u.branch_id = b.id
      WHERE u.username = $1 AND u.active = true
    `, [username]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'ไม่พบผู้ใช้งาน' });
    if (!await bcrypt.compare(password, user.password_hash))
      return res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
    const token = jwt.sign(
      { id: user.id, username: user.username, full_name: user.full_name, role: user.role, branch_id: user.branch_id, branch_code: user.branch_code },
      process.env.JWT_SECRET, { expiresIn: '8h' }
    );
    res.json({ token, user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role, branch_id: user.branch_id, branch_code: user.branch_code, branch_name: user.branch_name } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.username, u.full_name, u.phone, u.branch_id,
             b.code AS branch_code, b.name AS branch_name, r.name AS role, u.last_login
      FROM users u JOIN roles r ON u.role_id = r.id LEFT JOIN branches b ON u.branch_id = b.id
      WHERE u.id = $1
    `, [req.user.id]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

// ============================================================
// BRANCHES
// ============================================================
app.get('/api/branches', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM branches WHERE active = true ORDER BY id');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

// ============================================================
// USERS
// ============================================================
app.get('/api/users', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.username, u.full_name, u.phone, u.active,
             u.branch_id, b.code AS branch_code, b.name AS branch_name,
             r.id AS role_id, r.name AS role, u.last_login
      FROM users u JOIN roles r ON u.role_id = r.id LEFT JOIN branches b ON u.branch_id = b.id
      ORDER BY u.id
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.post('/api/users', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
  const { username, password, full_name, role_id, branch_id, phone } = req.body;
  if (!username || !password || !full_name || !role_id)
    return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, password_hash, full_name, role_id, branch_id, phone) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, username, full_name',
      [username, hash, full_name, role_id, branch_id || null, phone || null]
    );
    res.status(201).json({ message: 'สร้างผู้ใช้งานเรียบร้อย', user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'username นี้มีอยู่แล้ว' });
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

app.put('/api/users/:id', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
  const { full_name, role_id, branch_id, phone, active } = req.body;
  try {
    await pool.query('UPDATE users SET full_name=$1,role_id=$2,branch_id=$3,phone=$4,active=$5 WHERE id=$6',
      [full_name, role_id, branch_id || null, phone || null, active, req.params.id]);
    res.json({ message: 'แก้ไขเรียบร้อย' });
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.post('/api/users/:id/reset-password', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
  const { new_password } = req.body;
  if (!new_password || new_password.length < 6)
    return res.status(400).json({ error: 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร' });
  try {
    const hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.params.id]);
    res.json({ message: 'Reset รหัสผ่านเรียบร้อย' });
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.get('/api/roles', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM roles ORDER BY id');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

// ============================================================
// PRODUCTS
// ============================================================
app.get('/api/products', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, pc.name AS category_name, pc.type AS category_type
      FROM products p JOIN product_categories pc ON p.category_id = pc.id
      WHERE p.active = true ORDER BY pc.type, p.code
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.post('/api/products', authMiddleware, requireRole('owner', 'admin', 'manager'), async (req, res) => {
  const { category_id, code, name, unit, is_egg } = req.body;
  if (!category_id || !code || !name) return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });
  try {
    const result = await pool.query(
      'INSERT INTO products (category_id, code, name, unit, is_egg) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [category_id, code, name, unit || 'ฟอง', is_egg || false]
    );
    res.status(201).json({ message: 'เพิ่มสินค้าเรียบร้อย', product: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'รหัสสินค้านี้มีอยู่แล้ว' });
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

app.put('/api/products/:id', authMiddleware, requireRole('owner', 'admin', 'manager'), async (req, res) => {
  const { name, unit, active } = req.body;
  try {
    await pool.query('UPDATE products SET name=$1,unit=$2,active=$3 WHERE id=$4', [name, unit, active, req.params.id]);
    res.json({ message: 'แก้ไขเรียบร้อย' });
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.get('/api/product-categories', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM product_categories WHERE active=true ORDER BY id');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

// ราคาสินค้า
app.get('/api/products/:id/prices', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT pp.*, b.code AS branch_code, b.name AS branch_name
      FROM product_prices pp JOIN branches b ON pp.branch_id = b.id
      WHERE pp.product_id = $1 ORDER BY b.code, pp.customer_type, pp.qty
    `, [req.params.id]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.post('/api/products/:id/prices', authMiddleware, requireRole('owner', 'admin', 'manager'), async (req, res) => {
  const { branch_id, customer_type, qty, price } = req.body;
  try {
    await pool.query(`
      INSERT INTO product_prices (product_id, branch_id, customer_type, qty, price)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (product_id, branch_id, customer_type, qty) DO UPDATE SET price=EXCLUDED.price, active=true
    `, [req.params.id, branch_id, customer_type, qty, price]);
    res.json({ message: 'ตั้งราคาเรียบร้อย' });
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

// ดึงราคาสำหรับ POS
app.get('/api/pos/products', authMiddleware, async (req, res) => {
  const { branch_id, customer_type } = req.query;
  if (!branch_id || !customer_type) return res.status(400).json({ error: 'กรุณาระบุ branch_id และ customer_type' });
  try {
    const result = await pool.query(`
      SELECT p.id AS product_id, p.code, p.name, p.unit, p.is_egg,
             pp.qty, pp.price, COALESCE(s.qty_unit, 0) AS stock_qty
      FROM product_prices pp
      JOIN products p ON pp.product_id = p.id
      LEFT JOIN stock s ON s.product_id = p.id AND s.branch_id = $1
      WHERE pp.branch_id = $1 AND pp.customer_type = $2 AND pp.active=true AND p.active=true
      ORDER BY p.is_egg DESC, p.code, pp.qty
    `, [branch_id, customer_type]);
    const grouped = {};
    result.rows.forEach(row => {
      if (!grouped[row.product_id]) {
        grouped[row.product_id] = { product_id: row.product_id, code: row.code, name: row.name, unit: row.unit, is_egg: row.is_egg, stock_qty: parseInt(row.stock_qty), prices: [] };
      }
      grouped[row.product_id].prices.push({ qty: row.qty, price: parseFloat(row.price) });
    });
    res.json(Object.values(grouped));
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

// ============================================================
// STOCK
// ============================================================
app.get('/api/stock', authMiddleware, async (req, res) => {
  const { branch_id } = req.query;
  try {
    let q = `
      SELECT s.*, p.name AS product_name, p.code, p.unit, p.is_egg,
             b.code AS branch_code, b.name AS branch_name
      FROM stock s JOIN products p ON s.product_id = p.id JOIN branches b ON s.branch_id = b.id
      WHERE p.active = true
    `;
    const params = [];
    if (branch_id) { q += ' AND s.branch_id = $1'; params.push(branch_id); }
    q += ' ORDER BY b.code, p.code';
    const result = await pool.query(q, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

// รับสินค้าเข้า
app.post('/api/stock/receive', authMiddleware, requireRole('owner', 'admin', 'manager', 'stock'), async (req, res) => {
  const { branch_id, supplier, note, items } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const receipt = await client.query(
      'INSERT INTO stock_receipts (branch_id, supplier, note, created_by) VALUES ($1,$2,$3,$4) RETURNING id',
      [branch_id, supplier, note, req.user.id]
    );
    const receiptId = receipt.rows[0].id;
    for (const item of items) {
      await client.query(
        'INSERT INTO stock_receipt_items (receipt_id, product_id, qty_unit, qty_tray) VALUES ($1,$2,$3,$4)',
        [receiptId, item.product_id, item.qty_unit, item.qty_tray || null]
      );
      await client.query(`
        INSERT INTO stock (product_id, branch_id, qty_unit) VALUES ($1,$2,$3)
        ON CONFLICT (product_id, branch_id) DO UPDATE SET qty_unit = stock.qty_unit + $3, updated_at = NOW()
      `, [item.product_id, branch_id, item.qty_unit]);
    }
    await client.query('COMMIT');
    res.status(201).json({ message: 'รับสินค้าเข้าเรียบร้อย', receipt_id: receiptId });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  } finally { client.release(); }
});

// โอนย้ายสินค้า
app.post('/api/stock/transfer', authMiddleware, requireRole('owner', 'admin', 'manager', 'stock'), async (req, res) => {
  const { from_branch_id, to_branch_id, note, items } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const transfer = await client.query(
      'INSERT INTO stock_transfers (from_branch_id, to_branch_id, note, created_by) VALUES ($1,$2,$3,$4) RETURNING id',
      [from_branch_id, to_branch_id, note, req.user.id]
    );
    const transferId = transfer.rows[0].id;
    for (const item of items) {
      await client.query(
        'INSERT INTO stock_transfer_items (transfer_id, product_id, qty_sent) VALUES ($1,$2,$3)',
        [transferId, item.product_id, item.qty_sent]
      );
      // ตัดสต๊อกต้นทาง
      await client.query(`
        UPDATE stock SET qty_unit = qty_unit - $1, updated_at = NOW()
        WHERE product_id = $2 AND branch_id = $3
      `, [item.qty_sent, item.product_id, from_branch_id]);
    }
    await client.query('COMMIT');
    res.status(201).json({ message: 'สร้างการโอนย้ายเรียบร้อย', transfer_id: transferId });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  } finally { client.release(); }
});

// อนุมัติการโอนย้าย
app.post('/api/stock/transfer/:id/approve', authMiddleware, async (req, res) => {
  const { items } = req.body; // items = [{ transfer_item_id, qty_received }]
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const transfer = await client.query('SELECT * FROM stock_transfers WHERE id=$1', [req.params.id]);
    const t = transfer.rows[0];
    for (const item of items) {
      const ti = await client.query('SELECT * FROM stock_transfer_items WHERE id=$1', [item.transfer_item_id]);
      const tiRow = ti.rows[0];
      const received = item.qty_received;
      const returned = tiRow.qty_sent - received;
      await client.query('UPDATE stock_transfer_items SET qty_received=$1 WHERE id=$2', [received, item.transfer_item_id]);
      // เพิ่มสต๊อกปลายทาง
      await client.query(`
        INSERT INTO stock (product_id, branch_id, qty_unit) VALUES ($1,$2,$3)
        ON CONFLICT (product_id, branch_id) DO UPDATE SET qty_unit = stock.qty_unit + $3, updated_at = NOW()
      `, [tiRow.product_id, t.to_branch_id, received]);
      // คืนส่วนต่างกลับต้นทาง
      if (returned > 0) {
        await client.query(`
          UPDATE stock SET qty_unit = qty_unit + $1, updated_at = NOW()
          WHERE product_id = $2 AND branch_id = $3
        `, [returned, tiRow.product_id, t.from_branch_id]);
      }
    }
    const hasPartial = items.some(i => {
      const ti = i.qty_received;
      return ti !== undefined;
    });
    await client.query(
      'UPDATE stock_transfers SET status=$1, approved_by=$2, approved_at=NOW() WHERE id=$3',
      ['approved', req.user.id, req.params.id]
    );
    await client.query('COMMIT');
    res.json({ message: 'อนุมัติเรียบร้อย' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  } finally { client.release(); }
});

// ============================================================
// CUSTOMERS
// ============================================================
app.get('/api/customers', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*, b.code AS branch_code FROM customers c
      LEFT JOIN branches b ON c.branch_id = b.id
      WHERE c.active = true ORDER BY c.name
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.post('/api/customers', authMiddleware, requireRole('owner', 'admin', 'manager', 'cashier'), async (req, res) => {
  const { name, customer_type, phone, address, tax_id, company_name, credit_days, branch_id } = req.body;
  if (!name || !customer_type) return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });
  try {
    const result = await pool.query(
      'INSERT INTO customers (name, customer_type, phone, address, tax_id, company_name, credit_days, branch_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [name, customer_type, phone, address, tax_id, company_name, credit_days || 0, branch_id || null]
    );
    res.status(201).json({ message: 'เพิ่มลูกค้าเรียบร้อย', customer: result.rows[0] });
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.put('/api/customers/:id', authMiddleware, requireRole('owner', 'admin', 'manager'), async (req, res) => {
  const { name, phone, address, tax_id, company_name, credit_days, active } = req.body;
  try {
    await pool.query(
      'UPDATE customers SET name=$1,phone=$2,address=$3,tax_id=$4,company_name=$5,credit_days=$6,active=$7 WHERE id=$8',
      [name, phone, address, tax_id, company_name, credit_days, active, req.params.id]
    );
    res.json({ message: 'แก้ไขเรียบร้อย' });
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

// ============================================================
// SALES (POS)
// ============================================================
async function generateSaleNo(branchCode) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const result = await pool.query(
    `SELECT COUNT(*) FROM sales WHERE sale_no LIKE $1`,
    [`${branchCode}-${today}-%`]
  );
  const seq = parseInt(result.rows[0].count) + 1;
  return `${branchCode}-${today}-${String(seq).padStart(3, '0')}`;
}

app.post('/api/sales', authMiddleware, requireRole('owner', 'admin', 'manager', 'cashier'), async (req, res) => {
  const { branch_id, branch_code, customer_id, customer_type, items, discount, payment_method, note } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sale_no = await generateSaleNo(branch_code || 'XX');
    let subtotal = 0;
    for (const item of items) subtotal += item.qty_set * item.price_per_set;
    const total = subtotal - (discount || 0);
    const sale = await client.query(
      'INSERT INTO sales (sale_no, branch_id, customer_id, customer_type, cashier_id, subtotal, discount, total, payment_method, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
      [sale_no, branch_id, customer_id || null, customer_type, req.user.id, subtotal, discount || 0, total, payment_method, note]
    );
    const saleId = sale.rows[0].id;
    for (const item of items) {
      const qty_unit = item.qty_set * item.unit_size;
      await client.query(
        'INSERT INTO sale_items (sale_id, product_id, qty_set, unit_size, qty_unit, price_per_set, subtotal) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [saleId, item.product_id, item.qty_set, item.unit_size, qty_unit, item.price_per_set, item.qty_set * item.price_per_set]
      );
      // ตัดสต๊อก
      await client.query(
        'UPDATE stock SET qty_unit = qty_unit - $1, updated_at = NOW() WHERE product_id = $2 AND branch_id = $3',
        [qty_unit, item.product_id, branch_id]
      );
    }
    // อัพเดทคะแนนลูกค้า (นับฟอง)
    if (customer_id) {
      const totalEggs = items.filter(i => i.is_egg).reduce((sum, i) => sum + i.qty_set * i.unit_size, 0);
      if (totalEggs > 0) {
        await client.query(
          'UPDATE customers SET points = points + $1, total_eggs_bought = total_eggs_bought + $1 WHERE id = $2',
          [totalEggs, customer_id]
        );
      }
    }
    // สร้างใบแจ้งหนี้อัตโนมัติถ้าเป็นลูกค้าส่ง
    if (customer_type === 'wholesale' && payment_method === 'credit') {
      const customer = await client.query('SELECT * FROM customers WHERE id=$1', [customer_id]);
      const c = customer.rows[0];
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + (c.credit_days || 7));
      const invoiceNo = 'INV-' + sale_no;
      await client.query(
        'INSERT INTO invoices (invoice_no, sale_id, customer_id, branch_id, due_date, total, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [invoiceNo, saleId, customer_id, branch_id, dueDate.toISOString().slice(0, 10), total, req.user.id]
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ message: 'บันทึกการขายเรียบร้อย', sale_no, sale_id: saleId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  } finally { client.release(); }
});

app.get('/api/sales', authMiddleware, async (req, res) => {
  const { branch_id, date, customer_id } = req.query;
  try {
    let q = `
      SELECT s.*, c.name AS customer_name, u.full_name AS cashier_name, b.code AS branch_code
      FROM sales s
      LEFT JOIN customers c ON s.customer_id = c.id
      JOIN users u ON s.cashier_id = u.id
      JOIN branches b ON s.branch_id = b.id
      WHERE 1=1
    `;
    const params = [];
    if (branch_id && !['owner','admin'].includes(req.user.role)) {
      params.push(req.user.branch_id);
      q += ` AND s.branch_id = $${params.length}`;
    } else if (branch_id) {
      params.push(branch_id);
      q += ` AND s.branch_id = $${params.length}`;
    }
    if (date) { params.push(date); q += ` AND s.sale_date = $${params.length}`; }
    if (customer_id) { params.push(customer_id); q += ` AND s.customer_id = $${params.length}`; }
    q += ' ORDER BY s.created_at DESC LIMIT 100';
    const result = await pool.query(q, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.get('/api/sales/:id/items', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT si.*, p.name AS product_name, p.code
      FROM sale_items si JOIN products p ON si.product_id = p.id
      WHERE si.sale_id = $1
    `, [req.params.id]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

// ============================================================
// INVOICES
// ============================================================
app.get('/api/invoices', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT i.*, c.name AS customer_name, c.company_name, b.code AS branch_code
      FROM invoices i JOIN customers c ON i.customer_id = c.id JOIN branches b ON i.branch_id = b.id
      ORDER BY i.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.post('/api/invoices/:id/pay', authMiddleware, async (req, res) => {
  const { amount, method, note } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO invoice_payments (invoice_id, amount, method, note, created_by) VALUES ($1,$2,$3,$4,$5)',
      [req.params.id, amount, method, note, req.user.id]
    );
    const inv = await client.query('SELECT total, paid_amount FROM invoices WHERE id=$1', [req.params.id]);
    const newPaid = parseFloat(inv.rows[0].paid_amount) + parseFloat(amount);
    const status = newPaid >= parseFloat(inv.rows[0].total) ? 'paid' : 'partial';
    await client.query('UPDATE invoices SET paid_amount=$1, status=$2 WHERE id=$3', [newPaid, status, req.params.id]);
    await client.query('COMMIT');
    res.json({ message: 'บันทึกการชำระเงินเรียบร้อย' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  } finally { client.release(); }
});

// ============================================================
// REPORTS
// ============================================================
app.get('/api/reports/daily', authMiddleware, async (req, res) => {
  const { date, branch_id } = req.query;
  const targetDate = date || new Date().toISOString().slice(0, 10);
  try {
    let branchFilter = '';
    const params = [targetDate];
    if (branch_id) { params.push(branch_id); branchFilter = ` AND s.branch_id = $${params.length}`; }
    const sales = await pool.query(`
      SELECT b.code AS branch_code, b.name AS branch_name,
             COUNT(s.id) AS total_bills,
             SUM(s.total) AS total_revenue,
             SUM(s.discount) AS total_discount
      FROM sales s JOIN branches b ON s.branch_id = b.id
      WHERE s.sale_date = $1 AND s.status = 'completed' ${branchFilter}
      GROUP BY b.id, b.code, b.name ORDER BY b.code
    `, params);
    res.json({ date: targetDate, branches: sales.rows });
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.get('/api/reports/stock-summary', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.code, p.name, p.unit, p.is_egg,
             json_agg(json_build_object('branch_code', b.code, 'qty', s.qty_unit) ORDER BY b.code) AS by_branch,
             SUM(s.qty_unit) AS total_qty
      FROM stock s JOIN products p ON s.product_id = p.id JOIN branches b ON s.branch_id = b.id
      WHERE p.active = true
      GROUP BY p.id, p.code, p.name, p.unit, p.is_egg
      ORDER BY p.is_egg DESC, p.code
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

// ============================================================
// UPLOAD รูปไข่บุบ
// ============================================================
app.post('/api/damage-photos', authMiddleware, upload.single('photo'), async (req, res) => {
  const { branch_id, product_id, note } = req.body;
  if (!req.file) return res.status(400).json({ error: 'กรุณาเลือกรูป' });
  try {
    await pool.query(
      'INSERT INTO damage_photos (branch_id, product_id, photo_url, note, uploaded_by) VALUES ($1,$2,$3,$4,$5)',
      [branch_id, product_id, '/uploads/' + req.file.filename, note, req.user.id]
    );
    res.json({ message: 'อัพโหลดรูปเรียบร้อย', url: '/uploads/' + req.file.filename });
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.get('/api/damage-photos', authMiddleware, async (req, res) => {
  const { branch_id, date } = req.query;
  try {
    let q = `
      SELECT dp.*, p.name AS product_name, b.code AS branch_code, u.full_name AS uploaded_by_name
      FROM damage_photos dp JOIN products p ON dp.product_id = p.id
      JOIN branches b ON dp.branch_id = b.id JOIN users u ON dp.uploaded_by = u.id
      WHERE 1=1
    `;
    const params = [];
    if (branch_id) { params.push(branch_id); q += ` AND dp.branch_id = $${params.length}`; }
    if (date) { params.push(date); q += ` AND dp.photo_date = $${params.length}`; }
    q += ' ORDER BY dp.created_at DESC';
    const result = await pool.query(q, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

// ============================================================
// Serve index.html
// ============================================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================================
// Start
// ============================================================
initSchema().then(() => {
  app.listen(PORT, () => {
    console.log(`🥚 EggShop running on port ${PORT}`);
  });
});
