/**
 * The message catalogue.
 *
 * English ships at launch; Urdu is stored beside it from the start. The
 * decision was "English first, Urdu-ready by construction", and this file is
 * what makes the second half true rather than aspirational: every label,
 * validation message and email subject resolves through `t()`, so adding Urdu
 * later is a translation task against a known list of keys rather than a hunt
 * through sixty form fields, a dozen email templates and every error string.
 *
 * Retrofitting this is the expensive version of the same work, and the point
 * at which it becomes expensive is the point at which the application wizard
 * exists — so it goes in before the wizard, not after.
 *
 * What is deliberately NOT here: `/ur` routes, RTL layout, or a Nastaliq
 * webfont. Those are the launch-scope exclusions and they stay excluded. This
 * is the data layer of translation, nothing more.
 *
 * `ur: null` means "not yet translated", which is different from "the same in
 * both languages". `t()` falls back to English and the gap is countable — see
 * `untranslatedKeys()`.
 */

export type Locale = "en" | "ur";

export const DEFAULT_LOCALE: Locale = "en";

interface Message {
  en: string;
  /** null until the Information Department supplies the Urdu. */
  ur: string | null;
}

/**
 * Messages, grouped by area.
 *
 * Interpolation is `{name}`. Deliberately not a template literal type or a
 * full ICU implementation: plurals and gender in Urdu need a real library, and
 * introducing one before there is a single Urdu string would be choosing a
 * dependency to solve a problem nobody has yet described. When Urdu lands,
 * revisit — the keys will all be in one place by then, which is the point.
 */
const MESSAGES = {
  /* --- Authentication ---------------------------------------------------- */

  "auth.signIn.title": {
    en: "Sign in",
    ur: null,
  },
  /**
   * Said whether or not the identifier exists. The route also does the same
   * work in both cases — a dummy hash, a rate-limit row — so the response time
   * matches too. Membership numbers are sequential and guessable, which makes
   * this the one place where enumeration resistance is load-bearing.
   */
  "auth.signIn.sent": {
    en: "If that email address or membership number is registered, a sign-in code is on its way. It expires in 10 minutes.",
    ur: null,
  },
  "auth.code.invalid": {
    en: "That code is not right, or it has expired. Request a new one.",
    ur: null,
  },
  "auth.code.tooMany": {
    en: "Too many attempts. Request a new code in a few minutes.",
    ur: null,
  },
  "auth.code.wrongBrowser": {
    en: "Open the link in the same browser you asked for the code from.",
    ur: null,
  },
  "auth.session.ended": {
    en: "Your session has ended. Sign in again to continue.",
    ur: null,
  },
  "auth.session.rolesChanged": {
    en: "Your account permissions changed. Sign in again to continue.",
    ur: null,
  },

  /* --- Email ------------------------------------------------------------- */

  "email.signInCode.subject": {
    en: "Your LCCI sign-in code: {code}",
    ur: null,
  },
  "email.signInCode.body": {
    en: "Your sign-in code is {code}.\n\nIt expires in 10 minutes and can be used once. If you did not ask for it, you can ignore this message — nobody can sign in without it.\n\nLahore Chamber of Commerce & Industry",
    ur: null,
  },
  "email.footer.doNotReply": {
    en: "This message was sent automatically. Please do not reply to it.",
    ur: null,
  },

  /* --- Validation -------------------------------------------------------- */

  "validation.required": { en: "This is required.", ur: null },
  "validation.email": { en: "Enter a valid email address.", ur: null },
  /** The printed form prints boxes with dashes; we store the 13 digits. */
  "validation.cnic": {
    en: "A CNIC is 13 digits, with no dashes.",
    ur: null,
  },
  "validation.ntn": { en: "Enter the NTN as issued.", ur: null },
  "validation.amount": { en: "Enter an amount in rupees.", ur: null },
  "validation.tooLong": { en: "This is longer than {max} characters.", ur: null },

  /* --- Documents --------------------------------------------------------- */

  "upload.tooLarge": {
    en: "That file is {size}, which is over the {max} limit. A 300 dpi scan of one page is usually well under it.",
    ur: null,
  },
  "upload.wrongType": {
    en: "Upload a PDF, JPEG, PNG or WebP. Other formats are not accepted.",
    ur: null,
  },
  /**
   * Said without explaining the sniff. The honest version — "the contents do
   * not match the extension" — is accurate but reads as an accusation to the
   * majority of people who hit it by renaming a file, and tells the minority
   * who did it deliberately exactly which check to work around.
   */
  "upload.contentMismatch": {
    en: "That file could not be read as a PDF or an image. Try exporting or scanning it again.",
    ur: null,
  },
  /**
   * Said with the number, because "too small" without one leaves the applicant
   * guessing which of their files to re-scan and at what setting.
   */
  "upload.tooSmall": {
    en: "That image is too small to read reliably. Scan or photograph the document again at a higher resolution — at least 300 pixels on the shorter edge.",
    ur: null,
  },
  "upload.tooManyPages": {
    en: "That PDF has more than {max} pages. Upload only the pages this document needs.",
    ur: null,
  },
  /**
   * A password-protected PDF is refused rather than accepted, because its
   * contents cannot be inspected — and a document nobody can verify is useless
   * to a verification process.
   */
  "upload.pdfEncrypted": {
    en: "That PDF is password-protected, so it cannot be checked or reviewed. Upload an unprotected copy.",
    ur: null,
  },
  "upload.quota": {
    en: "This application has reached its limit of {files} documents or {max} in total. Remove something before adding more.",
    ur: null,
  },
  "upload.pdfActiveContent": {
    en: "That PDF contains embedded scripts or attachments, so it cannot be accepted. Re-export it as a plain PDF, or upload a scan instead.",
    ur: null,
  },

  /* --- Generic ----------------------------------------------------------- */

  "error.unexpected": {
    en: "Something went wrong on our side. Please try again — if it keeps happening, quote reference {reference}.",
    ur: null,
  },
  "error.unverifiedRequest": {
    en: "This request could not be verified. Reload the page and try again.",
    ur: null,
  },
  "error.concurrent": {
    en: "{what} has changed since this page was loaded. Reload and try again.",
    ur: null,
  },
} as const satisfies Record<string, Message>;

export type MessageKey = keyof typeof MESSAGES;

export const MESSAGE_KEYS = Object.keys(MESSAGES) as MessageKey[];

/**
 * Resolve a message.
 *
 * Falls back to English when the Urdu is missing rather than rendering the key
 * or an empty string. A half-translated page in two languages is awkward; a
 * page showing `auth.signIn.sent` to an applicant is broken.
 */
export function t(
  key: MessageKey,
  values?: Record<string, string | number>,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const message = MESSAGES[key];
  const template = (locale === "ur" ? message.ur : message.en) ?? message.en;

  if (!values) return template;

  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = values[name];
    return value === undefined ? whole : String(value);
  });
}

/** Keys with no Urdu yet. The translation worklist, and a countable gap. */
export function untranslatedKeys(): MessageKey[] {
  return MESSAGE_KEYS.filter((key) => MESSAGES[key].ur === null);
}

/** Placeholder names a message expects, so a test can check the call sites. */
export function placeholdersFor(key: MessageKey): string[] {
  const found = new Set<string>();
  for (const locale of ["en", "ur"] as const) {
    const template = MESSAGES[key][locale];
    if (!template) continue;
    for (const match of template.matchAll(/\{(\w+)\}/g)) found.add(match[1]);
  }
  return [...found].sort();
}
