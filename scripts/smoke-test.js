// End-to-end API smoke test against a throwaway data directory.
// Optional: SEED_SCHEMA_CHECK=<path to dir with seed-schema.ts + zod> also validates
// the Aekobaba export against the real seed schema.
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supplydesk-'));
process.env.DATA_DIR = dir;
process.env.ADMIN_PASSWORD = 'test-password';
const app = require('../server');

(async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const j = async (method, url, body, headers = {}) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  const step = (s) => console.log('  ✓', s);
  try {
    const cfg = await j('GET', '/api/config');
    assert.equal(cfg.status, 200);
    assert.ok(cfg.body.categories.some((c) => c.slug === 'pouches-bags')); step('config has Aekobaba categories');

    const up = async (name, content, kind) => {
      const fd = new FormData();
      fd.append('kind', kind);
      fd.append('file', new Blob([content]), name);
      const r = await fetch(`${base}/api/files`, { method: 'POST', body: fd });
      return { status: r.status, body: await r.json() };
    };
    const doc = await up('Price list 2026.xlsx', 'fake-xlsx', 'document');
    const img = await up('Kraft Pouch (front).png', 'fake-png', 'product_image');
    assert.equal(doc.status, 200); assert.equal(img.status, 200); step('uploads');
    assert.equal((await up('evil.exe', 'x', 'document')).status, 400); step('reject disallowed file type');

    const invalid = await j('POST', '/api/submissions', { action: 'submit', data: {
      company: { business_name: 'Acme' }, products: [{ name: 'Pouch' }] } });
    assert.equal(invalid.status, 422);
    for (const k of ['company.email', 'company.location', 'products.0.category', 'products.0.material', 'products.0.price', 'company.country']) assert.ok(invalid.body.errors[k], k);
    step('validation (company + product essentials)');

    const products = [
      { name: '250 g Kraft stand-up pouch with zip', category: 'pouches-bags', material: 'Kraft paper / PE', subcategory: 'Stand-up pouch',
        dimensions: '150 x 220 x 80 mm', thickness: '120 micron', closure: 'Zip lock', finish: 'Natural kraft', stock_or_custom: 'STOCK',
        printing: 'Yes', food_grade: 'Yes', price_type: 'EXACT', price: '$0.65', unit: 'piece', moq: '1,000 pcs', lead_time_days: '10',
        samples: 'Paid', sample_cost: '$25', setup_cost: '$150 per color plate',
        tiers: [{ min_qty: '5000', max_qty: '9999', unit_price: '0.59' }, { min_qty: '10000', unit_price: '0.52' }], image_ids: [img.body.id] },
      { name: '500 ml PET bottle', category: 'plastic-bottles', material: 'PET', capacity: '500 ml', neck_finish: '28 mm', price_type: 'QUOTE_ONLY', moq: '5000' },
    ];
    const draft = await j('POST', '/api/submissions', { action: 'draft', data: { company: { business_name: 'Acme Packaging', email: 'sales@acme.test' }, products, documents: [{ file_id: doc.body.id, doc_type: 'Price list' }] } });
    assert.equal(draft.status, 200);
    assert.equal(draft.body.status, 'draft'); step(`save draft (${draft.body.ref_id})`);

    const loaded = (await j('GET', `/api/submission/${draft.body.edit_token}`)).body;
    assert.equal(loaded.products[0].price, 0.65);
    assert.equal(loaded.products[0].moq, 1000);
    assert.equal(loaded.products[0].tiers.length, 2);
    assert.equal(loaded.products[0].images.length, 1);
    assert.equal(loaded.products[1].price, null);
    assert.equal(loaded.documents.length, 1); step('load draft via edit link');

    assert.equal((await j('GET', `/api/files/${doc.body.id}`)).status, 404);
    assert.equal((await j('GET', `/api/files/${doc.body.id}?k=${draft.body.edit_token}`)).status, 200); step('file access requires edit token');

    const full = { company: { business_name: 'Acme Packaging', contact_person: 'Ravi', email: 'sales@acme.test', phone: '+86 138 0000 0000',
      country: 'China', location: 'Ningbo, Zhejiang', website: 'acmepack.cn', legal_name: 'Ningbo Acme Packaging Co., Ltd.', certifications: ['ISO 9001', 'BRCGS Packaging'], certifications_other: 'FDA registered' },
      pricing: { currency: 'USD', terms: 'FOB', port: 'Ningbo' }, products, documents: [{ file_id: doc.body.id, doc_type: 'Price list' }], notes: 'We also make labels.', consent: true };
    const sub = await j('PUT', `/api/submission/${draft.body.edit_token}`, { action: 'submit', data: full });
    assert.equal(sub.status, 200);
    assert.equal(sub.body.status, 'submitted'); step('submit');

    const login = await fetch(`${base}/admin/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }) });
    const A = { Cookie: login.headers.get('set-cookie').split(';')[0] };
    assert.equal((await j('GET', '/admin/api/stats')).status, 401); step('admin auth');

    const inv = await j('POST', '/admin/api/invites', { supplier_name: 'Beta Boxes', contact_email: 'hi@beta.test' }, A);
    const invTok = inv.body.url.split('/s/')[1];
    const sub2 = await j('POST', '/api/submissions', { action: 'submit', invite_token: invTok, data: {
      company: { business_name: 'Beta Boxes', contact_person: 'Mei', email: 'hi@beta.test', phone: '123', country: 'United States', location: 'Chicago, IL' }, pricing: { currency: 'USD', terms: 'DELIVERED' },
      products: [{ name: 'Kraft pouch premium', category: 'pouches-bags', material: 'Kraft', price: '5.75', price_type: 'FROM' }], consent: true } });
    assert.equal(sub2.status, 200);
    assert.equal((await j('GET', `/api/invite/${invTok}`)).body.edit_token, sub2.body.edit_token); step('invite flow');

    const stats = (await j('GET', '/admin/api/stats', null, A)).body;
    assert.equal(stats.submitted, 2);
    assert.equal(stats.categories.find((c) => c.category === 'pouches-bags').name, 'Flexible Pouches & Bags'); step('stats');
    const list = (await j('GET', '/admin/api/submissions?q=kraft', null, A)).body;
    assert.equal(list.length, 2);
    assert.equal((await j('GET', '/admin/api/submissions?country=United%20States', null, A)).body.length, 1); step('search & filter');
    const acme = list.find((r) => r.ref_id === draft.body.ref_id);

    const cmp = (await j('GET', '/admin/api/compare?category=pouches-bags', null, A)).body;
    assert.equal(Math.min(...cmp.map((r) => r.unit_price)), 0.52); step('price comparison');

    const prev = (await j('GET', `/admin/api/submissions/${acme.id}/aekobaba-preview`, null, A)).body;
    const sp = prev.supplier;
    assert.equal(sp.slug, 'acme-packaging');
    assert.equal(sp.website, 'https://acmepack.cn/');
    assert.equal(sp.location, 'Ningbo, Zhejiang, China');
    assert.equal(sp.products.length, 2);
    assert.equal(sp.products[0].priceType, 'EXACT');
    assert.equal(sp.products[0].basePrice, 0.65);
    assert.equal(sp.products[0].priceBasis, 'per piece (USD, FOB Ningbo)');
    assert.deepEqual(sp.products[0].quantityBreaks, [{ minQty: 5000, maxQty: 9999, unitPrice: 0.59 }, { minQty: 10000, maxQty: null, unitPrice: 0.52 }]);
    assert.match(sp.products[0].images[0].url, /^\/partners\/acme-packaging\/[A-Za-z0-9._-]+$/);
    assert.ok(sp.products[0].description.includes('Thickness: 120 micron.'));
    assert.equal(sp.products[1].priceType, 'QUOTE_ONLY');
    assert.equal(sp.products[1].basePrice, null);
    assert.equal(sp.certifications.length, 3); step('aekobaba mapping');

    const zip = await j('GET', `/admin/api/submissions/${acme.id}/aekobaba.zip`, null, A);
    assert.equal(zip.body.subarray(0, 2).toString(), 'PK'); step(`aekobaba zip (${zip.body.length} bytes)`);
    const all = (await j('GET', '/admin/api/aekobaba.json', null, A)).body;
    assert.equal(all.suppliers.length, 2); step('aekobaba seed JSON (all suppliers)');

    if (process.env.SEED_SCHEMA_CHECK) {
      const checkDir = process.env.SEED_SCHEMA_CHECK;
      const seedFile = path.join(checkDir, 'candidate.json');
      fs.writeFileSync(seedFile, JSON.stringify({ meta: { name: 'test', transcribedAt: '2026-11-09', sources: ['portal'] },
        categories: cfg.body.categories.map((c) => ({ slug: c.slug, name: c.name, description: null, parentSlug: null })), suppliers: all.suppliers }));
      fs.writeFileSync(path.join(checkDir, 'check.ts'),
        "import { parseSeedFile } from './seed-schema.ts';\nimport fs from 'node:fs';\nparseSeedFile(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));\nconsole.log('valid');\n");
      const out = execFileSync(process.execPath, ['--no-warnings', path.join(checkDir, 'check.ts'), seedFile], { cwd: checkDir }).toString();
      assert.ok(out.includes('valid')); step('export passes Aekobaba seed-schema.ts validation');
    }

    assert.equal((await j('GET', '/admin/api/export.xlsx', null, A)).body.subarray(0, 2).toString(), 'PK'); step('excel export');
    assert.ok((await j('GET', '/admin/api/export.csv?type=products', null, A)).body.toString().includes('Stand-up pouch')); step('csv export');

    // Website import: guessing rules + SSRF guard (offline)
    const si = require('../lib/site-import');
    assert.equal(si.guessCategory('16 oz Clear PET Round Jar 89-400'), 'plastic-jars');
    assert.equal(si.guessCategory('4 oz Amber Glass Boston Round Bottle'), 'glass-bottles');
    assert.equal(si.guessCategory('Kraft Stand Up Pouch with Zipper'), 'pouches-bags');
    assert.equal(si.guessCategory('28-410 Black Ribbed Cap'), 'closures');
    assert.equal(si.guessCategory('24-410 White Lotion Pump'), 'pumps-sprayers');
    assert.equal(si.guessCategory('Corrugated Mailer Box'), 'mailers');
    assert.equal(si.guessMaterial('Clear Glass Jar'), 'Clear glass');
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1'])
      assert.ok(si.isPrivateIp(ip), ip);
    assert.ok(!si.isPrivateIp('93.184.216.34'));
    for (const u of ['http://127.0.0.1/', 'http://169.254.169.254/', 'http://example.com:8080/', 'ftp://example.com/'])
      await assert.rejects(si.safeGet(u), u);
    assert.equal((await j('POST', '/api/site-import', { url: 'http://10.0.0.1' })).status, 422);
    step('website import: category/material guessing + private-address blocking');

    // Spreadsheet import: template round-trip + a messy factory sheet
    const tpl = await j('GET', '/api/sheet-template.xlsx');
    assert.equal(tpl.body.subarray(0, 2).toString(), 'PK');
    const sheetUp = async (name, buf) => { const fd = new FormData(); fd.append('file', new Blob([buf]), name); const r = await fetch(base + '/api/sheet-import', { method: 'POST', body: fd }); return { status: r.status, body: await r.json() }; };
    const t1 = await sheetUp('product-template.xlsx', tpl.body);
    assert.equal(t1.status, 200); assert.equal(t1.body.sheet, 'Products'); assert.equal(t1.body.total, 2);
    assert.equal(t1.body.tiers.length, 3); assert.ok(t1.body.mapping.name === 0 && t1.body.mapping.price === 10);
    const ExcelJS = require('exceljs'); const wbm = new ExcelJS.Workbook(); const wsm = wbm.addWorksheet('Quote');
    wsm.addRow(['XYZ PACKAGING CO., LTD']); wsm.addRow([]);
    wsm.addRow(['Item No.', 'Description of goods', 'Material', 'Volume', 'MOQ (pcs)', 'Price @1,000', 'Price @ 10,000']);
    wsm.addRow(['A-1', '30ml Amber Glass Dropper Bottle', 'Glass', '30ml', '5,000', '$0.32', '$0.25']);
    const t2 = await sheetUp('quote.xlsx', Buffer.from(await wbm.xlsx.writeBuffer()));
    assert.equal(t2.body.mapping.name, 1); assert.equal(t2.body.mapping.sku, 0); assert.equal(t2.body.mapping.price, undefined);
    assert.deepEqual(t2.body.tiers.map((x) => x.min_qty), [1000, 10000]);
    const t3 = await sheetUp('list.csv', Buffer.from('Product;Price;MOQ\n"4 oz PET Jar";0,28;1000\n'));
    assert.equal(t3.status, 200); assert.equal(t3.body.total, 1);
    assert.equal((await sheetUp('old.xls', Buffer.from('x'))).status, 422);
    step('spreadsheet import: template, messy factory sheet, CSV, .xls rejected');

    const edited = await j('PUT', `/api/submission/${draft.body.edit_token}`, { action: 'submit', data: { ...full, documents: [] } });
    assert.equal(edited.body.status, 'submitted');
    assert.equal((await j('GET', `/api/submission/${draft.body.edit_token}`)).body.documents.length, 0); step('edit removes deleted files');

    console.log('\nAll smoke tests passed.');
  } catch (e) {
    console.error('\nSMOKE TEST FAILED:', e);
    process.exitCode = 1;
  } finally {
    server.close();
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(); }, 200);
  }
})();
