import Link from "next/link";
import { Check } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * The step indicator and the frame around each step.
 *
 * A server component: it renders no state of its own, and keeping it out of
 * the client bundle matters on a form this size.
 *
 * Steps are real links with real URLs rather than client-side tabs. Three
 * reasons, in order of how much they cost if ignored: the back button does
 * what an applicant expects, a half-finished application can be resumed at the
 * step it was left on from an emailed link, and the form survives JavaScript
 * failing to load on a phone on a bad connection.
 */

export interface StepDescriptor {
  readonly number: 1 | 2 | 3;
  readonly title: string;
  readonly summary: string;
}

export const STEPS: readonly StepDescriptor[] = [
  {
    number: 1,
    title: "Your firm",
    summary: "The company, its representative and the figures.",
  },
  {
    number: 2,
    title: "People",
    summary: "Directors or partners, and your proposer and seconder.",
  },
  {
    number: 3,
    title: "Documents and declaration",
    summary: "Upload what is required, then declare and submit.",
  },
];

export function StepIndicator({
  current,
  completed,
}: {
  current: 1 | 2 | 3;
  completed: readonly number[];
}) {
  return (
    <nav aria-label="Application progress">
      <ol className="flex flex-col gap-px overflow-hidden rounded-xl bg-stone-200 sm:flex-row">
        {STEPS.map((step) => {
          const isCurrent = step.number === current;
          const isDone = completed.includes(step.number);

          return (
            <li key={step.number} className="flex-1 bg-white">
              <Link
                href={`/membership/apply?step=${step.number}`}
                aria-current={isCurrent ? "step" : undefined}
                className={cn(
                  "flex h-full min-h-11 items-start gap-3 p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-600",
                  isCurrent && "bg-brand-50",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[0.75rem] font-semibold",
                    isDone
                      ? "border-success-700 bg-success-700 text-white"
                      : isCurrent
                        ? "border-brand-700 bg-brand-700 text-white"
                        : "border-stone-300 text-stone-600",
                  )}
                >
                  {isDone ? <Check className="h-3.5 w-3.5" aria-hidden /> : step.number}
                  <span className="sr-only">
                    {isDone ? "Completed: " : isCurrent ? "Current step: " : ""}
                  </span>
                </span>

                <span className="min-w-0">
                  <span
                    className={cn(
                      "block text-sm font-semibold",
                      isCurrent ? "text-ink-950" : "text-ink-900",
                    )}
                  >
                    Step {step.number}. {step.title}
                  </span>
                  <span className="mt-0.5 block text-[0.8125rem] leading-snug text-stone-600">
                    {step.summary}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** A titled group of fields, so a sixty-field form reads as sections. */
export function FieldSet({
  title,
  description,
  children,
  columns = 2,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  columns?: 1 | 2;
}) {
  return (
    <section className="border-t border-stone-200 pt-8 first:border-0 first:pt-0">
      <h3 className="font-display text-lg font-semibold text-ink-950">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-prose text-[0.9375rem] leading-relaxed text-stone-600">
          {description}
        </p>
      )}
      <div
        className={cn(
          "mt-5 grid gap-5",
          columns === 2 ? "sm:grid-cols-2" : "grid-cols-1",
        )}
      >
        {children}
      </div>
    </section>
  );
}
