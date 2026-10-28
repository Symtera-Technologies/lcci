"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

/* -------------------------------------------------------------------------- */
/* TiltCard                                                                   */
/* -------------------------------------------------------------------------- */

interface TiltCardProps extends React.ComponentProps<"div"> {
  /** Maximum rotation in degrees at the card's corners. */
  maxTilt?: number;
  /** How far the card rises towards the reader, in px. */
  lift?: number;
}

/**
 * Pointer-tracked 3D tilt.
 *
 * The rotation is written to CSS custom properties rather than to `style.
 * transform`, so the transform itself stays declarative in `@utility v2-tilt`
 * and this component never fights Tailwind for the property.
 *
 * Three things keep it honest:
 *  - it only binds on devices with a real pointer, so a tap cannot leave a
 *    phone stuck mid-tilt;
 *  - it does nothing at all under `prefers-reduced-motion: reduce`;
 *  - with no JS the properties are unset and the card renders flat, which is
 *    the correct resting state rather than a broken one.
 *
 * Writes happen on an animation frame because `pointermove` fires far more
 * often than the display refreshes, and each write invalidates style.
 */
export function TiltCard({
  maxTilt = 7,
  lift = 6,
  className,
  children,
  ...props
}: TiltCardProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const fine = window.matchMedia("(hover: hover) and (pointer: fine)");
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!fine.matches || calm.matches) return;

    let frame = 0;
    let rx = 0;
    let ry = 0;

    const paint = () => {
      frame = 0;
      el.style.setProperty("--v2-rx", `${rx.toFixed(2)}deg`);
      el.style.setProperty("--v2-ry", `${ry.toFixed(2)}deg`);
    };

    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      // -0.5 … 0.5 from the card's centre.
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      // Y pointer drives rotateX, and inverted: pushing the pointer up should
      // tip the card's top edge away from the reader, not towards them.
      rx = -py * maxTilt * 2;
      ry = px * maxTilt * 2;
      if (!frame) frame = requestAnimationFrame(paint);
    };

    const onEnter = () => {
      el.style.setProperty("--v2-lift", `-${lift}px`);
    };

    const onLeave = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      el.style.setProperty("--v2-rx", "0deg");
      el.style.setProperty("--v2-ry", "0deg");
      el.style.setProperty("--v2-lift", "0px");
    };

    el.addEventListener("pointerenter", onEnter);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener("pointerenter", onEnter);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
    };
  }, [maxTilt, lift]);

  return (
    <div
      ref={ref}
      className={cn(
        "v2-tilt transition-[transform,box-shadow] duration-300 ease-out-expo",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Counter                                                                    */
/* -------------------------------------------------------------------------- */

interface CounterProps {
  value: number;
  /** Rendered immediately after the number, e.g. "k+". */
  suffix?: string;
  className?: string;
}

/**
 * A figure that counts up the first time it is scrolled into view.
 *
 * The final value is what renders on the server, so the real number is in the
 * HTML for crawlers and for anyone without JS — the animation only ever
 * rewrites it downward to zero and back. It runs once and never re-triggers,
 * because a statistic that re-counts every time it scrolls past is a
 * distraction rather than an effect.
 */
export function Counter({ value, suffix = "", className }: CounterProps) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let frame = 0;
    let started = false;

    const run = () => {
      const start = performance.now();
      const duration = 1100;

      const step = (now: number) => {
        const t = Math.min((now - start) / duration, 1);
        // Ease-out quint: fast enough to read as responsive, settling slowly
        // so the final digits are legible rather than a blur.
        const eased = 1 - Math.pow(1 - t, 5);
        el.textContent = `${Math.round(eased * value).toLocaleString("en-PK")}${suffix}`;
        if (t < 1) frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    };

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !started) {
            started = true;
            io.disconnect();
            run();
          }
        }
      },
      { threshold: 0.4 },
    );

    io.observe(el);
    return () => {
      io.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [value, suffix]);

  return (
    <span ref={ref} className={className}>
      {value.toLocaleString("en-PK")}
      {suffix}
    </span>
  );
}
