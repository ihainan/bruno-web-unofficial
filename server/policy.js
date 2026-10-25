/**
 * Server-side rules that the page cannot override.
 *
 * Developer mode: upstream picks the script runtime from the collection object
 * the renderer sends (`securityConfig.jsSandboxMode`), so the decision has to
 * be enforced here. In developer mode upstream runs scripts in Node's `vm`
 * (runScriptInNodeVm) and evaluates variable/assertion expressions with
 * `new Function` in the main process — both have full access to the server.
 * When developer mode is disallowed we
 *   1. force every runtime class to QuickJS at construction, and
 *   2. replace the Node-side evaluators with functions that throw, as a
 *      backstop for any path that bypasses the runtime classes.
 * Must run before any upstream module requires @usebruno/js.
 */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const dns = require('node:dns');
const config = require('./config');

const DEVELOPER_MODE_DISABLED = 'Developer mode is disabled on this Bruno Web server; scripts run in Safe Mode. '
  + 'Ask the administrator to set BRUNO_WEB_ALLOW_DEVELOPER_MODE=true if this collection needs it.';

const isInside = (root, p) => {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

const RUNTIME_CLASSES = ['ScriptRuntime', 'GrpcScriptRuntime', 'TestRuntime', 'VarsRuntime', 'AssertRuntime'];

let notifyDowngrade = () => {};

const enforceSafeMode = () => {
  const electronDir = path.join(config.upstreamDir, 'packages', 'bruno-electron');
  const jsEntry = require.resolve('@usebruno/js', { paths: [electronDir] });
  const jsSrc = path.dirname(jsEntry);

  const refuse = () => {
    throw new Error(DEVELOPER_MODE_DISABLED);
  };

  // Backstops first: these modules are destructured by the runtimes at load time.
  const nodeVm = require(path.join(jsSrc, 'sandbox', 'node-vm'));
  nodeVm.runScriptInNodeVm = async () => refuse();
  const utils = require(path.join(jsSrc, 'utils'));
  utils.evaluateJsExpression = refuse;
  utils.evaluateJsTemplateLiteral = refuse;

  const js = require(jsEntry);
  for (const name of RUNTIME_CLASSES) {
    const Original = js[name];
    if (typeof Original !== 'function') {
      throw new Error(`@usebruno/js no longer exports ${name}; review server/policy.js`);
    }
    js[name] = class extends Original {
      constructor(props = {}) {
        const wanted = props && props.runtime;
        super({ ...props, runtime: 'quickjs' });
        if (wanted && wanted !== 'quickjs') notifyDowngrade();
      }
    };
    Object.defineProperty(js[name], 'name', { value: name });
  }
  js.runScriptInNodeVm = nodeVm.runScriptInNodeVm;
};

// Channels that are switched off by configuration.
const TERMINAL_CHANNELS = /^terminal:/;
const CODE_EXECUTION_CHANNELS = new Set(['renderer:install-postman-packages']);

class Policy {
  constructor() {
    this.hub = null;
    this.publicOrigin = null;
    this.downgradeNoticeAt = 0;
  }

  install() {
    if (!config.allowDeveloperMode) {
      enforceSafeMode();
      notifyDowngrade = () => this.onDowngrade();
    }
    if (config.blockMetadataHosts) blockMetadataAddresses();
  }

  setHub(hub) {
    this.hub = hub;
  }

  onDowngrade() {
    // One notice per minute is enough; a collection runner would otherwise spam.
    const now = Date.now();
    if (now - this.downgradeNoticeAt < 60000 || !this.hub) return;
    this.downgradeNoticeAt = now;
    this.hub.notify('toast', { level: 'warning', message: DEVELOPER_MODE_DISABLED });
  }

  checkChannel(channel) {
    if (!config.enableTerminal && TERMINAL_CHANNELS.test(channel)) {
      return 'The terminal is disabled on this Bruno Web server (BRUNO_WEB_ENABLE_TERMINAL).';
    }
    // `npm install` runs the packages' lifecycle scripts on the server: the same
    // trust level as developer mode.
    if (!config.allowDeveloperMode && CODE_EXECUTION_CHANNELS.has(channel)) {
      return 'Installing npm packages runs code on the server and is disabled on this Bruno Web server '
        + '(enable developer mode with BRUNO_WEB_ALLOW_DEVELOPER_MODE=true).';
    }
    return null;
  }

  onTheme(dark) {
    const { nativeTheme } = require('electron').__bruno_web__;
    nativeTheme.setPageDark(dark);
  }

  roots() {
    return config.roots;
  }

  setPublicOrigin(origin) {
    this.publicOrigin = origin;
  }

  oauthCallbackUrl() {
    return this.publicOrigin ? `${this.publicOrigin}/bruno-web/oauth2/callback` : null;
  }

  isInsideRoots(realPath, { allowUploads = false } = {}) {
    const bases = [...config.roots];
    if (allowUploads) bases.push(config.uploadsDir);
    return bases.some((root) => isInside(root, realPath));
  }

  /**
   * Resolve a path chosen in the file dialog and make sure it stays inside the
   * configured roots after following symlinks. For a path that does not exist
   * yet (save dialog, new folder) the nearest existing parent is checked.
   */
  async resolveInsideRoots(p, { forWrite = false, allowUploads = false } = {}) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) {
      throw new Error(`Invalid path from file dialog: ${p}`);
    }
    const normalized = path.resolve(p);
    let existing = normalized;
    const missingParts = [];
    for (;;) {
      try {
        existing = await fs.promises.realpath(existing);
        break;
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        if (!forWrite && missingParts.length === 0 && existing === normalized) {
          // Open dialogs may only return existing paths…
          throw new Error(`Path does not exist: ${p}`);
        }
        missingParts.unshift(path.basename(existing));
        const parent = path.dirname(existing);
        if (parent === existing) throw new Error(`Invalid path: ${p}`);
        existing = parent;
      }
    }
    const real = path.join(existing, ...missingParts);
    if (!this.isInsideRoots(real, { allowUploads })) {
      throw new Error(`Path is outside the folders this server allows: ${p}`);
    }
    return real;
  }
}

/**
 * Refuse outbound connections to link-local / cloud metadata addresses
 * (169.254.0.0/16, fd00:ec2::254). Requests leave from the server, so without
 * this a collection could read the host's cloud credentials.
 */
const blockMetadataAddresses = () => {
  const isBlocked = (address) => {
    if (!address) return false;
    if (net.isIPv4(address)) return address.startsWith('169.254.');
    const lower = address.toLowerCase();
    return lower.startsWith('fe80:') || lower === 'fd00:ec2::254' || lower.startsWith('::ffff:169.254.');
  };
  const blockedError = (host) => {
    const err = new Error(`Bruno Web blocks requests to link-local/metadata address ${host}`);
    err.code = 'EBRUNOWEBBLOCKED';
    return err;
  };

  const originalLookup = dns.lookup;
  dns.lookup = function (hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    return originalLookup.call(dns, hostname, options, (err, address, family) => {
      if (err) return callback(err);
      const list = Array.isArray(address) ? address : [{ address }];
      if (list.some((a) => isBlocked(a.address))) return callback(blockedError(hostname));
      callback(null, address, family);
    });
  };

  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    // net.connect() passes its normalized arguments as one array: [options, callback].
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const opts = typeof first === 'object' && first !== null ? first : { port: first, host: args[1] };
    if (opts && opts.host && net.isIP(opts.host) && isBlocked(opts.host)) {
      process.nextTick(() => this.destroy(blockedError(opts.host)));
      return this;
    }
    return originalConnect.apply(this, args);
  };
};

module.exports = { Policy, DEVELOPER_MODE_DISABLED, isInside };
