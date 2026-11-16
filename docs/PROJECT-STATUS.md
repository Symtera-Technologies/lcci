# LCCI website rebuild — project status

**Measured 16 November 2026** against the live site at lcci.com.pk and the
project database, on branch `site-rebuild` at commit `08554fc`.

Everything in this document is counted, not estimated.

---

## 1. Headline

| Question | Answer |
|---|---|
| Is any legacy page left unmigrated? | **Yes — 2 items, both published after the crawl.** An "Election 2026" page linked from the homepage, and 4 press releases. |
| Are all pages editable from the admin? | **Yes, all 62.** Body, standfirst, meta description, Urdu fields, SEO title and description, and sharing image. |
| Are images editable? | **Partly.** Editors can assign, describe, credit and swap images from a 73-item library. They **cannot upload a new file** without a deploy. |
| Are the pages designed? | **The templates are, uniformly.** 62 of 62 CMS pages use a structured editorial treatment and 65 of 66 routes use the feature header. But **27 pages have no content in them** and **no interior page carries an image**. |

---

## 2. What is still missing from lcci.com.pk

The live site was re-fetched on 16 November 2026 and every link on its entry
pages was compared against `src/content/legacy-redirects.ts`. Of 42 legacy page
links reachable from those pages, 37 are mapped and 5 are not.

| Legacy URL | What it is | Size | Status here |
|---|---|---|---|
| `about.php?id=0` | **LCCI Election Schedule 2026** — nomination papers, Regulator's directions of 25 August 2026 | 2,183 chars | **Not imported. No route, no redirect.** |
| `press.php?id=896` | SME Financing Key to Economic Revival | 5,722 chars | Not imported |
| `press.php?id=897` | (new release) | — | Not imported |
| `press.php?id=898` | (new release) | — | Not imported |
| `press.php?id=899` | Gillani Supports LCCI's call for Stakeholders | 7,986 chars | Not imported |

Ids 900–910 were probed and all return the empty template, so the archive ends
at 899 and the gap is exactly these four.

Three documents linked from the legacy homepage exist nowhere in this project:
`memorandum_2026.pdf`, `election_2026/MOA_EOGM2025-26.pdf`, and
`Analysis_Business_Confidence_Survey_2015.pdf`.

**The election page is the one that matters.** It is current, dated,
legally-framed content on the homepage of a chamber mid-election, and the
rebuild has no equivalent page at all.

### Legacy pages imported but never placed

52 legacy pages were imported; 51 had their prose seeded into the CMS. The
exceptions:

| Legacy page | Prose | Why it is unplaced |
|---|---|---|
| `excomm.php` — Executive Committee | 194 chars | **Withheld deliberately.** The page publishes 13 named officers' personal mobile numbers and private email addresses. Republishing them is LCCI's decision. |
| `about.php?id=137` — AGM 30 Sept | 0 | Photographs only; the images are still on the old host |
| `about.php?id=142` — Picture Gallery 2024 | 0 | Photographs only |
| `business.php?id=149` — LCCI Documentary | 0 | Video only |
| `business.php?id=92` — LCCI Delegations | 0 | Images only |
| `services.php?id=79` — Online Services | 0 | Link list only |

All six redirect to a truthful destination today, so no visitor is lost.

### Press archive

| | Count |
|---|---|
| Legacy ids crawled | 895 |
| Ids holding a release | 699 |
| Distinct releases after de-duplication | 691 |
| Rows in the database | 693 |
| Published | 7 |
| Draft, awaiting dates from LCCI | 686 |

`press.php` printed no date and none was invented, so 686 releases cannot be
published yet. Their redirects resolve to the archive index rather than to a
404 — two hops, both resolving. One `UPDATE` with LCCI's dates turns all 686
into live pages and nothing in the code has to change.

---

## 3. Page inventory

66 route files: 63 static routes, 3 dynamic. 62 of them are CMS pages, matched
1:1 against 62 `page` rows — no orphan route, no orphan row.

| State | Count | What a visitor sees |
|---|---|---|
| Published with a body | **35** | A full page. Average 4,982 characters, range 273 – 16,560 |
| Empty, renders a content list | **7** | Real content drawn from another content type |
| Empty, section landing | **5** | "This page is being prepared" panel |
| Empty, needs LCCI's own text | **3** | "This page is being prepared" panel |
| Empty, no source content ever existed | **12** | "This page is being prepared" panel |
| Dynamic detail routes | **3** | Press release, press page N, committee |
| Homepage | **1** | Bespoke, 12 section types |

### The 27 empty pages, by reason

| Reason | Pages |
|---|---|
| **Fine as-is** — the page renders a list, the body is an optional intro | `/about/committees` · `/advocacy/economy` · `/advocacy/positions` · `/news/galleries` · `/news/press-releases` · `/news/videos` · `/trade/events` |
| **Section landing, no introduction written** | `/about` · `/advocacy` · `/news` · `/services` · `/trade` |
| **LCCI must supply the text** | `/privacy` · `/terms` · `/accessibility` |
| **No source content exists on the old site** | `/about/careers` · `/advocacy/budget-proposals` · `/advocacy/business-confidence` · `/membership/categories` · `/membership/directory` · `/membership/faqs` · `/membership/renew` · `/news/media-contacts` · `/services/attestation` · `/services/certificates-of-origin` · `/services/visa-recommendation` · `/trade/delegations` |

Those last 12 are the real content gap. The old site never had these pages, so
there was nothing to migrate and each needs copy written.
`/membership/categories` matters most: it should carry the class and fee table,
which the legacy membership page never names.

### Published pages by size

| Characters | Pages |
|---|---|
| Under 1,000 | 9 |
| 1,000 – 3,000 | 10 |
| 3,000 – 8,000 | 9 |
| Over 8,000 | 7 |

The largest are `/about/past-leadership` (16,560), `/trade/exhibitions`
(14,596) and `/resources/government-authorities` (14,300).

---

## 4. Editability

All 15 content types have an admin screen, held by a compile-time
exhaustiveness check at `src/app/(admin)/admin/content/page.tsx` — a new
content type cannot ship without one.

| Type | Rows | Body | Image slots | Other editable fields |
|---|---|---|---|---|
| page | 62 | EN + UR | hero | standfirst, meta description (EN + UR) |
| press_release | 693 | EN + UR | hero | summary, spokesperson |
| portrait | 62 | — | photo, sharing | role, term, title, department, order |
| hero (homepage) | 1 | — | lead, behind, front | 19 fields: headline, subhead, two CTAs, stat, caption |
| event | 3 | EN + UR | — | type, dates, venue, fee, capacity, registration |
| policy_position | 2 | EN + UR | — | issue, chamber ask, status |
| video | 5 | — | poster | YouTube id, orientation, description |
| partner | 6 | — | logo | tier |
| committee | 6 | **none** | — | mandate, member count |
| gallery_album | 1 | **none** | **no image editor** | description, date |
| notice | 2 | — | — | message EN + UR, link, level, window |
| testimonial | 3 | — | — | quote, author, role, company |
| service_tile | 5 | — | — | description, link, icon |
| key_figure | 4 | — | — | value, suffix, verified date |
| economic_indicator | 5 | — | — | value, change %, source, measured date |

Every type also carries the shared controls: title EN/UR, slug, status, owning
department, SEO title, SEO description, sharing image, review date and
scheduled unpublish date.

### Three editing gaps

1. **`committee` has no body field.** The six committee detail pages can show
   only a mandate line and a member count.
2. **`gallery_album` has no image editor.** An album exists, but there is no
   way to add photographs to it.
3. **`published_at` is not editable.** It belongs to a Draft → In review →
   Published workflow that has not been built, which is why 686 press releases
   are stuck as drafts.

---

## 5. Images

73 registered assets. **Every file was verified present on disk** — there are no
broken images anywhere in the site.

| Slot | Filled | Total | |
|---|---|---|---|
| Portrait photo | 62 | 62 | complete |
| Video poster | 5 | 5 | complete |
| Homepage hero | 3 | 3 | complete |
| Gallery images | 6 | 6 | one album |
| Press release hero | 6 | 693 | 1% |
| **Interior page hero** | **0** | **62** | **no interior page has a banner image** |
| **Partner logo** | **0** | 6 | renders as typeset wordmarks |
| **Sharing image** | **0** | 860 | the plumbing works; nothing is set |

Where the files live: 62 under `/people`, 6 under `/photos`, 5 under `/video`.

### Two separate problems

**Filling** is editorial — someone has to choose the images.

**Uploading** is structural. `src/content/media.ts` manages records and
descriptions but accepts no file, and the reason is written into the module:
`public/` sits inside the app root and the release does `rm -rf .next` and
copies over the tree, so one `--delete` would take every photograph the chamber
has uploaded; and the private document root is encrypted, `no-store` and served
as an attachment, which is the opposite of what a hero image needs. The answer
is object storage behind the existing `DocumentStore` adapter. Until then,
adding a photograph requires a deploy.

---

## 6. Design

| Measure | Result |
|---|---|
| Routes using the shared interior template | 66 / 66 |
| Routes using the dark feature header | 65 / 66 |
| CMS pages using a structured body treatment | 62 / 62 — 59 editorial, 2 roster, 1 letter |
| Pages falling back to raw prose | 0 |

The body renderer reads a saved body as sections, definition lists, contact
blocks, resource links and numbered grids, and adds no words — enforced across
11,608 runs of six consecutive words by `scripts/verify-migrated-text.ts`.

This section measures structure, not appearance. No page falls back to an
unstyled wall of text. The pages most worth a visual check before launch are
the long reference tables: `/about/past-leadership`, `/trade/exhibitions` and
`/resources/government-authorities`.

---

## 7. Technical state

| Gate | Result |
|---|---|
| Migrations | 46 applied, no drift |
| TypeScript | clean |
| ESLint | clean |
| Unit tests | 44 files, 805 tests passing |
| Integration tests | 23 files, 407 tests passing |
| Production build | succeeds |
| Migrated-text verifier | 11,608 runs, 0 missing |
| Public routes returning 200 | 76 / 76 |
| Legacy redirects | 755 entries, every destination resolves |
| sitemap.xml | 76 URLs: 63 routes + 7 press + 6 committees |
| robots.txt | allows on a production host, blocks on a staging host |

### Known deployment risks

- **Publishing may not propagate across Passenger workers.** `next.config.ts`
  sets `output: "standalone"` with no `cacheHandler`, and Next's own ISR guide
  states that the default file-system cache is per-instance and that on-demand
  revalidation only invalidates the instance receiving the call. Needs testing
  on the host with the `x-nextjs-cache` header; the fix is a MySQL-backed cache
  handler.
- **41 PDF links in published bodies still point at lcci.com.pk** (Executive
  Committee minutes, LCN newsletters). They work only while the old host is up.
- **121 images and 47 documents** are still only on the old host.
- The host's MySQL/MariaDB version has never been recorded. The 46 migrations
  have only ever been applied against MySQL 8.4.
- The canonical domain (`lcci.com.pk` vs `lcci.org.pk`) is undecided, and the
  entire redirect map is keyed to that answer.

---

## 8. What is left, in order

| # | Action | Blocked on | Effort |
|---|---|---|---|
| 1 | Import the **Election 2026** page and its two PDFs | nothing | hours |
| 2 | Import **press releases 896–899** | nothing | hours |
| 3 | Copy **121 images and 47 documents** off the old host, and rewrite the 41 PDF links | **LCCI permission** | a day |
| 4 | Supply **press release dates** — publishes 686 pages | **LCCI export** | LCCI |
| 5 | Write copy for the **12 pages with no source content** | **LCCI** | LCCI |
| 6 | Supply **privacy, terms and accessibility** text | **LCCI** | LCCI |
| 7 | **Image upload** to object storage | a hosting decision | ~1 day |
| 8 | **Committee body** and **gallery image** editors | nothing | ~half a day each |
| 9 | **`published_at` control** / publish workflow | nothing | ~1 day |
| 10 | Fill page heroes, partner logos and sharing images | images + editorial time | editorial |
| 11 | Decide whether to **republish officers' contact details** | **LCCI** | LCCI |
| 12 | Test revalidation on the host; add a cache handler if needed | host access | ~1 day |

**Six of the twelve are waiting on LCCI, not on code.**

---

## Method

| Figure | How it was obtained |
|---|---|
| Legacy links and their coverage | `curl` of lcci.com.pk entry pages, href extraction, diffed against `src/content/legacy-redirects.ts` |
| New press ids | Direct fetch of ids 896–910; a 24,554-byte response is the empty template |
| Page counts, body sizes, statuses | SQL against `content_items` joined to `content_pages` |
| Image slots | `COUNT(column)` over each content table's image foreign key |
| Image files present | Every `media_assets.src` tested against `public/` |
| Placed vs unplaced legacy prose | Each `legacy-import/*.json` source URL matched against the provenance comments in `migrations/*.sql`, then spot-verified in the database |
| Editable fields | Parsed from `CONTENT_FORMS` in `src/content/fields.ts` |
| Layout and body treatment | Parsed from each `src/app/(site)/**/page.tsx` |
| Gates | `npm run migrate`, `tsc --noEmit`, `eslint`, `vitest`, `npm run build`, `verify:migration`, live HTTP sweep |
