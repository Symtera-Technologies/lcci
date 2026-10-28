"use client";

import { useActionState, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IDLE, type ActionState } from "@/lib/action-state";
import {
  saveDirectorsAction,
  saveEndorsersAction,
} from "@/app/(portal)/membership/apply/actions";
import { ENDORSEMENT_DECLARATION } from "@/membership/declaration";
import { ChoiceGroup, TextField } from "./fields";
import { FieldSet } from "./wizard-chrome";

/**
 * Step 2: the directors or partners, and the two members who endorse.
 *
 * The directors list is unbounded. The printed form fits five and says "use
 * photocopy of this page" for more, while the document checklist says "CNIC of
 * ALL directors" — so a paper limit of five is a property of the paper, not of
 * the Chamber's rule, and reproducing it here would force a board of nine into
 * the same workaround.
 *
 * Two forms rather than one. They write to different tables with different
 * rules — a director row is matched by id so its uploaded documents keep
 * pointing at it, and an endorsement that has already been given is superseded
 * rather than edited — and a single submit button would hide which of the two
 * failed.
 */

export interface DirectorRow {
  readonly id: number | null;
  readonly fullName: string;
  readonly designation: string;
  readonly membershipNo: string;
  readonly cell: string;
  readonly cnic: string;
  readonly passport: string;
  readonly ntn: string;
  readonly isForeignNational: boolean;
}

export interface EndorserRow {
  readonly firmName: string;
  readonly membershipNo: string;
  readonly representativeName: string;
  readonly mobile: string;
  readonly email: string;
  readonly state: string;
}

export interface PeopleProps {
  readonly applicationId: number;
  readonly directors: readonly DirectorRow[];
  readonly proposer: EndorserRow;
  readonly seconder: EndorserRow;
  readonly endorsementMode: string | null;
  readonly scratch: Record<string, string>;
  readonly fieldErrors: Record<string, string>;
}

const EMPTY_DIRECTOR: DirectorRow = {
  id: null,
  fullName: "",
  designation: "",
  membershipNo: "",
  cell: "",
  cnic: "",
  passport: "",
  ntn: "",
  isForeignNational: false,
};

export function StepPeople(props: PeopleProps) {
  return (
    <div className="space-y-12">
      <DirectorsForm {...props} />
      <EndorsersForm {...props} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Directors                                                                  */
/* -------------------------------------------------------------------------- */

function DirectorsForm(props: PeopleProps) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    saveDirectorsAction,
    IDLE,
  );

  // Seeded with one empty row so the section is never an empty box with an
  // "add" button — a proprietorship has exactly one person to enter and should
  // not have to discover that.
  const [rows, setRows] = useState<DirectorRow[]>(
    props.directors.length > 0 ? [...props.directors] : [EMPTY_DIRECTOR],
  );

  const errors = state.fieldErrors ?? props.fieldErrors;

  return (
    <form action={formAction}>
      <input type="hidden" name="applicationId" value={props.applicationId} />

      <FieldSet
        title="Directors or partners"
        description="Everyone on the board, or every partner. A CNIC is required for each of them at step 3, so the list here decides how many you will be asked to upload."
        columns={1}
      >
        <div className="space-y-6">
          {rows.map((row, index) => (
            <fieldset
              key={row.id ?? `new-${index}`}
              className="rounded-xl border border-stone-200 p-5"
            >
              <div className="flex items-center justify-between gap-3">
                <legend className="text-sm font-semibold text-ink-950">
                  {index === 0 ? "Director or partner 1" : `Director or partner ${index + 1}`}
                </legend>

                {rows.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setRows(rows.filter((_, i) => i !== index))}
                    className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2.5 text-[0.8125rem] font-medium text-urgent-700 hover:bg-urgent-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-urgent-600"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                    Remove
                    <span className="sr-only"> director or partner {index + 1}</span>
                  </button>
                )}
              </div>

              <div className="mt-4 grid gap-5 sm:grid-cols-2">
                {row.id !== null && (
                  <input type="hidden" name={`directors.${index}.id`} value={row.id} />
                )}
                <TextField
                  name={`directors.${index}.fullName`}
                  label="Full name"
                  required
                  maxLength={160}
                  defaultValue={row.fullName}
                  error={errors[`directors.${index}.fullName`]}
                />
                <TextField
                  name={`directors.${index}.designation`}
                  label="Designation"
                  required
                  maxLength={120}
                  defaultValue={row.designation}
                  error={errors[`directors.${index}.designation`]}
                />
                <TextField
                  name={`directors.${index}.cnic`}
                  label="CNIC number"
                  required
                  inputMode="numeric"
                  placeholder="35202-1234567-1"
                  defaultValue={props.scratch[`directors.${index}.cnic`] ?? row.cnic}
                  pending={`directors.${index}.cnic` in props.scratch}
                  error={errors[`directors.${index}.cnic`]}
                />
                <TextField
                  name={`directors.${index}.cell`}
                  label="Mobile number"
                  type="tel"
                  required
                  inputMode="tel"
                  defaultValue={row.cell}
                  error={errors[`directors.${index}.cell`]}
                />
                <TextField
                  name={`directors.${index}.membershipNo`}
                  label="LCCI membership number"
                  maxLength={30}
                  defaultValue={row.membershipNo}
                  error={errors[`directors.${index}.membershipNo`]}
                  hint="If this person is already a member in their own right."
                />
                <TextField
                  name={`directors.${index}.ntn`}
                  label="National Tax Number"
                  maxLength={40}
                  defaultValue={row.ntn}
                  error={errors[`directors.${index}.ntn`]}
                />
                <TextField
                  name={`directors.${index}.passport`}
                  label="Passport number"
                  maxLength={40}
                  defaultValue={row.passport}
                  error={errors[`directors.${index}.passport`]}
                  hint="Foreign nationals only."
                />
                <div className="flex items-end pb-1">
                  <label className="flex min-h-11 items-center gap-2.5 text-[0.9375rem] text-ink-900">
                    <input
                      type="checkbox"
                      name={`directors.${index}.isForeignNational`}
                      defaultChecked={row.isForeignNational}
                      className="h-4 w-4 accent-brand-700"
                    />
                    This person is a foreign national
                  </label>
                </div>
              </div>
            </fieldset>
          ))}

          <button
            type="button"
            onClick={() => setRows([...rows, EMPTY_DIRECTOR])}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-dashed border-stone-300 px-4 text-[0.9375rem] font-medium text-ink-900 hover:border-brand-500 hover:text-brand-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          >
            <Plus className="h-4 w-4" aria-hidden />
            Add another director or partner
          </button>
        </div>
      </FieldSet>

      <div className="mt-6 flex items-center gap-4">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save directors"}
        </Button>
        <p role="status" aria-live="polite" className="text-[0.8125rem] text-stone-600">
          {state.message}
        </p>
      </div>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Proposer and seconder                                                      */
/* -------------------------------------------------------------------------- */

function EndorsersForm(props: PeopleProps) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    saveEndorsersAction,
    IDLE,
  );

  const errors = state.fieldErrors ?? props.fieldErrors;

  return (
    <form action={formAction}>
      <input type="hidden" name="applicationId" value={props.applicationId} />

      <FieldSet
        title="Proposer and seconder"
        description="Two existing LCCI members, each holding valid membership. The Chamber checks their standing when you submit and again before a decision — an endorsement given in February by a member who lapses on 31 March does not carry into April."
        columns={1}
      >
        <ChoiceGroup
          name="endorsementMode"
          legend="How will they endorse?"
          required
          options={[
            { value: "in_app", label: "Online — we email each of them a link" },
            { value: "signed_sheet", label: "On paper — I will upload a signed and stamped sheet" },
          ]}
          selected={props.endorsementMode ? [props.endorsementMode] : []}
          error={errors.endorsementMode}
        />

        <blockquote className="rounded-lg border-l-4 border-brand-700 bg-stone-50 p-4 text-[0.9375rem] leading-relaxed text-ink-900">
          <p className="text-[0.8125rem] font-semibold uppercase tracking-wide text-stone-600">
            What they attest to
          </p>
          <p className="mt-2">{ENDORSEMENT_DECLARATION}</p>
        </blockquote>

        {(["proposer", "seconder"] as const).map((role) => {
          const row = role === "proposer" ? props.proposer : props.seconder;

          return (
            <fieldset key={role} className="rounded-xl border border-stone-200 p-5">
              <legend className="text-sm font-semibold text-ink-950">
                {role === "proposer" ? "Proposed by" : "Seconded by"}
                {row.state === "endorsed" && (
                  <span className="ml-2 rounded-full bg-success-50 px-2 py-0.5 text-[0.75rem] font-medium text-success-700">
                    Endorsed
                  </span>
                )}
              </legend>

              <div className="mt-4 grid gap-5 sm:grid-cols-2">
                <TextField
                  name={`${role}.firmName`}
                  label="Firm or company name"
                  required
                  maxLength={200}
                  defaultValue={row.firmName}
                  error={errors[`${role}.firmName`]}
                />
                <TextField
                  name={`${role}.membershipNo`}
                  label="Membership number"
                  required
                  maxLength={30}
                  defaultValue={row.membershipNo}
                  error={errors[`${role}.membershipNo`]}
                />
                <TextField
                  name={`${role}.representativeName`}
                  label="Representative's name"
                  required
                  maxLength={160}
                  defaultValue={row.representativeName}
                  error={errors[`${role}.representativeName`]}
                />
                <TextField
                  name={`${role}.mobile`}
                  label="Mobile number"
                  type="tel"
                  required
                  inputMode="tel"
                  defaultValue={row.mobile}
                  error={errors[`${role}.mobile`]}
                />
                <div className="sm:col-span-2">
                  <TextField
                    name={`${role}.email`}
                    label="Email address"
                    type="email"
                    defaultValue={row.email}
                    error={errors[`${role}.email`]}
                    hint="Needed if they are endorsing online — this is where their link goes."
                  />
                </div>
              </div>
            </fieldset>
          );
        })}
      </FieldSet>

      <div className="mt-6 flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save proposer and seconder"}
        </Button>
        <a
          href="/membership/apply?step=3"
          className="inline-flex h-11 items-center rounded-lg bg-brand-800 px-5 text-[0.9375rem] font-semibold text-white hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
        >
          Continue
        </a>
        <p role="status" aria-live="polite" className="text-[0.8125rem] text-stone-600">
          {state.message}
        </p>
      </div>
    </form>
  );
}
