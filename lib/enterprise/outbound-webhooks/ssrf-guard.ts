/**
 * Egress guard for customer-supplied outbound-webhook URLs (#1132).
 *
 * The endpoint URL is attacker-chosen by design — an org admin registers it.
 * Without a guard, `https://their-host/redir` → `http://169.254.169.254/…`
 * turns our delivery worker into a proxy for the platform's own metadata and
 * internal services. Two layers close it:
 *
 *   1. `assertPublicUrl` at registration AND again immediately before each
 *      delivery, so a hostname that later re-resolves to a private address
 *      (DNS rebinding) is caught on the next attempt rather than trusted from
 *      registration time.
 *   2. `redirect: "manual"` at the fetch call site, so a public host cannot
 *      bounce us to a private one after the check has passed.
 *
 * Fails closed: anything we cannot resolve or cannot classify is rejected.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class SsrfBlockedError extends Error {
  constructor(reason: string) {
    super(`Webhook URL rejected: ${reason}`);
    this.name = "SsrfBlockedError";
  }
}

/** Hostnames that must never be reachable regardless of what DNS says. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

// CIDRs that must never be dialled. Covers loopback, RFC1918, CGNAT, link-local
// (which is where cloud metadata lives), benchmarking, TEST-NET, multicast and
// reserved space.
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function isBlockedV4(ip: string): boolean {
  const addr = ipv4ToInt(ip);
  if (addr === null) return true; // unparseable → fail closed
  for (const [base, bits] of BLOCKED_V4) {
    const baseInt = ipv4ToInt(base);
    if (baseInt === null) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((addr & mask) === (baseInt & mask)) return true;
  }
  return false;
}

function isBlockedV6(ip: string): boolean {
  const v = ip.toLowerCase().split("%")[0]; // strip zone index

  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96) embed a v4 address —
  // classify on the embedded address, not the v6 wrapper.
  const embedded = v.match(/(?:^::ffff:|^64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (embedded) return isBlockedV4(embedded[1]);

  if (v === "::" || v === "::1") return true;
  if (v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb")) {
    return true; // fe80::/10 link-local
  }
  if (/^f[cd]/.test(v)) return true; // fc00::/7 unique-local
  if (v.startsWith("ff")) return true; // ff00::/8 multicast
  if (v.startsWith("2002:")) return true; // 6to4 — wraps a v4 address
  return false;
}

function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedV4(ip);
  if (family === 6) return isBlockedV6(ip);
  return true; // not an IP we understand → fail closed
}

/**
 * Rejects a webhook URL that is not plainly a public https endpoint.
 * Throws `SsrfBlockedError` with a customer-safe reason; never returns false.
 */
export async function assertPublicUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError("not a valid URL");
  }

  if (url.protocol !== "https:") {
    throw new SsrfBlockedError("must use https://");
  }
  if (url.port && url.port !== "443") {
    throw new SsrfBlockedError("only port 443 is allowed");
  }
  if (url.username || url.password) {
    throw new SsrfBlockedError("credentials in the URL are not allowed");
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new SsrfBlockedError("host is not publicly routable");
  }

  // A literal IP skips DNS entirely — classify it directly.
  if (isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new SsrfBlockedError("host is not publicly routable");
    }
    return;
  }

  let resolved: Array<{ address: string }>;
  try {
    resolved = await lookup(host, { all: true });
  } catch {
    throw new SsrfBlockedError("host could not be resolved");
  }
  if (resolved.length === 0) {
    throw new SsrfBlockedError("host could not be resolved");
  }
  // EVERY answer must be public: a host that returns one public and one private
  // address would otherwise be dialled on the private one at connect time.
  for (const { address } of resolved) {
    if (isBlockedAddress(address)) {
      throw new SsrfBlockedError("host resolves to a non-public address");
    }
  }
}
