import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { splitStatements } from "@/db/migrate";

/**
 * The migration runner's SQL splitter, and the real migration files run
 * through it.
 *
 * This exists because there is no database in the development environment, so
 * the first time a migration would otherwise be parsed is on the production
 * host, by hand, over SSH. Parsing them here catches the class of mistake that
 * would turn a release into a half-applied schema: an unterminated string, a
 * semicolon swallowed by a comment, a statement lost to a splitter bug.
 *
 * It does not prove the SQL is *valid* — only MySQL can say that. It proves
 * the runner will hand MySQL the statements the file actually contains.
 */

const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");

describe("splitStatements", () => {
  it("splits on semicolons and trims", () => {
    expect(splitStatements("SELECT 1; SELECT 2;")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("drops a trailing empty statement", () => {
    expect(splitStatements("SELECT 1;\n\n")).toEqual(["SELECT 1"]);
  });

  it("keeps a final statement with no trailing semicolon", () => {
    expect(splitStatements("SELECT 1")).toEqual(["SELECT 1"]);
  });

  it("ignores a semicolon inside a single-quoted literal", () => {
    const out = splitStatements("INSERT INTO t VALUES ('a;b'); SELECT 2;");
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("'a;b'");
  });

  it("ignores a semicolon inside a double-quoted literal", () => {
    expect(splitStatements('SELECT "a;b"; SELECT 2;')).toHaveLength(2);
  });

  it("ignores a semicolon inside a backtick identifier", () => {
    expect(splitStatements("SELECT `odd;name`; SELECT 2;")).toHaveLength(2);
  });

  it("handles an escaped quote inside a literal", () => {
    const out = splitStatements("SELECT 'it\\'s; fine'; SELECT 2;");
    expect(out).toHaveLength(2);
  });

  it("does not treat a backslash as an escape inside a backtick identifier", () => {
    // MySQL does not process backslash escapes in quoted identifiers, so a
    // trailing backslash must not swallow the closing backtick.
    expect(splitStatements("SELECT `a\\`; SELECT 2;")).toHaveLength(2);
  });

  it("strips a line comment and the semicolon inside it", () => {
    const out = splitStatements("SELECT 1; -- a; comment\nSELECT 2;");
    expect(out).toHaveLength(2);
    expect(out[1]).toBe("SELECT 2");
  });

  it("strips a hash comment", () => {
    expect(splitStatements("SELECT 1; # a; comment\nSELECT 2;")).toHaveLength(2);
  });

  it("strips a block comment", () => {
    expect(splitStatements("SELECT /* a; b */ 1; SELECT 2;")).toHaveLength(2);
  });

  it("does not mistake a bare double dash for a comment", () => {
    // `--` is only a comment when followed by whitespace; `a--b` is an
    // expression, and treating it as a comment would silently drop SQL.
    const out = splitStatements("SELECT 1--2;");
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("--2");
  });
});

describe("the migration files on disk", () => {
  it("are all named NNNN_lower_snake_case.sql", async () => {
    const entries = await readdir(MIGRATIONS_DIR);
    const sqlFiles = entries.filter((name) => name.endsWith(".sql"));
    expect(sqlFiles.length).toBeGreaterThan(0);
    for (const name of sqlFiles) {
      expect(name).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    }
  });

  it("have unique, gapless version numbers starting at 0001", async () => {
    const entries = await readdir(MIGRATIONS_DIR);
    const versions = entries
      .filter((name) => name.endsWith(".sql"))
      .map((name) => name.slice(0, 4))
      .sort();

    expect(new Set(versions).size).toBe(versions.length);
    // Gapless is not required by the runner, but a gap almost always means a
    // migration was written and then lost rather than deliberately skipped.
    versions.forEach((version, index) => {
      expect(version).toBe(String(index + 1).padStart(4, "0"));
    });
  });

  it("split into statements that each look like DDL or DML", async () => {
    const entries = await readdir(MIGRATIONS_DIR);
    const sqlFiles = entries.filter((name) => name.endsWith(".sql")).sort();

    for (const name of sqlFiles) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, name), "utf8");
      const statements = splitStatements(sql);

      expect(statements.length, `${name} produced no statements`).toBeGreaterThan(0);

      for (const statement of statements) {
        expect(
          statement,
          `${name} has a statement that does not start with a known verb:\n${statement.slice(0, 120)}`,
        ).toMatch(/^(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|SET|RENAME)\b/i);

        // A statement ending in an opening construct means the splitter cut
        // in the wrong place.
        expect(statement.trimEnd().endsWith("("), `${name}: truncated statement`).toBe(
          false,
        );
      }
    }
  });

  it("declare InnoDB and utf8mb4 on every CREATE TABLE", async () => {
    const entries = await readdir(MIGRATIONS_DIR);
    const sqlFiles = entries.filter((name) => name.endsWith(".sql")).sort();

    for (const name of sqlFiles) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, name), "utf8");
      for (const statement of splitStatements(sql)) {
        if (!/^CREATE TABLE/i.test(statement)) continue;
        expect(statement, `${name}: missing ENGINE=InnoDB`).toMatch(/ENGINE=InnoDB/i);
        expect(statement, `${name}: missing utf8mb4`).toMatch(/CHARSET=utf8mb4/i);
        // utf8mb4_0900_* collations are MySQL 8 only, and cPanel commonly
        // ships MariaDB. Pinning to _unicode_ci keeps the DDL portable.
        expect(statement, `${name}: non-portable collation`).toMatch(
          /COLLATE=utf8mb4_unicode_ci/i,
        );
      }
    }
  });

  it("use no CHECK constraints", async () => {
    // Not enforced before MariaDB 10.2.1 / MySQL 8.0.16, and silently ignored
    // rather than rejected on older servers — so a CHECK here would look like
    // a guarantee while guaranteeing nothing.
    const entries = await readdir(MIGRATIONS_DIR);
    for (const name of entries.filter((n) => n.endsWith(".sql"))) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, name), "utf8");
      const withoutComments = splitStatements(sql).join("\n");
      expect(withoutComments, `${name} uses a CHECK constraint`).not.toMatch(
        /\bCHECK\s*\(/i,
      );
    }
  });
});
