import type { PermissionDomain } from "@/db/schema";

/**
 * The permission vocabulary.
 *
 * Deliberately split between code and data. The *codes* live here as a closed
 * union, because they are referenced by name in route handlers and repository
 * functions — so `requirePermission(actor, "application.aprove")` has to be a
 * compile error, not a check that silently never matches. The *grants* live in
 * `role_permissions`, because which role holds which permission is a decision
 * the chamber will want to change without a deploy.
 *
 * No `server-only` import: the role and permission labels are rendered in the
 * admin UI, and a client component may legitimately need the type.
 */

export const PERMISSIONS = {
  /* --- Content ----------------------------------------------------------- */
  "content.read_draft": {
    domain: "content",
    label: "View unpublished content",
  },
  "content.create": { domain: "content", label: "Create content" },
  "content.edit": { domain: "content", label: "Edit content" },
  "content.submit_review": { domain: "content", label: "Submit content for review" },
  "content.review": { domain: "content", label: "Review submitted content" },
  "content.publish": { domain: "content", label: "Publish content" },
  "content.unpublish": { domain: "content", label: "Unpublish content" },
  "content.archive": { domain: "content", label: "Archive content" },
  "content.media.manage": { domain: "content", label: "Manage the media library" },

  /* --- Membership -------------------------------------------------------- */
  "application.read": { domain: "membership", label: "View applications" },
  "application.assign": { domain: "membership", label: "Assign applications" },
  "application.verify": {
    domain: "membership",
    label: "Complete the verification checklist",
  },
  "application.raise_deficiency": {
    domain: "membership",
    label: "Return an application for more information",
  },
  "application.recommend_reject": {
    domain: "membership",
    label: "Recommend rejection",
  },
  /**
   * Never held by the same role as `application.verify` or `payment.receipt`.
   * Separation of duties is enforced three ways — by grant here, by a
   * per-application check inside the approval transaction, and by an audited
   * waiver — because the printed form's separate staff and cashier signatures
   * exist to create exactly this separation.
   */
  "application.approve": { domain: "membership", label: "Grant membership" },
  "application.reject": { domain: "membership", label: "Reject an application" },
  "application.correct": {
    domain: "membership",
    label: "Correct an application out of sequence",
  },
  "membership.read": { domain: "membership", label: "View memberships" },
  "membership.issue": { domain: "membership", label: "Issue a membership number" },
  "membership.suspend": { domain: "membership", label: "Suspend a membership" },
  "directory.moderate": { domain: "membership", label: "Moderate directory listings" },
  "endorsement.verify": {
    domain: "membership",
    label: "Verify proposer and seconder standing",
  },
  "documents.read": { domain: "membership", label: "View uploaded documents" },
  "documents.review": { domain: "membership", label: "Accept or reject documents" },
  /**
   * Read only the documents whose `subject_kind` is `payment` — the pay-order
   * scan and the bank account-maintenance certificate.
   *
   * This exists because of what the control actually requires. Receipting a
   * fee means comparing the instrument against the certificate it was drawn
   * against, so the cashier genuinely must open two documents. It does not
   * mean reading every director's CNIC, which a blanket `documents.read`
   * would allow. The `subject_kind` column makes the narrower grant a SQL
   * predicate rather than a promise.
   */
  "documents.read_financial": {
    domain: "finance",
    label: "View payment documents only",
  },

  /* --- Finance ----------------------------------------------------------- */
  "payment.read": { domain: "finance", label: "View payments" },
  /** The cashier's duty, and the cashier's alone. */
  "payment.receipt": { domain: "finance", label: "Receipt a payment" },
  "payment.refund": { domain: "finance", label: "Record a refund" },
  "fee_schedule.manage": { domain: "finance", label: "Manage the fee schedule" },

  /* --- Admin ------------------------------------------------------------- */
  "user.manage": { domain: "admin", label: "Manage user accounts" },
  "role.manage": { domain: "admin", label: "Manage roles and permissions" },
  "calendar.manage": { domain: "admin", label: "Manage the working-day calendar" },
  "form_revision.manage": {
    domain: "admin",
    label: "Manage controlled form revisions",
  },
  "audit.read": { domain: "admin", label: "Read the audit log" },
  "conflict_waiver.grant": {
    domain: "admin",
    label: "Waive separation of duties on one application",
  },
  "migration.run": { domain: "admin", label: "Apply database migrations" },
} as const satisfies Record<string, { domain: PermissionDomain; label: string }>;

export type PermissionCode = keyof typeof PERMISSIONS;

export const PERMISSION_CODES = Object.keys(PERMISSIONS) as PermissionCode[];

/**
 * Roles and their grants.
 *
 * The five roles of spec section 8.3, plus two it is missing.
 *
 * `cashier` exists because the printed form carries a cashier block with its
 * own signature — a distinct duty with money attached. `membership_approver`
 * exists because somebody must *grant* membership, and one "Membership
 * Officer" doing both verification and approval collapses the separation of
 * duties that the thirteen-item checklist, the staff signature, the cashier
 * signature and the approval block exist to create. Both need adding to the
 * spec.
 *
 * This constant is the seed for `role_permissions`. Once seeded, the database
 * is authoritative — an administrator may adjust grants — so this is the
 * starting point, not a runtime source of truth.
 */
export const ROLE_SEED = {
  super_admin: {
    label: "Super administrator",
    isSystem: true,
    /** Every permission, including those added later. */
    permissions: "all",
    scope: "global",
  },
  department_editor: {
    label: "Department editor",
    isSystem: true,
    permissions: [
      "content.read_draft",
      "content.create",
      "content.edit",
      "content.submit_review",
      "content.media.manage",
    ],
    /** Scoped by `ownerDepartment` on the content row. */
    scope: "department",
  },
  reviewer: {
    label: "Reviewer",
    isSystem: true,
    permissions: [
      "content.read_draft",
      "content.review",
      "content.publish",
      "content.unpublish",
      "application.read",
      "application.verify",
      "application.raise_deficiency",
      "endorsement.verify",
      "documents.read",
      "documents.review",
    ],
    scope: "global",
  },
  media: {
    label: "Media",
    isSystem: true,
    permissions: [
      "content.read_draft",
      "content.create",
      "content.edit",
      "content.submit_review",
      "content.publish",
      "content.media.manage",
    ],
    /** Limited to press releases, galleries and videos. */
    scope: "content_type",
  },
  membership_officer: {
    label: "Membership officer",
    isSystem: true,
    permissions: [
      "application.read",
      "application.assign",
      "application.verify",
      "application.raise_deficiency",
      "application.recommend_reject",
      "endorsement.verify",
      "documents.read",
      "documents.review",
      "membership.read",
      "directory.moderate",
      "payment.read",
    ],
    scope: "global",
  },
  cashier: {
    label: "Cashier",
    isSystem: true,
    permissions: [
      "application.read",
      "payment.read",
      "payment.receipt",
      // Narrow by design: the pay order and the bank certificate, nothing else.
      "documents.read_financial",
    ],
    scope: "global",
  },
  membership_approver: {
    label: "Membership approver",
    isSystem: true,
    permissions: [
      "application.read",
      "application.approve",
      "application.reject",
      "membership.read",
      "membership.issue",
      "membership.suspend",
      "documents.read",
      "payment.read",
      "payment.refund",
    ],
    scope: "global",
  },
} as const satisfies Record<
  string,
  {
    label: string;
    isSystem: boolean;
    permissions: readonly PermissionCode[] | "all";
    scope: "global" | "department" | "content_type";
  }
>;

export type RoleCode = keyof typeof ROLE_SEED;

export const ROLE_CODES = Object.keys(ROLE_SEED) as RoleCode[];

/**
 * The three permissions that must never meet on one role.
 *
 * Asserted by a test rather than only documented, because this is the
 * invariant most likely to be broken by a well-meaning edit — somebody adds
 * `application.approve` to `membership_officer` so a short-staffed office can
 * get on with it, and the control is gone with no error anywhere.
 *
 * The legitimate answer for a secretariat where one officer is the only person
 * in the building is a `conflict_waivers` row: super-admin only, mandatory
 * reason, one audit event, visible on the application's history forever.
 */
export const SEPARATION_OF_DUTIES: readonly PermissionCode[][] = [
  ["application.verify", "application.approve"],
  ["payment.receipt", "application.approve"],
];

export function permissionsForRole(role: RoleCode): readonly PermissionCode[] {
  const seed = ROLE_SEED[role];
  return seed.permissions === "all" ? PERMISSION_CODES : seed.permissions;
}
