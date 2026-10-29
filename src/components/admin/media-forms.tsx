"use client";

import { useActionState } from "react";
import { IDLE, type ActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";

type Action = (prev: ActionState, formData: FormData) => Promise<ActionState>;

const CONTROL =
  "mt-1.5 h-10 w-full rounded-lg border bg-white px-3 text-[0.9375rem] text-ink-900 placeholder:text-stone-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-1";

function border(error?: string): string {
  return error ? "border-urgent-600" : "border-stone-300 focus:border-brand-500";
}

/**
 * The description fields, shared by registering and re-describing.
 *
 * Alt text is first and alone at the top, with the longest hint on the page
 * under it. It is the field this whole library exists for: the sanitiser has
 * no `<img>`, so the only route a photograph takes to a public page is through
 * one of these rows, and a row cannot be saved without a description. Putting
 * it below the dimensions would turn the one thing that matters into the one
 * thing people tab past.
 */
function DescriptionFields({
  errors,
  values,
  departments,
}: {
  errors: Record<string, string>;
  values?: {
    altEn?: string;
    altUr?: string | null;
    caption?: string | null;
    width?: number;
    height?: number;
    departmentCode?: string | null;
  };
  departments: readonly { code: string; nameEn: string }[];
}) {
  return (
    <>
      <Field
        name="alt_en"
        label="What is in the picture"
        required
        error={errors.alt_en}
        hint="One sentence, as it would be read aloud. Name what is happening, not who is in it — the chamber's photography does not identify individuals. Do not begin with “image of”: a screen reader has already said that."
      >
        {(id, invalid) => (
          <textarea
            id={id}
            name="alt_en"
            rows={2}
            required
            maxLength={500}
            defaultValue={values?.altEn ?? ""}
            aria-invalid={invalid}
            className={cn(
              "mt-1.5 w-full rounded-lg border bg-white px-3 py-2 text-[0.9375rem] leading-relaxed text-ink-900",
              border(errors.alt_en),
            )}
          />
        )}
      </Field>

      <Field
        name="alt_ur"
        label="What is in the picture (Urdu)"
        error={errors.alt_ur}
        hint="Optional. Stored now so the Urdu site is a translation task rather than a rebuild."
      >
        {(id) => (
          <textarea
            id={id}
            name="alt_ur"
            rows={2}
            maxLength={700}
            defaultValue={values?.altUr ?? ""}
            className={cn(
              "mt-1.5 w-full rounded-lg border bg-white px-3 py-2 text-[0.9375rem] leading-relaxed text-ink-900",
              border(errors.alt_ur),
            )}
          />
        )}
      </Field>

      <Field
        name="caption"
        label="Caption"
        error={errors.caption}
        hint="Optional, and different from the description: a caption is printed beside the photograph for everyone, the description is read instead of it."
      >
        {(id) => (
          <input
            id={id}
            type="text"
            name="caption"
            maxLength={400}
            defaultValue={values?.caption ?? ""}
            className={cn(CONTROL, border(errors.caption))}
          />
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          name="width"
          label="Width in pixels"
          required
          error={errors.width}
          hint="From the file's own properties."
        >
          {(id, invalid) => (
            <input
              id={id}
              type="number"
              name="width"
              required
              min={1}
              max={65535}
              defaultValue={values?.width ?? ""}
              aria-invalid={invalid}
              className={cn(CONTROL, border(errors.width))}
            />
          )}
        </Field>

        <Field name="height" label="Height in pixels" required error={errors.height}>
          {(id, invalid) => (
            <input
              id={id}
              type="number"
              name="height"
              required
              min={1}
              max={65535}
              defaultValue={values?.height ?? ""}
              aria-invalid={invalid}
              className={cn(CONTROL, border(errors.height))}
            />
          )}
        </Field>
      </div>

      <Field
        name="department_code"
        label="Contributed by"
        error={errors.department_code}
        hint="Who supplied it. It does not restrict who may use the image."
      >
        {(id) => (
          <select
            id={id}
            name="department_code"
            defaultValue={values?.departmentCode ?? ""}
            className={cn(CONTROL, border(errors.department_code))}
          >
            <option value="">Not recorded</option>
            {departments.map((department) => (
              <option key={department.code} value={department.code}>
                {department.nameEn}
              </option>
            ))}
          </select>
        )}
      </Field>
    </>
  );
}

/**
 * Registering an image that a deploy has already put on the site.
 *
 * Not an upload, and the form says so. There is nowhere for runtime bytes to
 * live yet — `public/` is inside the app root the release prunes, and the
 * private document store is encrypted and served as an attachment — so this
 * records and describes a file that is already being served.
 *
 * The dimensions are typed rather than measured because measuring means
 * decoding, and an image decoder on this host is how the worker runs out of
 * memory.
 */
export function RegisterImageForm({
  departments,
  action,
}: {
  departments: readonly { code: string; nameEn: string }[];
  action: Action;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="mt-4 max-w-2xl space-y-4">
      {state.status === "error" && state.message && (
        <p
          role="alert"
          className="rounded-lg border border-urgent-600/50 bg-urgent-50 px-4 py-3 text-[0.9375rem] text-urgent-800"
        >
          {state.message}
        </p>
      )}

      <Field
        name="src"
        label="Path on this site"
        required
        error={errors.src}
        hint="Starting with a slash, as it appears in the address bar: /photos/delegation-2026.jpg"
      >
        {(id, invalid) => (
          <input
            id={id}
            type="text"
            name="src"
            required
            maxLength={400}
            spellCheck={false}
            autoCapitalize="off"
            placeholder="/photos/…"
            aria-invalid={invalid}
            className={cn(CONTROL, border(errors.src), "font-mono text-[0.875rem]")}
          />
        )}
      </Field>

      <DescriptionFields errors={errors} departments={departments} />

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-brand-800 px-5 py-2.5 text-[0.9375rem] font-medium text-white hover:bg-brand-900 disabled:opacity-60"
      >
        {pending ? "Adding…" : "Add to the library"}
      </button>
    </form>
  );
}

/** Re-describing an image. `src` is absent because it is not editable. */
export function DescribeImageForm({
  id,
  values,
  departments,
  action,
}: {
  id: number;
  values: {
    altEn: string;
    altUr: string | null;
    caption: string | null;
    width: number;
    height: number;
    departmentCode: string | null;
  };
  departments: readonly { code: string; nameEn: string }[];
  action: Action;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="mt-4 max-w-2xl space-y-4">
      <input type="hidden" name="id" value={id} />

      <p role="status" aria-live="polite" className="sr-only">
        {pending ? "Saving" : (state.message ?? "")}
      </p>

      {state.status === "error" && state.message && (
        <p
          role="alert"
          className="rounded-lg border border-urgent-600/50 bg-urgent-50 px-4 py-3 text-[0.9375rem] text-urgent-800"
        >
          {state.message}
        </p>
      )}

      {state.status === "ok" && state.message && (
        <p className="rounded-lg border border-success-700/40 bg-success-50 px-4 py-3 text-[0.9375rem] text-success-900">
          {state.message} Every page using this image has been rebuilt.
        </p>
      )}

      <DescriptionFields errors={errors} values={values} departments={departments} />

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-brand-800 px-5 py-2.5 text-[0.9375rem] font-medium text-white hover:bg-brand-900 disabled:opacity-60"
      >
        {pending ? "Saving…" : "Save"}
      </button>
    </form>
  );
}

/* -------------------------------------------------------------------------- */

function Field({
  name,
  label,
  hint,
  error,
  required,
  children,
}: {
  name: string;
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: (id: string, invalid: true | undefined) => React.ReactNode;
}) {
  const id = `media-${name}`;

  return (
    <div className="flex flex-col">
      <label htmlFor={id} className="text-sm font-medium text-ink-900">
        {label}
        {required && (
          <>
            <span className="ml-1 text-urgent-700" aria-hidden>
              *
            </span>
            <span className="sr-only"> (required)</span>
          </>
        )}
      </label>

      {children(id, error ? true : undefined)}

      {hint && !error && (
        <p className="mt-1 text-[0.8125rem] leading-snug text-stone-600">{hint}</p>
      )}
      {error && <p className="mt-1 text-[0.8125rem] leading-snug text-urgent-700">{error}</p>}
    </div>
  );
}
