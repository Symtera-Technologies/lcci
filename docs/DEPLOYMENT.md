# Deploying to cPanel (Node.js app manager + MySQL)

Target: cPanel running the app under **Phusion Passenger**, with MySQL.
Server type (shared vs VPS with root) is not yet confirmed, so everything here
is written to the shared-cPanel floor — anything that runs there also runs on a
VPS.

---

## 1. Why the build happens off-box

`next build` routinely exceeds the per-application memory ceiling on shared
cPanel plans. Build on a developer machine or in CI, then ship the artefact.

**The build needs a reachable database.** Since migration 0016 the public pages
read their content from MySQL rather than from fixtures, and they are
statically prerendered — so the machine running `npm run build` has to be able
to connect to a database holding the published content, with the same
`DB_*` variables the server uses. A build against an empty or unreachable
database produces a site with empty sections rather than an error, because the
repository has no fixture fallback by design. Pointing the build at production
over an SSH tunnel is the straightforward answer; a restored dump is the
alternative when the tunnel is not available.

```bash
npm ci
npm run build
```

That produces:

| Path | Purpose |
|---|---|
| `.next/standalone/` | the server and a pruned `node_modules` |
| `.next/static/` | hashed client assets |
| `public/` | static files served as-is |

`output: "standalone"` in `next.config.ts` is what makes this self-contained.

---

## 2. One-time cPanel setup

1. **Node.js app** — cPanel → *Setup Node.js App* → Create Application:
   - Application root: `lcci`
   - Application URL: the site's domain
   - Application startup file: `server.js`
   - Node version: 20 LTS or newer
2. **Database** — cPanel → *MySQL Databases*: create the database and a user,
   grant all privileges, and note the credentials for `.env`.
3. **Environment** — add variables in the Node.js app screen, or place a `.env`
   in the application root:

   ```
   NODE_ENV=production
   NEXT_PUBLIC_SITE_URL=https://lcci.com.pk
   DATABASE_URL=mysql://user:pass@localhost:3306/dbname
   ```

4. **tmp directory** — `mkdir -p ~/lcci/tmp`. Passenger watches
   `tmp/restart.txt`.

---

## 3. Each release

Over SSH, from the application root:

```bash
git pull origin main
rm -rf .next
# upload or rsync the built .next/standalone, .next/static and public
cp -r .next/standalone/. .
touch tmp/restart.txt
```

`touch tmp/restart.txt` is the restart — do not kill the process by hand, as
Passenger will simply respawn the old one.

---

## 4. Things that will bite

- **Static assets 404 after deploy.** `.next/static` is *not* inside
  `.next/standalone`; it has to be copied alongside it. Same for `public/`.
- **App unreachable.** Passenger assigns the port. Never hardcode 3000.
- **Image optimisation OOM.** `sharp` is memory-hungry on shared plans. If the
  optimiser starts failing, set `images.unoptimized = true` and pre-size images
  at build time instead.
- **No background daemons.** A self-hosted Meilisearch/Typesense process is not
  available here, which is why search sits behind an adapter and ships on MySQL
  `FULLTEXT` first.
- **Scheduled publish/unpublish** needs no cron for *correctness*: a row is
  public when `status = 'published'`, its `published_at` has passed and its
  `scheduled_unpublish_at` has not, and the repository asks that question in
  SQL on every read. The same is true of notice expiry, which is a window on
  two columns.

  What cron is for is **cache revalidation**. The public pages are prerendered,
  so "evaluated on read" means evaluated when the page is rendered — at build
  time until something regenerates it. Until the revalidation route lands
  (plan item B4), a notice whose window closes, or a press release timed for
  Friday, does not change the served HTML on its own. Two things follow:
  editorial changes made in the admin are not live until the site is rebuilt
  or revalidated, and the schedule is only as accurate as the revalidation
  interval. Say so to LCCI rather than let them discover it with an expired
  notice on the homepage.

---

## 5. Still to decide

- Canonical domain: `lcci.com.pk` or `lcci.org.pk` (spec §14.1). The 301 map for
  ~890 legacy press URLs depends on it.
- CMS: **not Payload** — it ships no MySQL adapter. Directus is the current
  recommendation; Strapi 5 and headless WordPress are the alternatives.
- Whether a CDN (Cloudflare) sits in front. Without one, the Lighthouse ≥90
  mobile target in spec §9 is not realistically reachable on shared hosting.
