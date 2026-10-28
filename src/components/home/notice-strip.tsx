import Link from "next/link";
import { AlertTriangle, ArrowRight, Info } from "lucide-react";
import { getActiveNotice } from "@/content/repository";
import { cn } from "@/lib/cn";

/**
 * One notice, as a strip, never as a modal.
 *
 * The legacy homepage stacked four pop-ups with no expiry — an AGM notice for
 * 30 September was still interrupting visitors on 22 October. Here the window
 * is data, the repository filters on it, and nothing renders once it closes.
 */
export async function NoticeStrip() {
  const notice = await getActiveNotice();
  if (!notice) return null;

  const urgent = notice.level === "urgent";
  const Icon = urgent ? AlertTriangle : Info;

  return (
    <div
      className={cn(
        "border-b",
        urgent
          ? "border-urgent-500/20 bg-urgent-50 text-urgent-700"
          : "border-ink-200 bg-ink-50 text-ink-800",
      )}
      role={urgent ? "alert" : undefined}
    >
      <div className="container-page flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
        <Icon className="h-4 w-4 shrink-0" aria-hidden />
        <p className="font-medium">{notice.messageEn}</p>
        {notice.href && (
          <Link
            href={notice.href}
            className="inline-flex items-center gap-1 font-semibold underline underline-offset-4 hover:no-underline"
          >
            Read more
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        )}
      </div>
    </div>
  );
}
