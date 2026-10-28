import "server-only";

import { createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { env } from "@/server/env";
import { logError } from "@/server/log";
import { EXTENSION_BY_FORMAT } from "@/server/documents/sniff";

/**
 * Where document bytes live, behind an adapter.
 *
 * The adapter exists from day one rather than being extracted later, and the
 * reason is in the host-limits table: **this plan cannot hold the documents.**
 * Twenty thousand members at roughly six documents each projects to about
 * 480 GB against a quota of 10 to 50 GB. Object storage is the highest-value
 * change available — it fixes capacity, brings real server-side encryption and
 * gives lifecycle rules that enforce retention better than a cron job anyone
 * has to trust — and it costs single-digit dollars a month with no VPS.
 *
 * So the day that move happens, it must be one new implementation of this
 * interface and nothing else. Which is why the interface is deliberately
 * narrow and deliberately range-shaped: `readAt(key, offset, length)` is a
 * ranged GET on S3, R2 or B2 exactly as it is a positional read on a local
 * file, and it is the only read primitive the serve route is given. A
 * `readFile(key): Buffer` convenience method would be used, would work, and
 * would quietly make every document fetch load the whole file into a
 * Passenger worker — and it would be the thing that does not port.
 *
 * Mirrors the seam convention `src/content/repository.ts` already sets.
 */

export interface StoredObject {
  key: string;
  /** Stored size, which for an encrypted document is larger than the original. */
  bytes: number;
}

export interface DocumentStore {
  readonly name: string;
  /** Stream bytes in. Must be atomic: a partial write must not become a file. */
  write(key: string, source: Readable): Promise<StoredObject>;
  /** The only read primitive. Ranged, because the serve route is ranged. */
  readAt(key: string, offset: number, length: number): Promise<Buffer>;
  stat(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
}

/**
 * The storage key for a document.
 *
 * `{first two hex characters}/{uuid}.{extension}`. Sharded because ext4 and
 * most shared-host filesystems degrade with tens of thousands of entries in
 * one directory, and `ls` on the documents directory is something a human will
 * eventually do over a slow SSH connection.
 *
 * The extension comes from the magic-byte sniff, never from the upload, and
 * the name is a UUID, never the applicant's filename — so path traversal,
 * Windows device names, overlong names and homoglyph tricks are not mitigated
 * here, they are structurally absent.
 */
/**
 * The extensions a stored key may carry.
 *
 * The four sniffed formats, plus `tmp` for the quarantine key an upload is
 * written to before it has been inspected.
 */
const ALLOWED_EXTENSIONS = new Set<string>([
  ...Object.values(EXTENSION_BY_FORMAT),
  "tmp",
]);

export function keyFor(documentId: string, extension: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(documentId)) {
    throw new Error("Document id is not a UUID");
  }
  // An allowlist, not a shape check. The extension is supposed to come from
  // the magic-byte sniff, and "any five lowercase characters" would let a
  // future caller pass `php` — harmless on this host, where documents live
  // outside every served path, and not worth leaving to that one fact.
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error("Document extension did not come from the sniff");
  }
  return `${documentId.slice(0, 2)}/${documentId}.${extension}`;
}

/**
 * Validate a key before it reaches the filesystem.
 *
 * Belt and braces over `keyFor`: this is the function that stands between a
 * key read back from a database row and a path, and a row is not a trusted
 * input — it is only as trustworthy as everything that has ever written to it.
 */
function assertKey(key: string): void {
  if (!/^[0-9a-f]{2}\/[0-9a-f-]{36}\.[a-z0-9]{1,5}$/.test(key)) {
    throw new Error("Document key has an unexpected shape");
  }
}

/* -------------------------------------------------------------------------- */
/* Local disk                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Documents on the local filesystem, under `PRIVATE_UPLOAD_ROOT`.
 *
 * `src/server/env.ts` has already refused to start if that path is unset,
 * resolves inside the application root, does not exist, or is not writable —
 * turning a configuration mistake into a 503 rather than a process that
 * silently writes CNICs into a directory Apache serves.
 */
export class LocalDiskStore implements DocumentStore {
  readonly name = "local-disk";

  constructor(private readonly root: string = env.uploadRoot) {}

  private pathFor(key: string): string {
    assertKey(key);
    const resolved = path.resolve(this.root, key);

    // After resolution, not before. A key that passed the shape check but
    // somehow resolved outside the root would be a bug in the check rather
    // than an attack, and this is the assertion that catches the bug instead
    // of writing the file.
    const rootWithSep = path.resolve(this.root) + path.sep;
    if (!resolved.startsWith(rootWithSep)) {
      throw new Error("Resolved document path escaped the document root");
    }

    return resolved;
  }

  /**
   * Stream in, via a temporary file and a rename.
   *
   * The rename is the point. `rename` within a filesystem is atomic, so a
   * worker killed mid-upload — which the shared plan's CPU limiter will do —
   * leaves a `.part` file rather than a truncated document that the database
   * row says is complete. A truncated document would fail its GCM tag on
   * read, which is at least loud, but it would fail it during verification,
   * weeks later, in front of an officer.
   */
  async write(key: string, source: Readable): Promise<StoredObject> {
    const target = this.pathFor(key);
    const temporary = `${target}.${process.pid}.part`;

    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });

    try {
      await pipeline(
        source,
        createWriteStream(temporary, { mode: 0o600, flags: "wx" }),
      );
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }

    const info = await stat(target);
    return { key, bytes: info.size };
  }

  async readAt(key: string, offset: number, length: number): Promise<Buffer> {
    if (offset < 0 || length < 0) throw new Error("Negative read range");
    // One chunk plus its tag is the largest legitimate read. A caller asking
    // for more is either a bug or an attempt to make this allocate, and the
    // cap means neither becomes a memory problem.
    if (length > 2 * 1024 * 1024) throw new Error("Read length is too large");

    const handle = await open(this.pathFor(key), "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async stat(key: string): Promise<StoredObject | null> {
    try {
      const info = await stat(this.pathFor(key));
      return info.isFile() ? { key, bytes: info.size } : null;
    } catch {
      return null;
    }
  }

  /**
   * Remove the bytes.
   *
   * Used by draft expiry and the retention sweep, which are the jobs that make
   * the 24-month retention proposal real rather than aspirational. Failure is
   * logged and swallowed: the caller is deleting a row and a missing file must
   * not block that, or a single unlinkable file would stop retention for
   * everything behind it in the batch.
   */
  async delete(key: string): Promise<void> {
    try {
      await rm(this.pathFor(key), { force: true });
    } catch (error) {
      logError("could not delete document bytes", error);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                  */
/* -------------------------------------------------------------------------- */

let configured: DocumentStore | null = null;

export function getDocumentStore(): DocumentStore {
  configured ??= new LocalDiskStore();
  return configured;
}

/** For tests, and for the object-store implementation when it lands. */
export function setDocumentStore(store: DocumentStore | null): void {
  configured = store;
}
