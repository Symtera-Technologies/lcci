import { NoticeStrip } from "@/components/home/notice-strip";
import { Header } from "@/components/site/header";
import { Footer } from "@/components/site/footer";

/**
 * The public site's chrome: alert band, header, page, footer.
 *
 * A layout rather than three imports repeated in every page, because there are
 * 48 public routes behind the navigation and the header and footer are
 * identical on all of them. It also means the chrome does **not** re-render on
 * navigation between siblings, so the mobile nav sheet's open/closed state and
 * scroll position survive moving from `/about` to `/about/history`.
 *
 * This is the pattern Next's own docs warn against for *authorisation* — a
 * layout check runs once and then sibling navigations render pages it never
 * saw. That warning does not apply here: there is nothing to authorise on a
 * public page, and `src/server/auth/policy.ts` deliberately lists no entry for
 * anything under this group. See the note in `tests/routes.test.ts`.
 *
 * `(site)` contributes no URL segment, so the homepage still answers at `/`.
 * `/v2` sits outside the group on purpose: it is a `noindex` design variant
 * kept only until the chosen direction is signed off, and it must not quietly
 * acquire chrome changes made for the real site.
 */
export default function SiteLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <NoticeStrip />
      <Header />
      {children}
      <Footer />
    </>
  );
}
