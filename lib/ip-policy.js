// Decides whether an IP address is somewhere the server must never connect
// to on a user's behalf: loopback, private networks, link-local (incl. the
// 169.254.169.254 cloud metadata endpoint), CGNAT, multicast, reserved and
// documentation ranges — for both IPv4 and IPv6, including IPv6 forms that
// embed an IPv4 address (::ffff:127.0.0.1, 64:ff9b::a00:1, 2002:7f00:1::).
//
// Anything we can't parse is treated as blocked.

import net from 'node:net';

// [network, prefixLength]
const BLOCKED_V4 = [
  ['0.0.0.0', 8],          // "this network"
  ['10.0.0.0', 8],         // private
  ['100.64.0.0', 10],      // carrier-grade NAT
  ['127.0.0.0', 8],        // loopback
  ['169.254.0.0', 16],     // link-local, cloud metadata (169.254.169.254)
  ['172.16.0.0', 12],      // private
  ['192.0.0.0', 24],       // IETF protocol assignments
  ['192.0.2.0', 24],       // documentation (TEST-NET-1)
  ['192.88.99.0', 24],     // 6to4 relay anycast
  ['192.168.0.0', 16],     // private
  ['198.18.0.0', 15],      // benchmarking
  ['198.51.100.0', 24],    // documentation (TEST-NET-2)
  ['203.0.113.0', 24],     // documentation (TEST-NET-3)
  ['224.0.0.0', 4],        // multicast
  ['240.0.0.0', 4],        // reserved + 255.255.255.255 broadcast
].map(([addr, bits]) => [ipv4ToInt(addr), bits]);

// [first hextets as a BigInt-free prefix check] — expressed as
// [8 hextets of the network, prefixLength]
const BLOCKED_V6 = [
  ['::', 128],             // unspecified
  ['::1', 128],            // loopback
  ['100::', 64],           // discard-only
  ['2001:db8::', 32],      // documentation
  ['fc00::', 7],           // unique local (incl. fd00:ec2::254 AWS metadata)
  ['fe80::', 10],          // link-local
  ['fec0::', 10],          // deprecated site-local
  ['ff00::', 8],           // multicast
].map(([addr, bits]) => [expandIPv6(addr), bits]);

export function isBlockedAddress(address) {
  if (typeof address !== 'string') return true;
  let ip = address.trim();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  // Strip an IPv6 zone id (fe80::1%eth0) — the address itself decides.
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);

  const family = net.isIP(ip);
  if (family === 4) return isBlockedV4(ipv4ToInt(ip));
  if (family === 6) return isBlockedV6(ip);
  return true;
}

function isBlockedV4(n) {
  if (n === null) return true;
  return BLOCKED_V4.some(([network, bits]) => inV4Subnet(n, network, bits));
}

function isBlockedV6(ip) {
  const h = expandIPv6(ip);
  if (!h) return true;

  // IPv6 forms that carry an IPv4 address: judge them by that IPv4 address.
  const allZero = (from, to) => h.slice(from, to).every(x => x === 0);
  // ::ffff:a.b.c.d (IPv4-mapped)
  if (allZero(0, 5) && h[5] === 0xffff) return isBlockedV4(hextetsToV4(h[6], h[7]));
  // ::a.b.c.d (deprecated IPv4-compatible; :: and ::1 are caught below)
  if (allZero(0, 6) && !(h[6] === 0 && h[7] <= 1)) return isBlockedV4(hextetsToV4(h[6], h[7]));
  // 64:ff9b::a.b.c.d (NAT64 well-known prefix)
  if (h[0] === 0x64 && h[1] === 0xff9b && allZero(2, 6)) return isBlockedV4(hextetsToV4(h[6], h[7]));
  // 2002:AABB:CCDD::/48 (6to4 — embeds AA.BB.CC.DD)
  if (h[0] === 0x2002) return isBlockedV4(hextetsToV4(h[1], h[2]));

  return BLOCKED_V6.some(([network, bits]) => inV6Subnet(h, network, bits));
}

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function inV4Subnet(n, network, bits) {
  const size = 2 ** (32 - bits);
  return Math.floor(n / size) === Math.floor(network / size);
}

function hextetsToV4(hi, lo) {
  return hi * 65536 + lo;
}

// Returns an array of 8 numbers (0..65535), or null if not valid IPv6.
function expandIPv6(ip) {
  if (net.isIP(ip) !== 6) return null;
  let str = ip.toLowerCase();

  // Convert a trailing dotted IPv4 tail into two hextets.
  const lastColon = str.lastIndexOf(':');
  const tail = str.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToInt(tail);
    if (v4 === null) return null;
    str = str.slice(0, lastColon + 1) +
      Math.floor(v4 / 65536).toString(16) + ':' + (v4 % 65536).toString(16);
  }

  const [head, rest] = str.split('::');
  const headParts = head ? head.split(':') : [];
  const restParts = rest !== undefined && rest !== '' ? rest.split(':') : [];
  let parts;
  if (str.includes('::')) {
    const fill = 8 - headParts.length - restParts.length;
    if (fill < 0) return null;
    parts = [...headParts, ...Array(fill).fill('0'), ...restParts];
  } else {
    parts = headParts;
  }
  if (parts.length !== 8) return null;
  return parts.map(p => parseInt(p, 16));
}

function inV6Subnet(h, network, bits) {
  let remaining = bits;
  for (let i = 0; i < 8 && remaining > 0; i++) {
    const take = Math.min(16, remaining);
    const mask = (0xffff << (16 - take)) & 0xffff;
    if ((h[i] & mask) !== (network[i] & mask)) return false;
    remaining -= take;
  }
  return true;
}
