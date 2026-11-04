import type { Metadata } from "next";
import { CmsPage, cmsMetadata } from "@/components/site/cms-page";
import { ChamberContact, OfficeContacts } from "@/components/site/contact-blocks";
import { ContactForm } from "@/components/site/contact-form";
import { navEntry } from "@/components/site/nav-data";
import { SectionFooter } from "@/components/site/section-index";
import { pageSlug } from "@/content/page-slug";
import { sendEnquiry } from "./actions";

/**
 * How to reach the chamber.
 *
 * This page used to carry a written refusal to build a contact form, on the
 * grounds that a form posting nowhere is worse than a published address,
 * because the visitor believes they have been heard. The condition it set for
 * building one was "a staff inbox and an owner for it". That condition is now
 * met and the form is here: `src/server/enquiries.ts` commits the enquiry
 * before it queues the mail, `/admin/enquiries` is where staff read what the
 * mail server did not deliver, and `enquiry.read` is the grant that names the
 * owner.
 *
 * The addresses stay, beside the form rather than under it. They are still
 * the faster route for anyone who knows which desk they want, and the three
 * journeys with real handlers of their own — a trade inquiry, a membership
 * application, a service request — are still sent to those handlers, now by
 * the form itself when the topic is chosen.
 */
const PATH = "/about/contact" as const;

const PAGE = {
  ...navEntry(PATH),
  description:
    "Write to the chamber, or use its address, switchboard and departmental email addresses.",
  slug: pageSlug(PATH),
  path: PATH,
  missing: "visiting hours and directions",
} as const;

export function generateMetadata(): Promise<Metadata> {
  return cmsMetadata(PAGE);
}

export default function ContactPage() {
  return (
    <CmsPage
      {...PAGE}
      header="feature"
      footer={
        <SectionFooter section="/about" exclude={PATH} title="More about the chamber" />
      }
    >
      {/* The form leads and the addresses sit beside it, because most people
          arriving here do not know which desk they want — that is why they
          are on a contact page. Anyone who does know reads straight past it
          to the right-hand column, which is why the column is not collapsed
          behind a toggle. Below `lg` the form comes first in source order and
          therefore first on the page, which is the right order on a phone. */}
      <div className="grid gap-12 lg:grid-cols-12 lg:gap-16">
        <section aria-labelledby="write-to-us" className="lg:col-span-7">
          <h2
            id="write-to-us"
            className="font-display text-xl font-semibold text-ink-950"
          >
            Write to the chamber
          </h2>
          <p className="mt-2 max-w-[60ch] text-[0.9375rem] leading-relaxed text-ink-700">
            Anything that does not have a form of its own. You will get a
            confirmation with a reference straight away, and a reply from a
            member of staff after that.
          </p>

          <ContactForm action={sendEnquiry} />
        </section>

        <div className="space-y-12 lg:col-span-5">
          <ChamberContact />
          <OfficeContacts />
        </div>
      </div>
    </CmsPage>
  );
}
