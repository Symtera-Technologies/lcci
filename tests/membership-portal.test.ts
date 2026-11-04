import { describe, expect, it } from "vitest";
import {
  LEGACY_PORTAL,
  MEMBERSHIP_PORTAL_ENABLED,
  disabledRouteTarget,
} from "@/membership/portal";

/**
 * The membership portal is switched off and every transactional route is
 * redirected to the Chamber's own portal. These tests pin the two halves of
 * that which are easy to get wrong: which paths are caught, and which are
 * emphatically not.
 */
describe("the membership portal switch", () => {
  it("is off", () => {
    // The rest of this file describes the behaviour of the off state. If
    // somebody turns the portal back on, these tests should be read again
    // rather than quietly passing against a flag that no longer applies.
    expect(MEMBERSHIP_PORTAL_ENABLED).toBe(false);
  });

  it("sends the Chamber's own portal an absolute https address", () => {
    // A relative path here would be resolved against this site and quietly
    // produce a redirect loop back to the route we are redirecting away from.
    for (const url of Object.values(LEGACY_PORTAL)) {
      expect(url).toMatch(/^https:\/\/membership\.lcci\.org\.pk\//);
    }
  });

  it("sends joining to the portal's registration form", () => {
    expect(disabledRouteTarget("/membership/register")).toBe(LEGACY_PORTAL.register);
    expect(disabledRouteTarget("/membership/apply")).toBe(LEGACY_PORTAL.register);
    expect(disabledRouteTarget("/membership/apply/submitted")).toBe(
      LEGACY_PORTAL.register,
    );
  });

  it("sends anyone with an existing account to the portal's sign-in", () => {
    // Not the registration form. Someone who had an application open here
    // already has an account somewhere, and handing them a signup page is the
    // more confusing of the two wrong answers.
    expect(disabledRouteTarget("/membership/sign-in")).toBe(LEGACY_PORTAL.signIn);
    expect(disabledRouteTarget("/membership/applications")).toBe(LEGACY_PORTAL.signIn);
    expect(disabledRouteTarget("/membership/applications/01HQ")).toBe(
      LEGACY_PORTAL.signIn,
    );
  });

  it("sends the staff queues back to the dashboard", () => {
    expect(disabledRouteTarget("/admin/applications")).toBe("/admin");
    expect(disabledRouteTarget("/admin/applications/01HQ/approval")).toBe("/admin");
    expect(disabledRouteTarget("/admin/payments")).toBe("/admin");
    expect(disabledRouteTarget("/admin/reports/sla")).toBe("/admin");
  });

  it("leaves the public membership pages alone", () => {
    // The whole point of "content only" is that these still work. A redirect
    // rule one segment too wide would take the entire section off the site,
    // which is the single most damaging way this change could go wrong.
    for (const path of [
      "/membership",
      "/membership/why-join",
      "/membership/categories",
      "/membership/renew",
      "/membership/directory",
      "/membership/faqs",
    ]) {
      expect(disabledRouteTarget(path), path).toBeNull();
    }
  });

  it("leaves the rest of the admin alone", () => {
    for (const path of [
      "/admin",
      "/admin/content",
      "/admin/content/review",
      "/admin/media",
      "/admin/users",
      "/admin/audit",
      "/admin/security",
      "/admin/sign-in",
      // Shares a prefix with `/admin/reports/sla` and must survive it.
      "/admin/reports",
    ]) {
      expect(disabledRouteTarget(path), path).toBeNull();
    }
  });

  it("matches whole segments, not string prefixes", () => {
    // `/membership/applyXYZ` is a different route from `/membership/apply`.
    // A plain `startsWith` would catch it, which is the trap
    // `PROTECTED_PREFIXES` documents for the same reason.
    expect(disabledRouteTarget("/membership/applyXYZ")).toBeNull();
    expect(disabledRouteTarget("/membership/registered")).toBeNull();
    expect(disabledRouteTarget("/admin/applications-archive")).toBeNull();
  });

  it("leaves the public site untouched", () => {
    for (const path of ["/", "/about", "/services", "/news", "/resources/banks"]) {
      expect(disabledRouteTarget(path), path).toBeNull();
    }
  });
});
