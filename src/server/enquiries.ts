import "server-only";

import { randomInt } from "node:crypto";
import { getDb } from "@/db/client";
import { hashIp, hashUserAgent } from "@/server/crypto";
import { enqueue } from "@/server/mail/outbox";
import { log, logError } from "@/server/log";
import { CHAMBER } from "@/content/chamber";
import { contactTopicLabel } from "@/content/contact-topics";
import { formatDate, formatTime } from "@/lib/format";
import { requirePermission, type ActorContext } from "@/server/actor";

/**
 * What the website's contact form does with what it is given.
 *
 * The order of operations is the design: **commit the row, then queue the
 * mail.** Both are needed and only one of them is reliable. The email is how
 * staff find out an enquiry exists; the row is how the enquiry survives an
 * SMTP password the host rotated, a certificate that expired overnight, or a
 * provider that started refusing the domain. Doing it the other way round —
 * send, and record if that worked — loses exactly the messages nobody knows
 * to look for.
 *
 * It also means the visitor is told "we have it" on the strength of a
 * committed transaction rather than on the strength of a queue entry, which
 * is the difference between a true statement and a hopeful one.
 */

/* -------------------------------------------------------------------------- */
/* References                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * No I, O, S or Z, and no vowels.
 *
 * The reference gets read down a telephone and typed back, so the characters
 * that are confused for each other in that exchange are left out. Dropping
 * vowels as well costs a little entropy and guarantees the generator cannot
 * produce a reference that reads as a word — which, from a random source and
 * over enough enquiries, it eventually would, and some of those words the
 * chamber would not want quoted back to it.
 */
const REFERENCE_ALPHABET = "0123456789BCDFGHJKLMNPQRTVWXY";

/**
 * A short, unguessable reference.
 *
 * `LC-` plus six characters from a 29-character alphabet: about 29^6, so
 * roughly 600 million. Not derived from the row id, deliberately. A
 * sequential reference tells anyone who submits twice how much mail the
 * chamber receives, and invites trying the neighbours.
 *
 * `randomInt` rather than `Math.random`, because this is the only thing
 * identifying a message in correspondence, and because a modulo of a weak
 * source is the kind of shortcut that is invisible until it matters.
 */
export function newEnquiryReference(): string {
  let out = "";
  for (let index = 0; index < 6; index += 1) {
    out += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  }
  return `LC-${out}`;
}

/* -------------------------------------------------------------------------- */
/* Where enquiries are sent                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The mailbox that receives enquiries.
 *
 * `CONTACT_INBOX` when set, so LCCI can point the form at a shared
 * secretariat inbox without a deploy — which they will want to do, because
 * the right destination for this is an operational decision and not a code
 * one. Otherwise the correspondence address the chamber already publishes,
 * which is the honest default: it is where "anything that does not fit"
 * already goes, and it is on the contact page above the form.
 */
export function enquiryInbox(): string {
  const configured = process.env.CONTACT_INBOX?.trim();
  return configured && configured.includes("@")
    ? configured
    : CHAMBER.correspondenceEmail;
}

/* -------------------------------------------------------------------------- */
/* Recording                                                                  */
/* -------------------------------------------------------------------------- */

export interface EnquiryInput {
  name: string;
  email: string;
  phone: string | null;
  organisation: string | null;
  topic: string;
  message: string;
}

export interface EnquiryContext {
  ip: string | null;
  userAgent: string | null;
}

export interface RecordedEnquiry {
  id: number;
  reference: string;
  /** False when the row was stored but the notification could not be queued. */
  notified: boolean;
}

/**
 * Store an enquiry and queue the two messages it produces.
 *
 * Retries once on a reference collision and then gives up. At 29^6 a
 * collision is already a curiosity rather than an expectation, so a loop with
 * a bound of two is the right amount of machinery: the unique key is what
 * actually guarantees correctness, and this is only here so the one visitor
 * in several million who hits it is not shown an error.
 *
 * The two sends are queued, not awaited. `enqueue` writes a row and drains it
 * inside `after()`, so the happy path still delivers within a second of the
 * response — but a provider that hangs for ten seconds does not hold a
 * Passenger worker open while somebody waits on a thank-you page.
 *
 * A failure to queue is logged and reported, never thrown. The enquiry is
 * already committed at that point, and turning a successful submission into
 * an error message would invite the visitor to send it again — which is how
 * the chamber ends up with three copies of a complaint and no idea which one
 * to answer.
 */
export async function recordEnquiry(
  input: EnquiryInput,
  context: EnquiryContext,
): Promise<RecordedEnquiry> {
  const db = getDb();

  let id = 0;
  let reference = "";

  for (let attempt = 0; attempt < 2 && id === 0; attempt += 1) {
    reference = newEnquiryReference();
    try {
      const inserted = await db
        .insertInto("contact_messages")
        .values({
          reference,
          topic: input.topic,
          sender_name: input.name,
          sender_email: input.email,
          sender_phone: input.phone,
          organisation: input.organisation,
          body: input.message,
          locale: "en",
          ip_hash: hashIp(context.ip),
          user_agent_hash: hashUserAgent(context.userAgent),
        })
        .executeTakeFirst();

      id = Number(inserted.insertId ?? 0);
    } catch (error) {
      // Only a duplicate reference is worth another go. Anything else — a
      // column too short, the database refusing the connection — is a real
      // failure and must reach the action's catch rather than be retried into
      // the same wall.
      if (!isDuplicateKey(error) || attempt === 1) throw error;
    }
  }

  const now = new Date();
  const topicLabel = contactTopicLabel(input.topic);

  let notified = false;

  try {
    const outboxId = await enqueue({
      to: enquiryInbox(),
      template: "contact-enquiry",
      payload: {
        reference,
        name: input.name,
        email: input.email,
        phone: input.phone,
        organisation: input.organisation,
        topic: topicLabel,
        message: input.message,
        receivedAt: `${formatDate(now.toISOString())} at ${formatTime(now.toISOString())}`,
      },
      entityType: "contact_message",
      entityId: id,
    });

    await db
      .updateTable("contact_messages")
      .set({ outbox_id: outboxId })
      .where("id", "=", id)
      .execute();

    notified = true;
  } catch (error) {
    logError("could not queue the contact enquiry notification", error, {
      count: id,
    });
  }

  try {
    // The sender's own copy, queued separately so that a failure to
    // acknowledge does not take the chamber's notification with it. Of the
    // two, this is the one that may be lost: the enquiry is recorded and the
    // chamber has been told, and the sender will hear from a person.
    await enqueue({
      to: input.email,
      template: "contact-acknowledgement",
      payload: {
        reference,
        name: input.name,
        topic: topicLabel,
        message: input.message,
        telephone: CHAMBER.telephone.display,
      },
      entityType: "contact_message",
      entityId: id,
    });
  } catch (error) {
    logError("could not queue the contact acknowledgement", error, { count: id });
  }

  // The topic and whether mail was queued. Not the name, the address or a
  // word of the message: this log is read by whoever is debugging the form,
  // which is not the same set of people as those entitled to read the post.
  log.info("contact enquiry recorded", { template: input.topic, outcome: notified ? "queued" : "stored" });

  return { id, reference, notified };
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ER_DUP_ENTRY"
  );
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

export interface EnquiryRow {
  id: number;
  reference: string;
  topic: string;
  senderName: string;
  senderEmail: string;
  senderPhone: string | null;
  organisation: string | null;
  body: string;
  receivedAt: string;
  /** How the notification to the chamber fared, or null if it was never queued. */
  delivery: string | null;
}

export interface EnquiryQuery {
  topic?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

/**
 * The enquiries, newest first, for the staff screen.
 *
 * Joined to `email_outbox` so the screen can say whether the notification
 * actually left. That is the column that makes the page worth opening on a
 * quiet day: a list of enquiries tells you what came in, and a list of
 * enquiries whose mail says `dead` tells you that the form has been working
 * and the inbox has not.
 *
 * The permission is checked here rather than only at the route, because this
 * function is as publicly addressable as the page is once something imports
 * it. The route's own policy entry is the second lock, not the first.
 */
export async function listEnquiries(
  actor: ActorContext,
  query: EnquiryQuery = {},
): Promise<EnquiryRow[]> {
  requirePermission(actor, "enquiry.read");

  const rows = await getDb()
    .selectFrom("contact_messages")
    .leftJoin("email_outbox", "email_outbox.id", "contact_messages.outbox_id")
    .select([
      "contact_messages.id",
      "contact_messages.reference",
      "contact_messages.topic",
      "contact_messages.sender_name",
      "contact_messages.sender_email",
      "contact_messages.sender_phone",
      "contact_messages.organisation",
      "contact_messages.body",
      "contact_messages.created_at",
      "email_outbox.state as delivery",
    ])
    .$if(Boolean(query.topic), (qb) =>
      qb.where("contact_messages.topic", "=", query.topic ?? ""),
    )
    .$if(Boolean(query.search), (qb) =>
      qb.where((eb) =>
        eb.or(
          SEARCHED_COLUMNS.map((column) => eb(column, "like", likeTerm(query.search ?? ""))),
        ),
      ),
    )
    .orderBy("contact_messages.created_at", "desc")
    .limit(Math.min(200, Math.max(1, query.limit ?? 50)))
    .offset(Math.max(0, query.offset ?? 0))
    .execute();

  return rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    topic: row.topic,
    senderName: row.sender_name,
    senderEmail: row.sender_email,
    senderPhone: row.sender_phone,
    organisation: row.organisation,
    body: row.body,
    receivedAt: new Date(row.created_at).toISOString(),
    delivery: row.delivery ?? null,
  }));
}

export async function countEnquiries(
  actor: ActorContext,
  query: EnquiryQuery = {},
): Promise<number> {
  requirePermission(actor, "enquiry.read");

  const row = await getDb()
    .selectFrom("contact_messages")
    .select(({ fn }) => fn.countAll<number>().as("total"))
    .$if(Boolean(query.topic), (qb) =>
      qb.where("contact_messages.topic", "=", query.topic ?? ""),
    )
    .$if(Boolean(query.search), (qb) =>
      qb.where((eb) =>
        eb.or(
          SEARCHED_COLUMNS.map((column) => eb(column, "like", likeTerm(query.search ?? ""))),
        ),
      ),
    )
    .executeTakeFirst();

  return Number(row?.total ?? 0);
}

/**
 * The columns a staff search looks in, named once.
 *
 * The list and the count have to apply the same predicate — a count that
 * disagrees with its own list is how a paginated screen grows a page that is
 * always empty — and this constant plus `likeTerm` is what keeps them
 * honest without a shared builder that neither Kysely nor the reader enjoys.
 *
 * The body is in the list because staff search for the thing somebody
 * mentioned, not for their address.
 */
const SEARCHED_COLUMNS = [
  "contact_messages.reference",
  "contact_messages.sender_name",
  "contact_messages.sender_email",
  "contact_messages.body",
] as const;

/**
 * A `LIKE` pattern from a staff search box.
 *
 * `%` and `_` are escaped, because they are wildcards the person typing did
 * not ask for — and an unescaped `%` in a search over a table of
 * correspondence quietly returns every row.
 */
function likeTerm(search: string): string {
  return `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}
