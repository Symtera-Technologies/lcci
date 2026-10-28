import { describe, expect, it } from "vitest";
import {
  STEP_SECONDS,
  base32Decode,
  base32Encode,
  currentStep,
  matchingStep,
  newRecoveryCode,
  newTotpSecret,
  normaliseRecoveryCode,
  otpauthUri,
  totpCode,
} from "@/server/auth/totp";

/**
 * The hand-rolled TOTP implementation, against the specification.
 *
 * Worth testing against RFC 6238's own vectors rather than against itself: a
 * generator and a verifier written in the same file will agree with each other
 * even when both are wrong, and the failure mode is staff who cannot sign in
 * with a correctly configured authenticator app — reported as "the app is
 * broken", diagnosed nowhere near this file.
 */

/** RFC 4648 §10. The base32 test vectors, which have no padding here. */
describe("base32", () => {
  it("matches RFC 4648 for the standard vectors", () => {
    const vectors: ReadonlyArray<[string, string]> = [
      ["f", "MY"],
      ["fo", "MZXQ"],
      ["foo", "MZXW6"],
      ["foob", "MZXW6YQ"],
      ["fooba", "MZXW6YTB"],
      ["foobar", "MZXW6YTBOI"],
    ];

    for (const [plain, encoded] of vectors) {
      expect(base32Encode(Buffer.from(plain, "utf8"))).toBe(encoded);
      expect(base32Decode(encoded).toString("utf8")).toBe(plain);
    }
  });

  it("emits no padding, because Google Authenticator rejects it", () => {
    const { base32 } = newTotpSecret();
    expect(base32).not.toContain("=");
    expect(base32).toMatch(/^[A-Z2-7]+$/);
  });

  it("round-trips a 20-byte secret and tolerates how a person types it", () => {
    const { secret, base32 } = newTotpSecret();
    expect(base32Decode(base32).equals(secret)).toBe(true);

    // Grouped in fours on screen, so spaces and lower case come back.
    const asTyped = base32.replace(/(.{4})/g, "$1 ").trim().toLowerCase();
    expect(base32Decode(asTyped).equals(secret)).toBe(true);
  });
});

describe("totpCode", () => {
  /**
   * RFC 6238 Appendix B, the SHA-1 rows.
   *
   * The published vectors use the ASCII seed "12345678901234567890", and the
   * step is the Unix time divided by 30.
   */
  const seed = Buffer.from("12345678901234567890", "utf8");

  it("matches the published SHA-1 vectors", () => {
    const vectors: ReadonlyArray<[number, string]> = [
      [59, "287082"],
      [1111111109, "081804"],
      [1111111111, "050471"],
      [1234567890, "005924"],
      [2000000000, "279037"],
      [20000000000, "353130"],
    ];

    for (const [seconds, expected] of vectors) {
      expect(totpCode(seed, Math.floor(seconds / STEP_SECONDS))).toBe(expected);
    }
  });

  it("always returns six digits, including when the truncation is small", () => {
    for (let step = 0; step < 200; step += 1) {
      expect(totpCode(seed, step)).toMatch(/^\d{6}$/);
    }
  });
});

describe("matchingStep", () => {
  const { secret } = newTotpSecret();
  const at = 1_767_000_000_000;
  const step = currentStep(at);

  it("accepts the current code and returns the step that matched", () => {
    expect(matchingStep(secret, totpCode(secret, step), at)).toBe(step);
  });

  it("accepts one step either side, for clock drift", () => {
    expect(matchingStep(secret, totpCode(secret, step - 1), at)).toBe(step - 1);
    expect(matchingStep(secret, totpCode(secret, step + 1), at)).toBe(step + 1);
  });

  it("refuses two steps away, so the window stays 90 seconds", () => {
    expect(matchingStep(secret, totpCode(secret, step - 2), at)).toBeNull();
    expect(matchingStep(secret, totpCode(secret, step + 2), at)).toBeNull();
  });

  it("refuses a code of the wrong length rather than padding it", () => {
    const code = totpCode(secret, step);
    expect(matchingStep(secret, code.slice(1), at)).toBeNull();
    expect(matchingStep(secret, `0${code}`, at)).toBeNull();
    expect(matchingStep(secret, "", at)).toBeNull();
  });

  it("tolerates a space typed into the middle of the code", () => {
    const code = totpCode(secret, step);
    expect(matchingStep(secret, `${code.slice(0, 3)} ${code.slice(3)}`, at)).toBe(
      step,
    );
  });

  it("refuses another account's code", () => {
    const other = newTotpSecret().secret;
    expect(matchingStep(secret, totpCode(other, step), at)).toBeNull();
  });
});

describe("otpauthUri", () => {
  it("carries the issuer in both places an authenticator reads it", () => {
    const uri = otpauthUri({
      secret: "MZXW6YTBOI",
      accountName: "officer@lcci.org.pk",
      issuer: "LCCI",
    });

    // The colon in the label is percent-encoded, which the otpauth spec
    // permits and every authenticator app accepts.
    expect(
      uri.startsWith("otpauth://totp/LCCI%3Aofficer%40lcci.org.pk?"),
    ).toBe(true);
    expect(uri).toContain("secret=MZXW6YTBOI");
    expect(uri).toContain("issuer=LCCI");
  });
});

describe("recovery codes", () => {
  it("avoids the characters people misread off a screen", () => {
    for (let i = 0; i < 200; i += 1) {
      // No I, L, O, U, 0 or 1 — a code read aloud or copied by hand must not
      // hinge on telling O from 0.
      expect(newRecoveryCode()).toMatch(/^[2-9A-HJ-KM-NP-TV-Z-]+$/);
    }
  });

  it("normalises how a person types one back", () => {
    const code = newRecoveryCode();
    expect(normaliseRecoveryCode(code.toLowerCase())).toBe(
      normaliseRecoveryCode(code),
    );
    expect(normaliseRecoveryCode(` ${code.replace(/-/g, " ")} `)).toBe(
      normaliseRecoveryCode(code),
    );
  });
});
