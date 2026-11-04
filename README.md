# LCCI — lcci.com.pk rebuild

Rebuild of the Lahore Chamber of Commerce & Industry website, replacing the
query-ID PHP site and folding in the separate membership portal.

The brief lives in [`docs/`](docs/):

- `LCCI-Website-Rebuild-Developer-Spec.md` — sitemap, content models, flows, non-functionals
- `Chamber-of-Commerce-Benchmark-Findings.md` — seven-chamber benchmark; §4.3 is the homepage blueprint
- `DEPLOYMENT.md` — cPanel / Passenger / MySQL deployment

---

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router), React 19 |
| Styling | Tailwind CSS 4, tokens in `src/app/globals.css` |
| Hosting | cPanel Node.js app manager (Passenger) — `server.js` |
| Database | MySQL |
| CMS | **Not yet chosen** — see below |
| Search | Adapter boundary; MySQL `FULLTEXT` first |

### The CMS decision is still open

Payload was the original recommendation and **is not viable**: as of v3.92 it
ships adapters for Postgres, SQLite and MongoDB only — there is no
`@payloadcms/db-mysql`. Since MySQL is fixed by the hosting, the candidates are:

- **Directus** — MySQL native, granular RBAC, revisions and Flows in the free
  tier, admin ships pre-built (no admin build step on cPanel). Current pick.
- **Strapi 5** — MySQL fine, but Review Workflows (the Draft → In review →
  Published chain the spec asks for in §8.3) is a paid tier.
- **Headless WordPress + ACF** — the lowest-risk option on cPanel specifically:
  PHP, no Node memory ceiling, native MySQL, familiar to LCCI staff.

Nothing in `src/` imports a CMS client. Components read from
`src/content/repository.ts`, which currently returns fixtures; swapping it for a
real backend touches that one file.

---

## Layout

```
src/
  app/
    globals.css        design tokens — colour, type, elevation
    layout.tsx         fonts, metadata template, skip link
    (site)/            the public site — chrome in its layout, no URL segment
      page.tsx         homepage, assembled to blueprint §4.3
      about/           the About section: landing plus seven pages
  components/
    home/              the twelve homepage blocks
    site/              header, footer, nav-data (the IA as typed data),
                       interior-page, cms-page, section-index, prose
    ui/                button, tag
  content/
    types.ts           content models from spec §5
    repository.ts      the CMS seam
  lib/
    cn.ts              class merging
    format.ts          dates, pinned to Asia/Karachi
assets/photos-src/     original photographs — source only, never served
scripts/
  prepare-photos.mjs   de-frames, crops and re-encodes the photographs
  prepare-brand.mjs    derives the reversed logo and the app icon
  prepare-video-posters.mjs  crops the YouTube poster frames to how each was shot
server.js              Passenger entry point
```

### Brand and photo assets

Both the logo and the photographs come from the live lcci.com.pk, and both
needed work before use — so the transforms are scripted rather than done by hand:

```bash
node scripts/prepare-brand.mjs    # -> reversed logo + src/app/icon.png
node scripts/prepare-photos.mjs   # -> public/photos/hero-*.jpg
```

- The supplied logo is dark green line art. It disappears on the ink panels, so
  `prepare-brand.mjs` builds a white version by masking on **luminance**, not
  alpha — the crest sits on an opaque white box, so an alpha mask fills it as a
  solid block, and a CSS `invert()` would turn the crest magenta.
- The app icon is the crest alone; the full lockup is 3.6:1 and unreadable at
  32px. The crest/wordmark gutter is measured, not hardcoded.
- The photographs ship with a dark green border baked into the pixels.
  `prepare-photos.mjs` detects and removes it, then resizes and re-encodes.
- Originals live in `assets/photos-src/`, outside `public/`: 2.2MB nobody should
  download. The served crops total 412KB.

---

## Commands

```bash
npm run dev     # http://localhost:9000
npm run build   # produces .next/standalone for Passenger
npm run lint
npx tsc --noEmit
npm test        # 240 unit tests, no database needed
```

### Database

Copy `.env.example` to `.env.local` and fill in `DB_USER`, `DB_PASSWORD` and
`DB_NAME`, then:

```bash
npm run db:create       # both databases, and reports the server's real version
npm run migrate         # apply migrations/*.sql forward-only
npm run seed:rbac       # roles and permissions
npm run test:db         # the database-backed suite
```

**Two databases, not one.** `db:create` makes `$DB_NAME` and
`${DB_NAME}_test`. The development server and `npm run migrate` use the first;
`npm run test:db` uses the second, because the integration suite empties every
table it touches and then asserts on row counts. Pointing it at the
development database would destroy whatever was being worked on, so
`tests/integration/setup.ts` derives the `_test` name and `helpers.ts` refuses
to run against a name without that suffix.

`npm test` and `npm run test:db` are separate suites on purpose. The first is
hermetic — its setup stubs the database credentials to nonsense so nothing
under test can reach a server — and must keep passing on a machine with no
MySQL, which includes the off-box build runner. The second needs a real server
and fails loudly rather than skipping silently when it has none.

Migrations are never applied automatically on boot. The runner takes a
`GET_LOCK` and verifies a checksum per file, so re-running is safe and an
edited migration that has already been applied is an error rather than a
surprise.

---

## Design notes

The palette is built around the crest's own green: **brand green** for calls to
action, figures and accents, **ink** (deep indigo) for authority and the dark
panels, **clay** for editorial tags, on warm stone neutrals. The official LCCI
crest and wordmark
are used as-is — the arch motif behind the hero echoes Lahore's own
architecture and the crest's own silhouette, but it decorates; it does not
replace the mark.

The hero photographs are framed panels, not a background image. Nothing has to
be scrimmed for the headline to stay readable, and the faces are not cropped by
whatever the viewport happens to be.

**On the green scale.** The crest samples at `#174c30`, which is `brand-800`.
The crest colour itself is only **1.86:1** against the ink panels, so it is
never used as text or a fill on dark — `brand-300` carries text there (10.4:1)
and `brand-400` carries fills (7.7:1). The mid and light steps are deliberately
more saturated than the crest (S≈60% against its S≈53%); stepped down in chroma
they read grey-sage rather than green on screen.

Note that adding a new `@theme` token needs a dev-server restart. Turbopack's
CSS loader does not hot-reload them, and the symptom is silent — utilities
resolve to nothing, so elements render colourless rather than erroring.

Three rules the spec made structural rather than editorial:

- **Notices carry a required `endAt`** and are filtered on read, so an expired
  notice cannot linger the way the 30 September AGM pop-up did until 22 October.
- **The IA is typed data** (`nav-data.ts`), so a `#` or home-looping link is a
  type error rather than something QA finds. The legacy site had seven and six.
- **Dates and alt text are non-optional** in the models.

No pop-ups, no auto-rotating hero.

---

## The homepage — `components/v2/`

Two design directions were built. **The second one won and is now `/`**; the
first is still served at `/v2`, `noindex`, so the two can be opened side by
side while LCCI confirms the choice. The two sets of sections import nothing
from each other — they share only the content repository, the design tokens
and the site chrome — which is why the swap was two page files and no
component changes.

`/v2` is meant to go. Once the homepage is signed off, delete
`src/app/v2/page.tsx` and `src/components/home/` with it: a variant left
standing becomes a second homepage nobody maintains.

**The hero is editorial.** Every string above the fold and all three
photographs come from the `hero` content type — Content → Homepage → Homepage
heroes — so changing the headline, a button, the caption chip or a photograph
needs no deploy. What stays in `hero.tsx` is the composition: which plane each
photograph occupies and the perspective and shadow step that make the staging
read as depth. That is a fixed relationship between exactly three frames, so
how many pictures there are is a design decision rather than an editorial one.

Which hero is live is decided by `published_at`, not by a flag: the newest
published row wins, so scheduling one for Monday and reverting to last week’s
are both just publishing. The consequence is that **the homepage cannot render
with no hero published** — `getHero()` throws and names the fix, rather than
leaving an empty 88vh stage at the top of the site.

The chosen direction is **bento + glass + depth**: a dark ink stage lit by a
drifting green mesh, with content floating on layered shadows and real
perspective. The palette and type are unchanged — this was a layout and motion
variant, not a rebrand.

```
src/components/v2/
  primitives.tsx      TiltCard (pointer 3D tilt), Counter (count-up on reveal)
  marquee.tsx         seamless strip, pauses on hover and focus
  hero.tsx            layered photo composition over the mesh, read from the CMS
  bento-services.tsx  asymmetric bento grid, 2x2 feature tile
  figures.tsx  economy-ticker.tsx  news-events.tsx
  advocacy.tsx  committees.tsx  testimonials.tsx  closing-band.tsx
  video.tsx  video-player.tsx    facade player over the chamber's YouTube channel
  gallery.tsx  gallery-lightbox.tsx  dated photo album with a keyboard lightbox
```

**Motion is native CSS, not a library.** Scroll reveals and parallax use
`animation-timeline: view()`, which runs on the compositor — no GSAP, no
IntersectionObserver, no dependency and no licence question, which matters with
a Lighthouse ≥90 mobile target on shared cPanel. Everything degrades to the
final state: `v2-reveal` leaves content fully visible where it is unsupported
or where reduced motion is set, so nothing is invisible-by-default to a crawler.

Two traps worth keeping written down:

- **`v2-rise` and `v2-parallax` animate `translate`, not `transform`.** A
  scroll-driven animation runs with `fill-mode: both` and clamps to its final
  keyframe once past its range. Written as `transform`, that held value is
  `transform: none`, which silently overrides `v2-tilt` and kills the pointer
  tilt on any card that also reveals — in precisely the browsers that support
  scroll timelines. `translate` is a separate property and composes cleanly.
- **Do not hand-write `-webkit-backdrop-filter`.** Authoring it alongside the
  standard property made Lightning CSS treat the prefixed declaration as
  canonical and drop `backdrop-filter` entirely, so the glass silently stopped
  frosting. Write the standard property only and let the build prefix it.

---

## Interior pages

Everything behind the navigation — 62 interior routes, plus the committee
detail pages — is the same shape, and is built once. A route file is five lines: where it sits, what it is called, and the
`page` slug its prose is published at.

```tsx
const PATH = "/about/history" as const;

const PAGE = {
  ...navEntry(PATH),              // title, description and trail, from the IA
  slug: "about-history",          // the `page` row whose prose belongs here
  path: PATH,
  missing: "the chamber's history",
} as const;

export default function HistoryPage() {
  return <CmsPage {...PAGE} />;
}
```

**The route owns its place; the CMS owns its prose.** The heading, the
description and the breadcrumb come from `nav-data.ts`, which is typed, in the
repository, and already the single answer to "what is this page called" for the
header, the footer sitemap and the section index. Published prose may override
the *title* — renaming a page is an editorial act — but never the trail to it:
a content row does not know where it sits, and a page that invented its own
breadcrumb could point at an address that does not exist.

**A page renders correctly from nothing**, which is what lets the IA go in
ahead of the copy. With no row published, the route still has a correct
heading, description, breadcrumb and canonical, and the body is replaced by a
panel that says plainly that the page is being prepared and gives the
department to write to. `getPage()` returns `null` rather than throwing — the
opposite call to `getHero()`, and for a stated reason: throwing would mean the
whole site failing to build until every page had been written.

`navEntry()` **throws on an href that is in neither `PRIMARY_NAV` nor
`FOOTER_LEGAL`**. These pages are statically prerendered, so adding a route and
forgetting its navigation entry fails the build rather than shipping a page
with an empty `<h1>` that nothing links to. The privacy policy, the terms and
the accessibility statement resolve through `FOOTER_LEGAL` because they are
reachable from the footer and deliberately from nowhere else.

Pages whose real content is a list the database already holds — the committee
index, the secretariat's departments, the chamber's own contact details — pass
it as `children`, which render *below* the editable body. An editor can write
an introduction without being able to displace the structured part, and such a
page is not treated as unfinished merely because nobody wrote an introduction
for it.

## Migrating lcci.com.pk

The rebuilt site keeps the chamber’s own words. **No page copy is written in
this repository**; it is lifted off the live site mechanically and LCCI edits it
from the admin afterwards. Two scripts do it, and they are run in order:

```
scripts/crawl-legacy.ts          the live site → saved HTML + an inventory
scripts/import-legacy-page.ts    one saved legacy page → JSON (heading + body)
scripts/generate-page-seed.ts    that JSON + a route mapping → a seed migration
```

One migration per section, named on the command line:

```bash
npx tsx --tsconfig tsconfig.scripts.json scripts/generate-page-seed.ts   resources <json-dir> migrations/0028_seed_resources_content.sql
```

`SECTIONS` in that file is the mapping, and it is written out rather than
inferred because there is no rule to infer it from: `about.php?id=75` is titled
“Vision & Mission” and belongs at a route the IA calls “History & mission”, and
three separate legacy pages make up the one roll of past office bearers. Each
line is a judgement, so each line is visible in a diff. What is *not* written
out is the slug or the title: both are derived from the route's path by the
same `pageSlug` and `navEntry` the route file itself calls, because a seed and
a route that disagreed about either would produce a page that renders perfectly
and is permanently empty, with nothing to report it.

**The body goes through `sanitiseBody`** — the same function the admin’s save
handler calls — so an imported row is indistinguishable from one an editor
pasted in. That is not tidiness: `src/components/site/prose.tsx` renders these
columns with `dangerouslySetInnerHTML`, and its safety rests entirely on every
byte in a `body_*` column having come out of that function. A bespoke converter
that produced *almost* the same allowlist would break it, and the failure would
be an injection rather than a layout bug.

Three numbers are reported per page, and all three are load-bearing:

| Number | Catches |
|---|---|
| `textCharsLost` | text the allowlist dropped. Must be **0** |
| `textCharsOutsideContainer` | content the container slice *missed* |
| images / documents | assets the schema cannot hold, listed by name |

The second one exists because the first cannot see past its own cut. On
`excomm.php` the import reported “81 chars kept, 0 lost” for a page listing
fourteen office bearers — thirteen of them are rendered outside the content
container. A migration that loses thirteen people and prints a clean bill of
health is worse than no migration. The chrome costs ~1,295 characters on every
page, so a page reporting far more than that has content still to collect.

### The one thing not copied verbatim

A link's destination. Where a migrated body links to a legacy page that now
lives at a new address, the href is rewritten to that address — by the same
mapping the launch's 301 table is built from, derived from the `source` URL
recorded in each imported JSON file so it cannot drift from what was actually
imported. The link *text* is untouched; `/resources`, which on the old site is
largely nothing but an index of links, would otherwise publish fifteen links
that either 404 or walk the visitor back onto the old host.

A second, narrower repair: **eight links are broken on lcci.com.pk today**,
written as a bare hostname with no scheme — `href="www.bdhcpk.org/"` — so a
browser resolves them against the current page and every visitor who clicks one
lands on `lcci.com.pk/www.bdhcpk.org/`. The scheme is put back, which is
mechanical rather than a guess: the only way to read `www.bdhcpk.org/` is as a
hostname. Links to other sites are otherwise left exactly as written, broken or
not, because repairing somebody else's URL *would* be a guess. Every rewrite of
either kind is listed in the generated migration's comments.

**Nothing is trusted on the strength of a scrape.** `npm run verify:migration`
checks, after a build, that every run of **six consecutive words** from every
source page appears in the prerendered HTML of the route it was mapped to:
11,469 runs across 38 pages, and it exits non-zero on the first miss. It reads
the same `SECTIONS` table the seed generator reads, so a mapping added there is
checked on the next run and there is no second list to keep in step.

Six words because the import's own `textCharsLost: 0` cannot see past the
import, and there are five more steps between the legacy HTML and a visitor's
screen — a second sanitiser pass, a MySQL string literal, a migration,
`getPage`, and `dangerouslySetInnerHTML` — any of which can lose text without
raising anything.

The one deliberate exclusion is `contact.php`’s contact *form*, laid out as a
table of labels with no inputs — a form is a control, not content, the inputs
cannot survive the sanitiser, and the verifier skips any page whose table was
dropped on import rather than reporting it as a loss.

**The imported JSON is checked in**, under `legacy-import/`. It is the
provenance of every interior page's text: 51 files, one per legacy page, each
holding the heading, the sanitised body and the import's own report. Both
scripts default to reading it, so regenerating a seed and re-verifying a build
are one command each and need no network. Regenerating a seed must produce the
file already in `migrations/` byte for byte — if it does not, somebody edited a
migration by hand.

### Media: photographs, video and the gallery

The chamber's own media was the hard part of this section, because almost none
of it was usable as found.

**There is no press photography to migrate.** Every `press.php` page on the
legacy site is text; not one carries an image. The newsroom photographs are
therefore genuine chamber photographs but they are *not* photographs of those
particular stories, and the alt text is written to describe the photograph
rather than the headline next to it — which keeps it true for a screen reader
whichever story it is attached to. Real press photographs are owed by the
Information Department before launch.

**The legacy "Picture Gallery" could not be used.** It is a single undated album
of twelve photographs from one political delegation's visit — Palestinian
keffiyehs and sashes are plainly visible — captioned only with the visiting
party's name. Nothing in it says what the occasion was or when it happened, and
re-captioning a political visit as generic chamber imagery would misrepresent
it. The gallery is seeded from the chamber's own AGM photographs instead, as one
album with a title, a description and a date.

**The video section is a facade.** The videos live on the chamber's real YouTube
channel, but the poster frames are served from this origin, and nothing is
requested from any Google domain until a visitor actually presses play. Posters
that load from `i.ytimg.com` would hand every visitor's IP to a third party for
a video they never watched, and would cost a third-party connection on every
page load against a Lighthouse ≥90 mobile target on shared cPanel.

`orientation` is part of the video model rather than a styling choice, because
the channel genuinely mixes one widescreen film with vertical Shorts, and
YouTube pads a Short's thumbnail out to 16:9 with a blurred copy of itself.
Framing a Short as widescreen shows blurred bars around a cropped subject, so
`prepare-video-posters.mjs` takes the real centre column back out and the
section frames each video the way it was shot.

---

## Known gaps

- **Every public route is built and every nav link resolves**, which a test
  asserts. What varies is whether a page has text in it yet: 29 of the 62 carry
  prose migrated from lcci.com.pk, and the rest are empty drafts at the right
  slugs, so an editor finds them in the admin and types into them. A test
  (`tests/page-rows.test.ts`) asserts the two sets match in both directions —
  a route with no row can never be written, and a row with no route silently
  swallows whatever an editor types into it. The pages
  with no text are the pages the old site has no text for — `docs/LEGACY-MIGRATION.md`
  says which, and why, one page at a time.
- **The six index pages read their content types, but the content is seed
  data.** `/advocacy/positions`, `/advocacy/economy`, `/trade/events`,
  `/news/press-releases`, `/news/galleries` and `/news/videos` render
  `policy_position`, `economic_indicator`, `event`, `press_release`,
  `gallery_album` and `video` rows, and the build prerenders what is there
  today: 2 positions, 5 indicators, 3 events, 1 album of 6 photographs, 5
  videos. Those rows were written as fixtures for the homepage, not migrated
  from lcci.com.pk.
- **The press archive is imported, and waiting on dates to go live.** All 895
  `press.php?id=N` ids were crawled; 699 held a release, which merge to **691
  distinct ones**, and 686 are now `press_release` rows (the other 5 filled in
  the bodies of releases migration 0017 had already seeded by hand). They are
  seeded as **drafts with no `published_at`, because the old site records no
  publication date** — not in the markup, not in a response header, not on an
  index page, and the ids cannot stand in for one because low ids have been
  reused. `liveItems()` needs `published_at <= NOW()`, so the public newsroom
  still shows the seven dated releases while the archive sits in the admin for
  staff to read and date. Dating it is one `UPDATE` joined on the slug —
  `legacyId` is beside the slug in `legacy-import/press/` — and the realistic
  source is LCCI's own press table, which holds the dates its template never
  printed. Two things to know before any of it is published: **headlines are
  truncated at 55 characters in LCCI's own data** (114 sit at the limit, 90 of
  those cut mid-word), and 8 legacy ids are exact duplicates that were merged
  into one row, so their URLs need a 301 to the slug that survived.

  Publishing it needs no code change: `/news/press-releases/[slug]` and
  `/news/press-releases/page/[n]` are built for the full volume, the pager
  appears at 25 items, and `generateStaticParams` asks the database for the
  page count.
  ~895 `press.php?id=N` items are still on the old host, and until they are
  imported the newsroom shows seven releases where the chamber has published
  years of them. `/news/press-releases/[slug]` and
  `/news/press-releases/page/[n]` are built for that volume already — the
  pager appears at 25 items and `generateStaticParams` asks the database for
  the page count — so the import is a data task, not a code one.
- **The three most-used services are described nowhere.**
  `/services/certificates-of-origin`, `/services/attestation` and
  `/services/visa-recommendation` have no legacy page: the chamber's own
  website does not explain the things members come to it for. The forms behind
  `services.php?id=97` and `dues.pdf` are the only source, and turning a form's
  instructions into page prose is writing rather than migrating.
- **`/about/leadership` has the President’s message and not the committee.**
  The other thirteen Executive Committee members on `excomm.php` are structured
  records — name, designation, firm, telephone, personal email, portrait — and
  need a content type, not a paragraph. Their personal mobile numbers and
  hotmail/gmail addresses are published on the live site today; **migrating
  them into a new database is a privacy decision LCCI should take explicitly**,
  not a side effect of a scrape. The live page also shows the Senior Vice
  President above an address belonging to somebody else and lists the Vice
  President ahead of the Senior Vice President; both are reproduced, not
  corrected.
- **61 portraits on `presidents.php` are not migrated**, and nor is the
  President’s. `<img>` is not on the sanitiser’s allowlist, because alt text is
  NOT NULL on `media_assets` and a body that can carry an image is how an
  undescribed photograph reaches the site. The names and years are all there;
  the faces need collecting into the media library with descriptions.
- **`/about/minutes` links 39 PDFs still hosted on the old server.** The page
  is migrated — it is an index of the Executive Committee's minutes, and the
  spec's IA had no slot for it, so `/about/minutes` was added — but the
  documents themselves have to move before lcci.com.pk is switched off. 123
  images and 47 documents are in the same position; each migration names the
  ones its pages link to.
- **The chamber’s contact details were wrong in four places until they were
  checked against the live site** — the street name had lost "Sanat-O", the
  postcode and province were invented, the `tel:` links dropped Lahore’s area
  code so none of them dialled from abroad, and `info@lcci.org.pk`, which the
  whole site offered, does not exist. The four departmental addresses
  (`membership@`, `certificates@`, `research@`, `media@`) were invented too.
  lcci.com.pk publishes four addresses and they are its office bearers’.
  **If LCCI runs departmental inboxes, they still need supplying.**
- The six committees behind `/about/committees` came from the launch fixtures,
  and the legacy menu’s "Standing Committees 2026" is a dead `#` link — so
  there is nothing to check them against. Their provenance needs confirming
  before that page is published.
- Urdu: RTL plumbing and `*_ur` fields are in place; `/ur` is not built (out of
  scope for v1).
- `/ur` is linked from the header and the footer and does not exist. Urdu is
  out of scope for v1, so either the link goes or the route does; it is a
  product decision, not a bug to fix quietly.
- Newsletter sign-up validates and responds but stores nothing — the provider is
  still [TBC] in spec §9, and collecting addresses before then would promise
  something the chamber cannot deliver.
- Partner logos are typeset wordmarks pending approved artwork from LCCI.
- **The newsroom photographs are stand-ins.** They are real chamber
  photographs, but not of the stories they sit beside — the legacy site has no
  press photography at all. Their alt text describes the photograph, not the
  headline, so nothing it says is false; the pictures themselves still need
  replacing per story.
- **The gallery holds one album.** The chamber's wider photo archive, with
  occasions and dates, is still owed; `getGalleryAlbum()` returns a single album
  and will need to become a list.
- Video titles and ids come from the channel's public feed. Durations are not in
  that feed, so none is shown.
- **Hero photo alt text describes what is happening without naming anyone.** The
  source images carried `"..."` as their alt text, so who appears in them is
  unverified. The Information Department should confirm identities (and that
  these are the photographs the chamber wants leading its homepage) before any
  names are added.
- Lighthouse ≥90 mobile (spec §9) will need a CDN in front of cPanel.
