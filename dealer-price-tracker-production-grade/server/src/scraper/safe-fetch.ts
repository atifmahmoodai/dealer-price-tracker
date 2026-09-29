import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

/**
 * Competitor URLs are typed in by users, and the server fetches them. Without care, that lets anyone
 * with an admin login make the server read internal services (cloud metadata at 169.254.169.254, the
 * database host, admin panels on the private network). This fetch refuses such addresses:
 * - every DNS answer is checked at connect time (so DNS rebinding can't slip a private address in);
 * - literal IP hosts and every redirect hop are checked too;
 * - only http and https, at most 5 redirects, and a cap on how much of a page is read.
 */

const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, bits, "ipv4");
}
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["64:ff9b::", 96],
  ["2001:db8::", 32],
] as const) {
  blocked.addSubnet(net, bits, "ipv6");
}

/** True for loopback, private, link-local, multicast, documentation and other non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return blocked.check(ip, "ipv4");
  if (v === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) return blocked.check(mapped[1], "ipv4");
    return blocked.check(ip, "ipv6");
  }
  return true; // not an IP at all: refuse
}

export class BlockedAddressError extends Error {
  constructor(what: string) {
    super(`refused to fetch ${what}: private or local network address`);
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

function guardedLookup(hostname: string, options: { all?: boolean; family?: number }, callback: LookupCallback) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as LookupAddress[];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad || !list.length) return callback(Object.assign(new BlockedAddressError(`${hostname} (${bad?.address ?? "no address"})`), { code: "EBLOCKED" }), "", 0);
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

export interface SafeFetchOptions {
  allowPrivate?: boolean;
  maxBytes?: number;
  maxRedirects?: number;
}

/** A fetch() for the scraper with the protections above. Only the parts of fetch the scraper uses. */
export function createSafeFetch(opts: SafeFetchOptions = {}): typeof fetch {
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 5;
  const dispatcher = new Agent({
    connect: opts.allowPrivate ? {} : { lookup: guardedLookup as never },
    headersTimeout: 30_000,
    bodyTimeout: 30_000,
  });

  const checkUrl = (u: URL) => {
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`refused to fetch ${u.protocol} URL`);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (!opts.allowPrivate && isIP(host) && isPrivateAddress(host)) throw new BlockedAddressError(u.host);
    if (!opts.allowPrivate && /^localhost$|\.localhost$|\.internal$|\.local$/i.test(host)) throw new BlockedAddressError(u.host);
  };

  const safeFetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    let url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    for (let hop = 0; ; hop++) {
      checkUrl(url);
      const res = await undiciFetch(url, {
        method: "GET",
        headers: init.headers as Record<string, string> | undefined,
        signal: init.signal ?? undefined,
        redirect: "manual",
        dispatcher,
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        await res.body?.cancel();
        if (hop >= maxRedirects) throw new Error("too many redirects");
        url = new URL(res.headers.get("location")!, url);
        continue;
      }
      // Read at most maxBytes, so a huge or endless response can't exhaust memory.
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (res.body) {
        for await (const chunk of res.body) {
          size += chunk.byteLength;
          if (size > maxBytes) {
            await res.body.cancel().catch(() => {});
            throw new Error(`page larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
          }
          chunks.push(chunk);
        }
      }
      const body = Buffer.concat(chunks);
      return new Response(res.status === 204 || res.status === 304 ? null : body, { status: res.status, headers: new Headers([...res.headers]) });
    }
  };
  return safeFetch as typeof fetch;
}
