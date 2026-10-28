import "server-only";

import { Transform, type TransformCallback } from "node:stream";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Document encryption at rest: fixed-size chunked AES-256-GCM.
 *
 * This is decided here, before the upload route exists, because it is not
 * retrofittable. Encrypting a document as one GCM stream is simpler and is
 * wrong for this system: GCM authenticates the whole ciphertext, so serving
 * bytes 2,000,000–2,065,535 of a 40-page SECP filing would mean decrypting
 * everything before it. `Accept-Ranges` is not a nicety here — pdf.js and
 * every native PDF viewer use ranges to render page one without fetching the
 * file, and on a Pakistani mobile connection that is the difference between a
 * usable review queue and an unusable one. Choosing whole-file GCM now and
 * discovering that later means re-encrypting every stored document.
 *
 * So: the plaintext is cut into fixed 64 KB chunks, each sealed independently.
 * A byte range maps to chunk indices by division, and only those chunks are
 * read and decrypted.
 *
 * **What this protects against, stated honestly.** Filesystem exposure — a
 * backup tarball leaving the server, cPanel's own backup store, a stray path
 * readable by another tenant on shared hosting where no disk encryption is
 * available at all. It does **not** protect against application compromise,
 * because the application can obviously decrypt what it encrypts. That is
 * still most of the realistic threat model, and the limitation belongs in
 * writing rather than in an assumption.
 *
 * **Independent chunks are a trap, so three things bind them together.**
 * Sealing each chunk separately would otherwise let anyone with write access
 * reorder them, drop the tail, or move a chunk between two documents, all
 * without breaking a single tag. Each chunk's AAD therefore carries:
 *
 *   - the **header**, so the chunk size and nonce prefix cannot be altered;
 *   - the **document id**, so a chunk cannot be moved into another document's
 *     file — the same binding the encrypted columns use;
 *   - the **chunk index**, so chunks cannot be reordered or duplicated;
 *   - a **final flag**, so the file cannot be truncated at a chunk boundary.
 *     Truncation is the one that a careless design misses: without it, cutting
 *     a file after chunk 3 produces something that decrypts perfectly and is
 *     simply a shorter document.
 *
 * The IV is the header's 8-byte random prefix plus the chunk index as a
 * counter, so no two chunks in a document share an IV and no two documents
 * share a prefix. Reusing an IV under one key is the failure that breaks GCM
 * completely rather than partially, which is why it is derived rather than
 * generated per chunk.
 *
 * The key is a per-document data key, wrapped under the master key by
 * `wrapDataKey` and stored on the row. Per-document rather than one key for
 * everything, so the 64 KB IV counter space is per document, and so a single
 * disclosed data key costs one document.
 */

/** 64 KB of plaintext per chunk. */
export const CHUNK_PLAINTEXT_BYTES = 64 * 1024;

/** GCM tag, appended to each chunk's ciphertext. */
export const TAG_BYTES = 16;

export const HEADER_BYTES = 24;

const MAGIC = Buffer.from("LCCIDOC\u0001", "latin1");
const VERSION = 1;

/** Ciphertext bytes per full chunk, including its tag. */
export function sealedChunkBytes(chunkSize: number): number {
  return chunkSize + TAG_BYTES;
}

/* -------------------------------------------------------------------------- */
/* Header                                                                     */
/* -------------------------------------------------------------------------- */

export interface CipherHeader {
  version: number;
  chunkSize: number;
  /** The raw 24 bytes, which are the AAD prefix for every chunk. */
  bytes: Buffer;
}

export function createHeader(chunkSize = CHUNK_PLAINTEXT_BYTES): CipherHeader {
  const bytes = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(bytes, 0);
  bytes.writeUInt8(VERSION, 8);
  // Bytes 9-11 reserved, left zero. Deliberately present: a future change to
  // the cipher or the chunk layout needs somewhere to say so, and adding a
  // field later without a reserved space means a second header format.
  bytes.writeUInt32BE(chunkSize, 12);
  randomBytes(8).copy(bytes, 16);
  return { version: VERSION, chunkSize, bytes };
}

/**
 * Read a header, refusing anything it does not recognise.
 *
 * Strict about the chunk size as well as the magic. The size is used to
 * allocate and to compute offsets, so a header claiming a 4 GB chunk is an
 * out-of-memory attempt dressed as a corrupt file.
 */
export function parseHeader(bytes: Buffer): CipherHeader {
  if (bytes.length < HEADER_BYTES) {
    throw new Error("Document is shorter than its header");
  }

  const header = bytes.subarray(0, HEADER_BYTES);

  if (!header.subarray(0, 8).equals(MAGIC)) {
    throw new Error("Document is not in the expected encrypted format");
  }

  const version = header.readUInt8(8);
  if (version !== VERSION) {
    throw new Error(`Unsupported document cipher version: ${version}`);
  }

  const chunkSize = header.readUInt32BE(12);
  if (chunkSize < 4096 || chunkSize > 1024 * 1024 || chunkSize % 4096 !== 0) {
    throw new Error("Document header declares an implausible chunk size");
  }

  return { version, chunkSize, bytes: Buffer.from(header) };
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Where a chunk's sealed bytes start in the file.
 *
 * The whole reason for fixed-size chunks: this is arithmetic rather than an
 * index that has to be stored, kept in step and trusted.
 */
export function ciphertextOffsetOf(index: number, chunkSize: number): number {
  return HEADER_BYTES + index * sealedChunkBytes(chunkSize);
}

/** How many chunks a stored file holds. */
export function chunkCount(storedBytes: number, chunkSize: number): number {
  const body = storedBytes - HEADER_BYTES;
  if (body <= 0) return 0;
  return Math.ceil(body / sealedChunkBytes(chunkSize));
}

/**
 * The plaintext length a stored file decrypts to.
 *
 * Derived rather than recorded in the header, for one practical reason: the
 * length is not known while streaming an upload, and writing a header and then
 * seeking back to patch it is a local-disk trick that would not survive the
 * move to object storage the capacity table calls for.
 *
 * Deriving it is safe because the final chunk's AAD says it is final. Dropping
 * whole chunks leaves a last chunk whose AAD claims otherwise and fails to
 * authenticate; trimming bytes inside a chunk breaks its tag. So a shortened
 * file is a decryption failure, not a shorter document.
 */
export function plaintextLength(storedBytes: number, chunkSize: number): number {
  const chunks = chunkCount(storedBytes, chunkSize);
  if (chunks === 0) return 0;

  const lastSealed =
    storedBytes - HEADER_BYTES - (chunks - 1) * sealedChunkBytes(chunkSize);
  const lastPlain = lastSealed - TAG_BYTES;

  if (lastPlain < 0 || lastPlain > chunkSize) {
    throw new Error("Stored document length is not consistent with its header");
  }

  return (chunks - 1) * chunkSize + lastPlain;
}

/** The chunk indices covering a closed byte range, inclusive at both ends. */
export function chunksForRange(
  start: number,
  endInclusive: number,
  chunkSize: number,
): { first: number; last: number } {
  return {
    first: Math.floor(start / chunkSize),
    last: Math.floor(endInclusive / chunkSize),
  };
}

/* -------------------------------------------------------------------------- */
/* Sealing                                                                    */
/* -------------------------------------------------------------------------- */

function ivFor(header: CipherHeader, index: number): Buffer {
  const iv = Buffer.alloc(12);
  header.bytes.copy(iv, 0, 16, 24);
  iv.writeUInt32BE(index, 8);
  return iv;
}

/**
 * The additional authenticated data for one chunk.
 *
 * Everything that must not be changeable without detection, and nothing that
 * is secret — AAD is authenticated, not encrypted.
 */
function aadFor(
  header: CipherHeader,
  documentId: string,
  index: number,
  final: boolean,
): Buffer {
  const suffix = Buffer.alloc(5);
  suffix.writeUInt32BE(index, 0);
  suffix.writeUInt8(final ? 1 : 0, 4);
  return Buffer.concat([header.bytes, Buffer.from(documentId, "utf8"), suffix]);
}

export function encryptChunk(
  key: Buffer,
  header: CipherHeader,
  documentId: string,
  index: number,
  final: boolean,
  plaintext: Buffer,
): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, ivFor(header, index));
  cipher.setAAD(aadFor(header, documentId, index, final));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([body, cipher.getAuthTag()]);
}

/**
 * Decrypt one chunk, or throw.
 *
 * Throws on any tag failure, which is the only acceptable behaviour: a
 * partially authenticated document is not a document, and returning the
 * plaintext of a chunk whose tag failed would hand the caller bytes an
 * attacker chose.
 */
export function decryptChunk(
  key: Buffer,
  header: CipherHeader,
  documentId: string,
  index: number,
  final: boolean,
  sealed: Buffer,
): Buffer {
  if (sealed.length < TAG_BYTES) {
    throw new Error(`Chunk ${index} is too short to carry a tag`);
  }

  const body = sealed.subarray(0, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);

  const decipher = createDecipheriv("aes-256-gcm", key, ivFor(header, index));
  decipher.setAAD(aadFor(header, documentId, index, final));
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/* -------------------------------------------------------------------------- */
/* Streaming                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A Transform that turns a plaintext stream into a stored document.
 *
 * Memory is one chunk plus one chunk of lookahead, regardless of file size.
 * That constraint is the reason this is a stream at all: a 300 dpi A4 scan
 * buffered in a Passenger worker, on a plan that OOMs during `next build`, is
 * a site-wide outage triggered by an applicant from a public form.
 *
 * The lookahead exists because a chunk's AAD must say whether it is the last
 * one, and that is not knowable until either more data arrives or the stream
 * ends. So a completed chunk is held back until one of those happens. Without
 * it there would be no way to mark the final chunk, and no way to detect
 * truncation.
 */
export function createEncryptor(
  key: Buffer,
  documentId: string,
  header: CipherHeader = createHeader(),
): Transform & { readonly header: CipherHeader } {
  const chunkSize = header.chunkSize;

  let pending: Buffer = Buffer.alloc(0);
  /** A full chunk held back until we know whether it is the last. */
  let held: Buffer | null = null;
  let index = 0;
  let headerWritten = false;

  const stream = new Transform({
    transform(piece: Buffer, _encoding, callback: TransformCallback) {
      try {
        if (!headerWritten) {
          this.push(header.bytes);
          headerWritten = true;
        }

        // Always concat rather than reslice. `subarray` returns a view over
        // the incoming buffer, and holding a view keeps the whole arrival
        // alive — which for a 64 KB chunk carved out of a 1 MB socket read is
        // sixteen times the memory this is supposed to bound.
        pending = Buffer.concat([pending, piece]);

        while (pending.length >= chunkSize) {
          const full = Buffer.concat([pending.subarray(0, chunkSize)]);
          pending = Buffer.concat([pending.subarray(chunkSize)]);

          if (held !== null) {
            this.push(encryptChunk(key, header, documentId, index, false, held));
            index += 1;
          }
          held = full;
        }

        callback();
      } catch (error) {
        callback(error as Error);
      }
    },

    flush(callback: TransformCallback) {
      try {
        if (!headerWritten) {
          this.push(header.bytes);
          headerWritten = true;
        }

        // An empty document is one empty final chunk rather than no chunks, so
        // that `chunkCount` and the final flag stay meaningful and a zero-byte
        // file is still authenticated.
        if (held === null && pending.length === 0) {
          this.push(encryptChunk(key, header, documentId, 0, true, Buffer.alloc(0)));
          return callback();
        }

        if (held !== null) {
          const isFinal = pending.length === 0;
          this.push(encryptChunk(key, header, documentId, index, isFinal, held));
          index += 1;
          held = null;
        }

        if (pending.length > 0) {
          this.push(encryptChunk(key, header, documentId, index, true, pending));
          pending = Buffer.alloc(0);
        }

        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });

  return Object.defineProperty(stream, "header", {
    value: header,
    enumerable: true,
  }) as Transform & { readonly header: CipherHeader };
}

/**
 * Decrypt a byte range, given a reader over the stored file.
 *
 * `readAt` is supplied by the `DocumentStore`, so this works unchanged over a
 * local file today and over an object store's ranged GET later — which is the
 * migration the capacity table says is coming.
 *
 * Returns exactly the requested bytes, having decrypted only the chunks that
 * overlap them.
 */
export async function decryptRange(
  key: Buffer,
  header: CipherHeader,
  documentId: string,
  storedBytes: number,
  start: number,
  endInclusive: number,
  readAt: (offset: number, length: number) => Promise<Buffer>,
): Promise<Buffer> {
  const total = plaintextLength(storedBytes, header.chunkSize);
  if (total === 0 || start >= total) return Buffer.alloc(0);

  const end = Math.min(endInclusive, total - 1);
  const chunks = chunkCount(storedBytes, header.chunkSize);
  const { first, last } = chunksForRange(start, end, header.chunkSize);

  const pieces: Buffer[] = [];

  for (let index = first; index <= last && index < chunks; index += 1) {
    const final = index === chunks - 1;
    const offset = ciphertextOffsetOf(index, header.chunkSize);
    const sealedLength = final
      ? storedBytes - offset
      : sealedChunkBytes(header.chunkSize);

    const sealed = await readAt(offset, sealedLength);
    const plain = decryptChunk(key, header, documentId, index, final, sealed);

    const chunkStart = index * header.chunkSize;
    const from = Math.max(0, start - chunkStart);
    const to = Math.min(plain.length, end - chunkStart + 1);
    pieces.push(plain.subarray(from, to));
  }

  return Buffer.concat(pieces);
}
