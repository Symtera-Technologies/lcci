import { describe, expect, it } from "vitest";
import {
  TEMPLATES,
  TEMPLATE_NAMES,
  renderTemplate,
  type TemplateName,
} from "@/server/mail/templates";
import { MAX_ATTEMPTS, backoffMs } from "@/server/mail/outbox";

/**
 * One payload per template, so adding a template without adding a payload here
 * fails the suite rather than shipping a message nobody has ever rendered.
 */
const PAYLOADS: Record<TemplateName, unknown> = {
  "sign-in-code": { code: "408213" },
  "mail-test": { note: "pre-launch check" },
  "application-deficiency": {
    reference: "LCCI-APP-2026-00001",
    firmName: "Shalimar Textiles",
    summary: "Two documents need replacing before verification can continue.",
    respondBy: "20 November 2026",
    items: [
      "Re-upload the CNIC of B. Partner: the scan is cut off at the edge.",
      "Supply a bank account-maintenance certificate issued within the last three months.",
    ],
  },
  "application-approved": {
    reference: "LCCI-APP-2026-00001",
    firmName: "Shalimar Textiles",
    membershipNo: "LCCI-000142",
    membershipClass: "Corporate",
    validUntil: "31 March 2027",
    note: null,
  },
  "application-received": {
    reference: "LCCI-APP-2026-00001",
    firmName: "Shalimar Textiles",
    membershipClass: "Corporate",
    processingTier: "Urgent",
    dueDate: "20 November 2026",
    fees: [
      { label: "Membership fee", amount: "Rs 15,100" },
      {
        label: "International Trade Development surcharge",
        amount: "USD 750",
      },
    ],
  },
  "fee-receipted": {
    reference: "LCCI-APP-2026-00001",
    firmName: "Shalimar Textiles",
    receiptNo: "LCCI-RCPT-2026-00017",
    amount: "Rs 15,100",
    receivedOn: "28 October 2026",
    instrumentNo: "000412",
  },
  "application-not-approved": {
    reference: "LCCI-APP-2026-00001",
    firmName: "Shalimar Textiles",
    reason:
      "The partnership deed supplied is on plain paper. The Chamber requires it on Rs 1000 stamp paper.",
    feeReceipted: true,
  },
};

describe("email templates", () => {
  it("has a payload fixture for every template", () => {
    expect(Object.keys(PAYLOADS).sort()).toEqual([...TEMPLATE_NAMES].sort());
  });

  it("renders every template to a usable message", () => {
    for (const name of TEMPLATE_NAMES) {
      const message = renderTemplate(name, PAYLOADS[name]);

      expect(message.subject.length, name).toBeGreaterThan(0);
      expect(message.text.length, name).toBeGreaterThan(0);
      expect(message.stream, name).toMatch(/^(transactional|broadcast)$/);
    }
  });

  it("never renders a subject containing a newline", () => {
    // A newline in a subject is header injection, whether it arrived through a
    // bug or through an applicant-supplied value. The renderer must stop it;
    // the provider must never be asked to decide.
    for (const name of TEMPLATE_NAMES) {
      expect(renderTemplate(name, PAYLOADS[name]).subject, name).not.toMatch(/[\r\n]/);
    }
  });

  it("strips newlines from an echoed value rather than refusing the send", () => {
    const message = renderTemplate("mail-test", { note: "line one\r\nBcc: someone" });
    expect(message.subject).not.toMatch(/[\r\n]/);
    expect(message.subject).toContain("line one");
  });

  it("puts the sign-in code in the subject and the body", () => {
    const message = renderTemplate("sign-in-code", { code: "408213" });
    expect(message.subject).toContain("408213");
    expect(message.text).toContain("408213");
  });

  it("says a code expires and can be used once", () => {
    // The member needs to know both facts from the message itself: that a code
    // sitting in an old email will not work, and that forwarding it hands over
    // their account.
    const text = renderTemplate("sign-in-code", { code: "111111" }).text;
    expect(text).toMatch(/expires/i);
    expect(text).toMatch(/once/i);
  });

  it("rejects an unknown template name", () => {
    expect(() => renderTemplate("not-a-template", {})).toThrow(/Unknown email template/);
  });

  it("does not echo a malformed template name into the error", () => {
    // The name can arrive from a hand-edited queue row. An error message is
    // read in a log and sometimes shown in the admin panel, so it carries the
    // name only when the name looks like one.
    expect(() => renderTemplate("<script>x</script>", {})).toThrow(/<invalid>/);
  });

  it("rejects a payload that is not an object", () => {
    for (const payload of [null, "a string", 42, undefined]) {
      expect(() => renderTemplate("sign-in-code", payload)).toThrow(/not an object/);
    }
  });

  it("keeps every template's stream a property of the template", () => {
    // Not of the call site. Whether a message is transactional is a fact about
    // the message, and letting callers choose is how a renewal broadcast ends
    // up on the stream that sign-in delivery depends on.
    for (const name of TEMPLATE_NAMES) {
      expect(TEMPLATES[name].stream, name).toMatch(/^(transactional|broadcast)$/);
      expect(TEMPLATES[name].trigger.length, name).toBeGreaterThan(10);
    }
  });

  it("names templates so they fit the column and the log filter", () => {
    // `email_outbox.template` is VARCHAR(60).
    for (const name of TEMPLATE_NAMES) {
      expect(name, name).toMatch(/^[a-z0-9-]{1,60}$/);
    }
  });
});

describe("outbox retry backoff", () => {
  it("grows with each attempt", () => {
    for (let attempts = 1; attempts < MAX_ATTEMPTS - 1; attempts += 1) {
      expect(backoffMs(attempts + 1)).toBeGreaterThan(backoffMs(attempts));
    }
  });

  it("is capped, so a retry never lands days away", () => {
    expect(backoffMs(99)).toBeLessThanOrEqual(4 * 60 * 60 * 1000);
  });

  it("waits long enough to be worth retrying", () => {
    // A retry a few seconds after a provider rejection just reproduces the
    // rejection, and counts against the domain a second time.
    expect(backoffMs(1)).toBeGreaterThanOrEqual(5 * 60_000);
  });

  it("gives up rather than retrying forever", () => {
    // On a five-minute tick, an uncapped retry is 288 attempts a day against a
    // provider that counts every rejection against the sending domain.
    expect(MAX_ATTEMPTS).toBeGreaterThan(2);
    expect(MAX_ATTEMPTS).toBeLessThan(12);
  });
});
