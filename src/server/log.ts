import "server-only";

/**
 * Operational logging.
 *
 * This module exists to make it hard to log the wrong thing. It is not a
 * convenience wrapper over `console.log` — it is a filter, and the filter is
 * the feature.
 *
 * What this system holds is CNICs, passports, NTNs, bank account-maintenance
 * certificates and the signatures of directors and partners who are frequently
 * not the applicant and have never interacted with the chamber directly. A log
 * file is read by more people, kept for longer and backed up more carelessly
 * than the database, so the rule is that identifying data never enters one.
 *
 * The specific trap this guards against, and the reason `logError` exists
 * rather than letting callers log a caught error: a `mysql2` error object
 * carries `sql` and, depending on version and options, the bound parameters
 * with it. `console.error(err)` on a failed INSERT into `application_company`
 * is the single most likely route by which an applicant's CNIC reaches a log
 * file, and it looks like responsible error handling.
 *
 * Audit events are a different thing with a different destination; see
 * `src/server/audit.ts`. This is for operational lines — a job ran, a boot
 * check failed, an upload was rejected. Passenger captures stdout and stderr
 * into the account's log files.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Field names a log line may carry.
 *
 * A closed allowlist rather than an open record, because the failure mode of
 * an open record is that someone spreads a row into it — `{ ...application }`
 * — and every field of that row is now in the log. Adding a field here is a
 * deliberate act with a reviewer attached.
 *
 * Note what is absent and will not be added: anything named for a person, a
 * CNIC, a passport, an account number, an email address, a raw IP, a filename,
 * a token or a code. Where identity is genuinely needed, log the surrogate id
 * (`userId`) or a peppered hash (`ipHash`), both of which the audit log can
 * resolve under access control and a log reader cannot.
 */
const ALLOWED_FIELDS = [
  "requestId",
  "route",
  "method",
  "status",
  "durationMs",
  "userId",
  "userType",
  "roleCode",
  "ipHash",
  "entityType",
  "entityId",
  "action",
  "outcome",
  "reason",
  "job",
  "runId",
  "processed",
  "failed",
  "more",
  "attempts",
  "template",
  "channel",
  "documentId",
  "documentType",
  "byteSize",
  "mimeType",
  "sniffedType",
  "declaredType",
  "pageCount",
  "bucket",
  "limit",
  "retryAfterSeconds",
  "migration",
  "version",
  "errorCode",
  "errorName",
  "count",
  "state",
  "fromState",
  "toState",
  "directive",
] as const;

export type LogField = (typeof ALLOWED_FIELDS)[number];
export type LogFields = Partial<Record<LogField, string | number | boolean | null>>;

const ALLOWED = new Set<string>(ALLOWED_FIELDS);

/**
 * Drop unknown keys, and flatten values to primitives.
 *
 * Objects and arrays are rejected rather than serialised: a nested object is
 * how a whole row arrives in a log line, and `[object Object]` would be the
 * only warning. Strings are capped so a long free-text field cannot carry a
 * paragraph of applicant data under an approved key name.
 */
function scrub(fields: LogFields | undefined): Record<string, unknown> {
  if (!fields) return {};

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED.has(key)) {
      out.droppedFields = `${out.droppedFields ? `${out.droppedFields},` : ""}${key}`;
      continue;
    }
    if (value === null || value === undefined) continue;
    if (typeof value === "string") {
      out[key] = value.length > 200 ? `${value.slice(0, 200)}...` : value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
    // Anything else — object, array, bigint, function — is silently dropped
    // rather than stringified.
  }
  return out;
}

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    msg: message,
    ...scrub(fields),
  });

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (message: string, fields?: LogFields) => {
    if (process.env.NODE_ENV !== "production") emit("debug", message, fields);
  },
  info: (message: string, fields?: LogFields) => emit("info", message, fields),
  warn: (message: string, fields?: LogFields) => emit("warn", message, fields),
};

/**
 * Log a caught error without logging what it is carrying.
 *
 * Only the error's name, its `code`/`errno` where it has one, and the first
 * line of its message are recorded. The message is truncated to one line
 * because multi-line driver messages are where the offending SQL appears, and
 * the stack is omitted for the same reason: it can contain argument values.
 *
 * In development the full error goes out as a second line, so debugging is not
 * made harder — but only in development, and never as part of the structured
 * record that gets shipped and kept.
 */
export function logError(
  message: string,
  error: unknown,
  fields?: LogFields,
): void {
  const details: LogFields = { ...fields };

  if (error instanceof Error) {
    details.errorName = error.name;
    const firstLine = error.message.split("\n", 1)[0];
    details.reason = firstLine.length > 160 ? `${firstLine.slice(0, 160)}...` : firstLine;
  }

  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string" || typeof code === "number") {
      details.errorCode = String(code);
    }
  }

  emit("error", message, details);

  if (process.env.NODE_ENV !== "production") {
    console.error("[dev] full error:", error);
  }
}
