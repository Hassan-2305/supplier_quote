// SupplyDesk - standalone supplier quotation & information portal.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const archiver = require('archiver');

const config = require('./config');
const { db, now, token } = require('./db');
const subs = require('./lib/submissions');
const { toXlsx, toCsv } = require('./lib/export');
const { toSeed } = require('./lib/aekobaba');
const { importSite, fetchImage } = require('./lib/site-import');
const { parseSheet, template } = require('./lib/sheet-import');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

// ---------- Admin password & session signing ----------
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  const pwFile = path.join(config.dataDir, '.admin-password');
  if (!fs.existsSync(pwFile)) fs.writeFileSync(pwFile, token(12), { mode: 0o600 });
  ADMIN_PASSWORD = fs.readFileSync(pwFile, 'utf8').trim();
  console.log(`\n  No ADMIN_PASSWORD set - using generated password stored in ${pwFile}\n  Admin password: ${ADMIN_PASSWORD}\n`);
}
const SESSION_SECRET = crypto.createHash('sha256').update(`${process.env.SESSION_SECRET || ''}:${ADMIN_PASSWORD}`).digest();
const SESSION_HOURS = 12;

const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url');
function makeSession() {
  const exp = Date.now() + SESSION_HOURS * 3600e3;
  return `${exp}.${sign(String(exp))}`;
}
function validSession(cookie) {
  if (!cookie) return false;
  const [exp, sig] = cookie.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function getCookie(req, name) {
  const m = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name}=`));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
function requireAdmin(req, res, next) {
  if (validSession(getCookie(req, 'sd_admin'))) return next();
  res.status(401).json({ error: 'Not signed in' });
}

// ---------- Small in-memory rate limiter ----------
const buckets = new Map();
function rateLimit(name, max, windowMs) {
  return (req, res, next) => {
    const key = `${name}:${req.ip}`;
    const t = Date.now();
    const b = buckets.get(key) || { n: 0, reset: t + windowMs };
    if (t > b.reset) { b.n = 0; b.reset = t + windowMs; }
    b.n += 1;
    buckets.set(key, b);
    if (b.n > max) return res.status(429).json({ error: 'Too many requests - please wait a few minutes and try again.' });
    next();
  };
}
setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (t > b.reset) buckets.delete(k); }, 60e3).unref();

// ---------- Common middleware ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer'); // invite/edit tokens live in URLs
  next();
});
app.use(express.json({ limit: '2mb' }));

const baseUrl = (req) => config.publicUrl || `${req.protocol}://${req.get('host')}`;
const page = (file) => (req, res) => res.sendFile(path.join(__dirname, 'public', file));

// ---------- Uploads ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadDir,
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase().slice(0, 10)}`),
  }),
  limits: { fileSize: config.uploads.maxFileSizeMB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!config.uploads.allowedExtensions.includes(ext)) return cb(new Error(`File type ${ext || '(none)'} is not allowed`));
    cb(null, true);
  },
});

function sendFile(res, f, inline) {
  const ext = path.extname(f.original_name).toLowerCase();
  const isImage = config.uploads.imageExtensions.includes(ext) && ext !== '.heic';
  const showInline = inline && (isImage || ext === '.pdf');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Content-Type', showInline ? (f.mime || 'application/octet-stream') : 'application/octet-stream');
  res.setHeader('Content-Disposition', `${showInline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.original_name)}`);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(path.join(config.uploadDir, f.stored_name), (err) => { if (err && !res.headersSent) res.status(404).end(); });
}

// ======================================================================
//  Supplier-facing side
// ======================================================================
app.get('/', (req, res) => res.redirect(config.allowOpenSubmissions ? '/apply' : '/admin'));
app.get('/apply', (req, res, next) => (config.allowOpenSubmissions ? page('apply.html')(req, res, next) : res.status(404).sendFile(path.join(__dirname, 'public', 'closed.html'))));
app.get('/s/:token', page('apply.html'));
app.get('/e/:token', page('apply.html'));

app.get('/api/config', (req, res) => {
  const { brand, categories, specGroups, currencies, countries, priceTerms, documentTypes, certifications, uploads, allowOpenSubmissions } = config;
  res.json({ brand, categories, specGroups, currencies, countries, priceTerms, documentTypes, certifications, allowOpenSubmissions,
    uploads: { maxFileSizeMB: uploads.maxFileSizeMB, allowedExtensions: uploads.allowedExtensions, imageExtensions: uploads.imageExtensions } });
});

app.get('/api/invite/:token', (req, res) => {
  const inv = db.prepare('SELECT * FROM invites WHERE token = ?').get(req.params.token);
  if (!inv) return res.status(404).json({ error: 'This invitation link is not valid or has been withdrawn.' });
  if (!inv.opened_at) db.prepare('UPDATE invites SET opened_at = ? WHERE id = ?').run(now(), inv.id);
  let existing = null;
  if (inv.submission_id) {
    const s = db.prepare('SELECT edit_token FROM submissions WHERE id = ?').get(inv.submission_id);
    if (s) existing = s.edit_token;
  }
  res.json({ supplier_name: inv.supplier_name, contact_email: inv.contact_email, edit_token: existing });
});

app.get('/api/submission/:token', (req, res) => {
  const row = db.prepare('SELECT * FROM submissions WHERE edit_token = ?').get(req.params.token);
  if (!row) return res.status(404).json({ error: 'We could not find this submission. Please check your link.' });
  res.json(subs.load(row));
});

function saveResponse(req, result) {
  return { ...result, edit_url: `${baseUrl(req)}/e/${result.edit_token}` };
}

function handleSave(req, res, existingRow) {
  const action = req.body?.action === 'submit' ? 'submit' : 'draft';
  const s = subs.sanitize(req.body?.data);
  if (action === 'submit' || existingRow?.status === 'submitted') {
    const errors = subs.validate(s);
    if (Object.keys(errors).length) return res.status(422).json({ error: 'Please complete the highlighted fields.', errors });
  } else if (!s.company.business_name && !s.company.email) {
    return res.status(422).json({ error: 'Enter at least your business name or email before saving a draft.',
      errors: { 'company.business_name': 'Required to save a draft' } });
  }
  const status = action === 'submit' ? 'submitted' : 'draft';
  try {
    if (existingRow) return res.json(saveResponse(req, subs.update(existingRow, s, { status })));
    let inviteId = null;
    if (req.body?.invite_token) {
      const inv = db.prepare('SELECT id, submission_id FROM invites WHERE token = ?').get(String(req.body.invite_token));
      if (inv?.submission_id) {
        const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(inv.submission_id);
        if (row) return res.json(saveResponse(req, subs.update(row, s, { status })));
      }
      inviteId = inv?.id || null;
    }
    if (!inviteId && !config.allowOpenSubmissions) return res.status(403).json({ error: 'Submissions are by invitation only.' });
    res.json(saveResponse(req, subs.create(s, { status, inviteId })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong saving your submission. Please try again.' });
  }
}

app.post('/api/submissions', rateLimit('save', 40, 10 * 60e3), (req, res) => handleSave(req, res, null));
app.put('/api/submission/:token', rateLimit('save', 40, 10 * 60e3), (req, res) => {
  const row = db.prepare('SELECT * FROM submissions WHERE edit_token = ?').get(req.params.token);
  if (!row) return res.status(404).json({ error: 'Submission not found.' });
  handleSave(req, res, row);
});

app.post('/api/files', rateLimit('upload', 150, 10 * 60e3), (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `File is larger than ${config.uploads.maxFileSizeMB} MB` : err.message;
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    const id = crypto.randomUUID();
    const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8').slice(0, 250); // multer decodes as latin1
    db.prepare(`INSERT INTO files (id, kind, original_name, stored_name, mime, size, created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, req.body?.kind === 'product_image' ? 'product_image' : 'document', name, req.file.filename, req.file.mimetype, req.file.size, now());
    res.json({ id, name, size: req.file.size, mime: req.file.mimetype });
  });
});

// ---- "Enter your website" auto-fill --------------------------------------
app.post('/api/site-import', rateLimit('siteimport', 15, 10 * 60e3), async (req, res) => {
  try {
    const result = await importSite(req.body?.url);
    res.json(result);
  } catch (e) {
    const msg = /Blocked|Invalid URL|Only http|Port not allowed/.test(e.message) ? 'Please enter a public website address (e.g. www.yourcompany.com).'
      : /ENOTFOUND|EAI_AGAIN/.test(e.code || e.message) ? 'We couldn’t find that website. Check the address and try again.'
        : /Timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED/.test(e.code || e.message) ? 'Your website took too long to respond. You can fill the form in manually.'
          : e.message && e.message.length < 120 ? e.message : 'We couldn’t read your website. You can fill the form in manually.';
    console.warn(`[site-import] ${String(req.body?.url).slice(0, 200)} -> ${e.code || ''} ${e.message}`);
    res.status(422).json({ error: msg });
  }
});

// ---- Spreadsheet import -----------------------------------------------------
const sheetUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
app.post('/api/sheet-import', rateLimit('sheet', 30, 10 * 60e3), (req, res) => {
  sheetUpload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Spreadsheet is larger than 10 MB' : err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    try { res.json(await parseSheet(req.file.buffer, name)); }
    catch (e) { res.status(422).json({ error: e.message }); }
  });
});
app.get('/api/sheet-template.xlsx', async (req, res) => {
  const buf = await template();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="product-template.xlsx"');
  res.send(Buffer.from(buf));
});

// Download chosen product photos from the supplier's site into our upload store.
app.post('/api/site-import/images', rateLimit('siteimages', 25, 10 * 60e3), async (req, res) => {
  const urls = (Array.isArray(req.body?.urls) ? req.body.urls : []).map(String).filter((u) => /^https?:\/\//i.test(u)).slice(0, 40);
  const out = new Array(urls.length).fill(null);
  let i = 0;
  const worker = async () => {
    while (i < urls.length) {
      const idx = i++;
      try {
        const img = await fetchImage(urls[idx]);
        const id = crypto.randomUUID();
        const stored = `${crypto.randomUUID()}${path.extname(img.name)}`;
        fs.writeFileSync(path.join(config.uploadDir, stored), img.buffer);
        db.prepare('INSERT INTO files (id, kind, original_name, stored_name, mime, size, created_at) VALUES (?,?,?,?,?,?,?)')
          .run(id, 'product_image', img.name, stored, img.mime, img.buffer.length, now());
        out[idx] = { id, name: img.name, size: img.buffer.length };
      } catch { out[idx] = null; }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  res.json({ images: out });
});

// Suppliers can preview their own files: unattached uploads (fresh ids) or files of the submission whose edit token they hold.
app.get('/api/files/:id', (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
  if (!f) return res.status(404).end();
  if (f.submission_id) {
    const s = db.prepare('SELECT edit_token FROM submissions WHERE id = ?').get(f.submission_id);
    if (!s || s.edit_token !== req.query.k) return res.status(404).end();
  }
  sendFile(res, f, req.query.inline === '1');
});

// ======================================================================
//  Admin side
// ======================================================================
app.get('/admin', page('admin.html'));

app.post('/admin/api/login', rateLimit('login', 10, 15 * 60e3), (req, res) => {
  const given = Buffer.from(String(req.body?.password || ''));
  const real = Buffer.from(ADMIN_PASSWORD);
  if (given.length !== real.length || !crypto.timingSafeEqual(given, real)) return res.status(401).json({ error: 'Incorrect password' });
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sd_admin=${makeSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}`);
  res.json({ ok: true });
});
app.post('/admin/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'sd_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/admin/api/me', (req, res) => res.json({ signedIn: validSession(getCookie(req, 'sd_admin')), brand: config.brand }));

const admin = express.Router();
admin.use(requireAdmin);

admin.get('/stats', (req, res) => {
  const one = (sql, ...a) => db.prepare(sql).get(...a).n;
  res.json({
    total: one('SELECT COUNT(*) n FROM submissions'),
    submitted: one("SELECT COUNT(*) n FROM submissions WHERE status = 'submitted'"),
    drafts: one("SELECT COUNT(*) n FROM submissions WHERE status = 'draft'"),
    products: one("SELECT COUNT(*) n FROM products p JOIN submissions s ON s.id = p.submission_id"),
    invitesPending: one('SELECT COUNT(*) n FROM invites WHERE submission_id IS NULL'),
    invitesOpened: one('SELECT COUNT(*) n FROM invites WHERE submission_id IS NULL AND opened_at IS NOT NULL'),
    readyToList: one("SELECT COUNT(*) n FROM submissions WHERE review_status IN ('Ready to list', 'Listed')"),
    countries: db.prepare("SELECT country, COUNT(*) n FROM submissions WHERE country <> '' GROUP BY country ORDER BY n DESC").all().map((r) => ({ ...r })),
    categories: db.prepare("SELECT category, COUNT(*) n FROM products WHERE category <> '' GROUP BY category ORDER BY n DESC").all()
      .map((r) => ({ category: r.category, name: subs.categoryName(r.category), n: r.n })),
    reviewStatuses: config.reviewStatuses,
  });
});

admin.get('/submissions', (req, res) => {
  const where = [];
  const args = [];
  const q = String(req.query.q || '').trim();
  if (q) {
    where.push(`(s.business_name LIKE ? OR s.contact_person LIKE ? OR s.email LIKE ? OR s.ref_id LIKE ? OR s.city LIKE ?
      OR EXISTS (SELECT 1 FROM products p WHERE p.submission_id = s.id AND (p.name LIKE ? OR p.material LIKE ? OR p.category LIKE ?)))`);
    for (let i = 0; i < 8; i++) args.push(`%${q}%`);
  }
  if (req.query.status) { where.push('s.status = ?'); args.push(String(req.query.status)); }
  if (req.query.review) { where.push('s.review_status = ?'); args.push(String(req.query.review)); }
  if (req.query.country) { where.push('s.country = ?'); args.push(String(req.query.country)); }
  if (req.query.category) { where.push('EXISTS (SELECT 1 FROM products p WHERE p.submission_id = s.id AND p.category = ?)'); args.push(String(req.query.category)); }
  const rows = db.prepare(`
    SELECT s.id, s.ref_id, s.status, s.review_status, s.business_name, s.contact_person, s.email, s.phone, s.country, s.city,
           s.business_type, s.created_at, s.updated_at, s.submitted_at,
           (SELECT COUNT(*) FROM products p WHERE p.submission_id = s.id) AS product_count,
           (SELECT COUNT(*) FROM files f WHERE f.submission_id = s.id) AS file_count,
           (SELECT GROUP_CONCAT(DISTINCT p.category) FROM products p WHERE p.submission_id = s.id AND p.category <> '') AS categories
    FROM submissions s ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY COALESCE(s.submitted_at, s.updated_at) DESC`).all(...args);
  res.json(rows.map((r) => ({ ...r, categories: (r.categories || '').split(',').filter(Boolean).map(subs.categoryName).join(', ') })));
});

admin.get('/submissions/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const invite = row.invite_id ? db.prepare('SELECT supplier_name, contact_email, created_at FROM invites WHERE id = ?').get(row.invite_id) : null;
  res.json({ ...subs.load(row), id: row.id, review_status: row.review_status, admin_notes: row.admin_notes,
    edit_url: `${baseUrl(req)}/e/${row.edit_token}`, invite: invite ? { ...invite } : null });
});

admin.patch('/submissions/:id', (req, res) => {
  const row = db.prepare('SELECT id FROM submissions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (req.body.review_status != null) {
    if (!config.reviewStatuses.includes(req.body.review_status)) return res.status(400).json({ error: 'Invalid review status' });
    db.prepare('UPDATE submissions SET review_status = ? WHERE id = ?').run(req.body.review_status, row.id);
  }
  if (req.body.admin_notes != null) db.prepare('UPDATE submissions SET admin_notes = ? WHERE id = ?').run(String(req.body.admin_notes).slice(0, 10000), row.id);
  res.json({ ok: true });
});

admin.delete('/submissions/:id', (req, res) => {
  const files = db.prepare('SELECT stored_name FROM files WHERE submission_id = ?').all(req.params.id);
  db.prepare('DELETE FROM submissions WHERE id = ?').run(req.params.id);
  files.forEach((f) => fs.rm(path.join(config.uploadDir, f.stored_name), { force: true }, () => {}));
  res.json({ ok: true });
});

admin.get('/submissions/:id/files.zip', (req, res) => {
  const row = db.prepare('SELECT id, ref_id, business_name FROM submissions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).end();
  const files = db.prepare('SELECT * FROM files WHERE submission_id = ? ORDER BY kind, created_at').all(row.id);
  const safe = (s) => String(s || '').replace(/[^\w.\- ]+/g, '_').trim() || 'file';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${safe(row.ref_id)}-${safe(row.business_name)}.zip"`);
  const zip = archiver('zip', { zlib: { level: 6 } });
  zip.on('error', () => res.end());
  zip.pipe(res);
  const used = new Set();
  for (const f of files) {
    const folder = f.kind === 'product_image' ? `Product images/Product ${(f.product_pos ?? 0) + 1}` : `Documents/${safe(f.doc_type || 'Other')}`;
    let name = `${folder}/${safe(f.original_name)}`;
    for (let i = 2; used.has(name); i++) name = `${folder}/${i}-${safe(f.original_name)}`;
    used.add(name);
    const p = path.join(config.uploadDir, f.stored_name);
    if (fs.existsSync(p)) zip.file(p, { name });
  }
  zip.finalize();
});

// Price comparison: one row per price tier (or per product if it has no tiers).
admin.get('/compare', (req, res) => {
  const where = ["s.status = 'submitted'"];
  const args = [];
  const q = String(req.query.q || '').trim();
  if (q) { where.push('(p.name LIKE ? OR p.material LIKE ? OR p.dimensions LIKE ? OR s.business_name LIKE ?)'); for (let i = 0; i < 4; i++) args.push(`%${q}%`); }
  if (req.query.category) { where.push('p.category = ?'); args.push(String(req.query.category)); }
  if (req.query.currency) { where.push('p.currency = ?'); args.push(String(req.query.currency)); }
  if (req.query.drafts === '1') where.shift();
  const rows = db.prepare(`
    SELECT s.id AS submission_id, s.ref_id, s.business_name, s.country, s.city, s.review_status, s.data AS sdata,
           p.id AS product_id, p.name, p.category, p.material, p.dimensions, p.currency, p.unit, p.moq, p.lead_time,
           p.data AS pdata, t.min_qty, t.max_qty, t.unit_price
    FROM products p JOIN submissions s ON s.id = p.submission_id
    LEFT JOIN price_tiers t ON t.product_id = p.id
    WHERE ${where.join(' AND ')}
    ORDER BY p.category, p.name, t.unit_price`).all(...args);
  res.json(rows.map(({ sdata, pdata, ...r }) => {
    const d = JSON.parse(sdata || '{}');
    const p = JSON.parse(pdata || '{}');
    return { ...r, category_name: subs.categoryName(r.category), terms: subs.termsLabel(d.pricing?.terms, d.pricing?.port), price_type: p.price_type || '',
      samples: p.samples || '', sample_cost: p.sample_cost || '', setup_cost: p.setup_cost || '', stock_or_custom: p.stock_or_custom || '' };
  }));
});

// ---- Aekobaba export -------------------------------------------------------
// One supplier: a ZIP laid out like the Aekobaba repo, ready to merge.
admin.get('/submissions/:id/aekobaba.zip', (req, res) => {
  const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).end();
  const s = subs.load(row);
  const seed = toSeed(s);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="aekobaba-${seed.slug}.zip"`);
  const zip = archiver('zip', { zlib: { level: 6 } });
  zip.on('error', () => res.end());
  zip.pipe(res);
  zip.append(JSON.stringify(seed.supplier, null, 2) + '\n', { name: 'supplier.json' });
  zip.append(JSON.stringify(seed.record, null, 2) + '\n', { name: `public/partners/${seed.slug}/${seed.sourceFile}` });
  for (const f of seed.files) {
    const p = path.join(config.uploadDir, f.from);
    if (fs.existsSync(p)) zip.file(p, { name: `public/partners/${seed.slug}/${f.to}` });
  }
  const used = new Set();
  for (const d of s.documents) {
    const p = path.join(config.uploadDir, d.stored_name);
    let name = `supplier-documents/${d.name.replace(/[\\/:*?"<>|]+/g, '_')}`;
    for (let i = 2; used.has(name); i++) name = `supplier-documents/${i}-${d.name.replace(/[\\/:*?"<>|]+/g, '_')}`;
    used.add(name);
    if (fs.existsSync(p)) zip.file(p, { name });
  }
  zip.append([
    `Aekobaba listing export - ${s.company.business_name} (${s.ref_id})`,
    '',
    `1. Copy the public/ folder into the aekobaba repo root (images + submission record go to public/partners/${seed.slug}/).`,
    '2. Add the object in supplier.json to the "suppliers" array in data/aekobaba-seed.json.',
    '3. Run the seed validation / import as usual. Status is PENDING - change it to LISTED when ready.',
    '',
    'supplier-documents/ holds the catalogues / price lists the supplier uploaded, for your reference (not published).',
    ...(seed.warnings.length ? ['', 'Warnings:', ...seed.warnings.map((w) => ' - ' + w)] : []),
  ].join('\n'), { name: 'README.txt' });
  zip.finalize();
});

// All submitted suppliers as a seed fragment: { suppliers: [...] } (no files).
admin.get('/aekobaba.json', (req, res) => {
  const review = req.query.review ? String(req.query.review) : null;
  const rows = db.prepare("SELECT * FROM submissions WHERE status = 'submitted' ORDER BY submitted_at").all()
    .filter((r) => !review || r.review_status === review);
  const used = new Set();
  const suppliers = rows.map((r) => {
    const s = subs.load(r);
    const base = toSeed(s).slug;
    let slug = base;
    for (let i = 2; used.has(slug); i++) slug = `${base}-${i}`;
    used.add(slug);
    return toSeed(s, { slug }).supplier;
  });
  res.setHeader('Content-Disposition', `attachment; filename="aekobaba-suppliers-${new Date().toISOString().slice(0, 10)}.json"`);
  res.type('application/json').send(JSON.stringify({ suppliers }, null, 2));
});

admin.get('/submissions/:id/aekobaba-preview', (req, res) => {
  const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const seed = toSeed(subs.load(row));
  res.json({ supplier: seed.supplier, warnings: seed.warnings });
});

admin.get('/invites', (req, res) => {
  const rows = db.prepare(`SELECT i.*, s.ref_id, s.status AS submission_status, s.business_name
    FROM invites i LEFT JOIN submissions s ON s.id = i.submission_id ORDER BY i.created_at DESC`).all();
  res.json(rows.map((r) => ({ ...r, url: `${baseUrl(req)}/s/${r.token}` })));
});
admin.post('/invites', (req, res) => {
  const name = String(req.body?.supplier_name || '').trim().slice(0, 200);
  const email = String(req.body?.contact_email || '').trim().slice(0, 200);
  const note = String(req.body?.note || '').trim().slice(0, 1000);
  if (!name && !email) return res.status(400).json({ error: 'Enter a supplier name or email' });
  const t = token(18);
  const r = db.prepare('INSERT INTO invites (token, supplier_name, contact_email, note, created_at) VALUES (?,?,?,?,?)').run(t, name, email, note, now());
  res.json({ id: Number(r.lastInsertRowid), url: `${baseUrl(req)}/s/${t}` });
});
admin.delete('/invites/:id', (req, res) => {
  db.prepare('DELETE FROM invites WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

admin.get('/files/:id', (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
  if (!f) return res.status(404).end();
  sendFile(res, f, req.query.inline === '1');
});

const stamp = () => new Date().toISOString().slice(0, 10);
admin.get('/export.xlsx', async (req, res) => {
  const buf = await toXlsx(config.brand.name);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${config.brand.name}-suppliers-${stamp()}.xlsx"`);
  res.send(Buffer.from(buf));
});
admin.get('/export.csv', (req, res) => {
  const type = ['suppliers', 'products', 'prices', 'documents'].includes(req.query.type) ? req.query.type : 'suppliers';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${config.brand.name}-${type}-${stamp()}.csv"`);
  res.send(toCsv(type));
});

app.use('/admin/api', admin);
app.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: 0, etag: true, lastModified: true, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

// Clean up uploads that were never attached to a submission (older than 7 days).
function cleanupOrphans() {
  const cutoff = new Date(Date.now() - 7 * 24 * 3600e3).toISOString();
  const rows = db.prepare('SELECT id, stored_name FROM files WHERE submission_id IS NULL AND created_at < ?').all(cutoff);
  for (const f of rows) {
    db.prepare('DELETE FROM files WHERE id = ?').run(f.id);
    fs.rm(path.join(config.uploadDir, f.stored_name), { force: true }, () => {});
  }
}
cleanupOrphans();
setInterval(cleanupOrphans, 6 * 3600e3).unref();

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`  ${config.brand.name} running`);
    console.log(`  Supplier form:  http://localhost:${config.port}/apply`);
    console.log(`  Admin:          http://localhost:${config.port}/admin\n`);
  });
}

module.exports = app;
