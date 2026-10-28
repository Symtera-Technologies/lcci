import { describe, expect, it } from "vitest";
import {
  JOB_NAMES,
  crontabLines,
  isJobName,
  jobSchedule,
} from "@/server/jobs/schedule";
import { JOB_HANDLERS } from "@/server/jobs/registry";
import { ROUTE_POLICY } from "@/server/auth/policy";

/**
 * The registry is the only place a job exists.
 *
 * A job that lives only as a line in someone's crontab is a job nobody can
 * find, nobody can test, and nobody notices has stopped running. These tests
 * hold the properties that make the registry trustworthy as that single
 * source: the names fit the column and the route, the schedules are real
 * crontab lines, and the generated crontab does not leak the secret.
 */

describe("job registry", () => {
  it("has at least the Phase 0 jobs", () => {
    expect(JOB_NAMES).toContain("email-outbox");
    expect(JOB_NAMES).toContain("rate-limit-sweep");
    expect(JOB_NAMES).toContain("audit-verify");
    expect(JOB_NAMES).toContain("health");
  });

  it("names jobs so they fit the column, the URL and the log filter", () => {
    // `job_runs.job` is VARCHAR(40), the route's own sanitiser accepts
    // [a-z0-9-]{1,40}, and the name goes into a URL path segment unencoded.
    for (const name of JOB_NAMES) {
      expect(name, name).toMatch(/^[a-z0-9-]{1,40}$/);
      expect(encodeURIComponent(name), name).toBe(name);
    }
  });

  it("has exactly one handler per schedule", () => {
    // The type system already enforces this through `satisfies Record<JobName,
    // JobHandler>`. Asserted at runtime as well because the two halves live in
    // two files for the crontab generator's sake, and a job that is scheduled
    // with no handler is a 404 every five minutes that nobody looks at.
    expect(Object.keys(JOB_HANDLERS).sort()).toEqual([...JOB_NAMES].sort());
  });

  it("describes every job in a sentence someone else can read", () => {
    for (const name of JOB_NAMES) {
      expect(jobSchedule(name).description.length, name).toBeGreaterThan(20);
    }
  });

  it("gives every job a five-field crontab schedule", () => {
    for (const name of JOB_NAMES) {
      const fields = jobSchedule(name).schedule.trim().split(/\s+/);
      expect(fields.length, name).toBe(5);
      for (const field of fields) {
        expect(field, `${name}: ${field}`).toMatch(/^[\d*,\-/]+$/);
      }
    }
  });

  it("keeps every budget inside what a shared plan will allow", () => {
    // Passenger and the host's own limits kill long requests. A job that
    // budgets more than it will be given does not fail cleanly — it is killed
    // mid-run, leaving its row `running` with a cold heartbeat.
    for (const name of JOB_NAMES) {
      const budget = jobSchedule(name).budgetMs;
      if (budget !== undefined) expect(budget, name).toBeLessThanOrEqual(55_000);
    }
  });
});

describe("isJobName", () => {
  it("accepts every registered job", () => {
    for (const name of JOB_NAMES) expect(isJobName(name)).toBe(true);
  });

  it("rejects anything else, including inherited property names", () => {
    // The value arrives as a URL path segment. A plain `in` check would accept
    // "constructor" and "toString", and `JOBS[name]` would then hand the
    // runner a function it would try to call as a job definition.
    for (const value of [
      "",
      "../../etc/passwd",
      "constructor",
      "toString",
      "__proto__",
      "hasOwnProperty",
      "EMAIL-OUTBOX",
      "email-outbox ",
    ]) {
      expect(isJobName(value), value).toBe(false);
    }
  });
});

describe("generated crontab", () => {
  const lines = crontabLines("https://lcci.com.pk", "/home/lcci/.lcci-cron-secret");
  const text = lines.join("\n");

  it("emits a comment and a command for every job", () => {
    expect(lines.length).toBe(JOB_NAMES.length * 2);
  });

  it("reads the secret from a file rather than inlining it", () => {
    // cPanel crontabs are world-readable in some configurations, and an
    // inlined secret also lands in the mail cron sends about its own output.
    expect(text).toContain("$(cat /home/lcci/.lcci-cron-secret)");
    expect(text).not.toMatch(/Bearer [A-Za-z0-9+/=]{8,}/);
  });

  it("never puts a token in the query string", () => {
    // A query-string secret lands in Apache's access log and in the Referer
    // of anything the response links to.
    expect(text).not.toMatch(/\?.*(secret|token|key)=/i);
  });

  it("posts, and stays quiet when the job succeeds", () => {
    for (const name of JOB_NAMES) {
      expect(text).toContain(`-X POST`);
      expect(text).toContain(`https://lcci.com.pk/api/cron/${name}`);
    }
    // A cron job that mails on every run trains its recipient to filter it.
    expect(text).toContain("-s -o /dev/null");
  });
});

describe("the cron route's policy", () => {
  it("is declared public and authenticated by the bearer secret", () => {
    const policy = ROUTE_POLICY["/api/cron/[job]"];
    expect(policy).toBeDefined();
    expect(policy.public).toBe(true);
    // No session, so no permissions to require. If this ever grows a
    // permission list it would be silently unenforced, because the caller is
    // a cron daemon that cannot hold one.
    expect(policy.permissions).toEqual([]);
  });
});
