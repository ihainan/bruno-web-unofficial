/**
 * Errors the page reports (web/bridge.js), written to the server log. A
 * browser keeps its errors to itself, so without this nothing in the log shows
 * why the page broke on someone's phone.
 *
 * Reports come from a logged-in page but are still untrusted text: each field
 * is trimmed, control characters are dropped, and bearer tokens and key-like
 * query parameters are masked. Past PER_MINUTE reports in a minute the rest
 * are dropped, with one line saying so, so a page caught in an error loop
 * cannot flood the log.
 */
const PER_MINUTE = 30;
const MAX = { kind: 40, message: 500, source: 300, page: 200, stack: 4000, userAgent: 200 };

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const BEARER = /\b(Bearer\s+)[^\s"',;]+/gi;
const SECRET_PARAM = /([?&](?:[\w.-]*(?:key|token|secret|password|auth)[\w.-]*)=)[^&#\s"']+/gi;

const mask = (text) => text.replace(BEARER, '$1***').replace(SECRET_PARAM, '$1***');

// One line of text: whitespace runs (newlines included) become one space.
const field = (value, max) => mask(typeof value === 'string' ? value : '').replace(CONTROL, '').replace(/\s+/g, ' ').trim().slice(0, max);

const stackField = (value) => mask(typeof value === 'string' ? value : '').replace(CONTROL, '').trim().slice(0, MAX.stack);

class ClientErrorLog {
  constructor({ write = (text) => console.error(text), now = Date.now } = {}) {
    this.write = write;
    this.now = now;
    this.windowStart = 0;
    this.count = 0;
  }

  /** Returns false when the report was dropped by the per-minute limit. */
  record(report, { user = '', userAgent = '' } = {}) {
    const t = this.now();
    if (t - this.windowStart >= 60000) {
      this.windowStart = t;
      this.count = 0;
    }
    this.count += 1;
    if (this.count > PER_MINUTE) {
      if (this.count === PER_MINUTE + 1) {
        this.write(`[bruno-web] client errors: more than ${PER_MINUTE} this minute, dropping the rest until ${new Date(this.windowStart + 60000).toISOString()}`);
      }
      return false;
    }

    const r = report && typeof report === 'object' ? report : {};
    const kind = field(r.kind, MAX.kind) || 'error';
    const lines = [
      `[bruno-web] client ${kind}${r.ignored === true ? ' (ignored)' : ''} at ${new Date(t).toISOString()} user=${field(String(user), 80) || '-'}: ${field(r.message, MAX.message) || '(no message)'}`
    ];
    const source = field(r.source, MAX.source);
    if (source) lines.push(`    source: ${source}`);
    const page = field(r.page, MAX.page);
    if (page) lines.push(`    page: ${page}`);
    lines.push(`    browser: ${field(userAgent, MAX.userAgent) || '-'}`);
    const stack = stackField(r.stack);
    if (stack) lines.push(...stack.split('\n').map((l) => `    | ${l}`));
    this.write(lines.join('\n'));
    return true;
  }
}

module.exports = { ClientErrorLog, PER_MINUTE };
