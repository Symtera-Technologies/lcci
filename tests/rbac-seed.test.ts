import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PERMISSIONS,
  PERMISSION_CODES,
  ROLE_CODES,
  ROLE_SEED,
  permissionsForRole,
} from "@/server/permissions";

/**
 * The seed migration against the TypeScript it was generated from.
 *
 * These two must not drift, and the failure mode if they do is quiet: a
 * permission that exists as a TypeScript code and not as a `permissions` row
 * makes every check against it fail, which is a role that cannot do its job
 * with nothing in any log to say why. The reverse — a row with no code — is a
 * grant nothing can ever check.
 *
 * So this parses the committed SQL and compares it with the constants. Editing
 * a role's grants and forgetting `npm run seed:rbac` fails here.
 */

const SEED_PATH = path.join(process.cwd(), "migrations", "0005_seed_rbac.sql");

async function seedSql(): Promise<string> {
  return readFile(SEED_PATH, "utf8");
}

/** Every `('a', 'b')` tuple in the file, which is enough structure to compare. */
function tuples(sql: string): Array<string[]> {
  const found: Array<string[]> = [];
  const pattern = /\(\s*('(?:[^']|'')*'(?:\s*,\s*(?:'(?:[^']|'')*'|\d+))*)\s*\)/g;

  for (const match of sql.matchAll(pattern)) {
    const parts = match[1]
      .split(/\s*,\s*/)
      .map((part) =>
        part.startsWith("'") ? part.slice(1, -1).replace(/''/g, "'") : part,
      );
    found.push(parts);
  }

  return found;
}

describe("the RBAC seed migration", () => {
  it("declares every permission in the TypeScript vocabulary", async () => {
    const sql = await seedSql();
    const insertBlock = sql.slice(
      sql.indexOf("INSERT INTO permissions"),
      sql.indexOf("INSERT INTO roles"),
    );
    const declared = new Set(tuples(insertBlock).map((parts) => parts[0]));

    const missing = PERMISSION_CODES.filter((code) => !declared.has(code));
    expect(
      missing,
      `Permissions in TypeScript but not in the seed. Run \`npm run seed:rbac > migrations/0005_seed_rbac.sql\`.\n${missing.join("\n")}`,
    ).toEqual([]);

    const extra = [...declared].filter(
      (code) => !(PERMISSION_CODES as string[]).includes(code),
    );
    expect(extra, `Permissions in the seed with no TypeScript code.\n${extra.join("\n")}`).toEqual(
      [],
    );
  });

  it("carries each permission's label and domain", async () => {
    const sql = await seedSql();
    const insertBlock = sql.slice(
      sql.indexOf("INSERT INTO permissions"),
      sql.indexOf("INSERT INTO roles"),
    );

    const byCode = new Map(tuples(insertBlock).map((parts) => [parts[0], parts]));

    for (const code of PERMISSION_CODES) {
      const row = byCode.get(code);
      expect(row?.[1], code).toBe(PERMISSIONS[code].label);
      expect(row?.[2], code).toBe(PERMISSIONS[code].domain);
    }
  });

  it("declares every role, with its label and system flag", async () => {
    const sql = await seedSql();
    const insertBlock = sql.slice(
      sql.indexOf("INSERT INTO roles"),
      sql.indexOf("INSERT IGNORE INTO role_permissions"),
    );

    const byCode = new Map(tuples(insertBlock).map((parts) => [parts[0], parts]));
    expect([...byCode.keys()].sort()).toEqual([...ROLE_CODES].sort());

    for (const code of ROLE_CODES) {
      const row = byCode.get(code);
      expect(row?.[1], code).toBe(ROLE_SEED[code].label);
      expect(row?.[2], code).toBe(ROLE_SEED[code].isSystem ? "1" : "0");
    }
  });

  it("grants each enumerated role exactly its seeded permissions", async () => {
    const sql = await seedSql();
    const grantBlock = sql.slice(sql.indexOf("INSERT IGNORE INTO role_permissions"));

    const granted = new Map<string, Set<string>>();
    for (const [roleCode, permissionCode] of tuples(grantBlock)) {
      if (!permissionCode) continue;
      const set = granted.get(roleCode) ?? new Set<string>();
      set.add(permissionCode);
      granted.set(roleCode, set);
    }

    for (const roleCode of ROLE_CODES) {
      // super_admin is granted by `SELECT code FROM permissions` rather than
      // by an enumerated list, so it has no tuples to compare.
      if (ROLE_SEED[roleCode].permissions === "all") continue;

      expect([...(granted.get(roleCode) ?? [])].sort(), roleCode).toEqual(
        [...permissionsForRole(roleCode)].sort(),
      );
    }
  });

  it("grants the super-admin from the table rather than from a list", async () => {
    // Enumerating them would make this migration wrong the moment a later one
    // adds a permission — and the symptom would be a super-admin who cannot
    // use the newest feature.
    const sql = await seedSql();
    expect(sql).toMatch(
      /INSERT IGNORE INTO role_permissions \(role_code, permission_code\)\s*\n\s*SELECT 'super_admin', code FROM permissions;/,
    );
  });

  it("seeds no user account", async () => {
    // A migration that creates an administrator creates one whose password is
    // in the repository.
    const sql = await seedSql();
    expect(sql).not.toMatch(/INSERT[\s\S]{0,40}INTO\s+users/i);
    expect(sql).not.toMatch(/INSERT[\s\S]{0,40}INTO\s+user_roles/i);
  });

  it("stays writable to MariaDB", async () => {
    // cPanel ships MariaDB far more often than MySQL 8, and the row-alias form
    // of ON DUPLICATE KEY UPDATE is a parse error there. `VALUES()` is
    // deprecated on MySQL 8 and works on both.
    const sql = await seedSql();
    expect(sql).toContain("VALUES(label_en)");
    expect(sql).not.toMatch(/\bAS\s+new\b/i);
  });

  it("is idempotent, so it can be pasted into phpMyAdmin", async () => {
    // SSH to this host will be unavailable at some point, and when it is, the
    // ability to paste a migration into phpMyAdmin without worrying about
    // whether it has already run is the difference between a fix and a wait.
    const sql = await seedSql();
    const statements = sql
      .split(";")
      .map((statement) => statement.replace(/--[^\n]*/g, "").trim())
      .filter((statement) => statement !== "");

    for (const statement of statements) {
      const idempotent =
        /ON DUPLICATE KEY UPDATE/i.test(statement) || /^INSERT IGNORE/i.test(statement);
      expect(idempotent, statement.slice(0, 80)).toBe(true);
    }
  });
});
