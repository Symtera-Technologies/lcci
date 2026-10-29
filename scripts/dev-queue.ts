/**
 * Fill the development queue with applications an officer can actually work.
 *
 *   npm run dev:queue            (three applications across the open states)
 *   npm run dev:queue -- 6       (six)
 *
 * Why this exists: `/admin/applications` and the review screen cannot be
 * looked at, let alone judged, against an empty table — and the one thing that
 * must not happen is building those screens against hand-written fixtures and
 * discovering at the first real submission that the shapes differ.
 *
 * So this drives the same functions the wizard calls, ingests documents
 * through the same pipeline the upload route uses (so the bytes on disk are
 * genuinely encrypted and the viewer is reading a real file), and submits
 * through the real transition — which assigns the reference, snapshots the
 * form revision and the document matrix, creates the payment rows and starts
 * the SLA clock. Nothing here writes a row the application code would not have
 * written itself.
 *
 * It refuses to run in production, like the other dev scripts.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { PDFDocument } from "pdf-lib";
import { getDb, sql } from "@/db/client";
import { closePool } from "@/db/pool";
import { env } from "@/server/env";
import { newUlid } from "@/server/crypto";
import type { ActorContext } from "@/server/actor";
import {
  acceptDeclaration,
  loadDraft,
  saveDirectors,
  saveEndorsers,
  saveParticulars,
  startOrResumeDraft,
} from "@/membership/applications";
import { checkCompleteness, submitApplication } from "@/membership/submit";
import { ingestDocument } from "@/server/documents/ingest";

/**
 * One throwaway applicant per slot, not the shared development member.
 *
 * `startOrResumeDraft` resumes the caller's existing draft, so reusing
 * `member@lcci.test` would mean this script picking up whatever half-finished
 * draft somebody was testing the wizard with — and then failing, correctly,
 * because its directors have documents attached. A user per slot keeps every
 * run independent and leaves the real development member's draft alone.
 */
function applicantEmail(index: number): string {
  return `queue-applicant-${index + 1}@lcci.test`;
}

/**
 * Firms, tiers and the state each one should end up in.
 *
 * A spread rather than three identical rows: the queue's whole job is to sort
 * by deadline pressure across tiers, and a table of three Regular submissions
 * cannot show whether it does.
 */
const FIRMS = [
  { name: "Shalimar Textiles", tier: "executive", state: "SUBMITTED", backdateDays: 6 },
  { name: "Ravi Trading Company", tier: "urgent", state: "UNDER_VERIFICATION", backdateDays: 2 },
  { name: "Mall Road Exports", tier: "regular", state: "SUBMITTED", backdateDays: 0 },
  { name: "Gulberg Steel Works", tier: "urgent", state: "AWAITING_APPLICANT", backdateDays: 1 },
  { name: "Badami Bagh Motors", tier: "regular", state: "SUBMITTED", backdateDays: 0 },
  { name: "Walled City Crafts", tier: "executive", state: "VERIFIED", backdateDays: 1 },
] as const;

function actorFor(userId: number): ActorContext {
  return {
    userId,
    userType: "portal",
    roleCode: null,
    roleCodes: [],
    permissions: new Set(),
    requestId: newUlid(),
    ipHash: null,
    userAgentHash: null,
    onBehalfOfUserId: null,
  };
}

async function applicantId(email: string): Promise<number> {
  const db = getDb();
  const existing = await db
    .selectFrom("users")
    .select(["id"])
    .where("email", "=", email)
    .executeTakeFirst();

  if (existing) return existing.id;

  const inserted = await db
    .insertInto("users")
    .values({
      user_type: "portal",
      email,
      full_name: "Queue Fixture Applicant",
      password_hash: null,
      status: "active",
    })
    .executeTakeFirstOrThrow();

  return Number(inserted.insertId);
}

/** A real photograph off disk, so the image viewer has something to show. */
function photographBytes(): Buffer {
  const candidates = [
    "public/photos/hero-1.jpg",
    "public/photos/hero-2.jpg",
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(path.join(process.cwd(), candidate));
    } catch {
      continue;
    }
  }
  throw new Error(
    "No photograph found under public/photos to use as a sample scan.",
  );
}

/** A two-page PDF, built rather than committed, so nothing binary is added. */
async function certificateBytes(title: string): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  for (const page of [pdf.addPage([595, 842]), pdf.addPage([595, 842])]) {
    page.drawText(title, { x: 56, y: 760, size: 18 });
    page.drawText("Sample document generated for local development.", {
      x: 56,
      y: 730,
      size: 11,
    });
  }
  return Buffer.from(await pdf.save());
}

function streamOf(bytes: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

const PARTICULARS = {
  membershipClass: "corporate",
  companyStatus: "partnership",
  representativeName: "A. Representative",
  representativeCnic: "35202-1234567-1",
  representativeDob: "1980-04-15",
  representativeBirthplace: "Lahore",
  representativeNationality: "Pakistani",
  postalAddress: "11 Shara-e-Aiwan-e-Sanat-o-Tijarat, Lahore",
  premisesTenure: "rented",
  email: "office@example.com.pk",
  officePhone1: "042-37654321",
  representativeMobile1: "0300-1234567",
  paidUpCapital: "5000000",
  annualTurnover: "60000000",
  employeeCount: "42",
  ntn: "1234567-8",
  strnRegistered: "on",
  strn: "17-00-9999-999-99",
  businessSector: "Textiles",
  businessSubSector: "Home textiles",
  mainCommodity: "Bed linen",
  businessTypes: ["exporter", "manufacturer"],
  bankName: "Habib Bank Limited",
  bankBranch: "Gulberg III, Lahore",
} as const;

async function buildOne(
  actor: ActorContext,
  firm: (typeof FIRMS)[number],
  photograph: Buffer,
): Promise<number> {
  const db = getDb();
  const applicationId = await startOrResumeDraft(actor);

  await saveParticulars(actor, {
    applicationId,
    ...PARTICULARS,
    firmName: firm.name,
    processingTier: firm.tier,
  });

  await saveDirectors(actor, {
    applicationId,
    directors: [
      {
        fullName: "A. Representative",
        designation: "Managing Partner",
        cell: "0300-1234567",
        cnic: "35202-1234567-1",
      },
      {
        fullName: "B. Partner",
        designation: "Partner",
        cell: "0300-7654321",
        cnic: "35202-7654321-2",
      },
    ],
  });

  await saveEndorsers(actor, {
    applicationId,
    endorsementMode: "in_app",
    endorsers: [
      {
        role: "proposer",
        firmName: "Anarkali Fabrics",
        membershipNo: "L-1001",
        representativeName: "C. Member",
        mobile: "0321-1112223",
      },
      {
        role: "seconder",
        firmName: "Shahalam Market Traders",
        membershipNo: "L-1002",
        representativeName: "D. Member",
        mobile: "0321-4445556",
      },
    ],
  });

  // The in-app endorsement flow is still to come; what the transition needs is
  // the state it would leave behind.
  await db
    .updateTable("application_endorsements")
    .set({
      state: "endorsed",
      standing_at_endorsement: "active",
      endorsed_at: new Date(),
    })
    .where("application_id", "=", applicationId)
    .execute();

  const draft = await loadDraft(actor, applicationId);
  const attester = draft?.directors.find(
    (director) => director.full_name === "B. Partner",
  );
  if (!attester) throw new Error("attesting director missing");

  await acceptDeclaration(actor, {
    applicationId,
    attestingDirectorId: Number(attester.id),
    accepted: true,
  });

  // Every required document, through the real pipeline. Photographs go in as
  // JPEG and everything else as PDF, which is what applicants actually send.
  const completeness = await checkCompleteness(db, applicationId);
  const directors = await db
    .selectFrom("application_directors")
    .select(["id"])
    .where("application_id", "=", applicationId)
    .execute();

  for (const requirement of completeness.required) {
    if (requirement.cardinality === "optional") continue;

    const subjects =
      requirement.cardinality === "all_directors"
        ? directors.map((director) => director.id)
        : [null];

    for (const subjectId of subjects) {
      const asPhoto = /photo/.test(requirement.documentTypeCode);
      const bytes = asPhoto
        ? photograph
        : await certificateBytes(requirement.documentTypeCode);

      const result = await ingestDocument(actor, {
        body: streamOf(bytes),
        declaredLength: bytes.byteLength,
        declaredType: asPhoto ? "image/jpeg" : "application/pdf",
        filename: asPhoto
          ? `${requirement.documentTypeCode}.jpg`
          : `${requirement.documentTypeCode}.pdf`,
        documentTypeCode: requirement.documentTypeCode,
        applicationId,
        subjectKind: subjectId === null ? "company" : "director",
        subjectId,
      });

      if (!result.ok) {
        throw new Error(
          `could not ingest ${requirement.documentTypeCode}: ${result.failure.reason}`,
        );
      }
    }
  }

  await submitApplication(actor, applicationId);

  // Backdate the clock rather than the submission, so one application in the
  // list is genuinely late and the sort order can be judged. Writing the state
  // directly is honest here: the transitions that reach UNDER_VERIFICATION and
  // VERIFIED are A5's, and this script exists to give A5 something to work on.
  //
  // This back-date does not survive a calendar edit, and should not. Recording
  // a holiday flags every clock spanning it, and `sla-recompute` then rebuilds
  // the date from the clock's own start — which is the whole point of that job,
  // and which throws away a date no calendar can account for. So a recompute
  // leaves the queue with nothing overdue until this script is run again.
  // Nudging the stored date instead would have preserved the fiction, at the
  // price of a deadline nobody could derive.
  if (firm.backdateDays > 0) {
    await sql`
      UPDATE sla_clocks
         SET due_date = DATE_SUB(due_date, INTERVAL ${firm.backdateDays} DAY)
       WHERE application_id = ${applicationId}
    `.execute(db);
  }

  if (firm.state !== "SUBMITTED") {
    await sql`
      UPDATE applications SET state = ${firm.state} WHERE id = ${applicationId}
    `.execute(db);
  }

  return applicationId;
}

async function main(): Promise<number> {
  if (env.isProduction) {
    console.error(
      "Refusing to run: NODE_ENV is production.\n" +
        "This writes applications, documents and payment rows that would be " +
        "indistinguishable from real ones in the queue.",
    );
    return 1;
  }

  const count = Math.min(
    FIRMS.length,
    Math.max(1, Number(process.argv[2]) || 3),
  );

  const photograph = photographBytes();

  for (let index = 0; index < count; index += 1) {
    const firm = FIRMS[index]!;
    const userId = await applicantId(applicantEmail(index));
    const applicationId = await buildOne(actorFor(userId), firm, photograph);
    const row = await getDb()
      .selectFrom("applications")
      .select(["public_ref", "state"])
      .where("id", "=", applicationId)
      .executeTakeFirstOrThrow();

    console.log(
      `#${applicationId}  ${row.public_ref ?? "(no ref)"}  ${row.state}  ${firm.name}`,
    );
  }

  console.log(`\n${count} application(s) ready at /admin/applications`);
  return 0;
}

main()
  .then(async (code) => {
    await closePool();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(error);
    await closePool();
    process.exit(1);
  });
