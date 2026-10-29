import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, sql } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { newUlid } from "@/server/crypto";
import type { ActorContext } from "@/server/actor";
import type { PermissionCode } from "@/server/permissions";
import { sealField } from "@/membership/sensitive";
import {
  beginVerification,
  completeChecklist,
  loadVerification,
  saveChecklist,
} from "@/membership/verification";
import {
  DEFICIENCY_RESPONSE_WORKING_DAYS,
  outstandingFor,
  raiseDeficiency,
  recordApplicantResponse,
} from "@/membership/deficiency";
import { authorizeUpload } from "@/membership/uploads";
import { ingestDocument } from "@/server/documents/ingest";
import { createUser, databaseAvailable, resetTables, skipReason, teardown } from "./helpers";

/**
 * The verification loop, against the database.
 *
 * The pure half of this module is tested as arithmetic in
 * `tests/membership-checklist.test.ts`. What is left is everything the
 * arithmetic cannot show: that a round is immutable once signed, that the next
 * round is round two rather than an edit of round one, that a deficiency stops
 * the paid clock and restarts it having charged the applicant for the days
 * they held it, that it unlocks exactly the document it named and nothing
 * else, and that a replacement scan retires its predecessor instead of
 * becoming a second live copy of the same CNIC.
 *
 * Every one of those is a claim about rows, and several are claims about rows
 * written by two statements that must agree.
 */

const available = await databaseAvailable();
if (!available) {
  console.warn(`[integration] skipping verification tests: ${await skipReason()}`);
}

if (available) await runMigrations("integration-test");

afterAll(teardown);

const TABLES = [
  "verification_item_documents",
  "verification_checklist_items",
  "verification_checklists",
  "deficiency_items",
  "application_deficiencies",
  "document_access_log",
  "documents",
  "submission_snapshots",
  "application_required_documents",
  "application_state_transitions",
  "application_company",
  "sla_pauses",
  "sla_clocks",
  "applications",
  "email_outbox",
  "audit_log",
  "users",
];

/** The thirteen codes in printed order. Items 1 and 13 are the defects. */
const CODES = [
  "incomplete_form",
  "letterhead_signed",
  "cnic_readable",
  "ntn_title",
  "bank_certificate",
  "partnership_deed",
  "secp_documents",
  "utility_bill",
  "photographs",
  "endorser_standing",
  "company_stamp",
  "pay_order",
  "signature_mismatch",
] as const;

function staffActor(
  userId: number,
  permissions: readonly PermissionCode[],
  roleCode = "membership_officer",
): ActorContext {
  return {
    userId,
    userType: "staff",
    roleCode,
    roleCodes: [roleCode],
    permissions: new Set(permissions),
    departmentScopes: [],
    requestId: newUlid(),
    ipHash: "a".repeat(64),
    userAgentHash: "b".repeat(64),
    onBehalfOfUserId: null,
  };
}

function memberActor(userId: number): ActorContext {
  return {
    userId,
    userType: "portal",
    roleCode: null,
    roleCodes: [],
    permissions: new Set(),
    departmentScopes: [],
    requestId: newUlid(),
    ipHash: "c".repeat(64),
    userAgentHash: "d".repeat(64),
    onBehalfOfUserId: null,
  };
}

const OFFICER: readonly PermissionCode[] = [
  "application.read",
  "application.verify",
  "application.raise_deficiency",
];

/**
 * A calendar with every day a working day.
 *
 * Deliberately featureless: this file's subject is the checklist and the
 * deficiency round, and the holiday arithmetic is somebody else's test. A
 * calendar where every day counts makes "the fifteenth working day" a date
 * this file can compute in one line, so a wrong answer here is a bug in the
 * code rather than in the fixture.
 */
async function seedCalendar(fromDaysAgo = 30, days = 400): Promise<void> {
  const start = new Date(Date.now() - fromDaysAgo * 86_400_000);
  const rows = Array.from({ length: days }, (_, index) => ({
    cal_date: new Date(start.getTime() + index * 86_400_000).toISOString().slice(0, 10),
    is_working_day: 1,
    label_en: null,
    source: "integration-test",
    notified_on: null,
    updated_at: new Date(),
  }));

  await getDb().deleteFrom("working_day_calendar").execute();

  for (let at = 0; at < rows.length; at += 100) {
    await getDb()
      .insertInto("working_day_calendar")
      .values(rows.slice(at, at + 100))
      .execute();
  }
}

function isoDaysFromToday(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/** A JPEG with an APP0 segment before the frame header, as a real one has. */
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.alloc(18);
  app0.writeUInt16BE(0xffe0, 0);
  app0.writeUInt16BE(16, 2);
  app0.write("JFIF\0", 4, "latin1");

  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(8, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);

  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

function bodyOf(bytes: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

interface Fixture {
  applicationId: number;
  applicantId: number;
  officerId: number;
  cnicDocumentId: string;
}

/**
 * One submitted Partnership application, with a running clock and one CNIC.
 *
 * Inserted directly rather than driven through the wizard. The submit
 * transition has its own test; what this file needs is the row shape submit
 * leaves behind — in particular the *frozen* required-document matrix, which
 * is what `gatherChecklistFacts` reads and what makes the system's advice on
 * the thirteen items mean anything.
 */
async function fixture(options: { state?: string } = {}): Promise<Fixture> {
  const db = getDb();

  const applicantId = await createUser(`applicant-${randomUUID()}@example.com.pk`, "portal");
  const officerId = await createUser(`officer-${randomUUID()}@lcci.org.pk`);

  const inserted = await db
    .insertInto("applications")
    .values({
      state: (options.state ?? "SUBMITTED") as never,
      created_by: applicantId,
      membership_class: "corporate",
      processing_tier: "regular",
      company_status_code: "partnership",
      public_ref: `LCCI-T-${Math.floor(Math.random() * 1e6)}`,
      submitted_at: new Date(),
    })
    .executeTakeFirstOrThrow();

  const applicationId = Number(inserted.insertId);

  const sealed = sealField(
    "application_company",
    applicationId,
    "representative_cnic",
    "35202-1234567-1",
  );

  await db
    .insertInto("application_company")
    .values({
      application_id: applicationId,
      firm_name: "Ravi Textiles",
      representative_name: "A. Representative",
      representative_cnic_enc: sealed.enc,
      representative_cnic_hmac: sealed.hmac,
      email: "office@ravitextiles.example.com.pk",
    })
    .execute();

  // The frozen matrix, as submit writes it: what a Partnership owes.
  await db
    .insertInto("application_required_documents")
    .values(
      [
        { code: "letterhead_application", count: 1 },
        { code: "cnic", count: 2 },
        { code: "ntn_certificate", count: 1 },
        { code: "partnership_deed", count: 1 },
        { code: "utility_bill", count: 1 },
        { code: "bank_certificate", count: 1 },
        { code: "photo", count: 1 },
        { code: "pay_order", count: 1 },
      ].map((row) => ({
        application_id: applicationId,
        document_type_code: row.code,
        cardinality: "one" as const,
        required_count: row.count,
      })),
    )
    .execute();

  await db
    .insertInto("sla_clocks")
    .values({
      application_id: applicationId,
      processing_tier: "regular",
      working_days: 40,
      started_at: new Date(),
      due_date: isoDaysFromToday(40),
    })
    .execute();

  const cnicDocumentId = await putDocument(applicationId, officerId, {
    typeCode: "cnic",
    subjectKind: "representative",
    subjectId: null,
  });

  return { applicationId, applicantId, officerId, cnicDocumentId };
}

async function putDocument(
  applicationId: number,
  uploadedBy: number,
  options: {
    typeCode: string;
    subjectKind: "company" | "representative" | "director" | "endorser" | "payment";
    subjectId: number | null;
    uploadedAt?: Date;
  },
): Promise<string> {
  const id = randomUUID();

  await getDb()
    .insertInto("documents")
    .values({
      id,
      application_id: applicationId,
      membership_id: null,
      document_type_code: options.typeCode,
      subject_kind: options.subjectKind,
      subject_id: options.subjectId,
      original_filename: `${options.typeCode}.jpg`,
      storage_key: `aa/${randomUUID()}.jpg`,
      mime_type: "image/jpeg",
      byte_size: 1024,
      sha256: "0".repeat(64),
      pixel_width: 1240,
      pixel_height: 1754,
      page_count: null,
      issued_on: null,
      cipher_version: 1,
      uploaded_by: uploadedBy,
      uploaded_at: options.uploadedAt ?? new Date(),
    })
    .execute();

  return id;
}

/** Record that the officer opened a document, as the serve route's log does. */
async function logView(documentId: string, userId: number): Promise<void> {
  await getDb()
    .insertInto("document_access_log")
    .values({
      document_id: documentId,
      user_id: userId,
      outcome: "served",
      range_header: null,
      ip_hash: "a".repeat(64),
      request_id: newUlid(),
    })
    .execute();
}

/** Decide all thirteen, ticking whichever are named. */
function allItems(ticked: readonly string[], documentIds: readonly string[] = []) {
  return CODES.map((code) => ({
    itemCode: code,
    marked: ticked.includes(code),
    notApplicable: false,
    // A note on everything, so a `note_required` refusal cannot be what a
    // test is accidentally measuring.
    note: "Checked against the attached scan.",
    documentIds: code === "cnic_readable" ? documentIds : [],
  }));
}

describe.skipIf(!available)("verification rounds", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
    await seedCalendar();
  });

  it("opens round 1 and picks the application up", async () => {
    const { applicationId, officerId } = await fixture();
    const officer = staffActor(officerId, OFFICER);

    const begun = await beginVerification(officer, applicationId);
    expect(begun.round).toBe(1);

    const application = await getDb()
      .selectFrom("applications")
      .select(["state", "assigned_to"])
      .where("id", "=", applicationId)
      .executeTakeFirstOrThrow();

    expect(application.state).toBe("UNDER_VERIFICATION");
    // Picking it up claims it. An unassigned application under verification is
    // one nobody is accountable for.
    expect(Number(application.assigned_to)).toBe(officerId);
  });

  it("refuses an item that requires a document view until the officer has opened one", async () => {
    const { applicationId, officerId, cnicDocumentId } = await fixture();
    const officer = staffActor(officerId, OFFICER);
    await beginVerification(officer, applicationId);

    const first = await saveChecklist(officer, {
      applicationId,
      items: allItems([], [cnicDocumentId]),
    });

    expect(first.ok).toBe(false);
    expect(first.refusals.map((refusal) => refusal.itemCode)).toEqual(["cnic_readable"]);
    expect(first.refusals[0].reason).toBe("not_viewed");
    // The other twelve are still recorded. A single refused item must not
    // throw away the officer's work on the rest of the page.
    expect(first.savedCount).toBe(12);

    await logView(cnicDocumentId, officerId);

    const second = await saveChecklist(officer, {
      applicationId,
      items: allItems([], [cnicDocumentId]),
    });

    expect(second.ok).toBe(true);
    expect(second.savedCount).toBe(13);
  });

  it("refuses to sign a round off while an item is undecided", async () => {
    const { applicationId, officerId } = await fixture();
    const officer = staffActor(officerId, OFFICER);
    await beginVerification(officer, applicationId);

    // Twelve of thirteen. An untouched defect row would otherwise read as "no
    // defect found" by omission, asserting a judgement nobody made.
    await saveChecklist(officer, {
      applicationId,
      items: allItems([]).filter((item) => item.itemCode !== "signature_mismatch"),
    });

    const refused = await completeChecklist(officer, applicationId);
    expect(refused.ok).toBe(false);
    expect(refused.undecided).toContain(13);
  });

  it("records a round with items 1 and 13 ticked as deficient", async () => {
    const { applicationId, officerId, cnicDocumentId } = await fixture();
    const officer = staffActor(officerId, OFFICER);
    await beginVerification(officer, applicationId);
    await logView(cnicDocumentId, officerId);

    // Everything ticked. On a "checked = good" reading this is the cleanest
    // possible round; what it actually records is an incomplete form whose
    // signatures do not match the CNIC.
    await saveChecklist(officer, {
      applicationId,
      items: allItems([...CODES], [cnicDocumentId]),
    });

    const completed = await completeChecklist(officer, applicationId);
    expect(completed.ok).toBe(true);
    expect(completed.outcome).toBe("deficient");

    const row = await getDb()
      .selectFrom("verification_checklists")
      .select(["round", "state", "outcome", "completed_by"])
      .where("application_id", "=", applicationId)
      .executeTakeFirstOrThrow();

    expect(row.state).toBe("completed");
    expect(row.outcome).toBe("deficient");
    expect(Number(row.completed_by)).toBe(officerId);

    const failed = await getDb()
      .selectFrom("verification_checklist_items")
      .select(["item_code"])
      .where("outcome", "=", "fail")
      .execute();

    expect(failed.map((item) => item.item_code).sort()).toEqual([
      "incomplete_form",
      "signature_mismatch",
    ]);
  });

  it("freezes a completed round and writes one audit event carrying all thirteen items", async () => {
    const { applicationId, officerId, cnicDocumentId } = await fixture();
    const officer = staffActor(officerId, OFFICER);
    await beginVerification(officer, applicationId);
    await logView(cnicDocumentId, officerId);
    await saveChecklist(officer, { applicationId, items: allItems([], [cnicDocumentId]) });
    await completeChecklist(officer, applicationId);

    // Immutable: there is nothing open to save into, and a second completion
    // is not a second completion.
    const afterwards = await saveChecklist(officer, {
      applicationId,
      items: allItems([...CODES], [cnicDocumentId]),
    });
    expect(afterwards.noOpenRound).toBe(true);
    expect(afterwards.savedCount).toBe(0);

    expect((await completeChecklist(officer, applicationId)).ok).toBe(false);

    const events = await getDb()
      .selectFrom("audit_log")
      .select(["action", "after_json"])
      .where("action", "=", "application.verification_completed")
      .execute();

    expect(events).toHaveLength(1);

    // The driver hands back parsed JSON for a JSON column, so this is already
    // an object rather than a string.
    const after = events[0].after_json as unknown as {
      items: unknown[];
      failed: unknown[];
    };
    expect(after.items).toHaveLength(13);
    // Items 1 and 13 unticked, the other eleven unticked too: the eleven fail
    // for being unticked and the two defects pass.
    expect(after.failed).toHaveLength(11);
  });
});

describe.skipIf(!available)("deficiency rounds", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
    await seedCalendar();
  });

  /** Through round 1, signed off, with the CNIC item failed. */
  async function throughRoundOne() {
    const context = await fixture();
    const officer = staffActor(context.officerId, OFFICER);

    await beginVerification(officer, context.applicationId);
    await logView(context.cnicDocumentId, context.officerId);
    await saveChecklist(officer, {
      applicationId: context.applicationId,
      items: allItems(
        CODES.filter((code) => code !== "cnic_readable" && code !== "incomplete_form"),
        [context.cnicDocumentId],
      ),
    });

    return { ...context, officer };
  }

  it("refuses while the round is still open", async () => {
    const { applicationId, officer } = await throughRoundOne();

    const refused = await raiseDeficiency(officer, {
      applicationId,
      items: [{ kind: "document", documentTypeCode: "cnic", instruction: "Resend the CNIC." }],
    });

    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("round_in_progress");
  });

  it("stops the clock, names the items and queues the email", async () => {
    const { applicationId, officer } = await throughRoundOne();
    await completeChecklist(officer, applicationId);

    const raised = await raiseDeficiency(officer, {
      applicationId,
      summary: "Two things before we can continue.",
      items: [
        {
          kind: "document",
          documentTypeCode: "cnic",
          subjectKind: "representative",
          checklistItemCode: "cnic_readable",
          instruction: "The CNIC scan is not readable. Please send both sides on A4.",
        },
        { kind: "field", fieldName: "annual_turnover", instruction: "Confirm the turnover." },
        // Blank instructions are dropped, not stored as empty rows.
        { kind: "other", instruction: "   " },
      ],
    });

    expect(raised.ok).toBe(true);
    if (!raised.ok) return;

    expect(raised.round).toBe(1);
    expect(raised.itemCount).toBe(2);
    expect(raised.respondBy).toBe(isoDaysFromToday(DEFICIENCY_RESPONSE_WORKING_DAYS));

    const application = await getDb()
      .selectFrom("applications")
      .select(["state"])
      .where("id", "=", applicationId)
      .executeTakeFirstOrThrow();
    expect(application.state).toBe("AWAITING_APPLICANT");

    const clock = await getDb()
      .selectFrom("sla_clocks")
      .select(["state", "due_date"])
      .where("application_id", "=", applicationId)
      .executeTakeFirstOrThrow();
    // The paid promise is in working days of the Chamber's time, not the
    // applicant's. A clock still running here would charge the Chamber for
    // however long the applicant takes to find a scanner.
    expect(clock.state).toBe("paused");

    const pause = await getDb()
      .selectFrom("sla_pauses")
      .select(["reason", "resumed_at", "working_days_cost"])
      .executeTakeFirstOrThrow();
    expect(pause.reason).toBe("awaiting_applicant");
    expect(pause.resumed_at).toBeNull();

    const mail = await getDb()
      .selectFrom("email_outbox")
      .select(["template", "payload_json", "to_address"])
      .executeTakeFirstOrThrow();
    expect(mail.template).toBe("application-deficiency");
    expect(mail.to_address).toBe("office@ravitextiles.example.com.pk");

    const payload = mail.payload_json as unknown as { items: string[] };
    // The whole list in the body. An email that says "log in to see what is
    // wrong" costs the applicant a round trip for no reason.
    expect(payload.items).toHaveLength(2);

    // And a second return cannot be raised on top of the first. The state
    // machine refuses before the open-deficiency check is reached, because
    // `raise_deficiency` runs only from UNDER_VERIFICATION and the application
    // is now with the applicant — which is the stronger of the two guards.
    const again = await raiseDeficiency(officer, {
      applicationId,
      items: [{ kind: "other", instruction: "Anything." }],
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe("wrong_state");
  });

  it("unlocks the document it named and nothing else", async () => {
    const { applicationId, applicantId, officer } = await throughRoundOne();
    await completeChecklist(officer, applicationId);
    await raiseDeficiency(officer, {
      applicationId,
      items: [
        {
          kind: "document",
          documentTypeCode: "cnic",
          subjectKind: "representative",
          instruction: "The CNIC scan is not readable.",
        },
      ],
    });

    const applicant = memberActor(applicantId);

    const named = await authorizeUpload(applicant, {
      applicationId,
      documentTypeCode: "cnic",
      subjectKind: "representative",
      subjectId: null,
    });
    expect(named.ok).toBe(true);

    // A type the officer did not raise. The applicant is answering an item
    // nobody asked for, and saying so is more useful than "not allowed".
    const unnamed = await authorizeUpload(applicant, {
      applicationId,
      documentTypeCode: "utility_bill",
      subjectKind: "company",
      subjectId: null,
    });
    expect(unnamed.ok).toBe(false);
    if (!unnamed.ok) expect(unnamed.reason).toBe("not_unlocked");

    // And not somebody else's application, with the same wording either way so
    // the response cannot be used to discover which ids exist.
    const stranger = memberActor(await createUser(`stranger-${randomUUID()}@x.example`, "portal"));
    const trespass = await authorizeUpload(stranger, {
      applicationId,
      documentTypeCode: "cnic",
      subjectKind: "representative",
      subjectId: null,
    });
    expect(trespass.ok).toBe(false);
    if (!trespass.ok) expect(trespass.reason).toBe("not_found");
  });

  it("refuses the applicant's response while a named document is still outstanding", async () => {
    const { applicationId, applicantId, officer } = await throughRoundOne();
    await completeChecklist(officer, applicationId);
    await raiseDeficiency(officer, {
      applicationId,
      items: [
        {
          kind: "document",
          documentTypeCode: "cnic",
          subjectKind: "representative",
          instruction: "The CNIC scan is not readable.",
        },
      ],
    });

    const applicant = memberActor(applicantId);

    const outstanding = await outstandingFor(getDb(), applicationId);
    expect(outstanding?.items.every((item) => !item.answered)).toBe(true);

    const refused = await recordApplicantResponse(applicant, applicationId);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toBe("outstanding");
      // The list is the whole value of the refusal: an application cycling
      // back unchanged costs the applicant another fifteen working days.
      expect(refused.outstanding).toHaveLength(1);
    }
  });

  it("opens round 2 and restarts the clock once the applicant answers", async () => {
    const { applicationId, applicantId, officerId, officer } = await throughRoundOne();
    await completeChecklist(officer, applicationId);

    const before = await getDb()
      .selectFrom("sla_clocks")
      .select(["due_date"])
      .where("application_id", "=", applicationId)
      .executeTakeFirstOrThrow();

    await raiseDeficiency(officer, {
      applicationId,
      items: [
        {
          kind: "document",
          documentTypeCode: "cnic",
          subjectKind: "representative",
          instruction: "The CNIC scan is not readable.",
        },
      ],
    });

    // Backdated two days, so the pause has a measurable cost. The clock was
    // paused a moment ago, and a pause priced at zero working days proves
    // nothing about whether it is priced at all.
    await sql`
      UPDATE sla_pauses SET paused_at = DATE_SUB(NOW(), INTERVAL 2 DAY)
    `.execute(getDb());

    // The replacement scan, as the upload route lands it.
    await putDocument(applicationId, applicantId, {
      typeCode: "cnic",
      subjectKind: "representative",
      subjectId: null,
    });

    const applicant = memberActor(applicantId);
    const answered = await recordApplicantResponse(applicant, applicationId);

    expect(answered.ok).toBe(true);
    if (!answered.ok) return;

    expect(answered.checklistRound).toBe(2);
    expect(answered.snapshotRound).toBeGreaterThanOrEqual(1);
    expect(answered.pausedWorkingDays).toBeGreaterThan(0);

    const application = await getDb()
      .selectFrom("applications")
      .select(["state"])
      .where("id", "=", applicationId)
      .executeTakeFirstOrThrow();
    expect(application.state).toBe("UNDER_VERIFICATION");

    const clock = await getDb()
      .selectFrom("sla_clocks")
      .select(["state", "due_date", "paused_working_days"])
      .where("application_id", "=", applicationId)
      .executeTakeFirstOrThrow();

    expect(clock.state).toBe("running");
    expect(Number(clock.paused_working_days)).toBeGreaterThan(0);
    // The deadline moves out by exactly what the applicant held, so the
    // Chamber is not charged for the wait.
    expect(String(clock.due_date) > String(before.due_date)).toBe(true);

    const pause = await getDb()
      .selectFrom("sla_pauses")
      .select(["resumed_at", "working_days_cost"])
      .executeTakeFirstOrThrow();
    expect(pause.resumed_at).not.toBeNull();
    expect(Number(pause.working_days_cost)).toBeGreaterThan(0);

    // Round 1 is kept, not edited: it is marked superseded rather than
    // deleted, so an auditor sees every successive judgement — including the
    // one that was made against a scan the applicant has since replaced.
    const rounds = await getDb()
      .selectFrom("verification_checklists")
      .select(["round", "state"])
      .orderBy("round", "asc")
      .execute();
    expect(rounds.map((row) => `${row.round}:${row.state}`)).toEqual([
      "1:superseded",
      "2:in_progress",
    ]);

    // And the new round is empty, so the officer judges the replacement rather
    // than inheriting a verdict on a scan that no longer exists.
    const carried = await loadVerification(staffActor(officerId, OFFICER), applicationId);
    expect(carried).not.toBeNull();
    if (!carried) return;

    expect(carried.current?.round).toBe(2);
    expect(carried.current?.items.every((item) => item.outcome === null)).toBe(true);
    expect(carried.undecidedCodes).toHaveLength(13);
    expect(carried.history.map((round) => round.round)).toEqual([1]);
  });
});

describe.skipIf(!available)("supersession", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
    await seedCalendar();
  });

  it("leaves a type that allows several additive in a draft", async () => {
    const { applicationId, applicantId } = await fixture({ state: "DRAFT" });
    await putDocument(applicationId, applicantId, {
      typeCode: "pay_order",
      subjectKind: "payment",
      subjectId: null,
    });

    const decision = await authorizeUpload(memberActor(applicantId), {
      applicationId,
      documentTypeCode: "pay_order",
      subjectKind: "payment",
      subjectId: null,
    });

    // Two pay orders is the normal shape of an application carrying the ITD
    // surcharge. Superseding here would silently discard the first instrument.
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.supersedes).toBeNull();
  });

  it("derives the predecessor server-side and retires it on ingest", async () => {
    const { applicationId, applicantId, officerId, cnicDocumentId } = await fixture();
    const officer = staffActor(officerId, OFFICER);

    await beginVerification(officer, applicationId);
    await logView(cnicDocumentId, officerId);
    await saveChecklist(officer, {
      applicationId,
      items: allItems([], [cnicDocumentId]),
    });
    await completeChecklist(officer, applicationId);
    await raiseDeficiency(officer, {
      applicationId,
      items: [
        {
          kind: "document",
          documentTypeCode: "cnic",
          subjectKind: "representative",
          instruction: "The CNIC scan is not readable.",
        },
      ],
    });

    const applicant = memberActor(applicantId);

    const decision = await authorizeUpload(applicant, {
      applicationId,
      documentTypeCode: "cnic",
      subjectKind: "representative",
      subjectId: null,
    });

    expect(decision.ok).toBe(true);
    if (!decision.ok) return;

    // Derived, never taken from the client. The route used to read an
    // `x-supersedes` header that the wizard never sent, so nothing was ever
    // superseded and a corrected scan became a *second* live document — which
    // `checkCompleteness` counted and which left the officer looking at two
    // versions of one CNIC with nothing saying which was current.
    //
    // `allows_multiple` is 1 for a CNIC, and it is overridden here on purpose:
    // while answering a deficiency, replacement is always the intent.
    expect(decision.supersedes).toBe(cnicDocumentId);

    const ingested = await ingestDocument(applicant, {
      body: bodyOf(jpeg(1240, 1754)),
      declaredLength: null,
      declaredType: "image/jpeg",
      filename: "cnic-again.jpg",
      documentTypeCode: "cnic",
      applicationId,
      subjectKind: "representative",
      subjectId: null,
      supersedesDocumentId: decision.supersedes,
    });

    expect(ingested.ok).toBe(true);

    const documents = await getDb()
      .selectFrom("documents")
      .select(["id", "review_state", "supersedes_document_id"])
      .where("application_id", "=", applicationId)
      .where("document_type_code", "=", "cnic")
      .execute();

    expect(documents).toHaveLength(2);

    const retired = documents.find((row) => row.id === cnicDocumentId);
    expect(retired?.review_state).toBe("superseded");

    const live = documents.filter((row) => row.review_state !== "superseded");
    expect(live).toHaveLength(1);
    expect(live[0].supersedes_document_id).toBe(cnicDocumentId);

    // Which is what makes the applicant's own page say the item is answered.
    const outstanding = await outstandingFor(getDb(), applicationId);
    expect(outstanding?.items.every((item) => item.answered)).toBe(true);
  });
});
