import "server-only";

import { getDb } from "@/db/client";
import { ROLE_SEED, type RoleCode } from "@/server/permissions";
import type { DepartmentOption, RoleOption } from "@/components/admin/staff-forms";

/**
 * What the role and department controls offer.
 *
 * The notes are written here, beside the grants, rather than in the form,
 * because the thing an administrator needs to know when ticking a box is what
 * the role is *for* — and the three that carry separation-of-duties weight
 * need to say so at the moment of the decision, not in a policy document.
 */
const NOTES: Record<RoleCode, string> = {
  super_admin: "Everything, including these account screens. Keep it to one or two people.",
  department_editor:
    "Writes and submits content for one department. Scoped by the department below.",
  reviewer: "Reviews and publishes content, and verifies applications.",
  media: "Press releases, galleries and videos.",
  membership_officer:
    "Works the application queue: verification, deficiencies, the directory.",
  cashier:
    "Receipts fees and reads the pay order and bank certificate — and no other documents. Never also approves.",
  membership_approver:
    "Grants and refuses membership, issues numbers, records refunds. Never also verifies or receipts.",
};

export function roleOptions(): RoleOption[] {
  return (Object.keys(ROLE_SEED) as RoleCode[]).map((code) => ({
    code,
    label: ROLE_SEED[code].label,
    scoped: ROLE_SEED[code].scope === "department",
    note: NOTES[code],
  }));
}

/** The departments, for the one role that is scoped by them. */
export async function departmentOptions(): Promise<DepartmentOption[]> {
  const rows = await getDb()
    .selectFrom("departments")
    .select(["code", "name_en"])
    .where("active", "=", 1)
    .orderBy("sort_order", "asc")
    .execute();

  return rows.map((row) => ({ code: row.code, label: row.name_en }));
}
