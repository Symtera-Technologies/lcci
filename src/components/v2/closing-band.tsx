import Link from "next/link";
import { ArrowRight, LogIn } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";

/**
 * The last thing a visitor sees before the footer.
 *
 * Takes no data, so it is a plain server component.
 *
 * There is deliberately no newsletter sign-up here. The email provider is still
 * unresolved in the spec, and a field that collects addresses before anything
 * exists to send from would promise the reader a subscription the chamber
 * cannot currently deliver. "Staying informed" is offered instead as a link to
 * the circulars archive, which is a real route with real content behind it.
 *
 * The mesh moves; the words do not. A call to action that drifts, rises or
 * fades under the reader is the one place on a page where motion costs more
 * than it earns, so every animation here is confined to the decorative layer.
 */
export function ClosingBand() {
  return (
    <section
      aria-labelledby="v2-closing-heading"
      className="relative isolate overflow-hidden bg-ink-950 text-white"
    >
      {/* Mesh. Two lit blobs drift against a third that is held still, which is
          what keeps it reading as light falling across a surface rather than as
          a gradient being animated. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -left-24 -top-32 h-[32rem] w-[32rem] animate-drift rounded-full bg-[radial-gradient(circle,var(--color-brand-500)_0%,transparent_68%)] opacity-35 blur-3xl motion-reduce:animate-none" />
        <div className="absolute -bottom-40 left-[38%] h-[30rem] w-[30rem] animate-drift rounded-full bg-[radial-gradient(circle,var(--color-brand-700)_0%,transparent_70%)] opacity-50 blur-3xl [animation-direction:reverse] [animation-duration:32s] motion-reduce:animate-none" />
        <div className="absolute -right-32 top-[-6rem] h-[26rem] w-[26rem] rounded-full bg-[radial-gradient(circle,var(--color-ink-600)_0%,transparent_72%)] opacity-60 blur-3xl" />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />
      </div>

      <div className="container-page py-20 lg:py-28">
        <div className="grid items-center gap-12 lg:grid-cols-12 lg:gap-16">
          <div className="lg:col-span-7">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-300">
              Membership
            </p>
            <h2
              id="v2-closing-heading"
              className="mt-4 font-display text-display-lg font-semibold text-white"
            >
              Put your firm behind the ask
            </h2>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-ink-200">
              For 103 years the chamber has made the case for Lahore&rsquo;s
              businesses to government. Membership puts your sector in the
              directory, your people on the delegations, and your position in the
              room where the asks are drafted.
            </p>

            <div className="mt-9 flex flex-wrap items-center gap-3">
              <ButtonLink href="/membership/apply" variant="primary" size="lg">
                Join LCCI
                <ArrowRight className="h-4 w-4" aria-hidden />
              </ButtonLink>
              {/* The shared `onDark` ring is tuned for the lighter ink panels;
                  against ink-950 at 25% white it lands at 2.2:1, under the 3:1
                  that 1.4.11 asks of a control's boundary. 40% clears it. */}
              <ButtonLink
                href="/portal"
                variant="onDark"
                size="lg"
                className="ring-white/40"
              >
                <LogIn className="h-4 w-4" aria-hidden />
                Member login
              </ButtonLink>
            </div>

            <p className="mt-7 text-sm text-ink-200">
              Not ready to join?{" "}
              <Link
                href="/news/circulars"
                className="font-medium text-brand-300 underline decoration-brand-400 decoration-from-font underline-offset-4 hover:text-brand-200"
              >
                Every circular and SRO the chamber publishes
              </Link>{" "}
              is open to read.
            </p>
          </div>

          {/* A quiet typographic plaque rather than a second block of persuasion:
              the band already asks twice, and the founding date is the argument
              that needs no sentence. Real text, not an image, so it scales with
              the reader's type size. */}
          <div className="lg:col-span-5 lg:justify-self-end">
            <div className="v2-glass max-w-xs rounded-2xl p-8 shadow-depth-3">
              <p className="font-display text-display-md font-semibold leading-none text-brand-300">
                1923
              </p>
              <hr className="my-5 border-0 border-t border-brand-400/40" />
              <p className="font-display text-lg font-medium leading-snug text-white">
                Lahore Chamber of Commerce &amp; Industry
              </p>
              <p className="mt-3 text-sm leading-relaxed text-ink-200">
                One of Pakistan&rsquo;s oldest and largest chambers, representing
                members across twenty sectors of Punjab&rsquo;s economy.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
