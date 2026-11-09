// SQLite persistence using Node's built-in driver (no native build step needed).
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(config.uploadDir, { recursive: true });

const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS invites (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  token         TEXT NOT NULL UNIQUE,
  supplier_name TEXT,
  contact_email TEXT,
  note          TEXT,
  created_at    TEXT NOT NULL,
  opened_at     TEXT,
  submission_id INTEGER REFERENCES submissions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS submissions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_id         TEXT NOT NULL UNIQUE,
  edit_token     TEXT NOT NULL UNIQUE,
  invite_id      INTEGER REFERENCES invites(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'draft',      -- draft | submitted
  review_status  TEXT NOT NULL DEFAULT 'New',
  admin_notes    TEXT DEFAULT '',
  business_name  TEXT,
  contact_person TEXT,
  email          TEXT,
  phone          TEXT,
  country        TEXT,
  city           TEXT,
  business_type  TEXT,
  data           TEXT NOT NULL DEFAULT '{}',          -- full JSON payload (non-product sections)
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  submitted_at   TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL DEFAULT 0,
  name          TEXT,
  category      TEXT,
  material      TEXT,
  dimensions    TEXT,
  currency      TEXT,
  unit          TEXT,
  moq           REAL,
  sample_cost   REAL,
  tooling_cost  REAL,
  printing_cost REAL,
  lead_time     TEXT,
  data          TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS price_tiers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL DEFAULT 0,
  variant    TEXT,
  min_qty    REAL,
  max_qty    REAL,
  unit_price REAL
);

CREATE TABLE IF NOT EXISTS files (
  id            TEXT PRIMARY KEY,                     -- random UUID, unguessable
  submission_id INTEGER REFERENCES submissions(id) ON DELETE CASCADE,
  product_pos   INTEGER,                              -- product position for product images
  kind          TEXT NOT NULL,                        -- document | product_image
  doc_type      TEXT,
  original_name TEXT NOT NULL,
  stored_name   TEXT NOT NULL,
  mime          TEXT,
  size          INTEGER,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_submission ON products(submission_id);
CREATE INDEX IF NOT EXISTS idx_tiers_product ON price_tiers(product_id);
CREATE INDEX IF NOT EXISTS idx_files_submission ON files(submission_id);
`);

const now = () => new Date().toISOString();
const token = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

// Reference IDs look like SD-2611-K7Q3MZ: prefix, YYMM, 6 unambiguous characters.
function newRefId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const d = new Date();
  const yymm = String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, '0');
  for (;;) {
    let s = '';
    for (const b of crypto.randomBytes(6)) s += alphabet[b % alphabet.length];
    const ref = `${config.refPrefix}-${yymm}-${s}`;
    if (!db.prepare('SELECT 1 FROM submissions WHERE ref_id = ?').get(ref)) return ref;
  }
}

function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { db, now, token, newRefId, tx };
