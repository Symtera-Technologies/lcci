"use client";

import { useActionState } from "react";
import { IDLE, type ActionState } from "@/lib/action-state";
import { SelectField, TextField } from "@/components/membership/fields";

type Action = (prev: ActionState, formData: FormData) => Promise<ActionState>;

function Status({ state }: { state: ActionState }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className={
        state.status === "error"
          ? "min-h-6 text-[0.875rem] font-medium text-urgent-700"
          : "min-h-6 text-[0.875rem] text-brand-800"
      }
    >
      {state.message ?? ""}
    </p>
  );
}

/**
 * One day of the working-day calendar.
 *
 * A single form for both directions — recording a closure and reopening a day
 * — because they are the same edit and the register has no "delete a holiday"
 * operation. Reopening a day the chamber will in fact work is a decision
 * somebody makes, with a source, exactly as closing one is.
 *
 * The live region carries the consequence rather than a tick. "14 promised
 * dates are being recomputed" is the sentence the person entering an Eid
 * notification needs, and it is the only place they will ever see that number.
 */
export function CalendarDayForm({
  action,
  defaultDate,
}: {
  action: Action;
  defaultDate: string;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="space-y-4">
      <Status state={state} />

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="date"
          label="Date"
          type="date"
          required
          defaultValue={defaultDate}
          error={errors.date}
        />

        <SelectField
          name="working"
          label="The chamber is"
          required
          defaultValue="closed"
          placeholder="Choose…"
          options={[
            { value: "closed", label: "Closed — not a working day" },
            { value: "working", label: "Open — a working day" },
          ]}
          error={errors.working}
        />
      </div>

      <TextField
        name="label"
        label="What it is"
        maxLength={120}
        placeholder="Eid-ul-Fitr (second day)"
        error={errors.label}
        hint="Written on the day in the calendar, and the only thing that explains a moved deadline a year from now."
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="confidence"
          label="How firm is this"
          required
          defaultValue="provisional"
          placeholder="Choose…"
          options={[
            {
              value: "provisional",
              label: "Provisional — expected, not yet notified",
            },
            { value: "confirmed", label: "Confirmed — officially notified" },
          ]}
          error={errors.confidence}
          hint="Eid moves on the moon sighting. A provisional date still counts in the arithmetic; it is marked so somebody knows to come back to it."
        />

        <TextField
          name="notifiedOn"
          label="Notified on"
          type="date"
          error={errors.notifiedOn}
          hint="Leave blank until the notification lands."
        />
      </div>

      <TextField
        name="source"
        label="Where this came from"
        maxLength={160}
        placeholder="Cabinet Division notification, 12 March 2027"
        error={errors.source}
        hint="A deadline will move because of this row. In a year's time the source is what makes that defensible."
      />

      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-11 items-center rounded-lg bg-ink-900 px-5 text-sm font-semibold text-white hover:bg-ink-800 disabled:opacity-60"
      >
        {pending ? "Saving…" : "Record this day"}
      </button>
    </form>
  );
}

/**
 * Extend the calendar by a year at a time.
 *
 * Deliberately not automatic. A calendar that extends itself whenever it runs
 * short would quietly make a Monday-to-Friday assumption permanent, and the
 * secretariat's working week is still an open question — several Pakistani
 * chambers work a six-day week. Somebody presses this, and the rows it writes
 * say in their own `source` column that they were assumed.
 */
export function ExtendCalendarForm({
  action,
  nextYear,
}: {
  action: Action;
  nextYear: number;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="space-y-3">
      <Status state={state} />

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-40">
          <TextField
            name="throughYear"
            label="Extend to the end of"
            type="text"
            inputMode="numeric"
            required
            defaultValue={String(nextYear)}
            error={errors.throughYear}
          />
        </div>

        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-11 items-center rounded-lg border border-stone-300 bg-white px-5 text-sm font-medium text-ink-800 hover:border-ink-400 disabled:opacity-60"
        >
          {pending ? "Extending…" : "Extend the calendar"}
        </button>
      </div>
    </form>
  );
}
