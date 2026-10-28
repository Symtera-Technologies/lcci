import Link from "next/link";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "onDark";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  // Brand green, as a light-on-dark fill carrying ink text. Not the crest's own
  // #174c30: as a button on the ink hero that is a 1.86:1 shape, effectively
  // invisible. brand-400 clears 7.66:1 against both the label and the panel.
  primary:
    "bg-brand-400 text-ink-950 hover:bg-brand-300 active:bg-brand-500 shadow-sm",
  secondary:
    "bg-ink-900 text-white hover:bg-ink-800 active:bg-ink-950 shadow-sm",
  ghost:
    "bg-transparent text-ink-800 ring-1 ring-inset ring-ink-200 hover:bg-ink-50 hover:ring-ink-300",
  // The ring is this button's only real boundary — the white/10 fill is just
  // 1.30:1 on ink-950 — so it has to clear 3:1 on its own (WCAG 2.2 1.4.11).
  // white/25 measured 2.22:1 and failed; white/40 is 3.81:1.
  onDark:
    "bg-white/10 text-white ring-1 ring-inset ring-white/40 backdrop-blur-sm hover:bg-white/20",
};

const SIZES: Record<Size, string> = {
  sm: "h-9 px-3.5 text-sm gap-1.5",
  md: "h-11 px-5 text-[0.9375rem] gap-2",
  lg: "h-13 px-7 text-base gap-2.5",
};

const BASE =
  "inline-flex items-center justify-center rounded-lg font-medium tracking-tight " +
  "transition-colors duration-150 whitespace-nowrap " +
  "disabled:pointer-events-none disabled:opacity-50";

interface ButtonProps extends React.ComponentProps<"button"> {
  variant?: Variant;
  size?: Size;
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(BASE, VARIANTS[variant], SIZES[size], className)}
      {...props}
    />
  );
}

interface ButtonLinkProps extends React.ComponentProps<typeof Link> {
  variant?: Variant;
  size?: Size;
}

export function ButtonLink({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ButtonLinkProps) {
  return (
    <Link
      className={cn(BASE, VARIANTS[variant], SIZES[size], className)}
      {...props}
    />
  );
}
