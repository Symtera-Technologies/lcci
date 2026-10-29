import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/server/auth/dal";
import { getMediaAsset, mediaUsage } from "@/content/media";
import { editableDepartments } from "@/content/preview";
import { CONTENT_FORMS, isContentKind } from "@/content/fields";
import { DescribeImageForm } from "@/components/admin/media-forms";
import { formatDateShort } from "@/lib/format";
import { describeImage } from "../actions";

export const metadata: Metadata = {
  title: "Image",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * One image, its description and everywhere it is used.
 *
 * The usage list is the reason this is a page rather than a row in a table.
 * Changing alt text is not a local act: the same photograph can be the hero of
 * one release and the sharing image of another, and an editor rewriting
 * "Delegation at the chamber" needs to see both before deciding whether the
 * new words still describe what is on each page. Without the list the safe
 * move is to leave every description alone, which is how bad alt text becomes
 * permanent.
 *
 * The path is shown and not editable. Repointing an entry at a different file
 * would keep the old description against the new photograph, which is the one
 * change that turns correct alt text into a lie.
 */
export default async function MediaAssetPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) notFound();

  const actor = await requireStaffPage("content.read_draft");
  const query = await searchParams;

  const asset = await getMediaAsset(actor, id);
  if (!asset) notFound();

  const [uses, departments] = await Promise.all([
    mediaUsage(actor, id),
    actor.permissions.has("content.media.manage")
      ? editableDepartments(actor)
      : Promise.resolve([]),
  ]);

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
          href="/admin/media"
          className="text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600"
        >
          Images
        </Link>
      </nav>

      <h1 className="mt-2 text-[1.75rem] leading-tight font-semibold text-ink-950">
        {asset.altEn}
      </h1>
      <p className="mt-1 font-mono text-[0.8125rem] break-all text-ink-600">{asset.src}</p>

      {query.created !== undefined && (
        <p className="mt-6 rounded-lg border border-success-700/40 bg-success-50 px-4 py-3 text-[0.9375rem] text-success-900">
          Added to the library. It can now be picked on any content screen.
        </p>
      )}

      <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section aria-labelledby="describe-heading" className="min-w-0 order-2 lg:order-1">
          <h2 id="describe-heading" className="text-[1.0625rem] font-semibold text-ink-950">
            Description
          </h2>

          {actor.permissions.has("content.media.manage") ? (
            <DescribeImageForm
              id={asset.id}
              values={{
                altEn: asset.altEn,
                altUr: asset.altUr,
                caption: asset.caption,
                width: asset.width,
                height: asset.height,
                departmentCode: asset.departmentCode,
              }}
              departments={departments}
              action={describeImage}
            />
          ) : (
            <dl className="mt-4 space-y-3 text-[0.9375rem]">
              <Row term="Read instead of the image">{asset.altEn}</Row>
              {asset.altUr && <Row term="Urdu">{asset.altUr}</Row>}
              {asset.caption && <Row term="Caption">{asset.caption}</Row>}
              <Row term="Size">
                {asset.width} × {asset.height}
              </Row>
              <Row term="Last changed">{formatDateShort(asset.updatedAt.toISOString())}</Row>
            </dl>
          )}
        </section>

        <aside className="min-w-0 order-1 lg:order-2">
          <div className="overflow-hidden rounded-xl border border-stone-200 bg-stone-100">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={asset.src}
              // Empty: the description is the heading of this page, read a
              // moment earlier. The alternative is hearing the same sentence
              // twice in a row.
              alt=""
              width={asset.width}
              height={asset.height}
              className="h-auto w-full"
            />
          </div>

          <h2 className="mt-6 text-[1.0625rem] font-semibold text-ink-950">Used on</h2>
          {uses.length === 0 ? (
            <p className="mt-2 text-[0.875rem] text-ink-600">
              Nothing uses this image yet. Changing the description affects no
              page.
            </p>
          ) : (
            <>
              <p className="mt-2 text-[0.875rem] text-ink-600">
                A new description has to still describe the picture on{" "}
                {uses.length === 1 ? "this page" : "all of these"}.
              </p>
              <ul className="mt-3 space-y-2.5">
                {uses.map((use) => (
                  <li key={`${use.contentItemId}-${use.role}`} className="text-[0.875rem]">
                    <Link
                      href={
                        isContentKind(use.contentType)
                          ? `/admin/content/${use.contentType}/${use.contentItemId}`
                          : "/admin/content"
                      }
                      className="text-ink-900 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600"
                    >
                      {use.titleEn}
                    </Link>
                    <span className="block text-[0.8125rem] text-ink-600">
                      {use.role} ·{" "}
                      {isContentKind(use.contentType)
                        ? CONTENT_FORMS[use.contentType].singular.toLowerCase()
                        : use.contentType}{" "}
                      · {use.status === "in_review" ? "in review" : use.status}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>
      </div>
    </main>
  );
}

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[0.8125rem] font-medium text-ink-600">{term}</dt>
      <dd className="mt-0.5 text-ink-900">{children}</dd>
    </div>
  );
}
