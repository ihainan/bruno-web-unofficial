/**
 * HTTP endpoints behind the page's file dialogs:
 *   GET  /bruno-web/api/fs/list?path=        list a directory inside the roots
 *   POST /bruno-web/api/fs/mkdir?path=       create a directory inside the roots
 *   PUT  /bruno-web/api/fs/upload?dir=&name= store a local file into a root directory
 *   PUT  /bruno-web/api/upload/:id/:name     backing store for ipcRenderer.getFilePath()
 *   GET  /bruno-web/api/download/:token      one-shot download of a file the server wrote
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const express = require('express');
const config = require('./config');
const { isInside } = require('./policy');

const DOWNLOAD_TTL_MS = 10 * 60 * 1000;

class Downloads {
  constructor() {
    this.tokens = new Map(); // token -> { filePath, expiresAt }
  }

  // keep: the file lives in the user's folders (an export) rather than in our
  // temporary download area, so it must not be deleted after the download.
  register(filePath, { keep = false } = {}) {
    const token = crypto.randomBytes(24).toString('base64url');
    this.tokens.set(token, { filePath, keep, expiresAt: Date.now() + DOWNLOAD_TTL_MS });
    return token;
  }

  take(token) {
    const entry = this.tokens.get(token);
    if (!entry) return null;
    this.tokens.delete(token);
    if (entry.expiresAt < Date.now()) {
      if (!entry.keep) removeDownloadDir(entry.filePath);
      return null;
    }
    return entry;
  }

  sweep() {
    const now = Date.now();
    for (const [token, entry] of this.tokens) {
      if (entry.expiresAt < now) {
        this.tokens.delete(token);
        if (!entry.keep) removeDownloadDir(entry.filePath);
      }
    }
  }
}

const removeDownloadDir = (filePath) => {
  const dir = path.dirname(filePath);
  if (path.dirname(dir) !== config.downloadsDir) return;
  fs.rm(dir, { recursive: true, force: true }, () => {});
};

const safeName = (name) => {
  const base = path.basename(String(name || ''));
  if (!base || base === '.' || base === '..' || /[\0]/.test(base)) {
    throw httpError(400, 'Invalid file name');
  }
  return base;
};

const httpError = (status, message) => Object.assign(new Error(message), { status });

const writeBody = async (req, dest) => {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > config.maxUploadBytes) throw httpError(413, 'File is too large');
  let received = 0;
  const tmp = `${dest}.part-${crypto.randomBytes(4).toString('hex')}`;
  try {
    await pipeline(
      req,
      async function* limit(source) {
        for await (const chunk of source) {
          received += chunk.length;
          if (received > config.maxUploadBytes) throw httpError(413, 'File is too large');
          yield chunk;
        }
      },
      fs.createWriteStream(tmp, { flags: 'wx' })
    );
    await fs.promises.rename(tmp, dest);
  } catch (e) {
    fs.rm(tmp, { force: true }, () => {});
    throw e;
  }
  return received;
};

const createFsRouter = ({ policy, downloads }) => {
  const router = express.Router();

  const wrap = (fn) => (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      const status = err.status || (/outside|Invalid|does not exist/.test(err.message) ? 400 : 500);
      if (status === 500) console.error('[bruno-web] fs api error', err);
      if (!res.headersSent) res.status(status).json({ error: err.message });
    });
  };

  router.get('/fs/list', wrap(async (req, res) => {
    const requested = req.query.path || config.roots[0];
    const dir = await policy.resolveInsideRoots(String(requested));
    const stat = await fs.promises.stat(dir);
    if (!stat.isDirectory()) throw httpError(400, 'Not a directory');
    const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    const entries = [];
    for (const d of dirents) {
      const full = path.join(dir, d.name);
      let type = d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other';
      let size = 0;
      let mtime = 0;
      try {
        const s = await fs.promises.stat(full);
        type = s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other';
        size = s.size;
        mtime = s.mtimeMs;
      } catch (e) {
        // Broken symlink or permission problem: still list it, it just cannot be opened.
      }
      entries.push({ name: d.name, type, size, mtime });
    }
    entries.sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
    const root = config.roots.find((r) => isInside(r, dir));
    res.json({
      path: dir,
      parent: dir === root ? null : path.dirname(dir),
      root,
      roots: config.roots,
      sep: path.sep,
      entries
    });
  }));

  router.post('/fs/mkdir', wrap(async (req, res) => {
    const dir = await policy.resolveInsideRoots(String(req.query.path || ''), { forWrite: true });
    await fs.promises.mkdir(dir, { recursive: true });
    res.json({ path: dir });
  }));

  router.put('/fs/upload', wrap(async (req, res) => {
    const dir = await policy.resolveInsideRoots(String(req.query.dir || ''));
    const dest = path.join(dir, safeName(req.query.name));
    await policy.resolveInsideRoots(dest, { forWrite: true });
    if (fs.existsSync(dest) && req.query.overwrite !== '1') throw httpError(409, 'A file with that name already exists');
    if (fs.existsSync(dest)) await fs.promises.rm(dest);
    const size = await writeBody(req, dest);
    res.json({ path: dest, size });
  }));

  router.put('/upload/:id/:name', wrap(async (req, res) => {
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw httpError(400, 'Invalid upload id');
    const dir = path.join(config.uploadsDir, req.params.id);
    await fs.promises.mkdir(dir, { recursive: true });
    const dest = path.join(dir, safeName(req.params.name));
    const size = await writeBody(req, dest);
    res.json({ path: dest, size });
  }));

  router.get('/download/:token', wrap(async (req, res) => {
    const entry = downloads.take(req.params.token);
    if (!entry) throw httpError(404, 'This download link has expired');
    res.download(entry.filePath, path.basename(entry.filePath), (err) => {
      if (err && !res.headersSent) res.status(500).end();
      if (!entry.keep) removeDownloadDir(entry.filePath);
    });
  }));

  return router;
};

module.exports = { createFsRouter, Downloads };
