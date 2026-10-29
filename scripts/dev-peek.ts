/**
 * Print the development database's payment and financial-document rows.
 *
 * Kept rather than thrown away because every screen built on top of this one
 * is reached from a submitted application by id, and knowing which
 * applications have fee rows, what state each fee is in, and which have a
 * pay-order scan is the difference between opening the right URL and guessing
 * at eight of them. Read-only, and refuses in production.
 *
 * `dev-unreceipt.ts` puts a receipted fee back; this one never writes.
 */

import process from "node:process";
import { getDb, sql } from "@/db/client";
import { closePool } from "@/db/pool";
import { env } from "@/server/env";

async function main(): Promise<number> {
  if (env.isProduction) {
    console.error("Refusing to run: NODE_ENV is production.");
    return 1;
  }

  const payments = await sql<Record<string, unknown>>`
    SELECT p.id, p.application_id, a.public_ref, a.state AS app_state,
           p.fee_kind, p.amount, p.currency, p.state, p.version, p.receipt_no
      FROM payments p
      JOIN applications a ON a.id = p.application_id
     ORDER BY p.id
  `.execute(getDb());
  console.log("payments:", JSON.stringify(payments.rows, null, 1));

  const applicationId = Number(process.argv[2] ?? 0);

  const docs = await sql<Record<string, unknown>>`
    SELECT id, application_id, document_type_code, subject_kind, review_state, issued_on
      FROM documents
     WHERE deleted_at IS NULL
       ${applicationId > 0 ? sql`AND application_id = ${applicationId}` : sql`AND document_type_code IN ('pay_order', 'bank_certificate')`}
     ORDER BY application_id, document_type_code
  `.execute(getDb());
  console.log("documents:", JSON.stringify(docs.rows, null, 1));

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
