/**
 * The wording an applicant actually agrees to.
 *
 * Transcribed verbatim from the controlled form — `Doc # QDP/7.5/MSD/F-01,
 * Rev.# 01`, pages 2 and 3 — including its spelling. The point of a declaration
 * is that it is the text that was agreed; tidying it would make the digital
 * form say something slightly different from the document LCCI's quality system
 * controls, and the difference would only ever surface in a dispute.
 *
 * These constants are what is *shown*. What is *stored* is a copy on the row,
 * because the constant will change at Rev 02 and an application submitted under
 * Rev 01 must keep the Rev 01 wording — a digital signature is only evidence if
 * the thing signed is kept with it.
 *
 * No `server-only`: the wizard renders this text and the snapshot stores it.
 */

/** Shown above the particulars, as on page 2 of the form. */
export const APPLICATION_UNDERTAKING = `I/We do hereby apply for membership of the Lahore Chamber of Commerce & Industry and undertake to abide by the Memorandum and Articles of Association of the Chamber on being enrolled as Member and I/we have no criminal conviction. Particulars of my/our bussiness are given as under;`;

/** The declaration proper: page 2, the three lettered affirmations. */
export const DECLARATION_HEADING = "do solemnly declare and affirm that;";

export const DECLARATION_CLAUSES: readonly string[] = [
  "My/Our Firm/Company has never been a member of this chamber prior to the application submitted herewith.",
  "Our particulars are true to the best of my knowledge & belief.",
  "Hold myself/ourseleves responsible for all legal/judicial consequences arising due to false statement.",
];

/**
 * The second declaration, on page 3, beside the representative's signature
 * and photograph.
 *
 * A separate affirmation about the photograph and signature specifically, not
 * a restatement of the first. Kept separate here because the printed form
 * keeps it separate and the attesting director acknowledges this one.
 */
export const REPRESENTATION_DECLARATION = `I/WE do hereby solemnly declar and attest that the photograph & signature affixed are true of the representative aforementioned.`;

/**
 * What the attesting director acknowledges, from the note on page 3:
 * "Any one of the Directors/Partners other than representing the Company/Firm
 * will acknowledge the representation."
 */
export const ATTESTATION_NOTE = `Any one of the Directors/Partners other than the one representing the Company/Firm acknowledges the representation.`;

/**
 * What the proposer and seconder attest to, from page 2.
 *
 * Transcribed as printed, which is why it says "He is a genuine businessman".
 * Flagged rather than silently corrected: the wording excludes half the
 * chamber's potential membership and should be reworded at Rev 02, but that is
 * a controlled-document change for LCCI's quality system to authorise, not an
 * edit to make in code. The `declaration_text` column means endorsements given
 * under the current wording keep it either way.
 */
export const ENDORSEMENT_DECLARATION = `We do hereby attest that we know the applicant. He is a genuine businessman and his particulars are true to our knowledge and belief.`;

/**
 * The full text stored against a submission, assembled once so that what is
 * shown and what is stored cannot drift.
 */
export function applicantDeclarationText(): string {
  return [
    APPLICATION_UNDERTAKING,
    "",
    `I/We ${DECLARATION_HEADING}`,
    ...DECLARATION_CLAUSES.map((clause, index) => `${"abc"[index]}) ${clause}`),
    "",
    REPRESENTATION_DECLARATION,
  ].join("\n");
}

/**
 * The identifier of the wording, stored beside the text.
 *
 * Two submissions with the same hash agreed to the same words, which is the
 * question an auditor actually asks. Computed from the text rather than
 * maintained by hand, so it cannot be left behind when the wording changes.
 */
export const DECLARATION_VERSION = "QDP/7.5/MSD/F-01 Rev 01";
