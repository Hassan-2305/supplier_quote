// "Enter your website" auto-fill.
// Fetches a supplier's public site and pulls out company details and, where the
// store exposes them (Shopify / WooCommerce / schema.org), their products.
//
// Security: suppliers control the URL, so every request goes through safeGet(),
// which only allows http(s) on ports 80/443, resolves DNS itself and refuses
// private / loopback / link-local addresses (re-checked on every redirect, and
// the vetted address is the one actually connected to - no DNS rebinding),
// with tight timeouts and size caps.
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const zlib = require('zlib');
const config = require('../config');

const UA = 'Mozilla/5.0 (compatible; SupplierPortal/1.0; +product-listing-import)';

// ------------------------------------------------------------------ safe fetch
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0)
      || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
  }
  return true;
}

function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = addrs.filter((a) => !isPrivateIp(a.address));
    if (!ok.length || ok.length !== addrs.length) return cb(Object.assign(new Error('Blocked address'), { code: 'EBLOCKED' }));
    if (options && options.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}

function safeGet(rawUrl, { maxBytes = 3 * 1024 * 1024, timeout = 10000, accept = '*/*', redirects = 4 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(rawUrl); } catch { return reject(new Error('Invalid URL')); }
    if (!['http:', 'https:'].includes(url.protocol)) return reject(new Error('Only http(s) links are supported'));
    if (url.port && !['80', '443'].includes(url.port)) return reject(new Error('Port not allowed'));
    if (url.username || url.password) return reject(new Error('Invalid URL'));
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isPrivateIp(host)) return reject(new Error('Blocked address'));
    if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) return reject(new Error('Blocked address'));

    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(url, {
      lookup: safeLookup,
      headers: { 'User-Agent': UA, Accept: accept, 'Accept-Encoding': 'gzip, deflate, br', 'Accept-Language': 'en-US,en;q=0.8' },
      timeout,
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('Too many redirects'));
        let next;
        try { next = new URL(res.headers.location, url).toString(); } catch { return reject(new Error('Bad redirect')); }
        return safeGet(next, { maxBytes, timeout, accept, redirects: redirects - 1 }).then(resolve, reject);
      }
      let stream = res;
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = [];
      let size = 0;
      stream.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(); stream.destroy(); reject(new Error('Response too large')); return; }
        chunks.push(c);
      });
      stream.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks), url: url.toString() }));
      stream.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
    // Hard deadline covering slow-drip responses too.
    setTimeout(() => req.destroy(new Error('Timed out')), timeout + 2000).unref();
  });
}

async function getText(url, opts) {
  const r = await safeGet(url, { accept: 'text/html,application/xhtml+xml,*/*;q=0.8', ...opts });
  return { ...r, text: r.body.toString('utf8') };
}
async function getJson(url) {
  const r = await safeGet(url, { accept: 'application/json', maxBytes: 6 * 1024 * 1024 });
  if (r.status !== 200) return null;
  try { return JSON.parse(r.body.toString('utf8')); } catch { return null; }
}

// ------------------------------------------------------------------ html helpers
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", ndash: '–', mdash: '—', trade: '™', reg: '®' };
const decode = (s) => String(s || '').replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENT[e.toLowerCase()] ?? m;
});
const stripTags = (html) => decode(String(html || '').replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|div|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t\r]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
const clean = (s, max = 300) => decode(String(s || '')).replace(/\s+/g, ' ').trim().slice(0, max);

function attrs(tag) {
  const out = {};
  tag.replace(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g, (m, k, _v, a, b, c) => { out[k.toLowerCase()] = a ?? b ?? c ?? ''; });
  return out;
}
function metaTags(html) {
  const m = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const a = attrs(tag);
    const key = (a.property || a.name || a.itemprop || '').toLowerCase();
    if (key && a.content && !(key in m)) m[key] = decode(a.content);
  }
  return m;
}
function jsonLd(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const flat = (x) => {
        if (Array.isArray(x)) return x.forEach(flat);
        if (x && typeof x === 'object') { out.push(x); if (x['@graph']) flat(x['@graph']); }
      };
      flat(JSON.parse(m[1].trim()));
    } catch {}
  }
  return out;
}
const typeIs = (o, ...types) => [].concat(o['@type'] || []).some((t) => types.includes(String(t)));

// ------------------------------------------------------------------ company extraction
const COUNTRY_ALIASES = {
  US: 'United States', USA: 'United States', 'UNITED STATES': 'United States', 'UNITED STATES OF AMERICA': 'United States',
  CN: 'China', CHINA: 'China', PRC: 'China', "PEOPLE'S REPUBLIC OF CHINA": 'China', CA: 'Canada', CANADA: 'Canada', MX: 'Mexico', MEXICO: 'Mexico',
  VN: 'Vietnam', VIETNAM: 'Vietnam', TW: 'Taiwan', TAIWAN: 'Taiwan', HK: 'Hong Kong', 'HONG KONG': 'Hong Kong', IN: 'India', INDIA: 'India',
  GB: 'United Kingdom', UK: 'United Kingdom', 'UNITED KINGDOM': 'United Kingdom', DE: 'Germany', GERMANY: 'Germany', TR: 'Turkey', TURKEY: 'Turkey',
  IT: 'Italy', ITALY: 'Italy',
};
const normCountry = (c) => (c ? COUNTRY_ALIASES[String(c).trim().toUpperCase()] || clean(c, 60) : '');
const TLD_COUNTRY = { cn: 'China', 'com.cn': 'China', hk: 'Hong Kong', tw: 'Taiwan', vn: 'Vietnam', mx: 'Mexico', ca: 'Canada', in: 'India', 'co.uk': 'United Kingdom', de: 'Germany', it: 'Italy', tr: 'Turkey' };
const US_STATES = 'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY';
const CN_PROVINCES = ['Guangdong', 'Zhejiang', 'Jiangsu', 'Fujian', 'Shandong', 'Shanghai', 'Beijing', 'Hebei', 'Henan', 'Anhui', 'Hubei', 'Hunan', 'Tianjin', 'Sichuan', 'Liaoning', 'Jiangxi', 'Chongqing'];

const BAD_EMAIL = /(example\.|sentry|wixpress|\.png|\.jpe?g|\.gif|\.webp|\.svg|u003e|@2x|domain\.com|email\.com|yourcompany|@sentry)/i;

function extractCompany(pages, rootUrl) {
  const found = {};
  const emails = new Map();
  const phones = [];
  const certs = new Set();
  const host = new URL(rootUrl).hostname.replace(/^www\./, '');

  for (const { html } of pages) {
    const meta = metaTags(html);
    const ld = jsonLd(html);
    const org = ld.find((o) => typeIs(o, 'Organization', 'Corporation', 'LocalBusiness', 'Store', 'OnlineStore', 'Manufacturer'));
    if (org) {
      if (!found.business_name && org.name) found.business_name = clean(org.name, 150);
      if (!found.legal_name && org.legalName) found.legal_name = clean(org.legalName, 200);
      if (org.email) emails.set(String(org.email).replace(/^mailto:/i, '').trim().toLowerCase(), 10);
      if (org.telephone) phones.unshift(clean(org.telephone, 40));
      const addr = [].concat(org.address || [])[0];
      if (addr && typeof addr === 'object') {
        if (!found.location) found.location = [addr.addressLocality, addr.addressRegion].filter(Boolean).map((x) => clean(x, 60)).join(', ');
        if (!found.country) found.country = normCountry(typeof addr.addressCountry === 'object' ? addr.addressCountry.name : addr.addressCountry);
      }
    }
    if (!found.business_name && meta['og:site_name']) found.business_name = clean(meta['og:site_name'], 150);
    if (!found.description && (meta['og:description'] || meta.description)) found.description = clean(meta['og:description'] || meta.description, 400);

    for (const m of html.matchAll(/href=["']mailto:([^"'?\s]+)/gi)) {
      const e = decodeURIComponent(m[1]).trim().toLowerCase();
      emails.set(e, (emails.get(e) || 0) + 3);
    }
    for (const m of html.matchAll(/href=["']tel:([^"']+)/gi)) phones.push(clean(decodeURIComponent(m[1]), 40));
    const text = stripTags(html);
    for (const m of text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) {
      const e = m[0].toLowerCase().replace(/\.$/, '');
      emails.set(e, (emails.get(e) || 0) + 1);
    }
    for (const c of config.certifications) {
      const pattern = c.split(' / ')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s?');
      if (new RegExp(`\\b${pattern}\\b`, 'i').test(text)) certs.add(c);
    }
    if (/\bBRC(GS)?\b/.test(text)) certs.add('BRCGS Packaging');
    if (!found.location) {
      const us = text.match(new RegExp(`\\b([A-Z][a-zA-Z .'-]{2,30}),\\s?(${US_STATES})\\s\\d{5}(?:-\\d{4})?\\b`));
      if (us) { found.location = `${us[1].trim()}, ${us[2]}`; found.country = found.country || 'United States'; }
    }
    if (!found.location) {
      const prov = CN_PROVINCES.find((p) => new RegExp(`\\b${p}\\b`).test(text));
      const city = prov && text.match(new RegExp(`\\b([A-Z][a-z]{2,15})(?:\\s+City)?,\\s*${prov}\\b`));
      if (prov) { found.location = city ? `${city[1]}, ${prov}` : prov; found.country = found.country || 'China'; }
    }
  }

  // Prefer emails on the company's own domain.
  const ranked = [...emails.entries()].filter(([e]) => !BAD_EMAIL.test(e) && /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e))
    .map(([e, score]) => [e, score + (e.endsWith('@' + host) || e.endsWith('.' + host) ? 20 : 0) + (/^(sales|info|contact|hello|inquiry|enquiry)@/.test(e) ? 5 : 0)])
    .sort((a, b) => b[1] - a[1]);
  if (ranked.length) found.email = ranked[0][0];
  const phone = phones.map((p) => p.replace(/[^\d+()\s.-]/g, '').trim()).find((p) => p.replace(/\D/g, '').length >= 7);
  if (phone) found.phone = phone;

  if (!found.country) {
    const tld = Object.keys(TLD_COUNTRY).sort((a, b) => b.length - a.length).find((t) => host.endsWith('.' + t));
    if (tld) found.country = TLD_COUNTRY[tld];
    else if (found.phone && /^\+?86/.test(found.phone)) found.country = 'China';
    else if (found.phone && /^\+?1[\s(.-]?\d{3}/.test(found.phone)) found.country = 'United States';
  }
  found.business_name = pickName(found.business_name, pages, host);
  found.certifications = [...certs];
  found.website = rootUrl;
  return found;
}

// Company name: prefer the title segment that matches the domain, never a long SEO title.
function pickName(candidate, pages, host) {
  const root = host.split('.')[0].replace(/[^a-z0-9]/g, '');
  const compact = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const matches = (x) => root.length >= 3 && (compact(x).includes(root) || (compact(x).length >= 4 && root.includes(compact(x))));
  const title = clean((pages[0] && (pages[0].html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]) || '', 200);
  const segments = [candidate, ...title.split(/\s*[|–—:]\s*|\s-\s/)].map((x) => clean(x, 150)).filter(Boolean);
  const hit = segments.find(matches);
  if (hit && hit.length <= 50) return hit;
  if (candidate && candidate.length <= 40) return candidate;
  const short = segments.find((x) => x.length <= 40 && matches(x));
  return short || root.charAt(0).toUpperCase() + root.slice(1);
}

// ------------------------------------------------------------------ product guessing
const G = require('../public/guess');
const guessCategory = G.category;
const guessMaterial = G.material;

function shapeProduct({ name, description, price, prices, images, url, currency, variants }) {
  const text = `${name} ${description || ''}`;
  const all = (prices || []).filter((p) => Number.isFinite(p) && p > 0);
  const min = all.length ? Math.min(...all) : (Number.isFinite(price) && price > 0 ? price : null);
  const max = all.length ? Math.max(...all) : min;
  const desc = clean(description, 500);
  return {
    name: clean(name, 200),
    category: guessCategory(name) || guessCategory(text),
    material: guessMaterial(name) || guessMaterial(text),
    capacity: G.capacity(name),
    dimensions: G.dimensions(name),
    neck_finish: G.neck(name),
    finish: G.finish(name),
    price: min,
    price_type: min == null ? 'QUOTE_ONLY' : max > min ? 'FROM' : 'EXACT',
    currency: currency || '',
    description: [desc, variants && variants.length > 1 ? `Options: ${variants.slice(0, 12).join(', ')}.` : ''].filter(Boolean).join(' ').slice(0, 700),
    images: (images || []).filter((u) => /^https?:\/\//i.test(u)).slice(0, 4),
    url: url || '',
  };
}

// ------------------------------------------------------------------ product sources
async function shopifyProducts(origin) {
  const data = await getJson(`${origin}/products.json?limit=250`).catch(() => null);
  if (!data || !Array.isArray(data.products)) return null;
  return data.products.map((p) => shapeProduct({
    name: p.title,
    description: stripTags(p.body_html),
    prices: (p.variants || []).map((v) => Number(v.price)),
    images: (p.images || []).map((i) => i.src),
    url: `${origin}/products/${p.handle}`,
    variants: (p.variants || []).map((v) => v.title).filter((t) => t && t !== 'Default Title'),
  }));
}
async function wooProducts(origin) {
  const data = await getJson(`${origin}/wp-json/wc/store/v1/products?per_page=100`).catch(() => null);
  if (!Array.isArray(data)) return null;
  return data.map((p) => {
    const minor = Number(p.prices?.currency_minor_unit ?? 2);
    const toNum = (v) => (v == null || v === '' ? NaN : Number(v) / 10 ** minor);
    return shapeProduct({
      name: decode(p.name),
      description: stripTags(p.short_description || p.description),
      prices: [toNum(p.prices?.price_range?.min_amount ?? p.prices?.price), toNum(p.prices?.price_range?.max_amount ?? p.prices?.price)],
      images: (p.images || []).map((i) => i.src),
      url: p.permalink,
      currency: p.prices?.currency_code,
    });
  });
}
function ldProducts(pages) {
  const out = [];
  for (const { html } of pages) {
    for (const o of jsonLd(html)) {
      if (!typeIs(o, 'Product') || !o.name) continue;
      const offers = [].concat(o.offers || []).flatMap((x) => (x && x.offers ? [].concat(x.offers) : [x])).filter(Boolean);
      out.push(shapeProduct({
        name: o.name, description: o.description,
        prices: offers.flatMap((x) => [Number(x.price), Number(x.lowPrice), Number(x.highPrice)]),
        images: [].concat(o.image || []).map((i) => (typeof i === 'string' ? i : i && i.url)).filter(Boolean),
        currency: offers[0] && offers[0].priceCurrency, url: o.url,
      }));
    }
  }
  return out;
}

function detectCurrency(html) {
  const m = html.match(/"currency"\s*:\s*\{\s*"active"\s*:\s*"([A-Z]{3})"/) || html.match(/property=["']og:price:currency["'][^>]*content=["']([A-Z]{3})/i)
    || html.match(/"priceCurrency"\s*:\s*"([A-Z]{3})"/);
  return m ? m[1].toUpperCase() : '';
}

// ------------------------------------------------------------------ main
function normaliseInput(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Enter your website address');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  if (!u.hostname.includes('.')) throw new Error('That doesn’t look like a website address');
  return u;
}

async function importSite(input) {
  const u = normaliseInput(input);
  let home;
  try { home = await getText(u.toString()); }
  catch (e) {
    if (u.protocol === 'https:') { u.protocol = 'http:'; home = await getText(u.toString()).catch(() => { throw e; }); }
    else throw e;
  }
  if (home.status >= 400) throw new Error(`Your site responded with an error (${home.status}).`);
  const finalUrl = new URL(home.url);
  const origin = finalUrl.origin;
  const pages = [{ url: home.url, html: home.text }];

  // Follow contact / about links found on the home page (same site only), else common paths.
  const links = [...home.text.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => ({ href: m[1], label: stripTags(m[2]).toLowerCase() }))
    .filter((l) => /contact|about/.test(l.label) || /contact|about/i.test(l.href))
    .map((l) => { try { return new URL(l.href, origin); } catch { return null; } })
    .filter((x) => x && x.origin === origin).map((x) => x.toString());
  const extra = [...new Set([...links, `${origin}/contact`, `${origin}/contact-us`, `${origin}/about`, `${origin}/about-us`])]
    .filter((x) => x !== home.url).slice(0, 4);
  const extraPages = await Promise.all(extra.map((x) => getText(x, { maxBytes: 2 * 1024 * 1024, timeout: 8000 }).catch(() => null)));
  extraPages.forEach((p) => { if (p && p.status === 200 && /<html|<body/i.test(p.text)) pages.push({ url: p.url, html: p.text }); });

  const company = extractCompany(pages, origin);

  let products = null;
  let source = '';
  const shop = await shopifyProducts(origin);
  if (shop && shop.length) {
    products = shop;
    source = 'Shopify store';
    const meta = await getJson(`${origin}/meta.json`).catch(() => null);
    if (meta && /^[A-Z]{3}$/.test(meta.currency || '')) products.forEach((p) => { p.currency = meta.currency; });
  }
  if (!products) {
    const woo = await wooProducts(origin);
    if (woo && woo.length) { products = woo; source = 'WooCommerce store'; }
  }
  if (!products) {
    const ld = ldProducts(pages);
    if (ld.length) { products = ld; source = 'product data on your site'; }
  }
  const currency = detectCurrency(home.text) || (products && products.find((p) => p.currency) || {}).currency || '';
  const seen = new Set();
  products = (products || []).filter((p) => p.name && !seen.has(p.name.toLowerCase()) && seen.add(p.name.toLowerCase())).slice(0, 150);

  return { site: origin, company, products, productSource: source, currency: config.currencies.includes(currency) ? currency : '' };
}

// Download remote product photos into our upload store (images only, validated by magic bytes).
function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: '.jpg', mime: 'image/jpeg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: '.png', mime: 'image/png' };
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return { ext: '.webp', mime: 'image/webp' };
  if (buf.subarray(0, 4).toString() === 'GIF8') return { ext: '.gif', mime: 'image/gif' };
  return null;
}
async function fetchImage(url) {
  // Shopify CDN: ask for a sensible size instead of the full original.
  let u = url;
  try { const x = new URL(url); if (/cdn\.shopify\.com|\/cdn\/shop\//.test(x.href) && !x.searchParams.has('width')) { x.searchParams.set('width', '1200'); u = x.toString(); } } catch {}
  const r = await safeGet(u, { accept: 'image/webp,image/jpeg,image/png,image/*', maxBytes: config.uploads.maxFileSizeMB * 1024 * 1024, timeout: 15000 });
  if (r.status !== 200) throw new Error('Image not available');
  const kind = sniffImage(r.body);
  if (!kind) throw new Error('Not a supported image');
  const base = (new URL(r.url).pathname.split('/').pop() || 'photo').replace(/\.[a-z0-9]+$/i, '').replace(/[^\w.-]+/g, '-').slice(0, 60) || 'photo';
  return { buffer: r.body, name: `${base}${kind.ext}`, mime: kind.mime };
}

module.exports = { importSite, fetchImage, safeGet, isPrivateIp, guessCategory, guessMaterial };
