/**
 * Apply database migrations from the command line.
 *
 *   npm run migrate            apply everything pending
 *   npm run migrate:status     show what has and has not been applied
 *
 * The other invocation path is an authenticated admin route, because SSH to a
 * shared cPanel account is not always available when a release needs to land.
 * Both paths call the same runner and write the same ledger.
 */

import os from "node:os";
import process from "node:process";
import { closePool } from "@/db/pool";
import { migrationStatus, runMigrations } from "@/db/migrate";

async function main(): Promise<number> {
  const wantsStatus = process.argv.includes("--status");

  if (wantsStatus) {
    const statuses = await migrationStatus();
    if (statuses.length === 0) {
      console.log("No migrations found in migrations/.");
      return 0;
    }

    for (const s of statuses) {
      const when = s.appliedAt ? ` ${s.appliedAt.toISOString()} by ${s.appliedBy}` : "";
      console.log(`${s.version}  ${s.state.padEnd(18)} ${s.name}${when}`);
    }

    const broken = statuses.filter(
      (s) => s.state === "checksum-mismatch" || s.state === "missing-file",
    );
    if (broken.length > 0) {
      console.error(
        `\n${broken.length} migration(s) need attention. A checksum mismatch ` +
          "means the file and the database disagree; a missing file means a " +
          "migration was applied from a different checkout.",
      );

      // Which side changed is the whole question, and the message above does
      // not answer it. Printing both checksums does: hash the file against the
      // copy in version control and whichever one it matches is the side that
      // is intact. Line endings are normalised before hashing, so a checkout
      // with CRLF is not the explanation.
      for (const s of broken) {
        if (!s.checksums) continue;
        console.error(`\n${s.version}_${s.name}.sql`);
        console.error(`  recorded in the database  ${s.checksums.recorded}`);
        console.error(`  this file on disk         ${s.checksums.file}`);
        console.error(
          `  sha256sum migrations/${s.version}_${s.name}.sql`,
        );
        console.error(
          "  If it matches the repository, the ledger was written from a " +
            "different copy of this file.",
        );
        console.error(
          "  If it does not, this file is the damaged one — restore it from " +
            "the repository and re-run.",
        );
      }

      return 1;
    }
    return 0;
  }

  const who = `${os.userInfo().username}@${os.hostname()}`.slice(0, 80);
  const result = await runMigrations(who);

  if (result.skippedLocked) {
    console.error(
      "Another migration run holds the lock. Nothing was applied; try again.",
    );
    return 1;
  }

  if (result.applied.length === 0) {
    console.log(`Nothing to apply. ${result.alreadyApplied} already in place.`);
    return 0;
  }

  console.log(`Applied ${result.applied.length}:`);
  for (const filename of result.applied) console.log(`  ${filename}`);
  return 0;
}

main()
  .then(async (code) => {
    await closePool();
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    if (error instanceof Error && error.cause) console.error("Caused by:", error.cause);
    await closePool();
    process.exit(1);
  });
