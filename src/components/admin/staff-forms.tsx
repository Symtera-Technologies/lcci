"use client";

import { useActionState } from "react";
import Link from "next/link";
import { IDLE, type ActionState } from "@/lib/action-state";
import {
  createStaffAction,
  resetPasswordAction,
  updateStaffAction,
} from "@/app/(admin)/admin/users/actions";
import { TextField } from "@/components/membership/fields";
import { Button } from "@/components/ui/button";

/**
 * The staff account forms.
 *
 * Two things worth stating about the shape, because both were decisions.
 *
 * **The two-factor requirement is a checkbox on the same form as the roles**,
 * not a separate switch elsewhere. It is part of deciding what an account is
 * for: an administrator granting `cashier` or `membership_approver` is in the
 * one frame of mind where "and they must use an authenticator" is the obvious
 * next thought. A control on another screen is one somebody visits once.
 *
 * **A generated password and a requirement notice are shown once and said
 * plainly.** Neither can be recovered — the password is a scrypt digest the
 * moment the action returns — so the screen says so rather than implying the
 * moment can be had again.
 */

export interface RoleOption {
  readonly code: string;
  readonly label: string;
  readonly scoped: boolean;
  readonly note: string;
}

export interface DepartmentOption {
  readonly code: string;
  readonly label: string;
}

/* -------------------------------------------------------------------------- */
/* Creating                                                                   */
/* -------------------------------------------------------------------------- */

export function CreateStaffForm({
  roles,
  departments,
}: {
  roles: readonly RoleOption[];
  departments: readonly DepartmentOption[];
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    createStaffAction,
    IDLE,
  );

  const password = state.data?.temporaryPassword;
  if (password) {
    return (
      <HandOver
        password={password}
        userId={state.data?.userId}
        heading="Account created."
      />
    );
  }

  return (
    <form action={action} className="flex flex-col gap-6" noValidate>
      <Status state={state} />

      <TextField
        name="email"
        type="email"
        label="Chamber email address"
        hint="They sign in with this. It must be an address only they read."
        error={state.fieldErrors?.email}
        autoComplete="off"
        required
      />

      <TextField
        name="full_name"
        label="Full name"
        hint="As it should appear against their decisions in the audit log."
        error={state.fieldErrors?.fullName}
        autoComplete="off"
        required
      />

      <RoleChoice roles={roles} departments={departments} error={state.fieldErrors?.roles} />

      <TwoFactorChoice />

      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create account"}
        </Button>
        <Link
          href="/admin/users"
          className="text-[0.875rem] text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600"
        >
          Cancel
        </Link>
      </div>

      <p className="text-[0.8125rem] leading-relaxed text-stone-600">
        The account is created as <strong className="font-medium">invited</strong> and
        cannot sign in until you set it to active on its own page. A password is
        generated and shown to you once, to hand over in person.
      </p>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Managing                                                                   */
/* -------------------------------------------------------------------------- */

export interface StaffFormValues {
  readonly id: number;
  readonly email: string;
  readonly fullName: string;
  readonly status: string;
  readonly roles: readonly string[];
  readonly departmentScope: string | null;
  readonly twoFactorEnabled: boolean;
  readonly twoFactorRequired: boolean;
}

const STATUS_LABELS: Record<string, string> = {
  invited: "Invited — cannot sign in yet",
  active: "Active — can sign in",
  suspended: "Suspended — cannot sign in, can be restored",
  disabled: "Disabled — gone, kept for the audit trail",
};

export function UpdateStaffForm({
  user,
  roles,
  departments,
  isSelf,
}: {
  user: StaffFormValues;
  roles: readonly RoleOption[];
  departments: readonly DepartmentOption[];
  isSelf: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    updateStaffAction,
    IDLE,
  );

  if (isSelf) {
    return (
      <div className="rounded-lg border border-stone-300 bg-stone-50 p-4 text-[0.9375rem] leading-relaxed text-ink-800">
        <strong className="font-semibold">This is your own account.</strong> You
        cannot change your own roles, status or two-factor requirement here —
        that is what stops an administrator lifting a requirement somebody
        imposed on them, and what stops anyone who borrows your session doing
        it. Ask another administrator, or manage your own sign-in under{" "}
        <Link
          href="/admin/security"
          className="font-medium text-brand-700 underline decoration-brand-700/40 underline-offset-4"
        >
          Your sign-in
        </Link>
        .
      </div>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-6" noValidate>
      <input type="hidden" name="user_id" value={user.id} />
      <Status state={state} />

      <TextField
        name="full_name"
        label="Full name"
        defaultValue={user.fullName}
        error={state.fieldErrors?.fullName}
        autoComplete="off"
        required
      />

      <fieldset className="flex flex-col gap-2">
        <legend className="text-[0.9375rem] font-medium text-ink-950">
          Account status
        </legend>
        {Object.entries(STATUS_LABELS).map(([value, label]) => (
          <label key={value} className="flex items-start gap-3 text-[0.9375rem]">
            <input
              type="radio"
              name="status"
              value={value}
              defaultChecked={user.status === value}
              className="mt-1 size-4 accent-brand-800"
            />
            <span className="text-ink-800">{label}</span>
          </label>
        ))}
      </fieldset>

      <RoleChoice
        roles={roles}
        departments={departments}
        selected={user.roles}
        departmentScope={user.departmentScope}
        error={state.fieldErrors?.roles}
      />

      <TwoFactorChoice
        defaultChecked={user.twoFactorRequired}
        alreadyOn={user.twoFactorEnabled}
      />

      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
        <Link
          href="/admin/users"
          className="text-[0.875rem] text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600"
        >
          Back to the list
        </Link>
      </div>

      <p className="text-[0.8125rem] leading-relaxed text-stone-600">
        Saving signs this account out of every session it has open, so a change
        to what it can do takes effect at once rather than whenever they next
        happen to sign in.
      </p>
    </form>
  );
}

/**
 * Resetting somebody else's password.
 *
 * Its own form, so Enter in a text field on the page above cannot trigger it,
 * and behind a confirming click, because what it actually does is lock a
 * colleague out of a session they may be in the middle of using.
 */
export function ResetPasswordForm({ userId, name }: { userId: number; name: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    resetPasswordAction,
    IDLE,
  );

  const password = state.data?.temporaryPassword;
  if (password) {
    return <HandOver password={password} heading="New password set." />;
  }

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="user_id" value={userId} />
      <Status state={state} />
      <p className="max-w-prose text-[0.9375rem] leading-relaxed text-ink-700">
        Generates a new password, shows it to you once to hand over, and signs{" "}
        {name} out of everything. Their old password stops working immediately.
      </p>
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        {pending ? "Setting…" : "Set a new password"}
      </Button>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Shared pieces                                                              */
/* -------------------------------------------------------------------------- */

function Status({ state }: { state: ActionState }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className={
        state.status === "error"
          ? "min-h-6 text-sm font-medium text-urgent-700"
          : state.status === "ok"
            ? "min-h-6 text-sm font-medium text-ink-900"
            : "min-h-6 text-sm text-transparent"
      }
    >
      {state.message ?? ""}
    </p>
  );
}

function RoleChoice({
  roles,
  departments,
  selected = [],
  departmentScope = null,
  error,
}: {
  roles: readonly RoleOption[];
  departments: readonly DepartmentOption[];
  selected?: readonly string[];
  departmentScope?: string | null;
  error?: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      <fieldset
        aria-describedby={error ? "roles-error" : undefined}
        className="flex flex-col gap-2"
      >
        <legend className="text-[0.9375rem] font-medium text-ink-950">Roles</legend>
        <p className="mb-1 text-[0.8125rem] text-stone-600">
          What this account may do. Verifying, receipting and approving are
          never on one role on purpose — the printed form has separate staff and
          cashier signatures for the same reason.
        </p>
        {roles.map((role) => (
          <label key={role.code} className="flex items-start gap-3 text-[0.9375rem]">
            <input
              type="checkbox"
              name="roles"
              value={role.code}
              defaultChecked={selected.includes(role.code)}
              className="mt-1 size-4 accent-brand-800"
            />
            <span>
              <span className="font-medium text-ink-900">{role.label}</span>
              {/* A text node between the two, so the accessible name reads
                  "Cashier Receipts fees…" rather than running the role into
                  its note as one word. The note is a block element, so the
                  space costs nothing visually. */}{" "}
              <span className="block text-[0.8125rem] text-stone-600">{role.note}</span>
            </span>
          </label>
        ))}
        {error && (
          <p id="roles-error" className="text-sm font-medium text-urgent-700">
            {error}
          </p>
        )}
      </fieldset>

      <label className="flex max-w-sm flex-col gap-1">
        <span className="text-[0.9375rem] font-medium text-ink-950">Department</span>
        <span className="text-[0.8125rem] text-stone-600">
          Only used by the roles above that say they are scoped by department.
          Leave it blank for everyone else.
        </span>
        <select
          name="department_scope"
          defaultValue={departmentScope ?? ""}
          className="mt-1 h-10 rounded-lg border border-ink-300 bg-white px-3 text-[0.9375rem] text-ink-950 focus-visible:border-brand-700"
        >
          <option value="">No department scope</option>
          {departments.map((department) => (
            <option key={department.code} value={department.code}>
              {department.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function TwoFactorChoice({
  defaultChecked = false,
  alreadyOn = false,
}: {
  defaultChecked?: boolean;
  alreadyOn?: boolean;
}) {
  return (
    <fieldset className="rounded-lg border border-stone-300 bg-stone-50 p-4">
      <legend className="px-1 text-[0.9375rem] font-medium text-ink-950">
        Two-factor sign-in
      </legend>
      <label className="flex items-start gap-3 text-[0.9375rem]">
        <input
          type="checkbox"
          name="require_2fa"
          value="1"
          defaultChecked={defaultChecked}
          className="mt-1 size-4 accent-brand-800"
        />
        <span>
          <span className="font-medium text-ink-900">
            Require an authenticator app on this account
          </span>{" "}
          <span className="block text-[0.8125rem] leading-relaxed text-stone-600">
            They cannot reach anything in the backend until they have paired
            one, and they cannot turn it off for themselves afterwards. Strongly
            recommended for any account that receipts fees, approves
            memberships, or reads uploaded identity documents.
          </span>
        </span>
      </label>
      {alreadyOn && (
        <p className="mt-3 text-[0.8125rem] leading-relaxed text-stone-600">
          This account already uses an authenticator by its own choice. Ticking
          the box pins that in place — it stops them turning it off — rather
          than asking them to set anything up.
        </p>
      )}
    </fieldset>
  );
}

/**
 * A credential shown exactly once.
 *
 * Rendered from the action result into a `no-store` response. It says in
 * so many words that there is no second chance, because the alternative is an
 * administrator closing the tab and a colleague who cannot sign in.
 */
function HandOver({
  password,
  userId,
  heading,
}: {
  password: string;
  userId?: string;
  heading: string;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div
        role="status"
        className="rounded-lg border border-success-600/30 bg-success-50 p-4 text-[0.9375rem] leading-relaxed text-ink-900"
      >
        <strong className="font-semibold">{heading}</strong> Hand this password
        over in person or by telephone, not by email — an emailed password makes
        the inbox the credential. It is stored as a one-way hash, so this is the
        only time it can be shown.
      </div>

      <code className="block break-all rounded-lg border border-stone-300 bg-stone-50 px-3 py-2.5 font-mono text-[1.0625rem] tracking-[0.04em] text-ink-950">
        {password}
      </code>

      <p>
        <Link
          href={userId ? `/admin/users/${userId}` : "/admin/users"}
          className="inline-flex h-11 items-center justify-center rounded-lg bg-brand-400 px-5 text-[0.9375rem] font-medium tracking-tight text-ink-950 shadow-sm transition-colors hover:bg-brand-300"
        >
          {userId ? "I have it — open the account" : "I have it — continue"}
        </Link>
      </p>
    </div>
  );
}
