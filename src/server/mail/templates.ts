import { t, DEFAULT_LOCALE, type Locale } from "@/server/i18n";

/**
 * The message catalogue's email half, as a typed registry.
 *
 * Two things this shape buys, both of which matter more than they look:
 *
 * The outbox row stores a template *name* and a JSON payload, not a rendered
 * subject and body. A queued message therefore renders at send time against
 * the current catalogue, so fixing a typo in an email does not require fixing
 * it in a thousand queued rows. It also means the payload is the only thing
 * persisted — and the payloads are deliberately small, because `email_outbox`
 * is a table anyone with cPanel access can read, and "the applicant's full
 * particulars, rendered" is not something to leave sitting in a queue.
 *
 * And the payload type is checked at the call site. `enqueue({ template:
 * "sign-in-code", payload: { code } })` is a compile error if the payload is
 * wrong, which is the only mechanism that keeps a six-digit code from reaching
 * a template expecting a membership number once there are thirty templates.
 *
 * **Plain text only, deliberately.** Every message here is operational — a
 * code, a status change, an itemised deficiency list. HTML buys nothing for
 * those, costs an escaping sink on data that includes applicant-supplied firm
 * names, and reads as less legitimate to the spam filters that matter most for
 * exactly the mail that must not be filtered. The `html` field exists on the
 * message for the receipts Track B8 will need, and stays unused until then.
 */

export interface RenderedMessage {
  subject: string;
  text: string;
  html?: string;
}

interface TemplateDefinition<P> {
  /**
   * The provider stream. A property of the template, not of the call site:
   * whether a message is transactional is a fact about the message, and
   * letting callers choose is how a renewal broadcast ends up on the stream
   * whose reputation sign-in codes depend on.
   */
  readonly stream: "transactional" | "broadcast";
  /** One line on what causes this message, for whoever reads the queue. */
  readonly trigger: string;
  render(payload: P): RenderedMessage;
}

function template<P>(definition: TemplateDefinition<P>): TemplateDefinition<P> {
  return definition;
}

/** Payloads may carry a locale; absent means English. */
interface Localised {
  locale?: Locale;
}

function localeOf(payload: Localised): Locale {
  return payload.locale ?? DEFAULT_LOCALE;
}

export const TEMPLATES = {
  /**
   * The member sign-in code.
   *
   * The one message sent synchronously, because the login page must not say
   * "a code is on its way" when the provider rejected it. Carries the code and
   * nothing else — no name, no membership number — so a leaked queue row after
   * expiry discloses nothing, and so the message cannot be used to confirm who
   * an address belongs to.
   */
  "sign-in-code": template<Localised & { code: string }>({
    stream: "transactional",
    trigger: "A sign-in code was requested for this address or membership number.",
    render(payload) {
      const locale = localeOf(payload);
      return {
        subject: t("email.signInCode.subject", { code: payload.code }, locale),
        text: [
          t("email.signInCode.body", { code: payload.code }, locale),
          "",
          t("email.footer.doNotReply", undefined, locale),
        ].join("\n"),
      };
    },
  }),

  /**
   * The itemised deficiency list.
   *
   * The whole message is the list. A covering paragraph saying "your
   * application requires attention" and inviting the applicant to sign in to
   * find out why is the version that generates a phone call to the
   * secretariat, so every item the officer named is in the body, in their own
   * words, and the applicant can act on it from their inbox.
   *
   * No link to the portal and no reference to a document id: the applicant
   * signs in the way they always do. A one-click resume link in operational
   * mail is a credential, and this message goes to an address taken from a
   * form.
   *
   * `respondBy` is a civil date string, formatted by the caller. Not a
   * `Date` — a timezone conversion between here and the applicant's screen
   * would move a deadline by a day, and this is the deadline a
   * no-response closure is measured against.
   */
  "application-deficiency": template<
    Localised & {
      reference: string;
      firmName: string;
      summary: string | null;
      respondBy: string;
      items: readonly string[];
    }
  >({
    stream: "transactional",
    trigger: "An officer returned the application for more information.",
    render(payload) {
      const lines: string[] = [
        `Your membership application ${payload.reference} for ${payload.firmName} ` +
          `needs more information before the Lahore Chamber can continue.`,
        "",
      ];

      if (payload.summary) {
        lines.push(payload.summary, "");
      }

      lines.push("Please attend to the following:", "");
      payload.items.forEach((item, index) => {
        lines.push(`${index + 1}. ${item}`);
      });

      lines.push(
        "",
        `Please respond by ${payload.respondBy}. Sign in at the Chamber's ` +
          `website with this email address to upload the documents or correct ` +
          `the details above, then confirm that you are done.`,
        "",
        "Your processing time is on hold until you respond, so the working days",
        "you take are not counted against the Chamber's commitment to you.",
        "",
        t("email.footer.doNotReply", undefined, localeOf(payload)),
      );

      // The reference is Chamber-issued and newline-free by construction, so
      // this strip is insurance rather than a fix. It costs one call and
      // removes the need for whoever changes `public_ref`'s format later to
      // remember that it reaches a mail header.
      const reference = payload.reference.replace(/[\r\n]+/g, " ").slice(0, 60);

      return {
        subject: `Action needed on membership application ${reference}`,
        text: lines.join("\n"),
      };
    },
  }),

  /**
   * A deliverability probe.
   *
   * Exists because "is mail working?" must be answerable without triggering a
   * real flow. On a host with no monitoring stack, the alternative is finding
   * out that SPF broke when an applicant reports never receiving a code —
   * which is to say, finding out from the one person who cannot be told.
   *
   * `note` is echoed so a tester can correlate the message they received with
   * the send they triggered. It is truncated, because it reaches a subject
   * line and an unbounded string in a mail header is a header-injection
   * question nobody needs to answer.
   */
  "mail-test": template<{ note: string }>({
    stream: "transactional",
    trigger: "An administrator sent a test message to verify mail delivery.",
    render(payload) {
      const note = payload.note.replace(/[\r\n]+/g, " ").slice(0, 80);
      return {
        subject: `LCCI mail delivery test (${note})`,
        text: [
          "This is a test message from the LCCI website.",
          "",
          `Reference: ${note}`,
          "",
          "If you received it, outbound mail is working. Nothing else is implied —",
          "check SPF, DKIM and DMARC alignment separately, because a message can",
          "arrive and still be failing authentication.",
        ].join("\n"),
      };
    },
  }),
} as const;

export type TemplateName = keyof typeof TEMPLATES;

export type TemplatePayload<T extends TemplateName> =
  (typeof TEMPLATES)[T] extends TemplateDefinition<infer P> ? P : never;

export const TEMPLATE_NAMES = Object.keys(TEMPLATES) as TemplateName[];

/**
 * Render a queued row.
 *
 * The payload arrives from a JSON column, so it is `unknown` as far as the
 * type system is concerned no matter what the insert promised. A template
 * whose payload is malformed — a row written by an older revision of the code,
 * or hand-edited in phpMyAdmin — must produce a clear error rather than an
 * email reading "Your sign-in code is undefined".
 */
export function renderTemplate(
  name: string,
  payload: unknown,
): RenderedMessage & { stream: "transactional" | "broadcast" } {
  const definition = TEMPLATES[name as TemplateName] as
    | TemplateDefinition<unknown>
    | undefined;

  if (!definition) {
    throw new Error(`Unknown email template: ${safeName(name)}`);
  }

  if (!payload || typeof payload !== "object") {
    throw new Error(`Email payload for ${safeName(name)} is not an object`);
  }

  const rendered = definition.render(payload);

  // A subject containing a newline is a header-injection attempt or a bug, and
  // both must stop here rather than reach the provider.
  if (/[\r\n]/.test(rendered.subject)) {
    throw new Error(`Rendered subject for ${safeName(name)} contains a newline`);
  }

  return { ...rendered, stream: definition.stream };
}

/** Template names reach error messages; a hand-edited row's does not. */
function safeName(name: string): string {
  return /^[a-z0-9-]{1,60}$/.test(name) ? name : "<invalid>";
}
