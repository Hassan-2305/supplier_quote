// Read a supplier's own spreadsheet (xlsx / csv), find the header row and
// suggest which column is which field. The browser shows the mapping for the
// supplier to confirm, then builds product cards from the rows.
const ExcelJS = require('exceljs');
const { Readable } = require('stream');
const config = require('../config');

const MAX_ROWS = 1000;

// Field → header synonyms (lower-case, matched as whole words / prefixes).
const FIELD_SYNONYMS = {
  name: ['product name', 'product', 'name', 'item name', 'item', 'title', 'description of goods', 'product title', 'goods', '品名', '产品名称', '名称'],
  sku: ['sku', 'item no', 'item #', 'item number', 'model', 'model no', 'part number', 'part no', 'code', 'product code', 'ref', '型号', '货号'],
  category: ['category', 'product type', 'type of product', 'class', '类别', '分类'],
  subcategory: ['type', 'style', 'shape', 'sub category', 'subcategory'],
  material: ['material', 'materials', 'resin', 'substrate', '材质', '材料'],
  capacity: ['capacity', 'volume', 'size (ml)', 'ml', 'oz', 'fill volume', 'content', '容量'],
  dimensions: ['dimensions', 'dimension', 'size', 'measurements', 'l x w x h', 'lxwxh', '尺寸', '规格'],
  thickness: ['thickness', 'gauge', 'mil', 'micron', '厚度'],
  neck_finish: ['neck', 'neck finish', 'neck size', 'finish (neck)', 'thread', '口径'],
  closure: ['closure', 'cap', 'lid', 'closure type'],
  finish: ['color', 'colour', 'finish', 'colors', 'colours', '颜色'],
  price: ['price', 'unit price', 'price/unit', 'price per unit', 'cost', 'usd', 'fob price', 'exw price', 'price (usd)', '单价', '价格'],
  unit: ['unit', 'uom', 'per', 'price unit', 'unit of measure', '单位'],
  moq: ['moq', 'minimum order', 'min order', 'minimum', 'min qty', 'minimum quantity', '起订量', '最小起订量'],
  lead_time_days: ['lead time', 'leadtime', 'production time', 'delivery time', 'lead time (days)', '交期', '生产周期'],
  description: ['description', 'details', 'notes', 'remarks', 'features', 'specification', 'specs', '描述', '备注'],
  image: ['image', 'image url', 'photo', 'picture', 'image link', 'img', 'photo url', '图片'],
};

function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if (v.text != null) return String(v.text);          // hyperlink
    if (v.hyperlink) return String(v.hyperlink);
    if (v.result != null) return String(v.result);       // formula
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (v.error) return '';
  }
  return String(v);
}
const norm = (s) => String(s || '').toLowerCase().replace(/[_*:#()\[\].]/g, ' ').replace(/\s+/g, ' ').trim();

function scoreHeader(h, syn) {
  const n = norm(h);
  if (!n) return 0;
  let best = 0;
  for (const s of syn) {
    if (n === s) best = Math.max(best, 3);
    else if (n.startsWith(s + ' ') || n.endsWith(' ' + s)) best = Math.max(best, 2);
    else if (new RegExp(`(^|\\s)${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(n)) best = Math.max(best, 1);
  }
  return best;
}

// A header like "1,000 pcs", "5000+", "Qty 10000", "MOQ 3000" over a numeric column = a price slab.
function tierQty(h) {
  const n = norm(h).replace(/,/g, '');
  const m = n.match(/^(?:qty|quantity|moq|@|price @|price at|price for)?\s*(\d+(?:\.\d+)?)\s*(k)?\s*(?:pcs|pc|pieces|units|unit|\+|and up|or more)?\s*(?:price)?$/);
  if (!m) return null;
  const q = Number(m[1]) * (m[2] ? 1000 : 1);
  return q >= 1 ? Math.round(q) : null;
}
const numeric = (v) => /^\s*[$¥€£]?\s*\d[\d,]*(\.\d+)?\s*$/.test(v);

function suggestMapping(headers, rows) {
  const mapping = {};
  const used = new Set();
  // Price slab columns first ("Price @1,000", "5000 pcs"), so they aren't taken as the single price.
  const tiers = [];
  headers.forEach((h, i) => {
    const q = tierQty(h);
    if (q == null) return;
    const vals = rows.map((r) => r[i]).filter(Boolean);
    if (vals.length && vals.filter(numeric).length / vals.length >= 0.6) { tiers.push({ col: i, min_qty: q }); used.add(i); }
  });
  tiers.sort((a, b) => a.min_qty - b.min_qty);
  // Highest-scoring assignment first.
  const cands = [];
  headers.forEach((h, i) => {
    if (used.has(i)) return;
    for (const [field, syn] of Object.entries(FIELD_SYNONYMS)) {
      const s = scoreHeader(h, syn);
      if (s) cands.push({ field, i, s });
    }
  });
  cands.sort((a, b) => b.s - a.s || a.i - b.i);
  for (const c of cands) {
    if (mapping[c.field] != null || used.has(c.i)) continue;
    mapping[c.field] = c.i;
    used.add(c.i);
  }
  // No name column? Use the first mostly-text column.
  if (mapping.name == null) {
    const i = headers.findIndex((h, idx) => !used.has(idx) && rows.slice(0, 20).filter((r) => r[idx] && !numeric(r[idx])).length >= Math.min(3, rows.length));
    if (i >= 0) mapping.name = i;
  }
  return { mapping, tiers };
}

async function readWorkbook(buffer, filename) {
  const wb = new ExcelJS.Workbook();
  if (/\.csv$/i.test(filename)) {
    let text = buffer.toString('utf8').replace(/^﻿/, '');
    // Semicolon CSV (common in Europe)?
    const first = text.split(/\r?\n/, 1)[0] || '';
    const delimiter = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
    await wb.csv.read(Readable.from([text]), { parserOptions: { delimiter }, map: (v) => v });
  } else {
    await wb.xlsx.load(buffer);
  }
  return wb;
}

async function parseSheet(buffer, filename) {
  if (/\.xls$/i.test(filename)) throw new Error('Old .xls files aren’t supported. Please save as .xlsx or .csv and upload again.');
  if (!/\.(xlsx|xlsm|csv)$/i.test(filename)) throw new Error('Please upload an Excel (.xlsx) or CSV file.');
  let wb;
  try { wb = await readWorkbook(buffer, filename); } catch { throw new Error('We couldn’t read that file. Please save it as .xlsx or .csv and try again.'); }

  // Read every sheet; pick the one whose header row looks most like a product list.
  const sheets = [];
  wb.eachSheet((ws) => {
    const grid = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (grid.length > MAX_ROWS + 20) return;
      const vals = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => { vals[col - 1] = cellText(cell.value).trim(); });
      if (vals.some(Boolean)) grid.push(Array.from(vals, (v) => v || ''));
    });
    sheets.push({ name: ws.name, grid });
  });
  const rowScore = (r) => r.reduce((s, h) => s + Math.max(0, ...Object.values(FIELD_SYNONYMS).map((syn) => scoreHeader(h, syn)), tierQty(h) ? 2 : 0), 0)
    + r.filter(Boolean).length * 0.1;
  for (const sh of sheets) {
    sh.headerIdx = 0;
    sh.score = -1;
    sh.grid.slice(0, 15).forEach((r, idx) => { const sc = rowScore(r); if (sc > sh.score) { sh.score = sc; sh.headerIdx = idx; } });
    if (sh.grid.length - sh.headerIdx < 2) sh.score = -1;
  }
  const sheet = sheets.sort((a, b) => b.score - a.score || b.grid.length - a.grid.length)[0];
  if (!sheet || sheet.score < 0) throw new Error('That file looks empty. Make sure the first sheet has a header row and products below it.');
  const headerIdx = sheet.headerIdx;
  const width = Math.max(...sheet.grid.slice(headerIdx, headerIdx + 50).map((r) => r.length));
  const headers = Array.from({ length: width }, (_, i) => sheet.grid[headerIdx][i] || `Column ${i + 1}`);
  const rows = sheet.grid.slice(headerIdx + 1).map((r) => Array.from({ length: width }, (_, i) => (r[i] || '').slice(0, 1000)))
    .filter((r) => r.some(Boolean)).slice(0, MAX_ROWS);
  const { mapping, tiers } = suggestMapping(headers, rows);
  return { sheet: sheet.name, headers, rows, mapping, tiers, total: rows.length, truncated: sheet.grid.length - headerIdx - 1 > MAX_ROWS };
}

// Downloadable template with a category dropdown.
async function template() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Products', { views: [{ state: 'frozen', ySplit: 1 }] });
  const cols = [
    ['Product name', 40], ['SKU / model', 14], ['Category', 34], ['Material', 18], ['Capacity', 12], ['Size (L x W x H)', 18],
    ['Thickness', 12], ['Neck finish', 12], ['Closure', 16], ['Color / finish', 16], ['Unit price', 11], ['Price per', 10],
    ['1000 pcs', 10], ['5000 pcs', 10], ['10000 pcs', 10], ['MOQ', 10], ['Lead time (days)', 14], ['Description', 40], ['Image URL', 30],
  ];
  ws.columns = cols.map(([header, width]) => ({ header, width }));
  ws.addRow(['8 oz Clear PET Boston Round Bottle', 'BR-8-24', 'Plastic Bottles', 'PET', '8 oz', '', '', '24-410', 'Cap sold separately', 'Clear',
    0.42, 'piece', 0.38, 0.33, 0.29, 1000, 15, 'BPA-free, FDA food contact compliant', '']);
  ws.addRow(['Kraft Stand-Up Pouch with Zipper', 'SUP-KR-250', 'Flexible Pouches & Bags', 'Kraft paper / PE', '250 g', '5.9 x 8.6 x 3.1 in', '4 mil', '', 'Zipper', 'Natural kraft',
    0.18, 'piece', 0.16, 0.12, 0.09, 5000, 20, 'Custom printing available', '']);
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4A3F' } };
  [2, 3].forEach((r) => { ws.getRow(r).font = { italic: true, color: { argb: 'FF7C8582' } }; });

  const lists = wb.addWorksheet('Categories');
  lists.getColumn(1).width = 50;
  lists.addRow(['Category (use one of these)']).font = { bold: true };
  config.categories.forEach((c) => lists.addRow([c.name]));
  const ref = `Categories!$A$2:$A$${config.categories.length + 1}`;
  for (let r = 2; r <= 1000; r++) {
    ws.getCell(`C${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: [ref], showErrorMessage: false };
  }
  const help = wb.addWorksheet('How to use');
  help.getColumn(1).width = 110;
  [
    'How to fill in this template',
    '',
    '• One row per product (or per size). The grey rows on the Products sheet are examples, so delete or overwrite them.',
    '• Only Product name, Category, Material and a price are needed. Leave anything else blank if you don’t know it.',
    '• "1000 pcs", "5000 pcs", "10000 pcs" are bulk price slabs (unit price at that quantity). Rename or add columns like "20000 pcs" as needed.',
    '• Image URL: a link to a product photo (optional). You can also add photos in the form after importing.',
    '• Already have your own price list? Upload that instead. We’ll match the columns automatically and you can adjust them.',
  ].forEach((t, i) => { const row = help.addRow([t]); if (i === 0) row.font = { bold: true, size: 13 }; });
  return wb.xlsx.writeBuffer();
}

module.exports = { parseSheet, template, tierQty, suggestMapping };
