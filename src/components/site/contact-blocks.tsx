import { Mail, MapPin, Phone, Printer } from "lucide-react";
import { CHAMBER, addressLines } from "@/content/chamber";

/**
 * The chamber's own contact details, and the addresses it publishes.
 *
 * Two blocks rather than one, because both the secretariat page and the
 * contact page need the list of addresses and only the contact page needs the
 * postal address — a visitor who reached "Secretariat" looking for the
 * certificates desk should not have to read the switchboard number first.
 *
 * Everything here is quoted from `src/content/chamber.ts`, which in turn
 * quotes lcci.com.pk and records where each value came from. Nothing on this
 * page is editable in the CMS, deliberately: see that file's header for why
 * one chamber at one address is configuration rather than content.
 *
 * **The extensions are shown.** The chamber publishes them beside each
 * address, and they are the difference between reaching a person and reaching
 * a switchboard — so dropping them because they made the table wider would be
 * dropping the useful part.
 */

const ROW = "flex gap-3 text-[0.9375rem] leading-relaxed text-ink-800";
const ICON = "mt-0.5 h-4 w-4 shrink-0 text-brand-600";
const LINK =
  "font-medium text-brand-800 underline decoration-brand-400 decoration-2 underline-offset-4 " +
  "transition-colors hover:decoration-brand-700 " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-700";

/** Postal address, switchboard and fax. */
export function ChamberContact() {
  return (
    <section aria-labelledby="chamber-contact" className="max-w-[68ch]">
      <h2
        id="chamber-contact"
        className="font-display text-xl font-semibold text-ink-950"
      >
        The chamber
      </h2>

      <address className="mt-4 space-y-3 not-italic">
        <p className={ROW}>
          <MapPin className={ICON} aria-hidden />
          <span>
            {addressLines().map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
          </span>
        </p>
        <p className={ROW}>
          <Phone className={ICON} aria-hidden />
          <span>
            <a href={CHAMBER.telephone.href} className={LINK}>
              {CHAMBER.telephone.display}
            </a>{" "}
            {/* The international form, for anyone dialling from outside
                Pakistan — the UAN alone does not connect from abroad. */}
            <span className="text-ink-600">({CHAMBER.telephone.published})</span>
          </span>
        </p>
        <p className={ROW}>
          <Printer className={ICON} aria-hidden />
          {/* Not a link: there is nothing useful for a browser to do with a
              fax number, and `fax:` is not a scheme anything honours. */}
          <span>{CHAMBER.fax}</span>
        </p>
      </address>
    </section>
  );
}

/** One row per published address, with the role it reaches and its extension. */
export function OfficeContacts({ heading = "Who to write to" }: { heading?: string }) {
  return (
    <section aria-labelledby="office-contacts" className="max-w-[68ch]">
      <h2
        id="office-contacts"
        className="font-display text-xl font-semibold text-ink-950"
      >
        {heading}
      </h2>

      <dl className="mt-4 divide-y divide-stone-200 border-y border-stone-200">
        {CHAMBER.officeContacts.map((contact) => (
          <div
            key={contact.email}
            className="grid gap-1 py-3 sm:grid-cols-[14rem_minmax(0,1fr)]"
          >
            <dt className="font-medium text-ink-900">{contact.role}</dt>
            <dd className="flex min-w-0 flex-wrap items-baseline gap-x-3">
              <a href={`mailto:${contact.email}`} className={`${LINK} break-words`}>
                {contact.email}
              </a>
              <span className="text-[0.8125rem] text-ink-600">
                ext. {contact.extension}
              </span>
            </dd>
          </div>
        ))}
      </dl>

      <p className="mt-4 flex gap-3 text-[0.9375rem] leading-relaxed text-ink-700">
        <Mail className={ICON} aria-hidden />
        <span>
          Anything that does not fit one of these goes to the Secretary General
          at{" "}
          <a href={`mailto:${CHAMBER.correspondenceEmail}`} className={LINK}>
            {CHAMBER.correspondenceEmail}
          </a>
          , or telephone the chamber on{" "}
          <a href={CHAMBER.telephone.href} className={LINK}>
            {CHAMBER.telephone.display}
          </a>
          .
        </span>
      </p>
    </section>
  );
}
