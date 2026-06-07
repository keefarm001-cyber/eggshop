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
    // ลบกลุ่มสินค้าซ้ำ + เพิ่ม unique constraint
    try {
      await pool.query(`DELETE FROM product_categories WHERE id NOT IN (SELECT MIN(id) FROM product_categories GROUP BY name)`);
      await pool.query(`ALTER TABLE product_categories ADD CONSTRAINT product_categories_name_unique UNIQUE (name)`);
    } catch(e) { /* constraint อาจมีอยู่แล้ว */ }

    // seed กลุ่มสินค้า
    const defaultCats = [
      ['ไข่ไก่','stock'],['ของชำ','stock'],['บรรจุภัณฑ์','stock'],
      ['บริการ','service'],['อื่นๆ ไม่นับสต๊อก','nostock'],
      ['ไข่เสริม','stock'],['บรรจุภัณฑ์ไข่','stock'],
    ];
    for (const [name, type] of defaultCats) {
      await pool.query(`INSERT INTO product_categories (name,type) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING`, [name, type]);
    }

    // products
    await pool.query(`CREATE TABLE IF NOT EXISTS products (id SERIAL PRIMARY KEY, category_id INTEGER REFERENCES product_categories(id), code VARCHAR(30) UNIQUE NOT NULL, name VARCHAR(100) NOT NULL, unit VARCHAR(20) DEFAULT 'ฟอง', is_egg BOOLEAN DEFAULT false, track_stock BOOLEAN DEFAULT true, active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW())`);
    // add track_stock column if not exists
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS track_stock BOOLEAN DEFAULT true`);

    const eggCat = await pool.query(`SELECT id FROM product_categories WHERE name='ไข่ไก่'`);
    const catId = eggCat.rows[0].id;
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
    await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_methods JSONB DEFAULT '[]'`).catch(()=>{});
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

    // role_permissions — สิทธิ์ตาม role
    await pool.query(`CREATE TABLE IF NOT EXISTS product_categories (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      type VARCHAR(20) DEFAULT 'stock',
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(()=>{});

    await pool.query(`CREATE TABLE IF NOT EXISTS member_tiers (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      description TEXT,
      customer_type VARCHAR(20) DEFAULT 'retail',
      discount_percent NUMERIC(5,2) DEFAULT 0,
      discount_amount NUMERIC(10,2) DEFAULT 0,
      min_eggs_required INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(()=>{});

    // seed default tiers ถ้ายังไม่มี
    await pool.query(`INSERT INTO member_tiers (name, description, customer_type, sort_order)
      SELECT * FROM (VALUES
        ('ระดับ 1 (สมาชิกหน้าร้าน)', 'ราคาปลีก + สะสมฟองแลกส่วนลดได้', 'retail', 1),
        ('ระดับ 2 (ร้านค้า/ร้านอาหาร)', 'ราคาร้านค้า ไม่ต้องออกใบแจ้งหนี้', 'restaurant', 2)
      ) AS v(name, description, customer_type, sort_order)
      WHERE NOT EXISTS (SELECT 1 FROM member_tiers LIMIT 1)
    `).catch(()=>{});

    await pool.query(`CREATE TABLE IF NOT EXISTS role_permissions (
      id SERIAL PRIMARY KEY,
      role_name VARCHAR(50) NOT NULL,
      permission VARCHAR(100) NOT NULL,
      granted BOOLEAN DEFAULT true,
      UNIQUE(role_name, permission)
    )`);

    // seed default permissions สำหรับแต่ละ role
    const defaultPerms = {
      owner: ['*'],
      admin: ['*'],
      owner_biz: ['*'],
      manager: ['pos','shifts','sales_view','sales_void','quotations','invoices','credits','receipts','receipts_approve','stock_view','stock_receive','stock_transfer','members','contacts','products_view','products_edit','reports','expenses_view','expenses_edit','promotions','debt_notes','employees_view'],
      cashier: ['pos','shifts','sales_view','credits','members','stock_view'],
      stock: ['stock_view','stock_receive','stock_transfer','receipts'],
      viewer: ['sales_view','stock_view','reports'],
      accountant: ['invoices','credits','debt_notes','expense_docs','expenses_view','expenses_edit','payroll','reports','sales_view','quotations'],
      sales_pc: ['pos','shifts','sales_view','members','credits','stock_view','promotions'],
    };
    for (const [role, perms] of Object.entries(defaultPerms)) {
      for (const perm of perms) {
        await pool.query('INSERT INTO role_permissions (role_name,permission,granted) VALUES ($1,$2,true) ON CONFLICT (role_name,permission) DO NOTHING', [role, perm]);
      }
    }

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
    // เพิ่ม columns ใหม่ถ้ายังไม่มี
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

    // PAYROLL TABLES
    await pool.query(`CREATE TABLE IF NOT EXISTS payroll_periods (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      period_from DATE NOT NULL,
      period_to DATE NOT NULL,
      payment_date DATE,
      status VARCHAR(20) DEFAULT 'draft',
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS payroll_items (
      id SERIAL PRIMARY KEY,
      period_id INTEGER REFERENCES payroll_periods(id) ON DELETE CASCADE,
      employee_id INTEGER REFERENCES employees(id),
      base_salary NUMERIC(10,2) DEFAULT 0,
      overtime NUMERIC(10,2) DEFAULT 0,
      bonus NUMERIC(10,2) DEFAULT 0,
      commission NUMERIC(10,2) DEFAULT 0,
      allowance NUMERIC(10,2) DEFAULT 0,
      other_income NUMERIC(10,2) DEFAULT 0,
      social_security NUMERIC(10,2) DEFAULT 0,
      withholding_tax NUMERIC(10,2) DEFAULT 0,
      student_loan NUMERIC(10,2) DEFAULT 0,
      absent_deduct NUMERIC(10,2) DEFAULT 0,
      other_deduct NUMERIC(10,2) DEFAULT 0,
      deposit NUMERIC(10,2) DEFAULT 0,
      total_income NUMERIC(10,2) DEFAULT 0,
      total_deduct NUMERIC(10,2) DEFAULT 0,
      net_pay NUMERIC(10,2) DEFAULT 0,
      note TEXT,
      status VARCHAR(20) DEFAULT 'pending'
    )`);

    // EXPENSE DOCUMENTS (ค่าใช้จ่ายแบบ document)
    await pool.query(`CREATE TABLE IF NOT EXISTS expense_docs (
      id SERIAL PRIMARY KEY,
      doc_no VARCHAR(30) UNIQUE NOT NULL,
      branch_id INTEGER REFERENCES branches(id),
      contact_id INTEGER REFERENCES contacts(id),
      contact_name TEXT,
      contact_address TEXT,
      contact_tax_id VARCHAR(20),
      doc_date DATE NOT NULL DEFAULT CURRENT_DATE,
      due_date DATE,
      credit_days INTEGER DEFAULT 0,
      subtotal NUMERIC(10,2) DEFAULT 0,
      discount_pct NUMERIC(5,2) DEFAULT 0,
      discount_amt NUMERIC(10,2) DEFAULT 0,
      after_discount NUMERIC(10,2) DEFAULT 0,
      vat_pct NUMERIC(5,2) DEFAULT 0,
      vat_amt NUMERIC(10,2) DEFAULT 0,
      withholding_tax NUMERIC(10,2) DEFAULT 0,
      total NUMERIC(10,2) DEFAULT 0,
      ref_no TEXT,
      note TEXT,
      internal_note TEXT,
      attachment_url TEXT,
      status VARCHAR(20) DEFAULT 'draft',
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`ALTER TABLE expense_docs ADD COLUMN IF NOT EXISTS contact_name TEXT`);
    await pool.query(`ALTER TABLE expense_docs ADD COLUMN IF NOT EXISTS contact_address TEXT`);
    await pool.query(`ALTER TABLE expense_docs ADD COLUMN IF NOT EXISTS contact_tax_id VARCHAR(20)`);
    await pool.query(`ALTER TABLE expense_docs ADD COLUMN IF NOT EXISTS credit_days INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE expense_docs ADD COLUMN IF NOT EXISTS due_date DATE`);
    await pool.query(`ALTER TABLE expense_docs ADD COLUMN IF NOT EXISTS discount_pct NUMERIC(5,2) DEFAULT 0`);
    await pool.query(`ALTER TABLE expense_docs ADD COLUMN IF NOT EXISTS after_discount NUMERIC(10,2) DEFAULT 0`);
    await pool.query(`ALTER TABLE expense_docs ADD COLUMN IF NOT EXISTS vat_pct NUMERIC(5,2) DEFAULT 0`);
    await pool.query(`ALTER TABLE expense_docs ADD COLUMN IF NOT EXISTS vat_amt NUMERIC(10,2) DEFAULT 0`);
    await pool.query(`ALTER TABLE expense_docs ADD COLUMN IF NOT EXISTS ref_no TEXT`);
    await pool.query(`ALTER TABLE expense_docs ADD COLUMN IF NOT EXISTS internal_note TEXT`);
    await pool.query(`ALTER TABLE expense_docs ADD COLUMN IF NOT EXISTS attachment_url TEXT`);

    await pool.query(`CREATE TABLE IF NOT EXISTS expense_doc_items (
      id SERIAL PRIMARY KEY,
      doc_id INTEGER REFERENCES expense_docs(id) ON DELETE CASCADE,
      item_no INTEGER DEFAULT 1,
      description TEXT NOT NULL,
      product_id INTEGER REFERENCES products(id),
      qty NUMERIC(10,4) DEFAULT 1,
      unit VARCHAR(50),
      unit_price NUMERIC(10,4) DEFAULT 0,
      subtotal NUMERIC(10,2) DEFAULT 0
    )`);

    // doc sequence for expense
    await pool.query(`INSERT INTO doc_sequences (doc_type,prefix) VALUES ('expense_doc','EXP') ON CONFLICT (doc_type) DO NOTHING`);
    await pool.query(`INSERT INTO doc_sequences (doc_type,prefix) VALUES ('payroll','PAY') ON CONFLICT (doc_type) DO NOTHING`);

    // product_bundles (สินค้าเป็นชุด เช่น ไข่ 10 ฟอง/ชุด)
    await pool.query(`CREATE TABLE IF NOT EXISTS product_bundles (
      id SERIAL PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      branch_id INTEGER REFERENCES branches(id),
      product_id INTEGER REFERENCES products(id),
      qty_per_bundle INTEGER NOT NULL DEFAULT 10,
      price NUMERIC(10,2) NOT NULL DEFAULT 0,
      customer_type VARCHAR(20) DEFAULT 'retail',
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // เพิ่ม columns ที่อาจหายไป
    await pool.query(`CREATE TABLE IF NOT EXISTS product_categories (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      type VARCHAR(20) DEFAULT 'stock',
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(()=>{});

    await pool.query(`CREATE TABLE IF NOT EXISTS member_tiers (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      description TEXT,
      customer_type VARCHAR(20) DEFAULT 'retail',
      discount_percent NUMERIC(5,2) DEFAULT 0,
      discount_amount NUMERIC(10,2) DEFAULT 0,
      min_eggs_required INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(()=>{});

    // seed default tiers ถ้ายังไม่มี
    await pool.query(`INSERT INTO member_tiers (name, description, customer_type, sort_order)
      SELECT * FROM (VALUES
        ('ระดับ 1 (สมาชิกหน้าร้าน)', 'ราคาปลีก + สะสมฟองแลกส่วนลดได้', 'retail', 1),
        ('ระดับ 2 (ร้านค้า/ร้านอาหาร)', 'ราคาร้านค้า ไม่ต้องออกใบแจ้งหนี้', 'restaurant', 2)
      ) AS v(name, description, customer_type, sort_order)
      WHERE NOT EXISTS (SELECT 1 FROM member_tiers LIMIT 1)
    `).catch(()=>{});

    await pool.query(`CREATE TABLE IF NOT EXISTS role_permissions (
      id SERIAL PRIMARY KEY,
      role_name VARCHAR(50) NOT NULL,
      permission VARCHAR(100) NOT NULL,
      granted BOOLEAN DEFAULT true,
      UNIQUE(role_name, permission)
    )`).catch(()=>{});
    await pool.query('ALTER TABLE role_permissions ADD COLUMN IF NOT EXISTS granted BOOLEAN DEFAULT true').catch(()=>{});
    await pool.query(`ALTER TABLE stock_receipt_items ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(10,4) DEFAULT 0`).catch(()=>{});
    await pool.query('ALTER TABLE members ADD COLUMN IF NOT EXISTS tier_id INTEGER').catch(()=>{});
    // price_qty_tiers — กำหนด qty ที่ใช้ตั้งราคา แยกตาม customer_type
    await pool.query(`CREATE TABLE IF NOT EXISTS price_qty_tiers (
      id SERIAL PRIMARY KEY,
      customer_type VARCHAR(20) NOT NULL,
      qty INTEGER NOT NULL,
      label VARCHAR(50),
      sort_order INTEGER DEFAULT 0,
      active BOOLEAN DEFAULT true,
      UNIQUE(customer_type, qty)
    )`).catch(()=>{});
    // seed default tiers
    await pool.query(`INSERT INTO price_qty_tiers (customer_type, qty, label, sort_order) VALUES
      ('retail', 1, 'ต่อฟอง', 1),
      ('retail', 5, '5 ฟอง', 2),
      ('retail', 10, '10 ฟอง', 3),
      ('retail', 15, '15 ฟอง', 4),
      ('retail', 20, '20 ฟอง', 5),
      ('retail', 30, 'ต่อแผง (30)', 6),
      ('restaurant', 1, 'ต่อฟอง', 1),
      ('restaurant', 10, '10 ฟอง', 2),
      ('restaurant', 30, 'ต่อแผง (30)', 3),
      ('wholesale', 30, 'ต่อแผง (30)', 1),
      ('wholesale', 300, 'ต่อลัง (300)', 2)
      ON CONFLICT DO NOTHING
    `).catch(()=>{});
    await pool.query(`CREATE TABLE IF NOT EXISTS member_points_log (
      id SERIAL PRIMARY KEY,
      member_id INTEGER REFERENCES members(id),
      change_eggs INTEGER NOT NULL,
      reason VARCHAR(100),
      sale_id INTEGER,
      created_by INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(()=>{});
    await pool.query('ALTER TABLE members ADD COLUMN IF NOT EXISTS total_eggs INTEGER DEFAULT 0').catch(()=>{});
    await pool.query('ALTER TABLE members ADD COLUMN IF NOT EXISTS redeemed_eggs INTEGER DEFAULT 0').catch(()=>{});
    await pool.query('ALTER TABLE members ADD COLUMN IF NOT EXISTS line_id TEXT').catch(()=>{});
    await pool.query('ALTER TABLE contacts ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true').catch(()=>{});
    await pool.query('UPDATE contacts SET active=true WHERE active IS NULL').catch(()=>{});
    await pool.query('ALTER TABLE contacts ADD COLUMN IF NOT EXISTS tax_id VARCHAR(30)').catch(()=>{});
    await pool.query(`ALTER TABLE stock ADD CONSTRAINT IF NOT EXISTS stock_unique UNIQUE (product_id, branch_id)`).catch(()=>{});
    await pool.query(`ALTER TABLE product_prices ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`).catch(()=>{});
    await pool.query(`ALTER TABLE product_prices ADD CONSTRAINT IF NOT EXISTS pp_unique UNIQUE (product_id,branch_id,customer_type,qty)`).catch(()=>{});
    await pool.query(`ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS doc_no VARCHAR(50)`).catch(()=>{});
    await pool.query(`ALTER TABLE stock_receipt_items ADD COLUMN IF NOT EXISTS unit_mult INTEGER DEFAULT 1`).catch(()=>{});

    
    
    // member_tiers — ระดับสมาชิก
    await pool.query(`CREATE TABLE IF NOT EXISTS member_tiers (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      description TEXT,
      customer_type VARCHAR(20) DEFAULT 'retail',
      discount_percent NUMERIC(5,2) DEFAULT 0,
      discount_amount NUMERIC(10,2) DEFAULT 0,
      min_eggs_required INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(()=>{});

    // เพิ่ม column tier_id ในตาราง members ถ้ายังไม่มี
    await pool.query('ALTER TABLE members ADD COLUMN IF NOT EXISTS tier_id INTEGER REFERENCES member_tiers(id)').catch(()=>{});

    // สร้าง tier เริ่มต้น
    await pool.query(`INSERT INTO member_tiers (name, description, customer_type, sort_order) VALUES
      ('ระดับ 1 (ทั่วไป)', 'ลูกค้าทั่วไป', 'retail', 1),
      ('ระดับ 2 (ร้านข้าว)', 'ร้านอาหาร/ร้านข้าว', 'restaurant', 2),
      ('ระดับ 3 (ส่ง/ลูกค้าประจำ)', 'ลูกค้าส่งหรือประจำ', 'wholesale', 3)
      ON CONFLICT DO NOTHING`).catch(()=>{});
    // daily_close table
    await pool.query(`CREATE TABLE IF NOT EXISTS daily_closes (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL,
      branch_id INTEGER REFERENCES branches(id),
      sales_total NUMERIC(12,2) DEFAULT 0,
      cash_amount NUMERIC(12,2) DEFAULT 0,
      transfer_amount NUMERIC(12,2) DEFAULT 0,
      broken_eggs INTEGER DEFAULT 0,
      broken_price NUMERIC(8,2) DEFAULT 4.5,
      note TEXT,
      sales_snapshot JSONB DEFAULT '[]',
      stock_snapshot JSONB DEFAULT '[]',
      created_by INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(date, branch_id)
    )`).catch(()=>{});
    // damaged_eggs — บันทึกไข่บุบรายวัน
    await pool.query(`CREATE TABLE IF NOT EXISTS damaged_eggs (
      id SERIAL PRIMARY KEY,
      branch_id INTEGER REFERENCES branches(id),
      damage_date DATE NOT NULL DEFAULT CURRENT_DATE,
      product_id INTEGER REFERENCES products(id),
      product_name TEXT,
      qty INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      photo_url TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // daily_attachments — เอกสารแนบรายวัน (บิล, ใบส่งของ ฯลฯ)
    await pool.query(`CREATE TABLE IF NOT EXISTS daily_attachments (
      id SERIAL PRIMARY KEY,
      branch_id INTEGER REFERENCES branches(id),
      attach_date DATE NOT NULL DEFAULT CURRENT_DATE,
      file_url TEXT NOT NULL,
      file_type VARCHAR(20) DEFAULT 'image',
      doc_type VARCHAR(50) DEFAULT 'other',
      note TEXT,
      uploaded_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // daily_close — ปิดยอดประจำวัน
    await pool.query(`CREATE TABLE IF NOT EXISTS daily_closes (
      id SERIAL PRIMARY KEY,
      branch_id INTEGER REFERENCES branches(id),
      close_date DATE NOT NULL DEFAULT CURRENT_DATE,
      -- ยอดเงิน
      cash_system NUMERIC(10,2) DEFAULT 0,
      cash_actual NUMERIC(10,2) DEFAULT 0,
      cash_diff NUMERIC(10,2) DEFAULT 0,
      transfer_system NUMERIC(10,2) DEFAULT 0,
      transfer_actual NUMERIC(10,2) DEFAULT 0,
      transfer_diff NUMERIC(10,2) DEFAULT 0,
      other_income NUMERIC(10,2) DEFAULT 0,
      total_system NUMERIC(10,2) DEFAULT 0,
      total_actual NUMERIC(10,2) DEFAULT 0,
      total_diff NUMERIC(10,2) DEFAULT 0,
      -- สรุปไข่
      egg_sold_total INTEGER DEFAULT 0,
      egg_variance INTEGER DEFAULT 0,
      egg_variance_value NUMERIC(10,2) DEFAULT 0,
      -- หมายเหตุ
      note TEXT,
      items JSONB DEFAULT '[]',
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(branch_id, close_date)
    )`);
    await pool.query(`ALTER TABLE daily_closes ADD COLUMN IF NOT EXISTS other_income NUMERIC(10,2) DEFAULT 0`);

    // company_settings
    await pool.query(`CREATE TABLE IF NOT EXISTS company_settings (
      id SERIAL PRIMARY KEY,
      company_name VARCHAR(200) DEFAULT 'Egg Station',
      company_name_en VARCHAR(200) DEFAULT 'Egg Station',
      tax_id VARCHAR(20),
      address TEXT,
      phone VARCHAR(50),
      email VARCHAR(150),
      website VARCHAR(150),
      logo_url TEXT,
      bank_name VARCHAR(100),
      bank_account VARCHAR(50),
      bank_account_name VARCHAR(100),
      invoice_note TEXT DEFAULT 'ขอบคุณที่ใช้บริการ',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    const cs = await pool.query('SELECT id FROM company_settings');
    if (cs.rows.length === 0) {
      await pool.query(`INSERT INTO company_settings
        (company_name, company_name_en, tax_id, address, phone, invoice_note)
        VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          'บริษัท เจ เอ็น คอมพาเนียน กรุ๊ป จำกัด (สำนักงานใหญ่)',
          'J.N. Companion Group Co., Ltd. (Head Office)',
          '0745567000735',
          '219/791 หมู่ที่ 12 ต.อ้อมน้อย อ.กระทุ่มแบน จ.สมุทรสาคร 74130',
          '064-949-0589',
          'ขอบคุณที่ใช้บริการ กรุณาชำระเงินภายในกำหนด'
        ]);
    }

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
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
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

    const token = jwt.sign({ id:u.id, username:u.username, full_name:u.full_name, role:u.role, branch_id:u.branch_id, branch_code:u.branch_code }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id:u.id, username:u.username, full_name:u.full_name, role:u.role, branch_id:u.branch_id, branch_code:u.branch_code, branch_name:u.branch_name, access_branches: allBranches } });
  } catch(e) { console.error(e); res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});
app.get('/api/auth/me', auth, async (req, res) => {
  try {
    res.json({ id: req.user.id, username: req.user.username, role: req.user.role, branch_id: req.user.branch_id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// BRANCHES
app.get('/api/branches', auth, async (req, res) => { const r = await pool.query('SELECT * FROM branches WHERE active=true ORDER BY id'); res.json(r.rows); });
app.post('/api/branches', auth, role('owner','admin'), async (req, res) => {
  const { name, code, address, phone } = req.body;
  if (!name || !code) return res.status(400).json({ error: 'กรุณากรอกชื่อและรหัสสาขา' });
  try {
    const r = await pool.query('INSERT INTO branches (name,code,address,phone) VALUES ($1,$2,$3,$4) RETURNING *',
      [name, code.toUpperCase(), address||null, phone||null]);
    res.status(201).json({ message: 'สร้างสาขาเรียบร้อย', branch: r.rows[0] });
  } catch(e) {
    if (e.code==='23505') return res.status(409).json({ error: 'รหัสสาขานี้มีอยู่แล้ว' });
    res.status(500).json({ error: e.message });
  }
});

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
  const { full_name, role_id, phone, active, password } = req.body;
  try {
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.params.id]);
    }
    const fields = []; const vals = [];
    if (full_name !== undefined) { fields.push(`full_name=$${fields.length+1}`); vals.push(full_name); }
    if (role_id !== undefined) { fields.push(`role_id=$${fields.length+1}`); vals.push(role_id); }
    if (phone !== undefined) { fields.push(`phone=$${fields.length+1}`); vals.push(phone); }
    if (active !== undefined) { fields.push(`active=$${fields.length+1}`); vals.push(active); }
    if (fields.length > 0) { vals.push(req.params.id); await pool.query(`UPDATE users SET ${fields.join(',')} WHERE id=$${vals.length}`, vals); }
    res.json({ message: 'อัพเดทเรียบร้อย' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/roles', auth, async (req, res) => { const r = await pool.query('SELECT * FROM roles ORDER BY id'); res.json(r.rows); });

// ============================================================
// ROLE PERMISSIONS API
// ============================================================
// list ของ permissions ทั้งหมดในระบบ
const ALL_PERMISSIONS = [
  { group:'การขาย', items:[
    { key:'pos', label:'ขายหน้าร้าน' },
    { key:'shifts', label:'เปิด/ปิดกะ' },
    { key:'sales_view', label:'ดูประวัติการขาย' },
    { key:'sales_void', label:'ยกเลิกบิล' },
  ]},
  { group:'เอกสาร', items:[
    { key:'quotations', label:'ใบเสนอราคา' },
    { key:'invoices', label:'ใบแจ้งหนี้' },
    { key:'credits', label:'ลูกค้าเชื่อหน้าร้าน' },
    { key:'receipts', label:'ดูใบรับสินค้า (Pre)' },
    { key:'receipts_approve', label:'อนุมัติใบรับสินค้า (ใส่ราคา)' },
    { key:'debt_notes', label:'ใบลดหนี้/ใบเพิ่มหนี้' },
  ]},
  { group:'สต๊อก', items:[
    { key:'stock_view', label:'ดูสต๊อกสินค้า' },
    { key:'stock_receive', label:'รับสินค้าเข้า' },
    { key:'stock_transfer', label:'โอนย้ายสินค้า' },
  ]},
  { group:'CRM', items:[
    { key:'members', label:'สมาชิก' },
    { key:'contacts', label:'รายชื่อผู้ติดต่อ' },
  ]},
  { group:'การเงิน', items:[
    { key:'expenses_view', label:'ดูค่าใช้จ่าย' },
    { key:'expenses_edit', label:'เพิ่ม/แก้ไขค่าใช้จ่าย' },
    { key:'expense_docs', label:'เอกสารค่าใช้จ่าย' },
    { key:'promotions', label:'โปรโมชั่น' },
    { key:'payroll', label:'Payroll/เงินเดือน' },
  ]},
  { group:'จัดการ', items:[
    { key:'products_view', label:'ดูสินค้า' },
    { key:'products_edit', label:'แก้ไขสินค้า' },
    { key:'reports', label:'ดูรายงาน' },
    { key:'employees_view', label:'ดูรายชื่อพนักงาน' },
    { key:'users_manage', label:'จัดการผู้ใช้งาน' },
  ]},
];

app.get('/api/permissions/schema', auth, role('owner','admin'), async (req, res) => {
  res.json(ALL_PERMISSIONS);
});





// middleware ตรวจ permission (ใช้ใน API ที่ต้องการ)
async function checkPerm(perm) {
  return async (req, res, next) => {
    if (['owner','admin'].includes(req.user.role)) return next();
    const r = await pool.query('SELECT id FROM role_permissions WHERE role_name=$1 AND permission=$2 AND granted=true', [req.user.role, perm]);
    if (r.rows.length > 0) return next();
    return res.status(403).json({ error: `ไม่มีสิทธิ์: ${perm}` });
  };
}

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
  const token = jwt.sign({ id:u.id, username:u.username, full_name:u.full_name, role:u.role, branch_id:branch.id, branch_code:branch.code }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, branch_id: branch.id, branch_code: branch.code, branch_name: branch.name });
});

// MEMBER SETTINGS
app.get('/api/member-settings', auth, async (req, res) => { const r = await pool.query('SELECT * FROM member_settings LIMIT 1'); res.json(r.rows[0]); });
app.put('/api/member-settings', auth, role('owner','admin'), async (req, res) => { await pool.query('UPDATE member_settings SET eggs_required=$1,discount_amount=$2,updated_at=NOW()', [req.body.eggs_required, req.body.discount_amount]); res.json({ message: 'บันทึกเรียบร้อย' }); });

// MEMBERS
app.get('/api/members', auth, async (req, res) => { const r = await pool.query(`SELECT m.*,b.code AS branch_code, t.name AS tier_name, t.customer_type AS tier_customer_type FROM members m LEFT JOIN branches b ON m.branch_id=b.id LEFT JOIN member_tiers t ON m.tier_id=t.id WHERE m.active=true ORDER BY m.name`); res.json(r.rows); });
app.post('/api/members', auth, async (req, res) => {
  const { name, phone, branch_id } = req.body;
  if (!name) return res.status(400).json({ error: 'กรุณากรอกชื่อ' });
  try { const code = 'M' + Date.now().toString().slice(-6); const r = await pool.query('INSERT INTO members (code,name,phone,line_id,note,branch_id,tier_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [code, name, phone||null, req.body.line_id||null, req.body.note||null, branch_id||null, req.body.tier_id||null]); res.status(201).json({ message: 'เพิ่มสมาชิกเรียบร้อย', member: r.rows[0] }); }
  catch(e) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});
app.put('/api/members/:id', auth, async (req, res) => { const { name, phone, branch_id, active } = req.body; await pool.query('UPDATE members SET name=$1,phone=$2,branch_id=$3,active=$4,tier_id=$5 WHERE id=$6', [name, phone, branch_id||null, active, req.body.tier_id||null, req.params.id]); res.json({ message: 'แก้ไขเรียบร้อย' }); });

// PRODUCTS
app.get('/api/products', auth, async (req, res) => {
  const { category_id, search, branch_id } = req.query;
  try {
    let stockJoin = branch_id
      ? `LEFT JOIN stock s ON s.product_id=p.id AND s.branch_id=${parseInt(branch_id)}`
      : `LEFT JOIN stock s ON s.product_id=p.id`;
    let q = `SELECT p.*,
      COALESCE(pc.name,'') AS category_name,
      COALESCE(SUM(s.qty_unit),0) AS total_stock
      FROM products p
      LEFT JOIN product_categories pc ON p.category_id=pc.id
      ${stockJoin}
      WHERE 1=1`;
    const params = [];
    if (category_id) { params.push(category_id); q += ` AND p.category_id=$${params.length}`; }
    if (search) { params.push('%'+search+'%'); q += ` AND (p.name ILIKE $${params.length} OR p.code ILIKE $${params.length})`; }
    q += ' GROUP BY p.id, pc.name ORDER BY p.code NULLS LAST';
    const r = await pool.query(q, params);
    res.json(r.rows);
  } catch(e) {
    console.error('products GET error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/products', auth, role('owner','admin','manager'), async (req, res) => {
  const { category_id, code, name, unit, is_egg, track_stock } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'กรุณากรอกรหัสและชื่อสินค้า' });
  try {
    // ตรวจว่า code ซ้ำไหม
    const exist = await pool.query('SELECT id FROM products WHERE code=$1', [code]);
    if (exist.rows.length > 0) {
      return res.status(409).json({ error: 'รหัสสินค้านี้มีอยู่แล้ว ('+code+')' });
    }
    const r = await pool.query(
      'INSERT INTO products (category_id,code,name,unit,is_egg,track_stock) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [category_id||null, code, name, unit||'ฟอง', is_egg||false, track_stock!==false]
    );
    // สร้าง stock record สำหรับทุกสาขา
    const brs = await pool.query('SELECT id FROM branches WHERE active=true');
    for (const br of brs.rows) {
      await pool.query('INSERT INTO stock (product_id,branch_id,qty_unit) VALUES ($1,$2,0) ON CONFLICT DO NOTHING', [r.rows[0].id, br.id]);
    }
    res.status(201).json({ message: 'เพิ่มสินค้าเรียบร้อย', id: r.rows[0].id, product: r.rows[0] });
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'รหัสสินค้า "'+code+'" มีอยู่แล้ว' });
    res.status(500).json({ error: e.message });
  }
});
app.put('/api/products/:id', auth, role('owner','admin','manager'), async (req, res) => { const { name, unit, active, track_stock } = req.body; await pool.query('UPDATE products SET name=$1,unit=$2,active=$3,track_stock=$4 WHERE id=$5', [name, unit, active, track_stock!==false, req.params.id]); res.json({ message: 'แก้ไขเรียบร้อย' }); });
app.delete('/api/products/:id', auth, role('owner','admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM product_prices WHERE product_id=$1', [req.params.id]);
    await client.query('DELETE FROM stock WHERE product_id=$1', [req.params.id]);
    await client.query('DELETE FROM products WHERE id=$1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ message: 'ลบสินค้าเรียบร้อย' });
  } catch(e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

app.get('/api/product-categories', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM product_categories ORDER BY id');
    res.json(r.rows);
  } catch(e) { res.json([]); }
});

app.post('/api/product-categories', auth, role('owner','admin','manager'), async (req, res) => {
  const { name, type } = req.body;
  if (!name) return res.status(400).json({ error: 'กรุณากรอกชื่อกลุ่ม' });
  try {
    // ตรวจว่ามีชื่อซ้ำไหม
    const exist = await pool.query('SELECT id FROM product_categories WHERE name=$1', [name]);
    if (exist.rows.length) return res.status(400).json({ error: 'มีกลุ่มสินค้าชื่อ "'+name+'" อยู่แล้ว' });
    const r = await pool.query('INSERT INTO product_categories (name,type) VALUES ($1,$2) RETURNING *', [name, type||'stock']);
    res.status(201).json(r.rows[0]);
  } catch(e) {
    if (e.code === '23505') return res.status(400).json({ error: 'มีกลุ่มสินค้าชื่อ "'+name+'" อยู่แล้ว' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/product-categories/:id', auth, role('owner','admin','manager'), async (req, res) => {
  const { name, type } = req.body;
  if (!name) return res.status(400).json({ error: 'กรุณากรอกชื่อ' });
  try {
    // ตรวจชื่อซ้ำ (ยกเว้น id ตัวเอง)
    const exist = await pool.query('SELECT id FROM product_categories WHERE name=$1 AND id!=$2', [name, req.params.id]);
    if (exist.rows.length) return res.status(400).json({ error: 'มีกลุ่มสินค้าชื่อ "'+name+'" อยู่แล้ว' });
    await pool.query('UPDATE product_categories SET name=$1, type=$2 WHERE id=$3', [name, type||'stock', req.params.id]);
    res.json({ message: 'แก้ไขเรียบร้อย' });
  } catch(e) {
    if (e.code === '23505') return res.status(400).json({ error: 'มีกลุ่มสินค้าชื่อ "'+name+'" อยู่แล้ว' });
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/product-categories/:id', auth, role('owner','admin','manager'), async (req, res) => {
  try {
    await pool.query('UPDATE products SET category_id=NULL WHERE category_id=$1', [req.params.id]);
    await pool.query('DELETE FROM product_categories WHERE id=$1', [req.params.id]);
    res.json({ message: 'ลบเรียบร้อย' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/products/:id/prices', auth, async (req, res) => {
  const r = await pool.query(`SELECT pp.*,b.code AS branch_code,b.name AS branch_name FROM product_prices pp JOIN branches b ON pp.branch_id=b.id WHERE pp.product_id=$1 ORDER BY b.code,pp.customer_type,pp.qty`, [req.params.id]);
  res.json(r.rows);
});
app.delete('/api/products/prices/:priceId', auth, role('owner','admin','manager'), async (req, res) => {
  await pool.query('DELETE FROM product_prices WHERE id=$1', [req.params.priceId]);
  res.json({ message: 'ลบราคาเรียบร้อย' });
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
  
  // ดึงสินค้าพร้อมราคาของ branch นั้น (ถ้ามี)
  const r = await pool.query(`
    SELECT p.id AS product_id, p.code, p.name, p.unit, p.is_egg,
      pp.qty, pp.price,
      COALESCE(s.qty_unit,0) AS stock_qty
    FROM products p
    LEFT JOIN product_prices pp ON pp.product_id=p.id AND pp.branch_id=$1 AND pp.customer_type=$2
    LEFT JOIN stock s ON s.product_id=p.id AND s.branch_id=$1
    WHERE 1=1
    ORDER BY p.is_egg DESC, p.code, pp.qty NULLS LAST
  `, [branch_id, customer_type]);
  
  // group by product
  const grouped = {};
  r.rows.forEach(row => {
    if (!grouped[row.product_id]) {
      grouped[row.product_id] = {
        product_id: row.product_id, code: row.code, name: row.name,
        unit: row.unit, is_egg: row.is_egg,
        stock_qty: parseInt(row.stock_qty||0),
        prices: [], is_bundle: false
      };
    }
    if (row.qty && row.price) {
      grouped[row.product_id].prices.push({ qty: parseInt(row.qty), price: parseFloat(row.price) });
    }
  });
  
  // เพิ่ม bundles
  const bundles = await pool.query(`
    SELECT pb.*, p.name AS product_name, p.code, p.is_egg,
      COALESCE(s.qty_unit,0) AS stock_qty
    FROM product_bundles pb
    JOIN products p ON pb.product_id=p.id
    LEFT JOIN stock s ON s.product_id=p.id AND s.branch_id=$1
    WHERE pb.active=true AND (pb.branch_id=$1 OR pb.branch_id IS NULL)
      AND (pb.customer_type=$2 OR pb.customer_type='all')
    ORDER BY pb.name
  `, [branch_id, customer_type]);
  
  const result = Object.values(grouped);
  bundles.rows.forEach(b => {
    result.push({
      product_id: b.product_id, code: b.code,
      name: b.name + ' (ชุด '+b.qty_per_bundle+'ฟ.)',
      unit: 'ชุด', is_egg: b.is_egg,
      stock_qty: Math.floor(parseInt(b.stock_qty)/b.qty_per_bundle),
      prices: [{ qty: b.qty_per_bundle, price: parseFloat(b.price) }],
      is_bundle: true, bundle_id: b.id, qty_per_bundle: b.qty_per_bundle
    });
  });
  
  res.json(result);
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
  const { items } = req.body;
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
      if (!it) continue;
      const itemTotal = cost * it.qty_unit;
      totalCost += itemTotal;
      await client.query('UPDATE stock_receipt_items SET unit_cost=$1 WHERE id=$2', [cost, item.id]).catch(()=>{});
      // upsert stock — ไม่ใช้ ON CONFLICT ที่อาจ fail ถ้าไม่มี constraint
      const existing = await client.query('SELECT id,qty_unit FROM stock WHERE product_id=$1 AND branch_id=$2', [it.product_id, rec.branch_id]);
      if (existing.rows.length) {
        await client.query('UPDATE stock SET qty_unit=qty_unit+$1,updated_at=NOW() WHERE product_id=$2 AND branch_id=$3', [it.qty_unit, it.product_id, rec.branch_id]);
      } else {
        await client.query('INSERT INTO stock (product_id,branch_id,qty_unit) VALUES ($1,$2,$3)', [it.product_id, rec.branch_id, it.qty_unit]);
      }
      // log movement
      await client.query('INSERT INTO stock_movements (product_id,branch_id,movement_type,qty_unit,ref_doc,note) VALUES ($1,$2,$3,$4,$5,$6)',
        [it.product_id, rec.branch_id, 'in', it.qty_unit, grDocNo, rec.supplier_name||'รับสินค้า']).catch(()=>{});
    }
    await client.query("UPDATE stock_receipts SET status='approved',doc_no=$1,total_cost=$2 WHERE id=$3", [grDocNo, totalCost, req.params.id]);
    await client.query('COMMIT');
    res.json({ message: 'อนุมัติใบรับสินค้าเรียบร้อย', doc_no: grDocNo });
  } catch(e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: e.message }); } finally { client.release(); }
});

app.post('/api/stock/receipts/:id/photo', auth, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'กรุณาเลือกรูป' });
  await pool.query('UPDATE stock_receipts SET photo_url=$1 WHERE id=$2', ['/uploads/'+req.file.filename, req.params.id]);
  res.json({ message: 'อัพโหลดรูปเรียบร้อย', url: '/uploads/'+req.file.filename });
});

app.post('/api/stock/transfer', auth, role('owner','admin','manager','stock'), async (req, res) => {
  const { from_branch_id, to_branch_id, items, note,
          product_id, qty_unit } = req.body;
  if (!from_branch_id || !to_branch_id) return res.status(400).json({ error: 'กรุณาระบุสาขา' });

  const transferItems = items && items.length ? items : (product_id ? [{ product_id, qty_unit }] : []);
  if (!transferItems.length) return res.status(400).json({ error: 'กรุณาเพิ่มสินค้า' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fromBr = await client.query('SELECT code FROM branches WHERE id=$1', [from_branch_id]);
    const bCode = fromBr.rows[0]?.code||'';
    const docNo = 'TRF-'+bCode+'-'+Date.now().toString().slice(-6);

    // สร้าง transfer record
    const trR = await client.query(
      "INSERT INTO stock_transfers (doc_no,from_branch_id,to_branch_id,note,status,created_by) VALUES ($1,$2,$3,$4,'pending',$5) RETURNING id",
      [docNo, from_branch_id, to_branch_id, note||null, req.user.id]
    );
    const trId = trR.rows[0].id;

    // ตัดสต๊อกจากต้นทางทันที + บันทึก items
    for (const item of transferItems) {
      const { product_id: pid, qty_unit: qty } = item;
      if (!pid || !qty) continue;
      // ตรวจสต๊อกต้นทาง
      const stk = await client.query('SELECT qty_unit FROM stock WHERE product_id=$1 AND branch_id=$2', [pid, from_branch_id]);
      const cur = parseInt(stk.rows[0]?.qty_unit||0);
      if (cur < qty) {
        const prodR = await client.query('SELECT name FROM products WHERE id=$1', [pid]);
        throw new Error('สต๊อก "'+prodR.rows[0]?.name+'" ไม่พอ (มี '+cur+' ฟอง)');
      }
      // ตัดจากต้นทาง
      await client.query('UPDATE stock SET qty_unit=qty_unit-$1,updated_at=NOW() WHERE product_id=$2 AND branch_id=$3', [qty, pid, from_branch_id]);
      // บันทึก item
      await client.query('INSERT INTO stock_transfer_items (transfer_id,product_id,qty_unit) VALUES ($1,$2,$3)', [trId, pid, qty]).catch(()=>{});
    }
    await client.query('COMMIT');
    res.json({ message: 'ส่งออกสินค้าเรียบร้อย รอปลายทางกดรับสินค้า', doc_no: docNo, id: trId });
  } catch(e) { await client.query('ROLLBACK'); res.status(400).json({ error: e.message }); }
  finally { client.release(); }
});

// ปลายทางกดยืนยันรับสินค้า
app.post('/api/stock/transfer/:id/confirm', auth, role('owner','admin','manager','stock'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tr = await client.query("SELECT * FROM stock_transfers WHERE id=$1 AND status='pending'", [req.params.id]);
    if (!tr.rows.length) return res.status(404).json({ error: 'ไม่พบเอกสารหรือยืนยันแล้ว' });
    const trData = tr.rows[0];
    // ตรวจสิทธิ์สาขา — ต้องเป็นสาขาปลายทาง
    if (req.user.branch_id && req.user.branch_id !== trData.to_branch_id &&
        !['owner','admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'ไม่มีสิทธิ์รับสินค้าสาขาอื่น' });
    }
    const items = await client.query('SELECT * FROM stock_transfer_items WHERE transfer_id=$1', [req.params.id]);
    for (const item of items.rows) {
      const ex = await client.query('SELECT id FROM stock WHERE product_id=$1 AND branch_id=$2', [item.product_id, trData.to_branch_id]);
      if (ex.rows.length) {
        await client.query('UPDATE stock SET qty_unit=qty_unit+$1,updated_at=NOW() WHERE product_id=$2 AND branch_id=$3', [item.qty_unit, item.product_id, trData.to_branch_id]);
      } else {
        await client.query('INSERT INTO stock (product_id,branch_id,qty_unit) VALUES ($1,$2,$3)', [item.product_id, trData.to_branch_id, item.qty_unit]);
      }
    }
    await client.query("UPDATE stock_transfers SET status='confirmed',confirmed_by=$1,confirmed_at=NOW() WHERE id=$2", [req.user.id, req.params.id]);
    await client.query('COMMIT');
    res.json({ message: 'รับสินค้าเรียบร้อย สต๊อกปลายทางอัพเดทแล้ว' });
  } catch(e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// ดูประวัติโอนย้าย (รอรับ + รับแล้ว)
app.get('/api/stock/transfers', auth, async (req, res) => {
  const { branch_id, status } = req.query;
  let q = `SELECT st.*,
    fb.name AS from_branch_name, fb.code AS from_branch_code,
    tb.name AS to_branch_name, tb.code AS to_branch_code,
    u.full_name AS created_by_name
    FROM stock_transfers st
    JOIN branches fb ON st.from_branch_id=fb.id
    JOIN branches tb ON st.to_branch_id=tb.id
    LEFT JOIN users u ON st.created_by=u.id
    WHERE 1=1`;
  const params = [];
  if (branch_id) { params.push(branch_id); q += ' AND (st.from_branch_id=$'+params.length+' OR st.to_branch_id=$'+params.length+')'; }
  if (status) { params.push(status); q += ' AND st.status=$'+params.length; }
  q += ' ORDER BY st.created_at DESC LIMIT 100';
  const r = await pool.query(q, params);
  res.json(r.rows);
});

app.get('/api/stock/transfers/:id/items', auth, async (req, res) => {
  const r = await pool.query('SELECT sti.*,p.name AS product_name,p.code FROM stock_transfer_items sti JOIN products p ON sti.product_id=p.id WHERE sti.transfer_id=$1', [req.params.id]);
  res.json(r.rows);
});

// CONTACTS
app.get('/api/contacts', auth, async (req, res) => {
  const { type } = req.query;
  try {
    let q = 'SELECT * FROM contacts WHERE 1=1';
    if (type === 'customer') q += ' AND is_customer=true';
    else if (type === 'supplier') q += ' AND is_supplier=true';
    q += ' ORDER BY COALESCE(business_name,contact_name)';
    const r = await pool.query(q);
    res.json(r.rows);
  } catch(e) { console.error('contacts:', e.message); res.json([]); }
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
  const r = await pool.query(`SELECT i.*,c.contact_name,c.business_name,c.address AS contact_address,c.tax_id AS contact_tax_id,b.code AS branch_code,u.full_name AS created_by_name FROM invoices i LEFT JOIN contacts c ON i.contact_id=c.id JOIN branches b ON i.branch_id=b.id LEFT JOIN users u ON i.created_by=u.id ORDER BY i.created_at DESC`);
  res.json(r.rows);
});
app.post('/api/invoices/manual', auth, role('owner','admin','manager'), async (req, res) => {
  const { contact_id, branch_id, items, discount, due_date, note } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const docNo = await genDocNo('invoice', '');
    // คำนวณยอด
    let subtotal = 0;
    (items||[]).forEach(it => subtotal += parseFloat(it.qty||1) * parseFloat(it.unit_price||0));
    const discAmt = parseFloat(discount||0);
    const total = subtotal - discAmt;
    const r = await client.query(`INSERT INTO invoices (invoice_no,contact_id,branch_id,due_date,total,note,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [docNo, contact_id||null, branch_id, due_date||null, total, note||null, req.user.id]);
    const invId = r.rows[0].id;
    // ตัดสต๊อกสินค้าที่เป็น egg ตามหน่วย
    for (const item of (items||[])) {
      if (!item.product_id) continue;
      // แปลงหน่วย: ฟอง=1, แผง(30ฟ.)=30, ลัง(300ฟ.)=300
      const mult = (item.unit||'').includes('แผง') ? 30
                 : (item.unit||'').includes('ลัง') ? 300
                 : 1;
      const qtyEggs = parseFloat(item.qty||1) * mult;
      // ตัดสต๊อก
      await client.query(
        `UPDATE stock SET qty_unit=qty_unit-$1,updated_at=NOW() WHERE product_id=$2 AND branch_id=$3`,
        [qtyEggs, item.product_id, parseInt(branch_id)]
      );
      // บันทึก movement
      await client.query(
        `INSERT INTO stock_movements (product_id,branch_id,movement_type,qty_unit,ref_doc,note)
         VALUES ($1,$2,'out',$3,$4,$5)`,
        [item.product_id, parseInt(branch_id), qtyEggs, docNo, `ใบแจ้งหนี้ ${item.description||''}`]
      ).catch(()=>{});
    }
    await client.query('COMMIT');
    res.status(201).json({ message:'สร้างใบแจ้งหนี้เรียบร้อย', invoice_no:docNo, id:invId });
  } catch(e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error:'เกิดข้อผิดพลาด' }); }
  finally { client.release(); }
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
  const { full_name, nickname, phone, branch_id, position, start_date, salary,
          create_user, username, password, role_name, branch_access } = req.body;
  if (!full_name) return res.status(400).json({ error: 'กรุณากรอกชื่อ' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const code = 'EMP' + Date.now().toString().slice(-5);
    const emp = await client.query(`INSERT INTO employees (code,full_name,nickname,phone,branch_id,position,start_date,salary) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [code, full_name, nickname, phone, branch_id||null, position, start_date||null, salary||null]);
    const empId = emp.rows[0].id;
    let userId = null;
    // สร้าง user account ถ้าต้องการ
    if (create_user && username && password) {
      const hash = await bcrypt.hash(password, 10);
      const roleR = await client.query('SELECT id FROM roles WHERE name=$1', [role_name||'cashier']);
      const roleId = roleR.rows[0]?.id || 4;
      const userR = await client.query('INSERT INTO users (username,password_hash,full_name,role_id,branch_id,phone) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [username, hash, full_name, roleId, branch_id||null, phone||null]);
      userId = userR.rows[0].id;
      // สิทธิ์สาขา
      for (const bid of (branch_access||[])) {
        await client.query('INSERT INTO user_branch_access (user_id,branch_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, bid]);
      }
    }
    await client.query('COMMIT');
    res.status(201).json({ message: 'เพิ่มพนักงานเรียบร้อย', employee: emp.rows[0], user_id: userId });
  } catch(e) {
    await client.query('ROLLBACK');
    if (e.code==='23505') return res.status(409).json({ error: 'username นี้มีอยู่แล้ว' });
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  } finally { client.release(); }
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

// ============================================================
// PRODUCT BUNDLES API
// ============================================================
app.get('/api/bundles', auth, async (req, res) => {
  const { branch_id } = req.query;
  let q = `SELECT pb.*,p.name AS product_name,p.code AS product_code,b.code AS branch_code
    FROM product_bundles pb JOIN products p ON pb.product_id=p.id
    LEFT JOIN branches b ON pb.branch_id=b.id WHERE pb.active=true`;
  const params = [];
  if (branch_id) { params.push(branch_id); q += ` AND (pb.branch_id=$${params.length} OR pb.branch_id IS NULL)`; }
  q += ' ORDER BY pb.name';
  const r = await pool.query(q, params);
  res.json(r.rows);
});

app.post('/api/bundles', auth, role('owner','admin','manager'), async (req, res) => {
  const { name, branch_id, product_id, qty_per_bundle, price, customer_type } = req.body;
  if (!name||!product_id||!qty_per_bundle||!price) return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });
  const r = await pool.query(`INSERT INTO product_bundles (name,branch_id,product_id,qty_per_bundle,price,customer_type) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [name, branch_id||null, parseInt(product_id), parseInt(qty_per_bundle), parseFloat(price), customer_type||'retail']);
  res.status(201).json({ message: 'สร้างชุดสินค้าเรียบร้อย', bundle: r.rows[0] });
});

app.put('/api/bundles/:id', auth, role('owner','admin','manager'), async (req, res) => {
  const { name, qty_per_bundle, price, customer_type, active } = req.body;
  await pool.query('UPDATE product_bundles SET name=$1,qty_per_bundle=$2,price=$3,customer_type=$4,active=$5 WHERE id=$6',
    [name, qty_per_bundle, price, customer_type, active, req.params.id]);
  res.json({ message: 'แก้ไขเรียบร้อย' });
});

app.delete('/api/bundles/:id', auth, role('owner','admin','manager'), async (req, res) => {
  await pool.query('UPDATE product_bundles SET active=false WHERE id=$1', [req.params.id]);
  res.json({ message: 'ลบเรียบร้อย' });
});

// ============================================================
// EXPENSE DOCS API
// ============================================================
app.get('/api/expense-docs', auth, async (req, res) => {
  const r = await pool.query(`SELECT ed.*,b.code AS branch_code,c.business_name,c.contact_name AS ct_name
    FROM expense_docs ed JOIN branches b ON ed.branch_id=b.id
    LEFT JOIN contacts c ON ed.contact_id=c.id
    ORDER BY ed.created_at DESC`);
  res.json(r.rows);
});

app.get('/api/expense-docs/:id', auth, async (req, res) => {
  const doc = await pool.query(`SELECT ed.*,b.code AS branch_code FROM expense_docs ed JOIN branches b ON ed.branch_id=b.id WHERE ed.id=$1`,[req.params.id]);
  const items = await pool.query('SELECT * FROM expense_doc_items WHERE doc_id=$1 ORDER BY item_no',[req.params.id]);
  if (!doc.rows[0]) return res.status(404).json({error:'ไม่พบเอกสาร'});
  res.json({...doc.rows[0], items: items.rows});
});

app.post('/api/expense-docs', auth, async (req, res) => {
  const { branch_id, contact_id, contact_name, contact_address, contact_tax_id, doc_date, due_date, credit_days, items, discount_pct, vat_pct, withholding_tax, ref_no, note, internal_note } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const branchR = await client.query('SELECT code FROM branches WHERE id=$1',[branch_id]);
    const docNo = await genDocNo('expense_doc', branchR.rows[0]?.code||'');
    let subtotal = 0;
    (items||[]).forEach(i => subtotal += parseFloat(i.qty||1) * parseFloat(i.unit_price||0));
    const discAmt = subtotal * (parseFloat(discount_pct)||0) / 100;
    const afterDisc = subtotal - discAmt;
    const vatAmt = afterDisc * (parseFloat(vat_pct)||0) / 100;
    const wht = parseFloat(withholding_tax)||0;
    const total = afterDisc + vatAmt - wht;
    const r = await client.query(`INSERT INTO expense_docs
      (doc_no,branch_id,contact_id,contact_name,contact_address,contact_tax_id,doc_date,due_date,credit_days,subtotal,discount_pct,discount_amt,after_discount,vat_pct,vat_amt,withholding_tax,total,ref_no,note,internal_note,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`,
      [docNo,branch_id,contact_id||null,contact_name||null,contact_address||null,contact_tax_id||null,
       doc_date||new Date().toISOString().slice(0,10),due_date||null,credit_days||0,
       subtotal,discount_pct||0,discAmt,afterDisc,vat_pct||0,vatAmt,wht,total,
       ref_no||null,note||null,internal_note||null,req.user.id]);
    const docId = r.rows[0].id;
    for (let i=0; i<(items||[]).length; i++) {
      const item = items[i];
      const st = parseFloat(item.qty||1)*parseFloat(item.unit_price||0);
      await client.query('INSERT INTO expense_doc_items (doc_id,item_no,description,product_id,qty,unit,unit_price,subtotal) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [docId,i+1,item.description,item.product_id||null,item.qty||1,item.unit||'',item.unit_price||0,st]);
    }
    await client.query('COMMIT');
    res.status(201).json({message:'สร้างเอกสารเรียบร้อย',doc_no:docNo,id:docId});
  } catch(e){await client.query('ROLLBACK');console.error(e);res.status(500).json({error:'เกิดข้อผิดพลาด'});}
  finally{client.release();}
});

app.post('/api/expense-docs/:id/attachment', auth, upload.single('file'), async (req,res) => {
  if (!req.file) return res.status(400).json({error:'กรุณาเลือกไฟล์'});
  await pool.query('UPDATE expense_docs SET attachment_url=$1 WHERE id=$2',['/uploads/'+req.file.filename,req.params.id]);
  res.json({message:'อัพโหลดเรียบร้อย',url:'/uploads/'+req.file.filename});
});

// ============================================================
// PAYROLL API
// ============================================================
app.get('/api/payroll', auth, role('owner','admin'), async (req, res) => {
  const r = await pool.query(`SELECT pp.*,u.full_name AS created_by_name,
    (SELECT COUNT(*) FROM payroll_items WHERE period_id=pp.id) AS emp_count,
    (SELECT COALESCE(SUM(net_pay),0) FROM payroll_items WHERE period_id=pp.id) AS total_net
    FROM payroll_periods pp LEFT JOIN users u ON pp.created_by=u.id
    ORDER BY pp.created_at DESC`);
  res.json(r.rows);
});

app.post('/api/payroll', auth, role('owner','admin'), async (req, res) => {
  const { name, period_from, period_to, payment_date } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pp = await client.query(`INSERT INTO payroll_periods (name,period_from,period_to,payment_date,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [name, period_from, period_to, payment_date||null, req.user.id]);
    const periodId = pp.rows[0].id;
    // ดึงพนักงาน active ทั้งหมด + เพิ่มเข้า payroll
    const emps = await client.query(`SELECT * FROM employees WHERE active=true`);
    for (const e of emps.rows) {
      const base = parseFloat(e.salary)||0;
      const ss = Math.min(base*0.05, 750); // ประกันสังคม 5% ไม่เกิน 750
      await client.query(`INSERT INTO payroll_items (period_id,employee_id,base_salary,social_security,total_income,total_deduct,net_pay)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [periodId, e.id, base, ss, base, ss, base-ss]);
    }
    await client.query('COMMIT');
    res.status(201).json({message:'สร้าง Payroll เรียบร้อย', id: periodId, emp_count: emps.rows.length});
  } catch(e){await client.query('ROLLBACK');console.error(e);res.status(500).json({error:'เกิดข้อผิดพลาด'});}
  finally{client.release();}
});

app.get('/api/payroll/:id/items', auth, role('owner','admin'), async (req, res) => {
  const r = await pool.query(`SELECT pi.*,e.full_name,e.nickname,e.code AS emp_code,e.position,e.bank_name,e.bank_account
    FROM payroll_items pi JOIN employees e ON pi.employee_id=e.id
    WHERE pi.period_id=$1 ORDER BY e.full_name`, [req.params.id]);
  res.json(r.rows);
});

app.put('/api/payroll/:periodId/items/:itemId', auth, role('owner','admin'), async (req, res) => {
  const { overtime, bonus, commission, allowance, other_income, withholding_tax, student_loan, absent_deduct, other_deduct, deposit, note } = req.body;
  const item = await pool.query('SELECT * FROM payroll_items WHERE id=$1', [req.params.itemId]);
  const it = item.rows[0];
  const totalIncome = parseFloat(it.base_salary)+parseFloat(overtime||0)+parseFloat(bonus||0)+parseFloat(commission||0)+parseFloat(allowance||0)+parseFloat(other_income||0);
  const totalDeduct = parseFloat(it.social_security)+parseFloat(withholding_tax||0)+parseFloat(student_loan||0)+parseFloat(absent_deduct||0)+parseFloat(other_deduct||0)+parseFloat(deposit||0);
  const netPay = totalIncome - totalDeduct;
  await pool.query(`UPDATE payroll_items SET overtime=$1,bonus=$2,commission=$3,allowance=$4,other_income=$5,withholding_tax=$6,student_loan=$7,absent_deduct=$8,other_deduct=$9,deposit=$10,note=$11,total_income=$12,total_deduct=$13,net_pay=$14 WHERE id=$15`,
    [overtime||0,bonus||0,commission||0,allowance||0,other_income||0,withholding_tax||0,student_loan||0,absent_deduct||0,other_deduct||0,deposit||0,note,totalIncome,totalDeduct,netPay,req.params.itemId]);
  res.json({message:'อัพเดทเรียบร้อย',net_pay:netPay});
});

app.post('/api/payroll/:id/approve', auth, role('owner','admin'), async (req, res) => {
  await pool.query(`UPDATE payroll_periods SET status='approved' WHERE id=$1`, [req.params.id]);
  await pool.query(`UPDATE payroll_items SET status='approved' WHERE period_id=$1`, [req.params.id]);
  res.json({message:'อนุมัติ Payroll เรียบร้อย'});
});

// ============================================================
// DAMAGED EGGS API
// ============================================================
app.get('/api/damaged-eggs', auth, async (req, res) => {
  const { branch_id, date } = req.query;
  let q = `SELECT de.*,b.code AS branch_code,u.full_name AS created_by_name
    FROM damaged_eggs de JOIN branches b ON de.branch_id=b.id
    LEFT JOIN users u ON de.created_by=u.id WHERE 1=1`;
  const params = [];
  if (branch_id) { params.push(branch_id); q += ` AND de.branch_id=$${params.length}`; }
  if (date) { params.push(date); q += ` AND de.damage_date=$${params.length}`; }
  q += ' ORDER BY de.created_at DESC';
  const r = await pool.query(q, params);
  res.json(r.rows);
});

app.post('/api/damaged-eggs', auth, upload.single('photo'), async (req, res) => {
  const { branch_id, damage_date, product_id, product_name, qty, note } = req.body;
  const photo_url = req.file ? '/uploads/'+req.file.filename : null;
  if (!branch_id || !qty) return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });
  try {
    const r = await pool.query(`INSERT INTO damaged_eggs (branch_id,damage_date,product_id,product_name,qty,note,photo_url,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [branch_id, damage_date||new Date().toISOString().slice(0,10),
       product_id||null, product_name||null, parseInt(qty), note||null, photo_url, req.user.id]);
    res.status(201).json({ message: 'บันทึกไข่บุบเรียบร้อย', record: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/damaged-eggs/:id', auth, async (req, res) => {
  await pool.query('DELETE FROM damaged_eggs WHERE id=$1', [req.params.id]);
  res.json({ message: 'ลบเรียบร้อย' });
});

// ============================================================
// DAILY ATTACHMENTS API (เอกสารแนบรายวัน)
// ============================================================
app.get('/api/daily-attachments', auth, async (req, res) => {
  const { branch_id, date } = req.query;
  let q = `SELECT da.*,b.code AS branch_code,u.full_name AS uploaded_by_name
    FROM daily_attachments da JOIN branches b ON da.branch_id=b.id
    LEFT JOIN users u ON da.uploaded_by=u.id WHERE 1=1`;
  const params = [];
  if (branch_id) { params.push(branch_id); q += ` AND da.branch_id=$${params.length}`; }
  if (date) { params.push(date); q += ` AND da.attach_date=$${params.length}`; }
  q += ' ORDER BY da.created_at DESC';
  const r = await pool.query(q, params);
  res.json(r.rows);
});

// Upload จาก desktop/mobile (ต้องมี token)
app.post('/api/daily-attachments', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'กรุณาเลือกไฟล์' });
  const { branch_id, attach_date, doc_type, note } = req.body;
  const ext = req.file.originalname.split('.').pop().toLowerCase();
  const file_type = ['pdf'].includes(ext) ? 'pdf' : 'image';
  try {
    const r = await pool.query(`INSERT INTO daily_attachments (branch_id,attach_date,file_url,file_type,doc_type,note,uploaded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [branch_id, attach_date||new Date().toISOString().slice(0,10),
       '/uploads/'+req.file.filename, file_type,
       doc_type||'other', note||null, req.user.id]);
    res.status(201).json({ message: 'อัพโหลดเรียบร้อย', attachment: r.rows[0], url: '/uploads/'+req.file.filename });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUBLIC upload สำหรับ QR scan (ไม่ต้อง login แต่ต้องมี token พิเศษ)
app.post('/api/daily-attachments/qr-upload', upload.single('file'), async (req, res) => {
  const { qr_token, branch_id, attach_date, doc_type, note } = req.body;
  // verify QR token (format: branchId_date_secret)
  const expectedToken = Buffer.from(`${branch_id}_${attach_date}_${process.env.JWT_SECRET}`).toString('base64').slice(0,16);
  if (qr_token !== expectedToken) return res.status(403).json({ error: 'QR Token ไม่ถูกต้องหรือหมดอายุ' });
  if (!req.file) return res.status(400).json({ error: 'กรุณาเลือกไฟล์' });
  const ext = req.file.originalname.split('.').pop().toLowerCase();
  const file_type = ['pdf'].includes(ext) ? 'pdf' : 'image';
  try {
    const r = await pool.query(`INSERT INTO daily_attachments (branch_id,attach_date,file_url,file_type,doc_type,note)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [branch_id, attach_date, '/uploads/'+req.file.filename, file_type, doc_type||'other', note||null]);
    res.status(201).json({ message: 'อัพโหลดเรียบร้อย', url: '/uploads/'+req.file.filename });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// สร้าง QR token
app.get('/api/daily-attachments/qr-token', auth, (req, res) => {
  const { branch_id, date } = req.query;
  const token = Buffer.from(`${branch_id}_${date}_${process.env.JWT_SECRET}`).toString('base64').slice(0,16);
  const baseUrl = process.env.APP_URL || req.protocol+'://'+req.get('host');
  const uploadUrl = `${baseUrl}/upload-qr?branch_id=${branch_id}&date=${date}&token=${token}`;
  res.json({ token, upload_url: uploadUrl });
});

app.delete('/api/daily-attachments/:id', auth, async (req, res) => {
  await pool.query('DELETE FROM daily_attachments WHERE id=$1', [req.params.id]);
  res.json({ message: 'ลบเรียบร้อย' });
});

// ============================================================
// PUBLIC QR Upload Page (สำหรับมือถือสแกน QR)
// ============================================================
app.get('/upload-qr', (req, res) => {
  const { branch_id, date, token } = req.query;
  const branchId = branch_id || '';
  const uploadDate = date || new Date().toISOString().slice(0,10);
  res.send(`<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<title>📎 แนบเอกสาร - Egg Station</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Sarabun',sans-serif;background:#f4f6f9;color:#1f2937;font-size:16px;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:14px;padding:24px;width:100%;max-width:400px;box-shadow:0 4px 20px rgba(0,0,0,.1)}
.header{text-align:center;margin-bottom:24px}
.header .icon{font-size:48px;display:block;margin-bottom:8px}
.header h1{font-size:20px;font-weight:700;color:#e67e00}
.header p{font-size:13px;color:#6b7280;margin-top:4px}
.info-box{background:#fff3e0;border:1px solid #fed7aa;border-radius:8px;padding:12px;margin-bottom:20px;font-size:13px}
.info-box strong{color:#e67e00}
.form-group{margin-bottom:16px}
label{display:block;font-size:13px;font-weight:600;color:#6b7280;margin-bottom:6px}
select,input[type="text"],textarea{width:100%;border:1.5px solid #d1d5db;border-radius:8px;padding:10px 13px;font-family:'Sarabun',sans-serif;font-size:15px;outline:none;color:#1f2937}
select:focus,input:focus,textarea:focus{border-color:#e67e00}
.upload-area{border:2px dashed #d1d5db;border-radius:10px;padding:30px 20px;text-align:center;cursor:pointer;transition:all .2s;background:#f9fafb}
.upload-area:hover,.upload-area.drag{border-color:#e67e00;background:#fff3e0}
.upload-area input{display:none}
.upload-area .icon{font-size:40px;margin-bottom:8px}
.upload-area p{font-size:14px;color:#6b7280}
.upload-area .hint{font-size:12px;color:#9ca3af;margin-top:4px}
.preview{margin-top:12px;display:flex;flex-wrap:wrap;gap:8px}
.preview img{width:80px;height:80px;object-fit:cover;border-radius:6px;border:1px solid #d1d5db}
.preview .pdf-icon{width:80px;height:80px;background:#eff6ff;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:28px;border:1px solid #bfdbfe}
.btn{width:100%;padding:14px;background:#e67e00;color:#fff;border:none;border-radius:8px;font-family:'Sarabun',sans-serif;font-size:16px;font-weight:700;cursor:pointer;margin-top:8px}
.btn:disabled{opacity:.6;cursor:not-allowed}
.btn-secondary{background:#f0f2f5;color:#1f2937;margin-top:6px}
.result{margin-top:16px;padding:14px;border-radius:8px;font-size:14px;text-align:center;display:none}
.result.success{background:#f0fdf4;color:#16a34a;border:1px solid #86efac}
.result.error{background:#fef2f2;color:#dc2626;border:1px solid #fca5a5}
.progress{background:#e5e7eb;border-radius:4px;height:6px;margin-top:10px;overflow:hidden;display:none}
.progress-bar{height:100%;background:#e67e00;border-radius:4px;transition:width .3s}
</style>
</head>
<body>
<div class="card">
  <div class="header">
    <span class="icon">📎</span>
    <h1>แนบเอกสาร</h1>
    <p>Egg Station - อัพโหลดเอกสารจากมือถือ</p>
  </div>
  <div class="info-box">
    <strong>📅 วันที่:</strong> ${uploadDate}<br>
    <strong>🏪 สาขา:</strong> รหัส ${branchId}
  </div>
  <div class="form-group">
    <label>ประเภทเอกสาร</label>
    <select id="docType">
      <option value="delivery_bill">บิลส่งไข่ / ใบส่งของ</option>
      <option value="receipt_bill">ใบรับสินค้า / บิลซื้อ</option>
      <option value="damaged_egg">รูปไข่บุบ / เสียหาย</option>
      <option value="daily_report">รายงานประจำวัน</option>
      <option value="other">อื่นๆ</option>
    </select>
  </div>
  <div class="form-group">
    <label>หมายเหตุ (ถ้ามี)</label>
    <input type="text" id="noteInput" placeholder="เช่น บิลเบอร์ 123 จากฟาร์มA">
  </div>
  <div class="form-group">
    <label>เลือกรูป/เอกสาร (เลือกได้หลายไฟล์)</label>
    <div class="upload-area" onclick="document.getElementById('fileInput').click()" id="dropArea">
      <div class="icon">📷</div>
      <p>กดเพื่อถ่ายรูปหรือเลือกไฟล์</p>
      <div class="hint">รองรับ JPG, PNG, PDF ขนาดไม่เกิน 10MB/ไฟล์</div>
      <input type="file" id="fileInput" multiple accept="image/*,.pdf" capture="environment" onchange="handleFiles(this.files)">
    </div>
    <div class="preview" id="preview"></div>
  </div>
  <div class="progress" id="progress"><div class="progress-bar" id="progressBar" style="width:0%"></div></div>
  <button class="btn" id="uploadBtn" onclick="doUpload()" disabled>📤 อัพโหลด</button>
  <div class="result" id="result"></div>
</div>

<script>
const TOKEN = '${token}';
const BRANCH_ID = '${branchId}';
const DATE = '${uploadDate}';
let selectedFiles = [];

function handleFiles(files) {
  selectedFiles = Array.from(files);
  const preview = document.getElementById('preview');
  preview.innerHTML = '';
  selectedFiles.forEach(f => {
    if (f.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = e => { preview.innerHTML += '<img src="'+e.target.result+'">'; };
      reader.readAsDataURL(f);
    } else {
      preview.innerHTML += '<div class="pdf-icon">📄</div>';
    }
  });
  document.getElementById('uploadBtn').disabled = selectedFiles.length === 0;
}

// Drag & Drop
const dropArea = document.getElementById('dropArea');
['dragenter','dragover'].forEach(e => dropArea.addEventListener(e, ev => { ev.preventDefault(); dropArea.classList.add('drag'); }));
['dragleave','drop'].forEach(e => dropArea.addEventListener(e, ev => { ev.preventDefault(); dropArea.classList.remove('drag'); if(ev.dataTransfer?.files) handleFiles(ev.dataTransfer.files); }));

async function doUpload() {
  const btn = document.getElementById('uploadBtn');
  const result = document.getElementById('result');
  const progress = document.getElementById('progress');
  const bar = document.getElementById('progressBar');
  if (!selectedFiles.length) return;

  btn.disabled = true;
  btn.textContent = 'กำลังอัพโหลด...';
  progress.style.display = 'block';
  result.style.display = 'none';

  const docType = document.getElementById('docType').value;
  const note = document.getElementById('noteInput').value;
  let uploaded = 0, failed = 0;

  for (let i = 0; i < selectedFiles.length; i++) {
    const fd = new FormData();
    fd.append('file', selectedFiles[i]);
    fd.append('qr_token', TOKEN);
    fd.append('branch_id', BRANCH_ID);
    fd.append('attach_date', DATE);
    fd.append('doc_type', docType);
    fd.append('note', note);
    try {
      const res = await fetch('/api/daily-attachments/qr-upload', { method:'POST', body:fd });
      const data = await res.json();
      if (res.ok) uploaded++;
      else failed++;
    } catch(e) { failed++; }
    bar.style.width = ((i+1)/selectedFiles.length*100)+'%';
  }

  btn.disabled = false;
  btn.textContent = '📤 อัพโหลด';
  result.style.display = 'block';
  if (uploaded > 0 && failed === 0) {
    result.className = 'result success';
    result.innerHTML = '✅ อัพโหลดสำเร็จ '+uploaded+' ไฟล์<br><small>เอกสารถูกบันทึกเข้าระบบแล้ว</small>';
    selectedFiles = [];
    document.getElementById('preview').innerHTML = '';
    document.getElementById('fileInput').value = '';
    document.getElementById('uploadBtn').disabled = true;
  } else {
    result.className = 'result error';
    result.innerHTML = '❌ สำเร็จ '+uploaded+' ไฟล์ / ล้มเหลว '+failed+' ไฟล์';
  }
}
</script>
</body>
</html>`);
});

// ============================================================
// DAILY CLOSE API
// ============================================================
app.get('/api/daily-close/prepare', auth, async (req, res) => {
  // ดึงข้อมูลสำหรับเตรียมปิดยอดวันนี้
  const { branch_id, date } = req.query;
  const closeDate = date || new Date().toISOString().slice(0,10);
  const bid = parseInt(branch_id) || req.user.branch_id;
  if (!bid) return res.status(400).json({ error: 'กรุณาระบุสาขา' });

  try {
    // 1. ยอดขายวันนี้ แยกช่องทาง
    const salesR = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN pm->>'method'='cash' THEN (pm->>'amount')::numeric ELSE 0 END),0) AS cash_total,
        COALESCE(SUM(CASE WHEN pm->>'method'='transfer' THEN (pm->>'amount')::numeric ELSE 0 END),0) AS transfer_total,
        COALESCE(SUM(CASE WHEN pm->>'method' NOT IN ('cash','transfer','credit') THEN (pm->>'amount')::numeric ELSE 0 END),0) AS other_total,
        COUNT(s.id) AS bill_count,
        COALESCE(SUM(s.total),0) AS total_sales
      FROM sales s
      LEFT JOIN LATERAL jsonb_array_elements(COALESCE(s.payment_methods,'[]'::jsonb)) AS pm ON true
      WHERE s.branch_id=$1 AND s.sale_date=$2 AND s.status='completed'
    `, [bid, closeDate]);

    // 2. สต๊อกไข่ปัจจุบัน
    const stockR = await pool.query(`
      SELECT p.code, p.name, p.is_egg,
        COALESCE(s.qty_unit,0) AS qty_current,
        pc.name AS category_name
      FROM products p
      LEFT JOIN stock s ON s.product_id=p.id AND s.branch_id=$1
      LEFT JOIN product_categories pc ON p.category_id=pc.id
      WHERE p.active=true AND p.is_egg=true
      ORDER BY p.code
    `, [bid]);

    // 3. ยอดขายไข่แต่ละเบอร์วันนี้
    const eggSalesR = await pool.query(`
      SELECT p.code, p.name, COALESCE(SUM(si.qty_unit),0) AS sold_qty
      FROM sale_items si
      JOIN products p ON si.product_id=p.id
      JOIN sales s ON si.sale_id=s.id
      WHERE s.branch_id=$1 AND s.sale_date=$2 AND s.status='completed' AND p.is_egg=true
      GROUP BY p.id, p.code, p.name ORDER BY p.code
    `, [bid, closeDate]);

    // 4. รับเข้าวันนี้
    const receiveR = await pool.query(`
      SELECT p.code, COALESCE(SUM(sri.qty_unit),0) AS received_qty
      FROM stock_receipt_items sri
      JOIN products p ON sri.product_id=p.id
      JOIN stock_receipts sr ON sri.receipt_id=sr.id
      WHERE sr.branch_id=$1 AND DATE(sr.created_at)=$2 AND sr.status='approved'
      GROUP BY p.id, p.code
    `, [bid, closeDate]);

    // 5. กะปัจจุบัน (opening cash)
    const shiftR = await pool.query(`
      SELECT * FROM shifts WHERE branch_id=$1 AND (
        (status='open') OR (status='closed' AND DATE(close_time)=$2)
      ) ORDER BY open_time DESC LIMIT 1
    `, [bid, closeDate]);

    const sales = salesR.rows[0];
    const eggSalesMap = {};
    eggSalesR.rows.forEach(r => eggSalesMap[r.code] = parseInt(r.sold_qty)||0);
    const receiveMap = {};
    receiveR.rows.forEach(r => receiveMap[r.code] = parseInt(r.received_qty)||0);

    // รวม egg data
    const eggItems = stockR.rows.map(p => ({
      code: p.code,
      name: p.name,
      qty_current: parseInt(p.qty_current)||0,
      sold_today: eggSalesMap[p.code]||0,
      received_today: receiveMap[p.code]||0,
      // qty_open = qty_current + sold - received (ย้อนกลับ)
      qty_open: (parseInt(p.qty_current)||0) + (eggSalesMap[p.code]||0) - (receiveMap[p.code]||0),
    }));

    res.json({
      date: closeDate,
      branch_id: bid,
      sales: {
        bill_count: parseInt(sales.bill_count)||0,
        cash: parseFloat(sales.cash_total)||0,
        transfer: parseFloat(sales.transfer_total)||0,
        other: parseFloat(sales.other_total)||0,
        total: parseFloat(sales.total_sales)||0,
      },
      opening_cash: shiftR.rows[0] ? parseFloat(shiftR.rows[0].opening_cash)||0 : 0,
      egg_items: eggItems,
    });
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/api/daily-close', auth, async (req, res) => {
  const { branch_id, close_date, cash_system, cash_actual, transfer_system, transfer_actual, other_income, items, note, egg_variance, egg_variance_value } = req.body;
  const cash_diff = parseFloat(cash_actual||0) - parseFloat(cash_system||0);
  const transfer_diff = parseFloat(transfer_actual||0) - parseFloat(transfer_system||0);
  const total_system = parseFloat(cash_system||0) + parseFloat(transfer_system||0) + parseFloat(other_income||0);
  const total_actual = parseFloat(cash_actual||0) + parseFloat(transfer_actual||0) + parseFloat(other_income||0);
  try {
    await pool.query(`INSERT INTO daily_closes
      (branch_id,close_date,cash_system,cash_actual,cash_diff,transfer_system,transfer_actual,transfer_diff,other_income,total_system,total_actual,total_diff,egg_variance,egg_variance_value,items,note,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT (branch_id,close_date) DO UPDATE SET
        cash_system=$3,cash_actual=$4,cash_diff=$5,transfer_system=$6,transfer_actual=$7,transfer_diff=$8,
        other_income=$9,total_system=$10,total_actual=$11,total_diff=$12,egg_variance=$13,
        egg_variance_value=$14,items=$15,note=$16,created_by=$17`,
      [branch_id, close_date, cash_system||0, cash_actual||0, cash_diff,
       transfer_system||0, transfer_actual||0, transfer_diff,
       other_income||0, total_system, total_actual, total_actual-total_system,
       egg_variance||0, egg_variance_value||0,
       JSON.stringify(items||[]), note||null, req.user.id]);
    res.json({ message: 'บันทึกปิดยอดเรียบร้อย' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/daily-close/history', auth, async (req, res) => {
  const { branch_id } = req.query;
  let q = `SELECT dc.*,b.code AS branch_code,u.full_name AS created_by_name
    FROM daily_closes dc JOIN branches b ON dc.branch_id=b.id
    LEFT JOIN users u ON dc.created_by=u.id WHERE 1=1`;
  const params = [];
  if (branch_id) { params.push(branch_id); q += ` AND dc.branch_id=$${params.length}`; }
  q += ' ORDER BY dc.close_date DESC LIMIT 30';
  const r = await pool.query(q, params);
  res.json(r.rows);
});

// ============================================================
// COMPANY SETTINGS API
// ============================================================
app.get('/api/company-settings', auth, async (req, res) => {
  const r = await pool.query('SELECT * FROM company_settings LIMIT 1');
  res.json(r.rows[0] || {});
});

app.put('/api/company-settings', auth, role('owner','admin'), async (req, res) => {
  const { company_name, company_name_en, tax_id, address, phone, email, website, bank_name, bank_account, bank_account_name, invoice_note } = req.body;
  await pool.query(`UPDATE company_settings SET company_name=$1,company_name_en=$2,tax_id=$3,address=$4,phone=$5,email=$6,website=$7,bank_name=$8,bank_account=$9,bank_account_name=$10,invoice_note=$11,updated_at=NOW()`,
    [company_name, company_name_en, tax_id, address, phone, email, website, bank_name, bank_account, bank_account_name, invoice_note]);
  res.json({ message: 'บันทึกเรียบร้อย' });
});

app.post('/api/company-settings/logo', auth, role('owner','admin'), upload.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'กรุณาเลือกไฟล์' });
  await pool.query('UPDATE company_settings SET logo_url=$1', ['/uploads/'+req.file.filename]);
  res.json({ message: 'อัพโหลดโลโก้เรียบร้อย', url: '/uploads/'+req.file.filename });
});

// REPORTS
app.get('/api/reports/sales-by-product', auth, async (req, res) => {
  const { date, branch_id } = req.query;
  const d = date || new Date().toISOString().slice(0,10);
  let q = `SELECT p.name AS product_name, p.code,
    COALESCE(SUM(si.qty_unit),0) AS qty_sold,
    COALESCE(SUM(si.qty_set*si.price_per_set),0) AS revenue
    FROM sale_items si
    JOIN products p ON si.product_id=p.id
    JOIN sales s ON si.sale_id=s.id
    WHERE s.sale_date=$1 AND s.status='completed'`;
  const params = [d];
  if (branch_id) { params.push(branch_id); q += ` AND s.branch_id=$${params.length}`; }
  q += ' GROUP BY p.id, p.name, p.code ORDER BY qty_sold DESC';
  const r = await pool.query(q, params);
  res.json({ items: r.rows });
});

app.get('/api/reports/daily', auth, async (req, res) => {
  const { date, branch_id } = req.query;
  const targetDate = date || new Date().toISOString().slice(0,10);
  let branchFilter = ''; const params = [targetDate];
  if (branch_id) { params.push(branch_id); branchFilter = ` AND s.branch_id=$${params.length}`; }
  const r = await pool.query(`SELECT b.code AS branch_code,b.name AS branch_name,COUNT(s.id) AS total_bills,SUM(s.total) AS total_revenue,SUM(s.discount) AS total_discount FROM sales s JOIN branches b ON s.branch_id=b.id WHERE s.sale_date=$1 AND s.status='completed'${branchFilter} GROUP BY b.id,b.code,b.name ORDER BY b.code`, params);
  res.json({ date: targetDate, branches: r.rows });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ============================================================
// PERMISSIONS API
// ============================================================
app.get('/api/permissions/:role', auth, async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM role_permissions WHERE role_name=$1 AND granted=true", [req.params.role]);
    res.json(r.rows);
  } catch(e) { res.json([]); }
});




// IMPORT PRICES FROM CSV/JSON


// EXPORT PRICES TO CSV
app.get('/api/products/export-prices', auth, async (req, res) => {
  const r = await pool.query(`
    SELECT p.code, b.code AS branch_code, pp.customer_type, pp.qty, pp.price
    FROM product_prices pp
    JOIN products p ON pp.product_id=p.id
    JOIN branches b ON pp.branch_id=b.id
    ORDER BY p.code, b.code, pp.customer_type, pp.qty
  `);
  const csv = ['code,branch_code,customer_type,qty,price',
    ...r.rows.map(r=>`${r.code},${r.branch_code},${r.customer_type},${r.qty},${r.price}`)
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="prices.csv"');
  res.send('\uFEFF'+csv); // BOM สำหรับ Excel
});


// ============================================================
// DAILY CLOSE API
// ============================================================
app.get('/api/daily-close', auth, async (req, res) => {
  const { date, branch_id } = req.query;
  if (!date || !branch_id) return res.status(400).json({ error: 'กรุณาระบุ date และ branch_id' });
  const r = await pool.query('SELECT dc.*,b.code AS branch_code,b.name AS branch_name FROM daily_closes dc JOIN branches b ON dc.branch_id=b.id WHERE dc.date=$1 AND dc.branch_id=$2',
    [date, branch_id]);
  if (!r.rows.length) return res.status(404).json({ error: 'ยังไม่มีข้อมูล' });
  res.json(r.rows[0]);
});








// ============================================================
// MEMBER TIERS API
// ============================================================
app.get('/api/member-tiers', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM member_tiers WHERE active=true ORDER BY sort_order, id');
    res.json(r.rows);
  } catch(e) { res.json([]); }
});

app.post('/api/member-tiers', auth, role('owner','admin'), async (req, res) => {
  const { name, description, customer_type, discount_percent, discount_amount, min_eggs_required, sort_order } = req.body;
  if (!name) return res.status(400).json({ error: 'กรุณากรอกชื่อระดับสมาชิก' });
  const r = await pool.query(
    'INSERT INTO member_tiers (name,description,customer_type,discount_percent,discount_amount,min_eggs_required,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [name, description||null, customer_type||'retail', discount_percent||0, discount_amount||0, min_eggs_required||0, sort_order||0]
  );
  res.status(201).json(r.rows[0]);
});

app.put('/api/member-tiers/:id', auth, role('owner','admin'), async (req, res) => {
  const { name, description, customer_type, discount_percent, discount_amount, min_eggs_required, sort_order, active } = req.body;
  await pool.query(
    'UPDATE member_tiers SET name=$1,description=$2,customer_type=$3,discount_percent=$4,discount_amount=$5,min_eggs_required=$6,sort_order=$7,active=$8 WHERE id=$9',
    [name, description, customer_type||'retail', discount_percent||0, discount_amount||0, min_eggs_required||0, sort_order||0, active!==false, req.params.id]
  );
  res.json({ message: 'อัพเดทเรียบร้อย' });
});

app.delete('/api/member-tiers/:id', auth, role('owner','admin'), async (req, res) => {
  await pool.query('UPDATE member_tiers SET active=false WHERE id=$1', [req.params.id]);
  res.json({ message: 'ลบเรียบร้อย' });
});


// ============================================================
// MEMBER POINTS / LOYALTY
// ============================================================
// ดูยอดสะสม


// ใช้คะแนน (redeem)


// เพิ่มฟองหลังขาย (เรียกจาก completeSale)


// ดึงราคาตาม tier ของสมาชิก



// ============================================================
// PRODUCT DETAIL APIs
// ============================================================


// ปรับยอดคงคลัง


// ประวัติการเคลื่อนไหวสต๊อกแยกสินค้า


// แก้ราคาสินค้าแต่ละ SKU (upsert)


// ลบราคา SKU





// ============================================================
// PRICE QTY TIERS API
// ============================================================







initSchema().then(() => {
  const server = app.listen(PORT, () => console.log(`🥚 Egg Station running on port ${PORT}`));
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} already in use, retrying in 1s...`);
      setTimeout(() => server.listen(PORT), 1000);
    } else {
      throw err;
    }
  });
});


app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.use(express.static(__dirname));


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
// SALES BY PRODUCT REPORT
// ============================================================


// ============================================================
// STOCK RECEIPTS - รับสินค้า (Pre + Approved)
// ============================================================
app.post('/api/stock/receipts', auth, async (req, res) => {
  const { branch_id, receipt_date, supplier_name, items, note, status } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const branchR = await client.query('SELECT code FROM branches WHERE id=$1', [branch_id]);
    const bCode = branchR.rows[0]?.code||'';
    const isApproved = status === 'approved' && ['owner','admin'].includes(req.user.role);
    const docNo = isApproved
      ? await genDocNo('stock_receipt', bCode)
      : 'PRE-'+bCode+'-'+new Date().toISOString().slice(2,7).replace('-','')+'-'+String(Date.now()).slice(-4);
    
    const recv = await client.query(
      `INSERT INTO stock_receipts (doc_no,branch_id,receipt_date,supplier_name,status,note,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [docNo, branch_id, receipt_date||new Date().toISOString().slice(0,10), supplier_name||null, isApproved?'approved':'pre', note||null, req.user.id]
    );
    const recvId = recv.rows[0].id;

    for (const item of (items||[])) {
      await client.query('INSERT INTO stock_receipt_items (receipt_id,product_id,qty_unit,unit_cost) VALUES ($1,$2,$3,$4)',
        [recvId, item.product_id, item.qty_unit, item.unit_cost||null]);
      if (isApproved) {
        const _ex = await client.query('SELECT id FROM stock WHERE product_id=$1 AND branch_id=$2', [item.product_id, branch_id]);
        if (_ex.rows.length) {
          await client.query('UPDATE stock SET qty_unit=qty_unit+$1,updated_at=NOW() WHERE product_id=$2 AND branch_id=$3', [item.qty_unit, item.product_id, branch_id]);
        } else {
          await client.query('INSERT INTO stock (product_id,branch_id,qty_unit) VALUES ($1,$2,$3)', [item.product_id, branch_id, item.qty_unit]);
        }
        await client.query(
          'INSERT INTO stock_movements (product_id,branch_id,movement_type,qty_unit,ref_doc,note) VALUES ($1,$2,$3,$4,$5,$6)',
          [item.product_id, branch_id, 'in', item.qty_unit, docNo, supplier_name||'รับสินค้า']
        ).catch(()=>{});
      }
    }
    await client.query('COMMIT');
    res.status(201).json({ message: isApproved?'รับสินค้าและตัดสต๊อกเรียบร้อย':'บันทึก Pre เรียบร้อย', id: recvId, doc_no: docNo });
  } catch(e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});


// ============================================================
// PERMISSIONS API
// ============================================================





// IMPORT PRICES FROM CSV/JSON


// EXPORT PRICES TO CSV



// ============================================================
// DAILY CLOSE API
// ============================================================




app.get('/api/daily-close/:id', auth, async (req, res) => {
  const r = await pool.query('SELECT dc.*,b.code AS branch_code,b.name AS branch_name FROM daily_closes dc JOIN branches b ON dc.branch_id=b.id WHERE dc.id=$1', [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'ไม่พบข้อมูล' });
  const dc = r.rows[0];
  // ดึง snapshot หรือ realtime
  const salesR = await pool.query(`SELECT p.name AS product_name,p.is_egg,COALESCE(SUM(si.qty_unit),0) AS qty_sold,COALESCE(SUM(si.qty_set*si.price_per_set),0) AS revenue FROM sale_items si JOIN products p ON si.product_id=p.id JOIN sales s ON si.sale_id=s.id WHERE s.sale_date=$1 AND s.branch_id=$2 AND s.status='completed' GROUP BY p.id,p.name,p.is_egg ORDER BY qty_sold DESC`, [dc.date, dc.branch_id]);
  const stockR = await pool.query(`SELECT s.qty_unit,p.name AS product_name,p.is_egg FROM stock s JOIN products p ON s.product_id=p.id WHERE s.branch_id=$1 AND (p.is_egg=true OR p.track_stock=true) ORDER BY p.code`, [dc.branch_id]);
  res.json({ ...dc, sales_items: salesR.rows, stock_items: stockR.rows });
});




// ============================================================
// MEMBER TIERS API
// ============================================================









// ============================================================
// MEMBER POINTS / LOYALTY
// ============================================================
// ดูยอดสะสม
app.get('/api/members/:id/points', auth, async (req, res) => {
  try {
    const mem = await pool.query('SELECT id,name,phone,total_eggs,redeemed_eggs,tier_id FROM members WHERE id=$1', [req.params.id]);
    if (!mem.rows.length) return res.status(404).json({ error: 'ไม่พบสมาชิก' });
    const log = await pool.query('SELECT * FROM member_points_log WHERE member_id=$1 ORDER BY created_at DESC LIMIT 20', [req.params.id]);
    const tier = mem.rows[0].tier_id ?
      await pool.query('SELECT * FROM member_tiers WHERE id=$1', [mem.rows[0].tier_id]).then(r => r.rows[0]) : null;
    res.json({ member: mem.rows[0], tier, log: log.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ใช้คะแนน (redeem)
app.post('/api/members/:id/redeem', auth, async (req, res) => {
  const { eggs_to_redeem, discount_amount } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const mem = await client.query('SELECT * FROM members WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!mem.rows.length) return res.status(404).json({ error: 'ไม่พบสมาชิก' });
    const m = mem.rows[0];
    const available = (m.total_eggs||0) - (m.redeemed_eggs||0);
    if (available < eggs_to_redeem) return res.status(400).json({ error: `ฟองสะสมไม่พอ (มี ${available} ฟอง)` });
    await client.query('UPDATE members SET redeemed_eggs=redeemed_eggs+$1 WHERE id=$2', [eggs_to_redeem, req.params.id]);
    await client.query('INSERT INTO member_points_log (member_id,change_eggs,reason,created_by) VALUES ($1,$2,$3,$4)',
      [req.params.id, -eggs_to_redeem, 'แลกส่วนลด '+discount_amount+' บาท', req.user.id]);
    await client.query('COMMIT');
    res.json({ message: `แลกสำเร็จ ${eggs_to_redeem} ฟอง = ลด ${discount_amount} บาท` });
  } catch(e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// เพิ่มฟองหลังขาย (เรียกจาก completeSale)
app.post('/api/members/:id/add-eggs', auth, async (req, res) => {
  const { eggs, sale_id } = req.body;
  if (!eggs || eggs <= 0) return res.json({ ok: true });
  try {
    await pool.query('UPDATE members SET total_eggs=COALESCE(total_eggs,0)+$1 WHERE id=$2', [eggs, req.params.id]);
    await pool.query('INSERT INTO member_points_log (member_id,change_eggs,reason,sale_id,created_by) VALUES ($1,$2,$3,$4,$5)',
      [req.params.id, eggs, 'ซื้อไข่', sale_id||null, req.user.id]);
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false }); }
});

// ดึงราคาตาม tier ของสมาชิก
app.get('/api/pos/products-for-member/:member_id', auth, async (req, res) => {
  try {
    const mem = await pool.query('SELECT m.*,t.customer_type FROM members m LEFT JOIN member_tiers t ON m.tier_id=t.id WHERE m.id=$1', [req.params.member_id]);
    if (!mem.rows.length) return res.status(404).json({ error: 'ไม่พบสมาชิก' });
    const ctype = mem.rows[0].customer_type || 'retail';
    const branchId = req.query.branch_id || mem.rows[0].branch_id;
    const r = await pool.query(`
      SELECT p.id AS product_id, p.code, p.name, p.unit, p.is_egg,
        pp.qty, pp.price, COALESCE(s.qty_unit,0) AS stock_qty,
        $2 AS customer_type
      FROM products p
      LEFT JOIN product_prices pp ON pp.product_id=p.id AND pp.branch_id=$1 AND pp.customer_type=$2
      LEFT JOIN stock s ON s.product_id=p.id AND s.branch_id=$1
      WHERE p.track_stock=true OR p.is_egg=true
      ORDER BY p.is_egg DESC, p.code, pp.qty NULLS LAST`,
      [branchId, ctype]);
    const grouped = {};
    r.rows.forEach(row => {
      if (!grouped[row.product_id]) grouped[row.product_id] = { ...row, prices: [] };
      if (row.qty && row.price) grouped[row.product_id].prices.push({ qty: parseInt(row.qty), price: parseFloat(row.price) });
    });
    res.json({ customer_type: ctype, products: Object.values(grouped) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ============================================================
// PRODUCT DETAIL APIs
// ============================================================
app.get('/api/products/:id', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT p.*, pc.name AS category_name, pc.type AS category_type
      FROM products p
      LEFT JOIN product_categories pc ON p.category_id=pc.id
      WHERE p.id=$1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'ไม่พบสินค้า' });
    const prod = r.rows[0];
    // ราคาแยก branch + customer_type
    const prices = await pool.query(`
      SELECT pp.*, b.name AS branch_name, b.code AS branch_code
      FROM product_prices pp
      LEFT JOIN branches b ON pp.branch_id=b.id
      WHERE pp.product_id=$1 ORDER BY b.code, pp.customer_type, pp.qty`, [req.params.id]);
    // สต๊อกแยกสาขา
    const stocks = await pool.query(`
      SELECT s.*, b.name AS branch_name, b.code AS branch_code
      FROM stock s
      JOIN branches b ON s.branch_id=b.id
      WHERE s.product_id=$1 ORDER BY b.code`, [req.params.id]);
    res.json({ ...prod, prices: prices.rows, stocks: stocks.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ปรับยอดคงคลัง
app.post('/api/stock/adjust', auth, role('owner','admin','manager','stock'), async (req, res) => {
  const { product_id, branch_id, adjust_type, qty, reason, note } = req.body;
  if (!product_id || !branch_id || !qty) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT qty_unit FROM stock WHERE product_id=$1 AND branch_id=$2', [product_id, branch_id]);
    const before = parseInt(cur.rows[0]?.qty_unit||0);
    const change = adjust_type === 'add' ? parseInt(qty) : -parseInt(qty);
    const after = before + change;
    if (after < 0) throw new Error('สต๊อกติดลบไม่ได้ (มี '+before+' หน่วย)');
    if (cur.rows.length) {
      await client.query('UPDATE stock SET qty_unit=$1, updated_at=NOW() WHERE product_id=$2 AND branch_id=$3', [after, product_id, branch_id]);
    } else {
      await client.query('INSERT INTO stock (product_id,branch_id,qty_unit) VALUES ($1,$2,$3)', [product_id, branch_id, after]);
    }
    // log movement
    const moveType = adjust_type === 'add' ? 'adjust_in' : 'adjust_out';
    await client.query(`INSERT INTO stock_movements (product_id,branch_id,movement_type,qty_unit,ref_doc,note,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [product_id, branch_id, moveType, Math.abs(change),
       'ADJ-'+Date.now().toString().slice(-6), (reason||'')+(note?' | '+note:''), req.user.id]).catch(()=>{});
    await client.query('COMMIT');
    res.json({ message: 'ปรับยอดเรียบร้อย', before, after, change });
  } catch(e) { await client.query('ROLLBACK'); res.status(400).json({ error: e.message }); }
  finally { client.release(); }
});

// ประวัติการเคลื่อนไหวสต๊อกแยกสินค้า
app.get('/api/stock/movements/product/:id', auth, async (req, res) => {
  const { branch_id } = req.query;
  try {
    let q = `SELECT sm.*, b.name AS branch_name, b.code AS branch_code,
      u.full_name AS created_by_name
      FROM stock_movements sm
      JOIN branches b ON sm.branch_id=b.id
      LEFT JOIN users u ON sm.created_by=u.id
      WHERE sm.product_id=$1`;
    const params = [req.params.id];
    if (branch_id) { params.push(branch_id); q += ` AND sm.branch_id=$${params.length}`; }
    q += ' ORDER BY sm.created_at DESC LIMIT 100';
    const r = await pool.query(q, params);
    res.json(r.rows);
  } catch(e) { res.json([]); }
});

// แก้ราคาสินค้าแต่ละ SKU (upsert)
app.put('/api/products/:id/prices', auth, role('owner','admin','manager'), async (req, res) => {
  const { prices } = req.body; // [{branch_id, customer_type, qty, price}]
  if (!prices || !prices.length) return res.status(400).json({ error: 'ไม่มีราคา' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of prices) {
      const { branch_id, customer_type, qty, price } = p;
      if (!customer_type || !qty || price === undefined) continue; // branch_id=null = ทุกสาขา
      // upsert — branch_id อาจเป็น null (ทุกสาขา)
      const branchCond = branch_id ? 'AND branch_id=$2' : 'AND branch_id IS NULL';
      const branchParams = branch_id ? [req.params.id, branch_id, customer_type, qty] : [req.params.id, customer_type, qty];
      const exQ = branch_id
        ? 'SELECT id FROM product_prices WHERE product_id=$1 AND branch_id=$2 AND customer_type=$3 AND qty=$4'
        : 'SELECT id FROM product_prices WHERE product_id=$1 AND branch_id IS NULL AND customer_type=$2 AND qty=$3';
      const ex = await client.query(exQ, branchParams);
      if (ex.rows.length) {
        await client.query('UPDATE product_prices SET price=$1 WHERE id=$2', [price, ex.rows[0].id]);
      } else {
        await client.query(
          'INSERT INTO product_prices (product_id,branch_id,customer_type,qty,price) VALUES ($1,$2,$3,$4,$5)',
          [req.params.id, branch_id||null, customer_type, qty, price]);
      }
    }
    await client.query('COMMIT');
    res.json({ message: 'บันทึกราคาเรียบร้อย' });
  } catch(e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// ลบราคา SKU
app.delete('/api/products/:id/prices/:priceId', auth, role('owner','admin','manager'), async (req, res) => {
  try {
    await pool.query('DELETE FROM product_prices WHERE id=$1 AND product_id=$2', [req.params.priceId, req.params.id]);
    res.json({ message: 'ลบราคาเรียบร้อย' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/permissions/:role', auth, async (req, res) => {
  const { permissions } = req.body;
  if (!Array.isArray(permissions)) return res.status(400).json({ error: 'permissions must be array' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM role_permissions WHERE role_name=$1', [req.params.role]);
    for (const perm of permissions) {
      if (typeof perm !== 'string' || !perm) continue;
      await client.query(
        'INSERT INTO role_permissions (role_name, permission, granted) VALUES ($1,$2,true) ON CONFLICT (role_name,permission) DO UPDATE SET granted=true',
        [req.params.role, perm]
      );
    }
    await client.query('COMMIT');
    res.json({ message: 'บันทึกสิทธิ์เรียบร้อย', count: permissions.length });
  } catch(e) {
    try { await client.query('ROLLBACK'); } catch(_) {}
    console.error('PUT permissions error:', e.message);
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});


// ============================================================
// PRICE QTY TIERS API
// ============================================================
app.get('/api/price-qty-tiers', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM price_qty_tiers WHERE active=true ORDER BY customer_type, sort_order, qty');
    res.json(r.rows);
  } catch(e) { res.json([]); }
});

app.post('/api/price-qty-tiers', auth, role('owner','admin'), async (req, res) => {
  const { customer_type, qty, label, sort_order } = req.body;
  if (!customer_type || !qty) return res.status(400).json({ error: 'กรุณาระบุ customer_type และ qty' });
  try {
    const r = await pool.query(
      'INSERT INTO price_qty_tiers (customer_type,qty,label,sort_order) VALUES ($1,$2,$3,$4) ON CONFLICT (customer_type,qty) DO UPDATE SET active=true,label=$3 RETURNING *',
      [customer_type, qty, label||qty+' ฟอง', sort_order||0]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/price-qty-tiers/:id', auth, role('owner','admin'), async (req, res) => {
  await pool.query('UPDATE price_qty_tiers SET active=false WHERE id=$1', [req.params.id]);
  res.json({ message: 'ลบเรียบร้อย' });
});


initSchema().then(() => {
  const server = app.listen(PORT, () => console.log(`🥚 Egg Station running on port ${PORT}`));
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} already in use, retrying in 1s...`);
      setTimeout(() => server.listen(PORT), 1000);
    } else {
      throw err;
    }
  });
});
