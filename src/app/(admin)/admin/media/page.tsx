import type { Metadata } from "next";
import Link from "next/link";
import { requireStaffPage } from "@/server/auth/dal";
import { countMedia, listMedia } from "@/content/media";
import { editableDepartments } from "@/content/preview";
import { RegisterImageForm } from "@/components/admin/media-forms";
import { registerImage } from "./actions";

export const metadata: Metadata = {
  title: "Images",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

const PAGE_SIZE = 36;

/**
 * The media library.
 *
 * The description is the label on every tile, not the filename. That is the
 * point of the screen: an editor picking a photograph for a press release is
 * choosing from descriptions, and a grid of `IMG_4471.jpg` would have them
 * open each one to find out what it is. It also means a description that was
 * written carelessly is visible as carelessness, next to the picture.
 *
 * **Plain `<img>`, not `next/image`.** `images.unoptimized` is prescribed for
 * this deployment, under which `next/image` emits a plain `<img>` and does
 * nothing — and with the optimiser on it would want build-time dimensions for
 * paths that only exist in the database. The tiles are small and already on
 * the same origin.
 *
 * **No upload here.** Every row names a file a deploy has already put on the
 * site; `src/content/media.ts` says why, and it is a real limitation rather
 * than an oversight.
 */
export default async function MediaLibraryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireStaffPage("content.read_draft");
  const query = await searchParams;

  const search = one(query.q);
  const page = Math.max(1, positiveInt(query.page) ?? 1);
  const adding = query.add !== undefined;

  const [assets, total, departments] = await Promise.all([
    listMedia(actor, { search, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countMedia(actor, { search }),
    actor.permissions.has("content.media.manage")
      ? editableDepartments(actor)
      : Promise.resolve([]),
  ]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <main className="mx-auto max-w-[80rem] px-5 py-8 sm:px-8">
      <nav aria-label="Breadcrumb" className="text-[0.875rem]">
        <Link
          href="/admin/content"
          className="text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600"
        >
          Content
        </Link>
      </nav>

      <header className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[1.75rem] leading-tight font-semibold text-ink-950">Images</h1>
          <p className="mt-1 max-w-3xl text-[0.9375rem] text-ink-700">
            Every photograph on the site, with the description a screen reader
            reads instead of it. No image reaches a page except through one of
            these entries, which is how the description cannot be skipped.
          </p>
        </div>

        {actor.permissions.has("content.media.manage") && !adding && (
          <Link
            href="/admin/media?add=1"
            className="rounded-lg bg-brand-800 px-4 py-2 text-[0.875rem] font-medium text-white hover:bg-brand-900"
          >
            Add an image
          </Link>
        )}
      </header>

      {adding && actor.permissions.has("content.media.manage") && (
        <section
          aria-labelledby="add-heading"
          className="mt-8 rounded-xl border border-brand-700/25 bg-white px-5 py-5"
        >
          <h2 id="add-heading" className="text-[1.0625rem] font-semibold text-ink-950">
            Add an image
          </h2>
          <p className="mt-1 max-w-2xl text-[0.875rem] text-ink-600">
            For a file that is already on the site — one a developer has
            deployed under <code className="font-mono text-[0.8125rem]">/photos/</code>.
            Uploading from here needs somewhere for the bytes to live that
            survives a release, which is not decided yet.
          </p>
          <RegisterImageForm departments={departments} action={registerImage} />
        </section>
      )}

      <form method="get" action="/admin/media" className="mt-8 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[0.8125rem] font-medium text-ink-700">
            Search descriptions and paths
          </span>
          <input
            type="search"
            name="q"
            defaultValue={search ?? ""}
            className="w-80 rounded-lg border border-ink-300 bg-white px-3 py-2 text-[0.9375rem] text-ink-950 focus-visible:border-brand-700"
          />
        </label>
        <button
          type="submit"
          className="rounded-lg border border-ink-300 bg-white px-4 py-2 text-[0.875rem] font-medium text-ink-800 hover:border-ink-500"
        >
          Search
        </button>
        {search && (
          <Link
            href="/admin/media"
            className="text-[0.875rem] text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600"
          >
            Clear
          </Link>
        )}
        <p className="ml-auto text-[0.875rem] text-ink-600">
          {total} {total === 1 ? "image" : "images"}
        </p>
      </form>

      {assets.length === 0 ? (
        <p className="mt-8 rounded-lg border border-stone-200 bg-white px-4 py-6 text-center text-[0.9375rem] text-ink-600">
          {search ? "Nothing matches that." : "The library is empty."}
        </p>
      ) : (
        <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {assets.map((asset) => (
            <li key={asset.id}>
              <Link
                href={`/admin/media/${asset.id}`}
                className="group flex h-full flex-col overflow-hidden rounded-xl border border-brand-700/20 bg-white transition-colors hover:border-brand-700/50"
              >
                <span className="block aspect-[3/2] overflow-hidden bg-stone-100">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={asset.src}
                    // Empty, and deliberately so: the description is printed
                    // immediately beneath as text. Repeating it here would
                    // have a screen reader read the same sentence twice.
                    alt=""
                    width={asset.width}
                    height={asset.height}
                    loading="lazy"
                    className="size-full object-cover"
                  />
                </span>
                <span className="flex flex-1 flex-col px-3.5 py-3">
                  <span className="text-[0.875rem] leading-snug text-ink-900 group-hover:text-brand-800">
                    {asset.altEn}
                  </span>
                  <span className="mt-1.5 font-mono text-[0.75rem] break-all text-ink-500">
                    {asset.src}
                  </span>
                  <span className="mt-1 text-[0.75rem] text-ink-500">
                    {asset.width} × {asset.height}
                    {asset.caption ? " · captioned" : ""}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {pages > 1 && (
        <nav aria-label="Pages" className="mt-6 flex items-center gap-4 text-[0.875rem]">
          {page > 1 ? (
            <Link
              href={pageHref(search, page - 1)}
              className="text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600"
            >
              Newer
            </Link>
          ) : (
            <span className="text-ink-400">Newer</span>
          )}
          <span className="text-ink-600">
            Page {page} of {pages}
          </span>
          {page < pages ? (
            <Link
              href={pageHref(search, page + 1)}
              className="text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600"
            >
              Older
            </Link>
          ) : (
            <span className="text-ink-400">Older</span>
          )}
        </nav>
      )}
    </main>
  );
}

function one(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = first?.trim();
  return trimmed ? trimmed : undefined;
}

function positiveInt(value: string | string[] | undefined): number | undefined {
  const raw = one(value);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function pageHref(search: string | undefined, page: number): string {
  const query = new URLSearchParams();
  if (search) query.set("q", search);
  if (page > 1) query.set("page", String(page));
  const string = query.toString();
  return string ? `/admin/media?${string}` : "/admin/media";
}
