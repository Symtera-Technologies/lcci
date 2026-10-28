import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import {
  CHUNK_PLAINTEXT_BYTES,
  HEADER_BYTES,
  TAG_BYTES,
  chunkCount,
  chunksForRange,
  ciphertextOffsetOf,
  createEncryptor,
  createHeader,
  decryptChunk,
  decryptRange,
  encryptChunk,
  parseHeader,
  plaintextLength,
  sealedChunkBytes,
} from "@/server/documents/cipher";

/**
 * The chunked-GCM container, tested as the thing the whole document store
 * rests on.
 *
 * Independent per-chunk seals are the part that is easy to get subtly wrong,
 * so most of what follows is not round-tripping — it is the four ways a file
 * with valid individual tags can still be a forgery: reordered chunks, a
 * truncated tail, a chunk moved between documents, and an edited header.
 */

/** 4 KB keeps the tests fast; the geometry is identical at 64 KB. */
const CHUNK = 4096;
const KEY = randomBytes(32);
const DOC = "7f1c9a48-0b2e-4d61-9a3f-55c1ee0a9b10";

async function seal(
  plaintext: Buffer,
  { key = KEY, documentId = DOC, chunkSize = CHUNK } = {},
): Promise<{ stored: Buffer; header: ReturnType<typeof createHeader> }> {
  const header = createHeader(chunkSize);
  const encryptor = createEncryptor(key, documentId, header);
  const out: Buffer[] = [];

  await pipeline(Readable.from([plaintext]), encryptor, async function (source) {
    for await (const piece of source) out.push(piece as Buffer);
  });

  return { stored: Buffer.concat(out), header };
}

function readerOver(stored: Buffer) {
  return async (offset: number, length: number) =>
    stored.subarray(offset, offset + length);
}

async function open(
  stored: Buffer,
  documentId = DOC,
  key = KEY,
): Promise<Buffer> {
  const header = parseHeader(stored);
  const total = plaintextLength(stored.length, header.chunkSize);
  return decryptRange(
    key,
    header,
    documentId,
    stored.length,
    0,
    Math.max(0, total - 1),
    readerOver(stored),
  );
}

describe("document cipher round-trip", () => {
  const sizes = [0, 1, 17, CHUNK - 1, CHUNK, CHUNK + 1, CHUNK * 3, CHUNK * 3 + 7];

  for (const size of sizes) {
    it(`round-trips ${size} bytes`, async () => {
      const plaintext = randomBytes(size);
      const { stored } = await seal(plaintext);

      expect(plaintextLength(stored.length, CHUNK)).toBe(size);
      expect(await open(stored)).toEqual(plaintext);
    });
  }

  it("writes the header once, at the start", async () => {
    const { stored } = await seal(randomBytes(CHUNK * 2 + 10));
    expect(parseHeader(stored).chunkSize).toBe(CHUNK);
    expect(stored.length).toBeGreaterThan(HEADER_BYTES);
  });

  it("stores an empty document as one authenticated empty chunk", async () => {
    // Not zero chunks: a zero-byte file would otherwise be unauthenticated,
    // and "the document is empty" would be indistinguishable from "somebody
    // deleted the contents".
    const { stored } = await seal(Buffer.alloc(0));
    expect(stored.length).toBe(HEADER_BYTES + TAG_BYTES);
    expect(chunkCount(stored.length, CHUNK)).toBe(1);
  });

  it("costs one tag per chunk and nothing else", async () => {
    const plaintext = randomBytes(CHUNK * 4);
    const { stored } = await seal(plaintext);
    expect(stored.length).toBe(HEADER_BYTES + 4 * sealedChunkBytes(CHUNK));
  });

  it("gives two documents different nonce prefixes", () => {
    const prefixes = new Set(
      Array.from({ length: 200 }, () => createHeader(CHUNK).bytes.subarray(16, 24).toString("hex")),
    );
    expect(prefixes.size).toBe(200);
  });
});

describe("ranged reads", () => {
  it("returns exactly the requested slice, at every boundary that matters", async () => {
    const plaintext = randomBytes(CHUNK * 3 + 123);
    const { stored, header } = await seal(plaintext);
    const total = plaintext.length;

    const ranges: Array<[number, number]> = [
      [0, 0],
      [0, 10],
      [0, CHUNK - 1],
      [CHUNK - 1, CHUNK],
      [CHUNK, CHUNK * 2 - 1],
      [CHUNK + 5, CHUNK * 2 + 5],
      [CHUNK * 3, total - 1],
      [total - 1, total - 1],
      [0, total - 1],
    ];

    for (const [start, end] of ranges) {
      const got = await decryptRange(
        KEY,
        header,
        DOC,
        stored.length,
        start,
        end,
        readerOver(stored),
      );
      expect(got, `${start}-${end}`).toEqual(plaintext.subarray(start, end + 1));
    }
  });

  it("clamps a range that runs past the end", async () => {
    // What a viewer actually sends: `Range: bytes=0-` becomes an open-ended
    // request the route turns into a large end offset.
    const plaintext = randomBytes(500);
    const { stored, header } = await seal(plaintext);

    const got = await decryptRange(
      KEY,
      header,
      DOC,
      stored.length,
      0,
      999_999,
      readerOver(stored),
    );
    expect(got).toEqual(plaintext);
  });

  it("decrypts only the chunks a range touches", async () => {
    // The entire reason for fixed-size chunks. If this regresses, serving
    // page 1 of a 40-page filing reads the whole file.
    const plaintext = randomBytes(CHUNK * 10);
    const { stored, header } = await seal(plaintext);

    const reads: number[] = [];
    await decryptRange(
      KEY,
      header,
      DOC,
      stored.length,
      CHUNK * 7,
      CHUNK * 7 + 100,
      async (offset, length) => {
        reads.push(offset);
        return stored.subarray(offset, offset + length);
      },
    );

    expect(reads).toEqual([ciphertextOffsetOf(7, CHUNK)]);
  });

  it("maps ranges to chunk indices by division", () => {
    expect(chunksForRange(0, 0, CHUNK)).toEqual({ first: 0, last: 0 });
    expect(chunksForRange(CHUNK - 1, CHUNK, CHUNK)).toEqual({ first: 0, last: 1 });
    expect(chunksForRange(CHUNK * 5, CHUNK * 5, CHUNK)).toEqual({ first: 5, last: 5 });
  });
});

describe("tamper detection", () => {
  it("refuses a flipped ciphertext byte", async () => {
    const { stored } = await seal(randomBytes(CHUNK * 2));
    stored[HEADER_BYTES + 10] ^= 0xff;
    await expect(open(stored)).rejects.toThrow();
  });

  it("refuses a flipped tag byte", async () => {
    const { stored } = await seal(randomBytes(CHUNK * 2));
    stored[ciphertextOffsetOf(1, CHUNK) - 1] ^= 0xff;
    await expect(open(stored)).rejects.toThrow();
  });

  it("refuses reordered chunks", async () => {
    // Every individual tag is still valid here. Only the chunk index in the
    // AAD catches it, which is why the index is in the AAD.
    const { stored } = await seal(randomBytes(CHUNK * 3));
    const sealedLength = sealedChunkBytes(CHUNK);
    const first = Buffer.from(stored.subarray(HEADER_BYTES, HEADER_BYTES + sealedLength));
    const second = Buffer.from(
      stored.subarray(HEADER_BYTES + sealedLength, HEADER_BYTES + sealedLength * 2),
    );
    second.copy(stored, HEADER_BYTES);
    first.copy(stored, HEADER_BYTES + sealedLength);

    await expect(open(stored)).rejects.toThrow();
  });

  it("refuses a duplicated chunk", async () => {
    const { stored } = await seal(randomBytes(CHUNK * 3));
    const sealedLength = sealedChunkBytes(CHUNK);
    stored.copy(stored, HEADER_BYTES + sealedLength, HEADER_BYTES, HEADER_BYTES + sealedLength);
    await expect(open(stored)).rejects.toThrow();
  });

  it("refuses a file truncated at a chunk boundary", async () => {
    // The failure a careless design misses entirely: cut after chunk 1 and
    // every remaining tag is valid. The final flag in the AAD is what makes
    // the new last chunk fail to authenticate.
    const { stored } = await seal(randomBytes(CHUNK * 4));
    const truncated = stored.subarray(0, HEADER_BYTES + sealedChunkBytes(CHUNK) * 2);
    await expect(open(Buffer.from(truncated))).rejects.toThrow();
  });

  it("refuses a chunk moved from another document", async () => {
    // Both documents are ours and both chunks are validly sealed. The document
    // id in the AAD is the only thing that stops a CNIC from one application
    // being served as part of another.
    const a = await seal(randomBytes(CHUNK * 2));
    const b = await seal(randomBytes(CHUNK * 2), {
      documentId: "0f0f0f0f-0000-4000-8000-000000000000",
    });

    const sealedLength = sealedChunkBytes(CHUNK);
    b.stored.copy(a.stored, HEADER_BYTES, HEADER_BYTES, HEADER_BYTES + sealedLength);

    await expect(open(a.stored)).rejects.toThrow();
  });

  it("refuses a document opened under the wrong id", async () => {
    const { stored } = await seal(randomBytes(100));
    await expect(open(stored, "a-different-id")).rejects.toThrow();
  });

  it("refuses a document opened under the wrong key", async () => {
    const { stored } = await seal(randomBytes(100));
    await expect(open(stored, DOC, randomBytes(32))).rejects.toThrow();
  });

  it("refuses an edited header", async () => {
    const { stored } = await seal(randomBytes(CHUNK * 2));
    // Change the nonce prefix. Every chunk's AAD carries the header, so this
    // breaks authentication rather than silently changing the IVs.
    stored[18] ^= 0xff;
    await expect(open(stored)).rejects.toThrow();
  });
});

describe("header parsing", () => {
  it("rejects a file that is not one of ours", () => {
    expect(() => parseHeader(Buffer.alloc(HEADER_BYTES))).toThrow(/expected encrypted format/);
  });

  it("rejects a file shorter than a header", () => {
    expect(() => parseHeader(Buffer.alloc(8))).toThrow(/shorter than its header/);
  });

  it("rejects an unknown version", () => {
    const header = createHeader(CHUNK);
    header.bytes.writeUInt8(99, 8);
    expect(() => parseHeader(header.bytes)).toThrow(/Unsupported document cipher version/);
  });

  it("rejects an implausible chunk size", () => {
    // The declared size is used to allocate and to compute offsets, so a
    // header claiming a gigabyte chunk is an out-of-memory attempt wearing a
    // corrupt file's clothes.
    for (const size of [0, 100, 4097, 64 * 1024 * 1024]) {
      const header = createHeader(CHUNK);
      header.bytes.writeUInt32BE(size, 12);
      expect(() => parseHeader(header.bytes), String(size)).toThrow(/implausible chunk size/);
    }
  });

  it("accepts the production chunk size", () => {
    expect(parseHeader(createHeader().bytes).chunkSize).toBe(CHUNK_PLAINTEXT_BYTES);
  });
});

describe("length arithmetic", () => {
  it("accepts a full chunk followed by a partial one", () => {
    const stored = HEADER_BYTES + sealedChunkBytes(CHUNK) + (17 + TAG_BYTES);
    expect(plaintextLength(stored, CHUNK)).toBe(CHUNK + 17);
  });

  it("refuses a stored length no arrangement of chunks produces", () => {
    // A tail too short to carry a tag, and a tail one byte into a chunk that
    // the geometry says should be full. Both mean the file was cut, and the
    // length arithmetic must say so rather than return a plausible number that
    // later reads then run off the end of.
    for (const stored of [
      HEADER_BYTES + 5,
      HEADER_BYTES + sealedChunkBytes(CHUNK) + 1,
    ]) {
      expect(() => plaintextLength(stored, CHUNK), String(stored)).toThrow(
        /not consistent/,
      );
    }
  });

  it("reports no chunks for a header-only file", () => {
    expect(chunkCount(HEADER_BYTES, CHUNK)).toBe(0);
    expect(plaintextLength(HEADER_BYTES, CHUNK)).toBe(0);
  });
});

describe("single-chunk helpers", () => {
  it("round-trip a chunk directly", () => {
    const header = createHeader(CHUNK);
    const plain = randomBytes(1000);
    const sealedChunk = encryptChunk(KEY, header, DOC, 3, false, plain);
    expect(decryptChunk(KEY, header, DOC, 3, false, sealedChunk)).toEqual(plain);
  });

  it("refuses a chunk presented with the wrong final flag", () => {
    const header = createHeader(CHUNK);
    const sealedChunk = encryptChunk(KEY, header, DOC, 0, true, randomBytes(10));
    expect(() => decryptChunk(KEY, header, DOC, 0, false, sealedChunk)).toThrow();
  });

  it("refuses a chunk shorter than its tag", () => {
    const header = createHeader(CHUNK);
    expect(() => decryptChunk(KEY, header, DOC, 0, true, Buffer.alloc(4))).toThrow(
      /too short to carry a tag/,
    );
  });
});
