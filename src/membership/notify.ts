import "server-only";

import type { Queryable } from "@/db/client";
import { enqueue } from "@/server/mail/outbox";
import { formatDate, formatMoney } from "@/lib/format";
import type { MembershipClass, ProcessingTier } from "@/db/schema";
import { TIER_LABELS } from "@/membership/fees";

/**
 * What the applicant is told, and where it is sent.
 *
 * Two jobs, both of which were being done differently in three places before
 * this module existed.
 *
 * **One address rule.** The deficiency email went to
 * `application_company.email` — field 7 of the printed form — and the grant
 * email went to `users.email`, the account that signs in. Where those differ,
 * and they do differ whenever a clerk files on behalf of a director, the
 * Chamber was telling one person the application had been returned and a
 * different person that it had been approved. `applicantContact` is now the
 * only answer to "who do we write to", and it prefers the address the
 * applicant nominated on the form, because that is what the field is for.
 *
 * **One place to read what we send.** A reviewer asking "what mail does an
 * applicant get, and when?" should not have to read five transactions. The
 * answer is the four exported functions below plus the deficiency list, and
 * their absence is as deliberate as their presence — see `NOT_NOTIFIED`.
 *
 * Every function takes the caller's transaction, for the reason `enqueue`
 * documents: a message promising something that rolled back, and a state
 * change nobody was told about, are both worse than either failing alone.
 */

export interface ApplicantContact {
  /** Null where the form carries no address and the account has none either. */
  readonly email: string | null;
  readonly firmName: string;
  readonly reference: string;
}

/**
 * Where to write about this application, and what to call the firm.
 *
 * The form's declared address first, the signing-in account second. Not both:
 * two copies of a refusal arriving at one firm reads as a mistake, and the
 * applicant cannot tell which one the Chamber considers served.
 *
 * `COALESCE` in SQL rather than `??` in TypeScript so that an empty string —
 * which a form field can produce and a nullable column cannot distinguish from
 * an answer — is not treated as an address.
 */
export async function applicantContact(
  db: Queryable,
  applicationId: number,
): Promise<ApplicantContact | null> {
  const row = await db
    .selectFrom("applications")
    .leftJoin(
      "application_company",
      "application_company.application_id",
      "applications.id",
    )
    .leftJoin("users", "users.id", "applications.created_by")
    .select([
      "applications.public_ref",
      "application_company.firm_name",
      "application_company.email as form_email",
      "users.email as account_email",
    ])
    .where("applications.id", "=", applicationId)
    .executeTakeFirst();

  if (!row) return null;

  const formEmail = (row.form_email ?? "").trim();
  const accountEmail = (row.account_email ?? "").trim();

  return {
    email: formEmail || accountEmail || null,
    firmName: (row.firm_name ?? "").trim() || "your firm",
    reference: row.public_ref ?? `#${applicationId}`,
  };
}

/**
 * The stages that deliberately send no mail.
 *
 * Written down because "we forgot" and "we decided not to" look identical in a
 * codebase, and the next person to read the transition table will otherwise
 * add the missing ones.
 *
 * The rule: the Chamber writes when the applicant must act, or when the
 * outcome is decided. `under_review` is neither. It is real information — an
 * officer has picked the file up — and it belongs on the tracker, where the
 * applicant can look at it; as mail it arrives an hour after the receipt,
 * says nothing actionable, and spends deliverability that the sign-in codes
 * and the deficiency list depend on.
 */
export const NOT_NOTIFIED = ["draft", "under_review"] as const;

/* -------------------------------------------------------------------------- */
/* Submission                                                                 */
/* -------------------------------------------------------------------------- */

export interface SubmittedFee {
  readonly feeKind: "membership" | "itd_surcharge";
  readonly amount: string;
  readonly currency: string;
}

/**
 * The receipt §7.1 commits to, with the one word it must not use.
 *
 * The spec promises "pay online → receipt emailed". The fee is paid by pay
 * order drawn on the firm's own bank, so nothing is receipted at submission:
 * the instrument arrives with the form and a cashier compares it against the
 * account-maintenance certificate days later. Calling this message a receipt
 * would have the Chamber acknowledging money it has not yet confirmed it
 * holds, which is exactly the confusion a separate cashier's signature on
 * page 2 exists to prevent.
 *
 * So it confirms the application, states the fee as *noted* and names the real
 * receipt as a later message — `notifyFeeReceipted` below.
 */
export async function notifySubmitted(
  tx: Queryable,
  params: {
    readonly applicationId: number;
    readonly membershipClass: MembershipClass;
    readonly processingTier: ProcessingTier;
    readonly dueDate: string;
    readonly fees: readonly SubmittedFee[];
  },
): Promise<void> {
  const contact = await applicantContact(tx, params.applicationId);
  if (!contact?.email) return;

  await enqueue(
    {
      to: contact.email,
      template: "application-received",
      payload: {
        reference: contact.reference,
        firmName: contact.firmName,
        membershipClass:
          params.membershipClass === "corporate" ? "Corporate" : "Associate",
        processingTier: TIER_LABELS[params.processingTier],
        // A civil date string, formatted here. The template takes a string so
        // that the paid promise cannot be moved a day by a timezone between
        // this process and the applicant's screen.
        dueDate: formatDate(params.dueDate),
        fees: params.fees.map((fee) => ({
          label: fee.feeKind === "membership" ? "Membership fee" : "International Trade Development surcharge",
          amount: formatMoney(fee.amount, fee.currency),
        })),
      },
      entityType: "application",
      entityId: params.applicationId,
    },
    tx,
  );
}

/* -------------------------------------------------------------------------- */
/* The fee                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The real receipt, once a human has issued one.
 *
 * This is the message §7.1 meant and could not have at submission. It carries
 * the receipt number because that is the number finance reconciles bank
 * statements against, and because an applicant who has to telephone to ask
 * "did my pay order clear?" is a call the Chamber pays for twice.
 *
 * Not sent on a dishonoured instrument. A bounced pay order is a conversation,
 * not a notification: there is no replacement path in the system yet, so an
 * automatic message would tell the applicant their fee failed without telling
 * them what to do about it.
 */
export async function notifyFeeReceipted(
  tx: Queryable,
  params: {
    readonly applicationId: number;
    readonly receiptNo: string;
    readonly amount: string;
    readonly currency: string;
    readonly receivedOn: string;
    readonly instrumentNo: string | null;
  },
): Promise<void> {
  const contact = await applicantContact(tx, params.applicationId);
  if (!contact?.email) return;

  await enqueue(
    {
      to: contact.email,
      template: "fee-receipted",
      payload: {
        reference: contact.reference,
        firmName: contact.firmName,
        receiptNo: params.receiptNo,
        amount: formatMoney(params.amount, params.currency),
        receivedOn: formatDate(params.receivedOn),
        instrumentNo: params.instrumentNo,
      },
      entityType: "application",
      entityId: params.applicationId,
    },
    tx,
  );
}

/* -------------------------------------------------------------------------- */
/* Refusal                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The refusal notice A7 would not write in passing.
 *
 * It carries the approver's reason verbatim, because the alternative — "your
 * application was not approved, please contact the Chamber" — makes the
 * secretariat's telephone the appeals process.
 *
 * Two things it deliberately does not say. It does not describe an appeal
 * route, because LCCI has not defined one and inventing a deadline for
 * challenging a membership decision is not a developer's call. And it does not
 * promise anything about the fee: a refused application may have a receipted
 * pay order against it and the disposition of that money is an open question,
 * so the message says somebody will write about it rather than guessing which
 * way. Both gaps are LCCI's to fill, and both are stated here rather than
 * papered over with reassuring copy.
 */
export async function notifyNotApproved(
  tx: Queryable,
  params: {
    readonly applicationId: number;
    readonly reason: string;
    /** Whether any fee on this application has been receipted. */
    readonly feeReceipted: boolean;
  },
): Promise<void> {
  const contact = await applicantContact(tx, params.applicationId);
  if (!contact?.email) return;

  await enqueue(
    {
      to: contact.email,
      template: "application-not-approved",
      payload: {
        reference: contact.reference,
        firmName: contact.firmName,
        reason: params.reason,
        feeReceipted: params.feeReceipted,
      },
      entityType: "application",
      entityId: params.applicationId,
    },
    tx,
  );
}

/**
 * Whether the Chamber has taken money on this application, for the above.
 *
 * `dishonoured` counts. The firm wrote a pay order and believes it has paid;
 * that the instrument bounced is a separate conversation and not a reason to
 * send them a refusal that reads as though no fee was ever involved.
 */
export async function anyFeeReceipted(
  db: Queryable,
  applicationId: number,
): Promise<boolean> {
  const row = await db
    .selectFrom("payments")
    .select(["id"])
    .where("application_id", "=", applicationId)
    .where("state", "in", ["receipted", "dishonoured"])
    .executeTakeFirst();

  return row !== undefined;
}
