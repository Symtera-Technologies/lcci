import type { Metadata } from "next";
import Link from "next/link";
import { requireStaffPage } from "@/server/auth/dal";
import { contentCounts } from "@/content/preview";
import { CONTENT_FORMS } from "@/content/fields";
import type { ContentKind } from "@/db/schema";

export const metadata: Metadata = {
  title: "Content",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * The content hub.
 *
 * Twelve content types is too many for a flat list, and the obvious grouping —
 * by content type — is the one that does not help: an editor does not think
 * "I need to edit a service tile", they think "the homepage is wrong". So the
 * groups below are the parts of the site, and each one names where its items
 * appear. A type whose rows are invisible until an editor finds the right
 * screen is a type nobody maintains, which is how the old site ended up with a
 * notice that had been up for months.
 *
 * The counts carry the same department predicate as the lists, so the number
 * here is the number of rows the editor will find when they open it.
 */

interface Group {
  readonly title: string;
  readonly blurb: string;
  readonly kinds: readonly ContentKind[];
}

const GROUPS: readonly Group[] = [
  {
    title: "Newsroom",
    blurb: "What the chamber has said and done. Dated, and ordered by date.",
    kinds: ["press_release", "event", "video", "gallery_album"],
  },
  {
    title: "Advocacy",
    blurb: "The positions taken and the figures they are argued from.",
    kinds: ["policy_position", "economic_indicator"],
  },
  {
    title: "Homepage",
    blurb: "The bands a visitor sees first. Short, and ordered by hand.",
    kinds: ["notice", "key_figure", "service_tile", "testimonial"],
  },
  {
    title: "The chamber",
    blurb: "Who does the work, and who it is done with.",
    kinds: ["committee", "partner"],
  },
];

export default async function ContentHubPage() {
  const actor = await requireStaffPage("content.read_draft");
  const counts = await contentCounts(actor);

  const waiting = Object.values(counts).reduce((total, row) => total + row.in_review, 0);

  return (
    <main className="mx-auto max-w-[72rem] px-5 py-8 sm:px-8">
      <header>
        <h1 className="text-[1.75rem] leading-tight font-semibold text-ink-950">Content</h1>
        <p className="mt-1 max-w-3xl text-[0.9375rem] text-ink-700">
          Everything on the public site. Nothing here is live until it is
          published, and a draft is never visible to a visitor whatever its
          address.
          {actor.departmentScopes.length > 0 && (
            <>
              {" "}
              You are seeing the{" "}
              {actor.departmentScopes.length === 1 ? "department" : "departments"} you edit
              for.
            </>
          )}
        </p>
      </header>

      <p className="mt-4 text-[0.9375rem]">
        <Link
          href="/admin/media"
          className="text-brand-800 underline decoration-brand-700/40 underline-offset-4 hover:decoration-brand-700"
        >
          Images
        </Link>
        <span className="text-ink-600">
          {" "}
          — every photograph on the site and the description read instead of it.
        </span>
      </p>

      {waiting > 0 && (
        <p className="mt-6 rounded-lg border border-brand-600/40 bg-brand-50 px-4 py-3 text-[0.9375rem] text-brand-800">
          {waiting === 1 ? "One item is" : `${waiting} items are`} waiting for review.
        </p>
      )}

      <div className="mt-8 space-y-10">
        {GROUPS.map((group) => (
          <section key={group.title} aria-labelledby={`group-${group.title}`}>
            <h2
              id={`group-${group.title}`}
              className="text-[1.0625rem] font-semibold text-ink-950"
            >
              {group.title}
            </h2>
            <p className="mt-0.5 text-[0.875rem] text-ink-600">{group.blurb}</p>

            <ul className="mt-4 grid gap-3 sm:grid-cols-2">
              {group.kinds.map((kind) => (
                <TypeCard key={kind} kind={kind} counts={counts[kind]} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </main>
  );
}

function TypeCard({
  kind,
  counts,
}: {
  kind: ContentKind;
  counts: { draft: number; in_review: number; published: number; archived: number; total: number } | undefined;
}) {
  const form = CONTENT_FORMS[kind];
  const row = counts ?? { draft: 0, in_review: 0, published: 0, archived: 0, total: 0 };

  // Only the counts worth acting on. A card reading "0 drafts · 0 in review ·
  // 0 archived" is four numbers to read past before reaching the one that
  // matters.
  const notes: string[] = [];
  if (row.in_review > 0) notes.push(`${row.in_review} in review`);
  if (row.draft > 0) notes.push(`${row.draft} draft${row.draft === 1 ? "" : "s"}`);
  if (row.archived > 0) notes.push(`${row.archived} archived`);

  return (
    <li>
      <Link
        href={`/admin/content/${kind}`}
        className="group flex h-full flex-col rounded-xl border border-brand-700/20 bg-white px-4 py-3.5 transition-colors hover:border-brand-700/50 focus-visible:border-brand-700/50"
      >
        <span className="flex items-baseline justify-between gap-3">
          <span className="text-[0.9375rem] font-medium text-ink-950 group-hover:text-brand-800">
            {form.plural}
          </span>
          <span className="text-[0.875rem] tabular-nums text-ink-600">
            {row.published} live
          </span>
        </span>
        <span className="mt-1 text-[0.8125rem] text-ink-600">
          {notes.length > 0 ? notes.join(" · ") : `${row.total} in total`}
        </span>
      </Link>
    </li>
  );
}
