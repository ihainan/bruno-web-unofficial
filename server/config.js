/**
 * Runtime configuration, read once from the environment.
 */
const path = require('node:path');

const bool = (v, dflt) => {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

const repoRoot = path.resolve(__dirname, '..');
const dataDir = path.resolve(process.env.BRUNO_WEB_DATA || path.join(repoRoot, 'data'));

const roots = (process.env.BRUNO_WEB_ROOTS || path.join(dataDir, 'workspace'))
  .split(path.delimiter)
  .map((p) => p.trim())
  .filter(Boolean)
  .map((p) => path.resolve(p));

const config = {
  repoRoot,
  upstreamDir: path.resolve(process.env.BRUNO_WEB_UPSTREAM || path.join(repoRoot, 'upstream')),
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 8484),

  dataDir,
  userDataDir: path.resolve(process.env.BRUNO_WEB_USERDATA || path.join(dataDir, 'userData')),
  // Upstream puts new collections under <documents>/bruno by default.
  documentsDir: roots[0],
  downloadsDir: path.join(dataDir, 'tmp', 'downloads'),
  // Files picked in the browser; kept, because their paths end up in collection settings.
  uploadsDir: path.join(dataDir, 'uploads'),
  tmpDir: path.join(dataDir, 'tmp', 'os'),
  trashDir: path.join(dataDir, 'trash'),
  roots,

  // password | proxy | none
  auth: process.env.BRUNO_WEB_AUTH || 'password',
  password: process.env.BRUNO_WEB_PASSWORD || '',
  passwordHash: process.env.BRUNO_WEB_PASSWORD_HASH || '',
  proxyUserHeader: (process.env.BRUNO_WEB_PROXY_USER_HEADER || 'x-forwarded-user').toLowerCase(),
  proxySecretHeader: (process.env.BRUNO_WEB_PROXY_SECRET_HEADER || 'x-bruno-web-proxy-secret').toLowerCase(),
  proxySecret: process.env.BRUNO_WEB_PROXY_SECRET || '',
  trustProxy: bool(process.env.BRUNO_WEB_TRUST_PROXY, false),
  sessionTtlMs: Number(process.env.BRUNO_WEB_SESSION_TTL_HOURS || 12) * 3600 * 1000,

  publicUrl: (process.env.BRUNO_WEB_PUBLIC_URL || '').replace(/\/+$/, ''),
  secretKey: process.env.BRUNO_WEB_SECRET_KEY || '',
  sampleCollection: bool(process.env.BRUNO_WEB_SAMPLE_COLLECTION, true),

  // Test-only: lets the upstream Playwright suite run code in this process
  // (its electronApp.evaluate). Refused unless auth is off and we listen on loopback.
  testHooks: bool(process.env.BRUNO_WEB_TEST_HOOKS, false),
  playwright: process.env.PLAYWRIGHT === 'true',
  // Log every IPC message in the browser console (troubleshooting).
  debugIpc: bool(process.env.BRUNO_WEB_DEBUG_IPC, false),

  allowDeveloperMode: bool(process.env.BRUNO_WEB_ALLOW_DEVELOPER_MODE, false),
  enableTerminal: bool(process.env.BRUNO_WEB_ENABLE_TERMINAL, false),
  blockMetadataHosts: bool(process.env.BRUNO_WEB_BLOCK_METADATA, true),

  maxMessageBytes: Number(process.env.BRUNO_WEB_MAX_MESSAGE_MB || 64) * 1024 * 1024,
  maxUploadBytes: Number(process.env.BRUNO_WEB_MAX_UPLOAD_MB || 200) * 1024 * 1024,
  resumeWindowMs: Number(process.env.BRUNO_WEB_RESUME_SECONDS || 60) * 1000,
  replayMaxEvents: Number(process.env.BRUNO_WEB_REPLAY_MAX_EVENTS || 10000),
  replayMaxBytes: Number(process.env.BRUNO_WEB_REPLAY_MAX_MB || 32) * 1024 * 1024
};

// Scripts can read the whole process environment (bru.getProcessEnv()), so
// none of our own settings — the password and keys in particular — may stay in it.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('BRUNO_WEB_')) delete process.env[key];
}

module.exports = config;
