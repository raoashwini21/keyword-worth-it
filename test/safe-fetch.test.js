import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import dns from 'node:dns';
import { safeFetchText, assertPublicUrl, BlockedUrlError } from '../lib/safe-fetch.js';

// A local HTTP server stands in for "some website". A fake DNS name maps to it
// so the real lookup hook, redirect loop and body reader are all exercised.
const FAKE_HOST = 'kwi-test.example';
let server, port, realLookup;

before(async () => {
  server = http.createServer((req, res) => {
    const send = (code, headers, body) => { res.writeHead(code, headers); res.end(body); };
    switch (req.url) {
      case '/redirect-metadata': return send(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      case '/redirect-relative': return send(302, { Location: '/page' });
      case '/loop': return send(302, { Location: '/loop' });
      case '/big': return send(200, {}, 'x'.repeat(50_000));
      case '/gzip': return send(200, { 'Content-Encoding': 'gzip' }, zlib.gzipSync('<title>Zipped</title>'));
      default: return send(200, {}, '<title>Hello</title>');
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = String(server.address().port);

  realLookup = dns.lookup;
  dns.lookup = (host, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    if (host === FAKE_HOST) {
      return options && options.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4);
    }
    return realLookup.call(dns, host, options, cb);
  };
});
after(() => { dns.lookup = realLookup; server.close(); });

const url = path => 'http://' + FAKE_HOST + ':' + port + path;
const allowAll = () => false;
// Pretend 127.0.0.1 is public (it's our "website"), but keep metadata blocked.
const blockMetadataOnly = ip => ip.startsWith('169.254.');
const local = (isBlocked, extra = {}) => ({ isBlocked, allowedPorts: [port], timeoutMs: 3000, ...extra });

test('assertPublicUrl rejects bad schemes, ports, credentials and internal hosts', () => {
  for (const u of [
    'file:///etc/passwd', 'ftp://example.com/', 'gopher://example.com/',
    'http://example.com:6379/', 'https://user:pw@example.com/',
    'http://localhost/', 'http://foo.localhost/', 'http://127.0.0.1/', 'http://[::1]/',
    'http://169.254.169.254/', 'http://10.1.2.3/', 'http://172.20.0.1/', 'http://192.168.0.1/',
    // alternate IPv4 spellings — WHATWG URL normalises these to 127.0.0.1
    'http://2130706433/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/', 'http://127.1/',
    'http://[::ffff:127.0.0.1]/', 'http://[::ffff:a9fe:a9fe]/',
    'not a url',
  ]) assert.throws(() => assertPublicUrl(u), BlockedUrlError, u);

  assert.equal(assertPublicUrl('https://example.com/about').hostname, 'example.com');
  assert.equal(assertPublicUrl('https://example.com:443/').hostname, 'example.com');
  assert.equal(assertPublicUrl('http://8.8.8.8/').hostname, '8.8.8.8');
});

test('refuses a public-looking hostname that resolves to loopback (DNS / rebinding)', async () => {
  // Default policy: the lookup hook sees 127.0.0.1 at connect time and refuses.
  await assert.rejects(safeFetchText(url('/'), { allowedPorts: [port], timeoutMs: 3000 }), BlockedUrlError);
});

test('re-checks every redirect hop: page -> 169.254.169.254 is refused', async () => {
  await assert.rejects(safeFetchText(url('/redirect-metadata'), local(blockMetadataOnly)), BlockedUrlError);
});

test('follows ordinary redirects and returns the body', async () => {
  const { status, body, url: finalUrl } = await safeFetchText(url('/redirect-relative'), local(allowAll));
  assert.equal(status, 200);
  assert.match(body, /Hello/);
  assert.match(finalUrl, /\/page$/);
});

test('caps redirect chains', async () => {
  await assert.rejects(safeFetchText(url('/loop'), local(allowAll)), /too many redirects/);
});

test('truncates large bodies at maxBytes', async () => {
  const { body } = await safeFetchText(url('/big'), local(allowAll, { maxBytes: 1000 }));
  assert.equal(body.length, 1000);
});

test('decompresses gzip', async () => {
  const { body } = await safeFetchText(url('/gzip'), local(allowAll));
  assert.match(body, /Zipped/);
});
