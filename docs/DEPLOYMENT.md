# Deploying to cPanel (Node.js app manager + MySQL)

Target: cPanel running the app under **Phusion Passenger**, with MySQL.
Server type (shared vs VPS with root) is not yet confirmed, so everything here
is written to the shared-cPanel floor — anything that runs there also runs on a
VPS.

---

## 1. Why the build happens off-box

`next build` routinely exceeds the per-application memory ceiling on shared
cPanel plans. Build on a developer machine or in CI, then ship the artefact.

**The build needs a reachable database, and fails without one.** Since
migration 0016 the public pages read their content from MySQL rather than from
fixtures, and they are statically prerendered — so the machine running
`npm run build` has to connect to a database holding the published content,
with the same `DB_*` variables the server uses.

An **unreachable** database fails the build, and Next reports the driver's own
error against the page it was prerendering:

```
Error occurred prerendering page "/"
Error: connect ECONNREFUSED 127.0.0.1:3306
```

That is the correct outcome — far better than shipping an empty homepage — but
it says nothing about which setting is wrong, so check first:

```bash
npm ci
npm run db:check     # names the problem in a second, and the fix
npm run build
```

An **empty** database does not fail the build. It produces a site with empty
sections and no error, because the repository has no fixture fallback by
design. `db:check` warns about that case too, and exits non-zero.

### Connecting on cPanel

`ECONNREFUSED 127.0.0.1:3306` on this host almost always means one of two
things, and neither looks like a mistake in the configuration:

- **MySQL listens on a unix socket and refuses TCP.** `mysql2` is not the PHP
  or C client: those read the literal host `localhost` as "use the socket",
  `mysql2` resolves it to 127.0.0.1 and dials TCP. So copying "Host:
  localhost" out of the cPanel panel produces exactly this error. Set
  `DB_SOCKET` instead — find it with `mysqladmin variables | grep '  socket'`,
  usually `/var/lib/mysql/mysql.sock`. It wins over `DB_HOST` and `DB_PORT`.
- **The build shell has no environment.** Variables entered in cPanel’s
  Node.js app screen belong to the running application and are **not** exported
  into an SSH session. `next build` reads `.env` and `.env.local` from the
  application root, so a build run over SSH sees only those files — and
  `DB_HOST`/`DB_PORT` silently fall back to 127.0.0.1:3306 while `DB_USER` and
  the rest come from wherever they were set.

Either way this is **not only a build problem**: the running application
connects the same way, so a host the build cannot reach is a host the site
cannot serve from.

If you are building off-box, the database still has to be reachable from the
build machine: an SSH tunnel to production is the straightforward answer, and
a restored dump is the alternative. Remote MySQL on cPanel is per-IP and has
to be allowed for the build machine explicitly.

**After every release, the prerendered pages hold whatever database the build
saw.** They are rebuilt on the server, from the server’s own database, only
when something revalidates them — and `content-revalidate` only fires when a
scheduled publication or take-down time crosses. If nothing is scheduled, the
build-time content persists. Publish or re-save one item after a deploy, or
accept that the site shows the build machine’s content until something does.

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
   in the application root. **Copy `.env.example` and fill it in**; it is the
   contract `src/server/env.ts` validates at load, and a missing REQUIRED value
   is a 503 on the first request that needs it rather than a default. The
   minimum that will boot:

   ```
   NODE_ENV=production
   SITE_ORIGIN=https://staging.lcci.com.pk
   DB_HOST=127.0.0.1
   DB_PORT=3306
   DB_USER=
   DB_PASSWORD=
   DB_NAME=
   PRIVATE_UPLOAD_ROOT=/home/USER/lcci-documents
   ENCRYPTION_KEY=
   IP_HASH_PEPPER=
   CRON_SECRET=
   ```

   Generate the three secrets with
   `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`,
   and create `PRIVATE_UPLOAD_ROOT` by hand at mode 0700, outside the
   application root. Staging needs its own `ENCRYPTION_KEY`: sharing
   production's would mean a staging compromise decrypting production's
   identity documents.

4. **tmp directory** — `mkdir -p ~/lcci/tmp`. Passenger watches
   `tmp/restart.txt`.

---

## 3. Each release

Over SSH, from the application root:

```bash
git pull origin master
rm -rf .next
# upload or rsync the built .next/standalone, .next/static and public
cp -r .next/standalone/. .
touch tmp/restart.txt
```

`touch tmp/restart.txt` is the restart — do not kill the process by hand, as
Passenger will simply respawn the old one.

Migrations are **never** run by the deploy. Run them yourself, once the files
are in place and before the restart:

```bash
npm run migrate:status
npm run migrate
```

Forward-only and checksummed, so a file edited after it was applied is refused
rather than silently skipped. Where SSH is unavailable, the numbered `.sql`
files under `migrations/` paste straight into phpMyAdmin in order.

### Cron, once per environment

Nothing on a schedule runs without it: no outgoing email, no SLA recompute, and
no revalidation, so a published page never reaches the served HTML. Set it up
when the environment is first built, and again whenever a job is added.

```bash
umask 077 && printf '%s' "$CRON_SECRET" > ~/.lcci-cron-secret
npm run cron:print -- --origin=https://staging.example.com
```

Paste the output into cPanel’s cron editor. It is generated from
`src/server/jobs/schedule.ts`, so the crontab cannot quietly fall behind the
code — which is how a job ends up never having run in production and nobody
finding out. Check `date` over SSH first: the server’s timezone is often not
Asia/Karachi, and the overnight jobs are written in local time.

### Staging specifically

Same procedure, four differences that matter:

- **Its own database and its own secrets.** Never point staging at the
  production database: the admin can publish, archive and delete, and nothing
  in the application knows which database it is talking to.
- **Seed it.** `npm run seed:rbac` creates the roles and permissions, then
  `npm run seed:content` loads the launch content. Without the first, nobody
  can sign in to anything.
- **A first staff account.** `npm run dev:staff -- name@lcci.org.pk "Full Name"
  super_admin` prints a password once. Two-factor is off by default; turn it on
  at `/admin/security`, or require it from `/admin/users`.
- **Keep it out of search.** Staging serves the same pages as production and
  will be indexed if it is reachable; put HTTP auth in front of it at the
  cPanel level, which also stops an AI crawler reading draft copy.

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
  time until something regenerates it. The `content-revalidate` job runs every
  ten minutes, asks whether any publication or take-down time has passed since
  it last looked, and marks the site for rebuild when one has.

  **So the schedule is accurate to the revalidation interval, and no better.**
  Ten minutes is the number to give LCCI: a press release timed for 9:00 is
  live by 9:10, and an expired notice is gone within ten minutes of its window
  closing. Tell them the figure rather than let them infer a precision the
  system does not have — and if they need the hour exactly, that is a change
  to one line in `src/server/jobs/schedule.ts` and to the crontab, not a
  rebuild.

  **If cron is not wired up, nothing on a schedule happens at all.** The rows
  are still right; the served HTML is whatever was last built. On staging that
  usually means an editor publishes something and cannot see it, which is a
  missing crontab line, not a bug.

---

## 5. Still to decide

- Canonical domain: `lcci.com.pk` or `lcci.org.pk` (spec §14.1). The 301 map for
  ~890 legacy press URLs depends on it.
- Whether a CDN (Cloudflare) sits in front. Without one, the Lighthouse ≥90
  mobile target in spec §9 is not realistically reachable on shared hosting.
