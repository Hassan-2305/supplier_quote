// File storage: local folder in development, a private Supabase Storage bucket
// in production (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).
//
// On Vercel, request and response bodies are capped at 4.5 MB, so large files
// never pass through the server: browsers upload straight to Supabase with a
// one-time signed upload URL, and downloads redirect to short-lived signed URLs.
const fs = require('fs');
const path = require('path');
const config = require('../config');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BUCKET = process.env.SUPABASE_BUCKET || 'supplier-files';
const remote = !!(SUPABASE_URL && KEY);

const enc = (key) => key.split('/').map(encodeURIComponent).join('/');
const headers = (extra = {}) => ({ Authorization: `Bearer ${KEY}`, apikey: KEY, ...extra });

async function sb(method, p, { body, json, headers: h } = {}) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1${p}`, {
    method,
    headers: headers({ ...(json ? { 'Content-Type': 'application/json' } : {}), ...(h || {}) }),
    body: json ? JSON.stringify(json) : body,
  });
  return res;
}

let bucketReady = null;
function ensureBucket() {
  if (!remote) return Promise.resolve();
  if (!bucketReady) {
    bucketReady = (async () => {
      const r = await sb('GET', `/bucket/${encodeURIComponent(BUCKET)}`);
      if (r.ok) return;
      const c = await sb('POST', '/bucket', { json: { id: BUCKET, name: BUCKET, public: false, file_size_limit: config.uploads.maxFileSizeMB * 1024 * 1024 } });
      if (!c.ok && c.status !== 409) {
        const t = await c.text();
        if (!/already exists/i.test(t)) throw new Error(`Could not create storage bucket: ${c.status} ${t.slice(0, 200)}`);
      }
    })().catch((e) => { bucketReady = null; throw e; });
  }
  return bucketReady;
}

const localPath = (key) => path.join(config.uploadDir, key);

const storage = {
  remote,

  /** Save bytes the server already has (site-import photos). */
  async put(key, buffer, mime) {
    if (!remote && process.env.VERCEL) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set in the Vercel project settings.');
    if (!remote) {
      fs.mkdirSync(config.uploadDir, { recursive: true });
      fs.writeFileSync(localPath(key), buffer);
      return;
    }
    await ensureBucket();
    const r = await sb('POST', `/object/${encodeURIComponent(BUCKET)}/${enc(key)}`, {
      body: buffer, headers: { 'Content-Type': mime || 'application/octet-stream', 'x-upsert': 'true' },
    });
    if (!r.ok) throw new Error(`Upload to storage failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  },

  /** Read a whole file (exports and ZIPs). */
  async getBuffer(key) {
    if (!remote) {
      const p = localPath(key);
      return fs.existsSync(p) ? fs.readFileSync(p) : null;
    }
    const r = await sb('GET', `/object/authenticated/${encodeURIComponent(BUCKET)}/${enc(key)}`);
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  },

  /** Size in bytes, or null if the file isn't there. */
  async stat(key) {
    if (!remote) {
      const p = localPath(key);
      return fs.existsSync(p) ? { size: fs.statSync(p).size } : null;
    }
    const r = await sb('HEAD', `/object/authenticated/${encodeURIComponent(BUCKET)}/${enc(key)}`);
    if (!r.ok) return null;
    return { size: Number(r.headers.get('content-length')) || null };
  },

  async remove(keys) {
    const list = (keys || []).filter(Boolean);
    if (!list.length) return;
    if (!remote) { list.forEach((k) => fs.rm(localPath(k), { force: true }, () => {})); return; }
    await sb('DELETE', `/object/${encodeURIComponent(BUCKET)}`, { json: { prefixes: list } }).catch(() => {});
  },

  /** Signed URL the browser can PUT the file to (remote only). */
  async signUpload(key) {
    if (!remote) return null;
    await ensureBucket();
    const r = await sb('POST', `/object/upload/sign/${encodeURIComponent(BUCKET)}/${enc(key)}`, { json: {} });
    if (!r.ok) throw new Error(`Could not prepare upload: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return `${SUPABASE_URL}/storage/v1${j.url}`;
  },

  /** Short-lived signed download URL (remote only). download=filename forces "save as". */
  async signDownload(key, { download, expiresIn = 300 } = {}) {
    if (!remote) return null;
    const r = await sb('POST', `/object/sign/${encodeURIComponent(BUCKET)}/${enc(key)}`, { json: { expiresIn } });
    if (!r.ok) return null;
    const j = await r.json();
    const u = `${SUPABASE_URL}/storage/v1${j.signedURL || j.signedUrl}`;
    return download ? `${u}${u.includes('?') ? '&' : '?'}download=${encodeURIComponent(download)}` : u;
  },

  /** Stream a file to an Express response: local sendFile, or redirect to a signed URL. */
  async send(res, f, inline) {
    const ext = path.extname(f.original_name).toLowerCase();
    const isImage = config.uploads.imageExtensions.includes(ext);
    const showInline = inline && (isImage || ext === '.pdf');
    if (remote) {
      const url = await storage.signDownload(f.stored_name, { download: showInline ? undefined : f.original_name });
      if (!url) return res.status(404).end();
      res.setHeader('Cache-Control', 'private, max-age=60');
      return res.redirect(302, url);
    }
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Content-Type', showInline ? (f.mime || 'application/octet-stream') : 'application/octet-stream');
    res.setHeader('Content-Disposition', `${showInline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.original_name)}`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(localPath(f.stored_name), (err) => { if (err && !res.headersSent) res.status(404).end(); });
  },
};

module.exports = storage;
