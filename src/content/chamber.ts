/**
 * The chamber's own standing facts, in one place.
 *
 * Its address, telephone and founding year were written out three separate
 * times — in the footer, in the header's contact strip, and in the homepage's
 * `Organization` JSON-LD — and the contact page would have been a fourth. Four
 * copies of a postal address is three chances to update it and miss one, and
 * the copy most likely to be missed is the JSON-LD, because nobody looking at
 * the site can see it.
 *
 * **Every value here is quoted from lcci.com.pk, and the provenance is noted
 * per field.** That is not pedantry. The first version of this file was
 * assembled from the briefing documents and from inference, and when it was
 * finally checked against the live site four of its values were wrong: the
 * street name had lost a word, the postcode and province had been invented
 * outright, the telephone's international form had dropped Lahore's area code,
 * and the one email address the whole site offered does not exist. Each of
 * those was being published on every page, and two of them inside structured
 * data a search engine reads as authoritative.
 *
 * **Not a content type, and that is a decision rather than an omission.**
 * There is exactly one chamber at exactly one address; a CMS row for it would
 * add a workflow, a draft state and a publication date to a value that
 * changes roughly never, and the JSON-LD would then depend on a database read
 * on the one page where a build-time failure is least acceptable. When LCCI
 * does move, this is a one-line diff and a deploy, which is the right amount
 * of ceremony for the event.
 */

export const CHAMBER = {
  name: "Lahore Chamber of Commerce & Industry",
  shortName: "LCCI",
  /** Spec §2. The hero's "since 1923" and the JSON-LD both read it. */
  foundedYear: 1923,

  /**
   * The address exactly as lcci.com.pk/contact.php prints it.
   *
   * `postal` is the published string, kept whole and used wherever the address
   * is shown to a person, so what the site prints is what the chamber prints —
   * odd spacing included. The parts below it exist only because schema.org's
   * `PostalAddress` wants them separately.
   *
   * **No province and no postcode.** LCCI publishes neither. "Punjab" and
   * "54000" were in this file until they were checked; both were invented, and
   * an invented postcode inside JSON-LD is a wrong fact asserted to a search
   * engine in a machine-readable form. If LCCI confirms them they belong here
   * with a note saying who confirmed and when; until then the fields are
   * absent, which schema.org permits.
   */
  address: {
    postal: "11-Shahrah-e-Aiwan-e-Sanat-O Tijarat, Lahore -Pakistan",
    street: "11-Shahrah-e-Aiwan-e-Sanat-O Tijarat",
    locality: "Lahore",
    /** ISO 3166-1 alpha-2, which is what schema.org's `addressCountry` wants. */
    countryCode: "PK",
    country: "Pakistan",
  },

  /**
   * Three forms of the same number, because they are read by different things.
   *
   * `display` is the UAN as Lahore says it and as the chamber's own header
   * prints it. `published` is the full international form from the contact
   * page, for JSON-LD. `href` is that same number with the punctuation
   * stripped, which is what a `tel:` link needs in order to dial from a mobile
   * abroad — **including the 42**, which this file omitted until the contact
   * page was read, making every `tel:` link on the site undiallable from
   * outside Pakistan.
   */
  telephone: {
    display: "111-222-499",
    published: "+92-42-111-222-499",
    href: "tel:+924211122499",
  },

  /** As published on the contact page. */
  fax: "+92-42-36368854",

  /**
   * The only email addresses lcci.com.pk publishes.
   *
   * Quoted from the "Other ways to contact" table on `contact.php`, in the
   * order that table lists them — which puts the Vice President above the
   * Senior Vice President. That ordering is almost certainly a mistake on the
   * chamber's side, and it is reproduced rather than corrected, because the
   * running order of the chamber's own office bearers is theirs to fix and
   * doing it here would hide it.
   *
   * **There is no general address.** `info@lcci.org.pk` was used across this
   * site — in the empty-page panel, on the committee pages, on the contact
   * page — and it appears nowhere on lcci.com.pk; nor do the four
   * departmental addresses this repository previously listed in `nav-data.ts`
   * (`membership@`, `certificates@`, `research@`, `media@`). They were
   * plausible and invented, and an invented contact address is the worst kind
   * of wrong fact on a chamber's website: a member writes to it and is never
   * answered.
   *
   * So correspondence is directed at the Secretary General, which is a
   * published address and the right desk for it. If LCCI runs departmental
   * inboxes they should be added here and the departmental block in the footer
   * restored.
   */
  officeContacts: [
    { role: "President", email: "president@lcci.org.pk", extension: "301" },
    { role: "Vice President", email: "vp@lcci.org.pk", extension: "302" },
    { role: "Senior Vice President", email: "svp@lcci.org.pk", extension: "303" },
    { role: "Secretary General", email: "sect@lcci.org.pk", extension: "305" },
  ],

  /** Where to send anything with no more specific destination. */
  correspondenceEmail: "sect@lcci.org.pk",
} as const;

/**
 * The postal address as the lines a visitor would write on an envelope.
 *
 * The chamber publishes one line, so this splits it on its own comma rather
 * than recomposing it from parts — recomposing is how "Sanat-O" went missing.
 * The chamber's name is prepended, because an envelope needs it and the
 * published string does not carry it.
 */
export function addressLines(): readonly string[] {
  return [CHAMBER.name, ...CHAMBER.address.postal.split(",").map((part) => part.trim())];
}

/** Years since founding, for the "N years of advocacy" kind of statement. */
export function yearsSinceFounding(now = new Date()): number {
  return now.getUTCFullYear() - CHAMBER.foundedYear;
}
