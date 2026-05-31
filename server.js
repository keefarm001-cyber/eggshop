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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway') ? { rejectUnauthorized: false } : false
});

// ============================================================
// SCHEMA INIT
// ============================================================
async function initSchema() {
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // branches
    await pool.query(`CREATE TABLE IF NOT EXISTS branches (id SERIAL PRIMARY KEY, code VARCHAR(10) UNIQUE NOT NULL, name VARCHAR(100) NOT NULL, address TEXT, phone VARCHAR(20), active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`INSERT INTO branches (code,name) VALUES ('TB','สาขาตลาดสดธนบุรี'),('OM','สาขาทิวลิปแสควร์ อ้อมน้อย'),('16KA','สาขาเดอะมอลล์ บางแค') ON CONFLICT (code) DO NOTHING`);

    // roles
    await pool.query(`CREATE TABLE IF NOT EXISTS roles (id SERIAL PRIMARY KEY, name VARCHAR(50) UNIQUE NOT NULL, description TEXT)`);
    await pool.query(`INSERT INTO roles (name,description) VALUES ('owner','เจ้าของ'),('admin','แอดมิน'),('manager','ผู้จัดการ'),('cashier','แคชเชียร์'),('stock','สต๊อก'),('viewer','ผู้ชม') ON CONFLICT (name) DO NOTHING`);

    // users
    await pool.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username VARCHAR(50) UNIQUE NOT NULL, password_hash TEXT NOT NULL, full_name VARCHAR(100) NOT NULL, role_id INTEGER REFERENCES roles(id), branch_id INTEGER REFERENCES branches(id), phone VARCHAR(20), active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW(), last_login TIMESTAMPTZ)`);

    // doc_sequences - สำหรับเลขที่เอกสาร
    await pool.query(`CREATE TABLE IF NOT EXISTS doc_sequences (id SERIAL PRIMARY KEY, doc_type VARCHAR(30) UNIQUE NOT NULL, prefix VARCHAR(20) NOT NULL, last_seq INTEGER DEFAULT 0, year_month VARCHAR(10))`);
    await pool.query(`INSERT INTO doc_sequences (doc_type, prefix) VALUES ('invoice','INV'),('receipt','RCP'),('receipt_pre','PRE'),('receipt_final','GR'),('quotation','QT'),('debit_note','DN'),('credit_note','CN') ON CONFLICT (doc_type) DO NOTHING`);

    // member_settings
    await pool.query(`CREATE TABLE IF NOT EXISTS member_settings (id SERIAL PRIMARY KEY, eggs_required INTEGER NOT NULL DEFAULT 100, discount_amount NUMERIC(10,2) NOT NULL DEFAULT 5, updated_at TIMESTAMPTZ DEFAULT NOW())`);
    const ms = await pool.query(`SELECT id FROM member_settings`);
    if (ms.rows.length === 0) await pool.query(`INSERT INTO member_settings (eggs_required,discount_amount) VALUES (100,5)`);

    // members
    await pool.query(`CREATE TABLE IF NOT EXISTS members (id SERIAL PRIMARY KEY, code VARCHAR(20) UNIQUE, name VARCHAR(100) NOT NULL, phone VARCHAR(20), branch_id INTEGER REFERENCES branches(id), total_eggs INTEGER DEFAULT 0, redeemable_discount NUMERIC(10,2) DEFAULT 0, total_redeemed NUMERIC(10,2) DEFAULT 0, active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW())`);

    // product_categories
    await pool.query(`CREATE TABLE IF NOT EXISTS product_categories (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, type VARCHAR(20) DEFAULT 'stock', active BOOLEAN DEFAULT true)`);
    const catCheck = await pool.query(`SELECT id FROM product_categories WHERE name='ไข่ไก่'`);
    if (catCheck.rows.length === 0) {
      await pool.query(`INSERT INTO product_categories (name,type) VALUES ('ไข่ไก่','stock'),('ของชำ','stock'),('บรรจุภัณฑ์','stock'),('บริการ','service'),('อื่นๆ ไม่นับสต๊อก','nostock'),('ไข่เสริม','stock'),('บรรจุภัณฑ์ไข่','stock')`);
    }

    // products
    await pool.query(`CREATE TABLE IF NOT EXISTS products (id SERIAL PRIMARY KEY, category_id INTEGER REFERENCES product_categories(id), code VARCHAR(30) UNIQUE NOT NULL, name VARCHAR(100) NOT NULL, unit VARCHAR(20) DEFAULT 'ฟอง', is_egg BOOLEAN DEFAULT false, track_stock BOOLEAN DEFAULT true, active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW())`);
    // add track_stock column if not exists
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS track_stock BOOLEAN DEFAULT true`);

    const eggCat = await pool.query(`SELECT id FROM product_categories WHERE name='ไข่ไก่'`);
    const catId = eggCat.rows[0].id;
    // เพิ่มกลุ่มสินค้าใหม่ถ้ายังไม่มี (ตรวจสอบก่อนเสมอ)
    const extraCatNames = ['ไข่เสริม','บรรจุภัณฑ์ไข่'];
    for (const name of extraCatNames) {
      const ec = await pool.query('SELECT id FROM product_categories WHERE name=$1', [name]);
      if (ec.rows.length === 0) await pool.query('INSERT INTO product_categories (name,type) VALUES ($1,$2)', [name, 'stock']);
    }
    const eggProducts = [['EGG-0','ไข่ไก่เบอร์ 0'],['EGG-1','ไข่ไก่เบอร์ 1'],['EGG-2','ไข่ไก่เบอร์ 2'],['EGG-3','ไข่ไก่เบอร์ 3'],['EGG-4','ไข่ไก่เบอร์ 4'],['EGG-5','ไข่ไก่เบอร์ 5'],['EGG-6','ไข่ไก่เบอร์ 6'],['EGG-BANG-L','ไข่บางใหญ่'],['EGG-BANG-M','ไข่บางกลาง'],['EGG-BANG-S','ไข่บางเล็ก']];
    for (const [code,name] of eggProducts) await pool.query(`INSERT INTO products (category_id,code,name,unit,is_egg,track_stock) VALUES ($1,$2,$3,'ฟอง',true,true) ON CONFLICT (code) DO NOTHING`, [catId, code, name]);

    // product_prices
    await pool.query(`CREATE TABLE IF NOT EXISTS product_prices (id SERIAL PRIMARY KEY, product_id INTEGER REFERENCES products(id), branch_id INTEGER REFERENCES branches(id), customer_type VARCHAR(20) NOT NULL, qty INTEGER NOT NULL, price NUMERIC(10,2) NOT NULL, active BOOLEAN DEFAULT true, UNIQUE(product_id,branch_id,customer_type,qty))`);

    // stock
    await pool.query(`CREATE TABLE IF NOT EXISTS stock (id SERIAL PRIMARY KEY, product_id INTEGER REFERENCES products(id), branch_id INTEGER REFERENCES branches(id), qty_unit INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(product_id,branch_id))`);

    // stock_movements
    await pool.query(`CREATE TABLE IF NOT EXISTS stock_movements (id SERIAL PRIMARY KEY, product_id INTEGER REFERENCES products(id), branch_id INTEGER REFERENCES branches(id), movement_type VARCHAR(30) NOT NULL, qty_change INTEGER NOT NULL, qty_before INTEGER, qty_after INTEGER, ref_type VARCHAR(30), ref_id INTEGER, note TEXT, created_by INTEGER REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT NOW())`);

    // stock_receipts (Pre = ผู้จัดการสร้าง, ไม่เห็นราคา)
    await pool.query(`CREATE TABLE IF NOT EXISTS stock_receipts (id SERIAL PRIMARY KEY, doc_no VARCHAR(30), branch_id INTEGER REFERENCES branches(id), receipt_date DATE NOT NULL DEFAULT CURRENT_DATE, supplier_id INTEGER, supplier_name TEXT, note TEXT, photo_url TEXT, status VARCHAR(20) DEFAULT 'pre', total_cost NUMERIC(10,2), created_by INTEGER REFERENCES users(id), priced_by INTEGER REFERENCES users(id), priced_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`ALTER TABLE stock_receipts ADD COLUMN IF NOT EXISTS doc_no VARCHAR(30)`);
    await pool.query(`ALTER TABLE stock_receipts ADD COLUMN IF NOT EXISTS supplier_id INTEGER`);
    await pool.query(`ALTER TABLE stock_receipts ADD COLUMN IF NOT EXISTS supplier_name TEXT`);
    await pool.query(`ALTER TABLE stock_receipts ADD COLUMN IF NOT EXISTS total_cost NUMERIC(10,2)`);
    await pool.query(`ALTER TABLE stock_receipts ADD COLUMN IF NOT EXISTS priced_at TIMESTAMPTZ`);

    await pool.query(`CREATE TABLE IF NOT EXISTS stock_receipt_items (id SERIAL PRIMARY KEY, receipt_id INTEGER REFERENCES stock_receipts(id), product_id INTEGER REFERENCES products(id), qty_unit INTEGER NOT NULL, qty_tray INTEGER, cost_per_unit NUMERIC(10,4), total_cost NUMERIC(10,2))`);

    // stock_transfers
    await pool.query(`CREATE TABLE IF NOT EXISTS stock_transfers (id SERIAL PRIMARY KEY, from_branch_id INTEGER REFERENCES branches(id), to_branch_id INTEGER REFERENCES branches(id), transfer_date DATE NOT NULL DEFAULT CURRENT_DATE, status VARCHAR(20) DEFAULT 'pending', note TEXT, created_by INTEGER REFERENCES users(id), approved_by INTEGER REFERENCES users(id), approved_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS stock_transfer_items (id SERIAL PRIMARY KEY, transfer_id INTEGER REFERENCES stock_transfers(id), product_id INTEGER REFERENCES products(id), qty_sent INTEGER NOT NULL, qty_received INTEGER)`);

    // contacts (ลูกค้า + ซัพพลายเออร์)
    await pool.query(`CREATE TABLE IF NOT EXISTS contacts (id SERIAL PRIMARY KEY, entity_type VARCHAR(20) NOT NULL DEFAULT 'individual', is_customer BOOLEAN DEFAULT true, is_supplier BOOLEAN DEFAULT false, business_name VARCHAR(150), tax_id VARCHAR(20), branch_office VARCHAR(100), address TEXT, postal_code VARCHAR(10), office_phone VARCHAR(20), contact_name VARCHAR(100), email VARCHAR(150), mobile VARCHAR(20), credit_days INTEGER DEFAULT 0, note TEXT, active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW())`);

    // shifts
    await pool.query(`CREATE TABLE IF NOT EXISTS shifts (id SERIAL PRIMARY KEY, branch_id INTEGER REFERENCES branches(id), cashier_id INTEGER REFERENCES users(id), open_time TIMESTAMPTZ DEFAULT NOW(), close_time TIMESTAMPTZ, opening_cash NUMERIC(10,2) DEFAULT 0, closing_cash NUMERIC(10,2), expected_cash NUMERIC(10,2), cash_difference NUMERIC(10,2), status VARCHAR(20) DEFAULT 'open', note TEXT)`);

    // sales
    await pool.query(`CREATE TABLE IF NOT EXISTS sales (id SERIAL PRIMARY KEY, sale_no VARCHAR(30) UNIQUE NOT NULL, branch_id INTEGER REFERENCES branches(id), shift_id INTEGER REFERENCES shifts(id), contact_id INTEGER REFERENCES contacts(id), member_id INTEGER REFERENCES members(id), sale_channel VARCHAR(20) DEFAULT 'retail', cashier_id INTEGER REFERENCES users(id), sale_date DATE NOT NULL DEFAULT CURRENT_DATE, subtotal NUMERIC(10,2) NOT NULL DEFAULT 0, member_discount NUMERIC(10,2) DEFAULT 0, discount NUMERIC(10,2) DEFAULT 0, total NUMERIC(10,2) NOT NULL DEFAULT 0, payment_methods JSONB DEFAULT '[]', status VARCHAR(20) DEFAULT 'completed', void_reason TEXT, voided_by INTEGER REFERENCES users(id), note TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS sale_items (id SERIAL PRIMARY KEY, sale_id INTEGER REFERENCES sales(id) ON DELETE CASCADE, product_id INTEGER REFERENCES products(id), qty_set INTEGER NOT NULL, unit_size INTEGER NOT NULL, qty_unit INTEGER NOT NULL, price_per_set NUMERIC(10,2) NOT NULL, subtotal NUMERIC(10,2) NOT NULL)`);

    // credit_sales
    await pool.query(`CREATE TABLE IF NOT EXISTS credit_sales (id SERIAL PRIMARY KEY, sale_id INTEGER REFERENCES sales(id), contact_id INTEGER REFERENCES contacts(id), member_id INTEGER REFERENCES members(id), branch_id INTEGER REFERENCES branches(id), amount NUMERIC(10,2) NOT NULL, paid_amount NUMERIC(10,2) DEFAULT 0, status VARCHAR(20) DEFAULT 'unpaid', due_note TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS credit_payments (id SERIAL PRIMARY KEY, credit_sale_id INTEGER REFERENCES credit_sales(id), amount NUMERIC(10,2) NOT NULL, method VARCHAR(20), paid_at TIMESTAMPTZ DEFAULT NOW(), created_by INTEGER REFERENCES users(id))`);

    // invoices
    await pool.query(`CREATE TABLE IF NOT EXISTS invoices (id SERIAL PRIMARY KEY, invoice_no VARCHAR(30) UNIQUE NOT NULL, sale_id INTEGER REFERENCES sales(id), contact_id INTEGER REFERENCES contacts(id), branch_id INTEGER REFERENCES branches(id), issue_date DATE NOT NULL DEFAULT CURRENT_DATE, due_date DATE, total NUMERIC(10,2) NOT NULL, paid_amount NUMERIC(10,2) DEFAULT 0, status VARCHAR(20) DEFAULT 'unpaid', note TEXT, created_by INTEGER REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS invoice_payments (id SERIAL PRIMARY KEY, invoice_id INTEGER REFERENCES invoices(id), paid_date DATE NOT NULL DEFAULT CURRENT_DATE, amount NUMERIC(10,2) NOT NULL, method VARCHAR(20), note TEXT, created_by INTEGER REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT NOW())`);

    // quotations (ใบเสนอราคา)
    await pool.query(`CREATE TABLE IF NOT EXISTS quotations (id SERIAL PRIMARY KEY, doc_no VARCHAR(30) UNIQUE NOT NULL, branch_id INTEGER REFERENCES branches(id), contact_id INTEGER REFERENCES contacts(id), issue_date DATE NOT NULL DEFAULT CURRENT_DATE, valid_until DATE, subtotal NUMERIC(10,2) DEFAULT 0, discount NUMERIC(10,2) DEFAULT 0, total NUMERIC(10,2) DEFAULT 0, status VARCHAR(20) DEFAULT 'draft', note TEXT, created_by INTEGER REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS quotation_items (id SERIAL PRIMARY KEY, quotation_id INTEGER REFERENCES quotations(id) ON DELETE CASCADE, product_id INTEGER REFERENCES products(id), description TEXT, qty NUMERIC(10,2) NOT NULL, unit VARCHAR(20), price NUMERIC(10,2) NOT NULL, subtotal NUMERIC(10,2) NOT NULL)`);

    // debit/credit notes
    await pool.query(`CREATE TABLE IF NOT EXISTS debt_notes (id SERIAL PRIMARY KEY, doc_no VARCHAR(30) UNIQUE NOT NULL, note_type VARCHAR(10) NOT NULL, branch_id INTEGER REFERENCES branches(id), contact_id INTEGER REFERENCES contacts(id), ref_invoice_id INTEGER REFERENCES invoices(id), issue_date DATE NOT NULL DEFAULT CURRENT_DATE, amount NUMERIC(10,2) NOT NULL, reason TEXT, status VARCHAR(20) DEFAULT 'active', created_by INTEGER REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT NOW())`);

    // promotions
    await pool.query(`CREATE TABLE IF NOT EXISTS promotions (id SERIAL PRIMARY KEY, name VARCHAR(150) NOT NULL, branch_id INTEGER REFERENCES branches(id), promo_type VARCHAR(20) NOT NULL, product_id INTEGER REFERENCES products(id), min_qty INTEGER DEFAULT 1, discount_value NUMERIC(10,2), free_product_id INTEGER REFERENCES products(id), free_qty INTEGER, start_date DATE NOT NULL, end_date DATE NOT NULL, active BOOLEAN DEFAULT true, created_by INTEGER REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT NOW())`);

    // expenses
    await pool.query(`CREATE TABLE IF NOT EXISTS expense_categories (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL)`);
    const expCheck = await pool.query(`SELECT id FROM expense_categories WHERE name='ค่าแรงพนักงาน'`);
    if (expCheck.rows.length === 0) await pool.query(`INSERT INTO expense_categories (name) VALUES ('ค่าแรงพนักงาน'),('ค่าน้ำมัน'),('ค่าเช่าร้าน'),('ค่าบรรจุภัณฑ์'),('ค่าสาธารณูปโภค'),('อื่นๆ')`);
    await pool.query(`CREATE TABLE IF NOT EXISTS expenses (id SERIAL PRIMARY KEY, branch_id INTEGER REFERENCES branches(id), category_id INTEGER REFERENCES expense_categories(id), amount NUMERIC(10,2) NOT NULL, expense_date DATE NOT NULL DEFAULT CURRENT_DATE, note TEXT, created_by INTEGER REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT NOW())`);

    // damage_photos
    await pool.query(`CREATE TABLE IF NOT EXISTS damage_photos (id SERIAL PRIMARY KEY, branch_id INTEGER REFERENCES branches(id), product_id INTEGER REFERENCES products(id), photo_url TEXT NOT NULL, photo_date DATE NOT NULL DEFAULT CURRENT_DATE, note TEXT, uploaded_by INTEGER REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT NOW())`);

    // user_branch_access — สิทธิ์สาขาของแต่ละ user
    await pool.query(`CREATE TABLE IF NOT EXISTS user_branch_access (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      branch_id INTEGER REFERENCES branches(id) ON DELETE CASCADE,
      UNIQUE(user_id, branch_id)
    )`);

    // promotions table already exists, add expenses table
    await pool.query(`CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      branch_id INTEGER REFERENCES branches(id),
      category_id INTEGER REFERENCES expense_categories(id),
      amount NUMERIC(10,2) NOT NULL,
      expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
      note TEXT,
      withholding_tax NUMERIC(10,2) DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS withholding_tax NUMERIC(10,2) DEFAULT 0`);

    // employees
    await pool.query(`CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      code VARCHAR(20) UNIQUE,
      full_name VARCHAR(100) NOT NULL,
      nickname VARCHAR(50),
      national_id VARCHAR(20),
      phone VARCHAR(20),
      email VARCHAR(150),
      address TEXT,
      branch_id INTEGER REFERENCES branches(id),
      position VARCHAR(100),
      start_date DATE,
      probation_end_date DATE,
      salary NUMERIC(10,2),
      salary_base NUMERIC(10,2),
      bank_name VARCHAR(100),
      bank_account VARCHAR(50),
      education TEXT,
      work_history TEXT,
      emergency_contact TEXT,
      photo_url TEXT,
      doc_url TEXT,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    -- เพิ่ม columns ใหม่ถ้ายังไม่มี
    await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS national_id VARCHAR(20)`);
    await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS email VARCHAR(150)`);
    await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS address TEXT`);
    await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS probation_end_date DATE`);
    await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS salary_base NUMERIC(10,2)`);
    await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS bank_name VARCHAR(100)`);
    await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS bank_account VARCHAR(50)`);
    await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS education TEXT`);
    await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS work_history TEXT`);
    await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS emergency_contact TEXT`);
    await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS photo_url TEXT`);
    await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS doc_url TEXT`);

    // debt_notes already in schema
    // add doc_sequence for debit/credit note
    await pool.query(`INSERT INTO doc_sequences (doc_type, prefix) VALUES ('debit_note','DN'),('credit_note','CN') ON CONFLICT (doc_type) DO NOTHING`);

    // admin user
    const userCheck = await pool.query(`SELECT id FROM users WHERE username='admin'`);
    if (userCheck.rows.length === 0) {
      const hash = await bcrypt.hash('password', 10);
      await pool.query(`INSERT INTO users (username,password_hash,full_name,role_id,branch_id) VALUES ('admin',$1,'เจ้าของร้าน',1,NULL)`, [hash]);
    }
    console.log('✅ Schema พร้อม');
  } catch (err) { console.error('❌ Schema error:', err.message); }
}

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));
const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({ destination: uploadDir, filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname) });
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });
app.use('/uploads', express.static(uploadDir));

function auth(req, res, next) {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token หมดอายุ' }); }
}
function role(...roles) { return (req, res, next) => { if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'ไม่มีสิทธิ์' }); next(); }; }

// ============================================================
// DOC NUMBER GENERATOR
// ============================================================
// docTypes ที่ไม่ต้องมีรหัสสาขา
const NO_BRANCH_DOCS = ['invoice','receipt','quotation','debit_note','credit_note'];

async function genDocNo(docType, branchCode) {
  const now = new Date();
  const ym = `${now.getFullYear().toString().slice(2)}${String(now.getMonth()+1).padStart(2,'0')}`;
  const result = await pool.query(`SELECT * FROM doc_sequences WHERE doc_type=$1`, [docType]);
  let seq = result.rows[0];
  let newSeq;
  if (!seq) { await pool.query(`INSERT INTO doc_sequences (doc_type,prefix,last_seq,year_month) VALUES ($1,$2,1,$3)`, [docType, docType.toUpperCase(), ym]); newSeq = 1; }
  else {
    newSeq = (seq.year_month === ym) ? seq.last_seq + 1 : 1;
    await pool.query(`UPDATE doc_sequences SET last_seq=$1,year_month=$2 WHERE doc_type=$3`, [newSeq, ym, docType]);
  }
  const prefix = seq ? seq.prefix : docType.toUpperCase();
  // ใบเสนอราคา, ใบแจ้งหนี้, ใบเสร็จ, ใบลดหนี้, ใบเพิ่มหนี้ = ไม่มีรหัสสาขา
  const useBranch = !NO_BRANCH_DOCS.includes(docType) && branchCode;
  return `${prefix}-${useBranch ? branchCode+'-' : ''}${ym}-${String(newSeq).padStart(4,'0')}`;
}

// ============================================================
// AUTH
// ============================================================
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const r = await pool.query(`SELECT u.*,ro.name AS role,b.code AS branch_code,b.name AS branch_name FROM users u JOIN roles ro ON u.role_id=ro.id LEFT JOIN branches b ON u.branch_id=b.id WHERE u.username=$1 AND u.active=true`, [username]);
    const u = r.rows[0];
    if (!u || !await bcrypt.compare(password, u.password_hash)) return res.status(401).json({ error: 'username หรือ password ไม่ถูกต้อง' });
    await pool.query('UPDATE users SET last_login=NOW() WHERE id=$1', [u.id]);
    // ดึงสาขาที่ user มีสิทธิ์
    const branchAccess = await pool.query(`
      SELECT b.id, b.code, b.name FROM user_branch_access uba
      JOIN branches b ON uba.branch_id = b.id
      WHERE uba.user_id = $1 AND b.active = true ORDER BY b.id
    `, [u.id]);
    const accessBranches = branchAccess.rows;
    // owner/admin เข้าได้ทุกสาขา
    const isOwner = ['owner','admin'].includes(u.role);
    const allBranches = isOwner ? (await pool.query('SELECT id,code,name FROM branches WHERE active=true ORDER BY id')).rows : accessBranches;

    const token = jwt.sign({ id:u.id, username:u.username, full_name:u.full_name, role:u.role, branch_id:u.branch_id, branch_code:u.branch_code }, process.env.JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, user: { id:u.id, username:u.username, full_name:u.full_name, role:u.role, branch_id:u.branch_id, branch_code:u.branch_code, branch_name:u.branch_name, access_branches: allBranches } });
  } catch(e) { console.error(e); res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});
app.get('/api/auth/me', auth, async (req, res) => {
  const r = await pool.query(`SELECT u.id,u.username,u.full_name,u.phone,u.branch_id,b.code AS branch_code,b.name AS branch_name,ro.name AS role,u.last_login FROM users u JOIN roles ro ON u.role_id=ro.id LEFT JOIN branches b ON u.branch_id=b.id WHERE u.id=$1`, [req.user.id]);
  res.json(r.rows[0]);
});

// BRANCHES
app.get('/api/branches', auth, async (req, res) => { const r = await pool.query('SELECT * FROM branches WHERE active=true ORDER BY id'); res.json(r.rows); });

// USERS
app.get('/api/users', auth, role('owner','admin'), async (req, res) => {
  const r = await pool.query(`SELECT u.id,u.username,u.full_name,u.phone,u.active,u.branch_id,b.code AS branch_code,b.name AS branch_name,ro.id AS role_id,ro.name AS role,u.last_login FROM users u JOIN roles ro ON u.role_id=ro.id LEFT JOIN branches b ON u.branch_id=b.id ORDER BY u.id`);
  res.json(r.rows);
});
app.post('/api/users', auth, role('owner','admin'), async (req, res) => {
  const { username, password, full_name, role_id, branch_id, phone } = req.body;
  try { const hash = await bcrypt.hash(password, 10); const r = await pool.query('INSERT INTO users (username,password_hash,full_name,role_id,branch_id,phone) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,username,full_name', [username, hash, full_name, role_id, branch_id||null, phone||null]); res.status(201).json({ message: 'สร้างเรียบร้อย', user: r.rows[0] }); }
  catch(e) { if (e.code==='23505') return res.status(409).json({ error: 'username นี้มีอยู่แล้ว' }); res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});
app.put('/api/users/:id', auth, role('owner','admin'), async (req, res) => {
  const { full_name, role_id, branch_id, phone, active } = req.body;
  await pool.query('UPDATE users SET full_name=$1,role_id=$2,branch_id=$3,phone=$4,active=$5 WHERE id=$6', [full_name, role_id, branch_id||null, phone||null, active, req.params.id]);
  res.json({ message: 'แก้ไขเรียบร้อย' });
});
app.get('/api/roles', auth, async (req, res) => { const r = await pool.query('SELECT * FROM roles ORDER BY id'); res.json(r.rows); });

// USER BRANCH ACCESS
app.get('/api/users/:id/branches', auth, role('owner','admin'), async (req, res) => {
  const r = await pool.query(`SELECT uba.branch_id, b.code, b.name FROM user_branch_access uba JOIN branches b ON uba.branch_id=b.id WHERE uba.user_id=$1`, [req.params.id]);
  res.json(r.rows);
});
app.put('/api/users/:id/branches', auth, role('owner','admin'), async (req, res) => {
  const { branch_ids } = req.body; // array of branch_id
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM user_branch_access WHERE user_id=$1', [req.params.id]);
    for (const bid of (branch_ids||[])) {
      await client.query('INSERT INTO user_branch_access (user_id,branch_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, bid]);
    }
    await client.query('COMMIT');
    res.json({ message: 'อัพเดทสิทธิ์สาขาเรียบร้อย' });
  } catch(e) { await client.query('ROLLBACK'); res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
  finally { client.release(); }
});

// Switch branch (เปลี่ยนสาขาที่ทำงาน)
app.post('/api/auth/switch-branch', auth, async (req, res) => {
  const { branch_id } = req.body;
  const isOwner = ['owner','admin'].includes(req.user.role);
  if (!isOwner) {
    const access = await pool.query('SELECT id FROM user_branch_access WHERE user_id=$1 AND branch_id=$2', [req.user.id, branch_id]);
    if (!access.rows.length) return res.status(403).json({ error: 'ไม่มีสิทธิ์เข้าถึงสาขานี้' });
  }
  const branchR = await pool.query('SELECT id,code,name FROM branches WHERE id=$1', [branch_id]);
  const branch = branchR.rows[0];
  if (!branch) return res.status(404).json({ error: 'ไม่พบสาขา' });
  const userR = await pool.query(`SELECT u.*,r.name AS role FROM users u JOIN roles r ON u.role_id=r.id WHERE u.id=$1`, [req.user.id]);
  const u = userR.rows[0];
  const token = jwt.sign({ id:u.id, username:u.username, full_name:u.full_name, role:u.role, branch_id:branch.id, branch_code:branch.code }, process.env.JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, branch_id: branch.id, branch_code: branch.code, branch_name: branch.name });
});

// MEMBER SETTINGS
app.get('/api/member-settings', auth, async (req, res) => { const r = await pool.query('SELECT * FROM member_settings LIMIT 1'); res.json(r.rows[0]); });
app.put('/api/member-settings', auth, role('owner','admin'), async (req, res) => { await pool.query('UPDATE member_settings SET eggs_required=$1,discount_amount=$2,updated_at=NOW()', [req.body.eggs_required, req.body.discount_amount]); res.json({ message: 'บันทึกเรียบร้อย' }); });

// MEMBERS
app.get('/api/members', auth, async (req, res) => { const r = await pool.query(`SELECT m.*,b.code AS branch_code FROM members m LEFT JOIN branches b ON m.branch_id=b.id WHERE m.active=true ORDER BY m.name`); res.json(r.rows); });
app.post('/api/members', auth, async (req, res) => {
  const { name, phone, branch_id } = req.body;
  if (!name) return res.status(400).json({ error: 'กรุณากรอกชื่อ' });
  try { const code = 'M' + Date.now().toString().slice(-6); const r = await pool.query('INSERT INTO members (code,name,phone,branch_id) VALUES ($1,$2,$3,$4) RETURNING *', [code, name, phone||null, branch_id||null]); res.status(201).json({ message: 'เพิ่มสมาชิกเรียบร้อย', member: r.rows[0] }); }
  catch(e) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});
app.put('/api/members/:id', auth, async (req, res) => { const { name, phone, branch_id, active } = req.body; await pool.query('UPDATE members SET name=$1,phone=$2,branch_id=$3,active=$4 WHERE id=$5', [name, phone, branch_id||null, active, req.params.id]); res.json({ message: 'แก้ไขเรียบร้อย' }); });

// PRODUCTS
app.get('/api/products', auth, async (req, res) => {
  const { category_id, search } = req.query;
  let q = `SELECT p.*,pc.name AS category_name,pc.type AS category_type FROM products p JOIN product_categories pc ON p.category_id=pc.id WHERE p.active=true`;
  const params = [];
  if (category_id) { params.push(category_id); q += ` AND p.category_id=$${params.length}`; }
  if (search) { params.push('%'+search+'%'); q += ` AND (p.name ILIKE $${params.length} OR p.code ILIKE $${params.length})`; }
  q += ' ORDER BY pc.type,p.code';
  const r = await pool.query(q, params);
  res.json(r.rows);
});
app.post('/api/products', auth, role('owner','admin','manager'), async (req, res) => {
  const { category_id, code, name, unit, is_egg, track_stock } = req.body;
  try { const r = await pool.query('INSERT INTO products (category_id,code,name,unit,is_egg,track_stock) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [category_id, code, name, unit||'ฟอง', is_egg||false, track_stock!==false]); res.status(201).json({ message: 'เพิ่มสินค้าเรียบร้อย', product: r.rows[0] }); }
  catch(e) { if (e.code==='23505') return res.status(409).json({ error: 'รหัสสินค้านี้มีอยู่แล้ว' }); res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});
app.put('/api/products/:id', auth, role('owner','admin','manager'), async (req, res) => { const { name, unit, active, track_stock } = req.body; await pool.query('UPDATE products SET name=$1,unit=$2,active=$3,track_stock=$4 WHERE id=$5', [name, unit, active, track_stock!==false, req.params.id]); res.json({ message: 'แก้ไขเรียบร้อย' }); });
app.delete('/api/products/:id', auth, role('owner','admin'), async (req, res) => { await pool.query('UPDATE products SET active=false WHERE id=$1', [req.params.id]); res.json({ message: 'ลบเรียบร้อย' }); });
app.get('/api/product-categories', auth, async (req, res) => { const r = await pool.query('SELECT * FROM product_categories WHERE active=true ORDER BY id'); res.json(r.rows); });

app.get('/api/products/:id/prices', auth, async (req, res) => {
  const r = await pool.query(`SELECT pp.*,b.code AS branch_code,b.name AS branch_name FROM product_prices pp JOIN branches b ON pp.branch_id=b.id WHERE pp.product_id=$1 ORDER BY b.code,pp.customer_type,pp.qty`, [req.params.id]);
  res.json(r.rows);
});
app.post('/api/products/:id/prices', auth, role('owner','admin','manager'), async (req, res) => {
  const { branch_id, customer_type, qty, price } = req.body;
  await pool.query(`INSERT INTO product_prices (product_id,branch_id,customer_type,qty,price) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (product_id,branch_id,customer_type,qty) DO UPDATE SET price=EXCLUDED.price,active=true`, [req.params.id, branch_id, customer_type, qty, price]);
  res.json({ message: 'ตั้งราคาเรียบร้อย' });
});
app.post('/api/products/import-prices', auth, role('owner','admin'), async (req, res) => {
  const { prices } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let count = 0;
    for (const row of prices) {
      const prod = await client.query('SELECT id FROM products WHERE code=$1', [row.code]);
      const branch = await client.query('SELECT id FROM branches WHERE code=$1', [row.branch_code]);
      if (!prod.rows[0] || !branch.rows[0]) continue;
      await client.query(`INSERT INTO product_prices (product_id,branch_id,customer_type,qty,price) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (product_id,branch_id,customer_type,qty) DO UPDATE SET price=EXCLUDED.price,active=true`, [prod.rows[0].id, branch.rows[0].id, row.customer_type, row.qty, row.price]);
      count++;
    }
    await client.query('COMMIT');
    res.json({ message: `นำเข้าราคาเรียบร้อย ${count} รายการ` });
  } catch(e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { client.release(); }
});

app.get('/api/pos/products', auth, async (req, res) => {
  const { branch_id, customer_type } = req.query;
  if (!branch_id || !customer_type) return res.status(400).json({ error: 'กรุณาระบุ branch_id และ customer_type' });
  const r = await pool.query(`SELECT p.id AS product_id,p.code,p.name,p.unit,p.is_egg,pp.qty,pp.price,COALESCE(s.qty_unit,0) AS stock_qty FROM product_prices pp JOIN products p ON pp.product_id=p.id LEFT JOIN stock s ON s.product_id=p.id AND s.branch_id=$1 WHERE pp.branch_id=$1 AND pp.customer_type=$2 AND pp.active=true AND p.active=true ORDER BY p.is_egg DESC,p.code,pp.qty`, [branch_id, customer_type]);
  const grouped = {};
  r.rows.forEach(row => { if (!grouped[row.product_id]) grouped[row.product_id] = { product_id:row.product_id, code:row.code, name:row.name, unit:row.unit, is_egg:row.is_egg, stock_qty:parseInt(row.stock_qty), prices:[] }; grouped[row.product_id].prices.push({ qty:row.qty, price:parseFloat(row.price) }); });
  res.json(Object.values(grouped));
});

// SHIFTS
app.get('/api/shifts/current', auth, async (req, res) => {
  if (!req.user.branch_id) return res.json(null);
  const r = await pool.query(`SELECT s.*,u.full_name AS cashier_name,b.code AS branch_code FROM shifts s JOIN users u ON s.cashier_id=u.id JOIN branches b ON s.branch_id=b.id WHERE s.branch_id=$1 AND s.status='open' ORDER BY s.open_time DESC LIMIT 1`, [req.user.branch_id]);
  res.json(r.rows[0] || null);
});
app.post('/api/shifts/open', auth, async (req, res) => {
  const branchId = req.user.branch_id;
  if (!branchId) return res.status(400).json({ error: 'ไม่พบสาขา' });
  const existing = await pool.query(`SELECT id FROM shifts WHERE branch_id=$1 AND status='open'`, [branchId]);
  if (existing.rows.length > 0) return res.status(409).json({ error: 'มีกะที่เปิดอยู่แล้ว' });
  const r = await pool.query('INSERT INTO shifts (branch_id,cashier_id,opening_cash) VALUES ($1,$2,$3) RETURNING *', [branchId, req.user.id, req.body.opening_cash||0]);
  res.status(201).json({ message: 'เปิดกะเรียบร้อย', shift: r.rows[0] });
});
app.post('/api/shifts/:id/close', auth, async (req, res) => {
  const { closing_cash, note } = req.body;
  const shift = await pool.query('SELECT * FROM shifts WHERE id=$1', [req.params.id]);
  const s = shift.rows[0];
  if (!s) return res.status(404).json({ error: 'ไม่พบกะ' });
  const salesR = await pool.query(`SELECT COALESCE(SUM((pm->>'amount')::numeric),0) AS cash_sales FROM sales,jsonb_array_elements(payment_methods) AS pm WHERE shift_id=$1 AND pm->>'method'='cash' AND status='completed'`, [s.id]);
  const expectedCash = parseFloat(s.opening_cash) + parseFloat(salesR.rows[0].cash_sales);
  const difference = parseFloat(closing_cash||0) - expectedCash;
  await pool.query(`UPDATE shifts SET close_time=NOW(),closing_cash=$1,expected_cash=$2,cash_difference=$3,status='closed',note=$4 WHERE id=$5`, [closing_cash||0, expectedCash, difference, note, req.params.id]);
  res.json({ message: 'ปิดกะเรียบร้อย', expected_cash: expectedCash, difference });
});
app.get('/api/shifts', auth, async (req, res) => {
  const branchId = req.user.branch_id;
  let q = `SELECT s.*,u.full_name AS cashier_name,b.code AS branch_code FROM shifts s JOIN users u ON s.cashier_id=u.id JOIN branches b ON s.branch_id=b.id WHERE 1=1`;
  const params = [];
  if (branchId && !['owner','admin'].includes(req.user.role)) { params.push(branchId); q += ` AND s.branch_id=$${params.length}`; }
  q += ' ORDER BY s.open_time DESC LIMIT 50';
  const r = await pool.query(q, params);
  res.json(r.rows);
});

// STOCK
app.get('/api/stock', auth, async (req, res) => {
  const { branch_id, search } = req.query;
  let q = `SELECT s.*,p.name AS product_name,p.code,p.unit,p.is_egg,b.code AS branch_code,b.name AS branch_name FROM stock s JOIN products p ON s.product_id=p.id JOIN branches b ON s.branch_id=b.id WHERE p.active=true AND p.track_stock=true`;
  const params = [];
  if (branch_id) { params.push(branch_id); q += ` AND s.branch_id=$${params.length}`; }
  if (search) { params.push('%'+search+'%'); q += ` AND (p.name ILIKE $${params.length} OR p.code ILIKE $${params.length})`; }
  q += ' ORDER BY b.code,p.code';
  const r = await pool.query(q, params);
  res.json(r.rows);
});

app.get('/api/stock/movements', auth, async (req, res) => {
  const { product_id, branch_id } = req.query;
  let q = `SELECT sm.*,p.name AS product_name,p.code,b.code AS branch_code,u.full_name AS created_by_name FROM stock_movements sm JOIN products p ON sm.product_id=p.id JOIN branches b ON sm.branch_id=b.id LEFT JOIN users u ON sm.created_by=u.id WHERE 1=1`;
  const params = [];
  if (product_id) { params.push(product_id); q += ` AND sm.product_id=$${params.length}`; }
  if (branch_id) { params.push(branch_id); q += ` AND sm.branch_id=$${params.length}`; }
  q += ' ORDER BY sm.created_at DESC LIMIT 100';
  const r = await pool.query(q, params);
  res.json(r.rows);
});

// STOCK RECEIPTS (Pre)
app.get('/api/stock/receipts', auth, async (req, res) => {
  const isOwner = ['owner','admin'].includes(req.user.role);
  let q = `SELECT sr.*,b.code AS branch_code,u.full_name AS created_by_name FROM stock_receipts sr JOIN branches b ON sr.branch_id=b.id LEFT JOIN users u ON sr.created_by=u.id WHERE 1=1`;
  // manager เห็นเฉพาะ pre ของตัวเอง
  if (!isOwner) q += ` AND sr.status='pre'`;
  q += ' ORDER BY sr.created_at DESC LIMIT 50';
  const r = await pool.query(q);
  // ซ่อนราคาถ้าไม่ใช่ owner
  r.rows.forEach(row => { if (!isOwner) { row.total_cost = null; } });
  res.json(r.rows);
});

app.get('/api/stock/receipts/:id/items', auth, async (req, res) => {
  const isOwner = ['owner','admin'].includes(req.user.role);
  const r = await pool.query(`SELECT sri.*,p.name AS product_name,p.code FROM stock_receipt_items sri JOIN products p ON sri.product_id=p.id WHERE sri.receipt_id=$1`, [req.params.id]);
  if (!isOwner) r.rows.forEach(row => { row.cost_per_unit = null; row.total_cost = null; });
  res.json(r.rows);
});

app.post('/api/stock/receive', auth, role('owner','admin','manager','stock'), async (req, res) => {
  const { branch_id, supplier_id, supplier_name, note, items } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const branchR = await client.query('SELECT code FROM branches WHERE id=$1', [branch_id]);
    const branchCode = branchR.rows[0]?.code || '';
    const docNo = await genDocNo('receipt_pre', branchCode);
    const receipt = await client.query('INSERT INTO stock_receipts (doc_no,branch_id,supplier_id,supplier_name,note,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [docNo, branch_id, supplier_id||null, supplier_name||null, note, req.user.id]);
    const receiptId = receipt.rows[0].id;
    for (const item of items) {
      await client.query('INSERT INTO stock_receipt_items (receipt_id,product_id,qty_unit,qty_tray) VALUES ($1,$2,$3,$4)', [receiptId, item.product_id, item.qty_unit, item.qty_tray||null]);
    }
    await client.query('COMMIT');
    res.status(201).json({ message: 'บันทึกใบรับสินค้า (Pre) เรียบร้อย', receipt_id: receiptId, doc_no: docNo });
  } catch(e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); } finally { client.release(); }
});

// Owner ใส่ราคาและอนุมัติ → ตัดสต๊อก
app.post('/api/stock/receipts/:id/approve', auth, role('owner','admin'), async (req, res) => {
  const { items } = req.body; // items = [{id, cost_per_unit}]
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const receipt = await client.query('SELECT * FROM stock_receipts WHERE id=$1', [req.params.id]);
    const rec = receipt.rows[0];
    if (!rec) return res.status(404).json({ error: 'ไม่พบเอกสาร' });
    const branchR = await client.query('SELECT code FROM branches WHERE id=$1', [rec.branch_id]);
    const branchCode = branchR.rows[0]?.code || '';
    const grDocNo = await genDocNo('receipt_final', branchCode);
    let totalCost = 0;
    for (const item of items) {
      const cost = parseFloat(item.cost_per_unit) || 0;
      const itemR = await client.query('SELECT * FROM stock_receipt_items WHERE id=$1', [item.id]);
      const it = itemR.rows[0];
      const itemTotal = cost * it.qty_unit;
      totalCost += itemTotal;
      await client.query('UPDATE stock_receipt_items SET cost_per_unit=$1,total_cost=$2 WHERE id=$3', [cost, itemTotal, item.id]);
      const before = await client.query('SELECT qty_unit FROM stock WHERE product_id=$1 AND branch_id=$2', [it.product_id, rec.branch_id]);
      const qBefore = before.rows[0] ? parseInt(before.rows[0].qty_unit) : 0;
      await client.query(`INSERT INTO stock (product_id,branch_id,qty_unit) VALUES ($1,$2,$3) ON CONFLICT (product_id,branch_id) DO UPDATE SET qty_unit=stock.qty_unit+$3,updated_at=NOW()`, [it.product_id, rec.branch_id, it.qty_unit]);
      await client.query('INSERT INTO stock_movements (product_id,branch_id,movement_type,qty_change,qty_before,qty_after,ref_type,ref_id,note,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [it.product_id, rec.branch_id, 'receive', it.qty_unit, qBefore, qBefore+it.qty_unit, 'receipt', rec.id, rec.supplier_name||'', req.user.id]);
    }
    await client.query(`UPDATE stock_receipts SET status='approved',doc_no=$1,total_cost=$2,priced_by=$3,priced_at=NOW() WHERE id=$4`, [grDocNo, totalCost, req.user.id, req.params.id]);
    await client.query('COMMIT');
    res.json({ message: 'อนุมัติใบรับสินค้าเรียบร้อย', doc_no: grDocNo });
  } catch(e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); } finally { client.release(); }
});

app.post('/api/stock/receipts/:id/photo', auth, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'กรุณาเลือกรูป' });
  await pool.query('UPDATE stock_receipts SET photo_url=$1 WHERE id=$2', ['/uploads/'+req.file.filename, req.params.id]);
  res.json({ message: 'อัพโหลดรูปเรียบร้อย', url: '/uploads/'+req.file.filename });
});

app.post('/api/stock/transfer', auth, role('owner','admin','manager','stock'), async (req, res) => {
  const { from_branch_id, to_branch_id, note, items } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const transfer = await client.query('INSERT INTO stock_transfers (from_branch_id,to_branch_id,note,created_by) VALUES ($1,$2,$3,$4) RETURNING id', [from_branch_id, to_branch_id, note, req.user.id]);
    const transferId = transfer.rows[0].id;
    for (const item of items) {
      const before = await client.query('SELECT qty_unit FROM stock WHERE product_id=$1 AND branch_id=$2', [item.product_id, from_branch_id]);
      const qBefore = before.rows[0] ? parseInt(before.rows[0].qty_unit) : 0;
      await client.query('INSERT INTO stock_transfer_items (transfer_id,product_id,qty_sent) VALUES ($1,$2,$3)', [transferId, item.product_id, item.qty_sent]);
      await client.query('UPDATE stock SET qty_unit=qty_unit-$1,updated_at=NOW() WHERE product_id=$2 AND branch_id=$3', [item.qty_sent, item.product_id, from_branch_id]);
      await client.query('INSERT INTO stock_movements (product_id,branch_id,movement_type,qty_change,qty_before,qty_after,ref_type,ref_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [item.product_id, from_branch_id, 'transfer_out', -item.qty_sent, qBefore, qBefore-item.qty_sent, 'transfer', transferId, req.user.id]);
    }
    await client.query('COMMIT');
    res.status(201).json({ message: 'สร้างการโอนย้ายเรียบร้อย', transfer_id: transferId });
  } catch(e) { await client.query('ROLLBACK'); res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); } finally { client.release(); }
});

// CONTACTS
app.get('/api/contacts', auth, async (req, res) => {
  const { type } = req.query;
  let q = `SELECT * FROM contacts WHERE active=true`;
  if (type === 'customer') q += ` AND is_customer=true`;
  else if (type === 'supplier') q += ` AND is_supplier=true`;
  q += ' ORDER BY business_name,contact_name';
  const r = await pool.query(q);
  res.json(r.rows);
});
app.post('/api/contacts', auth, async (req, res) => {
  const { entity_type,is_customer,is_supplier,business_name,tax_id,branch_office,address,postal_code,office_phone,contact_name,email,mobile,credit_days,note } = req.body;
  try { const r = await pool.query(`INSERT INTO contacts (entity_type,is_customer,is_supplier,business_name,tax_id,branch_office,address,postal_code,office_phone,contact_name,email,mobile,credit_days,note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`, [entity_type||'individual',is_customer||true,is_supplier||false,business_name,tax_id,branch_office,address,postal_code,office_phone,contact_name,email,mobile,credit_days||0,note]); res.status(201).json({ message: 'เพิ่มเรียบร้อย', contact: r.rows[0] }); }
  catch(e) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});
app.put('/api/contacts/:id', auth, async (req, res) => {
  const { entity_type,is_customer,is_supplier,business_name,tax_id,branch_office,address,postal_code,office_phone,contact_name,email,mobile,credit_days,note,active } = req.body;
  await pool.query(`UPDATE contacts SET entity_type=$1,is_customer=$2,is_supplier=$3,business_name=$4,tax_id=$5,branch_office=$6,address=$7,postal_code=$8,office_phone=$9,contact_name=$10,email=$11,mobile=$12,credit_days=$13,note=$14,active=$15 WHERE id=$16`, [entity_type,is_customer,is_supplier,business_name,tax_id,branch_office,address,postal_code,office_phone,contact_name,email,mobile,credit_days,note,active,req.params.id]);
  res.json({ message: 'แก้ไขเรียบร้อย' });
});
app.delete('/api/contacts/:id', auth, role('owner','admin'), async (req, res) => { await pool.query('UPDATE contacts SET active=false WHERE id=$1', [req.params.id]); res.json({ message: 'ลบเรียบร้อย' }); });

// QUOTATIONS
app.get('/api/quotations', auth, async (req, res) => {
  const r = await pool.query(`SELECT q.*,c.business_name,c.contact_name,b.code AS branch_code FROM quotations q LEFT JOIN contacts c ON q.contact_id=c.id JOIN branches b ON q.branch_id=b.id ORDER BY q.created_at DESC`);
  res.json(r.rows);
});
app.post('/api/quotations', auth, async (req, res) => {
  const { branch_id, contact_id, valid_until, items, discount, note } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const branchR = await client.query('SELECT code FROM branches WHERE id=$1', [branch_id]);
    const docNo = await genDocNo('quotation', branchR.rows[0]?.code||'');
    let subtotal = 0;
    items.forEach(i => subtotal += parseFloat(i.qty) * parseFloat(i.price));
    const total = subtotal - (parseFloat(discount)||0);
    const r = await client.query(`INSERT INTO quotations (doc_no,branch_id,contact_id,valid_until,subtotal,discount,total,note,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [docNo, branch_id, contact_id||null, valid_until||null, subtotal, discount||0, total, note, req.user.id]);
    const qtId = r.rows[0].id;
    for (const item of items) {
      await client.query('INSERT INTO quotation_items (quotation_id,product_id,description,qty,unit,price,subtotal) VALUES ($1,$2,$3,$4,$5,$6,$7)', [qtId, item.product_id||null, item.description, item.qty, item.unit||'', item.price, item.qty*item.price]);
    }
    await client.query('COMMIT');
    res.status(201).json({ message: 'สร้างใบเสนอราคาเรียบร้อย', doc_no: docNo, id: qtId });
  } catch(e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); } finally { client.release(); }
});
app.get('/api/quotations/:id/items', auth, async (req, res) => {
  const r = await pool.query(`SELECT qi.*,p.name AS product_name FROM quotation_items qi LEFT JOIN products p ON qi.product_id=p.id WHERE qi.quotation_id=$1`, [req.params.id]);
  res.json(r.rows);
});

// SALES
async function generateSaleNo(branchCode) {
  const today = new Date().toISOString().slice(0,10).replace(/-/g,'');
  const r = await pool.query(`SELECT COUNT(*) FROM sales WHERE sale_no LIKE $1`, [`${branchCode}-${today}-%`]);
  return `${branchCode}-${today}-${String(parseInt(r.rows[0].count)+1).padStart(3,'0')}`;
}

app.post('/api/sales', auth, async (req, res) => {
  const { branch_id, branch_code, contact_id, member_id, sale_channel, items, discount, member_discount, payment_methods, shift_id, note } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sale_no = await generateSaleNo(branch_code||'XX');
    let subtotal = 0;
    for (const item of items) subtotal += item.qty_set * item.price_per_set;
    const total = subtotal - (discount||0) - (member_discount||0);
    const sale = await client.query('INSERT INTO sales (sale_no,branch_id,shift_id,contact_id,member_id,sale_channel,cashier_id,subtotal,discount,member_discount,total,payment_methods,note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id', [sale_no, branch_id, shift_id||null, contact_id||null, member_id||null, sale_channel||'retail', req.user.id, subtotal, discount||0, member_discount||0, total, JSON.stringify(payment_methods||[]), note]);
    const saleId = sale.rows[0].id;
    let totalEggs = 0;
    for (const item of items) {
      const qty_unit = item.qty_set * item.unit_size;
      if (item.is_egg) totalEggs += qty_unit;
      await client.query('INSERT INTO sale_items (sale_id,product_id,qty_set,unit_size,qty_unit,price_per_set,subtotal) VALUES ($1,$2,$3,$4,$5,$6,$7)', [saleId, item.product_id, item.qty_set, item.unit_size, qty_unit, item.price_per_set, item.qty_set*item.price_per_set]);
      const before = await client.query('SELECT qty_unit FROM stock WHERE product_id=$1 AND branch_id=$2', [item.product_id, branch_id]);
      const qBefore = before.rows[0] ? parseInt(before.rows[0].qty_unit) : 0;
      await client.query('UPDATE stock SET qty_unit=qty_unit-$1,updated_at=NOW() WHERE product_id=$2 AND branch_id=$3', [qty_unit, item.product_id, branch_id]);
      await client.query('INSERT INTO stock_movements (product_id,branch_id,movement_type,qty_change,qty_before,qty_after,ref_type,ref_id,note,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [item.product_id, branch_id, 'sale', -qty_unit, qBefore, qBefore-qty_unit, 'sale', saleId, sale_no, req.user.id]);
    }
    if (member_id && totalEggs > 0) {
      const ms = await client.query('SELECT * FROM member_settings LIMIT 1');
      const setting = ms.rows[0];
      const member = await client.query('SELECT * FROM members WHERE id=$1', [member_id]);
      const m = member.rows[0];
      const newTotal = m.total_eggs + totalEggs;
      const newSets = Math.floor(newTotal / setting.eggs_required);
      const oldSets = Math.floor(m.total_eggs / setting.eggs_required);
      const newDiscount = m.redeemable_discount + (newSets - oldSets) * parseFloat(setting.discount_amount);
      const usedDiscount = parseFloat(member_discount||0);
      await client.query('UPDATE members SET total_eggs=$1,redeemable_discount=$2,total_redeemed=total_redeemed+$3 WHERE id=$4', [newTotal, Math.max(0, newDiscount-usedDiscount), usedDiscount, member_id]);
    }
    const hasCredit = (payment_methods||[]).find(p => p.method === 'credit');
    if (hasCredit) {
      await client.query('INSERT INTO credit_sales (sale_id,contact_id,member_id,branch_id,amount) VALUES ($1,$2,$3,$4,$5)', [saleId, contact_id||null, member_id||null, branch_id, hasCredit.amount]);
    }
    if (sale_channel === 'wholesale' && hasCredit && contact_id) {
      const branchR = await client.query('SELECT code FROM branches WHERE id=$1', [branch_id]);
      const docNo = await genDocNo('invoice', branchR.rows[0]?.code||'');
      const contact = await client.query('SELECT * FROM contacts WHERE id=$1', [contact_id]);
      const c = contact.rows[0];
      const dueDate = new Date(); dueDate.setDate(dueDate.getDate() + (c.credit_days||7));
      await client.query('INSERT INTO invoices (invoice_no,sale_id,contact_id,branch_id,due_date,total,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [docNo, saleId, contact_id, branch_id, dueDate.toISOString().slice(0,10), hasCredit.amount, req.user.id]);
    }
    await client.query('COMMIT');
    res.status(201).json({ message: 'บันทึกการขายเรียบร้อย', sale_no, sale_id: saleId });
  } catch(e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); } finally { client.release(); }
});

app.get('/api/sales', auth, async (req, res) => {
  const { branch_id, date_from, date_to, date, channel } = req.query;
  let q = `SELECT s.*,c.business_name,c.contact_name,u.full_name AS cashier_name,b.code AS branch_code FROM sales s LEFT JOIN contacts c ON s.contact_id=c.id JOIN users u ON s.cashier_id=u.id JOIN branches b ON s.branch_id=b.id WHERE 1=1`;
  const params = [];
  if (branch_id) { params.push(branch_id); q += ` AND s.branch_id=$${params.length}`; }
  if (date) { params.push(date); q += ` AND s.sale_date=$${params.length}`; }
  if (date_from) { params.push(date_from); q += ` AND s.sale_date>=$${params.length}`; }
  if (date_to) { params.push(date_to); q += ` AND s.sale_date<=$${params.length}`; }
  if (channel) { params.push(channel); q += ` AND s.sale_channel=$${params.length}`; }
  q += ' ORDER BY s.created_at DESC LIMIT 200';
  const r = await pool.query(q, params);
  res.json(r.rows);
});
app.get('/api/sales/:id/items', auth, async (req, res) => {
  const r = await pool.query(`SELECT si.*,p.name AS product_name,p.code FROM sale_items si JOIN products p ON si.product_id=p.id WHERE si.sale_id=$1`, [req.params.id]);
  res.json(r.rows);
});

// INVOICES
app.get('/api/invoices', auth, async (req, res) => {
  const r = await pool.query(`SELECT i.*,c.contact_name,c.business_name,b.code AS branch_code FROM invoices i LEFT JOIN contacts c ON i.contact_id=c.id JOIN branches b ON i.branch_id=b.id ORDER BY i.created_at DESC`);
  res.json(r.rows);
});
app.post('/api/invoices/:id/pay', auth, async (req, res) => {
  const { amount, method, note } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO invoice_payments (invoice_id,amount,method,note,created_by) VALUES ($1,$2,$3,$4,$5)', [req.params.id, amount, method, note, req.user.id]);
    const inv = await client.query('SELECT * FROM invoices WHERE id=$1', [req.params.id]);
    const newPaid = parseFloat(inv.rows[0].paid_amount) + parseFloat(amount);
    const status = newPaid >= parseFloat(inv.rows[0].total) ? 'paid' : 'partial';
    await client.query('UPDATE invoices SET paid_amount=$1,status=$2 WHERE id=$3', [newPaid, status, req.params.id]);
    // สร้างใบเสร็จ
    const branchR = await client.query('SELECT code FROM branches WHERE id=$1', [inv.rows[0].branch_id]);
    const receiptNo = await genDocNo('receipt', branchR.rows[0]?.code||'');
    await client.query('COMMIT');
    res.json({ message: 'บันทึกเรียบร้อย', receipt_no: receiptNo });
  } catch(e) { await client.query('ROLLBACK'); res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); } finally { client.release(); }
});

// CREDIT SALES
app.get('/api/credit-sales', auth, async (req, res) => {
  const r = await pool.query(`SELECT cs.*,c.contact_name,c.business_name,c.mobile,b.code AS branch_code,s.sale_no,s.sale_date FROM credit_sales cs LEFT JOIN contacts c ON cs.contact_id=c.id JOIN branches b ON cs.branch_id=b.id JOIN sales s ON cs.sale_id=s.id WHERE cs.status!='paid' ORDER BY cs.created_at DESC`);
  res.json(r.rows);
});
app.post('/api/credit-sales/:id/pay', auth, async (req, res) => {
  const { amount, method } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO credit_payments (credit_sale_id,amount,method,created_by) VALUES ($1,$2,$3,$4)', [req.params.id, amount, method, req.user.id]);
    const cs = await client.query('SELECT * FROM credit_sales WHERE id=$1', [req.params.id]);
    const newPaid = parseFloat(cs.rows[0].paid_amount) + parseFloat(amount);
    const status = newPaid >= parseFloat(cs.rows[0].amount) ? 'paid' : 'partial';
    await client.query('UPDATE credit_sales SET paid_amount=$1,status=$2 WHERE id=$3', [newPaid, status, req.params.id]);
    await client.query('COMMIT');
    res.json({ message: 'รับชำระเรียบร้อย' });
  } catch(e) { await client.query('ROLLBACK'); res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); } finally { client.release(); }
});

// EXPENSES
app.get('/api/expenses', auth, async (req, res) => {
  const { branch_id, date_from, date_to } = req.query;
  let q = `SELECT e.*,ec.name AS category_name,b.code AS branch_code,u.full_name AS created_by_name
    FROM expenses e JOIN expense_categories ec ON e.category_id=ec.id
    JOIN branches b ON e.branch_id=b.id LEFT JOIN users u ON e.created_by=u.id WHERE 1=1`;
  const params = [];
  if (branch_id) { params.push(branch_id); q += ` AND e.branch_id=$${params.length}`; }
  if (date_from) { params.push(date_from); q += ` AND e.expense_date>=$${params.length}`; }
  if (date_to) { params.push(date_to); q += ` AND e.expense_date<=$${params.length}`; }
  q += ' ORDER BY e.expense_date DESC LIMIT 100';
  const r = await pool.query(q, params);
  res.json(r.rows);
});
app.post('/api/expenses', auth, async (req, res) => {
  const { branch_id, category_id, amount, expense_date, note, withholding_tax } = req.body;
  if (!branch_id||!category_id||!amount) return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });
  try {
    const r = await pool.query(`INSERT INTO expenses (branch_id,category_id,amount,expense_date,note,withholding_tax,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [branch_id, category_id, amount, expense_date||new Date().toISOString().slice(0,10), note, withholding_tax||0, req.user.id]);
    res.status(201).json({ message: 'บันทึกค่าใช้จ่ายเรียบร้อย', expense: r.rows[0] });
  } catch(e) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});
app.delete('/api/expenses/:id', auth, role('owner','admin','manager'), async (req, res) => {
  await pool.query('DELETE FROM expenses WHERE id=$1', [req.params.id]);
  res.json({ message: 'ลบเรียบร้อย' });
});
app.get('/api/expense-categories', auth, async (req, res) => {
  const r = await pool.query('SELECT * FROM expense_categories ORDER BY id');
  res.json(r.rows);
});
app.post('/api/expense-categories', auth, role('owner','admin'), async (req, res) => {
  const r = await pool.query('INSERT INTO expense_categories (name) VALUES ($1) RETURNING *', [req.body.name]);
  res.status(201).json(r.rows[0]);
});

// DEBT NOTES (ใบลดหนี้ / ใบเพิ่มหนี้)
app.get('/api/debt-notes', auth, async (req, res) => {
  const r = await pool.query(`SELECT dn.*,c.business_name,c.contact_name,b.code AS branch_code,i.invoice_no AS ref_invoice_no
    FROM debt_notes dn LEFT JOIN contacts c ON dn.contact_id=c.id JOIN branches b ON dn.branch_id=b.id
    LEFT JOIN invoices i ON dn.ref_invoice_id=i.id ORDER BY dn.created_at DESC`);
  res.json(r.rows);
});
app.post('/api/debt-notes', auth, role('owner','admin','manager'), async (req, res) => {
  const { note_type, branch_id, contact_id, ref_invoice_id, amount, reason } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const docType = note_type === 'debit' ? 'debit_note' : 'credit_note';
    const branchR = await client.query('SELECT code FROM branches WHERE id=$1', [branch_id]);
    const docNo = await genDocNo(docType, branchR.rows[0]?.code||'');
    const r = await client.query(`INSERT INTO debt_notes (doc_no,note_type,branch_id,contact_id,ref_invoice_id,amount,reason,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [docNo, note_type, branch_id, contact_id||null, ref_invoice_id||null, amount, reason, req.user.id]);
    // ปรับยอดใบแจ้งหนี้ถ้าอ้างอิง
    if (ref_invoice_id) {
      const adj = note_type === 'credit' ? -parseFloat(amount) : parseFloat(amount);
      await client.query('UPDATE invoices SET total=total+$1 WHERE id=$2', [adj, ref_invoice_id]);
    }
    await client.query('COMMIT');
    res.status(201).json({ message: 'สร้างเอกสารเรียบร้อย', doc_no: docNo, note: r.rows[0] });
  } catch(e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
  finally { client.release(); }
});

// PROMOTIONS
app.get('/api/promotions', auth, async (req, res) => {
  const r = await pool.query(`SELECT p.*,pr.name AS product_name,b.code AS branch_code FROM promotions p LEFT JOIN products pr ON p.product_id=pr.id LEFT JOIN branches b ON p.branch_id=b.id ORDER BY p.start_date DESC`);
  res.json(r.rows);
});
app.post('/api/promotions', auth, role('owner','admin','manager'), async (req, res) => {
  const { name, branch_id, promo_type, product_id, min_qty, discount_value, free_product_id, free_qty, start_date, end_date } = req.body;
  try {
    const r = await pool.query(`INSERT INTO promotions (name,branch_id,promo_type,product_id,min_qty,discount_value,free_product_id,free_qty,start_date,end_date,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [name, branch_id||null, promo_type, product_id||null, min_qty||1, discount_value||null, free_product_id||null, free_qty||null, start_date, end_date, req.user.id]);
    res.status(201).json({ message: 'สร้างโปรโมชั่นเรียบร้อย', promotion: r.rows[0] });
  } catch(e) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});
app.put('/api/promotions/:id', auth, role('owner','admin','manager'), async (req, res) => {
  const { active } = req.body;
  await pool.query('UPDATE promotions SET active=$1 WHERE id=$2', [active, req.params.id]);
  res.json({ message: 'อัพเดทเรียบร้อย' });
});

// EMPLOYEES
app.get('/api/employees', auth, async (req, res) => {
  const r = await pool.query(`SELECT e.*,b.code AS branch_code,b.name AS branch_name FROM employees e LEFT JOIN branches b ON e.branch_id=b.id WHERE e.active=true ORDER BY e.full_name`);
  res.json(r.rows);
});
app.post('/api/employees', auth, role('owner','admin'), async (req, res) => {
  const { full_name, nickname, phone, branch_id, position, start_date, salary } = req.body;
  if (!full_name) return res.status(400).json({ error: 'กรุณากรอกชื่อ' });
  try {
    const code = 'EMP' + Date.now().toString().slice(-5);
    const r = await pool.query(`INSERT INTO employees (code,full_name,nickname,phone,branch_id,position,start_date,salary) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [code, full_name, nickname, phone, branch_id||null, position, start_date||null, salary||null]);
    res.status(201).json({ message: 'เพิ่มพนักงานเรียบร้อย', employee: r.rows[0] });
  } catch(e) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});
app.put('/api/employees/:id', auth, role('owner','admin'), async (req, res) => {
  const { full_name, nickname, national_id, phone, email, address, branch_id, position, start_date, probation_end_date, salary, salary_base, bank_name, bank_account, education, work_history, emergency_contact, active } = req.body;
  await pool.query(`UPDATE employees SET full_name=$1,nickname=$2,national_id=$3,phone=$4,email=$5,address=$6,branch_id=$7,position=$8,start_date=$9,probation_end_date=$10,salary=$11,salary_base=$12,bank_name=$13,bank_account=$14,education=$15,work_history=$16,emergency_contact=$17,active=$18 WHERE id=$19`,
    [full_name, nickname, national_id, phone, email, address, branch_id||null, position, start_date||null, probation_end_date||null, salary||null, salary_base||null, bank_name, bank_account, education, work_history, emergency_contact, active, req.params.id]);
  res.json({ message: 'แก้ไขเรียบร้อย' });
});

// Upload รูปพนักงาน
app.post('/api/employees/:id/photo', auth, role('owner','admin'), upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'กรุณาเลือกรูป' });
  await pool.query('UPDATE employees SET photo_url=$1 WHERE id=$2', ['/uploads/'+req.file.filename, req.params.id]);
  res.json({ message: 'อัพโหลดรูปเรียบร้อย', url: '/uploads/'+req.file.filename });
});

// Upload เอกสารพนักงาน
app.post('/api/employees/:id/doc', auth, role('owner','admin'), upload.single('doc'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'กรุณาเลือกไฟล์' });
  await pool.query('UPDATE employees SET doc_url=$1 WHERE id=$2', ['/uploads/'+req.file.filename, req.params.id]);
  res.json({ message: 'อัพโหลดเอกสารเรียบร้อย', url: '/uploads/'+req.file.filename });
});

// REPORTS
app.get('/api/reports/daily', auth, async (req, res) => {
  const { date, branch_id } = req.query;
  const targetDate = date || new Date().toISOString().slice(0,10);
  let branchFilter = ''; const params = [targetDate];
  if (branch_id) { params.push(branch_id); branchFilter = ` AND s.branch_id=$${params.length}`; }
  const r = await pool.query(`SELECT b.code AS branch_code,b.name AS branch_name,COUNT(s.id) AS total_bills,SUM(s.total) AS total_revenue,SUM(s.discount) AS total_discount FROM sales s JOIN branches b ON s.branch_id=b.id WHERE s.sale_date=$1 AND s.status='completed'${branchFilter} GROUP BY b.id,b.code,b.name ORDER BY b.code`, params);
  res.json({ date: targetDate, branches: r.rows });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

initSchema().then(() => app.listen(PORT, () => console.log(`🥚 Egg Station running on port ${PORT}`)));
