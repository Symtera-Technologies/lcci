import { cn } from "@/lib/cn";
import type { TopicSlug } from "@/content/types";

export const TOPIC_LABELS: Record<TopicSlug, string> = {
  "taxation-budget": "Taxation & Budget",
  energy: "Energy",
  "exports-trade": "Exports & Trade",
  regulation: "Regulation",
  "law-order": "Law & Order",
  smes: "SMEs",
  "women-entrepreneurs": "Women Entrepreneurs",
  infrastructure: "Infrastructure",
};

export function Tag({
  children,
  tone = "neutral",
  className,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "clay" | "ink" | "success" | "urgent";
  className?: string;
}) {
  const tones = {
    neutral: "bg-stone-100 text-stone-700 ring-stone-200",
    clay: "bg-clay-50 text-clay-700 ring-clay-200",
    ink: "bg-ink-50 text-ink-700 ring-ink-200",
    success: "bg-success-50 text-success-700 ring-success-500/20",
    urgent: "bg-urgent-50 text-urgent-700 ring-urgent-500/20",
  } as const;

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Advocacy positions carry a status so readers can see whether an ask moved. */
export function PositionStatus({
  status,
}: {
  status: "raised" | "under_review" | "accepted" | "resolved";
}) {
  const map = {
    raised: { label: "Raised", tone: "neutral" },
    under_review: { label: "Under review", tone: "clay" },
    accepted: { label: "Accepted", tone: "success" },
    resolved: { label: "Resolved", tone: "success" },
  } as const;

  const { label, tone } = map[status];
  return <Tag tone={tone}>{label}</Tag>;
}
