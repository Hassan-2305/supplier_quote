/* Admin dashboard - hash-routed single page */
(function () {
  const { $, $$, api, toast, esc, bytes, ext, fmtDate } = window.SD;
  const app = $('#app');
  let brand = { name: 'Aekobaba' };
  let stats = null;

  const money = (v, cur) => (v == null || v === '' ? '' : `${cur ? esc(cur) + ' ' : ''}${Number(v).toLocaleString(undefined, { maximumFractionDigits: 4 })}`);
  const numf = (v) => (v == null || v === '' ? '' : Number(v).toLocaleString());
  const qtyRange = (a, b) => (a == null && b == null ? '' : b == null ? `${numf(a)}+` : `${numf(a ?? 0)} – ${numf(b)}`);
  const statusBadge = (s) => `<span class="badge ${esc(s)}">${s === 'submitted' ? 'Submitted' : 'Draft'}</span>`;
  const reviewBadge = (r) => `<span class="badge r-${esc(String(r).replace(/\s+/g, '-'))}">${esc(r)}</span>`;
  const fileHref = (id, inline) => `/admin/api/files/${encodeURIComponent(id)}${inline ? '?inline=1' : ''}`;
  const isImg = (name) => ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext(name));

  function confirmModal(title, text, okLabel = 'Confirm', danger) {
    return new Promise((resolve) => {
      const w = document.createElement('div');
      w.className = 'modal-backdrop';
      w.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><h3>${esc(title)}</h3><p>${esc(text)}</p>
        <div class="modal-actions"><button class="btn" data-r="0">Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-r="1">${esc(okLabel)}</button></div></div>`;
      document.body.appendChild(w);
      const done = (v) => { w.remove(); resolve(v); };
      w.addEventListener('click', (e) => { if (e.target === w) done(false); const b = e.target.closest('[data-r]'); if (b) done(b.dataset.r === '1'); });
    });
  }

  async function guarded(fn) {
    try { await fn(); } catch (e) {
      if (e.status === 401) return renderLogin();
      app.innerHTML = `<div class="wrap"><div class="panel empty">${esc(e.message)}</div></div>`;
    }
  }

  // ------------------------------------------------------------ login
  function renderLogin() {
    $('#topbar').hidden = true;
    app.innerHTML = `<div class="login"><div class="side-card">
      <div class="brand" style="margin-bottom:22px"><span class="brand-mark">${esc(brand.name.charAt(0))}</span><span class="brand-name">${esc(brand.name)}</span></div>
      <h1>Admin sign in</h1><p style="color:var(--ink-2);margin:0 0 20px">View and compare supplier submissions.</p>
      <form id="loginForm"><div class="field"><label for="pw">Password</label><input type="password" id="pw" autocomplete="current-password" required></div>
      <div class="form-error" id="loginErr" hidden></div>
      <button class="btn btn-primary" style="width:100%;margin-top:16px" type="submit">Sign in</button></form></div></div>`;
    $('#pw').focus();
    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('/admin/api/login', { method: 'POST', json: { password: $('#pw').value } }); route(); }
      catch (err) { const el = $('#loginErr'); el.textContent = err.message; el.hidden = false; }
    });
  }

  // ------------------------------------------------------------ suppliers list
  const listState = { q: '', status: '', review: '', country: '', category: '' };

  async function renderSuppliers() {
    stats = await api('/admin/api/stats');
    app.innerHTML = `<div class="wrap">
      <div class="page-head"><div><h1>Suppliers</h1><p>All supplier submissions, newest first.</p></div>
        <div class="actions">
          <a class="btn btn-primary" href="/admin/api/aekobaba.json" title="All submitted suppliers in Aekobaba seed format"><svg class="i"><use href="#i-download"/></svg>Aekobaba seed JSON</a>
          <a class="btn" href="/admin/api/export.xlsx"><svg class="i"><use href="#i-download"/></svg>Excel</a>
          <select id="csvExport" class="btn" style="width:auto;padding-right:34px" aria-label="Export CSV">
            <option value="">Export CSV…</option><option value="suppliers">Suppliers CSV</option><option value="products">Products CSV</option>
            <option value="prices">Price tiers CSV</option><option value="documents">Documents CSV</option></select>
        </div></div>
      <div class="stats">
        <div class="stat"><small>Submitted</small><strong>${stats.submitted}</strong><span>${stats.readyToList} ready to list / listed</span></div>
        <div class="stat"><small>Drafts (incomplete)</small><strong>${stats.drafts}</strong><span>saved, not submitted</span></div>
        <div class="stat"><small>Products listed</small><strong>${stats.products}</strong><span>${stats.categories.length} categories</span></div>
        <div class="stat"><small>Invites pending</small><strong>${stats.invitesPending}</strong><span>${stats.invitesOpened} opened, not started</span></div>
        <div class="stat"><small>Categories</small><strong>${stats.categories.length}</strong><span>${esc(stats.categories.slice(0, 2).map((c) => c.name).join(', '))}</span></div>
      </div>
      <div class="panel">
        <div class="filters">
          <input type="search" id="fq" placeholder="Search suppliers, products, materials, reference ID…" value="${esc(listState.q)}">
          <select id="fstatus"><option value="">All statuses</option><option value="submitted">Submitted</option><option value="draft">Drafts</option></select>
          <select id="freview"><option value="">Any review status</option>${stats.reviewStatuses.map((r) => `<option>${esc(r)}</option>`).join('')}</select>
          <select id="fcountry"><option value="">All countries</option>${stats.countries.map((c) => `<option>${esc(c.country)}</option>`).join('')}</select>
          <select id="fcategory"><option value="">All categories</option>${stats.categories.map((c) => `<option value="${esc(c.category)}">${esc(c.name)}</option>`).join('')}</select>
        </div>
        <div class="table-scroll"><table class="data"><thead><tr>
          <th>Supplier</th><th>Contact</th><th>Location</th><th>Categories</th><th class="num">Products</th><th class="num">Files</th><th>Status</th><th>Review</th><th>Updated</th>
        </tr></thead><tbody id="rows"><tr><td colspan="9" class="empty">Loading…</td></tr></tbody></table></div>
      </div></div>`;
    $('#fstatus').value = listState.status; $('#freview').value = listState.review;
    $('#fcountry').value = listState.country; $('#fcategory').value = listState.category;
    let t;
    $('#fq').addEventListener('input', (e) => { listState.q = e.target.value; clearTimeout(t); t = setTimeout(loadRows, 250); });
    [['#fstatus', 'status'], ['#freview', 'review'], ['#fcountry', 'country'], ['#fcategory', 'category']].forEach(([s, k]) =>
      $(s).addEventListener('change', (e) => { listState[k] = e.target.value; loadRows(); }));
    $('#csvExport').addEventListener('change', (e) => { if (e.target.value) location.href = `/admin/api/export.csv?type=${e.target.value}`; e.target.value = ''; });
    await loadRows();
  }

  async function loadRows() {
    const qs = new URLSearchParams(Object.entries(listState).filter(([, v]) => v)).toString();
    const rows = await api(`/admin/api/submissions${qs ? '?' + qs : ''}`);
    const body = $('#rows');
    if (!body) return;
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="9" class="empty">${Object.values(listState).some(Boolean) ? 'No suppliers match these filters.' : 'No submissions yet. Share the form link or create invitations to get started.'}</td></tr>`;
      return;
    }
    body.innerHTML = rows.map((r) => `<tr class="clickable" data-id="${r.id}">
      <td><div class="strong">${esc(r.business_name || '(no name yet)')}</div><div class="muted">${esc(r.ref_id)}</div></td>
      <td>${esc(r.contact_person)}<div class="muted">${esc(r.email)}</div></td>
      <td>${esc([r.city, r.country].filter(Boolean).join(', '))}</td>
      <td class="muted">${esc(r.categories || '')}</td>
      <td class="num">${r.product_count}</td><td class="num">${r.file_count}</td>
      <td>${statusBadge(r.status)}</td><td>${reviewBadge(r.review_status)}</td>
      <td class="muted" style="white-space:nowrap">${fmtDate(r.submitted_at || r.updated_at)}</td></tr>`).join('');
    $$('tr[data-id]', body).forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/s/${tr.dataset.id}`; }));
  }

  // ------------------------------------------------------------ supplier detail
  function kv(pairs) {
    const items = pairs.filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length));
    if (!items.length) return '<p class="muted" style="margin:0;color:var(--ink-3)">Not provided</p>';
    return `<dl class="kv">${items.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${Array.isArray(v) ? esc(v.join(', ')) : esc(v)}</dd>`).join('')}</dl>`;
  }

  const PRICE_TYPE = { EXACT: 'Fixed price', FROM: 'Starts from', QUOTE_ONLY: 'Price on request' };

  async function renderDetail(id) {
    const [s, preview] = await Promise.all([
      api(`/admin/api/submissions/${encodeURIComponent(id)}`),
      api(`/admin/api/submissions/${encodeURIComponent(id)}/aekobaba-preview`),
    ]);
    if (!stats) stats = await api('/admin/api/stats');
    const c = s.company;
    const cur = s.pricing.currency;
    const gst = s.pricing.terms ? [s.pricing.terms === 'DELIVERED' ? 'delivered' : s.pricing.terms, s.pricing.terms !== 'DELIVERED' ? s.pricing.port : ''].filter(Boolean).join(' ') : '';
    const products = s.products.map((p, i) => {
      const priceLine = p.price_type === 'QUOTE_ONLY' ? 'Price on request'
        : p.price != null ? `${p.price_type === 'FROM' ? 'From ' : ''}${money(p.price, cur)} per ${esc(p.unit || 'piece')}${gst ? ` (${gst})` : ''}` : '';
      return `<div class="pcard">
      <h3>${i + 1}. ${esc(p.name || 'Untitled product')}</h3>
      <div class="pmeta">${esc([p.category_name, p.subcategory, p.material].filter(Boolean).join(' · '))}</div>
      ${priceLine ? `<p style="margin:0 0 10px;font-size:16px"><strong>${priceLine}</strong></p>` : ''}
      ${p.tiers.length ? `<table class="data"><thead><tr><th class="num">Quantity</th><th class="num">Unit price</th></tr></thead><tbody>
        ${p.tiers.map((t) => `<tr><td class="num">${qtyRange(t.min_qty, t.max_qty)}</td><td class="num strong">${money(t.unit_price, cur)}</td></tr>`).join('')}
      </tbody></table>` : ''}
      ${kv([['MOQ', p.moq != null ? `${numf(p.moq)} ${p.moq_unit || ''}`.trim() : ''], ['Lead time', p.lead_time_days ? `${p.lead_time_days} days` : ''],
        ['Capacity', p.capacity], ['Size', p.dimensions], ['Thickness', p.thickness], ['Neck finish', p.neck_finish], ['Closure', p.closure],
        ['Board / flute', p.board], ['Color / finish', p.finish],
        ['Availability', p.stock_or_custom === 'CUSTOM' ? 'Made to order' : p.stock_or_custom === 'STOCK' ? 'Ready stock' : ''],
        ['Custom printing', p.printing], ['Food grade', p.food_grade],
        ['Samples', p.samples ? `${p.samples}${p.sample_cost ? ` (${p.sample_cost})` : ''}` : ''], ['Setup / plate cost', p.setup_cost],
        ['Description', p.description]])}
      ${p.images.length ? `<div class="gallery">${p.images.map((img) => `<a href="${fileHref(img.id, true)}" target="_blank" rel="noopener" title="${esc(img.name)}"><img loading="lazy" src="${fileHref(img.id, true)}" alt="${esc(img.name)}"></a>`).join('')}</div>` : ''}
    </div>`;
    }).join('');

    app.innerHTML = `<div class="wrap">
      <a class="back" href="#/"><svg class="i"><use href="#i-back"/></svg>All suppliers</a>
      <div class="page-head"><div><h1>${esc(c.business_name || '(no name)')}</h1>
        <p><strong style="font-family:ui-monospace,monospace">${esc(s.ref_id)}</strong> · ${statusBadge(s.status)} ${reviewBadge(s.review_status)}
        · ${s.submitted_at ? `Submitted ${fmtDate(s.submitted_at, true)}` : `Created ${fmtDate(s.created_at, true)}`}${s.updated_at !== s.submitted_at ? ` · Updated ${fmtDate(s.updated_at, true)}` : ''}</p></div>
        <div class="actions">
          ${s.documents.length || s.products.some((p) => p.images.length) ? `<a class="btn" href="/admin/api/submissions/${s.id}/files.zip"><svg class="i"><use href="#i-download"/></svg>All files</a>` : ''}
          <a class="btn btn-primary" href="/admin/api/submissions/${s.id}/aekobaba.zip"><svg class="i"><use href="#i-download"/></svg>Export for Aekobaba</a>
        </div>
      </div>
      <div class="detail-grid">
        <div class="panel">
          <div class="dsec"><h2>Company</h2>${kv([['Contact', c.contact_person], ['Location', [c.location, c.country].filter(Boolean).join(', ')], ['Registered company name', c.legal_name],
            ['Certifications', [...(c.certifications || []), c.certifications_other].filter(Boolean)], ['Prices in', `${cur}${gst ? ', ' + gst : ''}`]])}</div>
          <div class="dsec"><h2>Products (${s.products.length})</h2>${products || '<p style="color:var(--ink-3);margin:0">No products entered. See the uploaded catalogue / price list.</p>'}</div>
          ${s.notes ? `<div class="dsec"><h2>Notes from supplier</h2><p style="margin:0;white-space:pre-wrap">${esc(s.notes)}</p></div>` : ''}
          <div class="dsec"><h2>Aekobaba listing preview</h2>
            <p style="margin:0 0 10px;color:var(--ink-2);font-size:14px">This is the supplier entry for <code>data/aekobaba-seed.json</code>. <strong>Export for Aekobaba</strong> downloads it together with the photos laid out for <code>public/partners/${esc(preview.supplier.slug)}/</code>.</p>
            ${preview.warnings.length ? `<div class="form-error" style="margin:0 0 10px">${preview.warnings.map(esc).join('<br>')}</div>` : ''}
            <details><summary style="cursor:pointer;font-weight:600">Show JSON (${preview.supplier.products.length} product${preview.supplier.products.length === 1 ? '' : 's'})</summary>
              <pre style="background:var(--surface-2);border:1px solid var(--line);border-radius:9px;padding:12px;overflow:auto;max-height:420px;font-size:12px">${esc(JSON.stringify(preview.supplier, null, 2))}</pre></details>
          </div>
        </div>
        <aside class="detail-side">
          <div class="side-card"><h3>Contact</h3>
            <div class="contact-line"><svg class="i"><use href="#i-mail"/></svg><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></div>
            <div class="contact-line"><svg class="i"><use href="#i-phone"/></svg><a href="tel:${esc(c.phone)}">${esc(c.phone)}</a></div>
            ${c.website ? `<div class="contact-line"><svg class="i"><use href="#i-globe"/></svg><a href="${/^https?:\/\//i.test(c.website) ? esc(c.website) : 'https://' + esc(c.website)}" target="_blank" rel="noopener noreferrer">${esc(c.website)}</a></div>` : ''}
          </div>
          <div class="side-card"><h3>Review</h3>
            <div class="field"><label for="rv">Status</label><select id="rv">${stats.reviewStatuses.map((r) => `<option${r === s.review_status ? ' selected' : ''}>${esc(r)}</option>`).join('')}</select></div>
            <div class="field"><label for="notes">Internal notes</label><textarea id="notes" rows="5" placeholder="Only visible to your team">${esc(s.admin_notes || '')}</textarea></div>
            <button class="btn btn-primary btn-sm" id="saveReview">Save review</button>
          </div>
          <div class="side-card"><h3>Documents (${s.documents.length})</h3>
            ${s.documents.length ? s.documents.map((d) => `<a class="doc-link" href="${fileHref(d.id, ext(d.name) === 'pdf' || isImg(d.name))}" target="_blank" rel="noopener">
              <span class="ficon">${esc(ext(d.name) || 'file')}</span><span style="min-width:0;flex:1"><span style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.name)}</span><small>${esc(d.doc_type || 'Other')} · ${bytes(d.size)}</small></span>
              <svg class="i"><use href="#i-download"/></svg></a>`).join('') : '<p style="color:var(--ink-3);margin:0;font-size:14px">No documents uploaded.</p>'}
          </div>
          <div class="side-card"><h3>Supplier edit link</h3>
            <p style="font-size:13px;color:var(--ink-2);margin:0 0 8px">Send this to the supplier if they've lost their link.</p>
            <div class="link-copy"><input type="text" readonly id="editUrl" value="${esc(s.edit_url)}"><button class="btn btn-sm" data-copy="#editUrl"><svg class="i"><use href="#i-copy"/></svg></button></div>
            ${s.invite ? `<p style="font-size:13px;color:var(--ink-3);margin:12px 0 0">From invitation to ${esc(s.invite.supplier_name || s.invite.contact_email)} (${fmtDate(s.invite.created_at)})</p>` : ''}
          </div>
          <button class="btn btn-danger btn-sm" id="delSub" style="justify-self:start"><svg class="i"><use href="#i-trash"/></svg>Delete submission</button>
        </aside>
      </div></div>`;

    $('#saveReview').addEventListener('click', async () => {
      try { await api(`/admin/api/submissions/${s.id}`, { method: 'PATCH', json: { review_status: $('#rv').value, admin_notes: $('#notes').value } }); toast('Review saved'); }
      catch (e) { toast(e.message, 'error'); }
    });
    $('#delSub').addEventListener('click', async () => {
      if (!(await confirmModal('Delete this submission?', `${c.business_name || s.ref_id} and all of its products and files will be permanently deleted.`, 'Delete', true))) return;
      await api(`/admin/api/submissions/${s.id}`, { method: 'DELETE' });
      toast('Submission deleted');
      location.hash = '#/';
    });
  }

  // ------------------------------------------------------------ compare prices
  const cmpState = { q: '', category: '', currency: '', drafts: false, sort: 'unit_price', dir: 1 };

  async function renderCompare() {
    if (!stats) stats = await api('/admin/api/stats');
    app.innerHTML = `<div class="wrap">
      <div class="page-head"><div><h1>Compare prices</h1><p>Indicative unit prices across suppliers. Lowest price per category &amp; currency is highlighted.</p></div>
        <div class="actions"><a class="btn" href="/admin/api/export.csv?type=prices"><svg class="i"><use href="#i-download"/></svg>Price tiers CSV</a></div></div>
      <div class="panel">
        <div class="filters">
          <input type="search" id="cq" placeholder="Search product, material, size, supplier…" value="${esc(cmpState.q)}">
          <select id="ccat"><option value="">All categories</option>${stats.categories.map((c) => `<option value="${esc(c.category)}">${esc(c.name)}</option>`).join('')}</select>
          <select id="ccur"><option value="">All currencies</option></select>
          <label class="check-pill"><input type="checkbox" id="cdrafts"${cmpState.drafts ? ' checked' : ''}><span>Include drafts</span></label>
        </div>
        <div class="table-scroll"><table class="data"><thead><tr>
          <th class="sortable" data-sort="name">Product</th><th class="sortable" data-sort="business_name">Supplier</th>
          <th class="num sortable" data-sort="min_qty">Quantity</th><th class="num sortable" data-sort="unit_price">Unit price</th><th class="num sortable" data-sort="moq">MOQ</th>
          <th>Lead time</th><th>Samples</th><th>Setup cost</th><th>Type</th>
        </tr></thead><tbody id="crow"><tr><td colspan="9" class="empty">Loading…</td></tr></tbody></table></div>
      </div></div>`;
    $('#ccat').value = cmpState.category;
    let t;
    $('#cq').addEventListener('input', (e) => { cmpState.q = e.target.value; clearTimeout(t); t = setTimeout(loadCompare, 250); });
    $('#ccat').addEventListener('change', (e) => { cmpState.category = e.target.value; loadCompare(); });
    $('#ccur').addEventListener('change', (e) => { cmpState.currency = e.target.value; loadCompare(); });
    $('#cdrafts').addEventListener('change', (e) => { cmpState.drafts = e.target.checked; loadCompare(); });
    $$('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
      cmpState.dir = cmpState.sort === th.dataset.sort ? -cmpState.dir : 1;
      cmpState.sort = th.dataset.sort;
      loadCompare();
    }));
    await loadCompare();
  }

  let currenciesSeen = new Set();
  async function loadCompare() {
    const qs = new URLSearchParams();
    if (cmpState.q) qs.set('q', cmpState.q);
    if (cmpState.category) qs.set('category', cmpState.category);
    if (cmpState.currency) qs.set('currency', cmpState.currency);
    if (cmpState.drafts) qs.set('drafts', '1');
    const rows = await api(`/admin/api/compare?${qs}`);
    rows.forEach((r) => r.currency && currenciesSeen.add(r.currency));
    const cur = $('#ccur');
    if (cur) {
      cur.innerHTML = '<option value="">All currencies</option>' + [...currenciesSeen].sort().map((c) => `<option>${esc(c)}</option>`).join('');
      cur.value = cmpState.currency;
    }
    // Lowest price per (category, currency)
    const best = new Map();
    rows.forEach((r) => {
      if (r.unit_price == null) return;
      const k = `${r.category || ''}|${r.currency || ''}`;
      if (!best.has(k) || r.unit_price < best.get(k)) best.set(k, r.unit_price);
    });
    const { sort, dir } = cmpState;
    rows.sort((a, b) => {
      const x = a[sort], y = b[sort];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
    });
    $$('th[data-sort]').forEach((th) => { th.textContent = th.textContent.replace(/ [▲▼]$/, '') + (th.dataset.sort === sort ? (dir > 0 ? ' ▲' : ' ▼') : ''); });
    const body = $('#crow');
    if (!body) return;
    if (!rows.length) { body.innerHTML = '<tr><td colspan="9" class="empty">No priced products match. Prices appear here once suppliers submit.</td></tr>'; return; }
    body.innerHTML = rows.map((r) => {
      const isBest = r.unit_price != null && best.get(`${r.category || ''}|${r.currency || ''}`) === r.unit_price;
      return `<tr>
        <td><div class="strong">${esc(r.name || 'Untitled')}</div><div class="muted">${esc([r.category_name, r.material, r.dimensions].filter(Boolean).join(' · '))}</div></td>
        <td><a href="#/s/${r.submission_id}">${esc(r.business_name)}</a><div class="muted">${esc(r.country || '')}</div></td>
        <td class="num">${qtyRange(r.min_qty, r.max_qty)}</td>
        <td class="num strong${isBest ? ' best' : ''}">${money(r.unit_price, r.currency) || '<span class="muted">—</span>'}<div class="muted">per ${esc(r.unit || 'piece')}${r.terms ? ', ' + esc(r.terms) : ''}</div>${isBest ? '<span class="best-badge">Lowest</span>' : ''}</td>
        <td class="num">${numf(r.moq)}</td>
        <td>${r.lead_time ? esc(r.lead_time) + ' days' : ''}</td>
        <td>${esc(r.samples === 'Paid' ? 'Paid' + (r.sample_cost ? ': ' + r.sample_cost : '') : r.samples || '')}</td>
        <td class="muted">${esc(r.setup_cost || '')}</td>
        <td class="muted">${r.stock_or_custom === 'CUSTOM' ? 'Made to order' : r.stock_or_custom === 'STOCK' ? 'Ready stock' : ''}${r.price_type === 'FROM' ? '<div>Starts from</div>' : ''}</td></tr>`;
    }).join('');
  }

  // ------------------------------------------------------------ invitations
  async function renderInvites() {
    const rows = await api('/admin/api/invites');
    const state = (r) => (r.submission_status === 'submitted' ? '<span class="badge submitted">Submitted</span>'
      : r.submission_status === 'draft' ? '<span class="badge draft">Draft started</span>'
        : r.opened_at ? '<span class="badge opened">Opened</span>' : '<span class="badge pending">Not opened</span>');
    app.innerHTML = `<div class="wrap">
      <div class="page-head"><div><h1>Invitations</h1><p>Create a unique link for each supplier and track who has opened, started or submitted.</p></div></div>
      <div class="panel panel-pad" style="margin-bottom:22px">
        <form class="invite-form" id="invForm">
          <div class="field"><label for="in">Supplier name</label><input type="text" id="in" placeholder="Company name"></div>
          <div class="field"><label for="ie">Contact email</label><input type="email" id="ie" placeholder="name@company.com"></div>
          <div class="field"><label for="io">Internal note</label><input type="text" id="io" placeholder="e.g. Met at trade fair, packaging"></div>
          <button class="btn btn-primary" type="submit">Create invite link</button>
        </form>
        <div id="newInvite" hidden style="margin-top:16px"></div>
      </div>
      <div class="panel"><div class="table-scroll"><table class="data"><thead><tr><th>Supplier</th><th>Status</th><th>Link</th><th>Created</th><th></th></tr></thead><tbody>
      ${rows.length ? rows.map((r) => `<tr>
        <td><div class="strong">${esc(r.supplier_name || r.business_name || '—')}</div><div class="muted">${esc(r.contact_email || '')}${r.note ? ' · ' + esc(r.note) : ''}</div></td>
        <td>${state(r)}${r.ref_id ? `<div class="muted"><a href="#/s/${r.submission_id}">${esc(r.ref_id)}</a></div>` : ''}</td>
        <td><div class="url-cell" title="${esc(r.url)}">${esc(r.url)}</div></td>
        <td class="muted" style="white-space:nowrap">${fmtDate(r.created_at)}</td>
        <td style="white-space:nowrap;text-align:right">
          <button class="btn btn-sm" data-copy="${esc(r.url)}"><svg class="i"><use href="#i-copy"/></svg>Copy</button>
          ${r.contact_email ? `<a class="btn btn-sm" href="${mailto(r)}"><svg class="i"><use href="#i-mail"/></svg>Email</a>` : ''}
          <button class="icon-btn danger" data-del="${r.id}" title="Delete invite"><svg class="i"><use href="#i-trash"/></svg></button>
        </td></tr>`).join('') : '<tr><td colspan="5" class="empty">No invitations yet.</td></tr>'}
      </tbody></table></div></div></div>`;
    $('#invForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api('/admin/api/invites', { method: 'POST', json: { supplier_name: $('#in').value, contact_email: $('#ie').value, note: $('#io').value } });
        await renderInvites();
        const box = $('#newInvite');
        box.hidden = false;
        box.innerHTML = `<div class="field"><span class="label">Invite link created &mdash; send this to the supplier</span>
          <div class="link-copy"><input type="text" readonly id="newUrl" value="${esc(r.url)}"><button type="button" class="btn" data-copy="#newUrl"><svg class="i"><use href="#i-copy"/></svg>Copy</button></div></div>`;
        $('#newUrl').select();
      } catch (err) { toast(err.message, 'error'); }
    });
    $$('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmModal('Delete this invitation?', 'The link will stop working. Any submission already made is kept.', 'Delete', true))) return;
      await api(`/admin/api/invites/${b.dataset.del}`, { method: 'DELETE' });
      renderInvites();
    }));
  }

  function mailto(r) {
    const subject = `Supplier information request from ${brand.name}`;
    const body = `Hello${r.supplier_name ? ' ' + r.supplier_name : ''},\n\nWe'd like to learn more about your products and pricing. Please share your company profile, products, indicative pricing and capabilities using this link (takes about 10 minutes, no account needed):\n\n${r.url}\n\nYou can also upload your existing catalogue and price list.\n\nThank you,\n${brand.name} Sourcing Team`;
    return `mailto:${encodeURIComponent(r.contact_email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  // ------------------------------------------------------------ router
  async function route() {
    const me = await api('/admin/api/me');
    brand = me.brand;
    document.title = `Admin · ${brand.name}`;
    $$('[data-brand-name]').forEach((el) => { el.textContent = brand.name; });
    $$('[data-brand-initial]').forEach((el) => { el.textContent = brand.name.charAt(0); });
    if (!me.signedIn) return renderLogin();
    $('#topbar').hidden = false;
    const h = location.hash.replace(/^#/, '') || '/';
    const nav = h.startsWith('/compare') ? 'compare' : h.startsWith('/invites') ? 'invites' : 'suppliers';
    $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));
    window.scrollTo({ top: 0 });
    const m = h.match(/^\/s\/(\d+)/);
    if (m) return guarded(() => renderDetail(m[1]));
    if (nav === 'compare') return guarded(renderCompare);
    if (nav === 'invites') return guarded(renderInvites);
    return guarded(renderSuppliers);
  }

  window.addEventListener('hashchange', route);
  $('#logout').addEventListener('click', async () => { await api('/admin/api/logout', { method: 'POST' }); stats = null; renderLogin(); });
  route().catch((e) => { app.innerHTML = `<div class="wrap"><div class="panel empty">${esc(e.message)}</div></div>`; });
})();
