import Link from "next/link";

/**
 * 401, for a request with no usable session.
 *
 * Pages redirect to a sign-in form rather than reaching this, so what lands
 * here is the case where a redirect would be wrong — a fetch, or a segment
 * that cannot navigate. It stays a page rather than a bare status because a
 * 401 with no body in a browser tab is indistinguishable from a broken site.
 */
export default function Unauthorized() {
  return (
    <main className="mx-auto w-full max-w-lg px-6 py-20">
      <p className="text-[0.8125rem] font-medium uppercase tracking-[0.12em] text-stone-500">
        401
      </p>
      <h1 className="mt-2 text-[1.75rem] font-semibold tracking-tight text-ink-950">
        Your session has ended
      </h1>
      <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink-700">
        Sign in again to continue. Anything you had saved is still there.
      </p>
      <p className="mt-6 flex flex-wrap gap-x-5 text-[0.9375rem]">
        <Link
          href="/admin/sign-in"
          className="font-medium text-brand-700 underline decoration-brand-700/40 underline-offset-4 hover:decoration-brand-700"
        >
          Staff sign-in
        </Link>
        <Link
          href="/membership/sign-in"
          className="font-medium text-brand-700 underline decoration-brand-700/40 underline-offset-4 hover:decoration-brand-700"
        >
          Member sign-in
        </Link>
      </p>
    </main>
  );
}
