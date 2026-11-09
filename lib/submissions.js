// Sanitising, validating, saving and loading supplier submissions.
// Product fields mirror the Aekobaba Product model (see config.js).
const { db, now, token, newRefId } = require('../db');
const storage = require('./storage');
const config = require('../config');

const str = (v, max = 2000) => (v == null ? '' : String(v).trim().slice(0, max));
// Tolerant number parsing: "1,000 pcs" -> 1000, "$12.50" -> 12.5
const num = (v) => {
  if (v === '' || v == null) return null;
  const m = String(v).replace(/,/g, '').match(/\d+(\.\d+)?|\.\d+/);
  const n = m ? Number(m[0]) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const oneOf = (v, list) => (list.includes(v) ? v : '');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CATEGORY_SLUGS = config.categories.map((c) => c.slug);

const COMPANY_FIELDS = ['business_name', 'contact_person', 'email', 'phone', 'country', 'location', 'website', 'legal_name'];
const PRODUCT_TEXT = ['name', 'subcategory', 'material', 'finish', 'capacity', 'dimensions', 'thickness', 'neck_finish',
  'closure', 'board', 'unit', 'moq_unit', 'setup_cost', 'sample_cost', 'description'];

function sanitize(body) {
  const b = body && typeof body === 'object' ? body : {};
  const company = {};
  for (const f of COMPANY_FIELDS) company[f] = str(b.company?.[f], 300);
  company.certifications = (Array.isArray(b.company?.certifications) ? b.company.certifications : [])
    .map((c) => str(c, 100)).filter(Boolean).slice(0, 30);
  company.certifications_other = str(b.company?.certifications_other, 300);

  const pricing = {
    currency: oneOf(str(b.pricing?.currency), config.currencies) || config.currencies[0],
    terms: oneOf(str(b.pricing?.terms), config.priceTerms.map((t) => t[0])),
    port: str(b.pricing?.port, 120),
  };

  const products = (Array.isArray(b.products) ? b.products : []).slice(0, 200).map((p) => {
    const prod = {};
    for (const f of PRODUCT_TEXT) prod[f] = str(p?.[f], f === 'description' ? 2000 : 300);
    prod.category = oneOf(str(p?.category), CATEGORY_SLUGS);
    prod.stock_or_custom = oneOf(str(p?.stock_or_custom), ['STOCK', 'CUSTOM']);
    prod.printing = oneOf(str(p?.printing), ['Yes', 'No']);
    prod.food_grade = oneOf(str(p?.food_grade), ['Yes', 'No']);
    prod.samples = oneOf(str(p?.samples), ['Free', 'Paid', 'No']);
    prod.price_type = oneOf(str(p?.price_type), ['EXACT', 'FROM', 'QUOTE_ONLY']) || 'EXACT';
    prod.price = prod.price_type === 'QUOTE_ONLY' ? null : num(p?.price);
    prod.moq = num(p?.moq);
    prod.lead_time_days = num(p?.lead_time_days);
    prod.tiers = (Array.isArray(p?.tiers) ? p.tiers : []).slice(0, 30)
      .map((t) => ({ min_qty: num(t?.min_qty), max_qty: num(t?.max_qty), unit_price: num(t?.unit_price) }))
      .filter((t) => t.min_qty != null || t.max_qty != null || t.unit_price != null);
    prod.image_ids = (Array.isArray(p?.image_ids) ? p.image_ids : []).map((x) => str(x, 64)).filter(Boolean).slice(0, 12);
    return prod;
  }).filter((p) => p.name || p.material || p.category || p.price != null || p.tiers.length || p.image_ids.length);

  const documents = (Array.isArray(b.documents) ? b.documents : []).slice(0, config.uploads.maxFilesPerSubmission)
    .map((d) => ({ file_id: str(d?.file_id, 64), doc_type: str(d?.doc_type, 100) || 'Other' }))
    .filter((d) => d.file_id);

  return { company, pricing, products, documents, notes: str(b.notes, 5000), consent: b.consent === true };
}

// Only what Aekobaba needs to list a product is mandatory.
function validate(s) {
  const errors = {};
  const c = s.company;
  if (!c.business_name) errors['company.business_name'] = 'Company name is required';
  if (!c.contact_person) errors['company.contact_person'] = 'Contact name is required';
  if (!c.email) errors['company.email'] = 'Email is required';
  else if (!EMAIL_RE.test(c.email)) errors['company.email'] = 'Enter a valid email address';
  if (!c.phone) errors['company.phone'] = 'Phone number is required';
  if (!c.country) errors['company.country'] = 'Country is required';
  if (!c.location) errors['company.location'] = 'City is required';
  if (!s.products.length && !s.documents.length) {
    errors.products = 'Add at least one product, or upload your catalogue / price list below';
  }
  s.products.forEach((p, i) => {
    if (!p.name) errors[`products.${i}.name`] = 'Product name is required';
    if (!p.category) errors[`products.${i}.category`] = 'Choose a category';
    if (!p.material) errors[`products.${i}.material`] = 'Material is required';
    if (p.price_type !== 'QUOTE_ONLY' && p.price == null && !p.tiers.some((t) => t.unit_price != null)) {
      errors[`products.${i}.price`] = 'Enter a price, or choose "Price on request"';
    }
  });
  if (!s.consent) errors.consent = 'Please confirm to continue';
  return errors;
}

// Files are uploaded before the form is saved; attach them now. A file can only be
// claimed if it is unattached or already belongs to this submission.
async function attachFiles(t, submissionId, s) {
  const claim = (fid, kind, docType, pos) => t.run(`UPDATE files SET submission_id = ?, kind = ?, doc_type = ?, product_pos = ?
    WHERE id = ? AND uploaded = 1 AND (submission_id IS NULL OR submission_id = ?)`, [submissionId, kind, docType, pos, fid, submissionId]);
  const keep = new Set();
  for (const d of s.documents) { await claim(d.file_id, 'document', d.doc_type, null); keep.add(d.file_id); }
  for (const [pos, p] of s.products.entries()) {
    for (const fid of p.image_ids) { await claim(fid, 'product_image', null, pos); keep.add(fid); }
  }
  const existing = await t.all('SELECT id, stored_name FROM files WHERE submission_id = ?', [submissionId]);
  const gone = existing.filter((f) => !keep.has(f.id));
  for (const f of gone) await t.run('DELETE FROM files WHERE id = ?', [f.id]);
  return gone.map((f) => f.stored_name);
}

async function writeProducts(t, submissionId, s) {
  await t.run('DELETE FROM products WHERE submission_id = ?', [submissionId]);
  for (const [pos, p] of s.products.entries()) {
    const { tiers, image_ids, ...rest } = p;
    const size = [p.capacity, p.dimensions].filter(Boolean).join(', ');
    const productId = await t.insert(`INSERT INTO products (submission_id, position, name, category, material, dimensions, currency, unit, moq,
      sample_cost, tooling_cost, printing_cost, lead_time, data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [submissionId, pos, p.name, p.category, p.material, size, s.pricing.currency, p.unit, p.moq,
      null, null, null, p.lead_time_days == null ? '' : String(p.lead_time_days), JSON.stringify(rest)]);
    // The headline price is stored as the first tier so price comparison sees it.
    const rows = [...tiers];
    if (p.price != null && !rows.some((x) => x.unit_price === p.price)) rows.unshift({ min_qty: p.moq, max_qty: null, unit_price: p.price, headline: true });
    for (const [i, x] of rows.entries()) {
      await t.run('INSERT INTO price_tiers (product_id, position, variant, min_qty, max_qty, unit_price) VALUES (?,?,?,?,?,?)',
        [productId, i, x.headline ? 'headline' : '', x.min_qty, x.max_qty, x.unit_price]);
    }
  }
}

const sectionData = (s) => JSON.stringify({ company: s.company, pricing: s.pricing, notes: s.notes, consent: s.consent });

async function create(s, { status, inviteId }) {
  let removed = [];
  const result = await db.tx(async (t) => {
    const ts = now();
    const ref = await newRefId(t);
    const editToken = token(24);
    const c = s.company;
    const id = await t.insert(`INSERT INTO submissions (ref_id, edit_token, invite_id, status, business_name, contact_person, email, phone,
      country, city, business_type, data, created_at, updated_at, submitted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [ref, editToken, inviteId || null, status, c.business_name, c.contact_person, c.email, c.phone, c.country, c.location,
      '', sectionData(s), ts, ts, status === 'submitted' ? ts : null]);
    await writeProducts(t, id, s);
    removed = await attachFiles(t, id, s);
    if (inviteId) await t.run('UPDATE invites SET submission_id = ? WHERE id = ?', [id, inviteId]);
    return { id, ref_id: ref, edit_token: editToken, status };
  });
  await storage.remove(removed);
  return result;
}

async function update(row, s, { status }) {
  let removed = [];
  const result = await db.tx(async (t) => {
    const ts = now();
    const newStatus = row.status === 'submitted' ? 'submitted' : status; // never back to draft
    const submittedAt = row.submitted_at || (newStatus === 'submitted' ? ts : null);
    const c = s.company;
    await t.run(`UPDATE submissions SET status=?, business_name=?, contact_person=?, email=?, phone=?, country=?, city=?,
      data=?, updated_at=?, submitted_at=? WHERE id=?`,
    [newStatus, c.business_name, c.contact_person, c.email, c.phone, c.country, c.location, sectionData(s), ts, submittedAt, row.id]);
    await writeProducts(t, row.id, s);
    removed = await attachFiles(t, row.id, s);
    return { id: row.id, ref_id: row.ref_id, edit_token: row.edit_token, status: newStatus };
  });
  await storage.remove(removed);
  return result;
}

function fileMeta(f) {
  return { id: f.id, name: f.original_name, size: f.size, mime: f.mime, doc_type: f.doc_type, product_pos: f.product_pos, kind: f.kind,
    stored_name: f.stored_name };
}

const termsLabel = (t, port) => (t ? `${t === 'DELIVERED' ? 'delivered' : t}${port && t !== 'DELIVERED' ? ' ' + port : ''}` : '');
const categoryName = (slug) => (config.categories.find((c) => c.slug === slug) || {}).name || slug || '';

// Full, structured view of a submission (supplier edit page, admin, exports).
async function load(row) {
  const data = JSON.parse(row.data || '{}');
  const pricing = { currency: config.currencies[0], terms: '', port: '', ...(data.pricing || {}) };
  const files = await db.all('SELECT * FROM files WHERE submission_id = ? ORDER BY created_at', [row.id]);
  const productRows = await db.all('SELECT * FROM products WHERE submission_id = ? ORDER BY position', [row.id]);
  const tierRows = productRows.length
    ? await db.all(`SELECT product_id, variant, min_qty, max_qty, unit_price FROM price_tiers
        WHERE product_id IN (${productRows.map(() => '?').join(',')}) ORDER BY product_id, position`, productRows.map((p) => p.id))
    : [];
  const products = productRows.map((p) => {
    const extra = JSON.parse(p.data || '{}');
    const tiers = tierRows.filter((x) => x.product_id === p.id && x.variant !== 'headline')
      .map((x) => ({ min_qty: x.min_qty, max_qty: x.max_qty, unit_price: x.unit_price }));
    const images = files.filter((f) => f.kind === 'product_image' && f.product_pos === p.position).map(fileMeta);
    return { ...extra, id: p.id, name: p.name, category: p.category, category_name: categoryName(p.category), material: p.material,
      currency: pricing.currency, tiers, images, image_ids: images.map((i) => i.id) };
  });
  const documents = files.filter((f) => f.kind === 'document').map(fileMeta);
  return {
    ref_id: row.ref_id, status: row.status, created_at: row.created_at, updated_at: row.updated_at, submitted_at: row.submitted_at,
    company: { certifications: [], ...(data.company || {}) }, pricing, notes: data.notes || '', consent: !!data.consent, products, documents,
  };
}

module.exports = { sanitize, validate, create, update, load, categoryName, termsLabel };
