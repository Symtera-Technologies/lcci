import { describe, expect, it } from "vitest";
import { DEFAULT_DESTINATION, safeDestination } from "@/server/auth/destination";

/**
 * The sign-in redirect target.
 *
 * Small enough to read in one sitting and worth a test of its own, because the
 * failure mode is an open redirect on the one page where an open redirect is
 * most valuable to an attacker: the visitor has just proved who they are and
 * will trust whatever page comes next.
 *
 * The cases below are the ones that have historically survived hand-written
 * checks — protocol-relative URLs, backslashes, and a scheme smuggled past a
 * test that only looked for a leading slash.
 */

describe("safeDestination", () => {
  it("keeps a member path", () => {
    expect(safeDestination("/membership/apply")).toBe("/membership/apply");
    expect(safeDestination("/membership/apply?step=2")).toBe("/membership/apply?step=2");
    expect(safeDestination("/portal/dashboard")).toBe("/portal/dashboard");
  });

  it("falls back when there is nothing usable", () => {
    expect(safeDestination(undefined)).toBe(DEFAULT_DESTINATION);
    expect(safeDestination("")).toBe(DEFAULT_DESTINATION);
    expect(safeDestination(null)).toBe(DEFAULT_DESTINATION);
    expect(safeDestination(42)).toBe(DEFAULT_DESTINATION);
    expect(safeDestination({ toString: () => "/membership/apply" })).toBe(
      DEFAULT_DESTINATION,
    );
  });

  it("refuses another origin, however it is spelled", () => {
    for (const hostile of [
      "https://evil.example/x",
      "http://evil.example",
      // Protocol-relative: a browser reads this as another origin, and it is
      // the usual way an open redirect survives a check for "starts with /".
      "//evil.example/x",
      "///evil.example",
      // Some parsers and proxies fold a backslash to a slash.
      "/\\evil.example",
      "/membership/\\evil.example",
      "\\\\evil.example",
      "javascript:alert(1)",
      "mailto:someone@example.test",
    ]) {
      expect(safeDestination(hostile), hostile).toBe(DEFAULT_DESTINATION);
    }
  });

  it("refuses a path outside the member area", () => {
    // Including `/admin`: a member session must not be redirected into staff
    // routes, even though those routes would refuse it themselves. Two locks.
    expect(safeDestination("/admin")).toBe(DEFAULT_DESTINATION);
    expect(safeDestination("/admin/applications")).toBe(DEFAULT_DESTINATION);
    expect(safeDestination("/")).toBe(DEFAULT_DESTINATION);
    expect(safeDestination("/api/documents/1")).toBe(DEFAULT_DESTINATION);
    // A prefix that merely starts with the right letters is not the member
    // area: `/membershipfoo` would be a different route entirely.
    expect(safeDestination("/membershipfoo")).toBe(DEFAULT_DESTINATION);
  });

  it("refuses to loop back to the sign-in page", () => {
    expect(safeDestination("/membership/sign-in")).toBe(DEFAULT_DESTINATION);
    expect(safeDestination("/membership/sign-in?next=/membership/apply")).toBe(
      DEFAULT_DESTINATION,
    );
  });
});
