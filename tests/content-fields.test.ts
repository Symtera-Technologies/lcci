import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTENT_FORMS, CONTENT_KINDS, allFields, parentFields } from "@/content/fields";
import type { FieldSpec } from "@/content/fields";

/**
 * The editor's field specs against the actual columns.
 *
 * `src/content/fields.ts` is a second description of a schema that already
 * exists in SQL, and two descriptions of one thing drift. The drift is silent
 * in both directions and both are bad: a `NOT NULL` column with no spec field
 * is a column no editor can fill, so every save of that type fails with a
 * database error; a spec field naming a column that was renamed writes into
 * nothing until somebody opens that one screen, months later.
 *
 * So the migrations are parsed and compared. This is a guard on a guard — the
 * field specs are what make twelve bespoke editors unnecessary, and this is
 * what makes the specs trustworthy. It reads the `.sql` files rather than the
 * database so it runs in the default suite with no MySQL at all.
 *
 * It also checks two things that are easy to get subtly wrong and impossible
 * to notice: that a `select`'s options are exactly its column's `ENUM` values,
 * and that a text field's character limit is its column's width. A limit that
 * is too generous does not fail — it truncates, which is the defect nobody
 * reports for months.
 */

interface Column {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly hasDefault: boolean;
  /** For VARCHAR(n), n. */
  readonly width: number | null;
  /** For ENUM(...), the values in declaration order. */
  readonly enumValues: readonly string[] | null;
}

const MIGRATIONS = join(process.cwd(), "migrations");

function readMigration(file: string): string {
  return readFileSync(join(MIGRATIONS, file), "utf8");
}

/**
 * The columns of every `CREATE TABLE` in a migration.
 *
 * Deliberately a small parser over our own hand-written DDL rather than
 * anything general: the files are in one house style, every column sits at two
 * spaces of indent, and the constraint lines all start with a keyword. A
 * general SQL parser would be a dependency carrying far more behaviour than
 * the one question asked here.
 */
function parseTables(sql: string): Map<string, Column[]> {
  const tables = new Map<string, Column[]>();
  const withoutComments = sql
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n");

  const createRe = /CREATE TABLE (\w+) \(([\s\S]*?)\n\)\s*ENGINE=/g;
  let match: RegExpExecArray | null;

  while ((match = createRe.exec(withoutComments)) !== null) {
    const [, table, body] = match;
    const columns: Column[] = [];

    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim().replace(/,$/, "");
      if (line === "") continue;
      if (/^(PRIMARY KEY|UNIQUE KEY|KEY|CONSTRAINT|FULLTEXT|INDEX)\b/i.test(line)) continue;

      const columnMatch = /^(\w+)\s+(.+)$/.exec(line);
      if (!columnMatch) continue;

      const [, name, rest] = columnMatch;
      const varchar = /^(?:VAR)?CHAR\((\d+)\)/i.exec(rest);
      const enumMatch = /^ENUM\(([^)]*)\)/i.exec(rest);

      columns.push({
        name,
        type: rest,
        notNull: /\bNOT NULL\b/i.test(rest),
        hasDefault: /\bDEFAULT\b/i.test(rest) || /\bAUTO_INCREMENT\b/i.test(rest),
        width: varchar ? Number(varchar[1]) : null,
        enumValues: enumMatch
          ? enumMatch[1].split(",").map((value) => value.trim().replace(/^'|'$/g, ""))
          : null,
      });
    }

    tables.set(table, columns);
  }

  return tables;
}

const TABLES = parseTables(readMigration("0016_content.sql"));

/**
 * Migration 0018's `ALTER TABLE`s, folded in.
 *
 * Only the added columns are read, not re-parsed from scratch: the point is
 * that a later migration's columns are visible here too, so a third body
 * column added in 0019 and left out of the specs still fails this file.
 */
for (const statement of readMigration("0018_content_body.sql").split(";")) {
  const alter = /ALTER TABLE (\w+)([\s\S]*)/.exec(
    statement.replace(/^\s*--.*$/gm, "").trim(),
  );
  if (!alter) continue;

  const columns = TABLES.get(alter[1]);
  if (!columns) continue;

  for (const add of alter[2].matchAll(/ADD COLUMN (\w+)\s+([A-Z]+(?:\(\d+\))?)\s+(NOT NULL|NULL)/g)) {
    columns.push({
      name: add[1],
      type: `${add[2]} ${add[3]}`,
      notNull: add[3] === "NOT NULL",
      hasDefault: false,
      width: null,
      enumValues: null,
    });
  }
}

function columnsOf(table: string): Column[] {
  const columns = TABLES.get(table);
  if (!columns) throw new Error(`migration 0016 declares no table ${table}`);
  return columns;
}

function columnByName(table: string, name: string): Column | undefined {
  return columnsOf(table).find((column) => column.name === name);
}

/* -------------------------------------------------------------------------- */

describe("the migrations parsed", () => {
  it("found the tables and read their shapes", () => {
    // A parser that silently matched nothing would make every test below pass
    // for the wrong reason, which is the standard failure of a test that reads
    // its expectations from a file.
    expect(TABLES.size).toBe(18);
    expect(columnByName("content_items", "title_en")).toMatchObject({
      notNull: true,
      width: 300,
    });
    expect(columnByName("content_events", "event_type")?.enumValues).toEqual([
      "seminar",
      "training",
      "agm",
      "delegation",
      "exhibition",
    ]);
    expect(columnByName("content_press_releases", "body_en")).toMatchObject({
      notNull: false,
    });
  });
});

describe.each(CONTENT_KINDS)("%s", (kind) => {
  const form = CONTENT_FORMS[kind];

  it("has a satellite table", () => {
    expect(() => columnsOf(form.table)).not.toThrow();
  });

  it("names only columns that exist", () => {
    for (const field of form.fields) {
      expect(columnByName(form.table, field.name), `${form.table}.${field.name}`).toBeDefined();
    }
  });

  /**
   * The failure this file exists for.
   *
   * A `NOT NULL` column with no default and no spec field cannot be filled by
   * the editor, so every save of this type fails on the insert — not at
   * validation, where the editor would be told something useful, but with a
   * database error after they pressed Save.
   */
  it("offers a field for every column that must be filled", () => {
    const names = new Set(form.fields.map((field) => field.name));

    for (const column of columnsOf(form.table)) {
      if (column.name === "content_item_id") continue;
      if (!column.notNull || column.hasDefault) continue;

      expect(names.has(column.name), `${form.table}.${column.name} has no editor field`).toBe(true);
      const field = form.fields.find((candidate) => candidate.name === column.name);
      expect(field?.required, `${form.table}.${column.name} must be required`).toBe(true);
    }
  });

  it("does not mark a nullable column required", () => {
    for (const field of form.fields) {
      if (!field.required) continue;
      const column = columnByName(form.table, field.name);
      // A field required by the form but nullable in the column is not a bug
      // in the schema — it is an editorial rule the column does not enforce,
      // which is exactly where the two are allowed to differ. The reverse
      // never is, and that is the test above. This one only pins the cases we
      // have, so a new one has to be deliberate.
      if (column && !column.notNull) {
        expect(
          ["poster_id"],
          `${form.table}.${field.name} is required in the form but nullable in the column`,
        ).toContain(field.name);
      }
    }
  });

  it("offers exactly the enum's values on every select", () => {
    for (const field of form.fields) {
      if (field.kind !== "select") continue;
      const column = columnByName(form.table, field.name);
      expect(column?.enumValues, `${form.table}.${field.name}`).toEqual(
        field.options?.map((option) => option.value),
      );
    }
  });

  it("limits text to the column's width", () => {
    for (const field of allFields(kind)) {
      if (field.kind !== "text" && field.kind !== "textarea" && field.kind !== "slug") continue;

      const table = form.fields.includes(field) ? form.table : "content_items";
      const column = columnByName(table, field.name);
      if (!column?.width) continue;

      // Equal, not merely "no greater than". A limit below the column's width
      // is a rule somebody meant; a limit above it is silent truncation of
      // editorial copy, and MySQL only raises it under strict mode.
      expect(field.max, `${table}.${field.name}`).toBe(column.width);
    }
  });

  it("keeps its satellite names clear of the parent's", () => {
    const parents = new Set(parentFields(kind).map((field) => field.name));
    for (const field of form.fields) {
      // The editor submits one flat form, so a satellite column named `slug`
      // would be indistinguishable from the parent's.
      expect(parents.has(field.name), `${field.name} collides with a parent field`).toBe(false);
    }
  });

  it("gives every select at least two options and every field a label", () => {
    for (const field of allFields(kind)) {
      expect(field.label.length, field.name).toBeGreaterThan(0);
      if (field.kind === "select") {
        expect(field.options?.length ?? 0, field.name).toBeGreaterThan(1);
      }
    }
  });
});

describe("the parent fields", () => {
  it("name only columns of content_items", () => {
    for (const kind of CONTENT_KINDS) {
      for (const field of parentFields(kind)) {
        expect(columnByName("content_items", field.name), field.name).toBeDefined();
      }
    }
  });

  it("appear on every type, so the editor is one screen", () => {
    const always: (keyof FieldSpec | string)[] = [
      "title_en",
      "title_ur",
      "slug",
      "department_code",
      "review_by",
      "scheduled_unpublish_at",
    ];

    for (const kind of CONTENT_KINDS) {
      const names = parentFields(kind).map((field) => field.name);
      for (const name of always) expect(names, kind).toContain(name);
    }
  });

  it("offers sort_order only where a public read orders by it", () => {
    // Offering it elsewhere invites an editor to set it and then wonder why
    // the newsroom ignored them.
    const ordered = CONTENT_KINDS.filter((kind) => CONTENT_FORMS[kind].hasSortOrder);
    expect([...ordered].sort()).toEqual([
      "committee",
      "economic_indicator",
      "key_figure",
      "notice",
      "partner",
      "policy_position",
      "service_tile",
      "testimonial",
    ]);
  });
});
