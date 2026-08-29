import assert from "node:assert/strict";
import { test } from "node:test";

import { isPrivateAddress, resolvePublic, BlockedAddress } from "./ssrf.js";

test("private and reserved addresses are recognised", () => {
  const blocked = [
    "127.0.0.1", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254",           // cloud metadata: the one that leaks credentials
    "0.0.0.0", "100.64.0.1", "224.0.0.1", "255.255.255.255",
    "::1", "fc00::1", "fe80::1",
    "::ffff:127.0.0.1",          // IPv4-mapped loopback
    "not-an-ip",
  ];
  for (const ip of blocked) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be treated as private`);
  }

  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700::1111"]) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be allowed`);
  }
});

test("a webhook URL cannot point into the private network", async () => {
  for (const url of [
    "http://127.0.0.1:3000/health",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]:3000/health",
    "http://10.0.0.1/",
    "http://192.168.1.1/",
    "http://[::ffff:127.0.0.1]/",
  ]) {
    await assert.rejects(() => resolvePublic(url), BlockedAddress, `${url} should be refused`);
  }
});

test("only http and https are allowed", async () => {
  for (const url of ["file:///etc/passwd", "gopher://x/", "ftp://x/"]) {
    await assert.rejects(() => resolvePublic(url), BlockedAddress, `${url} should be refused`);
  }
  await assert.rejects(() => resolvePublic("not a url"), BlockedAddress);
});

test("an ordinary public URL is allowed through", async () => {
  const { url, address } = await resolvePublic("https://example.com/hooks/pergola");
  assert.equal(url.hostname, "example.com");
  assert.ok(address.length > 0, "the checked address is returned for pinning");
});
