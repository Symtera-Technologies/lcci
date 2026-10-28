import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fieldErrorsFrom, formDataToObject } from "@/server/action";

/**
 * The two pure helpers in the action wrapper.
 *
 * The wrapper itself needs a request context and a database, so it is
 * exercised end to end in the browser rather than here. These two are where
 * the quiet bugs live: a form that silently loses a repeated field, or an
 * error map whose keys do not match the input names and so renders every
 * message in the wrong place — or nowhere.
 */

describe("formDataToObject", () => {
  it("reads a single value", () => {
    const form = new FormData();
    form.set("firmName", "Shalimar Textiles");
    expect(formDataToObject(form)).toEqual({ firmName: "Shalimar Textiles" });
  });

  it("collects a repeated key into an array", () => {
    // The business-type multi-select and the repeatable directors list both
    // submit repeated keys. Taking only the last would silently discard every
    // choice but one.
    const form = new FormData();
    form.append("businessType", "exporter");
    form.append("businessType", "manufacturer");
    form.append("businessType", "trading");
    expect(formDataToObject(form)).toEqual({
      businessType: ["exporter", "manufacturer", "trading"],
    });
  });

  it("keeps a single repeated value as a scalar", () => {
    // A multi-select with one option chosen submits one key, so a schema that
    // expects an array has to coerce. Asserted so the asymmetry is visible
    // rather than discovered when one director is entered instead of two.
    const form = new FormData();
    form.append("businessType", "services");
    expect(formDataToObject(form)).toEqual({ businessType: "services" });
  });

  it("marks a File rather than passing it through", () => {
    // Files never travel through a server action here — they stream to the
    // upload route and the action carries document ids. A File arriving is a
    // mistake, and the marker makes the schema reject it loudly instead of
    // coercing a File to "[object File]".
    const form = new FormData();
    form.set("scan", new File(["x"], "cnic.jpg", { type: "image/jpeg" }));
    expect(formDataToObject(form)).toEqual({ scan: "__file__" });
  });

  it("preserves an empty string rather than dropping the key", () => {
    // An untouched optional field and an absent field are different things to
    // a wizard that autosaves: the first means "the user cleared it".
    const form = new FormData();
    form.set("strn", "");
    expect(formDataToObject(form)).toEqual({ strn: "" });
  });
});

describe("fieldErrorsFrom", () => {
  const schema = z.object({
    firmName: z.string().min(1, "Enter the firm or company name."),
    email: z.string().email("Enter a valid email address."),
    turnover: z.coerce.number().positive("Enter the annual turnover in rupees."),
  });

  it("keys each message by its field name", () => {
    const result = schema.safeParse({ firmName: "", email: "nope", turnover: "-1" });
    expect(result.success).toBe(false);
    if (result.success) return;

    const errors = fieldErrorsFrom(result.error);
    expect(errors).toEqual({
      firmName: "Enter the firm or company name.",
      email: "Enter a valid email address.",
      turnover: "Enter the annual turnover in rupees.",
    });
  });

  it("keeps only the first message per field", () => {
    // A field with three simultaneous complaints is how a form becomes
    // unreadable, and the user can only fix one at a time anyway.
    const strict = z.object({
      cnic: z
        .string()
        .length(13, "A CNIC is 13 digits.")
        .regex(/^\d+$/, "Digits only, with no dashes."),
    });
    const result = strict.safeParse({ cnic: "42201-123" });
    if (result.success) throw new Error("expected a failure");

    expect(Object.keys(fieldErrorsFrom(result.error))).toEqual(["cnic"]);
  });

  it("keeps the index in a nested path so a repeated row gets its own error", () => {
    // `directors.1.cnic` must not collapse to `cnic`, or the second
    // director's error appears on the first director's input.
    const nested = z.object({
      directors: z.array(z.object({ cnic: z.string().length(13, "A CNIC is 13 digits.") })),
    });
    const result = nested.safeParse({
      directors: [{ cnic: "4220112345678" }, { cnic: "short" }],
    });
    if (result.success) throw new Error("expected a failure");

    expect(fieldErrorsFrom(result.error)).toEqual({
      "directors.1.cnic": "A CNIC is 13 digits.",
    });
  });

  it("files a form-level issue under _form", () => {
    // A cross-field rule — "a Corporate application needs a sales-tax
    // registration number" — belongs to no single input and must still be
    // shown somewhere rather than swallowed.
    const crossField = z
      .object({ memberClass: z.string(), strn: z.string().optional() })
      .refine((v) => v.memberClass !== "corporate" || !!v.strn, {
        message: "A Corporate application needs a sales-tax registration number.",
      });

    const result = crossField.safeParse({ memberClass: "corporate" });
    if (result.success) throw new Error("expected a failure");

    expect(fieldErrorsFrom(result.error)).toEqual({
      _form: "A Corporate application needs a sales-tax registration number.",
    });
  });
});
