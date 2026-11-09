/* Supplier-facing single-page form (packaging suppliers → Aekobaba listings) */
(function () {
  const { $, $$, api, toast, esc, bytes, ext, fmtDate } = window.SD;

  const form = $('#supplierForm');
  const productList = $('#productList');
  const state = {
    cfg: null, mode: 'new', inviteToken: null, editToken: null, status: null, refId: null,
    docs: [], uploads: 0, dirty: false, restoring: false,
  };
  let uid = 0;
  const storageKey = () => `sd_draft_v2_${state.inviteToken || 'open'}`;

  // ---------------------------------------------------------------- utils
  const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  function setPath(obj, path, val) {
    const keys = path.split('.');
    let o = obj;
    keys.slice(0, -1).forEach((k) => { o = o[k] = o[k] || {}; });
    o[keys[keys.length - 1]] = val;
  }
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const fileUrl = (id) => `/api/files/${encodeURIComponent(id)}?inline=1&k=${encodeURIComponent(state.editToken || '')}`;
  const currency = () => $('[name="pricing.currency"]').value || 'USD';

  function modal(html) {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(wrap);
    return wrap;
  }
  function confirmModal(title, text, okLabel = 'Confirm') {
    return new Promise((resolve) => {
      const w = modal(`<h3>${esc(title)}</h3><p>${esc(text)}</p>
        <div class="modal-actions"><button class="btn" data-r="0">Cancel</button><button class="btn btn-primary" data-r="1">${esc(okLabel)}</button></div>`);
      const done = (v) => { w.remove(); resolve(v); };
      w.addEventListener('click', (e) => { if (e.target === w) done(false); const b = e.target.closest('[data-r]'); if (b) done(b.dataset.r === '1'); });
      w.querySelector('[data-r="1"]').focus();
    });
  }
  function linkModal(url) {
    const w = modal(`<h3>Draft saved</h3>
      <p>Use this private link to come back and finish later. Bookmark it or copy it somewhere safe. Anyone with the link can edit your draft.</p>
      <div class="link-copy"><input type="text" readonly value="${esc(url)}" id="draftLink"><button class="btn" data-copy="#draftLink">Copy</button></div>
      <p style="margin-top:14px;font-size:13px">Your draft isn't sent to our team until you click <strong>Submit</strong>.</p>
      <div class="modal-actions"><button class="btn btn-primary" data-close>Continue editing</button></div>`);
    w.addEventListener('click', (e) => { if (e.target === w || e.target.closest('[data-close]')) w.remove(); });
    w.querySelector('input').select();
  }
  function showNotice(html, kind) {
    const n = $('#notice');
    n.className = `notice${kind === 'info' ? ' info' : ''}`;
    n.firstElementChild.innerHTML = html;
    n.hidden = false;
  }

  // ---------------------------------------------------------------- uploads
  function checkFile(file, imagesOnly) {
    const e = `.${ext(file.name)}`;
    const allowed = imagesOnly ? state.cfg.uploads.imageExtensions : state.cfg.uploads.allowedExtensions;
    if (!allowed.includes(e)) return `${file.name}: ${imagesOnly ? 'please upload a photo (JPG, PNG, WebP)' : 'this file type is not supported'}`;
    if (file.size > state.cfg.uploads.maxFileSizeMB * 1048576) return `${file.name} is larger than ${state.cfg.uploads.maxFileSizeMB} MB`;
    return null;
  }
  function uploadFile(file, kind, onProgress) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      fd.append('kind', kind);
      fd.append('file', file);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/files');
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        let body = {};
        try { body = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(body); else reject(new Error(body.error || 'Upload failed'));
      };
      xhr.onerror = () => reject(new Error('Upload failed - check your connection'));
      state.uploads++;
      xhr.onloadend = () => { state.uploads--; };
      xhr.send(fd);
    });
  }
  function wireDropzone(zone, input, onFiles) {
    zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('drag'); }));
    zone.addEventListener('drop', (e) => onFiles(Array.from(e.dataTransfer.files || [])));
    input.addEventListener('change', () => { onFiles(Array.from(input.files || [])); input.value = ''; });
  }

  // ---------------------------------------------------------------- documents
  function guessDocType(name) {
    const n = name.toLowerCase();
    if (/price|rate|quot|tariff/.test(n) || /\.(xlsx?|xlsm|csv|ods)$/.test(n)) return 'Price list';
    if (/cert|iso|bis|fssai|brc|fsc|licen/.test(n)) return 'Certificate';
    if (/catalog|catalogue|brochure|range|product/.test(n)) return 'Product catalogue';
    return /\.pdf$/.test(n) ? 'Product catalogue' : 'Other';
  }
  function renderDocs() {
    const list = $('#docList');
    list.innerHTML = '';
    state.docs.forEach((d) => {
      const row = document.createElement('div');
      row.className = `file-row${d.error ? ' error' : ''}`;
      row.innerHTML = `<span class="ficon">${esc(ext(d.name) || 'file')}</span>
        <div class="fmeta"><div class="fname" title="${esc(d.name)}">${esc(d.name)}</div>
          ${d.error ? `<div class="err">${esc(d.error)}</div>` : d.uploading ? `<div class="fbar"><span style="width:${Math.round((d.progress || 0) * 100)}%"></span></div>` : `<div class="fsize">${bytes(d.size)}</div>`}
        </div>
        ${d.error ? '' : `<select aria-label="Document type">${state.cfg.documentTypes.map((t) => `<option${t === d.doc_type ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`}
        <button type="button" class="icon-btn danger" title="Remove file"><svg class="i"><use href="#i-x"/></svg></button>`;
      const sel = row.querySelector('select');
      if (sel) sel.addEventListener('change', () => { d.doc_type = sel.value; changed(); });
      row.querySelector('button').addEventListener('click', () => { state.docs = state.docs.filter((x) => x !== d); renderDocs(); changed(); });
      d.row = row;
      list.appendChild(row);
    });
  }
  function addDocFiles(files) {
    files.forEach((file) => {
      const d = { name: file.name, size: file.size, doc_type: guessDocType(file.name), uploading: true, progress: 0 };
      const problem = checkFile(file, false);
      if (problem) { d.uploading = false; d.error = problem; state.docs.push(d); return; }
      state.docs.push(d);
      uploadFile(file, 'document', (p) => {
        d.progress = p;
        const bar = d.row && d.row.querySelector('.fbar span');
        if (bar) bar.style.width = `${Math.round(p * 100)}%`;
      }).then((meta) => { d.file_id = meta.id; d.uploading = false; renderDocs(); changed(); })
        .catch((err) => { d.uploading = false; d.error = err.message; renderDocs(); });
    });
    renderDocs();
  }

  // ---------------------------------------------------------------- products
  const specGroupOf = (slug) => (state.cfg.categories.find((c) => c.slug === slug) || {}).group;

  function addTier(card, t = {}) {
    const row = $('#tierTpl').content.firstElementChild.cloneNode(true);
    $$('[data-t]', row).forEach((inp) => { const v = t[inp.dataset.t]; inp.value = v == null ? '' : v; });
    $('[data-tiers]', card).appendChild(row);
    $('[data-tiers-table]', card).hidden = false;
    return row;
  }

  function renderThumbs(card) {
    const box = $('[data-thumbs]', card);
    box.innerHTML = '';
    card._images.forEach((img) => {
      const el = document.createElement('div');
      el.className = `thumb${img.uploading ? ' loading' : ''}`;
      el.title = img.error || img.name;
      el.innerHTML = img.error
        ? `<div style="padding:8px;font-size:11px;color:var(--danger)">${esc(img.error)}</div>`
        : `<img alt="${esc(img.name)}" src="${esc(img.preview || fileUrl(img.id))}">`;
      el.insertAdjacentHTML('beforeend', '<button type="button" class="thumb-x" aria-label="Remove photo">&times;</button>');
      el.querySelector('.thumb-x').addEventListener('click', () => { card._images = card._images.filter((x) => x !== img); renderThumbs(card); changed(); });
      box.appendChild(el);
    });
    updatePreview(card);
  }
  function addImages(card, files) {
    files.forEach(async (original) => {
      if (original.size > state.cfg.uploads.maxFileSizeMB * 1048576 && original.type.startsWith('image/')) original = await shrinkImage(original);
      const problem = checkFile(original, true);
      if (problem) { toast(problem, 'error'); return; }
      const img = { name: original.name, size: original.size, uploading: true };
      try { img.preview = URL.createObjectURL(original); } catch {}
      card._images.push(img);
      renderThumbs(card);
      const file = await shrinkImage(original);
      uploadFile(file, 'product_image').then((meta) => { img.id = meta.id; img.uploading = false; renderThumbs(card); changed(); })
        .catch((err) => { img.uploading = false; img.error = err.message; renderThumbs(card); });
    });
    renderThumbs(card);
  }

  const radioVal = (card, field) => { const r = $(`input[type=radio][data-p="${field}"]:checked`, card); return r ? r.value : ''; };

  // Show the right spec fields for the category, price fields for the price type, etc.
  function syncCard(card) {
    const group = specGroupOf($('[data-p="category"]', card).value);
    const show = group ? state.cfg.specGroups[group] : [];
    $$('[data-spec]', card).forEach((f) => { f.hidden = !show.includes(f.dataset.spec); });
    const quoteOnly = radioVal(card, 'price_type') === 'QUOTE_ONLY';
    $$('[data-priced]', card).forEach((el) => { el.hidden = quoteOnly; });
    $('[data-sample-cost]', card).hidden = radioVal(card, 'samples') !== 'Paid';
    $$('[data-cur]', card).forEach((el) => { el.textContent = currency(); });
    $('[data-tiers-table]', card).hidden = !$$('[data-tiers] tr', card).length;
    updateCardHead(card);
  }

  function updateCardHead(card) {
    const name = $('[data-p="name"]', card).value.trim();
    const t = $('[data-title]', card);
    t.textContent = name || 'Untitled product';
    t.classList.toggle('empty', !name);
    const parts = [];
    const price = $('[data-p="price"]', card).value.trim();
    if (radioVal(card, 'price_type') === 'QUOTE_ONLY') parts.push('Price on request');
    else if (price) parts.push(`${currency()} ${price}${$('[data-p="unit"]', card).value.trim() ? ' / ' + $('[data-p="unit"]', card).value.trim() : ''}`);
    const moq = $('[data-p="moq"]', card).value.trim();
    if (moq) parts.push(`MOQ ${moq}`);
    if (card._images.length) parts.push(`${card._images.length} photo${card._images.length > 1 ? 's' : ''}`);
    $('[data-summary]', card).textContent = parts.join(' · ');
    updatePreview(card);
  }

  function renumber() {
    const cards = $$('.product-card', productList);
    cards.forEach((c, i) => { $('[data-num]', c).textContent = i + 1; });
    $$('.product-card [data-act="remove"]', productList).forEach((b) => { b.hidden = cards.length === 1; });
  }

  function addProduct(p = {}, { collapseOthers = false, focus = false } = {}) {
    const card = $('#productTpl').content.firstElementChild.cloneNode(true);
    const id = ++uid;
    const cat = $('[data-categories]', card);
    cat.innerHTML = '<option value="">Choose a category…</option>' + state.cfg.categories.map((c) => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join('');
    $$('[data-p]', card).forEach((inp) => {
      const v = p[inp.dataset.p];
      if (inp.type === 'radio') {
        inp.name = `p${id}_${inp.dataset.p}`;
        if (v) inp.checked = inp.value === v;
      } else inp.value = v == null ? '' : v;
    });
    card._images = (p.images || []).map((i) => ({ id: i.id, name: i.name, size: i.size }));
    (p.tiers || []).forEach((t) => addTier(card, t));

    if (collapseOthers) $$('.product-card', productList).forEach((c) => { if ($('[data-p="name"]', c).value.trim()) c.classList.add('collapsed'); });
    productList.appendChild(card);

    $('.product-head', card).addEventListener('click', (e) => { if (!e.target.closest('[data-act]')) card.classList.toggle('collapsed'); });
    card.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'add-tier') { const r = addTier(card); $('input', r).focus(); }
      if (act === 'remove-tier') { b.closest('tr').remove(); syncCard(card); changed(); }
      if (act === 'remove') {
        const hasContent = $$('input[type=text][data-p], textarea[data-p], select[data-p]', card).some((i) => i.value.trim()) || card._images.length;
        if (hasContent && !(await confirmModal('Remove this product?', 'Its details, prices and photos will be removed from your submission.', 'Remove'))) return;
        card.remove(); renumber(); changed();
      }
      if (act === 'duplicate') {
        const copy = collectProduct(card);
        copy.name = copy.name ? `${copy.name} (copy)` : '';
        copy.images = [];
        const c = addProduct(copy, { collapseOthers: true });
        c.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setTimeout(() => $('[data-p="name"]', c).select(), 400);
        changed();
      }
    });
    card.addEventListener('input', () => updateCardHead(card));
    card.addEventListener('change', () => syncCard(card));
    wireDropzone($('[data-img-drop]', card), $('[data-img-input]', card), (files) => addImages(card, files));
    $('[data-cam-input]', card).addEventListener('change', (e) => { addImages(card, Array.from(e.target.files || [])); e.target.value = ''; });
    const suggest = debounce(() => { suggestFromName(card); updateCardHead(card); }, 350);
    $('[data-p="name"]', card).addEventListener('input', suggest);
    renderThumbs(card);
    syncCard(card);
    renumber();
    if (focus) setTimeout(() => $('[data-p="name"]', card).focus(), 50);
    return card;
  }

  function collectProduct(card) {
    const p = {};
    $$('[data-p]', card).forEach((inp) => {
      const key = inp.dataset.p;
      if (inp.type === 'radio') { if (inp.checked) p[key] = inp.value; else if (!(key in p)) p[key] = ''; return; }
      const hiddenSpec = inp.closest('[data-spec]') && inp.closest('[data-spec]').hidden;
      p[key] = hiddenSpec ? '' : inp.value.trim();
    });
    if (p.price_type === 'QUOTE_ONLY') { p.price = ''; p.unit = ''; }
    if (p.samples !== 'Paid') p.sample_cost = '';
    p.tiers = p.price_type === 'QUOTE_ONLY' ? [] : $$('[data-tiers] tr', card).map((r) => {
      const t = {};
      $$('[data-t]', r).forEach((inp) => { t[inp.dataset.t] = inp.value.trim(); });
      return t;
    }).filter((t) => t.min_qty || t.max_qty || t.unit_price);
    p.image_ids = card._images.filter((i) => i.id).map((i) => i.id);
    p.images = card._images.filter((i) => i.id).map((i) => ({ id: i.id, name: i.name, size: i.size }));
    return p;
  }
  const productHasContent = (p) => p.name || p.material || p.category || p.price || p.tiers.length || p.image_ids.length;

  // ---------------------------------------------------------------- collect / populate
  function collect() {
    const data = { company: { certifications: [] }, pricing: {}, notes: '' };
    $$('[name]', form).forEach((el) => {
      if (el.closest('.product-card')) return;
      const name = el.name;
      if (name === 'consent') { data.consent = el.checked; return; }
      if (name === 'company.certifications') { if (el.checked) data.company.certifications.push(el.value); return; }
      if (el.type === 'radio') { if (el.checked) setPath(data, name, el.value); else if (getPath(data, name) === undefined) setPath(data, name, ''); return; }
      setPath(data, name, el.value.trim());
    });
    data.products = $$('.product-card', productList).map(collectProduct).filter(productHasContent);
    data.documents = state.docs.filter((d) => d.file_id).map((d) => ({ file_id: d.file_id, doc_type: d.doc_type, name: d.name, size: d.size }));
    return data;
  }

  function populate(data) {
    state.restoring = true;
    $$('[name]', form).forEach((el) => {
      if (el.closest('.product-card')) return;
      const name = el.name;
      if (name === 'consent') { el.checked = !!data.consent; return; }
      if (name === 'company.certifications') { el.checked = (data.company?.certifications || []).includes(el.value); return; }
      const v = getPath(data, name);
      if (el.type === 'radio') { el.checked = v === el.value; return; }
      if (v != null && v !== '') el.value = v;
    });
    productList.innerHTML = '';
    const products = data.products && data.products.length ? data.products : [{}];
    products.forEach((p) => addProduct(p));
    if (products.length > 2) $$('.product-card', productList).forEach((c) => c.classList.add('collapsed'));
    state.docs = (data.documents || []).map((d) => ({ file_id: d.file_id || d.id, name: d.name, size: d.size, doc_type: d.doc_type || 'Other' }));
    renderDocs();
    state.restoring = false;
    updateProgress();
  }

  // ---------------------------------------------------------------- progress + autosave
  const SECTIONS = {
    company: (d) => ['business_name', 'contact_person', 'email', 'phone', 'country', 'location'].every((k) => d.company[k]),
    products: (d) => d.products.some((p) => p.name && p.category && p.material),
    documents: (d) => d.documents.length > 0,
    notes: (d) => !!d.notes,
  };
  function updateProgress() {
    const d = collect();
    let n = 0;
    for (const [sec, test] of Object.entries(SECTIONS)) {
      const ok = !!test(d);
      if (ok) n++;
      const a = $(`.sidenav a[data-sec="${sec}"]`);
      if (a) a.classList.toggle('done', ok);
    }
    $('#progressText').textContent = `${n} of 4 steps done`;
    $('#progressBar').style.width = `${(n / 4) * 100}%`;
  }
  const autosave = debounce(() => {
    if (state.mode === 'edit') return;
    try {
      localStorage.setItem(storageKey(), JSON.stringify({ savedAt: new Date().toISOString(), data: collect() }));
      $('#saveState').textContent = 'Progress saved on this device';
    } catch {}
  }, 700);
  const progressSoon = debounce(updateProgress, 250);
  function changed() {
    if (state.restoring) return;
    state.dirty = true;
    if (state.mode === 'edit') $('#saveState').textContent = 'Unsaved changes';
    autosave();
    progressSoon();
  }

  // ---------------------------------------------------------------- validation
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const hasNumber = (v) => /\d/.test(String(v || ''));
  function validateClient(d) {
    const e = {};
    const c = d.company;
    if (!c.business_name) e['company.business_name'] = 'Company name is required';
    if (!c.contact_person) e['company.contact_person'] = 'Contact name is required';
    if (!c.email) e['company.email'] = 'Email is required'; else if (!EMAIL_RE.test(c.email)) e['company.email'] = 'Enter a valid email address';
    if (!c.phone) e['company.phone'] = 'Phone number is required';
    if (!c.country) e['company.country'] = 'Country is required';
    if (!c.location) e['company.location'] = 'City is required';
    if (!d.products.length && !d.documents.length) e.products = 'Add at least one product, or upload your catalogue / price list in step 3.';
    d.products.forEach((p, i) => {
      if (!p.name) e[`products.${i}.name`] = 'Product name is required';
      if (!p.category) e[`products.${i}.category`] = 'Choose a category';
      if (!p.material) e[`products.${i}.material`] = 'Material is required';
      if (p.price_type !== 'QUOTE_ONLY' && !hasNumber(p.price) && !p.tiers.some((t) => hasNumber(t.unit_price))) {
        e[`products.${i}.price`] = 'Enter a price, or choose "On request"';
      }
    });
    if (!d.consent) e.consent = 'Please confirm to submit.';
    return e;
  }
  function clearErrors() {
    $$('.field.invalid', form).forEach((f) => { f.classList.remove('invalid'); const m = $('.err', f); if (m) m.remove(); });
    $$('.product-card.invalid', form).forEach((c) => c.classList.remove('invalid'));
    $('#productsError').hidden = true;
    $('#consentBox').classList.remove('invalid');
    $('#formError').hidden = true;
  }
  function markField(input, msg) {
    const f = input.closest('.field');
    if (!f) return;
    f.classList.add('invalid');
    if (!$('.err', f)) f.insertAdjacentHTML('beforeend', `<span class="err">${esc(msg)}</span>`);
  }
  function showErrors(errors, summary) {
    clearErrors();
    const cards = $$('.product-card', productList).filter((c) => productHasContent(collectProduct(c)));
    let first = null;
    for (const [key, msg] of Object.entries(errors)) {
      let target = null;
      if (key === 'products') { const box = $('#productsError'); box.textContent = msg; box.hidden = false; target = box; }
      else if (key === 'consent') { $('#consentBox').classList.add('invalid'); target = $('#consentBox'); }
      else if (key.startsWith('products.')) {
        const [, idx, field] = key.split('.');
        const card = cards[Number(idx)];
        if (card) { card.classList.add('invalid'); card.classList.remove('collapsed'); target = $(`[data-p="${field}"]`, card); if (target) markField(target, msg); }
      } else {
        target = form.querySelector(`[name="${key}"]`);
        if (target) markField(target, msg);
      }
      if (target && !first) first = target;
    }
    const n = Object.keys(errors).length;
    const fe = $('#formError');
    fe.textContent = summary || `Please complete ${n} highlighted field${n > 1 ? 's' : ''} before submitting.`;
    fe.hidden = false;
    if (first) {
      first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (first.focus && !['DIV', 'LABEL'].includes(first.tagName)) setTimeout(() => first.focus({ preventScroll: true }), 400);
    }
  }

  form.addEventListener('input', (e) => {
    const f = e.target.closest('.field.invalid');
    if (f) { f.classList.remove('invalid'); const m = $('.err', f); if (m) m.remove(); }
    if (e.target.id === 'consent') $('#consentBox').classList.remove('invalid');
    changed();
  });
  form.addEventListener('change', (e) => {
    if (e.target.name === 'pricing.currency') $$('.product-card', productList).forEach(syncCard);
    if (e.target.name === 'pricing.terms') syncPort();
    changed();
  });

  // ---------------------------------------------------------------- save / submit
  let saving = false;
  async function save(action) {
    if (saving) return;
    if (state.uploads > 0 || state.docs.some((d) => d.uploading)) { toast('Please wait for your files to finish uploading.', 'error'); return; }
    const data = collect();
    if (action === 'submit' || state.status === 'submitted') {
      const errs = validateClient(data);
      if (Object.keys(errs).length) { showErrors(errs); return; }
    } else if (!data.company.business_name && !data.company.email) {
      showErrors({ 'company.business_name': 'Enter your company name to save a draft' }, 'Enter at least your company name or email to save a draft.');
      return;
    }
    clearErrors();
    saving = true;
    const btns = ['#submitBtn', '#saveDraftTop', '#saveDraftBottom', '#saveDraftMobile'].map((s) => $(s));
    btns.forEach((b) => { b.disabled = true; });
    const mainBtn = action === 'submit' ? $('#submitBtn') : null;
    const oldLabel = mainBtn && mainBtn.innerHTML;
    if (mainBtn) mainBtn.innerHTML = '<span class="spinner"></span> Submitting…';
    try {
      const body = { action, data, invite_token: state.inviteToken };
      const res = state.editToken
        ? await api(`/api/submission/${encodeURIComponent(state.editToken)}`, { method: 'PUT', json: body })
        : await api('/api/submissions', { method: 'POST', json: body });
      const wasSubmitted = state.status === 'submitted';
      Object.assign(state, { editToken: res.edit_token, refId: res.ref_id, status: res.status, dirty: false, mode: 'edit' });
      try { localStorage.removeItem(storageKey()); } catch {}
      history.replaceState(null, '', `/e/${res.edit_token}`);
      if (res.status === 'submitted') showSuccess(res, wasSubmitted);
      else {
        $('#saveState').textContent = `Draft saved · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        applyModeUi();
        linkModal(res.edit_url);
      }
    } catch (err) {
      if (err.status === 422 && err.body && err.body.errors) showErrors(err.body.errors, err.message);
      else { toast(err.message, 'error'); const fe = $('#formError'); fe.textContent = err.message; fe.hidden = false; }
    } finally {
      saving = false;
      btns.forEach((b) => { b.disabled = false; });
      if (mainBtn) mainBtn.innerHTML = oldLabel;
    }
  }

  function showSuccess(res, wasUpdate) {
    $('#formView').hidden = true;
    $('#saveDraftTop').hidden = true;
    $('#saveState').textContent = '';
    $('#successView').hidden = false;
    $('#successRef').textContent = res.ref_id;
    $('#successLink').value = res.edit_url;
    $('#successEdit').href = `/e/${res.edit_token}`;
    if (wasUpdate) {
      $('#successTitle').textContent = 'Your submission has been updated';
      $('#successText').textContent = 'Thanks for keeping your products and prices current. Our team will see the latest version.';
    }
    window.scrollTo({ top: 0 });
  }

  function applyModeUi() {
    const submitted = state.status === 'submitted';
    ['#saveDraftTop', '#saveDraftBottom', '#saveDraftMobile'].forEach((s) => { $(s).hidden = submitted; });
    if (state.mode === 'edit' && state.refId) {
      $('#submitBtn').textContent = submitted ? 'Update submission' : 'Submit products';
      $('#submitTitle').textContent = submitted ? 'Save your changes' : 'Ready to submit?';
      $('#submitText').textContent = submitted
        ? `Updating submission ${state.refId}. Your changes replace the previous version.`
        : `Your draft ${state.refId} is saved. Submit when you're ready for our team to review it.`;
      showNotice(submitted
        ? `<span>You're editing submission <strong>${esc(state.refId)}</strong>. Make your changes and click <strong>Update submission</strong> at the bottom.</span>`
        : `<span>You're continuing draft <strong>${esc(state.refId)}</strong>. It hasn't been submitted yet.</span>`, 'info');
    }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); save('submit'); });
  ['#saveDraftTop', '#saveDraftBottom', '#saveDraftMobile'].forEach((s) => $(s).addEventListener('click', () => save('draft')));
  $('#addProduct').addEventListener('click', () => { const c = addProduct({}, { collapseOthers: true, focus: true }); c.scrollIntoView({ behavior: 'smooth', block: 'start' }); changed(); });
  wireDropzone($('#docDrop'), $('#docInput'), addDocFiles);

  window.addEventListener('beforeunload', (e) => {
    if (state.uploads > 0 || (state.mode === 'edit' && state.dirty)) { e.preventDefault(); e.returnValue = ''; }
  });

  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      const id = en.target.id.replace('sec-', '');
      $$('.sidenav a').forEach((a) => a.classList.toggle('active', a.dataset.sec === id));
    });
  }, { rootMargin: '-40% 0px -55% 0px' });
  $$('.section, .submit-card').forEach((s) => io.observe(s));

  // ---------------------------------------------------------------- marketplace preview
  const CUR_SYMBOL = { USD: '$', CAD: 'CA$', EUR: '€', GBP: '£', CNY: '¥', MXN: 'MX$', INR: '₹' };
  const toNum = (v) => { const m = String(v ?? '').replace(/,/g, '').match(/\d+(\.\d+)?|\.\d+/); return m ? Number(m[0]) : null; };
  function money(n, cur) {
    const d = n < 1 ? Math.max(2, Math.min(4, (String(n).split('.')[1] || '').length)) : 2;
    const v = n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    return CUR_SYMBOL[cur] ? `${CUR_SYMBOL[cur]}${v}` : `${v} ${cur}`;
  }
  function termsText() {
    const t = $('[name="pricing.terms"]').value;
    if (!t) return '';
    if (t === 'DELIVERED') return 'delivered';
    const port = $('[name="pricing.port"]').value.trim();
    return `${t}${port ? ' ' + port : ''}`;
  }
  function previewHtml(p, img) {
    const cur = currency();
    const catLabel = (state.cfg.categories.find((c) => c.slug === p.category) || {}).name || 'Packaging';
    const supplier = $('[name="company.business_name"]').value.trim() || 'Your company';
    const tierMin = (p.tiers || []).map((t) => toNum(t.unit_price)).filter((x) => x != null && x > 0);
    let price = p.price_type === 'QUOTE_ONLY' ? null : toNum(p.price);
    if ((price == null || price <= 0) && p.price_type !== 'QUOTE_ONLY' && tierMin.length) price = Math.min(...tierMin);
    const unit = p.unit || 'piece';
    const moq = toNum(p.moq);
    const terms = termsText();
    const priceBlock = price == null || price <= 0
      ? `<div class="mk-tag">Price on request</div><div class="mk-ask">Ask the supplier</div><div class="mk-note">Quote-only listing · the supplier prices your quantity</div>`
      : `<div class="mk-tag">${p.price_type === 'FROM' ? 'From-price' : 'Published price'} · ${esc(cur)}</div>
         <div class="mk-price"><strong>${esc(money(price, cur))}</strong><span>/ ${esc(unit)}</span></div>
         <div class="mk-note">Price per ${esc(unit)}${terms ? `, ${esc(terms)}` : ''}</div>
         <div class="mk-note">${tierMin.length ? `Bulk pricing from ${esc(money(Math.min(...tierMin), cur))}` : 'Excludes shipping, tax and setup'}</div>`;
    return `<div class="mk-card">
      <div class="mk-img">
        ${img ? `<img alt="" src="${esc(img)}">` : `<span class="mk-pending"><b>${esc(catLabel.split(/[ ,]/)[0])}</b>Supplier photo pending</span>`}
        <span class="mk-chip">${p.stock_or_custom === 'CUSTOM' ? 'Custom printed' : 'Stock item'}</span>
      </div>
      <div class="mk-body">
        <div class="mk-sup"><span>${esc(supplier)}</span><span class="mk-pill">Listed</span></div>
        <div class="mk-title${p.name ? '' : ' empty'}">${esc(p.name || 'Your product name')}</div>
        ${priceBlock}
        <div class="mk-moq"><span>Minimum order</span><b class="${moq ? '' : 'none'}">${moq ? `${moq.toLocaleString('en-US')} ${esc(p.moq_unit || 'pcs')}` : 'Not published'}</b></div>
        <div class="mk-meta"><span><i class="dot"></i>Checked today · Supplier-submitted</span>${p.samples === 'Free' || p.samples === 'Paid' ? `<span>✓ Samples available${p.samples === 'Free' ? ' (free)' : ''}</span>` : ''}</div>
        <div class="mk-btn">Add to Quote Basket</div>
      </div></div>`;
  }
  function cardImage(card) {
    const img = (card._images || []).find((i) => !i.error && (i.preview || i.id));
    return img ? img.preview || fileUrl(img.id) : '';
  }
  function updatePreview(card) {
    const box = $('[data-preview]', card);
    if (box) box.innerHTML = previewHtml(collectProduct(card), cardImage(card));
  }
  const refreshAllPreviews = debounce(() => $$('.product-card', productList).forEach(updatePreview), 200);

  function previewAll() {
    const cards = $$('.product-card', productList).filter((c) => productHasContent(collectProduct(c)));
    if (!cards.length) { toast('Add a product first to preview your listings.'); return; }
    const w = modal(`<h3>Your listings on ${esc(state.cfg.brand.name)}</h3>
      <p>This is roughly how brands will see your ${cards.length} product${cards.length > 1 ? 's' : ''} in search results.</p>
      <div class="preview-grid">${cards.map((c) => previewHtml(collectProduct(c), cardImage(c))).join('')}</div>
      <div class="modal-actions"><button class="btn btn-primary" data-close>Close</button></div>`);
    w.firstElementChild.classList.add('wide');
    w.firstElementChild.style.maxWidth = '1080px';
    w.addEventListener('click', (e) => { if (e.target === w || e.target.closest('[data-close]')) w.remove(); });
  }

  // ---------------------------------------------------------------- auto-suggest from product name
  const SUGGEST_FIELDS = ['category', 'material', 'capacity', 'dimensions', 'neck_finish', 'finish', 'thickness'];
  function suggestFromName(card) {
    if (!window.SDGuess) return;
    const name = $('[data-p="name"]', card).value.trim();
    const g = name.length >= 4 ? window.SDGuess.all(name) : {};
    let changedCat = false;
    for (const f of SUGGEST_FIELDS) {
      const el = $(`[data-p="${f}"]`, card);
      if (!el) continue;
      const auto = el.dataset.auto === '1';
      if (el.value.trim() && !auto) continue;            // supplier typed it - never touch
      const v = g[f] || '';
      if (f === 'category' && v && ![...el.options].some((o) => o.value === v)) continue;
      if (el.value !== v) { el.value = v; if (f === 'category') changedCat = true; }
      el.dataset.auto = v ? '1' : '';
      el.closest('.field').classList.toggle('suggested', !!v);
    }
    if (changedCat) syncCard(card);
  }
  // The supplier editing a suggested field makes it theirs.
  productList.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset && el.dataset.auto === '1' && e.isTrusted) { el.dataset.auto = ''; const f = el.closest('.field'); if (f) f.classList.remove('suggested'); }
  });
  productList.addEventListener('change', (e) => {
    const el = e.target;
    if (el.tagName === 'SELECT' && el.dataset.auto === '1' && e.isTrusted) { el.dataset.auto = ''; el.closest('.field').classList.remove('suggested'); }
  });

  // ---------------------------------------------------------------- phone photos: shrink before upload
  async function shrinkImage(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 1.2 * 1024 * 1024) return file;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale);
      c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
      if (!blob || blob.size >= file.size) return file;
      return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
    } catch { return file; }
  }

  // ---------------------------------------------------------------- website auto-fill
  const FILL_FIELDS = [
    ['business_name', 'Company name'], ['email', 'Email'], ['phone', 'Phone'], ['country', 'Country'],
    ['location', 'City'], ['legal_name', 'Registered name'], ['website', 'Website'],
  ];
  let siteData = null;

  function fillCompany(company) {
    const filled = [];
    for (const [key, label] of FILL_FIELDS) {
      const el = form.querySelector(`[name="company.${key}"]`);
      const v = company[key];
      if (!el || !v || el.value.trim()) continue;
      el.value = v;
      el.closest('.field').classList.add('autofilled');
      filled.push(label);
    }
    let certs = 0;
    (company.certifications || []).forEach((c) => {
      const box = form.querySelector(`[name="company.certifications"][value="${CSS.escape(c)}"]`);
      if (box && !box.checked) { box.checked = true; certs++; }
    });
    if (certs) filled.push(`${certs} certification${certs > 1 ? 's' : ''}`);
    changed();
    return filled;
  }

  async function fetchSite() {
    const input = $('#siteUrl');
    const url = input.value.trim();
    const box = $('#siteResult');
    if (!url) { input.focus(); return; }
    const btn = $('#siteFetch');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Reading your site…';
    box.hidden = false;
    box.className = 'autofill-result';
    box.innerHTML = 'Looking at your homepage, contact page and product catalog. This can take up to 20 seconds…';
    try {
      siteData = await api('/api/site-import', { method: 'POST', json: { url } });
      const filled = fillCompany(siteData.company);
      const n = siteData.products.length;
      box.innerHTML = `
        ${filled.length
          ? `<strong>We filled in ${filled.length} field${filled.length > 1 ? 's' : ''} from your site. Please check them below.</strong>
             <div class="found">${filled.map((f) => `<span>✓ ${esc(f)}</span>`).join('')}</div>`
          : '<strong>We read your site, but your details were already filled in (or we couldn’t find them).</strong>'}
        ${n ? `<div class="products-found"><span>We found <strong>${n} product${n > 1 ? 's' : ''}</strong> in your ${esc(siteData.productSource)}.</span>
               <button type="button" class="btn btn-primary btn-sm" id="openPicker">Choose products to import</button></div>`
          : '<div class="products-found"><span>We couldn’t find a product catalog on your site, so please add products below or upload your price list in step 3.</span></div>'}`;
      if (n) $('#openPicker').addEventListener('click', openPicker);
      updateProgress();
    } catch (err) {
      box.className = 'autofill-result error';
      box.textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Fetch my details';
    }
  }

  const catName = (slug) => (state.cfg.categories.find((c) => c.slug === slug) || {}).name || 'Category to choose';

  function openPicker() {
    const items = siteData.products.map((p, i) => ({ ...p, i }));
    const cur = siteData.currency || '';
    const w = modal(`
      <h3>Import products from your site</h3>
      <p>Tick the products you'd like listed. We'll bring in the name, price and photos, and guess the category and material. You can edit everything afterwards.</p>
      <div class="picker-tools">
        <input type="search" placeholder="Search your products…" data-search>
        <button type="button" class="btn btn-sm" data-all>Select all</button>
        <button type="button" class="btn btn-sm btn-ghost" data-none>Clear</button>
      </div>
      <div class="picker-list" data-list></div>
      <div class="picker-foot">
        <span class="hint" data-status>Up to 50 products per import.</span>
        <div style="display:flex;gap:10px"><button type="button" class="btn" data-cancel>Cancel</button>
        <button type="button" class="btn btn-primary" data-import disabled>Import 0 products</button></div>
      </div>`);
    w.firstElementChild.classList.add('wide');
    const list = $('[data-list]', w);
    const chosen = new Set();
    const render = (q = '') => {
      const ql = q.toLowerCase();
      list.innerHTML = items.filter((p) => !ql || p.name.toLowerCase().includes(ql)).map((p) => `
        <label class="picker-item">
          <input type="checkbox" data-i="${p.i}"${chosen.has(p.i) ? ' checked' : ''}>
          ${p.images[0] ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(p.images[0])}" alt="">` : '<span class="noimg"></span>'}
          <span class="pi-main"><div class="pi-name" title="${esc(p.name)}">${esc(p.name)}</div>
            <div class="pi-meta">${esc([catName(p.category), p.material, p.capacity || p.dimensions].filter(Boolean).join(' · '))}</div></span>
          <span class="pi-price">${p.price != null ? `${p.price_type === 'FROM' ? 'from ' : ''}${esc(cur || p.currency || '')} ${esc(p.price)}` : 'No price'}</span>
        </label>`).join('') || '<div class="empty" style="padding:30px;text-align:center;color:var(--ink-3)">No products match.</div>';
    };
    const sync = () => {
      const n = chosen.size;
      const btn = $('[data-import]', w);
      btn.disabled = !n || n > 50;
      btn.textContent = `Import ${n} product${n === 1 ? '' : 's'}`;
      $('[data-status]', w).textContent = n > 50 ? 'Please choose 50 or fewer at a time.' : 'Up to 50 products per import.';
    };
    render();
    list.addEventListener('change', (e) => {
      const i = Number(e.target.dataset.i);
      if (e.target.checked) chosen.add(i); else chosen.delete(i);
      sync();
    });
    $('[data-search]', w).addEventListener('input', (e) => render(e.target.value));
    $('[data-all]', w).addEventListener('click', () => { $$('input[data-i]', list).forEach((c) => { if (chosen.size < 50) { c.checked = true; chosen.add(Number(c.dataset.i)); } }); sync(); });
    $('[data-none]', w).addEventListener('click', () => { chosen.clear(); render($('[data-search]', w).value); sync(); });
    $('[data-cancel]', w).addEventListener('click', () => w.remove());
    w.addEventListener('click', (e) => { if (e.target === w) w.remove(); });
    $('[data-import]', w).addEventListener('click', () => importProducts([...chosen].sort((a, b) => a - b).map((i) => items[i]), w));
  }

  async function importProducts(pickedAll, w) {
    const existing = new Set($$('.product-card [data-p="name"]', productList).map((i) => i.value.trim().toLowerCase()).filter(Boolean));
    const picked = pickedAll.filter((p) => !existing.has(p.name.trim().toLowerCase()));
    const skipped = pickedAll.length - picked.length;
    if (!picked.length) { w.remove(); toast('Those products are already in your form.'); return; }
    if (skipped) toast(`${skipped} product${skipped > 1 ? 's were' : ' was'} already in your form and skipped.`);
    const btn = $('[data-import]', w);
    const status = $('[data-status]', w);
    btn.disabled = true;
    $$('button', w).forEach((b) => { b.disabled = true; });
    // Up to 2 photos per product, downloaded server-side in batches.
    const urls = [];
    picked.forEach((p) => p.images.slice(0, 2).forEach((u) => urls.push(u)));
    const fetched = new Map();
    for (let k = 0; k < urls.length; k += 40) {
      status.innerHTML = `<span class="spinner"></span> Importing photos ${Math.min(k + 40, urls.length)} of ${urls.length}…`;
      const batch = urls.slice(k, k + 40);
      try {
        const r = await api('/api/site-import/images', { method: 'POST', json: { urls: batch } });
        batch.forEach((u, j) => { if (r.images[j]) fetched.set(u, r.images[j]); });
      } catch (e) { toast(`Some photos couldn't be imported: ${e.message}`, 'error'); }
    }
    // Replace the single blank starter card, if untouched.
    const cards = $$('.product-card', productList);
    if (cards.length === 1 && !productHasContent(collectProduct(cards[0]))) cards[0].remove();
    if (siteData.currency) {
      const sel = $('[name="pricing.currency"]');
      if ([...sel.options].some((o) => o.value === siteData.currency)) sel.value = siteData.currency;
    }
    picked.forEach((p) => {
      const card = addProduct({
        name: p.name, category: p.category, material: p.material, capacity: p.capacity, dimensions: p.dimensions,
        neck_finish: p.neck_finish, finish: p.finish,
        price_type: p.price_type, price: p.price == null ? '' : p.price, description: p.description, stock_or_custom: 'STOCK',
        images: p.images.slice(0, 2).map((u) => fetched.get(u)).filter(Boolean),
      });
      card.classList.add('collapsed');
      $('.pnum', card).insertAdjacentHTML('afterend', '<span class="imported-tag">Imported</span>');
    });
    $$('.product-card', productList).forEach(syncCard);
    renumber();
    w.remove();
    changed();
    updateProgress();
    $('#sec-products').scrollIntoView({ behavior: 'smooth' });
    showNotice(`<span>Imported <strong>${picked.length} product${picked.length > 1 ? 's' : ''}</strong>. We guessed each product's category and material, so open each one to check them and add MOQ and lead time.</span>`, 'info');
  }

  // ---------------------------------------------------------------- apply to all
  function segHtml(key, options) {
    return `<div class="seg">${options.map(([v, l]) => `<label><input type="radio" name="aa_${key}" value="${esc(v)}"><span>${esc(l)}</span></label>`).join('')}</div>`;
  }
  function openApplyAll() {
    const cards = $$('.product-card', productList);
    if (cards.length < 2) { toast('Add at least two products to use "Apply to all".'); return; }
    const w = modal(`<h3>Apply to all ${cards.length} products</h3>
      <p>Fill in only what's the same for every product. Fields you leave blank stay as they are.</p>
      <div class="grid" style="gap:14px 16px">
        <div class="field"><label>Category</label><select data-aa="category"><option value="">(leave as is)</option>${state.cfg.categories.map((c) => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Material</label><input type="text" data-aa="material"></div>
        <div class="field"><label>Minimum order (MOQ)</label><input type="text" inputmode="numeric" data-aa="moq" placeholder="e.g. 1000"></div>
        <div class="field"><label>Production lead time (days)</label><input type="text" inputmode="numeric" data-aa="lead_time_days" placeholder="e.g. 15"></div>
        <div class="field"><label>Price per</label><input type="text" data-aa="unit" list="unitList" placeholder="piece"></div>
        <div class="field"><label>Printing setup / plate cost</label><input type="text" data-aa="setup_cost" placeholder="e.g. $150 per color plate"></div>
        <div class="field"><span class="label">Availability</span>${segHtml('stock_or_custom', [['STOCK', 'Ready stock'], ['CUSTOM', 'Made to order']])}</div>
        <div class="field"><span class="label">Custom printing?</span>${segHtml('printing', [['Yes', 'Yes'], ['No', 'No']])}</div>
        <div class="field"><span class="label">Food safe (FDA / EU)?</span>${segHtml('food_grade', [['Yes', 'Yes'], ['No', 'No']])}</div>
        <div class="field"><span class="label">Samples</span>${segHtml('samples', [['Free', 'Free'], ['Paid', 'Paid'], ['No', 'No']])}</div>
        <div class="field span-2"><label>Sample cost</label><input type="text" data-aa="sample_cost" placeholder="e.g. $25 incl. shipping"></div>
      </div>
      <label class="check-pill" style="margin-top:14px;display:inline-block"><input type="checkbox" data-overwrite><span>Also replace values already filled in</span></label>
      <div class="modal-actions"><button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-apply>Apply to ${cards.length} products</button></div>`);
    w.firstElementChild.classList.add('wide');
    w.firstElementChild.style.overflow = 'auto';
    w.addEventListener('click', (e) => { if (e.target === w || e.target.closest('[data-cancel]')) w.remove(); });
    $('[data-apply]', w).addEventListener('click', () => {
      const overwrite = $('[data-overwrite]', w).checked;
      const values = {};
      $$('[data-aa]', w).forEach((el) => { if (el.value.trim()) values[el.dataset.aa] = el.value.trim(); });
      ['stock_or_custom', 'printing', 'food_grade', 'samples'].forEach((k) => { const r = $(`input[name="aa_${k}"]:checked`, w); if (r) values[k] = r.value; });
      if (!Object.keys(values).length) { toast('Fill in at least one field to apply.'); return; }
      let touched = 0;
      $$('.product-card', productList).forEach((card) => {
        let did = false;
        for (const [k, v] of Object.entries(values)) {
          const radios = $$(`input[type=radio][data-p="${k}"]`, card);
          if (radios.length) {
            if (!overwrite && radios.some((r) => r.checked) && k !== 'samples') continue;
            radios.forEach((r) => { r.checked = r.value === v; });
            did = true;
            continue;
          }
          const el = $(`[data-p="${k}"]`, card);
          if (!el || (!overwrite && el.value.trim() && el.dataset.auto !== '1')) continue;
          el.value = v;
          el.dataset.auto = '';
          const f = el.closest('.field'); if (f) f.classList.remove('suggested');
          did = true;
        }
        if (did) { touched++; syncCard(card); }
      });
      w.remove();
      changed();
      toast(`Updated ${touched} product${touched === 1 ? '' : 's'}.`);
    });
  }

  // ---------------------------------------------------------------- spreadsheet import
  const SHEET_FIELDS = [
    ['name', 'Product name', true], ['sku', 'SKU / model no.'], ['category', 'Category'], ['subcategory', 'Type'], ['material', 'Material'],
    ['capacity', 'Capacity'], ['dimensions', 'Size'], ['thickness', 'Thickness'], ['neck_finish', 'Neck finish'], ['closure', 'Closure'],
    ['finish', 'Color / finish'], ['price', 'Unit price'], ['unit', 'Price per'], ['moq', 'MOQ'], ['lead_time_days', 'Lead time (days)'],
    ['description', 'Description'], ['image', 'Image URL'],
  ];
  const catNorm = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
  function matchCategory(v) {
    if (!v) return '';
    const n = catNorm(v);
    const cats = state.cfg.categories;
    const exact = cats.find((c) => catNorm(c.name) === n || c.slug === n.replace(/ /g, '-'));
    if (exact) return exact.slug;
    const partial = cats.find((c) => catNorm(c.name).includes(n) || n.includes(catNorm(c.name).split(' ')[0]));
    return partial ? partial.slug : (window.SDGuess ? window.SDGuess.category(v) : '');
  }

  async function handleSheet(file) {
    if (!file) return;
    const btn = $('#sheetBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Reading spreadsheet…';
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/sheet-import', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not read that file');
      openMapping(data, file);
    } catch (e) { toast(e.message, 'error'); }
    finally { btn.disabled = false; btn.innerHTML = '<svg class="i"><use href="#i-sheet"/></svg>Upload spreadsheet'; }
  }

  function openMapping(data, file) {
    const map = { ...data.mapping };
    const sample = (col) => { const v = data.rows.map((r) => r[col]).find(Boolean); return v ? ` (e.g. ${String(v).slice(0, 28)})` : ''; };
    const colOptions = data.headers.map((h, i) => `<option value="${i}">${esc(h)}${esc(sample(i))}</option>`).join('');
    const w = modal(`<h3>Match your columns</h3>
      <p>We read <strong>${data.total} row${data.total === 1 ? '' : 's'}</strong> from “${esc(data.sheet)}”${data.truncated ? ' (first 1,000 only)' : ''}. Check that each field points at the right column. We guessed these for you.</p>
      <div style="overflow:auto;flex:1;min-height:0">
        <div class="grid" style="gap:10px 16px">
          ${SHEET_FIELDS.map(([k, label, req]) => `<div class="field"><label>${esc(label)}${req ? '<span class="req">*</span>' : ''}</label>
            <select data-map="${k}"><option value="">(not in my file)</option>${colOptions}</select></div>`).join('')}
        </div>
        ${data.tiers.length ? `<p class="hint" style="margin:14px 0 0">Bulk price columns found: ${data.tiers.map((t) => `<strong>${esc(data.headers[t.col])}</strong> → price at ${t.min_qty.toLocaleString('en-US')}+`).join(', ')}.</p>` : ''}
        <div class="subhead" style="margin-top:18px">Preview</div>
        <div data-preview-rows></div>
      </div>
      <div class="picker-foot"><span class="hint" data-status></span>
        <div style="display:flex;gap:10px"><button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-go>Import</button></div></div>`);
    w.firstElementChild.classList.add('wide');
    $$('[data-map]', w).forEach((s) => { s.value = map[s.dataset.map] != null ? String(map[s.dataset.map]) : ''; });
    const readMap = () => { const m = {}; $$('[data-map]', w).forEach((s) => { if (s.value !== '') m[s.dataset.map] = Number(s.value); }); return m; };
    const refresh = () => {
      const m = readMap();
      const products = rowsToProducts(data, m);
      const room = Math.max(0, 200 - $$('.product-card', productList).filter((c) => productHasContent(collectProduct(c))).length);
      $('[data-preview-rows]', w).innerHTML = m.name == null ? '<p class="err">Choose which column has the product name.</p>'
        : `<table class="data" style="width:100%;font-size:13px;border-collapse:collapse">${products.slice(0, 5).map((p) =>
          `<tr><td style="padding:6px 8px;border-bottom:1px solid var(--line)"><strong>${esc(p.name)}</strong><div class="hint">${esc([catName(p.category), p.material, p.capacity || p.dimensions].filter(Boolean).join(' · '))}</div></td>
           <td style="padding:6px 8px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap">${p.price ? esc(money(toNum(p.price), currency())) : '<span class="hint">no price</span>'}${p.tiers.length ? `<div class="hint">${p.tiers.length} bulk prices</div>` : ''}</td></tr>`).join('')}</table>
           ${products.length > 5 ? `<p class="hint">…and ${products.length - 5} more.</p>` : ''}`;
      const n = Math.min(products.length, room);
      const go = $('[data-go]', w);
      go.disabled = !n;
      go.textContent = `Import ${n} product${n === 1 ? '' : 's'}`;
      $('[data-status]', w).textContent = products.length > room ? `Only ${room} more products fit in one submission. Your full file is still kept for our team.` : '';
      return products.slice(0, room);
    };
    refresh();
    w.addEventListener('change', (e) => { if (e.target.dataset.map) refresh(); });
    w.addEventListener('click', (e) => { if (e.target === w || e.target.closest('[data-cancel]')) w.remove(); });
    $('[data-go]', w).addEventListener('click', async () => {
      const products = refresh();
      $$('button, select', w).forEach((b) => { b.disabled = true; });
      await addImportedProducts(products, (msg) => { $('[data-status]', w).innerHTML = msg; });
      // Keep the original spreadsheet too, so our team has the full price list.
      if (!state.docs.some((d) => d.name === file.name && d.size === file.size)) addDocFiles([file]);
      w.remove();
      showNotice(`<span>Imported <strong>${products.length} product${products.length === 1 ? '' : 's'}</strong> from your spreadsheet. Check the category and material we suggested, and use <strong>Apply to all</strong> for terms that are the same across products.</span>`, 'info');
    });
  }

  function rowsToProducts(data, m) {
    const get = (row, k) => (m[k] != null ? String(row[m[k]] || '').trim() : '');
    const out = [];
    for (const row of data.rows) {
      let name = get(row, 'name');
      if (!name) continue;
      const sku = get(row, 'sku');
      if (sku && !name.includes(sku)) name = `${name} (${sku})`;
      const g = window.SDGuess ? window.SDGuess.all(name, get(row, 'description')) : {};
      const tiers = data.tiers.map((t, i) => ({
        min_qty: String(t.min_qty),
        max_qty: data.tiers[i + 1] ? String(data.tiers[i + 1].min_qty - 1) : '',
        unit_price: String(toNum(row[t.col]) ?? ''),
      })).filter((t) => t.unit_price);
      let price = get(row, 'price');
      if (!toNum(price) && tiers.length) price = tiers[0].unit_price;
      let moq = get(row, 'moq');
      if (!toNum(moq) && tiers.length) moq = tiers[0].min_qty;
      const images = (get(row, 'image').match(/https?:\/\/[^\s,;"']+/g) || []).slice(0, 2);
      out.push({
        name,
        category: matchCategory(get(row, 'category')) || g.category || '',
        subcategory: get(row, 'subcategory'),
        material: get(row, 'material') || g.material || '',
        capacity: get(row, 'capacity') || g.capacity || '',
        dimensions: get(row, 'dimensions') || g.dimensions || '',
        thickness: get(row, 'thickness') || g.thickness || '',
        neck_finish: get(row, 'neck_finish') || g.neck_finish || '',
        closure: get(row, 'closure'),
        finish: get(row, 'finish') || g.finish || '',
        price_type: toNum(price) ? 'EXACT' : 'QUOTE_ONLY',
        price: toNum(price) ? String(toNum(price)) : '',
        unit: get(row, 'unit'),
        moq: toNum(moq) ? String(toNum(moq)) : '',
        lead_time_days: toNum(get(row, 'lead_time_days')) ? String(toNum(get(row, 'lead_time_days'))) : '',
        description: get(row, 'description').slice(0, 1500),
        tiers: tiers.length > 1 || (tiers.length === 1 && tiers[0].unit_price !== price) ? tiers : [],
        imageUrls: images,
      });
    }
    return out;
  }

  // Shared by website + spreadsheet import: fetch photos, then create collapsed cards.
  async function addImportedProducts(products, status) {
    const urls = [...new Set(products.flatMap((p) => p.imageUrls || []))];
    const fetched = new Map();
    for (let k = 0; k < urls.length; k += 40) {
      status(`<span class="spinner"></span> Importing photos ${Math.min(k + 40, urls.length)} of ${urls.length}…`);
      const batch = urls.slice(k, k + 40);
      try {
        const r = await api('/api/site-import/images', { method: 'POST', json: { urls: batch } });
        batch.forEach((u, j) => { if (r.images[j]) fetched.set(u, r.images[j]); });
      } catch (e) { toast(`Some photos couldn't be imported: ${e.message}`, 'error'); }
    }
    status('<span class="spinner"></span> Adding products…');
    const cards = $$('.product-card', productList);
    if (cards.length === 1 && !productHasContent(collectProduct(cards[0]))) cards[0].remove();
    const existing = new Set($$('.product-card [data-p="name"]', productList).map((i) => i.value.trim().toLowerCase()));
    let added = 0;
    for (const p of products) {
      if (existing.has(p.name.toLowerCase())) continue;
      existing.add(p.name.toLowerCase());
      const { imageUrls, ...rest } = p;
      const card = addProduct({ ...rest, images: (imageUrls || []).map((u) => fetched.get(u)).filter(Boolean) });
      card.classList.add('collapsed');
      $('.pnum', card).insertAdjacentHTML('afterend', '<span class="imported-tag">Imported</span>');
      added++;
    }
    renumber();
    changed();
    updateProgress();
    $('#sec-products').scrollIntoView({ behavior: 'smooth' });
    return added;
  }

  $('#sheetBtn').addEventListener('click', () => $('#sheetInput').click());
  $('#sheetInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; handleSheet(f); });
  $('#applyAllBtn').addEventListener('click', openApplyAll);
  $('#previewAllBtn').addEventListener('click', previewAll);
  form.addEventListener('input', (e) => { if (['company.business_name', 'pricing.port'].includes(e.target.name)) refreshAllPreviews(); });
  form.addEventListener('change', (e) => { if (['pricing.currency', 'pricing.terms'].includes(e.target.name)) refreshAllPreviews(); });

  $('#siteFetch').addEventListener('click', fetchSite);
  $('#siteUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fetchSite(); } });
  form.addEventListener('input', (e) => { const f = e.target.closest('.field.autofilled'); if (f) f.classList.remove('autofilled'); });

  // ---------------------------------------------------------------- init
  async function init() {
    try { state.cfg = await api('/api/config'); }
    catch (e) { document.body.innerHTML = `<p style="padding:40px;text-align:center">${esc(e.message)}</p>`; return; }
    const { cfg } = state;
    document.title = `Supplier Portal · ${cfg.brand.name}`;
    $$('[data-brand-name]').forEach((el) => { el.textContent = cfg.brand.name; });
    $$('[data-brand-initial]').forEach((el) => { el.textContent = cfg.brand.name.charAt(0); });
    $$('[data-brand-tagline]').forEach((el) => { el.textContent = cfg.brand.tagline; });
    if (cfg.brand.contactEmail) $('#contactLine').innerHTML = `Questions? <a href="mailto:${esc(cfg.brand.contactEmail)}">${esc(cfg.brand.contactEmail)}</a>`;
    const cur = $('[name="pricing.currency"]');
    cur.innerHTML = cfg.currencies.map((c) => `<option>${esc(c)}</option>`).join('');
    $('[data-terms]').innerHTML = '<option value="">Select…</option>' + cfg.priceTerms.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
    $('#countryList').innerHTML = cfg.countries.map((c) => `<option value="${esc(c)}"></option>`).join('');
    $('#certList').innerHTML = cfg.certifications.map((c) =>
      `<label class="check-pill"><input type="checkbox" name="company.certifications" value="${esc(c)}"><span>${esc(c)}</span></label>`).join('');
    $('#docHint').textContent = `PDF, Excel, Word, images · up to ${cfg.uploads.maxFileSizeMB} MB each`;

    const [, kind, tok] = location.pathname.match(/^\/(s|e)\/([^/]+)/) || [];
    try {
      if (kind === 'e') await loadExisting(tok);
      else if (kind === 's') {
        state.inviteToken = tok;
        state.mode = 'invite';
        const inv = await api(`/api/invite/${encodeURIComponent(tok)}`);
        if (inv.edit_token) { history.replaceState(null, '', `/e/${inv.edit_token}`); await loadExisting(inv.edit_token); }
        else {
          if (!restoreLocal()) populate({ company: { business_name: inv.supplier_name || '', email: inv.contact_email || '' } });
          if (inv.supplier_name) showNotice(`<span>Welcome, <strong>${esc(inv.supplier_name)}</strong>. This is your personal link. You can save a draft and come back any time.</span>`, 'info');
        }
      } else if (!restoreLocal()) populate({});
    } catch (err) {
      $('#formView').innerHTML = `<div class="success"><div class="success-card"><h1>Link not available</h1><p style="color:var(--ink-2)">${esc(err.message)}</p>
        ${cfg.allowOpenSubmissions ? '<a class="btn btn-primary" href="/apply">Start a new submission</a>' : ''}</div></div>`;
      $('#saveDraftTop').hidden = true;
      return;
    }
    if (!cfg.allowOpenSubmissions && state.mode === 'new') {
      $('#formView').innerHTML = '<div class="success"><div class="success-card"><h1>Invitation required</h1><p>Please use the invitation link you received.</p></div></div>';
    }
    $$('.product-card', productList).forEach(syncCard);
    syncPort();
    updateProgress();
  }

  function syncPort() {
    const t = $('[name="pricing.terms"]').value;
    $('[data-port]').hidden = !['FOB', 'CIF', 'EXW'].includes(t);
  }

  async function loadExisting(tok) {
    const s = await api(`/api/submission/${encodeURIComponent(tok)}`);
    Object.assign(state, { mode: 'edit', editToken: tok, status: s.status, refId: s.ref_id });
    populate(s);
    applyModeUi();
    $('#saveState').textContent = `Last saved ${fmtDate(s.updated_at, true)}`;
  }

  function restoreLocal() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(storageKey()) || 'null'); } catch {}
    if (!saved || !saved.data) return false;
    populate(saved.data);
    showNotice(`<span>We restored what you entered earlier on this device (${esc(fmtDate(saved.savedAt, true))}).</span>
      <button type="button" class="btn btn-sm" id="startOver">Start over</button>`);
    $('#startOver').addEventListener('click', async () => {
      if (!(await confirmModal('Start over?', 'This clears everything you have entered on this page.', 'Clear form'))) return;
      try { localStorage.removeItem(storageKey()); } catch {}
      location.reload();
    });
    return true;
  }

  init();
})();
