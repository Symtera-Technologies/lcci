import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName } from "pdf-lib";
import { inspectPdf } from "@/server/documents/pdf-guard";

/**
 * The structural PDF guard, against real PDFs.
 *
 * This module stands in for a virus scanner the host cannot run, so it is
 * tested against documents built by the same library that will parse them —
 * not against hand-written byte strings that only resemble PDFs.
 *
 * The premise being tested is narrow and worth restating: a scanned CNIC, a
 * partnership deed, a utility bill and a bank certificate have no legitimate
 * reason to carry JavaScript, an open action, an embedded file or a launch
 * instruction. So rather than detecting malice, this refuses the capabilities
 * malice needs, and the false-positive rate on the documents LCCI actually
 * receives should be nil. The last test in this file is what checks that
 * claim.
 */

const LIMIT = 8 * 1024 * 1024;

async function cleanPdf(pages = 1): Promise<Buffer> {
  const document = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) document.addPage([595, 842]);
  return Buffer.from(await document.save());
}

/** A clean PDF with one forbidden key set on its catalogue. */
async function withCatalogueKey(key: string): Promise<Buffer> {
  const document = await PDFDocument.create();
  document.addPage([595, 842]);
  document.catalog.set(PDFName.of(key), document.context.obj({}));
  return Buffer.from(await document.save());
}

describe("clean documents", () => {
  it("accepts an ordinary one-page PDF", async () => {
    const inspection = await inspectPdf(await cleanPdf(), LIMIT);
    expect(inspection.activeContent).toEqual([]);
    expect(inspection.pageCount).toBe(1);
    expect(inspection.encrypted).toBe(false);
  });

  it("counts pages, for the page-count limit", async () => {
    expect((await inspectPdf(await cleanPdf(12), LIMIT)).pageCount).toBe(12);
  });

  it("accepts a multi-page document the size of a real SECP filing", async () => {
    // Form 9, MoA and AoA together run to dozens of pages. If this were
    // refused, the single most important document set in a Company
    // application would be unuploadable.
    const inspection = await inspectPdf(await cleanPdf(40), LIMIT);
    expect(inspection.activeContent).toEqual([]);
    expect(inspection.pageCount).toBe(40);
  });
});

describe("active content", () => {
  it("refuses an /OpenAction on the catalogue", async () => {
    // The delivery mechanism for essentially every malicious PDF: run
    // something the moment the officer opens the file.
    const inspection = await inspectPdf(await withCatalogueKey("OpenAction"), LIMIT);
    expect(inspection.activeContent).toContain("OpenAction");
  });

  it("refuses additional actions", async () => {
    const inspection = await inspectPdf(await withCatalogueKey("AA"), LIMIT);
    expect(inspection.activeContent).toContain("AA");
  });

  it("refuses an embedded file, which is how a PDF smuggles past a format allowlist", async () => {
    const inspection = await inspectPdf(await withCatalogueKey("EmbeddedFiles"), LIMIT);
    expect(inspection.activeContent).toContain("EmbeddedFiles");
  });

  it("finds JavaScript declared as an action type, not just as a key", async () => {
    // `/S /JavaScript` is how an action says what it is, so the *values* have
    // to be checked as well as the keys.
    const document = await PDFDocument.create();
    document.addPage([595, 842]);
    const action = document.context.obj({
      S: PDFName.of("JavaScript"),
      JS: document.context.obj("app.alert(1)"),
    });
    document.context.register(action);
    const bytes = Buffer.from(await document.save());

    const inspection = await inspectPdf(bytes, LIMIT);
    expect(inspection.activeContent).toContain("JavaScript");
  });

  it("finds an action nested inside an annotation rather than on the catalogue", async () => {
    // Walking the object store rather than the page tree is what makes this
    // work: an action can hang off a form field, an annotation, a name tree or
    // the catalogue, and chasing each individually is a list that will be
    // incomplete.
    const document = await PDFDocument.create();
    const page = document.addPage([595, 842]);
    const annotation = document.context.obj({
      Type: PDFName.of("Annot"),
      Subtype: PDFName.of("Link"),
      A: document.context.obj({
        S: PDFName.of("Launch"),
        F: document.context.obj("calc.exe"),
      }),
    });
    page.node.set(PDFName.of("Annots"), document.context.obj([annotation]));
    const bytes = Buffer.from(await document.save());

    const inspection = await inspectPdf(bytes, LIMIT);
    expect(inspection.activeContent).toContain("Launch");
  });

  it("reports every feature it found, sorted", async () => {
    const document = await PDFDocument.create();
    document.addPage([595, 842]);
    document.catalog.set(PDFName.of("OpenAction"), document.context.obj({}));
    document.catalog.set(PDFName.of("AA"), document.context.obj({}));
    const bytes = Buffer.from(await document.save());

    const inspection = await inspectPdf(bytes, LIMIT);
    expect(inspection.activeContent).toEqual(["AA", "OpenAction"]);
  });
});

describe("refusals", () => {
  it("refuses something that is not a PDF at all", async () => {
    await expect(inspectPdf(Buffer.from("not a pdf"), LIMIT)).rejects.toThrow(
      /could not be parsed/,
    );
  });

  it("refuses a truncated PDF", async () => {
    const bytes = await cleanPdf();
    await expect(inspectPdf(bytes.subarray(0, 200), LIMIT)).rejects.toThrow();
  });

  it("refuses a file past the inspection limit before parsing it", async () => {
    // pdf-lib parses a whole document into memory, so this check has to come
    // first rather than be discovered by the allocator.
    await expect(inspectPdf(Buffer.alloc(100), 50)).rejects.toThrow(
      /larger than the inspection limit/,
    );
  });
});
