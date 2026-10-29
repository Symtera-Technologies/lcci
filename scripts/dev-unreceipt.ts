/**
 * Put a development application's fees back to `due`.
 *
 *   npm run dev:unreceipt -- 10
 *
 * Receipting is a one-way door by design: a receipt number is allocated and
 * never reused, and there is no "undo" in the admin because finance has the
 * number on a counterfoil. That is correct and it makes the screen impossible
 * to exercise twice on a development machine, which is all this is for.
 *
 * It deletes the pay order, clears the receipt and leaves the allocated number
 * spent — exactly as a real reversal would have to, since the sequence does not
 * go backwards. Refuses in production, where reversing a receipt is a decision
 * with money attached and belongs in the audit log rather than in a script.
 */

import process from "node:process";
import { getDb, sql } from "@/db/client";
import { closePool } from "@/db/pool";
import { env } from "@/server/env";

async function main(): Promise<number> {
  if (env.isProduction) {
    console.error(
      "Refusing to run: NODE_ENV is production. Reversing a receipt there is an " +
        "audited decision, not a script.",
    );
    return 1;
  }

  const applicationId = Number(process.argv[2]);
  if (!Number.isSafeInteger(applicationId) || applicationId <= 0) {
    console.error(
      "Pass an application id, for example: npm run dev:unreceipt -- 10",
    );
    return 1;
  }

  const db = getDb();

  const removed = await sql`
    DELETE o FROM pay_orders o
      JOIN payments p ON p.id = o.payment_id
     WHERE p.application_id = ${applicationId}
  `.execute(db);

  const reset = await db
    .updateTable("payments")
    .set({
      state: "due",
      receipt_no: null,
      receipted_at: null,
      receipted_by: null,
      received_at: null,
      amount_received: null,
      variance_reason: null,
      dishonoured_at: null,
      dishonour_reason: null,
      dishonoured_by: null,
    })
    .where("application_id", "=", applicationId)
    .execute();

  console.log(
    `Application ${applicationId}: ${Number(reset[0]?.numUpdatedRows ?? 0)} payment(s) back to due, ` +
      `${Number(removed.numAffectedRows ?? 0)} pay order(s) deleted. ` +
      "The receipt numbers they held stay spent — the sequence does not go backwards.",
  );

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
