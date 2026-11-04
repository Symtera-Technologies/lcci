# Migrating lcci.com.pk

What is on the old site, where each page goes on the new one, and what still
has no home. This is the working record for the content migration and the
source of the 301 map; it is generated against a crawl, not from memory.

Reproduce it with:

```bash
# Crawl and import. Only needed to pick up a change on the old site — the
# imported JSON is checked in, under legacy-import/.
npx tsx --tsconfig tsconfig.scripts.json scripts/crawl-legacy.ts \
  --out-dir <dir> --inventory <inventory.json>
npx tsx --tsconfig tsconfig.scripts.json scripts/import-legacy-page.ts \
  <saved.html> legacy-import/<name>.json --url <source-url>

# One migration per section, from the mapping in scripts/legacy-sections.ts.
# The output must match the file already in migrations/ byte for byte.
npx tsx --tsconfig tsconfig.scripts.json scripts/generate-page-seed.ts \
  <section> legacy-import migrations/00NN_seed_section.sql

# After `npm run build`: 11,469 runs of six consecutive words, 0 missing.
npm run verify:migration
```

## What the crawl found

The old site has no `sitemap.xml` and no `robots.txt` — both 404 — so discovery
is by following links from `index.php`. That is the right set anyway: an
unlinked page needs no redirect and has no inbound traffic to preserve.

| | |
|---|---|
| Static content pages | **51** (plus the homepage, which has no content container) |
| Text to migrate | **88,373 characters**, `0` lost to the sanitiser on every page |
| Images not migrated | **123** |
| Documents still on the old host | **47** |
| Press archive | `press.php?id=N`, observed to **895** |
| Member directory | `directory.php`, `directory2.php` — ~20,000 records |

The member directory is deliberately **not** crawled: its records come from the
membership database, not from HTML. It still needs redirects.

The press archive got the dedicated pass its own content type needed, and is
now imported — see **The press archive** below. The directory has not.

### Eight links are broken on the live site today

Not broken by the migration — broken now, for every visitor. Each is an href
written without a scheme, so the browser resolves it against `lcci.com.pk`:

| Broken href | On |
|---|---|
| `www.lcci.com.pk/`, `pakuschamber.com/` | `about.php?id=103` |
| `www.bdhcpk.org/`, `www.kenyahighcommission.com.pk/`, `www.pakistan.mid.ru/embassy?` | `about.php?id=106` |
| `www.dailymashriq.com.pk/?` | `about.php?id=104` |
| `mediation`, `gallery.php` | `membership.php` |

They are listed so the rebuild does not faithfully reproduce them.

### Five pages hold no text at all

Their content is images or an embed, so there is nothing for a `page` body:

| Legacy page | What it actually holds |
|---|---|
| `about.php?id=137` AGM 30 Sept | 30 photographs |
| `about.php?id=142` Picture Gallery 2024 | 12 photographs |
| `business.php?id=149` LCCI Documentary 2026-27 | a video |
| `business.php?id=92` LCCI Delegations | — |
| `services.php?id=79` Online Services | — |

The two galleries belong to `gallery_album` and the documentary to `video`, not
to `page`.

## Mapping: legacy → rebuilt

### About — done

| Legacy | New route | State |
|---|---|---|
| `about.php?id=75` Vision & Mission | `/about/history` | migrated |
| `about.php?id=5` President Message | `/about/leadership` | migrated |
| `presidents.php` + `about.php?id=6` + `about.php?id=7` | `/about/past-leadership` | migrated |
| `services.php?id=9` + `about.php?id=95` + `services.php?id=76` | `/about/secretariat` | migrated |
| `contact.php` | `/about/contact` | migrated (form excluded) |
| `about.php?id=135` Minutes of Meeting | `/about/minutes` | migrated |
| `excomm.php` + `about.php?id=19`, `=21`, `=22` | `/about/leadership` | **needs `office_bearer`** |

`services.php?id=95` and `about.php?id=95` serve the same page, as do
`about.php?id=85` and `members.php?id=85`. Two legacy URLs, one new route, two
301s.

### Membership — done

| Legacy | New route | State |
|---|---|---|
| `members.php?id=83` Membership Benefits | `/membership/why-join` | migrated |
| `dues.pdf` | `/membership/categories` | **the dues are a PDF today** |
| `membership.lcci.org.pk/register` | `/membership/register` | the portal's own form |
| `directory.php`, `directory2.php` | `/membership/directory` | **needs the directory (B5)** |

`/membership/renew` and `/membership/faqs` have no legacy source; FAQs is an
`href="#"` on the old menu. `/membership/register` is a form behind a session
and gets no `page` row at all — the seed creates rows only for routes the
public `(site)` group serves, so a portal route cannot end up in the admin's
list looking editable.

### Services — mostly done

| Legacy | New route | State |
|---|---|---|
| `services.php?id=77` Women Entrepreneur | `/services/women-entrepreneurs` | migrated |
| `business.php?id=134` Training & Seminars | `/services/training` | migrated |
| `services.php?id=98` LCCI Internet Library | `/services/library` | migrated |
| `services.php?id=97` Download Forms | `/services/forms` | migrated |
| `services.php?id=76` Computer & Internet Department | `/about/secretariat` | migrated, **appended** |
| `services.php?id=79` Online Services | — | a heading with no body |

`services.php?id=76` is the one page that landed on a route another migration
had already filled. 0026 seeded `/about/secretariat` with the Information and
the Research & Development departments; this is a third department on the same
page, found later, and an applied migration cannot be edited. `Mapping.append`
emits a `CONCAT` guarded on the heading not already being in the body, so it is
idempotent and keeps anything an editor has written.

**`/services/certificates-of-origin`, `/services/attestation` and
`/services/visa-recommendation` are still empty, and that is the finding**: the
chamber's three most-used services are not described on its own website today.
What exists is the forms behind `services.php?id=97` and the fee schedule in
`dues.pdf`. Turning a form's instructions into page prose is writing rather
than migrating, so those three wait for LCCI — the routes, rows and navigation
are in place for them.

### Advocacy — partly done

| Legacy | New route | State |
|---|---|---|
| `about.php?id=113` Lahore Chamber Newsletter | `/advocacy/research` | migrated |
| `budgetproposals/` (directory index) | `/advocacy/budget-proposals` | **PDFs, not a page** |

`/advocacy/positions`, `/advocacy/economy` and `/advocacy/business-confidence`
have no legacy source. The footer's "Economic Indicator", "Economic Out Look"
and "Analysis Business Confidence" are `#` or a 2015 PDF. The first two have
content types behind them already (`policy_position`, `economic_indicator`) and
now read those rather than prose: the pages are indexes over rows, and the
editable `page` body sits above the index as an introduction. Both are
therefore "done" in the sense that nothing is left to migrate into them —
what they show is whatever the chamber enters, and today that is seed data.

### Trade & Events — done

| Legacy | New route | State |
|---|---|---|
| `business.php?id=126` + `=131` + `=133` Fairs & Exhibitions | `/trade/exhibitions` | migrated, three pages into one |
| `business.php?id=87` Investment Opportunities | `/trade/investment` | migrated |
| `business.php?id=90` Trade Inquiries / Tender Notices | `/trade/inquiries` | migrated |
| `business.php?id=94` Humanitarian Appeals | `/trade/humanitarian-appeals` | migrated |
| `business.php?id=92` LCCI Delegations | `/trade/delegations` | a heading with no body |

`/trade/events` has no legacy source and wants the `event` content type.

### Newsroom — partly done

| Legacy | New route | State |
|---|---|---|
| `business.php?id=88` LCCI Circular | `/news/circulars` | migrated |
| `press.php?id=1…895` | `/news/press-releases/{slug}` | imported as drafts — see below |
| `about.php?id=137`, `about.php?id=142` | `/news/galleries` | **`gallery_album`** |
| `business.php?id=149` LCCI Documentary | `/news/videos` | **`video`** |

`/news/media-contacts` has no legacy source.

### Added to the IA because the content exists

Two routes spec §4.1 does not have, added because dropping them would lose
pages that are on the old site today:

| Route | Why | Legacy |
|---|---|---|
| `/resources` + 16 children | 17 reference lists, ~19,000 characters | the "Useful Links" menu |
| `/about/minutes` | the Executive Committee's minutes, 39 PDFs deep | `about.php?id=135` |

## Resources — done

The old site's "Useful Links" menu: **seventeen pages, ~19,000 characters**,
and spec §4.1's IA had no slot for any of them. They are not filler — the
embassy list, the helpline numbers and the government department directory are
the kind of page a member actually opens — so a seventh top-level section was
added rather than dropping them. One route per legacy list, so every legacy URL
301s to the list it was pointing at instead of to a fragment.

| Legacy | New route | Chars |
|---|---|---|
| `about.php?id=96` Useful Links | `/resources` | 2,329 |
| `about.php?id=106` High Commissions / Foreign Embassies in Pakistan | `/resources/embassies-in-pakistan` | 2,105 |
| `about.php?id=107` Pakistan Embassies / High Commissions abroad | `/resources/pakistan-embassies-abroad` | 884 |
| `about.php?id=120` Govt. Authorities & Ministries | `/resources/government-authorities` | 2,510 |
| `about.php?id=129` Federal Govt Departments | `/resources/federal-departments` | 3,513 |
| `about.php?id=146` Helpline Numbers Lahore | `/resources/helpline-numbers` | 1,835 |
| `about.php?id=128` Hospitals in Lahore | `/resources/hospitals-lahore` | 4,180 |
| `business.php?id=130` Hospitals in Pakistan | `/resources/hospitals-pakistan` | 5,021 |
| `about.php?id=100` Banks in Pakistan | `/resources/banks` | 685 |
| `about.php?id=103` Pakistani Chambers of Commerce | `/resources/chambers-pakistan` | 1,489 |
| `about.php?id=101` International Chambers | `/resources/chambers-international` | 323 |
| `about.php?id=104` Pakistani Newspapers | `/resources/newspapers-pakistan` | 331 |
| `about.php?id=102` International Newspapers | `/resources/newspapers-international` | 122 |
| `about.php?id=145` International Airlines in Pakistan | `/resources/airlines` | 940 |
| `about.php?id=144` International Links | `/resources/international-links` | 1,977 |
| `about.php?id=109` Major Places to visit in Pakistan | `/resources/places-to-visit` | 100 |
| `about.php?id=85` + `members.php?id=85` Member Websites | `/resources/member-websites` | 484 |

Seeded by `migrations/0028_seed_resources_content.sql`, which also creates the
rows — unlike About, where 0025 created them first and 0026 filled them. That
split bought nothing: the row and the text it holds arrive in the same change.

Three things about this section are worth knowing before LCCI reviews it.

**`about.php?id=96` is a menu and a page at once.** Alongside the links to the
sixteen lists it carries ~50 external ones that exist nowhere else on the site:
the three stock exchanges, the FBR and WeBOC tax links, NTN verification, the
utilities, the mobile operators, the three MoU PDFs, and a block of Czech trade
links the Embassy of Czech Republic sent the chamber. All of it is migrated.
The route renders it above the generated index of the sixteen children, so the
menu part is duplicated by design — in correct new hrefs rather than
`about.php?id=101`.

**Several of these lists are visibly out of date**, and some are telephone
numbers. They are published because they are what the chamber publishes today,
and every row carries `review_by = 2027-04-01` so B4's stale-content report
raises them. A wrong emergency number is worse than no number, and the report
is the only mechanism that will ever look at them again.

**Three legacy links in this section still have nowhere to go**, listed in the
migration's own comments: `pdfs/1-MoU-Foreign-Chambers.pdf`,
`pdfs/2-MoU-Chambers-Associations.pdf`,
`pdfs/3-MoU-Education-Sector-Miscl.pdf` (documents on the old host), and
`member_web/Hafiz_(Bros.)_Media_Solutions/index.htm`, a member's microsite
hosted on lcci.com.pk.

## Still to place

Every page on the old site that holds text is now on the new one, with one
exception, and `generate-page-seed.ts` prints the list on each run. Eleven
files remain unplaced and each has a reason:

| Unplaced | Why |
|---|---|
| `excomm.php`, `about.php?id=19`, `=21`, `=22` | structured records, not prose — they need an `office_bearer` content type, and that is **blocked on a privacy decision**: `excomm.php` prints personal mobile numbers and hotmail/gmail addresses |
| `about.php?id=137`, `about.php?id=142` | 42 photographs between them and no text — `gallery_album` |
| `business.php?id=149` | a video and no text — `video` |
| `services.php?id=79`, `business.php?id=92` | a heading with no body on the live site |
| `services.php?id=95`, `members.php?id=85` | duplicates of pages already migrated; both still need a 301 |

Not crawled at all: the member directory (`directory.php`, `directory2.php`),
whose ~20,000 records come from the membership database rather than from HTML.

Beyond the page bodies:

* **123 images and 47 documents** are still on the old host and linked from
  migrated bodies. The migrations name them. They have to move before
  lcci.com.pk is switched off — the 39 minutes PDFs behind `/about/minutes` and
  the three MoU PDFs on `/resources` among them.
* **The 301 map.** Every legacy URL in the tables above, plus the 699 press
  URLs, plus the two duplicate pairs. `legacyRouteMap` in
  `generate-page-seed.ts` already derives the static half from the same
  `source` fields the seeds use, and `legacy-import/press/` carries the
  `legacyId` → slug pairs for the press half. Eight of those ids are exact
  duplicates merged into one row, and the comment above each insert in
  migration 0037 names them, so both URLs in a pair redirect to the slug that
  survived.
* **The six index pages are built; most of their rows are not migrated.**
  `/advocacy/positions`, `/advocacy/economy`, `/trade/events`,
  `/news/press-releases`, `/news/galleries` and `/news/videos` read their
  content types and prerender what the database holds. The press archive is
  now real content; the rest — 2 positions, 5 indicators, 3 events, 1 album of
  6 photographs, 5 videos — is still seeded for the homepage rather than taken
  off lcci.com.pk. So the code is done and the data is the remaining work:
  `about.php?id=137` and `=142` into `gallery_album`, `business.php?id=149`
  into `video`.

## The press archive

All 895 `press.php?id=N` ids were fetched, one at a time, by
`scripts/crawl-press-archive.ts`. **699 held a release** and 196 render the
template with an empty headline. Eight of the 699 are byte-identical to
another id, so the archive is **691 distinct releases**; 686 became new rows
and 5 filled in the body of a release migration 0017 had already seeded by
hand. `migrations/0037_seed_press_archive.sql`, from
`legacy-import/press/*.json`.

```bash
# 1. crawl (about a quarter of an hour; resumable, skips what is on disk)
npx tsx --tsconfig tsconfig.scripts.json scripts/crawl-press-archive.ts   --out-dir <raw-dir> --manifest <manifest.json>

# 2. lift the text off the template into the checked-in provenance
npx tsx --tsconfig tsconfig.scripts.json scripts/import-press-archive.ts   --raw-dir <raw-dir> --manifest <manifest.json> --out-dir legacy-import/press

# 3. the seed. Must regenerate byte-identically; the runner checksums it.
npx tsx --tsconfig tsconfig.scripts.json scripts/generate-press-seed.ts   legacy-import/press migrations/0037_seed_press_archive.sql
```

The raw HTML is not checked in — the JSON is the provenance, as everywhere
else in `legacy-import/`.

### Three things the old site does not give us

**No dates.** `press.php` prints none, there is no `Last-Modified` header
(PHP 5.4, generated per request) and there is no index page. The id is not a
substitute: an archived capture of `press.php?id=1` is "LCCI's website
Revamped" from 2014 while that id serves a 2025 release today, and ids 1–4 and
601–602 duplicate content that also sits at 881–894. So every row is a
**draft with `published_at` NULL**, which `liveItems()` keeps out of the
public newsroom. The fix is LCCI's own press table, which holds the date its
template never printed; joined on the slug it is one `UPDATE`.

**Headlines are truncated at 55 characters** in LCCI's data, not by this
import: no headline in the archive is longer, 114 sit at 54–55 and 90 of those
stop mid-word — "LCCI slates re-imposition of Gas Infrastructure Develop".
Reconstructing the rest from the body would be writing a headline rather than
migrating one, so they are seeded as they stand.

**Only 8 releases carry a standfirst.** `content_press_releases.summary` is
NOT NULL and the index renders it under every headline, so for the other 683
it is a prefix of the release's own opening paragraph, truncated at the
column's 700 characters (158 of them are). The detail route then suppresses
the standfirst when it merely repeats how the body opens, which is what stops
683 pages printing their first paragraph twice.

### One repair that was made

24 releases are double-encoded on the live site: `press.php` declares
`<meta charset="utf-8">` and serves bytes that render as `â€œ`, so "LCCI has
established â€œExcise & Taxation Help Deskâ€" is genuinely what a visitor sees,
and 22 of the 24 have it in the headline. `repairMisdecodedText` in
`scripts/legacy-html.ts` undoes one round of UTF-8-read-as-Windows-1252 — 44
runs across those 24 releases — which restores the quotation mark the press
officer typed and keeps `â€œ` out of 22 headlines and out of the public URL.
It changes no word, and it is one call to remove if LCCI would rather the
archive reproduce the fault.
