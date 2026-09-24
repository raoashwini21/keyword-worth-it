import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedAddress } from '../lib/ip-policy.js';

test('blocks loopback, private, link-local, metadata and reserved IPv4', () => {
  for (const ip of [
    '127.0.0.1', '127.255.255.254', '0.0.0.0', '10.0.0.1', '10.255.255.255',
    '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '169.254.0.1',
    '100.64.0.1', '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.5',
  ]) assert.equal(isBlockedAddress(ip), true, ip);
});

test('allows public IPv4, including neighbours of private ranges', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '11.0.0.1', '192.169.0.1', '169.255.0.1', '100.128.0.1']) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

test('blocks internal IPv6 and IPv6 forms embedding internal IPv4', () => {
  for (const ip of [
    '::1', '::', '[::1]', 'fe80::1', 'fe80::1%eth0', 'fc00::1', 'fd00:ec2::254', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::ffff:10.0.0.1',
    '64:ff9b::a9fe:a9fe', '2002:7f00:1::1', '2002:c0a8:101::', '::127.0.0.1', '2001:db8::1',
  ]) assert.equal(isBlockedAddress(ip), true, ip);
});

test('allows public IPv6', () => {
  for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '2002:808:808::1']) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

test('treats garbage as blocked', () => {
  for (const ip of ['', 'localhost', '999.1.1.1', 'not-an-ip', null, undefined]) {
    assert.equal(isBlockedAddress(ip), true, String(ip));
  }
});
