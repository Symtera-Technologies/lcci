import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TOPIC_LABELS } from "@/components/ui/tag";

/**
 * The topic vocabulary exists in two places, so something has to make them
 * agree.
 *
 * `TopicSlug` in `src/content/types.ts` is a closed union, so a misspelled
 * slug in a component is a compile error — which is why `TOPIC_LABELS` in
 * `src/components/ui/tag.tsx` stays where it is rather than being read from
 * the database. But `content_topics` also holds the eight slugs, because the
 * admin's topic picker needs them as rows and B2 will join against them.
 *
 * A database label cannot be compile-checked, so this is the check. The
 * failure it prevents is quiet in exactly the way the undefined-Tailwind-token
 * failure was quiet: a topic tagged in the admin against a slug the union does
 * not have renders `TOPIC_LABELS[slug]` as `undefined`, which React prints as
 * nothing at all. An empty tag beside a headline, with no error anywhere.
 *
 * Read from the migration file rather than from a live database, so the check
 * runs in `npm test` on a machine with no MySQL. It is the DDL that is the
 * source of truth for the schema, and the DDL is what this reads.
 */

const MIGRATION = path.join(process.cwd(), "migrations", "0016_content.sql");

/** The slugs the migration seeds into `content_topics`. */
function seededTopicSlugs(): string[] {
  const sql = readFileSync(MIGRATION, "utf8");

  const start = sql.indexOf("INSERT IGNORE INTO content_topics");
  expect(
    start,
    "migration 0016 no longer seeds content_topics; this guard is examining nothing",
  ).toBeGreaterThan(-1);

  const end = sql.indexOf(";", start);
  expect(end).toBeGreaterThan(start);

  const block = sql.slice(start, end);
  // Each row opens `('slug', 'Label', 10)`, so the first literal after an
  // opening parenthesis is the slug.
  const matches = block.matchAll(/\(\s*'([^']+)'/g);
  return [...matches].map((match) => match[1]);
}

describe("the topic vocabulary", () => {
  it("is the same set in the migration and in TOPIC_LABELS", () => {
    const seeded = seededTopicSlugs();
    const labelled = Object.keys(TOPIC_LABELS);

    // A guard on the guard: if the parse above ever returns nothing, the
    // comparison below passes vacuously and this test becomes decoration.
    expect(seeded.length).toBe(8);

    expect([...seeded].sort()).toEqual([...labelled].sort());
  });

  it("gives every topic a non-empty label", () => {
    for (const [slug, label] of Object.entries(TOPIC_LABELS)) {
      expect(label, `topic "${slug}" has no label`).toBeTruthy();
    }
  });
});
