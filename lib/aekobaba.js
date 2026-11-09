// Converts a submission into an Aekobaba seed supplier object
// (data/seed-schema.ts → supplierSchema) plus the files to host under
// public/partners/<slug>/.
//
// Provenance: the supplier's own submission is the source for every fact, so
// each record points at /partners/<slug>/<REF>.json (the submission record,
// included in the export) and is dated with the submission date.
const path = require('path');
const config = require('../config');
const { termsLabel } = require('./submissions');

const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '')
  .replace(/[_\s-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'supplier';
const safeFile = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
const intOrNull = (v) => (v == null || !Number.isFinite(Number(v)) || Number(v) < 1 ? null : Math.round(Number(v)));
const posOrNull = (v) => (v == null || !(Number(v) > 0) ? null : Number(v));

function normaliseWebsite(w) {
  if (!w) return '';
  const url = /^https?:\/\//i.test(w) ? w : `https://${w}`;
  try { return new URL(url).toString(); } catch { return ''; }
}

// Spec sentences phrased so Aekobaba's extractSpecs() (src/lib/catalog/specs.ts) picks them up.
function describe(p, s) {
  const parts = [];
  if (p.description) parts.push(p.description.replace(/\s+/g, ' ').trim().replace(/([^.])$/, '$1.'));
  if (p.capacity) parts.push(`Capacity: ${p.capacity}.`);
  if (p.dimensions) parts.push(`Size: ${p.dimensions.replace(/\s*[xX*]\s*/g, ' x ')}.`);
  if (p.thickness) parts.push(`Thickness: ${p.thickness}.`);
  if (p.neck_finish) parts.push(`Neck finish: ${p.neck_finish}.`);
  if (p.closure) parts.push(`Closure: ${p.closure}.`);
  if (p.board) parts.push(`Board: ${p.board}.`);
  if (p.finish) parts.push(`Colour & finish: ${p.finish}.`);
  if (p.printing === 'Yes') parts.push('Custom printing / artwork available.');
  if (p.printing === 'No') parts.push('Plain / blank stock.');
  if (p.food_grade === 'Yes') parts.push('Food grade / food contact.');
  if (p.setup_cost) parts.push(`Setup: ${p.setup_cost}.`);
  if (p.samples === 'Free') parts.push('Free samples available.');
  if (p.samples === 'Paid') parts.push(`Samples priced${p.sample_cost ? ` at ${p.sample_cost}` : ''}.`);
  if (p.lead_time_days) parts.push(`${p.lead_time_days} day lead time.`);
  if (s.pricing.terms) parts.push(`Prices ${termsLabel(s.pricing.terms, s.pricing.port)}.`);
  return parts.join(' ').replace(/\.\./g, '.');
}

/** Build { supplier, files: [{ from, to }], record, warnings } for one submission. */
function toSeed(s, { slug } = {}) {
  const supplierSlug = slug || slugify(s.company.business_name);
  const captured = (s.submitted_at || s.updated_at || new Date().toISOString()).slice(0, 10);
  const sourceFile = `${safeFile(s.ref_id)}.json`;
  const sourceUrl = `/partners/${supplierSlug}/${sourceFile}`;
  const files = [];
  const warnings = [];
  const titles = new Set();

  const products = s.products.filter((p) => p.name && p.category && p.material).map((p, idx) => {
    let title = p.name.trim();
    if (titles.has(title.toLowerCase())) title = `${title} (${[p.capacity, p.dimensions, p.finish].filter(Boolean).join(', ') || idx + 1})`;
    titles.add(title.toLowerCase());

    // Quantity breaks: integers, ascending by minQty, positive prices.
    const breaks = [];
    [...p.tiers].filter((t) => posOrNull(t.unit_price) && intOrNull(t.min_qty))
      .sort((a, b) => a.min_qty - b.min_qty)
      .forEach((t) => {
        const minQty = intOrNull(t.min_qty);
        if (breaks.length && minQty <= breaks[breaks.length - 1].minQty) return;
        let maxQty = intOrNull(t.max_qty);
        if (maxQty != null && maxQty < minQty) maxQty = null;
        breaks.push({ minQty, maxQty, unitPrice: Number(t.unit_price) });
      });

    let priceType = p.price_type || 'EXACT';
    let basePrice = posOrNull(p.price);
    if (basePrice == null && breaks.length) basePrice = Math.min(...breaks.map((b) => b.unitPrice));
    if (priceType !== 'QUOTE_ONLY' && basePrice == null) priceType = 'QUOTE_ONLY';
    if (priceType === 'QUOTE_ONLY') basePrice = null;

    const unit = p.unit || 'piece';
    const terms = s.pricing.terms ? `, ${termsLabel(s.pricing.terms, s.pricing.port)}` : '';
    const images = p.images.map((img, i) => {
      const ext = path.extname(img.name).toLowerCase() || '.jpg';
      const name = safeFile(`${slugify(title).slice(0, 40)}-${i + 1}${ext}`);
      files.push({ from: img.stored_name, to: name });
      return { url: `/partners/${supplierSlug}/${name}`, alt: title, credit: s.company.business_name };
    });

    const product = {
      title,
      description: describe(p, s) || undefined,
      material: p.material,
      ...(p.subcategory ? { subcategory: p.subcategory } : {}),
      categorySlug: p.category,
      priceType,
      basePrice,
      priceBasis: priceType === 'QUOTE_ONLY' ? null : `per ${unit} (${s.pricing.currency}${terms})`,
      priceUnit: null,
      moq: intOrNull(p.moq),
      moqUnit: intOrNull(p.moq) ? (p.moq_unit || 'pieces') : null,
      leadTimeDays: intOrNull(p.lead_time_days),
      stockOrCustom: p.stock_or_custom || (p.printing === 'Yes' ? 'CUSTOM' : 'STOCK'),
      samplePolicyVerified: p.samples === 'Free' || p.samples === 'Paid',
      sourceUrl,
      sourceCapturedAt: captured,
      quantityBreaks: breaks,
      ...(images.length ? { images } : {}),
    };
    if (!product.description) delete product.description;
    return product;
  });

  const skipped = s.products.length - products.length;
  if (skipped) warnings.push(`${skipped} product(s) skipped - missing name, category or material`);
  if (!products.length) warnings.push('No listable products - check the uploaded catalogue / price list');

  const certNames = [...new Set([...(s.company.certifications || []),
    ...String(s.company.certifications_other || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean)])];

  const supplier = {
    slug: supplierSlug,
    name: s.company.business_name,
    website: normaliseWebsite(s.company.website),
    location: [s.company.location, s.company.country].filter(Boolean).join(', ') || 'Unknown',
    legalIdentity: s.company.legal_name || null,
    status: 'PENDING',
    isPartner: false,
    sourceUrl,
    sourceCapturedAt: captured,
    review: null,
    certifications: certNames.map((name) => ({ name, sourceUrl, sourceCapturedAt: captured })),
    products,
  };

  // The submission record that backs every provenance link (no internal tokens).
  const record = {
    reference: s.ref_id, submittedAt: s.submitted_at, updatedAt: s.updated_at,
    note: `Supplied directly by ${s.company.business_name} via the ${config.brand.name} supplier portal.`,
    company: { ...s.company }, pricing: s.pricing,
    products: s.products.map(({ images, image_ids, id, ...p }) => p),
    documents: s.documents.map((d) => ({ name: d.name, type: d.doc_type })),
    notes: s.notes,
  };
  return { supplier, files, record, sourceFile, slug: supplierSlug, warnings };
}

module.exports = { toSeed, slugify };
