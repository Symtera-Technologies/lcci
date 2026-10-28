# LCCI Website Rebuild: Developer Specification

**Project:** Redesign and restructure of lcci.com.pk (Lahore Chamber of Commerce & Industry)
**Prepared by:** Symtera Technologies
**Version:** 0.1 (draft, based on the leadership pitch deck of 22 Oct 2026)
**Status:** Pre-discovery. Items marked **[TBC]** are confirmed during the Discovery phase.

---

## 1. Purpose and scope

Rebuild the LCCI public website and bring the separate membership portal into one platform, organised around **member tasks** instead of the chamber's org chart.

**In scope**
- New information architecture (sitemap, navigation, URL scheme)
- Structured content types managed in a CMS with roles and review
- Member portal: join, renew, pay, request documents, book events, edit directory profile
- Searchable member directory with a cleaned sector taxonomy
- Bilingual site (English and Urdu, right-to-left)
- Migration of existing content plus 301 redirects for every old URL
- SEO, accessibility, performance and security baseline

**Out of scope (for v1)** [TBC]
- Rebuilding the back-office membership database (we integrate with it)
- Native mobile apps

---

## 2. Audit summary of the current site

Scan of lcci.com.pk on 22 Oct 2026. These are the defects the rebuild must remove.

### 2.1 Platform
- Custom PHP pages addressed by query ID (`about.php?id=75`, `services.php?id=95`, `business.php?id=90`, `press.php?id=893`)
- Every page uses the same `<title>`: "Welcome to Lahore Chamber of Commerce & Industry"
- Empty `meta description` and `author`
- Membership runs on a separate domain (`membership.lcci.org.pk`), and staff emails use `@lcci.org.pk`, while the site uses `lcci.com.pk`
- Mixed `http` / `https` links

### 2.2 Navigation
- 8 menus and about 40 links that mirror departments
- The same links repeat in the top bar, main menu, sidebar and footer
- **Placeholder links (`#`):** Advisory Committee, Administration, EDRC, WTO Reference Center, Standing Committees, FAQs, WRC Web Portal
- **Footer links that loop back to the homepage:** Economic Indicator, Circular, Economic Outlook, Careers, SRO Income Tax, Trade with Countries
- The Election 2026 banner links to `about.php?id=0`
- The Gmail icon is `javascript:void(0)`

### 2.3 Content
- 4 stacked pop-up notices on the homepage, with no dates or expiry (the AGM notice for 30 Sep 2026 was still showing on 22 Oct)
- Press releases have no visible publication date, no image, no share buttons and no related items
- The slider repeats the news list, and some headlines are cut off
- The Business Confidence analysis is from 2015
- "Trade Ordinance 2025" and "Trade Ordinance 2007" are both listed
- Typos: "Ministery", "Trade Inquires", "Eamil Address", "YOU TUBE", and directory sectors such as "AVAITION", "SANITRY" and "REAL ESTAT"
- Images with no alt text, or with "..." as alt text

### 2.4 Directory
- 72 sectors rendered in one unsorted block, with "MISCELLANEOUS" appearing twice
- The business type list includes "N/A"
- There are two overlapping lists: `directory.php` and `directory2.php` ("List of Valid Members")
- Search behaviour is unclear and there is no pagination or result count

### 2.5 Strengths to keep
- The newsroom is updated almost daily, and the press archive runs to roughly 890 items
- Active social channels: Facebook, X, Instagram and YouTube
- Online registration and renewal already exist (integrate, don't discard)

---

## 3. Design principles (acceptance tests for every page)

1. **Member first.** Join, Renew and request a document are reachable in one click from every page.
2. **Organised by task.** Six top-level menus plus site search, with no department-based menus.
3. **Always current.** Every item has a date, notices expire automatically, and every section has a named content owner.
4. **Trusted and open.** One HTTPS domain, English and Urdu, mobile first, and WCAG 2.2 AA.

---

## 4. Information architecture

### 4.1 Sitemap

```
/                                Home
/search                          Site-wide search
/about
  /about/history                 History, vision, mission, values
  /about/leadership              President, SVP, VP, Executive Committee
  /about/committees              Standing and advisory committees (listing → detail)
  /about/past-leadership         Former Presidents, SVPs, VPs
  /about/secretariat             Administration and departments
  /about/careers
  /about/contact
/membership
  /membership/why-join           Benefits
  /membership/categories         Categories and dues (HTML table; PDF optional)
  /membership/apply              → portal application flow
  /membership/renew              → portal renewal flow
  /membership/directory          Searchable member directory
  /membership/directory/{slug}   Member profile
  /membership/faqs
/services
  /services/certificates-of-origin
  /services/attestation
  /services/visa-recommendation  [TBC: exact service list from Secretariat]
  /services/women-entrepreneurs
  /services/training
  /services/library              Internet Library, EDRC, WTO Reference Center [TBC]
  /services/forms                Forms library (filterable)
/advocacy
  /advocacy/positions            Policy positions (listing → detail)
  /advocacy/budget-proposals     Includes the yearly budget proposal form
  /advocacy/economy              Economic indicators dashboard
  /advocacy/research             Publications (listing → detail)
  /advocacy/business-confidence
/trade
  /trade/events                  Events calendar (listing → detail)
  /trade/delegations
  /trade/exhibitions
  /trade/inquiries               Trade inquiries (listing → detail)
  /trade/investment
  /trade/humanitarian-appeals
/news
  /news/press-releases           (listing → /news/{yyyy}/{mm}/{slug})
  /news/circulars                Circulars, SROs, notifications
  /news/galleries
  /news/videos
  /news/media-contacts
/portal                          Authenticated member area (see §7)
/ur/...                          Urdu mirror of every public route
```

### 4.2 Primary navigation
`About · Membership · Services · Advocacy · Trade & Events · Newsroom` plus `Search`, a **Join** button (primary) and a **Member login** link.

### 4.3 Footer
Contact block (address, phone, fax, department emails), quick tasks (Renew, Certificates, Circulars, Directory), social links, legal pages (Privacy, Terms, Accessibility) and a language switch. **No link may point to `#` or loop back to the homepage.**

### 4.4 Mapping old pages to the new structure

| Current | New location |
|---|---|
| President Message (`about.php?id=5`) | `/about/leadership` |
| Executive Committee (`excomm.php`) | `/about/leadership` |
| Former Presidents / SVPs / VPs | `/about/past-leadership` |
| EC Meetings (`about.php?id=135`) | `/about/leadership#meetings` or news tag [TBC] |
| Information / Research / Computer & Internet depts | `/about/secretariat` |
| LCCI Internet Library, EDRC, WTO Ref. Center | `/services/library` |
| Women Entrepreneur (`services.php?id=77`) | `/services/women-entrepreneurs` |
| Download Forms (`services.php?id=97`) | `/services/forms` |
| Trade Ordinance | `/news/circulars` (as a document) |
| Circulars / Notification (`business.php?id=88`) | `/news/circulars` |
| Training & Seminars (`business.php?id=134`) | `/trade/events?type=training` |
| LCCI Delegations (`business.php?id=92`) | `/trade/delegations` |
| Fairs and Exhibitions (`business.php?id=126`) | `/trade/exhibitions` |
| Trade Inquiries (`business.php?id=90`) | `/trade/inquiries` |
| Investment Opportunities (`business.php?id=87`) | `/trade/investment` |
| Humanitarian Appeals (`business.php?id=94`) | `/trade/humanitarian-appeals` |
| Membership Benefits (`members.php?id=83`) | `/membership/why-join` |
| Dues (`dues.pdf`) | `/membership/categories` |
| Member Directory + List of Valid Members | `/membership/directory` (merged; filter "valid/active") |
| Members Websites (`about.php?id=85`) | Website field on the member profile |
| Picture Gallery / AGM Pictures | `/news/galleries` |
| Useful Links (`about.php?id=96`) | Footer or `/about/contact#links` [TBC] |
| Press releases (`press.php?id=N`) | `/news/{yyyy}/{mm}/{slug}` |
| Lahore Chamber News (`about.php?id=113`) | `/news` |
| Business Confidence 2015 PDF | `/advocacy/business-confidence` (archive) |
| Memorandum 2026 PDF | Publication under `/advocacy/research` |
| Contact (`contact.php`) | `/about/contact` |

---

## 5. Content types (CMS models)

All types share these **base fields**: `id`, `title_en`, `title_ur`, `slug`, `status` (draft / in_review / published / archived), `published_at`, `updated_at`, `owner_department`, `seo_title`, `seo_description`, `og_image`, and taxonomy references (§6).

| Type | Specific fields | Listing / appears on |
|---|---|---|
| **PressRelease** | `summary`, `body` (rich text), `hero_image` (+alt), `gallery[]`, `spokesperson` → Person, `topics[]`, `related[]` | /news, home, topic pages |
| **Circular** | `issuing_body`, `reference_no` (e.g. SRO number), `issue_date`, `effective_date`, `file` (PDF), `summary`, `sectors[]`, `topics[]` | /news/circulars, member alerts |
| **Event** | `type` (seminar / training / AGM / delegation / exhibition), `start`, `end`, `venue`, `map`, `fee`, `capacity`, `speakers[]` → Person, `registration_open` (bool), `registration_deadline`, `gallery[]`, `video_url` | /trade/events, home, portal |
| **Publication** | `kind` (report / memorandum / survey / budget proposal), `year`, `summary`, `file`, `cover_image`, `topics[]` | /advocacy/research, search |
| **PolicyPosition** | `issue`, `chamber_ask`, `status` (raised / under review / accepted / resolved), `timeline[]`, `related_news[]`, `topics[]` | /advocacy/positions |
| **TradeInquiry** | `direction` (buy / sell / partner), `country`, `product`, `hs_code` (optional), `sectors[]`, `contact_via_chamber` (bool), `expires_at` | /trade/inquiries, member alerts |
| **MemberProfile** | `company_name`, `membership_no`, `category`, `status` (active / lapsed), `valid_until`, `business_types[]`, `sectors[]`, `products`, `address`, `city`, `phone`, `email`, `website`, `logo`, `verified` (bool), `show_in_directory` (bool) | /membership/directory |
| **Person** | `name`, `role`, `term_start`, `term_end`, `photo`, `bio`, `committees[]` | About, committees, events |
| **Notice** | `message`, `link`, `level` (info / urgent), `start_at`, `end_at` (**required**) | Home notice strip; hidden automatically after `end_at` |
| **Page** | `body`, `sections[]` (flexible blocks) | Static pages |
| **Form / Download** | `file`, `category`, `version`, `effective_from` | /services/forms |
| **Gallery** | `images[]` (+alt, caption), `event` → Event | /news/galleries |
| **Video** | `youtube_id`, `description`, `event` → Event | /news/videos |

**Rules**
- `published_at` is shown on every dated item.
- A `Notice` cannot be saved without `end_at`. At most one notice shows at a time, as a strip and never as a modal.
- Images cannot be published without alt text in both languages; the CMS enforces this.
- PDF-only content is discouraged. Key facts (dues, benefits, ordinance summaries) must also exist as HTML.

---

## 6. Taxonomies (categories)

One shared tag set drives menus, filters, search facets and member alerts.

| Taxonomy | Values (draft) | Used by |
|---|---|---|
| **Sector** | About 20 groups replacing the current 72 [TBC with the Research Dept], e.g. Textiles & Apparel, Food & Agriculture, Pharma & Chemicals, Engineering & Auto, IT & Digital, Construction & Real Estate, Energy, Leather & Footwear, Sports Goods, Surgical & Medical, Logistics & Aviation, Banking & Finance, Retail & Trading, Services, … | MemberProfile, Circular, TradeInquiry, Event |
| **Business type** | Manufacturer, Exporter, Importer, Trader, Services, Indenting Agent (drop "N/A") | MemberProfile |
| **Topic** | Taxation & Budget, Energy, Exports & Trade, Regulation, Law & Order, SMEs, Women Entrepreneurs, Infrastructure | PressRelease, PolicyPosition, Publication, Circular |
| **Audience** | Members, Prospective members, Foreign buyers, Investors, Media, Government | Pages, used to tune search and home modules |

**Migration of sectors:** build a lookup table from the 72 legacy values to the new groups (fix typos, merge duplicates). Keep the legacy value in `legacy_sector` for traceability. Optionally map to PSIC/ISIC codes [TBC].

---

## 7. Key user flows

### 7.1 New business joins
1. Home → **Join LCCI**
2. `/membership/categories`: pick a category and see the dues
3. `/portal/apply`: a multi-step form (company details → documents upload → declaration), with autosave
4. Pay online → receipt emailed → track status (Submitted → Under review → Approved / Need info)
- **Integration:** submits to the existing membership system [TBC API]; the status syncs back.

### 7.2 Member renews and requests a service
1. Login (email or membership number, plus OTP)
2. Dashboard shows membership status, `valid_until` and a renewal CTA when within 60 days
3. One-click renewal → pay → updated certificate (PDF)
4. Request a Certificate of Origin or attestation → upload documents → pay fee → track → download the signed copy [TBC: process with Secretariat]

### 7.3 Foreign buyer finds a supplier
1. `/membership/directory`: filter by sector and business type, plus a keyword
2. Member profile (verified badge, products, website)
3. "Send inquiry" form → stored as a lead → routed by the chamber to the member (contact details hidden by default) [TBC privacy policy]

### 7.4 Journalist or policymaker
Newsroom → filter by topic → press release → spokesperson and media contact, or Advocacy → position page → status and timeline.

---

## 8. Feature requirements

### 8.1 Public site
- **Homepage:** an optional notice strip, a hero (one campaign and two CTAs), four task tiles (Renew, Certificate, Circulars, Directory), latest dated news with images, upcoming events, and an "Economy at a glance" indicator strip. **No pop-ups, no duplicated slider.**
- **Site search:** full text across all types, with facets by type, sector, topic and year. Urdu tokenisation required.
- **Directory:** server-side filtering, pagination, result count, shareable filter URLs (`?sector=textiles&type=exporter`), and lapsed members hidden.
- **Events:** calendar and list views, registration with capacity limits, `.ics` download, and confirmation email.
- **Circular alerts:** members subscribe by sector and topic, with delivery by email and WhatsApp/SMS [TBC provider].
- **Economy dashboard:** indicators (exports, inflation, policy rate, KIBOR, PKR/USD) from an admin-managed dataset or an API [TBC source], each with a "last updated" stamp.
- **Sharing:** Open Graph and X cards on every content page, plus share buttons on news and events.
- **AI help desk (phase 2):** a retrieval-based assistant that answers only from published LCCI content (circulars, service pages, FAQs), cites its source pages and hands off to the department contact. All Q&A is logged for review. No answers on legal or tax specifics beyond quoting published circulars.

### 8.2 Member portal (`/portal`)
- Dashboard, profile and directory listing editor (changes moderated)
- Renewals, invoices and receipts
- Service requests with status tracking
- Event bookings
- Alert subscriptions
- Multiple users per company (owner plus staff) [TBC]

### 8.3 CMS and admin
- Roles: Super Admin, Department Editor (scoped to their sections), Reviewer, Media (news only), Membership Officer (portal and directory)
- Workflow: Draft → In review → Published, with scheduled publish and unpublish
- Content owner and "review by" date on every page; a stale-content report for items not updated in 12 months
- Full audit log of changes
- Media library with mandatory alt text and automatic image resizing

---

## 9. Technical requirements

**Stack: recommendation, to be finalised in Discovery**
- A headless or traditional CMS with structured content, roles and i18n (e.g. Strapi, Payload, Directus, or WordPress with ACF and Polylang)
- Frontend: a server-rendered framework (e.g. Next.js or Nuxt) or CMS-native themes
- Database: PostgreSQL or MySQL
- Search: Meilisearch, Typesense or OpenSearch (Urdu support required)
- Hosting: a managed VPS or cloud in-region, with a CDN in front

**Domains**
- One canonical domain [TBC: `lcci.org.pk` vs `lcci.com.pk`]; the other redirects with 301s
- The portal is served at `/portal` on the same domain, not a separate site

**URLs and redirects**
- Human-readable slugs and no query-ID URLs
- **301 redirect map for every legacy URL**, including all `press.php?id=N` (about 890), `about.php`, `services.php`, `business.php`, `members.php`, `directory*.php`, `excomm.php`, `presidents.php` and linked PDFs
- Custom 404 page with search; monitor 404s after launch and add redirects

**SEO**
- Unique `<title>` and meta description per page, canonical tags, `hreflang` (en / ur), an XML sitemap and robots.txt
- Schema.org markup: `Organization`, `NewsArticle`, `Event`, `BreadcrumbList`, `FAQPage`

**Performance**
- Lighthouse 90 or above (mobile) on Home, News detail and Directory
- LCP under 2.5 s on 4G, CLS under 0.1
- Responsive images (WebP/AVIF) and lazy loading

**Accessibility**
- WCAG 2.2 AA: keyboard navigation, visible focus, contrast, alt text, labelled forms and skip links
- Urdu pages use `dir="rtl"` with a proper Nastaliq or Naskh web font

**Security**
- HTTPS only with HSTS, a secure-headers set and CSP
- WAF and rate limiting on forms and login, plus CAPTCHA on public forms
- OTP or 2FA for portal login and admin accounts
- Payments through a PCI-DSS compliant local gateway [TBC with LCCI's bank]; no card data stored
- Daily encrypted backups with tested restore; privacy policy and consent for directory listings

**Integrations [TBC]**
- Existing membership system (API or database sync)
- Payment gateway
- SMS/WhatsApp provider, transactional email and newsletter tool
- YouTube and social embeds
- Analytics (GA4 or Matomo) with a leadership dashboard

---

## 10. Content migration

1. **Inventory:** crawl the current site and export every URL, title, date (where it can be recovered) and attachment.
2. **Classify:** map each item to a content type and the new taxonomy (sheet signed off by content owners).
3. **Clean:** fix typos, add missing dates and alt text, and retire stale items such as expired notices and outdated PDFs, which go to an archive.
4. **Import:** script the press releases (around 890), circulars, forms and member records; migrate pages by hand.
5. **Redirect:** generate the 301 map from the inventory, then test 100% of legacy URLs before go-live.
6. **Verify:** owners sign off their sections in staging.

---

## 11. Roadmap (indicative)

| Phase | Weeks | Deliverables |
|---|---|---|
| 1. Discover | 1–3 | Stakeholder interviews, content audit, final sitemap, integration assessment, analytics baseline |
| 2. Design | 4–7 | Visual identity for web, design system, clickable prototype, usability test with members |
| 3. Build | 8–16 | CMS models, templates, directory, search, portal and payments, migration scripts, redirects |
| 4. Launch | 17–20 | QA, training for content owners, go-live, post-launch fixes, monthly improvement cycle |

The public site can launch before the portal if integration takes longer. The legacy site stays live until cut-over.

---

## 12. Definition of done (launch checklist)

- [ ] 0 links to `#`, `javascript:void(0)` or unintended homepage loops (automated link check)
- [ ] 0 modal pop-ups on load
- [ ] 100% of press releases, circulars and events show a date
- [ ] Every page has a unique title and meta description
- [ ] Every image has alt text (en and ur)
- [ ] All legacy URLs return a 301 to the correct page (redirect test suite passes)
- [ ] Directory uses the new sector taxonomy (about 20 groups) with no duplicates or typos
- [ ] Join, renew and pay work end to end in production with a real transaction
- [ ] Lighthouse mobile scores of 90 or above (Performance, Accessibility, Best Practices, SEO) on key templates
- [ ] WCAG 2.2 AA audit passed
- [ ] Security scan (OWASP Top 10) passed; backups restored successfully in a test
- [ ] Content owners trained and named per section

## 13. Success metrics (tracked post-launch)

| Metric | Baseline | Target |
|---|---|---|
| Broken or looping links | 15 | 0 |
| Pop-ups on arrival | 4 | 0 |
| Dated press releases | 0% | 100% |
| Directory sectors | 72 | about 20 |
| Renewals paid online | [__%] | [__%] |
| Trade inquiries per month | [__] | [__] |

---

## 14. Open questions for Discovery

1. Canonical domain: `.org.pk` or `.com.pk`?
2. Membership system: vendor, API availability and data ownership
3. Payment gateway and bank partner
4. Final list of chamber services and their current offline processes (CoO, attestation, visa letters)
5. Who owns each section's content, and the review cadence
6. Directory privacy: which member fields are public by default
7. Source and update frequency for the economic indicators
8. Is Urdu required at launch for all content, or for key pages first?
9. Hosting constraints (local data residency, existing infrastructure)
10. Advertising policy: keep third-party banners (e.g. the current TÜV ads) or drop them?
