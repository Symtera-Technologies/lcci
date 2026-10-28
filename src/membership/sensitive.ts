import "server-only";

import { hmacHex, packSealed, seal, unpackSealed, unseal } from "@/server/crypto";

/**
 * The encrypted identity columns, and the lookup hashes beside them.
 *
 * A CNIC is the most sensitive field in this system. It is encrypted at rest
 * with the application's master key, and — this is the part that matters — it
 * is **never indexed in plaintext**. An index on the plaintext would hand the
 * whole point back: `ORDER BY` on an encrypted column is useless, but an index
 * on the clear value means a database dump yields every CNIC without needing
 * the key at all.
 *
 * Equality lookup still has to work, because the office genuinely asks "has
 * this person applied before". So each encrypted column has a peppered HMAC
 * beside it. That supports exact match and nothing else — no range scan, no
 * prefix search, no sorting — and the pepper means a stolen database cannot
 * be brute-forced back to CNICs, which an unpeppered hash absolutely could:
 * the CNIC space is enumerable.
 *
 * What this does not protect against is application compromise, since the
 * application can obviously decrypt what it encrypts. It protects against
 * filesystem and backup exposure, which on a shared host with no disk
 * encryption is most of the realistic threat.
 */

/**
 * Additional authenticated data, binding ciphertext to where it lives.
 *
 * Without it, a row's ciphertext could be copied into another row or another
 * column and would still decrypt — so a director's CNIC could be moved onto
 * the representative, or an NTN presented as a passport number. The AAD makes
 * that a decryption failure rather than a silent substitution.
 */
function aadFor(table: string, rowId: number | string, column: string): string {
  return `${table}:${rowId}:${column}`;
}

export interface SensitiveField {
  /** The sealed bytes, ready for a VARBINARY column. */
  readonly enc: Buffer;
  /** The peppered HMAC, for the lookup index. */
  readonly hmac: string;
}

/**
 * Normalise before hashing, or the lookup silently fails.
 *
 * `42201-1234567-8` and `4220112345678` are the same CNIC and must produce the
 * same HMAC, otherwise "has this person applied before" answers no whenever
 * the two applications typed it differently — which is the common case, and a
 * failure that looks like correct behaviour.
 */
export function normaliseIdentityNumber(value: string): string {
  return value.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}

export function sealField(
  table: string,
  rowId: number | string,
  column: string,
  plaintext: string,
): SensitiveField {
  const trimmed = plaintext.trim();
  return {
    enc: packSealed(seal(trimmed, aadFor(table, rowId, column))),
    // Hashed from the normalised form; encrypted from what the applicant
    // typed, so a certificate can reproduce their own formatting.
    hmac: hmacHex(normaliseIdentityNumber(trimmed)),
  };
}

export function openField(
  table: string,
  rowId: number | string,
  column: string,
  packed: Buffer | null,
): string | null {
  if (packed === null || packed.length === 0) return null;
  return unseal(unpackSealed(packed), aadFor(table, rowId, column));
}

/** The HMAC alone, for a lookup that must not decrypt anything. */
export function identityLookupHash(value: string): string {
  return hmacHex(normaliseIdentityNumber(value));
}
