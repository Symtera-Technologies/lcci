import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/server/auth/dal";
import { editableDepartments, listTopics, loadForEditing } from "@/content/preview";
import { listMedia } from "@/content/media";
import { CONTENT_FORMS, isContentKind, parentFields } from "@/content/fields";
import { ContentEditorForm } from "@/components/admin/content-editor-form";
import { ContentStatusPill, visibilityNote } from "@/components/admin/content-status-pill";
import { ContentDeleteForm } from "@/components/admin/content-delete-form";
import { formatDate, formatDateShort } from "@/lib/format";
import { deleteContent, saveContent } from "../actions";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ type: string; id: string }>;
}): Promise<Metadata> {
  const { type } = await params;
  return {
    title: isContentKind(type) ? CONTENT_FORMS[type].singular : "Content",
    robots: { index: false, follow: false },
  };
}

/**
 * One content item, open for editing.
 *
 * **Addressed by id, not by slug.** The slug is editable and is the public
 * address; keying the editor on it would mean that correcting a typo in a URL
 * changes the URL of the screen you are typing into, and that two editors
 * renaming at once could end up on each other's rows.
 *
 * **What is missing here is the workflow, and that is deliberate.** There is
 * no Publish button: the status moves through B3's transitions, with their own
 * permissions and their own separation between the person who writes and the
 * person who approves. So this screen saves copy — including, for now, the
 * copy of something already published, which the banner says out loud rather
 * than leaving an editor to discover.
 */
export default async function EditContentPage({
  params,
  searchParams,
}: {
  params: Promise<{ type: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { type, id: rawId } = await params;
  if (!isContentKind(type)) notFound();

  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) notFound();

  const actor = await requireStaffPage("content.read_draft");
  const query = await searchParams;
  const form = CONTENT_FORMS[type];

  const loaded = await loadForEditing(actor, type, id);
  // Null for "no such row" and for "not your department" alike. A 403 on one
  // and a 404 on the other would let a department editor enumerate another
  // department's unpublished slugs one guess at a time.
  if (!loaded) notFound();

  const [departments, media, topics] = await Promise.all([
    editableDepartments(actor),
    listMedia(actor, { limit: 200 }),
    form.hasTopics ? listTopics() : Promise.resolve([]),
  ]);

  const { item, values, topics: selected } = loaded;
  const note = visibilityNote(item);
  const canDelete =
    actor.permissions.has("content.edit") &&
    item.status === "draft" &&
    item.publishedAt === null;

  return (
    <main className="mx-auto max-w-[80rem] px-5 py-8 sm:px-8">
      <nav aria-label="Breadcrumb" className="flex flex-wrap gap-x-2 text-[0.875rem]">
        <Link
          href="/admin/content"
          className="text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600"
        >
          Content
        </Link>
        <span aria-hidden className="text-ink-400">
          /
        </span>
        <Link
          href={`/admin/content/${type}`}
          className="text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600"
        >
          {form.plural}
        </Link>
      </nav>

      <header className="mt-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[1.75rem] leading-tight font-semibold text-ink-950">
            {item.titleEn}
          </h1>
          <ContentStatusPill status={item.status} />
        </div>

        <p className="mt-1 text-[0.875rem] text-ink-600">
          {form.singular} · {item.departmentName} · last changed{" "}
          {formatDateShort(item.updatedAt.toISOString())}
          {item.publishedAt && <> · published {formatDate(item.publishedAt.toISOString())}</>}
          {note && <> · {note}</>}
        </p>
      </header>

      {query.created !== undefined && (
        <p className="mt-6 rounded-lg border border-success-700/40 bg-success-50 px-4 py-3 text-[0.9375rem] text-success-900">
          Created as a draft. It is not on the public site.
        </p>
      )}

      {item.status === "published" && (
        /*
          Said on the screen rather than left to be found out. Until B3's
          workflow lands, `content.edit` saves straight over live copy — which
          is the honest state of the system, and an editor correcting a
          published release should know their next keystroke is public.
        */
        <p className="mt-6 rounded-lg border border-urgent-600/40 bg-urgent-50 px-4 py-3 text-[0.9375rem] text-urgent-800">
          This item is published. Saving changes what visitors see as soon as
          the pages rebuild — there is no review step yet.
        </p>
      )}

      <ContentEditorForm
        chrome={{
          kind: type,
          singular: form.singular,
          plural: form.plural,
          hasTopics: form.hasTopics,
        }}
        fields={form.fields}
        parentFields={parentFields(type)}
        values={values}
        departments={departments}
        media={media.map((asset) => ({
          id: asset.id,
          label: `${asset.altEn} — ${asset.src}`,
        }))}
        topics={topics}
        selectedTopics={selected}
        item={{ id: item.id, version: item.version, status: item.status }}
        action={saveContent}
      />

      {canDelete && (
        <section aria-labelledby="delete-heading" className="mt-12 border-t border-stone-200 pt-6">
          <h2 id="delete-heading" className="text-[0.9375rem] font-semibold text-ink-950">
            Delete this draft
          </h2>
          <p className="mt-1 max-w-2xl text-[0.875rem] text-ink-600">
            Only possible because it has never been published, so no address
            anybody could have linked to disappears. The full record of what it
            said is kept in the audit log.
          </p>
          <ContentDeleteForm kind={type} id={item.id} action={deleteContent} />
        </section>
      )}
    </main>
  );
}
