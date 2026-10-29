"use client";

import { useId } from "react";
import { cn } from "@/lib/cn";
import type { FieldSpec } from "@/content/fields";
import { RichTextField } from "@/components/admin/rich-text";

/**
 * One control per field kind, driven by the spec.
 *
 * The accessibility contract is the same as the wizard's and is not optional:
 * a visible label, the error at the field rather than in a summary,
 * `aria-invalid` on the control, and `aria-describedby` pointing at whichever
 * of the hint and the error actually exists. Written once here because fifty
 * hand-written fields across twelve screens will not all honour it.
 *
 * **Its own controls rather than the wizard's.** `src/components/membership/`
 * has the same primitives, and reusing them would mean widening them for
 * `datetime-local` and a media picker that the applicant's form has no use
 * for. Track B is not meant to be editing Track A's modules, and a shared
 * component that grows a parameter for every caller is how two forms end up
 * coupled through their inputs. The duplication is the input classes, which
 * are four lines.
 *
 * Controls here are `h-10`, not the wizard's 44px touch target: this is a
 * staff desktop screen, and a sixty-field editor at touch spacing is a form
 * nobody can see the shape of.
 */

const CONTROL =
  "mt-1.5 h-10 w-full rounded-lg border bg-white px-3 text-[0.9375rem] text-ink-900 placeholder:text-stone-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-1";

function border(error?: string): string {
  // Never colour alone: the message beneath carries the meaning and the border
  // reinforces it.
  return error ? "border-urgent-600" : "border-stone-300 focus:border-brand-500";
}

export interface MediaOption {
  readonly id: number;
  readonly label: string;
}

export function ContentField({
  field,
  value,
  error,
  departments,
  media,
}: {
  field: FieldSpec;
  value: string | boolean | undefined;
  error?: string;
  departments: readonly { code: string; nameEn: string }[];
  media: readonly MediaOption[];
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [field.help ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;

  if (field.kind === "richtext") {
    return (
      <RichTextField
        name={field.name}
        label={field.label}
        hint={field.help}
        error={error}
        defaultValue={typeof value === "string" ? value : ""}
      />
    );
  }

  if (field.kind === "checkbox") {
    return (
      <div className="flex flex-col">
        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            name={field.name}
            defaultChecked={value === true}
            aria-describedby={describedBy}
            className="mt-0.5 size-4.5 rounded border-stone-400 text-brand-800 focus-visible:ring-2 focus-visible:ring-brand-600"
          />
          <span className="text-sm font-medium text-ink-900">{field.label}</span>
        </label>
        <Notes field={field} error={error} hintId={hintId} errorId={errorId} indent />
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <label htmlFor={id} className="text-sm font-medium text-ink-900">
        {field.label}
        {field.required && (
          <>
            <span className="ml-1 text-urgent-700" aria-hidden>
              *
            </span>
            <span className="sr-only"> (required)</span>
          </>
        )}
      </label>

      <Control
        id={id}
        field={field}
        value={value}
        error={error}
        describedBy={describedBy}
        departments={departments}
        media={media}
      />

      <Notes field={field} error={error} hintId={hintId} errorId={errorId} />
    </div>
  );
}

function Control({
  id,
  field,
  value,
  error,
  describedBy,
  departments,
  media,
}: {
  id: string;
  field: FieldSpec;
  value: string | boolean | undefined;
  error?: string;
  describedBy?: string;
  departments: readonly { code: string; nameEn: string }[];
  media: readonly MediaOption[];
}) {
  const text = typeof value === "string" ? value : "";
  const shared = {
    id,
    name: field.name,
    "aria-describedby": describedBy,
    "aria-invalid": error ? true : undefined,
    required: field.required,
  } as const;

  switch (field.kind) {
    case "textarea":
      return (
        <textarea
          {...shared}
          defaultValue={text}
          rows={3}
          maxLength={field.max}
          className={cn(
            "mt-1.5 w-full rounded-lg border bg-white px-3 py-2 text-[0.9375rem] leading-relaxed text-ink-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600",
            border(error),
          )}
        />
      );

    case "select":
      return (
        <select
          {...shared}
          defaultValue={text}
          className={cn(CONTROL, border(error))}
        >
          {/*
            An empty first option even where the field is required: a select
            that opens pre-answered records a choice nobody made, and on
            `good_when` or `position_status` that choice is the meaning of the
            row.
          */}
          <option value="">Choose…</option>
          {field.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );

    case "department":
      return (
        <select {...shared} defaultValue={text} className={cn(CONTROL, border(error))}>
          <option value="">Choose…</option>
          {departments.map((department) => (
            <option key={department.code} value={department.code}>
              {department.nameEn}
            </option>
          ))}
        </select>
      );

    case "media":
      return (
        <select {...shared} defaultValue={text} className={cn(CONTROL, border(error))}>
          <option value="">
            {field.required ? "Choose an image…" : "No image"}
          </option>
          {media.map((option) => (
            <option key={option.id} value={String(option.id)}>
              {option.label}
            </option>
          ))}
        </select>
      );

    case "integer":
      return (
        <input
          {...shared}
          type="number"
          step={1}
          min={field.min}
          defaultValue={text}
          inputMode="numeric"
          className={cn(CONTROL, border(error))}
        />
      );

    case "decimal":
      return (
        <input
          {...shared}
          type="number"
          step="0.01"
          defaultValue={text}
          inputMode="decimal"
          className={cn(CONTROL, border(error))}
        />
      );

    case "date":
      return (
        <input
          {...shared}
          type="date"
          defaultValue={text}
          className={cn(CONTROL, border(error))}
        />
      );

    case "datetime":
      return (
        <input
          {...shared}
          type="datetime-local"
          defaultValue={text}
          className={cn(CONTROL, border(error))}
        />
      );

    case "url":
      return (
        <input
          {...shared}
          type="url"
          defaultValue={text}
          maxLength={field.max}
          placeholder="https://"
          className={cn(CONTROL, border(error))}
        />
      );

    case "slug":
      return (
        <input
          {...shared}
          type="text"
          defaultValue={text}
          maxLength={field.max}
          spellCheck={false}
          autoCapitalize="off"
          className={cn(CONTROL, border(error), "font-mono text-[0.875rem]")}
        />
      );

    default:
      return (
        <input
          {...shared}
          type="text"
          defaultValue={text}
          maxLength={field.max}
          className={cn(CONTROL, border(error))}
        />
      );
  }
}

function Notes({
  field,
  error,
  hintId,
  errorId,
  indent,
}: {
  field: FieldSpec;
  error?: string;
  hintId: string;
  errorId: string;
  indent?: boolean;
}) {
  return (
    <>
      {field.help && !error && (
        <p
          id={hintId}
          className={cn(
            "mt-1 text-[0.8125rem] leading-snug text-stone-600",
            indent && "ml-7",
          )}
        >
          {field.help}
        </p>
      )}
      {error && (
        <p
          id={errorId}
          className={cn(
            "mt-1 text-[0.8125rem] leading-snug text-urgent-700",
            indent && "ml-7",
          )}
        >
          {error}
        </p>
      )}
    </>
  );
}
