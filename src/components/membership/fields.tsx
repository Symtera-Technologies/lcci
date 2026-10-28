"use client";

import { useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The form primitives the wizard is built from.
 *
 * One wrapper rather than hand-written markup per field, because the
 * accessibility contract here is not optional and sixty hand-written fields
 * will not all honour it. Every field gets a visible label, an error placed at
 * the field rather than in a summary at the top, `aria-invalid` on the control
 * and `aria-describedby` pointing at whichever of the hint and the error
 * actually exist. Getting that right once is the whole argument for the
 * wrapper.
 *
 * Controls are `h-11` — 44px — which is the touch target minimum, and it is
 * the reason the inputs look larger than a desktop form would need. Most of
 * the chamber's applicants will type a sixty-field form on a phone.
 */

export interface FieldProps {
  name: string;
  label: string;
  hint?: string;
  error?: string;
  /** Shown when autosave is holding the raw text because it did not parse. */
  pending?: boolean;
  required?: boolean;
  children?: ReactNode;
}

interface InputFieldProps extends FieldProps {
  type?: "text" | "email" | "tel" | "date" | "number" | "password";
  defaultValue?: string | number | null;
  placeholder?: string;
  autoComplete?: string;
  inputMode?: "text" | "numeric" | "tel" | "email";
  maxLength?: number;
  /**
   * Present only where the parent needs the value as it is typed — the sign-in
   * form carries the identifier from its first stage into its second. Every
   * other field in the wizard is uncontrolled and submitted by name, which is
   * what keeps a sixty-field form from re-rendering on every keystroke.
   */
  value?: string;
  onValueChange?: (value: string) => void;
}

/**
 * The shared frame: label on top, control, then hint and error beneath.
 *
 * The error comes after the control in the DOM so a screen reader reaching the
 * field announces the label, then the value, then what is wrong with it — the
 * order someone fixing it needs. Placing errors only in a summary at the top
 * of a three-step form means scrolling back and forth once per mistake.
 */
export function FieldFrame({
  id,
  label,
  hint,
  error,
  pending,
  required,
  children,
}: FieldProps & { id: string }) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  return (
    <div className="flex flex-col">
      <label htmlFor={id} className="text-sm font-medium text-ink-900">
        {label}
        {required && (
          <span className="ml-1 text-urgent-700" aria-hidden>
            *
          </span>
        )}
        {required && <span className="sr-only"> (required)</span>}
      </label>

      {children}

      {hint && !error && (
        <p id={hintId} className="mt-1.5 text-[0.8125rem] leading-snug text-stone-600">
          {hint}
        </p>
      )}

      {pending && !error && (
        <p className="mt-1.5 text-[0.8125rem] leading-snug text-stone-600">
          Saved as typed — this will need tidying before you submit.
        </p>
      )}

      {error && (
        <p id={errorId} className="mt-1.5 text-[0.8125rem] leading-snug text-urgent-700">
          {error}
        </p>
      )}
    </div>
  );
}

const CONTROL_CLASS =
  "mt-2 h-11 w-full rounded-lg border bg-white px-3.5 text-[0.9375rem] text-ink-900 placeholder:text-stone-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-1";

function borderClass(error?: string): string {
  // Never colour alone: the error text beneath carries the meaning, and the
  // border is reinforcement. A red border on its own fails for anyone who
  // cannot distinguish it from the default grey.
  return error ? "border-urgent-600" : "border-stone-300 focus:border-brand-500";
}

export function TextField({
  name,
  label,
  hint,
  error,
  pending,
  required,
  type = "text",
  defaultValue,
  placeholder,
  autoComplete,
  inputMode,
  maxLength,
  value,
  onValueChange,
}: InputFieldProps) {
  const id = useId();
  const controlled = value !== undefined;

  return (
    <FieldFrame
      id={id}
      name={name}
      label={label}
      hint={hint}
      error={error}
      pending={pending}
      required={required}
    >
      <input
        id={id}
        name={name}
        type={type}
        {...(controlled
          ? { value, onChange: (event) => onValueChange?.(event.target.value) }
          : { defaultValue: defaultValue ?? "" })}
        placeholder={placeholder}
        autoComplete={autoComplete}
        inputMode={inputMode}
        maxLength={maxLength}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={cn(CONTROL_CLASS, borderClass(error))}
      />
    </FieldFrame>
  );
}

export function TextAreaField({
  name,
  label,
  hint,
  error,
  required,
  defaultValue,
  rows = 3,
  maxLength,
}: FieldProps & { defaultValue?: string | null; rows?: number; maxLength?: number }) {
  const id = useId();

  return (
    <FieldFrame id={id} name={name} label={label} hint={hint} error={error} required={required}>
      <textarea
        id={id}
        name={name}
        rows={rows}
        defaultValue={defaultValue ?? ""}
        maxLength={maxLength}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={cn(
          CONTROL_CLASS,
          borderClass(error),
          "h-auto py-2.5 leading-relaxed",
        )}
      />
    </FieldFrame>
  );
}

export interface Option {
  value: string;
  label: string;
}

export function SelectField({
  name,
  label,
  hint,
  error,
  required,
  options,
  defaultValue,
  placeholder = "Choose…",
}: FieldProps & {
  options: readonly Option[];
  defaultValue?: string | null;
  placeholder?: string;
}) {
  const id = useId();

  return (
    <FieldFrame id={id} name={name} label={label} hint={hint} error={error} required={required}>
      <select
        id={id}
        name={name}
        defaultValue={defaultValue ?? ""}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={cn(CONTROL_CLASS, borderClass(error))}
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldFrame>
  );
}

/**
 * A group of radios or checkboxes.
 *
 * A `fieldset` and `legend` rather than a label, because a label pointing at
 * one of eight checkboxes does not name the group — and "Business type" is the
 * question, not "Trading".
 */
export function ChoiceGroup({
  name,
  legend,
  hint,
  error,
  required,
  options,
  selected,
  multiple,
}: {
  name: string;
  legend: string;
  hint?: string;
  error?: string;
  required?: boolean;
  options: readonly Option[];
  selected: readonly string[];
  multiple?: boolean;
}) {
  const id = useId();

  return (
    <fieldset
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy(id, hint, error)}
    >
      <legend className="text-sm font-medium text-ink-900">
        {legend}
        {required && (
          <span className="ml-1 text-urgent-700" aria-hidden>
            *
          </span>
        )}
        {required && <span className="sr-only"> (required)</span>}
      </legend>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {options.map((option) => (
          <label
            key={option.value}
            className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border border-stone-300 bg-white px-3.5 py-2 text-[0.9375rem] text-ink-900 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-600"
          >
            <input
              type={multiple ? "checkbox" : "radio"}
              name={name}
              value={option.value}
              defaultChecked={selected.includes(option.value)}
              className="h-4 w-4 accent-brand-700 focus:outline-none"
            />
            {option.label}
          </label>
        ))}
      </div>

      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1.5 text-[0.8125rem] text-stone-600">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="mt-1.5 text-[0.8125rem] text-urgent-700">
          {error}
        </p>
      )}
    </fieldset>
  );
}

export function CheckboxField({
  name,
  label,
  hint,
  error,
  defaultChecked,
}: FieldProps & { defaultChecked?: boolean }) {
  const id = useId();

  return (
    <div>
      <label
        htmlFor={id}
        className="flex min-h-11 cursor-pointer items-start gap-2.5 text-[0.9375rem] text-ink-900"
      >
        <input
          id={id}
          name={name}
          type="checkbox"
          defaultChecked={defaultChecked}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, hint, error)}
          className="mt-1 h-4 w-4 shrink-0 accent-brand-700"
        />
        <span>{label}</span>
      </label>

      {hint && !error && (
        <p id={`${id}-hint`} className="ml-7 text-[0.8125rem] text-stone-600">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="ml-7 text-[0.8125rem] text-urgent-700">
          {error}
        </p>
      )}
    </div>
  );
}

function describedBy(id: string, hint?: string, error?: string): string | undefined {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean);
  return ids.length > 0 ? ids.join(" ") : undefined;
}
