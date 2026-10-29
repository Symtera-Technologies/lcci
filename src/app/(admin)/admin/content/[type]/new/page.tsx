import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/server/auth/dal";
import { editableDepartments, listTopics } from "@/content/preview";
import { listMedia } from "@/content/media";
import { CONTENT_FORMS, isContentKind, parentFields } from "@/content/fields";
import { ContentEditorForm } from "@/components/admin/content-editor-form";
import { saveContent } from "../actions";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ type: string }>;
}): Promise<Metadata> {
  const { type } = await params;
  return {
    title: isContentKind(type) ? `New ${CONTENT_FORMS[type].singular.toLowerCase()}` : "Content",
    robots: { index: false, follow: false },
  };
}

/**
 * A new content item.
 *
 * `content.create`, not `content.read_draft`: the list is readable by anyone
 * who may see drafts, but creating is its own grant. The row that comes out of
 * this screen is a draft whatever is typed into it, because nothing on the
 * form can set a status — see `createContentItem`.
 */
export default async function NewContentPage({
  params,
}: {
  params: Promise<{ type: string }>;
}) {
  const { type } = await params;
  if (!isContentKind(type)) notFound();

  const actor = await requireStaffPage("content.create");
  const form = CONTENT_FORMS[type];

  const [departments, media, topics] = await Promise.all([
    editableDepartments(actor),
    listMedia(actor, { limit: 200 }),
    form.hasTopics ? listTopics() : Promise.resolve([]),
  ]);

  // Only the department where there is no choice to make. Every other default
  // would be a value the editor did not enter arriving in the audit log as
  // though they had.
  const values: Record<string, string | boolean> = {
    department_code: departments.length === 1 ? departments[0].code : "",
    sort_order: "100",
  };

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

      <h1 className="mt-2 text-[1.75rem] leading-tight font-semibold text-ink-950">
        New {form.singular.toLowerCase()}
      </h1>

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
          // The alt text is the label, because it is the one description of an
          // image that is guaranteed to exist and to say what is in it. A list
          // of filenames would make the editor open each one to find out.
          label: `${asset.altEn} — ${asset.src}`,
        }))}
        topics={topics}
        selectedTopics={[]}
        item={null}
        action={saveContent}
      />
    </main>
  );
}
