"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { ChevronDown, Menu, Phone, Search, User, X } from "lucide-react";
import { Logo } from "./logo";
import { PRIMARY_NAV, type NavSection } from "./nav-data";
import { ButtonLink } from "@/components/ui/button";
import { cn } from "@/lib/cn";

export function Header() {
  const [mobileOpen, setMobileOpen] = useState(false);

  // Lock scroll while the mobile sheet is open.
  useEffect(() => {
    document.body.style.overflow = mobileOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileOpen]);

  return (
    <header className="sticky top-0 z-40 border-b border-stone-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80">
      {/* Utility bar — spec §4.2 */}
      <div className="hidden bg-ink-950 text-ink-100 lg:block">
        <div className="container-page flex h-10 items-center justify-between text-[0.8125rem]">
          <a
            href="tel:+92111222499"
            className="inline-flex items-center gap-2 text-ink-200 transition-colors hover:text-white"
          >
            <Phone className="h-3.5 w-3.5" aria-hidden />
            <span>111-222-499</span>
          </a>

          <nav aria-label="Utility" className="flex items-center gap-6">
            <Link href="/services" className="transition-colors hover:text-brand-300">
              Smart Services
            </Link>
            <Link href="/trade/inquiries" className="transition-colors hover:text-brand-300">
              Trade inquiries
            </Link>
            <Link href="/news/media-contacts" className="transition-colors hover:text-brand-300">
              Media
            </Link>
            <span className="h-4 w-px bg-white/15" aria-hidden />
            <Link
              href="/portal"
              className="inline-flex items-center gap-1.5 transition-colors hover:text-brand-300"
            >
              <User className="h-3.5 w-3.5" aria-hidden />
              Member login
            </Link>
            <Link
              href="/ur"
              lang="ur"
              dir="rtl"
              className="rounded px-1.5 py-0.5 text-sm transition-colors hover:bg-white/10 hover:text-white"
            >
              اردو
            </Link>
          </nav>
        </div>
      </div>

      {/* Main bar */}
      <div className="container-page flex h-[4.5rem] items-center justify-between gap-6">
        <Link href="/" aria-label="Lahore Chamber of Commerce & Industry — home">
          <Logo />
        </Link>

        <nav aria-label="Primary" className="hidden items-center gap-0.5 xl:flex">
          {PRIMARY_NAV.map((section) => (
            <NavDropdown key={section.href} section={section} />
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <Link
            href="/search"
            aria-label="Search the site"
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-ink-700 transition-colors hover:bg-stone-100"
          >
            <Search className="h-[1.125rem] w-[1.125rem]" aria-hidden />
          </Link>

          <ButtonLink href="/membership/apply" size="sm" className="hidden sm:inline-flex">
            Join LCCI
          </ButtonLink>

          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
            aria-expanded={mobileOpen}
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-ink-800 transition-colors hover:bg-stone-100 xl:hidden"
          >
            <Menu className="h-5 w-5" aria-hidden />
          </button>
        </div>
      </div>

      {mobileOpen && <MobileNav onClose={() => setMobileOpen(false)} />}
    </header>
  );
}

/* -------------------------------------------------------------------------- */

function NavDropdown({ section }: { section: NavSection }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Close on Escape, and when focus leaves the whole group — so the panel is
  // usable by keyboard, not only by mouse.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const scheduleClose = () => {
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  };
  const cancelClose = () => clearTimeout(closeTimer.current);

  return (
    <div
      ref={wrapRef}
      className="relative"
      onMouseEnter={() => {
        cancelClose();
        setOpen(true);
      }}
      onMouseLeave={scheduleClose}
      onFocus={() => setOpen(true)}
      onBlur={(e) => {
        if (!wrapRef.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <Link
        href={section.href}
        aria-expanded={open}
        aria-controls={panelId}
        className={cn(
          "inline-flex items-center gap-1 rounded-lg px-3 py-2 text-[0.9375rem] font-medium transition-colors",
          open ? "bg-stone-100 text-ink-950" : "text-ink-800 hover:bg-stone-100",
        )}
      >
        {section.label}
        <ChevronDown
          className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </Link>

      {open && (
        <div
          id={panelId}
          className="absolute start-0 top-full z-50 w-[22rem] pt-2"
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          <div className="overflow-hidden rounded-xl border border-stone-200 bg-white p-2 shadow-raised">
            {section.children.map((child) => (
              <Link
                key={child.href}
                href={child.href}
                className="block rounded-lg px-3 py-2.5 transition-colors hover:bg-stone-50"
              >
                <span className="block text-sm font-medium text-ink-900">
                  {child.label}
                </span>
                {child.description && (
                  <span className="mt-0.5 block text-[0.8125rem] leading-snug text-stone-500">
                    {child.description}
                  </span>
                )}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function MobileNav({ onClose }: { onClose: () => void }) {
  // Portalled to <body> on purpose. The header sets `backdrop-filter`, and a
  // backdrop-filtered ancestor becomes the containing block for its fixed-
  // position descendants — so rendering the drawer inside the header clipped it
  // to the header's own 72px box instead of filling the viewport.
  //
  // Resolved once in a lazy initialiser rather than inline, because `document`
  // does not exist during the server render and Fast Refresh can re-run this
  // component before the document is available. The drawer only mounts on a
  // click, so by then the body is always there.
  const [container] = useState<HTMLElement | null>(() =>
    typeof document === "undefined" ? null : document.body,
  );

  if (!container) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 xl:hidden">
      <div
        className="absolute inset-0 bg-ink-950/40"
        onClick={onClose}
        aria-hidden
      />
      <div className="absolute inset-y-0 end-0 flex w-full max-w-sm flex-col bg-white shadow-raised">
        <div className="flex h-[4.5rem] shrink-0 items-center justify-between border-b border-stone-200 px-5">
          <Logo />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-ink-800 hover:bg-stone-100"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>

        <nav aria-label="Primary (mobile)" className="flex-1 overflow-y-auto px-3 py-4">
          {PRIMARY_NAV.map((section) => (
            <details key={section.href} className="group border-b border-stone-100">
              <summary className="flex cursor-pointer list-none items-center justify-between px-2 py-3.5 text-[0.9375rem] font-medium text-ink-900 marker:hidden">
                {section.label}
                <ChevronDown
                  className="h-4 w-4 text-stone-400 transition-transform group-open:rotate-180"
                  aria-hidden
                />
              </summary>
              <div className="pb-2">
                {section.children.map((child) => (
                  <Link
                    key={child.href}
                    href={child.href}
                    onClick={onClose}
                    className="block rounded-lg px-2 py-2.5 text-sm text-stone-600 hover:bg-stone-50 hover:text-ink-900"
                  >
                    {child.label}
                  </Link>
                ))}
              </div>
            </details>
          ))}
        </nav>

        <div className="shrink-0 space-y-2 border-t border-stone-200 p-5">
          <ButtonLink href="/membership/apply" className="w-full" onClick={onClose}>
            Join LCCI
          </ButtonLink>
          <ButtonLink
            href="/portal"
            variant="ghost"
            className="w-full"
            onClick={onClose}
          >
            Member login
          </ButtonLink>
          <Link
            href="/ur"
            lang="ur"
            dir="rtl"
            onClick={onClose}
            className="block pt-1 text-center text-sm text-stone-500 hover:text-ink-900"
          >
            اردو میں دیکھیں
          </Link>
        </div>
      </div>
    </div>,
    container,
  );
}
