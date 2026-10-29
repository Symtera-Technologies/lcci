import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, sql } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { newUlid } from "@/server/crypto";
import { ConcurrencyError, ForbiddenError, type ActorContext } from "@/server/actor";
import type { PermissionCode } from "@/server/permissions";
import type { ContentKind } from "@/db/schema";
import {
  ContentInvalidError,
  createContentItem,
  deleteDraftContentItem,
  updateContentItem,
} from "@/content/admin";
import { databaseAvailable, resetTables, skipReason, teardown } from "./helpers";

/**
 * What the content write path must not do.
 *
 * Most of these are not "does saving work" — that is one test. The rest are
 * the ways a form-driven writer gets a schema wrong: a coercion that turns an
 * empty box into a number, a submitted key that reaches a column it should
 * never touch, a stale form that overwrites somebody else's work, a body that
 * keeps its `<script>` because the sanitiser was called on the render path
 * instead of the write path.
 *
 * `audit_log` is deliberately **not** reset between tests. It is hash-chained
 * against `audit_chain_head`, and deleting rows would leave the head pointing
 * at a hash that no longer exists — the suite would then be testing a database
 * it had itself corrupted. Each assertion reads the newest event for its own
 * entity instead.
 */

const available = await databaseAvailable();
if (!available) {
  console.warn(`[integration] skipping content admin tests: ${await skipReason()}`);
}

if (available) await runMigrations("integration-test");

afterAll(async () => {
  await teardown();
});

const TABLES = [
  "content_gallery_images",
  "content_gallery_albums",
  "content_videos",
  "content_testimonials",
  "content_partners",
  "content_committees",
  "content_service_tiles",
  "content_economic_indicators",
  "content_key_figures",
  "content_notices",
  "content_policy_positions",
  "content_events",
  "content_press_releases",
  "content_item_topics",
  "content_items",
  "media_assets",
];

beforeEach(async () => {
  if (!available) return;
  await resetTables(TABLES);
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function staffActor(
  permissions: readonly PermissionCode[],
  departmentScopes: readonly string[] = [],
): ActorContext {
  return {
    userId: null,
    userType: "staff",
    roleCode: "content_editor",
    roleCodes: ["content_editor"],
    permissions: new Set(permissions),
    departmentScopes,
    requestId: newUlid(),
    ipHash: null,
    userAgentHash: null,
    onBehalfOfUserId: null,
  };
}

const EDITOR = [
  "content.create",
  "content.edit",
  "content.read_draft",
] as const satisfies readonly PermissionCode[];

/** The smallest press release the schema will accept. */
function pressForm(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: "chamber-welcomes-tariff-review",
    title_en: "Chamber welcomes tariff review",
    department_code: "info",
    summary: "The chamber welcomed the review announced on Tuesday.",
    ...overrides,
  };
}

function eventForm(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: "export-documentation-clinic",
    title_en: "Export documentation clinic",
    department_code: "info",
    event_type: "training",
    starts_at: "2027-02-11T10:00",
    venue: "LCCI Auditorium",
    ...overrides,
  };
}

async function satelliteRow(table: string, itemId: number): Promise<Record<string, unknown>> {
  const result = await sql<Record<string, unknown>>`
    select * from ${sql.table(table)} where content_item_id = ${itemId}
  `.execute(getDb());
  const row = result.rows[0];
  if (!row) throw new Error(`no ${table} row for ${itemId}`);
  return row;
}

async function latestAudit(
  entityId: number,
): Promise<{ action: string; summary: string; before: unknown; after: unknown; context: unknown }> {
  const row = await getDb()
    .selectFrom("audit_log")
    .select(["action", "summary", "before_json", "after_json", "context_json"])
    .where("entity_type", "=", "content")
    .where("entity_id", "=", String(entityId))
    .orderBy("id", "desc")
    .executeTakeFirstOrThrow();

  // mysql2 returns JSON columns already parsed.
  return {
    action: row.action,
    summary: row.summary,
    before: row.before_json,
    after: row.after_json,
    context: row.context_json,
  };
}

async function parentRow(id: number) {
  return getDb()
    .selectFrom("content_items")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

/* -------------------------------------------------------------------------- */

describe.skipIf(!available)("createContentItem", () => {
  it("writes the parent and the satellite together, as a draft", async () => {
    const actor = staffActor(EDITOR);
    const saved = await createContentItem(actor, "press_release", pressForm());

    const parent = await parentRow(saved.id);
    expect(parent.content_type).toBe("press_release");
    expect(parent.slug).toBe("chamber-welcomes-tariff-review");
    expect(parent.department_code).toBe("info");
    expect(parent.version).toBe(1);

    const satellite = await satelliteRow("content_press_releases", saved.id);
    expect(satellite.summary).toBe("The chamber welcomed the review announced on Tuesday.");
  });

  /**
   * The single most important property of this module.
   *
   * `content.create` is granted to department editors, who have no publishing
   * right. If a submitted `status` reached the column, that grant would be
   * meaningless — any editor could put anything on the public site by adding
   * one hidden input. The write path walks the field *specs*, so a key that is
   * not in them is never looked at.
   */
  it("ignores submitted keys that are not fields, including status", async () => {
    const actor = staffActor(EDITOR);
    const saved = await createContentItem(
      actor,
      "press_release",
      pressForm({
        status: "published",
        published_at: "2020-01-01T00:00",
        published_by: 1,
        version: 99,
      }),
    );

    const parent = await parentRow(saved.id);
    expect(parent.status).toBe("draft");
    expect(parent.published_at).toBeNull();
    expect(parent.published_by).toBeNull();
    expect(parent.version).toBe(1);
  });

  it("sanitises a rich-text body on the way in, not on the way out", async () => {
    const actor = staffActor(EDITOR);
    const saved = await createContentItem(
      actor,
      "press_release",
      pressForm({
        body_en: '<p onclick="x()">Before</p><script>alert(1)</script><p>After</p>',
      }),
    );

    const satellite = await satelliteRow("content_press_releases", saved.id);
    // The stored bytes are the sanitised bytes: no render path can reintroduce
    // the script, and the value in the audit log is the value the public saw.
    expect(satellite.body_en).toBe("<p>Before</p><p>After</p>");
  });

  it("stores an emptied body as NULL rather than an empty paragraph", async () => {
    const actor = staffActor(EDITOR);
    const saved = await createContentItem(actor, "press_release", pressForm({ body_en: "<p></p>" }));

    const satellite = await satelliteRow("content_press_releases", saved.id);
    expect(satellite.body_en).toBeNull();
  });

  /**
   * `z.coerce.number()` reads `""` as 0.
   *
   * An event saved with the capacity box untouched would hold nought places,
   * and the booking screen would refuse every booking for a reason nobody
   * typed. This is the defect the `numeric()` preprocess exists to stop, and
   * it only shows up against a real column.
   */
  it("stores an empty optional number as NULL, not as zero", async () => {
    const actor = staffActor(EDITOR);
    const saved = await createContentItem(actor, "event", eventForm({ capacity: "" }));

    const satellite = await satelliteRow("content_events", saved.id);
    expect(satellite.capacity).toBeNull();
  });

  it("reads a datetime-local value as Pakistani time", async () => {
    const actor = staffActor(EDITOR);
    const saved = await createContentItem(actor, "event", eventForm({ starts_at: "2027-02-11T10:00" }));

    const satellite = await satelliteRow("content_events", saved.id);
    // Ten in the morning in Lahore is 05:00 UTC. Parsing it as UTC would print
    // the wrong time on the public page and start the clock five hours early.
    expect((satellite.starts_at as Date).toISOString()).toBe("2027-02-11T05:00:00.000Z");
  });

  it("stores an unticked checkbox as 0 rather than failing validation", async () => {
    const actor = staffActor(EDITOR);
    // An unticked box submits nothing at all, so the key is simply absent.
    const saved = await createContentItem(actor, "event", eventForm());

    const satellite = await satelliteRow("content_events", saved.id);
    expect(satellite.registration_open).toBe(0);
  });

  it("refuses a slug that is not a slug", async () => {
    const actor = staffActor(EDITOR);
    await expect(
      createContentItem(actor, "press_release", pressForm({ slug: "Tariff Review 2027" })),
    ).rejects.toMatchObject({
      name: "ContentInvalidError",
      fieldErrors: { slug: expect.stringContaining("Lowercase") },
    });
  });

  it("reports a duplicate slug as a field error on the slug", async () => {
    const actor = staffActor(EDITOR);
    await createContentItem(actor, "press_release", pressForm());

    await expect(
      createContentItem(actor, "press_release", pressForm({ title_en: "A different headline" })),
    ).rejects.toMatchObject({
      name: "ContentInvalidError",
      fieldErrors: { slug: expect.stringContaining("already uses") },
    });
  });

  it("allows the same slug on two different content types", async () => {
    const actor = staffActor(EDITOR);
    // `uq_content_slug` is (content_type, slug): an event and a press release
    // about the same thing live at different paths and do not collide.
    await createContentItem(actor, "press_release", pressForm({ slug: "annual-dinner-2027" }));
    await expect(
      createContentItem(actor, "event", eventForm({ slug: "annual-dinner-2027" })),
    ).resolves.toMatchObject({ slug: "annual-dinner-2027" });
  });

  it("names every missing required field at once", async () => {
    const actor = staffActor(EDITOR);
    await expect(
      createContentItem(actor, "event", {
        slug: "incomplete",
        title_en: "Incomplete",
        department_code: "info",
      }),
    ).rejects.toMatchObject({
      name: "ContentInvalidError",
      fieldErrors: {
        event_type: expect.any(String),
        starts_at: expect.any(String),
        venue: expect.any(String),
      },
    });
  });

  it("refuses a department the actor is not scoped to", async () => {
    const actor = staffActor(EDITOR, ["research"]);
    await expect(
      createContentItem(actor, "press_release", pressForm({ department_code: "info" })),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("lets an unscoped actor file under any active department", async () => {
    const actor = staffActor(EDITOR);
    await expect(
      createContentItem(actor, "press_release", pressForm({ department_code: "research" })),
    ).resolves.toMatchObject({ version: 1 });
  });

  it("refuses the permission it does not hold", async () => {
    const actor = staffActor(["content.edit"]);
    await expect(createContentItem(actor, "press_release", pressForm())).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("writes the topic tags it was given and ignores duplicates", async () => {
    const actor = staffActor(EDITOR);
    const saved = await createContentItem(
      actor,
      "press_release",
      pressForm({ topics: ["energy", "taxation-budget", "energy"] }),
    );

    const rows = await getDb()
      .selectFrom("content_item_topics")
      .select("topic_slug")
      .where("content_item_id", "=", saved.id)
      .execute();

    expect(rows.map((row) => row.topic_slug).sort()).toEqual(["energy", "taxation-budget"]);
  });

  it("reports an unknown topic as a field error rather than a server fault", async () => {
    const actor = staffActor(EDITOR);
    await expect(
      createContentItem(actor, "press_release", pressForm({ topics: ["not-a-topic"] })),
    ).rejects.toMatchObject({
      name: "ContentInvalidError",
      fieldErrors: { topics: expect.any(String) },
    });
  });

  it("records the creation in the audit log with a body digest, not the body", async () => {
    const actor = staffActor(EDITOR);
    const body = `<p>${"word ".repeat(400)}</p>`;
    const saved = await createContentItem(actor, "press_release", pressForm({ body_en: body }));

    const event = await latestAudit(saved.id);
    expect(event.action).toBe("content.created");
    expect(event.summary).toContain("Chamber welcomes tariff review");

    const after = event.after as Record<string, unknown>;
    // Two kilobytes of editorial copy per save, on an append-only table, is
    // how an audit log becomes too expensive to write and too long to read.
    expect(after.body_en).toMatchObject({ chars: body.length, sha256: expect.any(String) });
    expect(JSON.stringify(after)).not.toContain("word word");
  });
});

describe.skipIf(!available)("updateContentItem", () => {
  async function seeded(): Promise<{ actor: ActorContext; id: number }> {
    const actor = staffActor(EDITOR);
    const saved = await createContentItem(actor, "press_release", pressForm());
    return { actor, id: saved.id };
  }

  it("saves both halves and bumps the version", async () => {
    const { actor, id } = await seeded();

    const result = await updateContentItem(
      actor,
      "press_release",
      id,
      1,
      pressForm({ summary: "Revised summary.", spokesperson: "The President" }),
    );

    expect(result.version).toBe(2);

    const satellite = await satelliteRow("content_press_releases", id);
    expect(satellite.summary).toBe("Revised summary.");
    expect(satellite.spokesperson).toBe("The President");
    expect((await parentRow(id)).version).toBe(2);
  });

  /**
   * Last write wins is not an option here.
   *
   * Two editors with the same release open is the ordinary case in a
   * secretariat, and under Passenger there are several workers. Without the
   * guard the second save silently discards the first, and nobody finds out
   * until the published page is missing a paragraph somebody wrote.
   */
  it("refuses a save from a stale form and changes nothing", async () => {
    const { actor, id } = await seeded();

    await updateContentItem(actor, "press_release", id, 1, pressForm({ summary: "First edit." }));

    await expect(
      updateContentItem(actor, "press_release", id, 1, pressForm({ summary: "Second edit." })),
    ).rejects.toBeInstanceOf(ConcurrencyError);

    const satellite = await satelliteRow("content_press_releases", id);
    expect(satellite.summary).toBe("First edit.");
  });

  it("refuses to write a type's values into another type's table", async () => {
    const { actor, id } = await seeded();
    await expect(
      updateContentItem(actor, "event", id, 1, eventForm()),
    ).rejects.toBeInstanceOf(ConcurrencyError);
  });

  it("refuses to move a row out of the actor's own department", async () => {
    const unscoped = staffActor(EDITOR);
    const saved = await createContentItem(
      unscoped,
      "press_release",
      pressForm({ department_code: "info" }),
    );

    const scoped = staffActor(EDITOR, ["research"]);
    await expect(
      updateContentItem(
        scoped,
        "press_release",
        saved.id,
        1,
        pressForm({ department_code: "research" }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("records only the fields that changed", async () => {
    const { actor, id } = await seeded();

    await updateContentItem(
      actor,
      "press_release",
      id,
      1,
      pressForm({ title_en: "Chamber welcomes the tariff review" }),
    );

    const event = await latestAudit(id);
    expect(event.action).toBe("content.updated");
    expect(Object.keys(event.after as Record<string, unknown>)).toEqual(["title_en"]);
    expect(event.summary).toContain("Edited Headline");
  });

  /**
   * The noise test.
   *
   * mysql2 hands a `TINYINT(1)` back as `0`, a `DECIMAL` as a **string** and a
   * `DATETIME` as a `Date`, while the form submits a boolean, a number and a
   * local string. Comparing the two shapes directly reports every field as
   * changed on every save, and an audit log that says everything changed says
   * nothing.
   */
  it("reports no changes when nothing was changed", async () => {
    const actor = staffActor(EDITOR);
    const saved = await createContentItem(
      actor,
      "event",
      eventForm({
        capacity: "80",
        fee: "Free for members",
        registration_open: "on",
        ends_at: "2027-02-11T13:00",
      }),
    );

    await updateContentItem(
      actor,
      "event",
      saved.id,
      1,
      eventForm({
        capacity: "80",
        fee: "Free for members",
        registration_open: "on",
        ends_at: "2027-02-11T13:00",
      }),
    );

    const event = await latestAudit(saved.id);
    expect(event.after).toEqual({});
    expect(event.summary).toContain("no changes");
  });

  /**
   * The noise test's other half, and the one that was actually wrong.
   *
   * A press release has five optional fields nobody fills in on a first draft.
   * They are stored as NULL and submitted as `""`, and comparing those two as
   * they arrive reports five changes for a one-word fix to the summary — which
   * is what the audit log said before this was fixed: "Edited Headline (Urdu),
   * Check again by, Search-result title, Search-result description, Summary,
   * Quoted" for a corrected sentence.
   */
  it("does not report an untouched optional field as changed", async () => {
    const { actor, id } = await seeded();

    await updateContentItem(
      actor,
      "press_release",
      id,
      1,
      pressForm({ summary: "A corrected summary." }),
    );

    const event = await latestAudit(id);
    expect(Object.keys(event.after as Record<string, unknown>)).toEqual(["summary"]);
    expect(event.summary).toBe(
      'Edited Summary on press release "Chamber welcomes tariff review"',
    );
  });

  it("says whether the edit changed a page the public could already see", async () => {
    const { actor, id } = await seeded();

    await getDb()
      .updateTable("content_items")
      .set({ status: "published", published_at: new Date(Date.now() - 86_400_000) })
      .where("id", "=", id)
      .execute();

    await updateContentItem(actor, "press_release", id, 1, pressForm({ summary: "Live edit." }));

    expect((await latestAudit(id)).context).toMatchObject({ editedWhilePublished: true });
  });

  it("replaces the topic set rather than adding to it", async () => {
    const actor = staffActor(EDITOR);
    const saved = await createContentItem(
      actor,
      "press_release",
      pressForm({ topics: ["energy", "taxation-budget"] }),
    );

    await updateContentItem(
      actor,
      "press_release",
      saved.id,
      1,
      pressForm({ topics: ["taxation-budget"] }),
    );

    const rows = await getDb()
      .selectFrom("content_item_topics")
      .select("topic_slug")
      .where("content_item_id", "=", saved.id)
      .execute();

    expect(rows.map((row) => row.topic_slug)).toEqual(["taxation-budget"]);
  });

  it("clears an optional field that was emptied", async () => {
    const actor = staffActor(EDITOR);
    const saved = await createContentItem(
      actor,
      "press_release",
      pressForm({ spokesperson: "The President" }),
    );

    await updateContentItem(actor, "press_release", saved.id, 1, pressForm({ spokesperson: "" }));

    expect((await satelliteRow("content_press_releases", saved.id)).spokesperson).toBeNull();
  });
});

describe.skipIf(!available)("deleteDraftContentItem", () => {
  it("deletes a draft and takes its satellite and topics with it", async () => {
    const actor = staffActor(EDITOR);
    const saved = await createContentItem(
      actor,
      "press_release",
      pressForm({ topics: ["energy"] }),
    );

    await deleteDraftContentItem(actor, "press_release", saved.id);

    expect(
      await getDb()
        .selectFrom("content_items")
        .select("id")
        .where("id", "=", saved.id)
        .executeTakeFirst(),
    ).toBeUndefined();

    const satellites = await sql<{ n: number }>`
      select count(*) as n from content_press_releases where content_item_id = ${saved.id}
    `.execute(getDb());
    expect(Number(satellites.rows[0]?.n)).toBe(0);
  });

  /**
   * Archiving must not manufacture 404s.
   *
   * Roughly 890 legacy press URLs are being 301'd into this space, so an
   * archived release still resolves at its address. Deleting one would turn a
   * redirect chain into a dead link, which is why deletion stops at the draft
   * boundary.
   */
  it("refuses to delete anything that has ever been published", async () => {
    const actor = staffActor(EDITOR);
    const saved = await createContentItem(actor, "press_release", pressForm());

    await getDb()
      .updateTable("content_items")
      .set({ status: "archived", published_at: new Date(Date.now() - 86_400_000) })
      .where("id", "=", saved.id)
      .execute();

    await expect(
      deleteDraftContentItem(actor, "press_release", saved.id),
    ).rejects.toBeInstanceOf(ContentInvalidError);

    expect(await parentRow(saved.id)).toBeTruthy();
  });

  it("keeps the whole row in the audit log, body included", async () => {
    const actor = staffActor(EDITOR);
    const saved = await createContentItem(
      actor,
      "press_release",
      pressForm({ body_en: "<p>Unpublished draft text.</p>" }),
    );

    await deleteDraftContentItem(actor, "press_release", saved.id);

    const event = await latestAudit(saved.id);
    expect(event.action).toBe("content.deleted");
    // After the delete the audit log is the only record this existed, so here
    // — and only here — the full text is kept.
    expect(JSON.stringify(event.before)).toContain("Unpublished draft text.");
  });
});

/* -------------------------------------------------------------------------- */

describe.skipIf(!available)("every content type", () => {
  /**
   * One round trip per type, driven by the field specs.
   *
   * Twelve types share one write path, so a column renamed in a migration and
   * not in `CONTENT_FORMS` fails here rather than when an editor opens that
   * one screen months later. The forms below are the minimum each type's NOT
   * NULL columns require.
   */
  const MINIMAL: Record<ContentKind, Record<string, unknown>> = {
    press_release: { summary: "A summary." },
    event: { event_type: "seminar", starts_at: "2027-03-01T09:30", venue: "LCCI" },
    policy_position: {
      issue: "An issue.",
      chamber_ask: "An ask.",
      position_status: "raised",
    },
    notice: {
      message_en: "A notice.",
      level: "info",
      starts_at: "2027-03-01T00:00",
      ends_at: "2027-03-31T00:00",
    },
    key_figure: { figure_value: "1200", verified_at: "2027-01-31" },
    economic_indicator: {
      display_value: "11.0%",
      good_when: "down",
      source: "PBS",
      measured_at: "2027-01-31",
    },
    service_tile: { description: "A service.", href: "/membership/renew", icon: "renew" },
    committee: { mandate: "A mandate.", member_count: "14" },
    partner: { tier: "gold" },
    testimonial: {
      quote: "A quote.",
      author_name: "A name",
      author_role: "A role",
      company: "A firm",
    },
    video: { youtube_id: "abc123", orientation: "landscape", poster_id: "1" },
    gallery_album: { description: "An album.", occurred_at: "2027-02-20T18:00" },
  };

  it.each(Object.keys(MINIMAL) as ContentKind[])("round-trips a %s", async (kind) => {
    const actor = staffActor(EDITOR);

    // `content_videos.poster_id` is NOT NULL and a foreign key, so the video
    // case needs one real media row to point at.
    if (kind === "video") {
      await getDb()
        .insertInto("media_assets")
        .values({
          src: "/photos/poster.jpg",
          alt_en: "A poster frame",
          width: 1600,
          height: 900,
        })
        .execute();
    }

    const saved = await createContentItem(actor, kind, {
      slug: `a-${kind.replace(/_/g, "-")}`,
      title_en: `A ${kind}`,
      department_code: "info",
      ...MINIMAL[kind],
    });

    expect(saved.id).toBeGreaterThan(0);
    expect((await parentRow(saved.id)).status).toBe("draft");

    // And it saves again, which exercises the UPDATE column list too.
    await expect(
      updateContentItem(actor, kind, saved.id, 1, {
        slug: `a-${kind.replace(/_/g, "-")}`,
        title_en: `A revised ${kind}`,
        department_code: "info",
        ...MINIMAL[kind],
      }),
    ).resolves.toMatchObject({ version: 2 });
  });
});
