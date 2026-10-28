import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalDiskStore, keyFor } from "@/server/documents/store";
import {
  HEADER_BYTES,
  createEncryptor,
  createHeader,
  decryptRange,
  parseHeader,
  plaintextLength,
} from "@/server/documents/cipher";

/**
 * The store and the cipher together, against a real filesystem.
 *
 * The cipher tests cover the container in isolation; these cover the part that
 * only breaks when bytes actually travel through a stream to a file and back
 * out through positional reads — which is where an off-by-one in the chunk
 * geometry would show up, and nowhere else.
 */

const KEY = randomBytes(32);

let root: string;
let store: LocalDiskStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lcci-store-test-"));
  store = new LocalDiskStore(root);
});

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(root, { recursive: true, force: true });
});

async function storeEncrypted(
  documentId: string,
  plaintext: Buffer,
): Promise<{ key: string; bytes: number; header: ReturnType<typeof createHeader> }> {
  const key = keyFor(documentId, "pdf");
  const header = createHeader();
  const sink = new PassThrough();
  const written = store.write(key, sink);

  await pipeline(
    Readable.from([plaintext]),
    createEncryptor(KEY, documentId, header),
    sink,
  );

  const result = await written;
  return { key, bytes: result.bytes, header };
}

describe("LocalDiskStore", () => {
  it("round-trips an encrypted document of several chunks", async () => {
    const documentId = randomUUID();
    // 200 KB spans four 64 KB chunks and a partial fifth, which exercises
    // every branch of the geometry at the real chunk size.
    const plaintext = randomBytes(200 * 1024);

    const { key, bytes, header } = await storeEncrypted(documentId, plaintext);

    expect(plaintextLength(bytes, header.chunkSize)).toBe(plaintext.length);

    const recovered = await decryptRange(
      KEY,
      header,
      documentId,
      bytes,
      0,
      plaintext.length - 1,
      (offset, length) => store.readAt(key, offset, length),
    );

    expect(recovered).toEqual(plaintext);
  });

  it("serves a range from the middle without reading the rest", async () => {
    const documentId = randomUUID();
    const plaintext = randomBytes(300 * 1024);
    const { key, bytes, header } = await storeEncrypted(documentId, plaintext);

    const offsets: number[] = [];
    const slice = await decryptRange(
      KEY,
      header,
      documentId,
      bytes,
      150_000,
      150_511,
      async (offset, length) => {
        offsets.push(offset);
        return store.readAt(key, offset, length);
      },
    );

    expect(slice).toEqual(plaintext.subarray(150_000, 150_512));
    // 150,000 falls in chunk 2 and 150,511 in the same chunk, so exactly one
    // read. If this becomes more than one, serving page 1 of a long filing has
    // started reading the whole file.
    expect(offsets.length).toBe(1);
  });

  it("writes the file mode 0600 inside a sharded directory", async () => {
    const documentId = randomUUID();
    const { key } = await storeEncrypted(documentId, randomBytes(100));

    const full = path.join(root, key);
    const info = await stat(full);
    expect(info.isFile()).toBe(true);

    // Mode bits are not meaningful on Windows, where the test suite also runs,
    // so this is asserted only where it means something.
    if (process.platform !== "win32") {
      expect(info.mode & 0o777).toBe(0o600);
    }

    expect(path.basename(path.dirname(full))).toBe(documentId.slice(0, 2));
  });

  it("stores ciphertext, so the plaintext is not on disk", async () => {
    const documentId = randomUUID();
    const marker = Buffer.from("4220112345678 ATTESTED COPY OF CNIC", "utf8");
    const { key } = await storeEncrypted(documentId, marker);

    const raw = await readFile(path.join(root, key));
    expect(raw.includes(marker)).toBe(false);
    // The header is plaintext by design — it carries the chunk size and the
    // nonce prefix, neither of which is secret.
    expect(() => parseHeader(raw)).not.toThrow();
    expect(raw.length).toBeGreaterThan(HEADER_BYTES);
  });

  it("leaves no .part file behind on success", async () => {
    const documentId = randomUUID();
    const { key } = await storeEncrypted(documentId, randomBytes(1000));
    const entries = await readdir(path.join(root, path.dirname(key)));
    expect(entries.filter((name) => name.endsWith(".part"))).toEqual([]);
  });

  it("leaves no file at all when the source stream fails", async () => {
    // The atomic rename is what makes this true. Without it a worker killed
    // mid-upload would leave a truncated file that the database row calls
    // complete, and the truncation would surface weeks later, during
    // verification, in front of an officer.
    const documentId = randomUUID();
    const key = keyFor(documentId, "pdf");

    const failing = new Readable({
      read() {
        this.destroy(new Error("connection reset"));
      },
    });

    await expect(store.write(key, failing)).rejects.toThrow();
    expect(await store.stat(key)).toBeNull();

    const shard = path.join(root, path.dirname(key));
    const entries = await readdir(shard).catch(() => []);
    expect(entries).toEqual([]);
  });

  it("reports a missing document as null rather than throwing", async () => {
    expect(await store.stat(keyFor(randomUUID(), "pdf"))).toBeNull();
  });

  it("refuses a key that could escape the document root", async () => {
    for (const key of [
      "../outside.pdf",
      "7f/../../outside.pdf",
      "/etc/passwd",
      "7f/7f1c9a48-0b2e-4d61-9a3f-55c1ee0a9b10.php",
      "zz/7f1c9a48-0b2e-4d61-9a3f-55c1ee0a9b10.pdf",
    ]) {
      await expect(store.stat(key), key).resolves.toBeNull();
      await expect(store.readAt(key, 0, 10), key).rejects.toThrow();
    }
  });

  it("caps how much one read may allocate", async () => {
    // A caller asking for more than one chunk plus its tag is a bug or an
    // attempt to make this allocate; the cap makes neither a memory problem.
    const key = keyFor(randomUUID(), "pdf");
    await expect(store.readAt(key, 0, 64 * 1024 * 1024)).rejects.toThrow(/too large/);
  });

  it("refuses a negative range", async () => {
    const key = keyFor(randomUUID(), "pdf");
    await expect(store.readAt(key, -1, 10)).rejects.toThrow(/Negative read range/);
  });

  it("returns a short buffer rather than padding past the end of the file", async () => {
    const documentId = randomUUID();
    const { key, bytes } = await storeEncrypted(documentId, randomBytes(100));
    const read = await store.readAt(key, bytes - 10, 500);
    expect(read.length).toBe(10);
  });

  it("deletes bytes when asked", async () => {
    const documentId = randomUUID();
    const { key } = await storeEncrypted(documentId, randomBytes(100));
    expect(await store.stat(key)).not.toBeNull();
    await store.delete(key);
    expect(await store.stat(key)).toBeNull();
  });

  it("does not throw when deleting something already gone", async () => {
    // Retention and draft expiry delete in batches; one unlinkable file must
    // not stop everything behind it.
    await expect(store.delete(keyFor(randomUUID(), "pdf"))).resolves.toBeUndefined();
  });
});
