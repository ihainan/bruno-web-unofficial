/**
 * Exports that write into a folder the user picked (instead of asking for a
 * save path) never pass through the save dialog, so the browser would not get
 * the file. For these channels the server also offers what was written as a
 * download; the copy on the server stays where the user put it.
 *
 *   before(args)                 -> state captured before the handler runs
 *   after(args, result, before)  -> absolute paths to offer as downloads
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

const listEntries = async (dir) => {
  try {
    return new Set(await fs.promises.readdir(dir));
  } catch (e) {
    return new Set();
  }
};

// A folder export becomes one ZIP download.
const zipDirectory = async (dir) => {
  const archiver = require(require.resolve('archiver', { paths: [path.join(config.upstreamDir, 'packages', 'bruno-electron')] }));
  const outDir = path.join(config.downloadsDir, crypto.randomUUID());
  await fs.promises.mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `${path.basename(dir)}.zip`);
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outFile);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(dir, path.basename(dir));
    archive.finalize();
  });
  return { path: outFile, temporary: true };
};

const newEntriesIn = async (dir, before) => {
  const out = [];
  for (const name of await listEntries(dir)) {
    if (before.has(name)) continue;
    const full = path.join(dir, name);
    const stat = await fs.promises.stat(full).catch(() => null);
    if (!stat) continue;
    if (stat.isDirectory()) out.push(await zipDirectory(full));
    else if (stat.isFile()) out.push({ path: full, temporary: false });
  }
  return out;
};

const exportHooks = {
  // (dirPath, fileName, content, overwrite) -> { success, filePath }
  'renderer:export-collection-postman': {
    before: async () => null,
    after: async (args, result) => (result && result.filePath ? [{ path: result.filePath, temporary: false }] : [])
  },

  // ({ environments, environmentType, filePath: <directory>, exportFormat })
  'renderer:export-environment': {
    before: async ([options]) => listEntries(options && options.filePath),
    after: async ([options], result, before) => (options && options.filePath ? newEntriesIn(options.filePath, before) : [])
  }
};

module.exports = { exportHooks };
