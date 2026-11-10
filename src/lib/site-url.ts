/**
 * The one definition of this site's canonical origin.
 *
 * Read by the root layout for `metadataBase`, which is what every canonical
 * link and Open Graph URL is resolved against, and by `sitemap.ts` and
 * `robots.ts`. One definition because the three have to agree: a sitemap
 * listing `https://lcci.com.pk/about` for a page whose own canonical says
 * `https://www.lcci.com.pk/about` is a conflict a crawler resolves by trusting
 * neither, and the way that happens is two files each reading the environment
 * with their own fallback.
 *
 * Validated rather than handed to `new URL` at the call site: a placeholder
 * left in `.env.production.local` otherwise fails the build with `TypeError:
 * Invalid URL` and no indication of which variable produced it.
 *
 * Separate from `SITE_ORIGIN`, and both are needed. That one is a server-side
 * value used for the server-action origin check; this one is inlined into the
 * client bundle, because `metadataBase` is evaluated where metadata renders.
 * Setting one and not the other is the common mistake, which is why
 * `docs/DEPLOYMENT.md` lists them together.
 */
export function siteOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!configured) return "https://lcci.com.pk";

  try {
    new URL(configured);
  } catch {
    throw new Error(
      `NEXT_PUBLIC_SITE_URL is not a valid URL: ${JSON.stringify(configured)}. ` +
        "It must include the scheme, for example https://lcci.com.pk. Leave it " +
        "unset to fall back to the production domain.",
    );
  }

  // Normalised without a trailing slash, so that callers joining a path onto
  // it cannot produce `//about`. `metadataBase` does not care; a sitemap `loc`
  // does, because a crawler treats the two as different URLs.
  return configured.replace(/\/+$/, "");
}
