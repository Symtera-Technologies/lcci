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
   * The grant, carrying the membership number.
   *
   * The number is in the body because it is the one piece of information the
   * applicant has been waiting weeks for, and because it is what they will
   * quote on everything afterwards. A message saying "your application has
   * been approved, sign in to see your number" generates a phone call to the
   * secretariat from every new member.
   *
   * `validUntil` is a civil date string the caller has already formatted, for
   * the same reason the deficiency template takes one: this date is printed on
   * the certificate, and a timezone conversion between here and the member's
   * screen would move 31 March to 30 March.
   *
   * The 31 March rule is stated rather than left to be discovered. A member
   * granted in February who finds out in April that they owe a renewal is a
   * complaint the chamber will field, and the form's own rule is the answer —
   * so it is said here, in the message that announces the grant, rather than
   * in a renewal notice six weeks later.
   */
  "application-approved": template<
    Localised & {
      reference: string;
      firmName: string;
      membershipNo: string;
      membershipClass: string;
      validUntil: string;
      note: string | null;
    }
  >({
    stream: "transactional",
    trigger: "An approver granted the membership.",
    render(payload) {
      const lines: string[] = [
        `The Lahore Chamber of Commerce & Industry has approved the membership ` +
          `application ${payload.reference} for ${payload.firmName}.`,
        "",
        `Membership number: ${payload.membershipNo}`,
        `Class: ${payload.membershipClass}`,
        `Valid until: ${payload.validUntil}`,
        "",
      ];

      if (payload.note) {
        lines.push(payload.note, "");
      }

      lines.push(
        "Membership expires on 31 March each year regardless of the date of",
        "grant, so the date above is the end of the current membership year and",
        "not twelve months from today. A renewal notice will follow before it.",
        "",
        "Please quote the membership number in any correspondence with the",
        "Chamber. Sign in at the Chamber's website with this email address to",
        "see your membership and download your certificate.",
        "",
        t("email.footer.doNotReply", undefined, localeOf(payload)),
      );

      // Both values are chamber-issued and newline-free by construction, so
      // these strips are insurance rather than a fix — the same insurance the
      // deficiency template takes, and for the same reason: whoever changes
      // the format of either later should not have to remember that one of
      // them reaches a mail header.
      const reference = payload.reference.replace(/[\r\n]+/g, " ").slice(0, 60);
      const number = payload.membershipNo.replace(/[\r\n]+/g, " ").slice(0, 40);

      return {
        subject: `Membership approved — ${number} (application ${reference})`,
        text: lines.join("\n"),
      };
    },
  }),

  /**
   * Confirmation that the form arrived, and what it is going to cost.
   *
   * The message §7.1 asked for, minus the word it used. The spec promises
   * "pay online → receipt emailed"; the fee is paid by pay order drawn on the
   * firm's own bank, so at submission nothing has been receipted — the
   * instrument is in an envelope and a cashier will compare it against the
   * account-maintenance certificate days later. Acknowledging money the
   * Chamber has not confirmed it holds is precisely what the separate
   * cashier's signature on page 2 of the form exists to prevent, so the fee is
   * *noted* here and `fee-receipted` is the real thing.
   *
   * The deadline is in it because the applicant paid for a tier. A
   * three-working-day Executive promise whose date the applicant cannot see is
   * not a promise, it is a price.
   */
  "application-received": template<
    Localised & {
      reference: string;
      firmName: string;
      membershipClass: string;
      processingTier: string;
      dueDate: string;
      fees: readonly { label: string; amount: string }[];
    }
  >({
    stream: "transactional",
    trigger: "An applicant submitted their membership application.",
    render(payload) {
      const lines: string[] = [
        "The Lahore Chamber of Commerce & Industry has received the membership",
        `application for ${payload.firmName}.`,
        "",
        `Your reference: ${payload.reference}`,
        `Class applied for: ${payload.membershipClass}`,
        `Processing: ${payload.processingTier}`,
        `Expected decision by: ${payload.dueDate}`,
        "",
        "Please quote the reference in any correspondence about this application.",
        "",
      ];

      if (payload.fees.length > 0) {
        lines.push("Fee noted with your application:");
        for (const fee of payload.fees) {
          lines.push(`  ${fee.label}: ${fee.amount}`);
        }
        lines.push(
          "",
          "This is not a receipt. The fee is paid by pay order, and a cashier has",
          "to compare it against your bank's account-maintenance certificate",
          "before it can be receipted. You will receive the receipt number by",
          "email when that is done.",
          "",
        );
      }

      lines.push(
        "What happens next. An officer checks the form and the attached documents",
        "against the Chamber's thirteen-point list. If anything is missing or",
        "unclear we will write to you with an itemised list, and the days you",
        "take to answer are not counted against the date above. There is nothing",
        "for you to do until then.",
        "",
        "You can see the progress of this application at any time by signing in",
        "at the Chamber's website with this email address.",
        "",
        t("email.footer.doNotReply", undefined, localeOf(payload)),
      );

      const reference = payload.reference.replace(/[\r\n]+/g, " ").slice(0, 60);

      return {
        subject: `Application received — ${reference}`,
        text: lines.join("\n"),
      };
    },
  }),

  /**
   * The fee receipt, once a cashier has issued one.
   *
   * The receipt *number* is the point. Finance reconciles bank statements
   * against it, the applicant quotes it when something goes wrong, and an
   * applicant who has to telephone to ask whether their pay order cleared is a
   * call the Chamber pays for twice — once to answer it, and once because the
   * officer answering it has stopped verifying files.
   *
   * It says "recorded" rather than "cleared". A receipted pay order is one the
   * Chamber has taken in and compared; whether the bank has actually realised
   * the funds is a different fact, and `payments.dishonoured` exists because
   * the two sometimes disagree weeks apart.
   */
  "fee-receipted": template<
    Localised & {
      reference: string;
      firmName: string;
      receiptNo: string;
      amount: string;
      receivedOn: string;
      instrumentNo: string | null;
    }
  >({
    stream: "transactional",
    trigger: "A cashier receipted a fee on the application.",
    render(payload) {
      const lines: string[] = [
        `The Chamber has recorded the membership fee for ${payload.firmName}.`,
        "",
        `Receipt number: ${payload.receiptNo}`,
        `Amount: ${payload.amount}`,
        `Received: ${payload.receivedOn}`,
      ];

      if (payload.instrumentNo) {
        lines.push(`Pay order: ${payload.instrumentNo}`);
      }

      lines.push(
        `Application: ${payload.reference}`,
        "",
        "Please keep the receipt number, and quote it rather than the pay order",
        "number in any query about this payment.",
        "",
        "Recording the fee is not the decision on your application. The Chamber",
        "will write to you separately when that is made.",
        "",
        t("email.footer.doNotReply", undefined, localeOf(payload)),
      );

      const receipt = payload.receiptNo.replace(/[\r\n]+/g, " ").slice(0, 40);
      const reference = payload.reference.replace(/[\r\n]+/g, " ").slice(0, 60);

      return {
        subject: `Fee receipted — ${receipt} (application ${reference})`,
        text: lines.join("\n"),
      };
    },
  }),

  /**
   * The refusal.
   *
   * A7 would not write this in passing and said so; this is it, written on
   * purpose. The approver's reason is carried verbatim, because the
   * alternative — "your application was not approved, please contact the
   * Chamber" — makes the secretariat's telephone the appeals process, and
   * because the officer was asked to write that sentence for this reader.
   *
   * Two silences are deliberate and both are LCCI's to break. There is no
   * appeal deadline or procedure, because LCCI has not defined one and
   * inventing a window for challenging a membership decision is not a
   * developer's call. And there is nothing about the fee beyond "we will
   * write": a refused application may carry a receipted pay order, the
   * disposition of that money is an open question, and a template that guessed
   * either way would be the Chamber committing to a refund policy nobody has
   * agreed.
   */
  "application-not-approved": template<
    Localised & {
      reference: string;
      firmName: string;
      reason: string;
      feeReceipted: boolean;
    }
  >({
    stream: "transactional",
    trigger: "An approver refused the application.",
    render(payload) {
      const lines: string[] = [
        "The Lahore Chamber of Commerce & Industry has not approved the",
        `membership application ${payload.reference} for ${payload.firmName}.`,
        "",
        "The reason recorded by the Chamber:",
        "",
        // The approver's own words, indented so a multi-line reason reads as
        // theirs rather than as ours.
        ...payload.reason.split(/\r?\n/).map((line) => `  ${line}`),
        "",
      ];

      if (payload.feeReceipted) {
        lines.push(
          "A fee has been recorded against this application. The Chamber will",
          "write to you separately about it.",
          "",
        );
      }

      lines.push(
        "If you believe this was decided on incomplete information, write to",
        "membership@lcci.com.pk quoting the reference above. You may also submit",
        "a fresh application; nothing in this decision prevents it.",
        "",
        t("email.footer.doNotReply", undefined, localeOf(payload)),
      );

      const reference = payload.reference.replace(/[\r\n]+/g, " ").slice(0, 60);

      return {
        subject: `Membership application ${reference} — not approved`,
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
