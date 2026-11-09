// Database layer with one async API over three backends:
//   - Postgres (Supabase) when DATABASE_URL is set   -> production on Vercel
//   - PGlite (in-memory Postgres) when DB_DRIVER=pglite -> tests of the Postgres SQL
//   - SQLite file (node:sqlite) otherwise             -> local development
//
// Queries use "?" placeholders; they are rewritten to $1, $2... for Postgres.
//   await db.all(sql, params)    -> rows
//   await db.get(sql, params)    -> first row | undefined
//   await db.run(sql, params)    -> { changes }
//   await db.insert(sql, params) -> new id (appends RETURNING id)
//   await db.tx(async (t) => {...}) -> same methods inside one transaction
const fs = require('fs');
const crypto = require('crypto');
const config = require('./config');

// DATABASE_URL, or POSTGRES_URL as set by the Supabase integration on Vercel.
const PG_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
const DRIVER = PG_URL ? 'pg' : process.env.DB_DRIVER === 'pglite' ? 'pglite' : 'sqlite';
const isPg = DRIVER !== 'sqlite';

const toPg = (sql) => { let n = 0; return sql.replace(/\?/g, () => `$${++n}`); };
const plain = (rows) => rows.map((r) => ({ ...r }));

// ---------------------------------------------------------------- schema
const SCHEMA_SQLITE = `
CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL UNIQUE, supplier_name TEXT, contact_email TEXT, note TEXT,
  created_at TEXT NOT NULL, opened_at TEXT, submission_id INTEGER REFERENCES submissions(id) ON DELETE SET NULL);
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ref_id TEXT NOT NULL UNIQUE, edit_token TEXT NOT NULL UNIQUE,
  invite_id INTEGER REFERENCES invites(id) ON DELETE SET NULL, status TEXT NOT NULL DEFAULT 'draft',
  review_status TEXT NOT NULL DEFAULT 'New', admin_notes TEXT DEFAULT '', business_name TEXT, contact_person TEXT, email TEXT,
  phone TEXT, country TEXT, city TEXT, business_type TEXT, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, submitted_at TEXT);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT, submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0, name TEXT, category TEXT, material TEXT, dimensions TEXT, currency TEXT, unit TEXT,
  moq REAL, sample_cost REAL, tooling_cost REAL, printing_cost REAL, lead_time TEXT, data TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS price_tiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0, variant TEXT, min_qty REAL, max_qty REAL, unit_price REAL);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, submission_id INTEGER REFERENCES submissions(id) ON DELETE CASCADE, product_pos INTEGER,
  kind TEXT NOT NULL, doc_type TEXT, original_name TEXT NOT NULL, stored_name TEXT NOT NULL, mime TEXT, size INTEGER,
  created_at TEXT NOT NULL, uploaded INTEGER NOT NULL DEFAULT 1);
CREATE INDEX IF NOT EXISTS idx_products_submission ON products(submission_id);
CREATE INDEX IF NOT EXISTS idx_tiers_product ON price_tiers(product_id);
CREATE INDEX IF NOT EXISTS idx_files_submission ON files(submission_id);`;

const SCHEMA_PG = `
CREATE TABLE IF NOT EXISTS submissions (
  id SERIAL PRIMARY KEY, ref_id TEXT NOT NULL UNIQUE, edit_token TEXT NOT NULL UNIQUE, invite_id INTEGER,
  status TEXT NOT NULL DEFAULT 'draft', review_status TEXT NOT NULL DEFAULT 'New', admin_notes TEXT DEFAULT '',
  business_name TEXT, contact_person TEXT, email TEXT, phone TEXT, country TEXT, city TEXT, business_type TEXT,
  data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, submitted_at TEXT);
CREATE TABLE IF NOT EXISTS invites (
  id SERIAL PRIMARY KEY, token TEXT NOT NULL UNIQUE, supplier_name TEXT, contact_email TEXT, note TEXT,
  created_at TEXT NOT NULL, opened_at TEXT, submission_id INTEGER REFERENCES submissions(id) ON DELETE SET NULL);
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY, submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0, name TEXT, category TEXT, material TEXT, dimensions TEXT, currency TEXT, unit TEXT,
  moq DOUBLE PRECISION, sample_cost DOUBLE PRECISION, tooling_cost DOUBLE PRECISION, printing_cost DOUBLE PRECISION,
  lead_time TEXT, data TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS price_tiers (
  id SERIAL PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0, variant TEXT, min_qty DOUBLE PRECISION, max_qty DOUBLE PRECISION, unit_price DOUBLE PRECISION);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, submission_id INTEGER REFERENCES submissions(id) ON DELETE CASCADE, product_pos INTEGER,
  kind TEXT NOT NULL, doc_type TEXT, original_name TEXT NOT NULL, stored_name TEXT NOT NULL, mime TEXT, size INTEGER,
  created_at TEXT NOT NULL, uploaded INTEGER NOT NULL DEFAULT 1);
CREATE INDEX IF NOT EXISTS idx_products_submission ON products(submission_id);
CREATE INDEX IF NOT EXISTS idx_tiers_product ON price_tiers(product_id);
CREATE INDEX IF NOT EXISTS idx_files_submission ON files(submission_id);`;

// ---------------------------------------------------------------- backends
function sqliteBackend() {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(config.dataDir, { recursive: true });
  const sdb = new DatabaseSync(config.dbFile);
  sdb.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  sdb.exec(SCHEMA_SQLITE);
  try { sdb.exec('ALTER TABLE files ADD COLUMN uploaded INTEGER NOT NULL DEFAULT 1'); } catch {}
  const q = {
    all: async (sql, p = []) => plain(sdb.prepare(sql).all(...p)),
    get: async (sql, p = []) => { const r = sdb.prepare(sql).get(...p); return r ? { ...r } : undefined; },
    run: async (sql, p = []) => { const r = sdb.prepare(sql).run(...p); return { changes: Number(r.changes) }; },
    insert: async (sql, p = []) => Number(sdb.prepare(sql).run(...p).lastInsertRowid),
  };
  // node:sqlite is synchronous, so a transaction can't interleave with other requests.
  let chain = Promise.resolve();
  q.tx = (fn) => {
    const run = chain.then(async () => {
      sdb.exec('BEGIN');
      try { const r = await fn(q); sdb.exec('COMMIT'); return r; } catch (e) { sdb.exec('ROLLBACK'); throw e; }
    });
    chain = run.catch(() => {});
    return run;
  };
  return { q, ready: Promise.resolve() };
}

function wrapPg(exec) {
  return {
    all: async (sql, p = []) => (await exec(toPg(sql), p)).rows,
    get: async (sql, p = []) => (await exec(toPg(sql), p)).rows[0],
    run: async (sql, p = []) => ({ changes: (await exec(toPg(sql), p)).rowCount ?? (await Promise.resolve(0)) }),
    insert: async (sql, p = []) => Number((await exec(toPg(sql) + ' RETURNING id', p)).rows[0].id),
  };
}

function pgBackend() {
  const { Pool, types } = require('pg');
  types.setTypeParser(20, (v) => Number(v)); // COUNT(*) -> number
  // Drop sslmode/supa params from the URL: node-postgres treats sslmode=require as full
  // certificate verification, which fails on Supabase's pooler. TLS stays on via `ssl` below.
  const url = new URL(PG_URL);
  ['sslmode', 'sslrootcert', 'supa'].forEach((k) => url.searchParams.delete(k));
  const local = /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
  const pool = new Pool({
    connectionString: url.toString(),
    ssl: local ? false : { rejectUnauthorized: false },
    max: 3,
    idleTimeoutMillis: 10000,
  });
  const q = wrapPg((sql, p) => pool.query(sql, p));
  q.tx = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await fn(wrapPg((sql, p) => client.query(sql, p)));
      await client.query('COMMIT');
      return r;
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  };
  const ready = pool.query(SCHEMA_PG).then(() => pool.query('ALTER TABLE files ADD COLUMN IF NOT EXISTS uploaded INTEGER NOT NULL DEFAULT 1'));
  return { q, ready };
}

function pgliteBackend() {
  let inst;
  const ready = import('@electric-sql/pglite').then(async ({ PGlite }) => { inst = new PGlite(); await inst.exec(SCHEMA_PG); });
  const fix = (row) => { for (const k in row) if (typeof row[k] === 'bigint') row[k] = Number(row[k]); return row; };
  const exec = async (sql, p) => { await ready; const r = await inst.query(sql, p); return { rows: r.rows.map(fix), rowCount: r.affectedRows }; };
  const q = wrapPg(exec);
  let chain = Promise.resolve();
  q.tx = (fn) => {
    const run = chain.then(async () => {
      await exec('BEGIN', []);
      try { const r = await fn(q); await exec('COMMIT', []); return r; } catch (e) { await exec('ROLLBACK', []); throw e; }
    });
    chain = run.catch(() => {});
    return run;
  };
  return { q, ready };
}

function missingBackend() {
  const err = new Error('Database is not configured. Connect Supabase to this Vercel project (or set DATABASE_URL) and redeploy.');
  const fail = async () => { throw err; };
  return { q: { all: fail, get: fail, run: fail, insert: fail, tx: fail }, ready: Promise.resolve() };
}

const backend = DRIVER === 'pg' ? pgBackend() : DRIVER === 'pglite' ? pgliteBackend() : process.env.VERCEL ? missingBackend() : sqliteBackend();
let readyPromise = backend.ready;

const db = {
  driver: DRIVER,
  isPg,
  /** Case-insensitive LIKE */
  like: isPg ? 'ILIKE' : 'LIKE',
  /** Comma-joined distinct values */
  groupConcat: (expr) => (isPg ? `string_agg(DISTINCT ${expr}, ',')` : `GROUP_CONCAT(DISTINCT ${expr})`),
  ready: () => readyPromise,
  all: async (...a) => { await readyPromise; return backend.q.all(...a); },
  get: async (...a) => { await readyPromise; return backend.q.get(...a); },
  run: async (...a) => { await readyPromise; return backend.q.run(...a); },
  insert: async (...a) => { await readyPromise; return backend.q.insert(...a); },
  tx: async (fn) => { await readyPromise; return backend.q.tx(fn); },
};
readyPromise = readyPromise.catch((e) => { console.error('Database setup failed:', e.message); throw e; });

const now = () => new Date().toISOString();
const token = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

// Reference IDs look like SD-2611-K7Q3MZ: prefix, YYMM, 6 unambiguous characters.
async function newRefId(q = db) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const d = new Date();
  const yymm = String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, '0');
  for (;;) {
    let s = '';
    for (const b of crypto.randomBytes(6)) s += alphabet[b % alphabet.length];
    const ref = `${config.refPrefix}-${yymm}-${s}`;
    if (!(await q.get('SELECT 1 AS x FROM submissions WHERE ref_id = ?', [ref]))) return ref;
  }
}

module.exports = { db, now, token, newRefId };
