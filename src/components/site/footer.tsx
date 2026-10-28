import Link from "next/link";
import { Mail, MapPin, Phone, Printer } from "lucide-react";
import { Logo } from "./logo";
import {
  DEPARTMENTS,
  FOOTER_LEGAL,
  FOOTER_TASKS,
  PRIMARY_NAV,
  SOCIAL,
} from "./nav-data";

export function Footer() {
  return (
    <footer className="mt-24 bg-ink-950 text-ink-200">
      <div className="container-page py-16">
        <div className="grid gap-12 lg:grid-cols-12">
          {/* Contact block */}
          <div className="lg:col-span-4">
            <Logo onDark />

            <address className="mt-6 space-y-3 text-sm not-italic leading-relaxed">
              <p className="flex gap-3">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-brand-400" aria-hidden />
                <span>
                  Lahore Chamber of Commerce &amp; Industry
                  <br />
                  11 Shahrah-e-Aiwan-e-Tijarat
                  <br />
                  Lahore 54000, Punjab, Pakistan
                </span>
              </p>
              <p className="flex gap-3">
                <Phone className="h-4 w-4 shrink-0 text-brand-400" aria-hidden />
                <a href="tel:+92111222499" className="hover:text-white">
                  111-222-499
                </a>
              </p>
              <p className="flex gap-3">
                <Printer className="h-4 w-4 shrink-0 text-brand-400" aria-hidden />
                <span>+92 42 3636 8854</span>
              </p>
            </address>

            <h3 className="mt-8 text-xs font-semibold uppercase tracking-[0.14em] text-ink-400">
              Departments
            </h3>
            <ul className="mt-3 space-y-2 text-sm">
              {DEPARTMENTS.map((d) => (
                <li key={d.email} className="flex gap-3">
                  <Mail className="mt-0.5 h-4 w-4 shrink-0 text-ink-500" aria-hidden />
                  <span>
                    <span className="text-ink-400">{d.name}: </span>
                    <a href={`mailto:${d.email}`} className="hover:text-white">
                      {d.email}
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
            © {new Date().getFullYear()} Lahore Chamber of Commerce &amp; Industry.
            Established 1923.
          </p>
          <nav aria-label="Legal" className="flex flex-wrap items-center gap-x-6 gap-y-2">
            {FOOTER_LEGAL.map((l) => (
              <Link key={l.href} href={l.href} className="text-ink-400 hover:text-white">
                {l.label}
              </Link>
            ))}
            <Link
              href="/ur"
              lang="ur"
              dir="rtl"
              className="text-ink-400 hover:text-white"
            >
              اردو
            </Link>
          </nav>
        </div>
      </div>
    </footer>
  );
}
