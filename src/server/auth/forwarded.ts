/**
 * Reading a client address out of `X-Forwarded-For`, from the right.
 *
 * This module has no imports on purpose. The one decision it makes is easy to
 * get wrong and hard to notice when it is wrong, so it is kept where a test can
 * reach it without standing up `next/headers`, a database pool or an
 * environment.
 *
 * **Why the rightmost entry, and not the first.**
 *
 * `X-Forwarded-For` is a chain, and each proxy that handles a request appends
 * the address of the peer it received that request *from*. So the entries are
 * ordered furthest-away first, and the leftmost one is the only entry in the
 * header that no proxy ever vouched for — it is whatever the client sent,
 * including when the client sent a fabricated chain. Taking it hands anyone who
 * can set a header the ability to choose which rate-limit bucket they land in,
 * which is the same thing as having no limit: a fresh value per request is a
 * fresh bucket per request.
 *
 * Counting from the right instead is correct without having to know how the
 * fronting Apache is configured — a question this repository cannot answer,
 * because `RemoteIPHeader` and `RemoteIPInternalProxy` live in host config:
 *
 *   - if Apache *appends* the peer, the rightmost entry is the one Apache
 *     itself wrote, and the spoofed entries sit harmlessly to its left;
 *   - if Apache *overwrites* the header, there is one entry and the two
 *     readings agree.
 *
 * So the rightmost entry is the only one a hop we control put there. How far in
 * to count is `trustedHops` — a fact about the deployment, not a preference,
 * which is why it arrives as configuration rather than being hardcoded here.
 */

/**
 * The client address, counting `trustedHops` proxies in from the right.
 *
 * Returns `null` rather than guessing whenever the header does not match the
 * deployment it was configured for. A caller that gets `null` falls back to a
 * single shared bucket, which throttles addressless requests against each other
 * — the safe direction. Guessing would mean reaching back toward the
 * client-controlled end of the chain, which is the defect this exists to avoid.
 */
export function clientIpFromForwarded(
  forwarded: string | null | undefined,
  trustedHops: number,
): string | null {
  // Zero trusted proxies means nothing we control wrote any part of this
  // header, so there is no entry in it worth reading. Configured deliberately
  // (a direct-to-Node deployment), it must disable the header rather than
  // quietly fall back to trusting the client's own first entry.
  if (!Number.isInteger(trustedHops) || trustedHops < 1) return null;
  if (!forwarded) return null;

  // Empty segments are dropped rather than kept, because `a,,b` and a trailing
  // comma are both things real proxies emit, and a blank entry that stayed in
  // the list would shift the index and silently move which hop we trust.
  const entries = forwarded
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  const candidate = entries[entries.length - trustedHops];
  if (candidate === undefined) return null;

  return normaliseIp(candidate);
}

/**
 * An address as it should be stored, or `null` if it is not one.
 *
 * The port is stripped before validation because some proxies write
 * `1.2.3.4:51234`. Left in, it fails the check below and the request collapses
 * into the shared bucket — a rate limit that quietly stops distinguishing
 * anybody, which looks exactly like a working one.
 */
function normaliseIp(value: string): string | null {
  // IPv4 with a port. An IPv6 literal also contains colons, so this only fires
  // when there is exactly one and the left side looks like dotted quad.
  const withoutPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(value);
  const address = withoutPort ? withoutPort[1] : value;

  return looksLikeIp(address) ? address : null;
}

function looksLikeIp(value: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return value.split(".").every((part) => Number(part) <= 255);
  }
  // Loose but sufficient: the value is hashed, never resolved or connected to,
  // so the cost of accepting a malformed IPv6 literal is one useless bucket.
  return /^[0-9a-fA-F:]{2,45}$/.test(value) && value.includes(":");
}
