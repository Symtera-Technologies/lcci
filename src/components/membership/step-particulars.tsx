"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { IDLE, type ActionState } from "@/lib/action-state";
import { saveParticularsAction } from "@/app/(portal)/membership/apply/actions";
import { CLASS_LABELS, TIER_LABELS } from "@/membership/fees";
import { ChoiceGroup, SelectField, TextAreaField, TextField } from "./fields";
import { FieldSet } from "./wizard-chrome";
import type { Option } from "./fields";

/**
 * Step 1: the firm, its representative and the figures — fields 1 to 16 of the
 * printed form.
 *
 * Every value shown comes from `value`, which prefers what the applicant
 * actually typed over what was stored. That is the visible half of the
 * autosave design: "approx 60m" in the turnover box could not be put in a
 * DECIMAL column, so it lives in `wizard_scratch` and reappears here exactly as
 * typed, with a note rather than an error. Clearing the box on reload — which
 * is what a plain `defaultValue={row.annual_turnover}` would do — is how a form
 * silently eats an afternoon's work.
 */

export interface ParticularsValues {
  readonly [field: string]: string | undefined;
}

export interface ParticularsProps {
  readonly applicationId: number;
  readonly values: ParticularsValues;
  readonly scratch: Record<string, string>;
  readonly selectedBusinessTypes: readonly string[];
  readonly companyStatuses: readonly Option[];
  readonly businessTypes: readonly Option[];
  readonly fieldErrors: Record<string, string>;
}

const CLASS_OPTIONS: readonly Option[] = (["corporate", "associate"] as const).map(
  (value) => ({ value, label: CLASS_LABELS[value] }),
);

const TIER_OPTIONS: readonly Option[] = (
  ["regular", "urgent", "executive"] as const
).map((value) => ({ value, label: TIER_LABELS[value] }));

export function StepParticulars(props: ParticularsProps) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    saveParticularsAction,
    IDLE,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const { saveNow, savedAt, saving } = useAutosave(formRef, props.applicationId);

  // The server's field errors on first render; the action's thereafter, so a
  // save that fixed three fields does not leave their errors on screen.
  const errors = state.fieldErrors ?? props.fieldErrors;

  const value = (field: string) => props.scratch[field] ?? props.values[field] ?? "";
  const isPending = (field: string) => field in props.scratch;

  return (
    <form ref={formRef} action={formAction} onBlur={saveNow} className="space-y-8">
      <input type="hidden" name="applicationId" value={props.applicationId} />
      <input type="hidden" name="step" value="1" />

      <FieldSet
        title="Membership and processing"
        description="The class decides the fee; the tier decides how quickly the Chamber promises an answer. Both are printed on the pay order you will attach, so choose them before drawing it."
      >
        <SelectField
          name="membershipClass"
          label="Class of membership"
          required
          options={CLASS_OPTIONS}
          defaultValue={value("membershipClass")}
          error={errors.membershipClass}
          hint="Corporate covers a body corporate, a multinational, or a sales-tax-registered concern turning over Rs 50 million or more."
        />
        <SelectField
          name="processingTier"
          label="Processing"
          required
          options={TIER_OPTIONS}
          defaultValue={value("processingTier")}
          error={errors.processingTier}
          hint="Regular 40 working days, Urgent 15, Executive 3."
        />
      </FieldSet>

      <FieldSet title="The firm" description="As it appears on your letterhead.">
        <TextField
          name="firmName"
          label="Firm or company name"
          required
          maxLength={200}
          defaultValue={value("firmName")}
          error={errors.firmName}
        />
        <SelectField
          name="companyStatus"
          label="Status of the concern"
          required
          options={props.companyStatuses}
          defaultValue={value("companyStatus")}
          error={errors.companyStatus}
          hint="This decides which documents you will be asked for at step 3."
        />
      </FieldSet>

      <FieldSet
        title="Representative"
        description="Any one of the directors or partners may represent the concern. For a proprietorship, only the proprietor."
      >
        <TextField
          name="representativeName"
          label="Name of representative"
          required
          maxLength={160}
          autoComplete="name"
          defaultValue={value("representativeName")}
          error={errors.representativeName}
        />
        <TextField
          name="representativeCnic"
          label="CNIC number"
          required
          inputMode="numeric"
          placeholder="35202-1234567-1"
          defaultValue={value("representativeCnic")}
          pending={isPending("representativeCnic")}
          error={errors.representativeCnic}
          hint="Thirteen digits, as printed on the card."
        />
        <TextField
          name="representativePassport"
          label="Passport number"
          maxLength={40}
          defaultValue={value("representativePassport")}
          error={errors.representativePassport}
          hint="Foreign nationals only."
        />
        <TextField
          name="representativeDob"
          label="Date of birth"
          type="date"
          required
          defaultValue={value("representativeDob")}
          pending={isPending("representativeDob")}
          error={errors.representativeDob}
        />
        <TextField
          name="representativeBirthplace"
          label="Place of birth"
          required
          maxLength={120}
          defaultValue={value("representativeBirthplace")}
          error={errors.representativeBirthplace}
        />
        <TextField
          name="representativeNationality"
          label="Nationality"
          required
          maxLength={80}
          defaultValue={value("representativeNationality")}
          error={errors.representativeNationality}
          hint="A firm represented by a foreign national, or with foreign partners, also pays the USD 750 International Trade Development fee by separate pay order."
        />
      </FieldSet>

      <FieldSet title="Contact" columns={2}>
        <div className="sm:col-span-2">
          <TextAreaField
            name="postalAddress"
            label="Postal address of the company or firm"
            required
            maxLength={400}
            defaultValue={value("postalAddress")}
            error={errors.postalAddress}
          />
        </div>
        <TextField
          name="email"
          label="Email address"
          type="email"
          required
          autoComplete="email"
          defaultValue={value("email")}
          pending={isPending("email")}
          error={errors.email}
          hint="Every update about this application goes here."
        />
        <div className="sm:col-span-2">
          <ChoiceGroup
            name="premisesTenure"
            legend="Business premises"
            required
            options={[
              { value: "owned", label: "Owned" },
              { value: "rented", label: "Rented" },
            ]}
            selected={[value("premisesTenure")]}
            error={errors.premisesTenure}
          />
        </div>
        <TextField
          name="officePhone1"
          label="Office telephone"
          type="tel"
          required
          inputMode="tel"
          placeholder="042-37654321"
          defaultValue={value("officePhone1")}
          error={errors.officePhone1}
        />
        <TextField
          name="officePhone2"
          label="Office telephone (second)"
          type="tel"
          inputMode="tel"
          defaultValue={value("officePhone2")}
          error={errors.officePhone2}
        />
        <TextField
          name="fax"
          label="Fax"
          type="tel"
          inputMode="tel"
          defaultValue={value("fax")}
          error={errors.fax}
        />
        <TextField
          name="representativeMobile1"
          label="Representative's mobile"
          type="tel"
          required
          inputMode="tel"
          placeholder="0300-1234567"
          defaultValue={value("representativeMobile1")}
          error={errors.representativeMobile1}
        />
        <TextField
          name="representativeMobile2"
          label="Representative's mobile (second)"
          type="tel"
          inputMode="tel"
          defaultValue={value("representativeMobile2")}
          error={errors.representativeMobile2}
        />
      </FieldSet>

      <FieldSet
        title="The business"
        description="Figures in Pakistani rupees. Annual turnover is checked against the class you chose."
      >
        <TextField
          name="paidUpCapital"
          label="Paid-up capital (Rs)"
          required
          inputMode="numeric"
          defaultValue={value("paidUpCapital")}
          pending={isPending("paidUpCapital")}
          error={errors.paidUpCapital}
        />
        <TextField
          name="annualTurnover"
          label="Annual turnover (Rs)"
          required
          inputMode="numeric"
          defaultValue={value("annualTurnover")}
          pending={isPending("annualTurnover")}
          error={errors.annualTurnover}
        />
        <TextField
          name="employeeCount"
          label="Number of employees"
          required
          inputMode="numeric"
          defaultValue={value("employeeCount")}
          pending={isPending("employeeCount")}
          error={errors.employeeCount}
        />
        <TextField
          name="ntn"
          label="National Tax Number"
          required
          maxLength={40}
          defaultValue={value("ntn")}
          error={errors.ntn}
        />
        <TextField
          name="strn"
          label="Sales tax registration number"
          maxLength={40}
          defaultValue={value("strn")}
          error={errors.strn}
          hint="Leave blank if the concern is not sales-tax registered."
        />
        <div className="sm:col-span-2">
          <ChoiceGroup
            name="businessTypes"
            legend="Type of business"
            multiple
            required
            options={props.businessTypes}
            selected={props.selectedBusinessTypes}
            error={errors.businessTypes}
            hint="Choose every one that applies."
          />
        </div>
        <TextField
          name="businessSector"
          label="Business sector"
          required
          maxLength={120}
          defaultValue={value("businessSector")}
          error={errors.businessSector}
        />
        <TextField
          name="businessSubSector"
          label="Business sub-sector"
          maxLength={120}
          defaultValue={value("businessSubSector")}
          error={errors.businessSubSector}
        />
        <div className="sm:col-span-2">
          <TextField
            name="mainCommodity"
            label="Main commodity or product"
            required
            maxLength={200}
            defaultValue={value("mainCommodity")}
            error={errors.mainCommodity}
          />
        </div>
      </FieldSet>

      <FieldSet
        title="Bank"
        description="The pay order must be drawn on this account, and the account-maintenance certificate you upload must be from this bank."
      >
        <TextField
          name="bankName"
          label="Name of bank"
          required
          maxLength={160}
          defaultValue={value("bankName")}
          error={errors.bankName}
        />
        <TextField
          name="bankBranch"
          label="Branch address or code"
          required
          maxLength={160}
          defaultValue={value("bankBranch")}
          error={errors.bankBranch}
        />
      </FieldSet>

      <SaveBar
        pending={pending}
        saving={saving}
        savedAt={savedAt}
        message={state.message}
        status={state.status}
        nextHref="/membership/apply?step=2"
      />
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Autosave                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Save on blur, debounced, without disturbing the form.
 *
 * It posts the same `FormData` the submit button would and ignores the result
 * beyond "when did this last succeed". Deliberately not `useActionState`: that
 * would re-render the form on every save and move the caret in whichever field
 * the applicant had just tabbed into.
 *
 * Blur rather than keystroke. A keystroke autosave on a sixty-field form over
 * a Pakistani mobile connection means hundreds of requests per sitting against
 * a three-connection pool, and the applicant gains nothing — the risk being
 * covered here is closing the tab, not losing the last word typed.
 */
function useAutosave(formRef: React.RefObject<HTMLFormElement | null>, applicationId: number) {
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const saveNow = () => {
    if (timer.current) clearTimeout(timer.current);

    timer.current = setTimeout(async () => {
      const form = formRef.current;
      if (!form || inFlight.current) return;

      inFlight.current = true;
      setSaving(true);

      try {
        const data = new FormData(form);
        data.set("applicationId", String(applicationId));
        const result = await saveParticularsAction(IDLE, data);
        if (result.status === "ok") setSavedAt(new Date());
      } catch {
        // A failed autosave is not worth interrupting someone mid-form over:
        // the next blur retries, and "Save and continue" reports properly.
        // Staying silent about a *persistent* failure would be worse, which is
        // why the bar shows the last successful save time rather than a tick.
      } finally {
        inFlight.current = false;
        setSaving(false);
      }
    }, 800);
  };

  return { saveNow, savedAt, saving };
}

function SaveBar({
  pending,
  saving,
  savedAt,
  message,
  status,
  nextHref,
}: {
  pending: boolean;
  saving: boolean;
  savedAt: Date | null;
  message?: string;
  status: ActionState["status"];
  nextHref: string;
}) {
  return (
    <div className="sticky bottom-0 -mx-4 mt-10 border-t border-stone-200 bg-white/95 px-4 py-4 backdrop-blur sm:-mx-6 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p role="status" aria-live="polite" className="text-[0.8125rem] text-stone-600">
          {saving
            ? "Saving…"
            : message
              ? message
              : savedAt
                ? `Saved at ${savedAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`
                : "Your answers are saved as you go."}
        </p>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
          <a
            href={nextHref}
            className="inline-flex h-11 items-center rounded-lg bg-brand-800 px-5 text-[0.9375rem] font-semibold text-white hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
          >
            Continue
          </a>
        </div>
      </div>

      {status === "error" && message && (
        <p className="mt-2 text-[0.8125rem] text-urgent-700">{message}</p>
      )}
    </div>
  );
}
