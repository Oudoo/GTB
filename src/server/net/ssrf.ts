/**
 * Destination policy for outbound webhook calls (document 04 "Webhooks", I-47).
 *
 * - HTTPS only, default port only, no credentials in the URL.
 * - The host must resolve ONLY to public unicast addresses. Loopback, private, link-local
 *   (including cloud metadata), carrier-grade NAT, unique-local, multicast and reserved ranges
 *   are refused in every IPv4/IPv6 spelling, including IPv4-mapped IPv6.
 * - The check runs at registration AND again at delivery, and delivery connects to the address
 *   that was just validated (no second lookup), so DNS rebinding cannot swap the target.
 * - The only exception is an origin listed in WEBHOOK_TEST_RECEIVER_ALLOWLIST by the operator
 *   of the deployment — never something a user can type into the product.
 */
import ipaddr from "ipaddr.js";

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export type DestinationProblem = "URL_INVALID" | "SCHEME_NOT_HTTPS" | "CREDENTIALS_IN_URL" | "PORT_NOT_ALLOWED" | "HOST_NOT_ALLOWED" | "ADDRESS_NOT_PUBLIC" | "HOST_UNRESOLVABLE";

export class DestinationError extends Error {
  constructor(readonly problem: DestinationProblem) {
    super(problem);
    this.name = "DestinationError";
  }
}

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".corp", ".intranet"];

/** True only for a globally routable unicast address. */
export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  // `process` unwraps IPv4-mapped IPv6 (::ffff:10.0.0.1) to the IPv4 address it really is.
  return ipaddr.process(address).range() === "unicast";
}

export type Destination = { url: URL; testFixture: boolean };

/** Syntactic policy. Throws `DestinationError`; never performs a network call. */
export function parseDestination(raw: string, testAllowlist: readonly string[]): Destination {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DestinationError("URL_INVALID");
  }
  if (raw.length > 2_000 || url.hash !== "") throw new DestinationError("URL_INVALID");
  if (url.username !== "" || url.password !== "") throw new DestinationError("CREDENTIALS_IN_URL");
  if (testAllowlist.includes(url.origin)) return { url, testFixture: true };
  if (url.protocol !== "https:") throw new DestinationError("SCHEME_NOT_HTTPS");
  if (url.port !== "" && url.port !== "443") throw new DestinationError("PORT_NOT_ALLOWED");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "" || host === "localhost" || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix)) || !host.includes(".") && !ipaddr.isValid(host)) throw new DestinationError("HOST_NOT_ALLOWED");
  // An IP literal (in any spelling the URL parser normalizes) must itself be public.
  if (ipaddr.isValid(host) && !isPublicAddress(host)) throw new DestinationError("ADDRESS_NOT_PUBLIC");
  return { url, testFixture: false };
}

/**
 * Resolve the host and require EVERY returned address to be public. Returns the address to
 * connect to. A fixture destination from the operator's allowlist is returned unresolved.
 */
export async function resolveDestination(destination: Destination, resolver: Resolver): Promise<ResolvedAddress | null> {
  if (destination.testFixture) return null;
  const host = destination.url.hostname.replace(/^\[|\]$/g, "");
  if (ipaddr.isValid(host)) {
    if (!isPublicAddress(host)) throw new DestinationError("ADDRESS_NOT_PUBLIC");
    return { address: host, family: ipaddr.parse(host).kind() === "ipv6" ? 6 : 4 };
  }
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolver(host);
  } catch {
    throw new DestinationError("HOST_UNRESOLVABLE");
  }
  if (addresses.length === 0) throw new DestinationError("HOST_UNRESOLVABLE");
  if (addresses.some((entry) => !isPublicAddress(entry.address))) throw new DestinationError("ADDRESS_NOT_PUBLIC");
  return addresses[0] as ResolvedAddress;
}
