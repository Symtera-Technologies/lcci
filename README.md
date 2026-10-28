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
    page.tsx           homepage, assembled to blueprint §4.3
  components/
    home/              the twelve homepage blocks
    site/              header, footer, logo, nav-data (the IA as typed data)
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

## Homepage variant 2 — `/v2`

A second design direction, at its own route so both can be opened side by side
and judged honestly. `/` imports nothing from `v2/` and `v2/` imports nothing
from `home/`; they share only the content repository, the design tokens and the
site chrome — which is exactly what should be shared when the question is
"which layout?". The route is `noindex`: two near-identical homepages competing
in search results would be a real problem, not a hypothetical one.

Direction is **bento + glass + depth**: a dark ink stage lit by a drifting
green mesh, with content floating on layered shadows and real perspective. The
palette and type are unchanged — this is a layout and motion variant, not a
rebrand.

```
src/components/v2/
  primitives.tsx      TiltCard (pointer 3D tilt), Counter (count-up on reveal)
  marquee.tsx         seamless strip, pauses on hover and focus
  hero.tsx            layered photo composition over the mesh
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

- Only `/` exists. Every nav link points at its real spec route, so they 404
  until those pages are built — deliberately, rather than pointing at `#`.
- Urdu: RTL plumbing and `*_ur` fields are in place; `/ur` is not built (out of
  scope for v1).
- Member portal is out of scope for v1 but must land at `/portal` on this
  domain, not a separate site.
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
