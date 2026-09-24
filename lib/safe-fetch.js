// SSRF-guarded HTTP GET for fetching user-supplied websites.
//
// Why not plain fetch(): fetch resolves DNS and follows redirects on its own,
// so checking the hostname up front isn't enough — a public hostname can
// resolve to 127.0.0.1 (or flip to it between our check and the connect, i.e.
// DNS rebinding), and a public page can 302 to http://169.254.169.254/.
//
// So this uses node:http/https with a custom `lookup` hook: every connection,
// including each redirect hop, validates the exact IP it is about to connect
// to. Also enforces: http/https only, default ports only, no credentials in
// the URL, a redirect cap, an overall deadline, and a max body size.

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';
import { isBlockedAddress } from './ip-policy.js';

export class BlockedUrlError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'BlockedUrlError';
  }
}

const DEFAULT_PORTS = ['', '80', '443'];
const BLOCKED_HOSTNAMES = /^(localhost|localhost\.localdomain|ip6-localhost|ip6-loopback)$|\.localhost$/i;

// Throws BlockedUrlError if the URL itself (before any DNS) is off-limits.
// Returns the parsed URL.
export function assertPublicUrl(input, { isBlocked = isBlockedAddress, allowedPorts = DEFAULT_PORTS } = {}) {
  let url;
  try {
    url = input instanceof URL ? input : new URL(input);
  } catch (e) {
    throw new BlockedUrlError('invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError('protocol not allowed: ' + url.protocol);
  }
  if (url.username || url.password) {
    throw new BlockedUrlError('credentials in URL not allowed');
  }
  if (!allowedPorts.includes(url.port)) {
    throw new BlockedUrlError('port not allowed: ' + url.port);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) throw new BlockedUrlError('missing hostname');
  if (BLOCKED_HOSTNAMES.test(host)) throw new BlockedUrlError('hostname not allowed: ' + host);
  // IP literals never go through `lookup`, so check them here.
  if (net.isIP(host) && isBlocked(host)) {
    throw new BlockedUrlError('address not allowed: ' + host);
  }
  return url;
}

function makeGuardedLookup(isBlocked) {
  return function guardedLookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const opts = typeof options === 'number' ? { family: options } : { ...options };
    dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return callback(err);
      if (!addresses || !addresses.length) {
        return callback(Object.assign(new Error('no addresses for ' + hostname), { code: 'ENOTFOUND' }));
      }
      // Refuse if *any* address is internal, rather than filtering: a host that
      // mixes public and private records is not one we want to talk to.
      const bad = addresses.find(a => isBlocked(a.address));
      if (bad) return callback(new BlockedUrlError('hostname ' + hostname + ' resolves to blocked address ' + bad.address));
      if (opts.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

/**
 * GET `url`, following up to `maxRedirects` redirects, each re-validated.
 * Resolves to { status, url, body } where body is a utf-8 string truncated
 * to `maxBytes` (after decompression). Rejects with BlockedUrlError when the
 * target (or any redirect target) is not a public address.
 */
export async function safeFetchText(input, {
  timeoutMs = 8000,
  maxBytes = 1_000_000,
  maxRedirects = 5,
  headers = {},
  isBlocked = isBlockedAddress,
  allowedPorts = DEFAULT_PORTS,
} = {}) {
  const lookup = makeGuardedLookup(isBlocked);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timed out after ' + timeoutMs + 'ms')), timeoutMs);
  try {
    let url = assertPublicUrl(input, { isBlocked, allowedPorts });
    for (let hop = 0; ; hop++) {
      const res = await request(url, { lookup, headers, signal: controller.signal });
      const location = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && location) {
        res.resume();
        if (hop >= maxRedirects) throw new Error('too many redirects');
        url = assertPublicUrl(new URL(location, url), { isBlocked, allowedPorts });
        continue;
      }
      const body = await readBody(res, maxBytes);
      return { status: res.statusCode, url: url.href, body };
    }
  } finally {
    clearTimeout(timer);
  }
}

function request(url, { lookup, headers, signal }) {
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, {
      method: 'GET',
      lookup,
      signal,
      // No keep-alive agent: each hop gets a fresh, freshly-validated socket.
      agent: false,
      headers: { 'Accept-Encoding': 'gzip, deflate, br', ...headers },
    }, resolve);
    req.on('error', err => reject(signal.aborted && signal.reason ? signal.reason : err));
    req.end();
  });
}

function readBody(res, maxBytes) {
  const encoding = String(res.headers['content-encoding'] || '').toLowerCase().trim();
  let stream = res;
  if (encoding === 'gzip' || encoding === 'x-gzip') stream = res.pipe(zlib.createGunzip());
  else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
  else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());

  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    stream.on('data', chunk => {
      if (done) return;
      const room = maxBytes - total;
      chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
      total += Math.min(chunk.length, room);
      // Enough to summarise the page — stop reading (also caps zip bombs).
      if (total >= maxBytes) {
        finish();
        res.destroy();
      }
    });
    stream.on('end', finish);
    stream.on('error', err => { if (!done) { done = true; reject(err); } });
    res.on('error', err => { if (!done) { done = true; reject(err); } });
  });
}
