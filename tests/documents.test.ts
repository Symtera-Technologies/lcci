import { describe, expect, it } from "vitest";
import {
  ACCEPTED_DECLARED_TYPES,
  MIME_BY_FORMAT,
  declaredTypeAgrees,
  sniff,
} from "@/server/documents/sniff";
import {
  cleanUploadedName,
  contentDisposition,
  downloadName,
} from "@/server/documents/filename";
import { keyFor } from "@/server/documents/store";
import { parseRange } from "@/server/documents/serve";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "latin1");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

/** A JPEG with an APP0 segment before the frame header, as a real one has. */
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.alloc(18);
  app0.writeUInt16BE(0xffe0, 0);
  app0.writeUInt16BE(16, 2);
  app0.write("JFIF\0", 4, "latin1");

  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(8, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);

  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

function webp(variant: "VP8 " | "VP8L" | "VP8X", width: number, height: number): Buffer {
  const buffer = Buffer.alloc(40);
  buffer.write("RIFF", 0, "latin1");
  buffer.writeUInt32LE(32, 4);
  buffer.write("WEBP", 8, "latin1");
  buffer.write(variant, 12, "latin1");
  buffer.writeUInt32LE(20, 16);

  if (variant === "VP8 ") {
    Buffer.from([0x9d, 0x01, 0x2a]).copy(buffer, 23);
    buffer.writeUInt16LE(width, 26);
    buffer.writeUInt16LE(height, 28);
  } else if (variant === "VP8L") {
    buffer.writeUInt8(0x2f, 20);
    buffer.writeUInt32LE(((height - 1) << 14) | (width - 1), 21);
  } else {
    buffer.writeUIntLE(width - 1, 24, 3);
    buffer.writeUIntLE(height - 1, 27, 3);
  }

  return buffer;
}

const PDF = Buffer.concat([
  Buffer.from("%PDF-1.7\n", "latin1"),
  Buffer.alloc(100),
]);

/* -------------------------------------------------------------------------- */
/* Sniffing                                                                   */
/* -------------------------------------------------------------------------- */

describe("magic-byte sniffing", () => {
  it("identifies the four accepted formats", () => {
    expect(sniff(PDF)?.format).toBe("pdf");
    expect(sniff(png(600, 800))?.format).toBe("png");
    expect(sniff(jpeg(600, 800))?.format).toBe("jpeg");
    expect(sniff(webp("VP8L", 600, 800))?.format).toBe("webp");
  });

  it("returns the media type from the sniff, never from the caller", () => {
    for (const [format, mimeType] of Object.entries(MIME_BY_FORMAT)) {
      const fixture =
        format === "pdf"
          ? PDF
          : format === "png"
            ? png(600, 800)
            : format === "jpeg"
              ? jpeg(600, 800)
              : webp("VP8L", 600, 800);
      expect(sniff(fixture)?.mimeType, format).toBe(mimeType);
    }
  });

  it("refuses an SVG, whatever it is called", () => {
    // An XML document that executes script. No Content-Disposition makes
    // accepting one into a document store acceptable.
    const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg">');
    expect(sniff(svg)).toBeNull();
  });

  it("refuses HTML renamed as an image", () => {
    expect(sniff(Buffer.from("<!DOCTYPE html><script>alert(1)</script>"))).toBeNull();
  });

  it("refuses a PDF with leading junk", () => {
    // The specification tolerates it and so do most readers, which is exactly
    // why we do not: a file that is a PDF only after 300 bytes of something
    // else is a polyglot, and a polyglot exists to be read as one thing by the
    // validator and another by the viewer.
    const polyglot = Buffer.concat([Buffer.alloc(300, 0x20), PDF]);
    expect(sniff(polyglot)).toBeNull();
  });

  it("refuses an empty or truncated file rather than guessing", () => {
    for (const head of [
      Buffer.alloc(0),
      Buffer.from([0x89, 0x50]),
      Buffer.from("%PD", "latin1"),
      Buffer.from("RIFF", "latin1"),
    ]) {
      expect(sniff(head)).toBeNull();
    }
  });

  it("refuses a RIFF container that is not WebP", () => {
    const wav = Buffer.alloc(16);
    wav.write("RIFF", 0, "latin1");
    wav.write("WAVE", 8, "latin1");
    expect(sniff(wav)).toBeNull();
  });
});

describe("header dimensions", () => {
  it("reads PNG from IHDR", () => {
    expect(sniff(png(413, 531))).toMatchObject({ width: 413, height: 531 });
  });

  it("walks JPEG segments to the frame header", () => {
    // A real JPEG puts APP0, and often a multi-kilobyte EXIF block, before
    // SOF0. Reading a fixed offset would give the wrong answer, or garbage.
    expect(sniff(jpeg(1240, 1754))).toMatchObject({ width: 1240, height: 1754 });
  });

  it("reads all three WebP variants", () => {
    expect(sniff(webp("VP8 ", 640, 480))).toMatchObject({ width: 640, height: 480 });
    expect(sniff(webp("VP8L", 640, 480))).toMatchObject({ width: 640, height: 480 });
    expect(sniff(webp("VP8X", 640, 480))).toMatchObject({ width: 640, height: 480 });
  });

  it("reports no dimensions for a PDF", () => {
    expect(sniff(PDF)).toMatchObject({ width: null, height: null });
  });

  it("returns null dimensions rather than looping on a malformed JPEG", () => {
    // A zero segment length would not advance the cursor. An unbounded walk
    // over attacker-controlled lengths is a hang, and a hang in a Passenger
    // worker is one fewer worker for everyone else.
    const malformed = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]),
      Buffer.alloc(100),
    ]);
    expect(sniff(malformed)).toMatchObject({ width: null, height: null });
  });

  it("gives up on a JPEG whose scan starts before any frame header", () => {
    const truncated = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0, 0, 0, 0]);
    expect(sniff(truncated)).toMatchObject({ width: null, height: null });
  });
});

describe("declared type agreement", () => {
  it("accepts every type a client may legitimately claim", () => {
    for (const [declared, format] of Object.entries(ACCEPTED_DECLARED_TYPES)) {
      expect(declaredTypeAgrees(declared, format), declared).toBe(true);
    }
  });

  it("ignores parameters and case", () => {
    expect(declaredTypeAgrees("IMAGE/JPEG; charset=binary", "jpeg")).toBe(true);
  });

  it("rejects a mismatch, which is the audit-worthy case", () => {
    expect(declaredTypeAgrees("image/png", "jpeg")).toBe(false);
    expect(declaredTypeAgrees("image/svg+xml", "png")).toBe(false);
    expect(declaredTypeAgrees(null, "pdf")).toBe(false);
    expect(declaredTypeAgrees("", "pdf")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Filenames                                                                  */
/* -------------------------------------------------------------------------- */

describe("cleanUploadedName", () => {
  it("keeps an ordinary name", () => {
    expect(cleanUploadedName("Partnership Deed.pdf")).toBe("Partnership Deed.pdf");
  });

  it("drops any directory component the client sent", () => {
    expect(cleanUploadedName("C:\\Users\\Ali\\cnic.jpg")).toBe("cnic.jpg");
    expect(cleanUploadedName("../../etc/passwd")).toBe("passwd");
    expect(cleanUploadedName("/var/www/html/shell.php")).toBe("shell.php");
  });

  it("strips CRLF, which is the whole header-injection vector", () => {
    const injected = cleanUploadedName("cnic.jpg\r\nSet-Cookie: session=stolen");
    expect(injected).not.toMatch(/[\r\n]/);
    expect(injected).toContain("cnic.jpg");
  });

  it("strips bidirectional overrides", () => {
    // `cnic\u202Egpj.exe` renders as `cnic.exe.jpg` in the officer's browser.
    const name = cleanUploadedName("cnic\u202egpj.exe");
    expect(name).not.toMatch(/[\u202a-\u202e]/);
  });

  it("returns null when nothing usable survives", () => {
    for (const raw of ["", "   ", ".", "..", "\r\n", null, undefined]) {
      expect(cleanUploadedName(raw)).toBeNull();
    }
  });

  it("truncates to fit the column", () => {
    expect((cleanUploadedName("x".repeat(500)) ?? "").length).toBeLessThanOrEqual(200);
  });
});

describe("downloadName", () => {
  it("never echoes the uploaded filename", () => {
    // `42201-1234567-8.jpg` *is* a CNIC. Echoing it would put one in a
    // response header, in every proxy log on the way, and in the officer's
    // Downloads folder listing.
    const name = downloadName("cnic_proprietor", "7f1c9a48", "jpg");
    expect(name).toBe("cnic-proprietor-7f1c9a48.jpg");
    expect(name).not.toContain("42201");
  });

  it("produces something safe from unsafe input", () => {
    const name = downloadName('../../"evil', "a b/c", "jpg");
    expect(name).toMatch(/^[a-z0-9.-]+$/);
  });

  it("falls back rather than producing a bare extension", () => {
    expect(downloadName("", "", "pdf")).toBe("document.pdf");
    expect(downloadName("", "", "")).toBe("document.bin");
  });
});

describe("contentDisposition", () => {
  it("defaults to attachment, which is what neutralises a bad file", () => {
    expect(contentDisposition("a.pdf")).toMatch(/^attachment;/);
  });

  it("emits both the plain and the RFC 5987 parameter", () => {
    const header = contentDisposition("deed.pdf");
    expect(header).toContain('filename="deed.pdf"');
    expect(header).toContain("filename*=UTF-8''deed.pdf");
  });

  it("never emits a newline or a bare quote, whatever it is given", () => {
    const header = contentDisposition('ev"il\r\nX-Injected: 1.pdf');
    expect(header).not.toMatch(/[\r\n]/);
    // One pair of quotes, around the ASCII parameter, and no others.
    expect(header.match(/"/g)?.length).toBe(2);
  });

  it("percent-encodes the characters RFC 5987 excludes", () => {
    // encodeURIComponent leaves !'()* alone and attr-char does not permit
    // them, so an unencoded apostrophe would make the parameter unparseable.
    const header = contentDisposition("it's (final)!.pdf");
    expect(header).toContain("%27");
    expect(header).toContain("%28");
    expect(header).toContain("%21");
  });

  it("transliterates non-ASCII in the plain parameter and keeps it in the extended one", () => {
    const header = contentDisposition("درخواست.pdf");
    const plain = /filename="([^"]*)"/.exec(header)?.[1] ?? "";
    expect(plain).toMatch(/^[\x20-\x7e]*$/);
    expect(header).toContain("filename*=UTF-8''%D8%AF");
  });
});

/* -------------------------------------------------------------------------- */
/* Storage keys                                                               */
/* -------------------------------------------------------------------------- */

describe("keyFor", () => {
  it("shards by the first two characters", () => {
    expect(keyFor("7f1c9a48-0b2e-4d61-9a3f-55c1ee0a9b10", "pdf")).toBe(
      "7f/7f1c9a48-0b2e-4d61-9a3f-55c1ee0a9b10.pdf",
    );
  });

  it("refuses anything that is not a UUID", () => {
    for (const id of ["", "../../etc/passwd", "7f1c9a48", "7F1C9A48-0B2E-4D61-9A3F-55C1EE0A9B10"]) {
      expect(() => keyFor(id, "pdf"), id).toThrow(/not a UUID/);
    }
  });

  it("refuses an extension that did not come from the sniff", () => {
    for (const extension of ["", "php", "../x", "pdf.php", "PDF"]) {
      expect(() => keyFor("7f1c9a48-0b2e-4d61-9a3f-55c1ee0a9b10", extension), extension).toThrow();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Ranges                                                                     */
/* -------------------------------------------------------------------------- */

describe("parseRange", () => {
  const total = 10_000;

  it("serves the whole document with no Range header", () => {
    expect(parseRange(null, total)).toEqual({ kind: "full", start: 0, end: 9999 });
  });

  it("handles a closed range", () => {
    expect(parseRange("bytes=0-1023", total)).toEqual({ kind: "partial", start: 0, end: 1023 });
  });

  it("handles an open-ended range", () => {
    expect(parseRange("bytes=5000-", total)).toEqual({ kind: "partial", start: 5000, end: 9999 });
  });

  it("handles a suffix range, which is how a PDF viewer finds the xref table", () => {
    // `bytes=-500` is the first request every PDF viewer makes: the
    // cross-reference table lives at the end of the file.
    expect(parseRange("bytes=-500", total)).toEqual({ kind: "partial", start: 9500, end: 9999 });
  });

  it("clamps an end past the last byte", () => {
    expect(parseRange("bytes=9000-99999", total)).toEqual({
      kind: "partial",
      start: 9000,
      end: 9999,
    });
  });

  it("reports a start past the end as unsatisfiable", () => {
    expect(parseRange("bytes=99999-", total)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange(`bytes=${total}-`, total)).toEqual({ kind: "unsatisfiable" });
  });

  it("reports a reversed range as unsatisfiable", () => {
    expect(parseRange("bytes=500-100", total)).toEqual({ kind: "unsatisfiable" });
  });

  it("falls back to the whole document on a form it does not implement", () => {
    // Multipart ranges are legal and nothing that matters sends them. Serving
    // everything is handled by every client; an error is not.
    for (const header of ["bytes=0-99,200-299", "items=0-10", "bytes=abc-def", "bytes=-"]) {
      expect(parseRange(header, total).kind, header).toBe("ignored");
    }
  });

  it("ignores a range on an empty document", () => {
    expect(parseRange("bytes=0-10", 0)).toEqual({ kind: "full", start: 0, end: 0 });
  });
});
