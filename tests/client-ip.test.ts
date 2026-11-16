import { describe, expect, it } from "vitest";
import { clientIpFromForwarded } from "@/server/auth/forwarded";

/**
 * Which end of `X-Forwarded-For` we believe.
 *
 * This is one line of code and it decides whether three rate limits exist. The
 * header is a chain in which every proxy appends the peer it received the
 * request from, so the entries run furthest-away first and the leftmost one is
 * the only entry nothing we control wrote — it is whatever the caller sent.
 * Read it and the caller picks its own bucket key, which means the contact
 * form's five-an-hour limit, the CSP report limit and the IP axis of the login
 * throttle all stop counting anything.
 *
 * The failure is invisible from the outside: every limit still fires in
 * testing, because a normal browser sends no `X-Forwarded-For` of its own and
 * the chain has one honest entry. It only stops working for the person who
 * adds a header. Hence a test that spoofs on purpose.
 */
describe("clientIpFromForwarded", () => {
  it("reads the only entry when one proxy has appended one", () => {
    expect(clientIpFromForwarded("203.0.113.9", 1)).toBe("203.0.113.9");
  });

  it("ignores an entry the caller prepended, and takes the one Apache wrote", () => {
    // The spoofing case. `198.51.100.7` is the attacker's invention; Apache
    // appended `203.0.113.9` after it. Returning the first entry here would
    // hand every request a bucket of its own.
    expect(clientIpFromForwarded("198.51.100.7, 203.0.113.9", 1)).toBe("203.0.113.9");
  });

  it("stays spoof-proof however many entries are prepended", () => {
    const forged = Array.from({ length: 40 }, (_, i) => `198.51.100.${i + 1}`).join(", ");
    expect(clientIpFromForwarded(`${forged}, 203.0.113.9`, 1)).toBe("203.0.113.9");
  });

  it("counts in from the right when two hops are trusted", () => {
    // Cloudflare in front of Apache: Apache appended Cloudflare's address
    // last, and Cloudflare appended the real client before it.
    expect(
      clientIpFromForwarded("198.51.100.7, 203.0.113.9, 192.0.2.1", 2),
    ).toBe("203.0.113.9");
  });

  it("returns null when the chain is shorter than the configured hop count", () => {
    // Misconfiguration, or a request that did not arrive the way the
    // deployment says it does. Falling back to the leftmost entry would be
    // falling back to the client-controlled end, so there is no fallback: the
    // caller gets null and uses the shared bucket.
    expect(clientIpFromForwarded("203.0.113.9", 2)).toBeNull();
  });

  it("ignores the header entirely when no proxy is trusted", () => {
    expect(clientIpFromForwarded("203.0.113.9, 192.0.2.1", 0)).toBeNull();
    expect(clientIpFromForwarded("203.0.113.9", -1)).toBeNull();
  });

  it("has nothing to read when the header is absent or empty", () => {
    expect(clientIpFromForwarded(null, 1)).toBeNull();
    expect(clientIpFromForwarded(undefined, 1)).toBeNull();
    expect(clientIpFromForwarded("", 1)).toBeNull();
    expect(clientIpFromForwarded("   ", 1)).toBeNull();
  });

  it("drops empty segments instead of letting them shift the index", () => {
    // `a,,b` and a trailing comma are both emitted by real proxies. A blank
    // entry kept in the list would move which hop we trust by one.
    expect(clientIpFromForwarded("198.51.100.7,, 203.0.113.9", 1)).toBe("203.0.113.9");
    expect(clientIpFromForwarded("203.0.113.9, ", 1)).toBe("203.0.113.9");
    expect(clientIpFromForwarded(", ,", 1)).toBeNull();
  });

  it("strips a port, so a proxy that writes one does not erase the address", () => {
    // Left in place this fails validation and returns null, which collapses
    // every such request into the shared bucket — a limit that has quietly
    // stopped telling anybody apart.
    expect(clientIpFromForwarded("1.2.3.4:51234", 1)).toBe("1.2.3.4");
  });

  it("rejects something that is not an address", () => {
    expect(clientIpFromForwarded("999.1.1.1", 1)).toBeNull();
    expect(clientIpFromForwarded("not-an-ip", 1)).toBeNull();
    expect(clientIpFromForwarded("<script>", 1)).toBeNull();
  });

  it("accepts an IPv6 literal", () => {
    expect(clientIpFromForwarded("2001:db8::1", 1)).toBe("2001:db8::1");
  });
});
