"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { ArrowRight, CheckCircle2, ExternalLink, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IDLE, type ActionState } from "@/lib/action-state";
import { CONTACT_TOPICS } from "@/content/contact-topics";
import { cn } from "@/lib/cn";

/**
 * The contact form.
 *
 * Four things here are design decisions rather than markup, and each of them
 * is the difference between a form that looks finished and one that is.
 *
 * **The topic is asked before the message**, and answering it can tell the
 * visitor they are in the wrong place. Someone who picks "Membership" is shown
 * the portal link *while the message box is still empty*, which is the only
 * moment that saves them typing an application into a box that cannot accept
 * one. A form that accepts everything politely and routes it nowhere is the
 * thing the contact page previously refused to build.
 *
 * **Errors appear twice**: once in a live region at the top, which is what a
 * screen reader announces and what a keyboard user's focus moves to, and once
 * at each field, which is what a sighted user reads. Neither alone is enough —
 * a summary with no field markers leaves you hunting, and field markers with
 * no summary are silent to anyone not looking at them.
 *
 * **Success replaces the form rather than sitting above it.** The reference is
 * the only record the sender has, so it gets the whole panel and a heading
 * that takes focus, instead of a green line under a form they now have to work
 * out whether to submit again.
 *
 * **Nothing is disabled while submitting except the button.** Disabling the
 * fieldset is the common pattern and it moves focus to the body on a slow
 * connection, which is exactly when someone is most likely to be reading what
 * they wrote.
 *
 * ## Why every field is controlled
 *
 * React 19 calls `form.reset()` when a form action settles — on failure as
 * well as on success. With uncontrolled inputs that means a submission the
 * server rejected comes back as an empty form with "please check the
 * highlighted fields" above it, and the person has to retype six fields to
 * fix one. Verified in the browser, not deduced: name, email and message came
 * back blank, and the topic select reset to its placeholder while the panel
 * belonging to the chosen topic was still on screen.
 *
 * Holding the values in state makes the reset a no-op for the text fields,
 * because React tracks their DOM value and the next render puts them back.
 * **A `<select>` is not covered by that**, and the effect below says why.
 */

const FIELD =
  "h-11 w-full rounded-lg border bg-white px-3.5 text-[0.9375rem] text-ink-900 " +
  "transition-colors placeholder:text-stone-400 " +
  "focus:border-brand-600 focus:outline-2 focus:outline-offset-2 focus:outline-brand-700";

const FIELD_REST = "border-stone-300 hover:border-stone-400";
/** urgent-600 is 6.7:1 on white — a control boundary needs 3:1, and this is one. */
const FIELD_ERROR = "border-urgent-600 bg-urgent-50/40";

const LABEL = "block text-[0.875rem] font-medium text-ink-900";
const HINT = "mt-1.5 text-[0.8125rem] text-ink-600";

export function ContactForm({
  action,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const [values, setValues] = useState({
    name: "",
    email: "",
    phone: "",
    organisation: "",
    topic: "",
    message: "",
  });

  function set(field: keyof typeof values) {
    return (
      event: React.ChangeEvent<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >,
    ) => setValues((previous) => ({ ...previous, [field]: event.target.value }));
  }

  const ids = {
    name: useId(),
    email: useId(),
    phone: useId(),
    organisation: useId(),
    topic: useId(),
    message: useId(),
    summary: useId(),
    counter: useId(),
    redirect: useId(),
    done: useId(),
  };

  const summaryRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLHeadingElement>(null);
  const topicRef = useRef<HTMLSelectElement>(null);

  /**
   * Put the chosen topic back after React resets the form.
   *
   * React 19 resets a form when its action settles, and a controlled text
   * input survives that because React tracks the DOM value it last wrote and
   * restores it on the next render. A `<select>` does not: the reset clears
   * `selectedIndex`, React's own `value` prop has not changed between the two
   * renders, so it writes nothing and the control is left showing
   * "Choose one…" while the component still believes a topic is chosen.
   *
   * That is not only wrong on screen. `FormData` reads the DOM, so the next
   * submission of a form the person believes is unchanged would carry an
   * empty topic and fail validation on a field they can see is filled in.
   *
   * Observed in Chrome against this form, not inferred: after a rejected
   * submission the select's DOM value was `""` while its React prop was
   * `"certificates"`. No dependency array, because the condition is the
   * guard — it does nothing on every render where the two already agree.
   */
  useEffect(() => {
    const select = topicRef.current;
    if (select && select.value !== values.topic) select.value = values.topic;
  });

  // Focus follows the outcome, in both directions. Without this a keyboard
  // user who submits an invalid form is left at the bottom of it with a
  // message they will not find, and one who submits a valid one is left on a
  // button that has disappeared.
  useEffect(() => {
    if (state.status === "error") summaryRef.current?.focus();
    if (state.status === "ok") doneRef.current?.focus();
  }, [state]);

  const errors = state.fieldErrors ?? {};
  const chosen = CONTACT_TOPICS.find((entry) => entry.code === values.topic);

  if (state.status === "ok") {
    return (
      <Confirmation
        headingId={ids.done}
        headingRef={doneRef}
        message={state.message}
        reference={state.data?.reference}
      />
    );
  }

  return (
    <form action={formAction} noValidate className="mt-6">
      {/* Live region first in the DOM, so it is announced before the fields
          it is describing and so focus moving here does not jump backwards. */}
      <div
        ref={summaryRef}
        id={ids.summary}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        className={cn(
          "scroll-mt-24 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-700",
          state.status === "error" &&
            "mb-6 rounded-lg border border-urgent-300 bg-urgent-50 px-4 py-3",
        )}
      >
        {state.status === "error" && state.message && (
          <p className="text-[0.9375rem] font-medium text-urgent-800">{state.message}</p>
        )}
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          id={ids.name}
          name="name"
          label="Your name"
          autoComplete="name"
          required
          error={errors.name}
          value={values.name}
          onChange={set("name")}
        />
        <Field
          id={ids.email}
          name="email"
          type="email"
          label="Email address"
          autoComplete="email"
          placeholder="you@company.com.pk"
          required
          error={errors.email}
          value={values.email}
          onChange={set("email")}
        />
        <Field
          id={ids.phone}
          name="phone"
          type="tel"
          label="Phone"
          optional
          autoComplete="tel"
          placeholder="+92 42 …"
          error={errors.phone}
          value={values.phone}
          onChange={set("phone")}
        />
        <Field
          id={ids.organisation}
          name="organisation"
          label="Firm or organisation"
          optional
          autoComplete="organization"
          error={errors.organisation}
          value={values.organisation}
          onChange={set("organisation")}
        />
      </div>

      <div className="mt-5">
        <label htmlFor={ids.topic} className={LABEL}>
          What is this about?
        </label>
        <select
          ref={topicRef}
          id={ids.topic}
          name="topic"
          required
          value={values.topic}
          onChange={set("topic")}
          aria-invalid={errors.topic ? true : undefined}
          aria-describedby={cn(errors.topic && `${ids.topic}-error`, chosen?.redirect && ids.redirect) || undefined}
          className={cn(FIELD, errors.topic ? FIELD_ERROR : FIELD_REST, "pr-10")}
        >
          <option value="">Choose one…</option>
          {CONTACT_TOPICS.map((entry) => (
            <option key={entry.code} value={entry.code}>
              {entry.label}
            </option>
          ))}
        </select>
        {errors.topic && <FieldError id={`${ids.topic}-error`}>{errors.topic}</FieldError>}

        {chosen?.redirect && (
          <aside
            id={ids.redirect}
            className="mt-3 rounded-lg border border-brand-300 bg-brand-50 px-4 py-3"
          >
            <p className="text-[0.875rem] leading-relaxed text-ink-800">
              {chosen.redirect.text}
            </p>
            <a
              href={chosen.redirect.href}
              {...(chosen.redirect.href.startsWith("http")
                ? { target: "_blank", rel: "noreferrer noopener" }
                : {})}
              className="mt-2 inline-flex items-center gap-1.5 text-[0.875rem] font-medium text-brand-800 underline decoration-brand-400 decoration-2 underline-offset-4 transition-colors hover:decoration-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-700"
            >
              {chosen.redirect.linkLabel}
              {chosen.redirect.href.startsWith("http") ? (
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              )}
            </a>
            <p className="mt-2 text-[0.8125rem] text-ink-600">
              You can still write below if that is not what you need.
            </p>
          </aside>
        )}
      </div>

      <div className="mt-5">
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor={ids.message} className={LABEL}>
            Your message
          </label>
          <span
            id={ids.counter}
            className={cn(
              "text-[0.75rem] tabular-nums",
              values.message.length > 4000
                ? "font-medium text-urgent-700"
                : "text-ink-500",
            )}
          >
            {values.message.length.toLocaleString("en-GB")} / 4,000
          </span>
        </div>
        <textarea
          id={ids.message}
          name="message"
          rows={7}
          required
          value={values.message}
          onChange={set("message")}
          aria-invalid={errors.message ? true : undefined}
          aria-describedby={cn(ids.counter, errors.message && `${ids.message}-error`)}
          placeholder="Tell the chamber what you need, and include anything that would help us answer — a membership number, a date, a reference."
          className={cn(
            FIELD,
            errors.message ? FIELD_ERROR : FIELD_REST,
            "h-auto min-h-[10rem] py-3 leading-relaxed",
          )}
        />
        {errors.message && (
          <FieldError id={`${ids.message}-error`}>{errors.message}</FieldError>
        )}
      </div>

      {/* The honeypot. Off-screen rather than `display: none`, which some
          form-fillers skip, and out of the tab order and the accessibility
          tree, so no person can reach it by any route. */}
      <div aria-hidden="true" className="absolute left-[-9999px] top-0 h-0 w-0 overflow-hidden">
        <label htmlFor={`${ids.name}-website`}>Website</label>
        <input
          id={`${ids.name}-website`}
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          defaultValue=""
        />
      </div>

      <div className="mt-7 flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={pending} size="lg">
          {pending ? "Sending…" : "Send message"}
          {!pending && <Send className="h-4 w-4" aria-hidden />}
        </Button>
        <p className="text-[0.8125rem] leading-relaxed text-ink-600">
          The chamber uses what you send here only to answer you. See our{" "}
          <a
            href="/privacy"
            className="underline decoration-ink-300 underline-offset-4 transition-colors hover:text-ink-900 hover:decoration-ink-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-700"
          >
            privacy policy
          </a>
          .
        </p>
      </div>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                     */
/* -------------------------------------------------------------------------- */

function Field({
  id,
  name,
  label,
  error,
  optional,
  type = "text",
  ...rest
}: {
  id: string;
  name: string;
  label: string;
  error?: string;
  optional?: boolean;
  type?: string;
} & React.ComponentProps<"input">) {
  return (
    <div>
      <label htmlFor={id} className={LABEL}>
        {label}
        {optional && (
          // Marking what is optional rather than starring what is required:
          // on a form where most fields are compulsory, the asterisks become
          // the noise and the two fields that matter stop standing out.
          <span className="ml-1.5 font-normal text-ink-500">(optional)</span>
        )}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className={cn(FIELD, error ? FIELD_ERROR : FIELD_REST, "mt-1.5")}
        {...rest}
      />
      {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
    </div>
  );
}

function FieldError({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p id={id} className="mt-1.5 text-[0.8125rem] font-medium text-urgent-700">
      {children}
    </p>
  );
}

function Confirmation({
  headingId,
  headingRef,
  message,
  reference,
}: {
  headingId: string;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  message?: string;
  reference?: string;
}) {
  return (
    <div className="mt-6 rounded-xl border border-brand-300 bg-brand-50 px-6 py-7">
      <CheckCircle2 className="h-8 w-8 text-brand-700" aria-hidden />

      <h3
        ref={headingRef}
        id={headingId}
        tabIndex={-1}
        className="mt-3 font-display text-xl font-semibold text-ink-950 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-700"
      >
        {message ?? "Thank you — your message is with the chamber."}
      </h3>

      {reference && (
        <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink-800">
          Your reference is{" "}
          <strong className="font-mono text-[1.0625rem] font-semibold tracking-tight text-ink-950">
            {reference}
          </strong>
          . Quote it if you telephone about this message. It is in the
          confirmation sent to your email address as well.
        </p>
      )}

      <p className={HINT}>
        A member of staff will read it and reply to the address you gave. If it
        is urgent, telephone the chamber rather than waiting.
      </p>

      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-5 inline-flex items-center gap-1.5 text-[0.875rem] font-medium text-brand-800 underline decoration-brand-400 decoration-2 underline-offset-4 transition-colors hover:decoration-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-700"
      >
        Send another message
        <ArrowRight className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}
