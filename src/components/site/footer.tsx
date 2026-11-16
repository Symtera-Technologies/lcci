import { Fragment } from "react";
import Image from "next/image";
import Link from "next/link";
import { Mail, MapPin, Phone, Printer } from "lucide-react";
import { CHAMBER, addressLines } from "@/content/chamber";
import { Logo } from "./logo";
import { FOOTER_LEGAL, FOOTER_TASKS, PRIMARY_NAV, SOCIAL } from "./nav-data";

export function Footer() {
  return (
    // No top margin, deliberately. It carried `mt-24` and that was wrong in a
    // way only visible on the homepage: the closing band is `bg-ink-950`, the
    // same colour as this footer, so 96px of margin cut a white gash between
    // two identical dark surfaces. The space above the footer belongs to the
    // page — `main` already sets `pb-20`, which is the breathing room an
    // interior page ending in prose needs — and a page that chooses to end on
    // a dark band should flow straight into the dark footer.
    <footer className="bg-ink-950 text-ink-200">
      <div className="container-page py-16">
        <div className="grid gap-12 lg:grid-cols-12">
          {/* Contact block */}
          <div className="lg:col-span-4">
            <div className="flex items-center gap-5">
              <Logo onDark />
              {/* The anniversary seal, as a lockup with the wordmark rather
                  than floated somewhere on its own: it is a mark of standing
                  and it reads as one next to the name it belongs to.

                  **It is dated art.** The seal says "103 YEARS" and
                  "1923 — 2026", so it is right for one year and wrong after
                  that — unlike every other use of the chamber's age on this
                  site, which comes from `yearsSinceFounding()` in
                  src/content/chamber.ts. Replacing it is a yearly job:
                  scripts/prepare-anniversary-badge.mjs derives this file from
                  the supplied artwork and says what it does.

                  Not `aria-hidden`: the seal sets three facts in type that
                  appear nowhere else in the footer, so it is described rather
                  than hidden. */}
              <Image
                src="/brand/anniversary-103.png"
                alt="103 years of advocacy, 1923 to 2026"
                width={256}
                height={256}
                className="h-16 w-16 shrink-0 sm:h-[4.5rem] sm:w-[4.5rem]"
              />
            </div>

            <address className="mt-6 space-y-3 text-sm not-italic leading-relaxed">
              <p className="flex gap-3">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-brand-400" aria-hidden />
                <span>
                  {addressLines().map((line, i) => (
                    <Fragment key={line}>
                      {i > 0 ? <br /> : null}
                      {line}
                    </Fragment>
                  ))}
                </span>
              </p>
              <p className="flex gap-3">
                <Phone className="h-4 w-4 shrink-0 text-brand-400" aria-hidden />
                <a href={CHAMBER.telephone.href} className="hover:text-white">
                  {CHAMBER.telephone.display}
                </a>
              </p>
              <p className="flex gap-3">
                <Printer className="h-4 w-4 shrink-0 text-brand-400" aria-hidden />
                <span>{CHAMBER.fax}</span>
              </p>
            </address>

            {/* The chamber's own published addresses, which are its office
                bearers' — not departmental inboxes. Four plausible
                departmental addresses stood here until they were checked
                against lcci.com.pk, where none of them appears. */}
            <h3 className="mt-8 text-xs font-semibold uppercase tracking-[0.14em] text-ink-400">
              Write to the chamber
            </h3>
            <ul className="mt-3 space-y-2 text-sm">
              {CHAMBER.officeContacts.map((contact) => (
                <li key={contact.email} className="flex gap-3">
                  <Mail className="mt-0.5 h-4 w-4 shrink-0 text-ink-500" aria-hidden />
                  <span>
                    <span className="text-ink-400">{contact.role}: </span>
                    <a href={`mailto:${contact.email}`} className="hover:text-white">
                      {contact.email}
                    </a>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* Sitemap */}
          <div className="grid gap-8 sm:grid-cols-3 lg:col-span-5">
            {PRIMARY_NAV.slice(0, 3).map((section) => (
              <div key={section.href}>
                <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-400">
                  {section.label}
                </h3>
                <ul className="mt-3 space-y-2 text-sm">
                  {section.children.map((c) => (
                    <li key={c.href}>
                      <Link href={c.href} className="hover:text-white">
                        {c.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          {/* Quick tasks + social */}
          <div className="lg:col-span-3">
            <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-400">
              Quick tasks
            </h3>
            <ul className="mt-3 space-y-2 text-sm">
              {FOOTER_TASKS.map((t) => (
                <li key={t.href}>
                  <Link href={t.href} className="hover:text-white">
                    {t.label}
                  </Link>
                </li>
              ))}
            </ul>

            <h3 className="mt-8 text-xs font-semibold uppercase tracking-[0.14em] text-ink-400">
              Follow the chamber
            </h3>
            <ul className="mt-3 flex flex-wrap gap-2">
              {SOCIAL.map((s) => (
                <li key={s.href}>
                  <a
                    href={s.href}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex rounded-lg bg-white/5 px-3 py-1.5 text-sm ring-1 ring-inset ring-white/10 transition-colors hover:bg-white/10 hover:text-white"
                  >
                    {s.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-14 flex flex-col gap-4 border-t border-white/10 pt-6 text-sm sm:flex-row sm:items-center sm:justify-between">
          <p className="text-ink-400">
            © {new Date().getFullYear()} {CHAMBER.name}. Established{" "}
            {CHAMBER.foundedYear}.
          </p>
          <nav aria-label="Legal" className="flex flex-wrap items-center gap-x-6 gap-y-2">
            {FOOTER_LEGAL.map((l) => (
              <Link key={l.href} href={l.href} className="text-ink-400 hover:text-white">
                {l.label}
              </Link>
            ))}
            {/* The اردو switch was here too. Removed with the header's two,
                because `/ur` is not a route — see the note in
                src/components/site/header.tsx. */}
          </nav>
        </div>
      </div>
    </footer>
  );
}
