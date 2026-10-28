/**
 * Print the crontab, generated from the job registry.
 *
 *   npm run cron:print                       # uses SITE_ORIGIN
 *   npm run cron:print -- --secret-file=/home/lcci/.lcci-cron-secret
 *
 * Paste the output into cPanel's cron editor. Generating it rather than writing
 * it by hand is the point: a job added to `src/server/jobs/schedule.ts` appears
* here, so the crontab cannot silently fall behind the code — which is how a
 * job ends up never having run in production and nobody finding out.
 *
 * Before pasting, create the secret file:
 *
 *   umask 077 && printf '%s' "$CRON_SECRET" > ~/.lcci-cron-secret
 *
 * `printf` rather than `echo`, because a trailing newline becomes part of the
 * token and the comparison is exact.
 */

import { crontabLines, JOB_NAMES } from "../src/server/jobs/schedule";

function arg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const origin = arg("origin", process.env.SITE_ORIGIN ?? "https://lcci.com.pk").replace(
  /\/+$/,
  "",
);
const secretFile = arg("secret-file", "$HOME/.lcci-cron-secret");

console.log(`# LCCI scheduled jobs — ${JOB_NAMES.length} jobs, generated from`);
console.log("# src/server/jobs/schedule.ts. Do not edit by hand; re-run");
console.log("# `npm run cron:print` after changing the registry.");
console.log("#");
console.log("# Times are the server's local timezone, which on cPanel is often");
console.log("# NOT Asia/Karachi. Check `date` over SSH before trusting the");
console.log("# overnight schedules — a retention sweep at what you think is");
console.log("# 03:40 PKT may be running in the middle of the working day.");
console.log("");
console.log(`MAILTO=""`);
console.log("");

for (const line of crontabLines(origin, secretFile)) {
  console.log(line);
}
