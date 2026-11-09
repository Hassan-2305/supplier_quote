// Live check of the production setup: Supabase Postgres + Storage.
// Usage: put DATABASE_URL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env, then
//   npm run check:supabase
// Creates the tables and bucket if missing, round-trips a small test file through a
// signed upload URL (the same way browsers upload), and removes it again.
const crypto = require('crypto');

(async () => {
  if (!process.env.DATABASE_URL && process.env.POSTGRES_URL) process.env.DATABASE_URL = process.env.POSTGRES_URL;
  const missing = ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter((k) => !process.env[k]);
  if (missing.length) { console.error('Missing in .env:', missing.join(', ')); process.exit(1); }
  const { db } = require('../db');
  const storage = require('../lib/storage');
  const ok = (m) => console.log('  ok  ', m);

  await db.ready();
  const t = await db.all("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('submissions','products','price_tiers','files','invites') ORDER BY table_name");
  ok(`database connected, tables: ${t.map((r) => r.table_name).join(', ')}`);
  const n = await db.get('SELECT COUNT(*) AS n FROM submissions');
  ok(`submissions in database: ${n.n}`);

  const key = `healthcheck-${crypto.randomUUID()}.txt`;
  const body = `supplier portal storage check ${new Date().toISOString()}`;
  const uploadUrl = await storage.signUpload(key);
  ok('bucket ready, signed upload URL created');
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'text/plain', 'x-upsert': 'true' }, body });
  if (!put.ok) throw new Error(`signed upload failed: ${put.status} ${await put.text()}`);
  ok('file uploaded through signed URL (browser path)');
  const st = await storage.stat(key);
  if (!st) throw new Error('uploaded file not found');
  ok(`file found in bucket (${st.size} bytes)`);
  const url = await storage.signDownload(key);
  const got = await (await fetch(url)).text();
  if (got !== body) throw new Error('downloaded content does not match');
  ok('signed download returns the same content');
  await storage.remove([key]);
  ok('test file removed');
  console.log('\nSupabase is set up correctly.');
  process.exit(0);
})().catch((e) => { console.error('\nCHECK FAILED:', e.message); process.exit(1); });
