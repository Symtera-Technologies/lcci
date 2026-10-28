/**
 * The officer's document viewer.
 *
 * Shared between the review screen and the checklist screen rather than
 * duplicated, because what it does is security-relevant and two copies drift.
 * Three decisions in forty lines of markup, each with a reason that is not
 * obvious from reading it:
 *
 * **`?inline=1`.** The document route serves `Content-Disposition: attachment`
 * by default, which is what neutralises anything that slipped validation — a
 * file that renders is a file that can run. The inline mode is a separate,
 * staff-only branch of that route serving the same bytes under a bounded CSP
 * (`default-src 'none'`, `object-src 'none'`, `sandbox`), and it is the only
 * reason a frame here is safe at all.
 *
 * **A plain `<img>`, never `next/image`.** With `images.unoptimized`, which
 * the deployment prescribes, `next/image` emits a plain `img` and does
 * nothing. With the optimiser on, `/_next/image` is an *unauthenticated*
 * endpoint that caches fetched bytes into `.next/cache/images` — an
 * uncontrolled cache of identity documents, inside the directory the release
 * deletes and recreates. That is disqualifying on its own, before the SSRF
 * surface `remotePatterns` would open onto our own authenticated route.
 *
 * **No pdf.js.** The browser's own viewer renders a scanned filing correctly
 * and supports the Range requests the document route already answers, so 400
 * KB of client JavaScript buys page-level control nothing here needs yet. When
 * something does — a page thumbnail strip, an annotation layer — it goes
 * behind `next/dynamic` on this component alone.
 */

export interface ViewableDocument {
  readonly id: string;
  readonly typeLabel: string;
  readonly originalFilename: string;
  readonly mimeType: string;
  readonly viewable: boolean;
}

export function DocumentViewer({
  document: doc,
  emptyMessage = "Choose a document to view it here.",
  height = "75vh",
}: {
  document: ViewableDocument | null;
  emptyMessage?: string;
  /** Shorter on the checklist, where the item list is the primary surface. */
  height?: string;
}) {
  if (!doc) {
    return (
      <div className="flex min-h-[20rem] items-center justify-center rounded-xl border border-dashed border-stone-300 bg-white p-8 text-center text-[0.9375rem] text-stone-600">
        {emptyMessage}
      </div>
    );
  }

  const src = `/api/documents/${doc.id}?inline=1`;

  return (
    <figure className="rounded-xl border border-stone-200 bg-white p-4">
      <figcaption className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-[0.9375rem] font-semibold text-ink-950">
          {doc.typeLabel}
        </span>
        <a
          href={src}
          target="_blank"
          rel="noopener"
          className="text-[0.8125rem] font-medium text-brand-700 underline decoration-brand-700/40 underline-offset-4 hover:decoration-brand-700"
        >
          Open full size
        </a>
      </figcaption>

      {doc.viewable ? (
        doc.mimeType === "application/pdf" ? (
          <iframe
            // `title` rather than alt text: a frame is announced by its title,
            // and "PDF" alone would tell a screen-reader user nothing.
            title={`${doc.typeLabel} — ${doc.originalFilename}`}
            src={src}
            className="w-full rounded-lg border border-stone-200 bg-stone-100"
            style={{ height }}
          />
        ) : (
          /* See the note at the top of this file on why this is not
             next/image. */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={`Uploaded ${doc.typeLabel.toLowerCase()}, as submitted`}
            className="w-full rounded-lg border border-stone-200 object-contain"
            style={{ maxHeight: height }}
          />
        )
      ) : (
        <p className="rounded-lg border border-stone-200 bg-stone-50 p-5 text-[0.9375rem] text-ink-700">
          This file type cannot be shown in the browser. Download it to review
          it.
        </p>
      )}
    </figure>
  );
}
