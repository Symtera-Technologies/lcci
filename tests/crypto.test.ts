import { describe, expect, it } from "vitest";
import {
  hashIp,
  hashOtpCode,
  hashPassword,
  hmacHex,
  newDataKey,
  newOtpCode,
  newSalt,
  newToken,
  newUlid,
  seal,
  sha256Hex,
  timingSafeEqualHex,
  unseal,
  unwrapDataKey,
  verifyPassword,
  wrapDataKey,
} from "@/server/crypto";

describe("hashing", () => {
  it("peppers IP hashes so the IPv4 space cannot be enumerated", () => {
    // An unkeyed hash of an IPv4 address is reversible in minutes — the space
    // is only four billion. The pepper is what makes the stored digest useless
    // to anyone holding only the database.
    const ip = "203.0.113.7";
    expect(hashIp(ip)).not.toBe(sha256Hex(ip));
    expect(hashIp(ip)).toBe(hmacHex(`ip:${ip}`));
  });

  it("maps an unknown address to null rather than to a shared hash", () => {
    // Hashing the empty string would make every unknown address identical and
    // indistinguishable from a real one, which quietly poisons both the rate
    // limiter and any audit correlation.
    expect(hashIp(null)).toBeNull();
    expect(hashIp(undefined)).toBeNull();
    expect(hashIp("")).toBeNull();
  });

  it("gives the same address the same hash, for correlation", () => {
    expect(hashIp("198.51.100.4")).toBe(hashIp("198.51.100.4"));
    expect(hashIp("198.51.100.4")).not.toBe(hashIp("198.51.100.5"));
  });
});

describe("timingSafeEqualHex", () => {
  it("accepts equal values and rejects unequal ones", () => {
    const digest = sha256Hex("x");
    expect(timingSafeEqualHex(digest, digest)).toBe(true);
    expect(timingSafeEqualHex(digest, sha256Hex("y"))).toBe(false);
  });

  it("returns false on a length mismatch instead of throwing", () => {
    // timingSafeEqual throws on mismatched lengths, and an exception escaping
    // a bearer-token comparison is a 500 where a 404 was intended.
    expect(timingSafeEqualHex("abcd", "abcdef")).toBe(false);
    expect(timingSafeEqualHex("", sha256Hex("x"))).toBe(false);
  });

  it("returns false on non-hex input instead of throwing", () => {
    expect(timingSafeEqualHex("zzzz", "zzzz")).toBe(true);
  });
});

describe("newUlid", () => {
  it("is 26 Crockford-base32 characters", () => {
    expect(newUlid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("sorts lexicographically by time", () => {
    // The request id correlates audit events, and the audit log is read
    // chronologically. A UUIDv4 would need a timestamp join for every read.
    const early = newUlid(1_700_000_000_000);
    const later = newUlid(1_800_000_000_000);
    expect(early < later).toBe(true);
  });

  it("differs for two calls at the same instant", () => {
    const now = Date.now();
    expect(newUlid(now)).not.toBe(newUlid(now));
  });
});

describe("one-time codes", () => {
  it("are always six digits, including when the value is small", () => {
    // Padding matters: an unpadded 42 would be a two-character code, and the
    // guess space would collapse for whoever received it.
    for (let i = 0; i < 200; i += 1) {
      expect(newOtpCode()).toMatch(/^\d{6}$/);
    }
  });

  it("hash differently under different salts", () => {
    // Per-row salt, so two users holding the same code at the same time do not
    // share a digest — which would otherwise make the table searchable by code.
    const code = "123456";
    expect(hashOtpCode(code, newSalt())).not.toBe(hashOtpCode(code, newSalt()));
  });

  it("hash deterministically under the same salt", () => {
    const salt = newSalt();
    expect(hashOtpCode("123456", salt)).toBe(hashOtpCode("123456", salt));
  });
});

describe("session tokens", () => {
  it("are 32 bytes of base64url", () => {
    const token = newToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  it("are unique", () => {
    const tokens = new Set(Array.from({ length: 500 }, () => newToken()));
    expect(tokens.size).toBe(500);
  });
});

describe("passwords", () => {
  it("round-trips", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(verifyPassword("Correct horse battery staple", stored)).toBe(false);
  });

  it("salts, so two accounts with one password do not share a digest", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  it("carries its parameters, so they can be raised later", () => {
    // Without the parameters in the digest, raising the cost factor would
    // invalidate every existing password at once.
    expect(hashPassword("x")).toMatch(/^scrypt\$32768\$8\$1\$/);
  });

  it("normalises Unicode so an equivalent password still verifies", () => {
    // é typed as one code point and as e + combining accent are the same
    // password to the person typing it. Without NFKC they are not the same
    // bytes, and the user is locked out by their own keyboard layout.
    const composed = "passéword";
    const decomposed = "passéword";
    expect(composed).not.toBe(decomposed);
    expect(verifyPassword(decomposed, hashPassword(composed))).toBe(true);
  });

  it("rejects a malformed stored value rather than throwing", () => {
    for (const stored of ["", "nonsense", "scrypt$x$8$1$aa$bb", "bcrypt$1$2$3$4$5"]) {
      expect(verifyPassword("x", stored)).toBe(false);
    }
  });
});

describe("AES-256-GCM", () => {
  it("round-trips a value with its context", () => {
    const sealed = seal("4220112345678", "application_company.rep_cnic:42");
    expect(unseal(sealed, "application_company.rep_cnic:42")).toBe("4220112345678");
  });

  it("refuses to decrypt under a different context", () => {
    // The AAD binds the ciphertext to its row and column, so a CNIC value
    // cannot be copied into another applicant's row and still authenticate.
    const sealed = seal("4220112345678", "application_company.rep_cnic:42");
    expect(() => unseal(sealed, "application_company.rep_cnic:43")).toThrow();
  });

  it("refuses to decrypt a tampered ciphertext", () => {
    const sealed = seal("secret", "ctx");
    sealed.ciphertext[0] ^= 0xff;
    expect(() => unseal(sealed, "ctx")).toThrow();
  });

  it("refuses a tampered authentication tag", () => {
    const sealed = seal("secret", "ctx");
    sealed.tag[0] ^= 0xff;
    expect(() => unseal(sealed, "ctx")).toThrow();
  });

  it("uses a fresh IV each time", () => {
    // A reused IV under the same key is catastrophic for GCM: it leaks the
    // XOR of the plaintexts and, worse, the authentication subkey.
    const a = seal("same", "ctx");
    const b = seal("same", "ctx");
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("wraps and unwraps a document data key", () => {
    const dataKey = newDataKey();
    expect(dataKey).toHaveLength(32);
    const wrapped = wrapDataKey(dataKey, "documents:abc");
    expect(unwrapDataKey(wrapped, "documents:abc").equals(dataKey)).toBe(true);
    expect(() => unwrapDataKey(wrapped, "documents:xyz")).toThrow();
  });
});
