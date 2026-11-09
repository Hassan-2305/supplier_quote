// Excel / CSV export of everything in the database.
const ExcelJS = require('exceljs');
const { db } = require('../db');
const { load, termsLabel } = require('./submissions');

async function allSubmissions() {
  const rows = await db.all('SELECT * FROM submissions ORDER BY created_at DESC');
  const out = [];
  for (const row of rows) out.push({ row, s: await load(row) });
  return out;
}
const termsOf = (s) => termsLabel(s.pricing.terms, s.pricing.port);
const priceTypeLabel = (t) => ({ EXACT: 'Fixed', FROM: 'Starts from', QUOTE_ONLY: 'On request' }[t] || '');

const SUPPLIER_COLUMNS = [
  ['Reference ID', (r) => r.ref_id],
  ['Status', (r) => r.status],
  ['Review status', (r) => r.review_status],
  ['Company', (r, s) => s.company.business_name],
  ['Registered company name', (r, s) => s.company.legal_name],
  ['Contact', (r, s) => s.company.contact_person],
  ['Email', (r, s) => s.company.email],
  ['Phone', (r, s) => s.company.phone],
  ['Country', (r, s) => s.company.country],
  ['City', (r, s) => s.company.location],
  ['Website', (r, s) => s.company.website],
  ['Certifications', (r, s) => [...(s.company.certifications || []), s.company.certifications_other].filter(Boolean).join(', ')],
  ['Currency', (r, s) => s.pricing.currency],
  ['Price terms', (r, s) => termsOf(s)],
  ['Products', (r, s) => s.products.length],
  ['Categories', (r, s) => [...new Set(s.products.map((p) => p.category_name).filter(Boolean))].join(', ')],
  ['Documents', (r, s) => s.documents.map((d) => `${d.doc_type}: ${d.name}`).join('; ')],
  ['Notes from supplier', (r, s) => s.notes],
  ['Admin notes', (r) => r.admin_notes],
  ['Submitted', (r) => r.submitted_at],
  ['Last updated', (r) => r.updated_at],
];

const PRODUCT_COLUMNS = [
  ['Reference ID', (r) => r.ref_id], ['Supplier', (r, s) => s.company.business_name], ['Country', (r, s) => s.company.country],
  ['Product', (r, s, p) => p.name], ['Category', (r, s, p) => p.category_name], ['Type', (r, s, p) => p.subcategory],
  ['Material', (r, s, p) => p.material], ['Colour / finish', (r, s, p) => p.finish], ['Capacity', (r, s, p) => p.capacity],
  ['Dimensions', (r, s, p) => p.dimensions], ['Thickness', (r, s, p) => p.thickness], ['Neck finish', (r, s, p) => p.neck_finish],
  ['Closure', (r, s, p) => p.closure], ['Board / flute', (r, s, p) => p.board],
  ['Stock / custom', (r, s, p) => (p.stock_or_custom === 'CUSTOM' ? 'Made to order' : p.stock_or_custom === 'STOCK' ? 'Ready stock' : '')],
  ['Custom printing', (r, s, p) => p.printing], ['Food grade', (r, s, p) => p.food_grade],
  ['Price type', (r, s, p) => priceTypeLabel(p.price_type)], ['Price', (r, s, p) => p.price], ['Currency', (r, s) => s.pricing.currency],
  ['Per', (r, s, p) => p.unit || 'piece'], ['Price terms', (r, s) => termsOf(s)],
  ['MOQ', (r, s, p) => p.moq], ['MOQ unit', (r, s, p) => p.moq_unit], ['Lead time (days)', (r, s, p) => p.lead_time_days],
  ['Samples', (r, s, p) => p.samples], ['Sample cost', (r, s, p) => p.sample_cost], ['Setup / plate cost', (r, s, p) => p.setup_cost],
  ['Price slabs', (r, s, p) => p.tiers.length], ['Images', (r, s, p) => p.images.length], ['Description', (r, s, p) => p.description],
];

const TIER_COLUMNS = [
  ['Reference ID', (r) => r.ref_id], ['Supplier', (r, s) => s.company.business_name], ['Product', (r, s, p) => p.name],
  ['Category', (r, s, p) => p.category_name], ['Min qty', (r, s, p, t) => t.min_qty], ['Max qty', (r, s, p, t) => t.max_qty],
  ['Unit price', (r, s, p, t) => t.unit_price], ['Currency', (r, s) => s.pricing.currency], ['Per', (r, s, p) => p.unit || 'piece'],
  ['Price terms', (r, s) => termsOf(s)],
];

async function rowsFor(kind, all) {
  const out = [];
  for (const { row, s } of all || await allSubmissions()) {
    if (kind === 'suppliers') out.push(SUPPLIER_COLUMNS.map(([, f]) => f(row, s)));
    if (kind === 'products') s.products.forEach((p) => out.push(PRODUCT_COLUMNS.map(([, f]) => f(row, s, p))));
    if (kind === 'prices') s.products.forEach((p) => p.tiers.forEach((t) => out.push(TIER_COLUMNS.map(([, f]) => f(row, s, p, t)))));
    if (kind === 'documents') s.documents.forEach((d) => out.push([row.ref_id, s.company.business_name, d.doc_type, d.name, d.size]));
  }
  return out;
}
const HEADERS = {
  suppliers: SUPPLIER_COLUMNS.map((c) => c[0]),
  products: PRODUCT_COLUMNS.map((c) => c[0]),
  prices: TIER_COLUMNS.map((c) => c[0]),
  documents: ['Reference ID', 'Supplier', 'Document type', 'File name', 'Size (bytes)'],
};

async function toXlsx(brandName) {
  const wb = new ExcelJS.Workbook();
  wb.creator = brandName;
  wb.created = new Date();
  const all = await allSubmissions();
  const sheets = [['Suppliers', 'suppliers'], ['Products', 'products'], ['Price slabs', 'prices'], ['Documents', 'documents']];
  for (const [title, kind] of sheets) {
    const ws = wb.addWorksheet(title, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.addRow(HEADERS[kind]);
    (await rowsFor(kind, all)).forEach((r) => ws.addRow(r));
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3D36' } };
    ws.columns.forEach((col, i) => {
      const lens = [HEADERS[kind][i].length];
      col.eachCell({ includeEmpty: false }, (c) => lens.push(String(c.value ?? '').length));
      col.width = Math.min(60, Math.max(10, Math.max(...lens) + 2));
    });
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: HEADERS[kind].length } };
  }
  return wb.xlsx.writeBuffer();
}

async function toCsv(kind) {
  if (!HEADERS[kind]) throw new Error('Unknown export type');
  const esc = (v) => {
    if (v == null) return '';
    let s = String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [HEADERS[kind], ...(await rowsFor(kind))].map((r) => r.map(esc).join(','));
  return '﻿' + lines.join('\r\n');
}

module.exports = { toXlsx, toCsv };
