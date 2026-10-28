import { describe, expect, it } from "vitest";
import {
  PERMISSIONS,
  PERMISSION_CODES,
  ROLE_CODES,
  ROLE_SEED,
  SEPARATION_OF_DUTIES,
  permissionsForRole,
} from "@/server/permissions";

/**
 * The role and permission seed.
 *
 * The separation-of-duties test is the one that matters. The printed
 * membership form carries a staff signature on the thirteen-item checklist, a
 * separate cashier signature on the fee block, and an approval — three
 * signatures by three people, which is the control. Nothing in a type system
 * stops someone adding `application.approve` to `membership_officer` so a
 * short-staffed office can get on with it, and if that happens the control is
 * gone with no error anywhere. So it fails the build instead.
 *
 * The legitimate answer for a secretariat where one officer is the only person
 * in the building is a `conflict_waivers` row: super-admin only, mandatory
 * reason, one audit event, visible on that application's history forever.
 */

describe("separation of duties", () => {
  it("never grants two conflicting permissions to one role", () => {
    for (const role of ROLE_CODES) {
      // super_admin holds everything by definition. It is excluded here and
      // constrained instead by the per-application check inside the approval
      // transaction, which refuses even a super admin who completed the
      // checklist unless a waiver exists.
      if (role === "super_admin") continue;

      const held = new Set(permissionsForRole(role));
      for (const conflict of SEPARATION_OF_DUTIES) {
        const both = conflict.filter((permission) => held.has(permission));
        expect(
          both,
          `role "${role}" holds conflicting permissions: ${both.join(" + ")}`,
        ).not.toHaveLength(conflict.length);
      }
    }
  });

  it("puts verification and approval on different roles that both exist", () => {
    // If this fails, either nobody can verify or nobody can grant membership —
    // and the second is the gap spec section 8.3 actually has.
    const verifiers = ROLE_CODES.filter((role) =>
      permissionsForRole(role).includes("application.verify"),
    );
    const approvers = ROLE_CODES.filter((role) =>
      permissionsForRole(role).includes("application.approve"),
    );
    const receipters = ROLE_CODES.filter((role) =>
      permissionsForRole(role).includes("payment.receipt"),
    );

    expect(verifiers.length).toBeGreaterThan(0);
    expect(approvers.length).toBeGreaterThan(0);
    expect(receipters.length).toBeGreaterThan(0);
    expect(approvers).toContain("membership_approver");
    expect(receipters).toContain("cashier");
  });
});

describe("the permission vocabulary", () => {
  it("grants only permissions that exist", () => {
    for (const role of ROLE_CODES) {
      for (const permission of permissionsForRole(role)) {
        expect(
          PERMISSION_CODES,
          `role "${role}" grants unknown permission "${permission}"`,
        ).toContain(permission);
      }
    }
  });

  it("gives super_admin every permission, including ones added later", () => {
    // Spelled as "all" rather than a list precisely so that adding a
    // permission does not quietly leave the super admin unable to use it.
    expect(ROLE_SEED.super_admin.permissions).toBe("all");
    expect(permissionsForRole("super_admin")).toHaveLength(PERMISSION_CODES.length);
  });

  it("names every permission in a domain.action shape", () => {
    for (const code of PERMISSION_CODES) {
      expect(code, `"${code}" is not dotted`).toMatch(/^[a-z_]+(\.[a-z_]+){1,2}$/);
    }
  });

  it("gives every permission a label and a domain", () => {
    for (const code of PERMISSION_CODES) {
      const entry = PERMISSIONS[code];
      expect(entry.label.length, `"${code}" has no label`).toBeGreaterThan(3);
      expect(["content", "membership", "finance", "admin"]).toContain(entry.domain);
    }
  });

  it("grants no membership, finance or admin permission to a content-only role", () => {
    // department_editor and media are scoped editors. A content role that
    // acquires `application.read` has acquired read access to every CNIC in
    // the system, which is not what "editor" means to the person granting it.
    for (const role of ["department_editor", "media"] as const) {
      for (const permission of permissionsForRole(role)) {
        expect(
          PERMISSIONS[permission].domain,
          `role "${role}" holds non-content permission "${permission}"`,
        ).toBe("content");
      }
    }
  });

  it("gives the cashier payment documents only, never the full set", () => {
    // The cashier must open two documents to do the job at all: the pay-order
    // scan and the bank account-maintenance certificate it was drawn against,
    // because comparing them *is* the anti-fraud control. That is not a reason
    // to hand over every director's CNIC, so the grant is the scoped
    // permission and not the blanket one.
    const held = permissionsForRole("cashier");
    expect(held).toContain("documents.read_financial");
    expect(held).not.toContain("documents.read");
    expect(held).not.toContain("documents.review");
  });

  it("scopes documents.read_financial to roles that handle money", () => {
    // If a content role ever acquires this, it has acquired bank certificates.
    for (const role of ROLE_CODES) {
      if (role === "super_admin") continue;
      if (!permissionsForRole(role).includes("documents.read_financial")) continue;
      expect(
        permissionsForRole(role),
        `role "${role}" reads payment documents without any payment duty`,
      ).toContain("payment.read");
    }
  });
});
