import { lookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";

/**
 * Keeping outbound requests out of the private network.
 *
 * A webhook URL is supplied by a person and fetched by the server, which is the
 * textbook shape of SSRF: the caller borrows the server's network position. On a
 * cloud host that reaches 169.254.169.254, whose whole job is to hand out
 * credentials to whatever asks. On a company LAN it reaches everything the box
 * can see and the author cannot.
 *
 * Two checks, at two different moments, because one is not enough:
 *   - at creation, so the person gets told immediately rather than wondering
 *     why their endpoint never fires;
 *   - at delivery, because DNS is not a promise. A name that resolves to a
 *     public address while it is being validated can resolve to 127.0.0.1 a
 *     second later — that is DNS rebinding, and validating only on the way in
 *     is exactly the mistake it exists to exploit.
 */

export class BlockedAddress extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedAddress";
  }
}

/** IPv4 ranges nothing outbound has any business reaching. */
function isPrivateV4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  const [a = 0, b = 0] = p;
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;

  if (a === 0) return true;                       // "this network"
  if (a === 10) return true;                      // private
  if (a === 127) return true;                     // loopback
  if (a === 169 && b === 254) return true;        // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true;        // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier NAT
  if (a === 192 && b === 0) return true;          // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true;                      // multicast and reserved
  return false;
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "::1" || lower === "::") return true;

  /*
   * An IPv4-mapped address is an IPv4 address wearing a hat: ::ffff:127.0.0.1
   * reaches loopback just as well, so unwrap it rather than trusting the shape.
   *
   * Both spellings matter. Node's URL parser normalises the dotted form into
   * hex — ::ffff:127.0.0.1 becomes ::ffff:7f00:1 — so matching only the
   * readable one lets the normalised one straight through. A test caught that.
   */
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted?.[1]) return isPrivateV4(dotted[1]);

  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex?.[1] && hex[2]) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return isPrivateV4(
      `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`,
    );
  }

  const head = lower.split(":")[0] ?? "";
  const n = parseInt(head || "0", 16);
  if ((n & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((n & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  if (isIPv4(ip)) return isPrivateV4(ip);
  if (isIPv6(ip)) return isPrivateV6(ip);
  return true; // unparseable is not provably public
}

/**
 * Resolve a URL and refuse it if any address behind it is private.
 *
 * Returns the address to connect to, so the caller can pin the request to the
 * IP that was actually checked rather than resolving the name a second time and
 * getting a different answer.
 *
 * The policy is a parameter rather than a config import, so this module stays
 * pure: it has no database, no environment, and can be tested — or lifted into
 * another codebase — on its own.
 */
export async function resolvePublic(
  raw: string,
  opts: { allowPrivate?: boolean } = {},
): Promise<{ url: URL; address: string }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedAddress("That is not a URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedAddress("A webhook must be an http or https URL");
  }

  // Deliberately after the scheme check: file:// stays refused either way.
  if (opts.allowPrivate) return { url, address: url.hostname };

  const host = url.hostname.replace(/^\[|\]$/g, "");

  // A literal address needs no resolution, and must not get one — a DNS lookup
  // of "127.0.0.1" would happily hand it straight back.
  if (isIPv4(host) || isIPv6(host)) {
    if (isPrivateAddress(host)) {
      throw new BlockedAddress(`${host} is on a private network, so nothing will be sent there`);
    }
    return { url, address: host };
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new BlockedAddress(`${host} could not be resolved`);
  }
  if (addresses.length === 0) throw new BlockedAddress(`${host} could not be resolved`);

  // Every answer must be public. One private address among several is enough
  // for an attacker who can influence which one gets used.
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new BlockedAddress(
        `${host} resolves to ${address}, which is on a private network`,
      );
    }
  }

  return { url, address: addresses[0]!.address };
}
