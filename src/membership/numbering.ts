import "server-only";

import { sql } from "@/db/client";
import type { Queryable } from "@/db/client";

/**
 * Allocating an externally meaningful number.
 *
 * Not `MAX(col) + 1`, and not an AUTO_INCREMENT either. A membership number is
 * printed on certificates, quoted by proposers and used to sign in, so format
 * control and gaplessness matter more than throughput — and at tens of
 * approvals a week there is no throughput argument to make. An application
 * reference is the same shape of problem one step earlier.
 *
 * The allocation is a `SELECT ... FOR UPDATE` on the sequence row inside the
 * caller's transaction, so two concurrent approvals serialise and the loser
 * waits rather than taking the same number. `MAX(col) + 1` looks equivalent
 * and is not: two transactions both read the same maximum, both compute the
 * same successor, and the UNIQUE index on the destination turns a silent
 * duplicate into a failed approval — which is better than a duplicate, and
 * much worse than a lock.
 *
 * The caller must already be in a transaction. Without one, the `FOR UPDATE`
 * lock is released when the statement ends and the serialisation is
 * imaginary — the same trap the audit chain had.
 */

interface SequenceRow {
  pattern: string;
  next_value: number;
  pad_width: number;
  resets: "never" | "yearly";
  period_key: string | null;
}

/**
 * Take the next value from a named sequence and render it.
 *
 * Rolling a yearly counter over is part of the same locked read, so two
 * approvals either side of midnight on 1 January cannot both be issued
 * sequence 1.
 */
export async function allocateNumber(
  tx: Queryable,
  name: string,
  now: Date = new Date(),
): Promise<string> {
  if (!tx.isTransaction) {
    throw new Error(
      `allocateNumber("${name}") must run inside a transaction: outside one ` +
        "the FOR UPDATE lock is dropped as the statement ends and two " +
        "callers can take the same number.",
    );
  }

  const locked = await sql<SequenceRow>`
    SELECT pattern, next_value, pad_width, resets, period_key
      FROM number_sequences
     WHERE name = ${name}
     FOR UPDATE
  `.execute(tx);

  const row = locked.rows[0];
  if (!row) throw new Error(`No number sequence named "${name}".`);

  const year = now.getUTCFullYear();
  const periodKey = String(year);

  // A yearly sequence whose stored period is not the current one restarts.
  const rolled = row.resets === "yearly" && row.period_key !== periodKey;
  const value = rolled ? 1 : Number(row.next_value);

  await sql`
    UPDATE number_sequences
       SET next_value = ${value + 1},
           period_key = ${row.resets === "yearly" ? periodKey : row.period_key},
           updated_at = ${now}
     WHERE name = ${name}
  `.execute(tx);

  return render(row.pattern, {
    yyyy: periodKey,
    seq: String(value).padStart(Number(row.pad_width), "0"),
  });
}

/**
 * Substitute `{yyyy}` and `{seq}` in a sequence pattern.
 *
 * Exported for the test, and deliberately not a general template engine: a
 * pattern comes from reference data an administrator can edit, so the set of
 * placeholders is closed and an unknown one is left alone rather than
 * evaluated.
 */
export function render(pattern: string, values: Record<string, string>): string {
  return pattern.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
}
