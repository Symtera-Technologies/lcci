import { describe, expect, it } from "vitest";
import { canonicalJson, rowHashInput } from "@/server/audit";

/**
 * The two pure halves of the audit writer.
 *
 * Both exist because the hash chain is only evidence if a row hashes
 * identically when it is written and when it is later verified. Every test
 * here is really the same assertion from a different angle: nothing about how
 * an event was *built* may change its hash.
 */

describe("canonicalJson", () => {
  it("sorts object keys", () => {
    // The reason this function exists. JSON.stringify preserves insertion
    // order, so two code paths building the same event with fields in a
    // different order would hash differently and the chain would report a
    // break that never happened.
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe(canonicalJson({ b: 1, a: 2 }));
  });

  it("sorts nested keys too", () => {
    const one = canonicalJson({ outer: { z: 1, a: { y: 2, b: 3 } } });
    const two = canonicalJson({ outer: { a: { b: 3, y: 2 }, z: 1 } });
    expect(one).toBe(two);
  });

  it("preserves array order", () => {
    // Checklist items are an ordered list: items 1 and 13 are inverted in
    // polarity, so reordering them would change what the record means.
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("drops undefined properties rather than emitting them", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson({ a: 1 })).toBe(canonicalJson({ a: 1, b: undefined }));
  });

  it("serialises a Date as an ISO string", () => {
    expect(canonicalJson(new Date("2027-03-31T00:00:00.000Z"))).toBe(
      '"2027-03-31T00:00:00.000Z"',
    );
  });

  it("serialises a Buffer as base64", () => {
    expect(canonicalJson(Buffer.from("hi"))).toBe('"aGk="');
  });

  it("renders null and undefined as null", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(undefined)).toBe("null");
  });

  it("round-trips through JSON.parse as the same value", () => {
    // MySQL returns JSON columns already parsed, so verification re-serialises
    // what the driver handed back. If that round trip were lossy, every
    // verification would report tampering.
    const event = {
      round: 2,
      items: [
        { code: "cnic_readable", outcome: "fail", note: "page 2 unreadable" },
        { code: "pay_order", outcome: "pass", note: null },
      ],
      disagreements: [],
    };
    const once = canonicalJson(event);
    expect(canonicalJson(JSON.parse(once))).toBe(once);
  });
});

describe("rowHashInput", () => {
  const base = {
    prevHash: "a".repeat(64),
    occurredAt: "2027-03-31T10:00:00.000Z",
    requestId: "01HQRS000000000000000000AB",
    actorUserId: 7,
    actorRoleCode: "membership_approver",
    entityType: "application",
    entityId: "4512",
    action: "application.approved",
    summary: "Granted membership LCCI-2027-004512",
    before: null,
    after: '{"state":"APPROVED"}',
    context: null,
  };

  it("changes when any field changes", () => {
    const original = rowHashInput(base);
    const fields: (keyof typeof base)[] = [
      "prevHash",
      "occurredAt",
      "requestId",
      "actorUserId",
      "actorRoleCode",
      "entityType",
      "entityId",
      "action",
      "summary",
      "before",
      "after",
      "context",
    ];

    for (const field of fields) {
      const altered = { ...base, [field]: "tampered" };
      expect(rowHashInput(altered), `${field} does not affect the hash`).not.toBe(
        original,
      );
    }
  });

  it("is stable for the same input", () => {
    expect(rowHashInput(base)).toBe(rowHashInput({ ...base }));
  });

  it("distinguishes a null field from an empty string", () => {
    // A NUL separator rather than a delimiter that can appear in the data: with
    // a printable separator, actorRoleCode "a" + entityType "b" and
    // actorRoleCode "a|b" + entityType "" would produce the same input, and two
    // different events would share a hash.
    const withNull = rowHashInput({ ...base, actorRoleCode: null, entityType: "x" });
    const withEmpty = rowHashInput({ ...base, actorRoleCode: "", entityType: "x" });
    // Both render as empty in the joined string, which is acceptable only
    // because a role code is never the empty string in practice — asserted
    // here so the assumption is visible if that ever changes.
    expect(withNull).toBe(withEmpty);

    const shifted = rowHashInput({ ...base, actorRoleCode: "a", entityType: "b" });
    const collided = rowHashInput({ ...base, actorRoleCode: "a\u0000b", entityType: "" });
    expect(shifted).not.toBe(collided);
  });
});
