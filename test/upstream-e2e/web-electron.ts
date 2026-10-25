/**
 * Runs upstream Bruno's Playwright suite against Bruno Web.
 *
 * Upstream's fixtures (playwright/index.ts) start the app with
 * `playwright._electron.launch({ args, env })`. This module provides a
 * `_electron` with the same launch() that starts a Bruno Web server process
 * instead and returns an object with the parts of ElectronApplication the
 * suite uses:
 *   evaluate(fn, arg)  -> runs fn(electron, arg) in the server (test hook route)
 *   firstWindow()      -> a browser page on the server, like the main window
 *   context(), windows(), waitForEvent('window'), process(), close()
 */
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { Browser, BrowserContext, Page } from '@playwright/test';

const REPO = process.env.BRUNO_WEB_REPO as string;
if (!REPO) throw new Error('BRUNO_WEB_REPO must point at the Bruno Web checkout');
const SHIM = path.join(REPO, 'server', 'install-shim.js');
const SERVER = path.join(REPO, 'server', 'index.js');

const freePort = () => new Promise<number>((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address() as net.AddressInfo;
    srv.close(() => resolve(port));
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class WebElectronApp extends EventEmitter {
  private proc!: ChildProcess;
  private ctx: BrowserContext | null = null;
  private page: Page | null = null;
  private pagePromise: Promise<Page> | null = null;
  private base = '';
  private dataDir = '';
  private stderr = '';

  constructor(
    private browser: Browser,
    private env: Record<string, string | undefined>,
    private onRevive: (app: WebElectronApp) => void
  ) {
    super();
  }

  async start() {
    const port = await freePort();
    this.base = `http://127.0.0.1:${port}`;
    this.dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bruno-web-e2e-'));
    const userData = this.env.ELECTRON_USER_DATA_PATH || path.join(this.dataDir, 'userData');
    this.proc = spawn(process.execPath, ['--require', SHIM, SERVER], {
      env: {
        ...process.env,
        ...this.env,
        // The runner's electron stub must not reach the server, which uses the real shim.
        NODE_OPTIONS: '',
        HOST: '127.0.0.1',
        PORT: String(port),
        BRUNO_WEB_DATA: this.dataDir,
        BRUNO_WEB_USERDATA: userData,
        // Specs keep collections in os.tmpdir() and stub the dialogs.
        BRUNO_WEB_ROOTS: '/',
        BRUNO_WEB_AUTH: 'none',
        BRUNO_WEB_TEST_HOOKS: 'true',
        // Same capabilities as the desktop app, which is what the suite tests.
        BRUNO_WEB_ALLOW_DEVELOPER_MODE: 'true',
        BRUNO_WEB_ENABLE_TERMINAL: 'true',
        BRUNO_WEB_BLOCK_METADATA: 'false',
        BRUNO_WEB_DEBUG_IPC: process.env.E2E_PAGE_LOG ? 'true' : 'false'
      } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.proc.stderr!.on('data', (d) => { this.stderr = (this.stderr + d.toString()).slice(-4000); });
    const deadline = Date.now() + 60000;
    for (;;) {
      if (this.proc.exitCode !== null) throw new Error(`Bruno Web server exited (${this.proc.exitCode}): ${this.stderr}`);
      try {
        const res = await fetch(`${this.base}/bruno-web/healthz`);
        if (res.ok) break;
      } catch (e) { /* not listening yet */ }
      if (Date.now() > deadline) throw new Error(`Bruno Web server did not start: ${this.stderr}`);
      await sleep(100);
    }
    await this.openContext();
  }

  process() {
    return this.proc;
  }

  lastUsed = Date.now();
  retired = false;

  // A retired app (see createWebElectron) that is used again is started
  // anew on the same user data — what restarting the desktop app does.
  private async revive() {
    this.lastUsed = Date.now();
    if (!this.retired) return;
    this.retired = false;
    this.onRevive(this);
    await this.start();
  }

  async evaluate(fn: Function | string, arg?: unknown) {
    await this.revive();
    const res = await fetch(`${this.base}/bruno-web/test/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fn: fn.toString(), arg: arg === undefined ? null : arg })
    });
    const body = await res.json();
    if (!body.ok) {
      const err = new Error(body.error ? body.error.message : `evaluate failed (${res.status})`);
      if (body.error && body.error.stack) err.stack = body.error.stack;
      throw err;
    }
    return body.result;
  }

  // Electron's ElectronApplication.context() is synchronous; specs call
  // `app.context().close()`. The context is created when the app starts.
  context() {
    return this.ctx as BrowserContext;
  }

  // Browser storage (localStorage etc.) lives with the user's browser, not the
  // server. Electron keeps it in userData, so a restarted app finds it again:
  // keep a copy next to the user data to give restarts the same behaviour.
  private storageFile() {
    return this.env.ELECTRON_USER_DATA_PATH ? path.join(this.env.ELECTRON_USER_DATA_PATH, '.bruno-web-browser-storage.json') : null;
  }

  private async openContext() {
    const storage = this.storageFile();
    let storageState: any;
    if (storage && fs.existsSync(storage)) {
      // Storage is keyed by origin, and each launch gets a new port; a real
      // deployment keeps its address. Move the previous run's origin over.
      storageState = JSON.parse(fs.readFileSync(storage, 'utf8'));
      for (const o of storageState.origins || []) {
        if (/^http:\/\/127\.0\.0\.1:\d+$/.test(o.origin)) o.origin = this.base;
      }
    }
    this.ctx = await this.browser.newContext({
      viewport: { width: 1280, height: 768 },
      acceptDownloads: true,
      storageState
    });
    // The desktop app may use the clipboard. Granted to Bruno's own origin
    // only; app guests (opaque origins) stay denied.
    await this.ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: this.base });
  }

  firstWindow() {
    this.lastUsed = Date.now();
    if (!this.pagePromise) {
      this.pagePromise = (async () => {
        await this.revive();
        const page = await this.ctx!.newPage();
        // Electron reloads without a "leave site?" prompt.
        page.on('dialog', (d) => { if (d.type() === 'beforeunload') d.accept().catch(() => {}); });
        // The server asks the page to resize its window (BrowserWindow.setContentSize).
        await page.exposeBinding('__brunoWebResize', async (_src, size) => {
          await page.setViewportSize({ width: size.width, height: size.height });
        });
        await page.addInitScript(() => {
          window.addEventListener('bruno-web:window-size', (e: any) => (window as any).__brunoWebResize(e.detail));
        });
        // E2E_PAGE_LOG=<file>: append the page's console output and errors, for debugging.
        if (process.env.E2E_PAGE_LOG) {
          const out = (line: string) => fs.appendFileSync(process.env.E2E_PAGE_LOG as string, `${new Date().toISOString()} ${this.base} ${line}\n`);
          page.on('console', (m) => out(`[${m.type()}] ${m.text().slice(0, 500)}`));
          page.on('pageerror', (e) => out(`[pageerror] ${e.message}`));
        }
        await page.goto(`${this.base}/`);
        this.page = page;
        this.emit('window', page);
        return page;
      })();
    }
    return this.pagePromise;
  }

  windows() {
    return this.page ? [this.page] : [];
  }

  async waitForEvent(event: string) {
    if (event === 'window') return this.firstWindow();
    if (event === 'close') return new Promise((resolve) => this.proc.once('exit', resolve));
    throw new Error(`WebElectronApp.waitForEvent('${event}') is not supported`);
  }

  async close() {
    const storage = this.storageFile();
    try {
      if (this.ctx && storage) await this.ctx.storageState({ path: storage });
    } catch (e) { /* context already closed by the spec */ }
    try { await this.ctx?.close(); } catch (e) { /* already closed */ }
    this.ctx = null;
    this.page = null;
    this.pagePromise = null;
    if (this.proc && this.proc.exitCode === null) {
      const exited = new Promise((resolve) => this.proc.once('exit', resolve));
      this.proc.kill('SIGTERM');
      const done = await Promise.race([exited.then(() => true), sleep(10000).then(() => false)]);
      if (!done) this.proc.kill('SIGKILL');
    }
    await fs.promises.rm(this.dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Upstream's fixtures close launched apps only when the worker ends (`newPage`
// launches one per test). An Electron app that nobody uses costs little, but
// each of ours is a ~260 MB server process, and a long worker would pile up
// dozens of them. Keep the worker's first app (the shared `electronApp`) and
// the most recently used few; older ones belong to finished tests.
const MAX_IDLE_APPS = Number(process.env.E2E_MAX_APPS_PER_WORKER || 3);

export const createWebElectron = (playwright: any) => {
  let browser: Browser | null = null;
  const apps = new Set<WebElectronApp>();
  let first: WebElectronApp | null = null;

  const trim = async () => {
    const others = [...apps].filter((a) => a !== first).sort((a, b) => b.lastUsed - a.lastUsed);
    for (const stale of others.slice(MAX_IDLE_APPS)) {
      apps.delete(stale);
      await stale.close();
      stale.retired = true;
    }
  };

  return {
    async launch({ env = {} }: { args?: string[]; env?: Record<string, string | undefined> } = {}) {
      if (!browser) browser = await playwright.chromium.launch();
      await trim();
      const app = new WebElectronApp(browser!, env, (revived) => {
        apps.add(revived);
        trim().catch(() => {});
      });
      await app.start();
      apps.add(app);
      if (!first) first = app;
      return app;
    },
    async dispose() {
      await Promise.allSettled([...apps].map((a) => a.close()));
      await browser?.close();
    }
  };
};
