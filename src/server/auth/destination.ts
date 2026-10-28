/**
 * Where a member lands after signing in.
 *
 * In its own module, and with no `server-only` guard, for two reasons. Every
 * export of a `"use server"` file becomes a server action and must be an async
 * function, so a synchronous helper and a string constant cannot live beside
 * the sign-in actions however much they belong to them. And this is the kind of
 * function that is worth testing directly — one wrong character and the sign-in
 * page is an open redirect — which a unit test can do here with nothing stubbed.
 *
 * Nothing secret passes through it: it takes a string off a query parameter and
 * returns a path.
 */

export const DEFAULT_DESTINATION = "/membership/apply";

/**
 * Reduce a `?next=` value to something safe to redirect to.
 *
 * An open redirect matters more on a sign-in page than anywhere else on the
 * site, because the visitor has just been asked to prove who they are and is
 * primed to trust whatever happens next: "sign in, then land on a page that
 * asks for your code again" is the entire phishing flow, and the first half of
 * it would be genuine.
 *
 * So this is an allowlist of shapes, not a blocklist of tricks:
 *
 * - One leading slash and not two. `//evil.example/x` is a protocol-relative
 *   URL, and a browser treats it as another origin — it is the single most
 *   common way an open redirect survives a check that only looked for `http`.
 * - No backslash anywhere. Some parsers, and some proxies in front of them,
 *   fold `\` to `/`, so `/\evil.example` is the same trick spelled differently.
 * - Inside the member area, so a redirect cannot be aimed at an admin path a
 *   member may not hold.
 * - Not back to the sign-in page, which would be a loop that reads as a failure
 *   immediately after a success.
 *
 * Anything else silently becomes the default. A visitor who followed a mangled
 * link wants to get in, not to read an explanation of why their link was wrong.
 */
export function safeDestination(value: unknown): string {
  if (typeof value !== "string" || value === "") return DEFAULT_DESTINATION;
  if (!value.startsWith("/")) return DEFAULT_DESTINATION;
  if (value.startsWith("//") || value.includes("\\")) return DEFAULT_DESTINATION;
  if (!value.startsWith("/membership/") && !value.startsWith("/portal/")) {
    return DEFAULT_DESTINATION;
  }
  if (value.startsWith("/membership/sign-in")) return DEFAULT_DESTINATION;
  return value;
}
