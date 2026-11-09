/* Shared browser helpers */
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  async function api(url, opts = {}) {
    const init = { credentials: 'same-origin', ...opts, headers: { ...(opts.headers || {}) } };
    if (opts.json !== undefined) {
      init.body = JSON.stringify(opts.json);
      init.headers['Content-Type'] = 'application/json';
      delete init.json;
    }
    let res;
    try { res = await fetch(url, init); } catch (e) { throw Object.assign(new Error('Network error - check your connection and try again.'), { network: true }); }
    const ct = res.headers.get('content-type') || '';
    const body = ct.includes('json') ? await res.json().catch(() => ({})) : await res.text();
    if (!res.ok) throw Object.assign(new Error((body && body.error) || `Request failed (${res.status})`), { status: res.status, body });
    return body;
  }

  let toastTimer;
  function toast(msg, type) {
    let el = $('#toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.className = `toast${type === 'error' ? ' error' : ''}`;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, type === 'error' ? 6000 : 3200);
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function bytes(n) {
    if (n == null) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1048576).toFixed(1)} MB`;
  }
  const ext = (name) => (String(name).match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch {} ta.remove();
    }
    toast('Copied to clipboard');
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    const src = $(b.getAttribute('data-copy'));
    copyText(src ? (src.value || src.textContent) : b.getAttribute('data-copy'));
  });

  function fmtDate(iso, withTime) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) });
  }

  const COUNTRIES = ['India', 'United Arab Emirates', 'United States', 'United Kingdom', 'China', 'Bangladesh', 'Sri Lanka', 'Nepal', 'Pakistan',
    'Vietnam', 'Thailand', 'Indonesia', 'Malaysia', 'Singapore', 'Philippines', 'Japan', 'South Korea', 'Taiwan', 'Hong Kong', 'Turkey',
    'Saudi Arabia', 'Qatar', 'Oman', 'Kuwait', 'Bahrain', 'Egypt', 'Kenya', 'South Africa', 'Nigeria', 'Morocco', 'Germany', 'France',
    'Italy', 'Spain', 'Portugal', 'Netherlands', 'Belgium', 'Poland', 'Sweden', 'Denmark', 'Switzerland', 'Austria', 'Ireland', 'Canada',
    'Mexico', 'Brazil', 'Argentina', 'Chile', 'Australia', 'New Zealand'];

  window.SD = { $, $$, api, toast, esc, bytes, ext, copyText, fmtDate, COUNTRIES };
})();
