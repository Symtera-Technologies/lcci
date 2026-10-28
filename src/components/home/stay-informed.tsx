"use client";

import { useActionState, useId } from "react";
import { MessageCircle, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { subscribe, type SubscribeState } from "./subscribe-action";
import { cn } from "@/lib/cn";

const INITIAL: SubscribeState = { status: "idle" };

/**
 * Circular alerts by email, plus the WhatsApp channel.
 *
 * KCCI's WhatsApp channel is the single feature local members mention most, and
 * it costs nothing to match.
 */
export function StayInformed() {
  const [state, formAction, pending] = useActionState(subscribe, INITIAL);
  const emailId = useId();
  const statusId = useId();

  return (
    <section className="container-page py-20">
      <div className="grid gap-px overflow-hidden rounded-2xl bg-stone-200 md:grid-cols-2">
        {/* Email alerts */}
        <div className="bg-white p-8 lg:p-10">
          <h2 className="font-display text-display-sm font-semibold text-ink-950">
            Circular alerts
          </h2>
          <p className="mt-3 text-[0.9375rem] leading-relaxed text-stone-600">
            Every SRO, notification and circular that affects your sector, the day
            it lands. Choose your sectors after you confirm.
          </p>

          <form action={formAction} className="mt-6">
            <label
              htmlFor={emailId}
              className="block text-sm font-medium text-ink-900"
            >
              Email address
            </label>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                id={emailId}
                name="email"
                type="email"
                autoComplete="email"
                required
                aria-describedby={state.message ? statusId : undefined}
                aria-invalid={state.status === "error" || undefined}
                placeholder="you@company.com.pk"
                className="h-11 w-full rounded-lg border border-stone-300 bg-white px-3.5 text-[0.9375rem] text-ink-900 placeholder:text-stone-400 focus:border-brand-400"
              />
              <Button type="submit" disabled={pending} className="shrink-0">
                {pending ? "Sending…" : "Subscribe"}
                {!pending && <Send className="h-4 w-4" aria-hidden />}
              </Button>
            </div>

            {state.message && (
              <p
                id={statusId}
                role="status"
                className={cn(
                  "mt-3 text-sm",
                  state.status === "error" ? "text-urgent-700" : "text-success-700",
                )}
              >
                {state.message}
              </p>
            )}

            <p className="mt-3 text-xs text-stone-500">
              We use your address only for chamber alerts. See our{" "}
              <a href="/privacy" className="underline underline-offset-2 hover:text-ink-800">
                privacy policy
              </a>
              .
            </p>
          </form>
        </div>

        {/* WhatsApp channel */}
        <div className="bg-ink-950 p-8 text-white lg:p-10">
          <h2 className="font-display text-display-sm font-semibold text-white">
            WhatsApp channel
          </h2>
          <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink-300">
            Headlines, event reminders and urgent notices on the app your team
            already has open. No reply needed, no group noise.
          </p>

          <a
            href="https://whatsapp.com/channel/lcci"
            target="_blank"
            rel="noreferrer noopener"
            className="mt-6 inline-flex h-11 items-center gap-2 rounded-lg bg-white/10 px-5 text-[0.9375rem] font-medium text-white ring-1 ring-inset ring-white/20 transition-colors hover:bg-white/20"
          >
            <MessageCircle className="h-4 w-4" aria-hidden />
            Follow the channel
          </a>

          {/* ink-400 (5.05:1 on ink-950), not ink-500 (3.18:1). Small print is
              still text and still has to clear 4.5:1. */}
          <p className="mt-6 text-xs text-ink-400">
            Channel link pending confirmation by the Information Department.
          </p>
        </div>
      </div>
    </section>
  );
}
