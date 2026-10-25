/**
 * Message encoding shared by the server (require) and the page (<script>).
 *
 * Electron's invoke uses structured clone, so handler results may carry
 * Buffers, Dates, Maps and so on. Plain JSON would silently flatten those, so
 * such values are written as tagged objects `{ "__bw$": <type>, v: ... }` and
 * revived on the other side.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.BrunoWebCodec = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const TAG = '__bw$';

  const hasBuffer = typeof Buffer !== 'undefined';

  const bytesToBase64 = (bytes) => {
    if (hasBuffer) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  };

  const base64ToBytes = (b64) => {
    if (hasBuffer) {
      const buf = Buffer.from(b64, 'base64');
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };

  function replacer(key, value) {
    // `this[key]` is the value before toJSON() ran (Buffer and Date define toJSON).
    const raw = this[key];
    if (raw instanceof Uint8Array) return { [TAG]: 'u8', v: bytesToBase64(raw) };
    if (raw instanceof ArrayBuffer) return { [TAG]: 'ab', v: bytesToBase64(new Uint8Array(raw)) };
    if (ArrayBuffer.isView(raw) && !(raw instanceof DataView)) {
      return { [TAG]: 'u8', v: bytesToBase64(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)) };
    }
    if (raw instanceof Date) return { [TAG]: 'date', v: raw.getTime() };
    if (raw instanceof Map) return { [TAG]: 'map', v: Array.from(raw.entries()) };
    if (raw instanceof Set) return { [TAG]: 'set', v: Array.from(raw.values()) };
    if (raw instanceof Error) {
      return { [TAG]: 'err', v: { name: raw.name, message: raw.message, stack: raw.stack } };
    }
    if (typeof raw === 'bigint') return { [TAG]: 'bigint', v: raw.toString() };
    if (typeof raw === 'number' && !Number.isFinite(raw)) return { [TAG]: 'num', v: String(raw) };
    // Structured clone keeps undefined (array slots and object properties); JSON would drop it.
    if (raw === undefined && key !== '') return { [TAG]: 'undef' };
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, TAG)) {
      // A user value that happens to use our tag key: carry it as entries so the
      // escaped form does not contain the tag key again.
      return { [TAG]: 'obj', v: Object.entries(value) };
    }
    return value;
  }

  const UNDEFINED = {};

  function reviver(key, value) {
    if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, TAG)) return value;
    switch (value[TAG]) {
      case 'u8': return base64ToBytes(value.v);
      case 'ab': {
        const bytes = base64ToBytes(value.v);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }
      case 'date': return new Date(value.v);
      case 'map': return new Map(value.v);
      case 'set': return new Set(value.v);
      case 'err': {
        const err = new Error(value.v.message);
        err.name = value.v.name;
        if (value.v.stack) err.stack = value.v.stack;
        return err;
      }
      case 'bigint': return BigInt(value.v);
      case 'num': return Number(value.v);
      case 'undef': return UNDEFINED;
      case 'obj': return Object.fromEntries(value.v);
      default: return value;
    }
  }

  // JSON.parse drops properties whose reviver returns undefined, so array holes
  // are marked during parsing and turned into real undefined afterwards.
  const restoreUndefined = (node, seen) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return node;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        if (node[i] === UNDEFINED) node[i] = undefined;
        else restoreUndefined(node[i], seen);
      }
    } else if (node instanceof Map) {
      for (const [k, v] of node) {
        if (v === UNDEFINED) node.set(k, undefined);
        else restoreUndefined(v, seen);
      }
    } else if (!(node instanceof Uint8Array) && !(node instanceof Date)) {
      for (const k of Object.keys(node)) {
        if (node[k] === UNDEFINED) node[k] = undefined;
        else restoreUndefined(node[k], seen);
      }
    }
    return node;
  };

  let sawUndefinedMarker = false;
  const encode = (msg) => JSON.stringify(msg, replacer);
  const decode = (text) => {
    sawUndefinedMarker = false;
    const out = JSON.parse(text, function (key, value) {
      const revived = reviver.call(this, key, value);
      if (revived === UNDEFINED) sawUndefinedMarker = true;
      return revived;
    });
    return sawUndefinedMarker ? restoreUndefined(out, new Set()) : out;
  };

  // Electron's renderer turns a rejected invoke into this exact message; the
  // Bruno renderer strips or matches it (utils/common/error.js, QueryResult).
  const formatInvokeError = (channel, errorText) => `Error invoking remote method '${channel}': ${errorText}`;

  return { encode, decode, formatInvokeError, TAG };
});
