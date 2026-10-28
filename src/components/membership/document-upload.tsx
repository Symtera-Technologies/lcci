"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Paperclip, Upload } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * One upload slot.
 *
 * The file goes straight to `/api/portal/uploads` as a raw body with its
 * metadata in headers, not through a server action and not as `FormData`. Both
 * of those buffer the whole file in memory before any of our code runs, and
 * `serverActions.bodySizeLimit` is global — raising it for this form would
 * raise it for the unauthenticated newsletter form on the homepage too. The
 * route streams to disk a chunk at a time, so an 8 MB scan of a CNIC costs one
 * chunk of memory instead of eight megabytes of it.
 *
 * What comes back is an opaque document id. The step's own form carries ids,
 * never bytes.
 */

export interface UploadedDocument {
  readonly id: string;
  readonly filename: string;
  readonly byteSize: number;
  readonly reviewState: string;
}

export interface UploadSlotProps {
  readonly applicationId: number;
  readonly documentTypeCode: string;
  readonly label: string;
  readonly note?: string | null;
  readonly subjectKind: "company" | "representative" | "director" | "endorser" | "payment";
  readonly subjectId?: number | null;
  /** Who or what this slot is for, when one type needs several files. */
  readonly subjectLabel?: string;
  readonly existing: readonly UploadedDocument[];
}

const ACCEPT = "application/pdf,image/jpeg,image/png,image/webp";
const MAX_BYTES = 8 * 1024 * 1024;

export function UploadSlot(props: UploadSlotProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setError(null);

    // Checked here as a courtesy, and again on the server as the rule. A
    // browser-side size check saves someone on a mobile connection from
    // uploading eight megabytes to be told no; it is not what enforces the
    // limit, because nothing the browser says about a file is trustworthy.
    if (file.size > MAX_BYTES) {
      setError("That file is larger than 8 MB. Please upload a smaller scan.");
      return;
    }

    setBusy(true);

    try {
      const response = await fetch("/api/portal/uploads", {
        method: "POST",
        body: file,
        headers: {
          "content-type": file.type || "application/octet-stream",
          "x-application-id": String(props.applicationId),
          "x-document-type": props.documentTypeCode,
          "x-subject-kind": props.subjectKind,
          ...(props.subjectId ? { "x-subject-id": String(props.subjectId) } : {}),
          // Percent-encoded: a header is Latin-1, and a Pakistani firm's
          // filename very often is not.
          "x-filename": encodeURIComponent(file.name),
        },
      });

      const body = (await response.json()) as { ok?: boolean; error?: string };

      if (!response.ok || !body.ok) {
        setError(body.error ?? "That file could not be accepted.");
        return;
      }

      if (inputRef.current) inputRef.current.value = "";
      router.refresh();
    } catch {
      setError("The upload did not complete. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const inputId = `upload-${props.documentTypeCode}-${props.subjectId ?? "company"}`;

  return (
    <div className="rounded-xl border border-stone-200 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink-950">
            {props.label}
            {props.subjectLabel && (
              <span className="font-normal text-stone-600"> — {props.subjectLabel}</span>
            )}
          </p>
          {props.note && (
            <p className="mt-1 max-w-prose text-[0.8125rem] leading-snug text-stone-600">
              {props.note}
            </p>
          )}
        </div>

        <label
          htmlFor={inputId}
          className={cn(
            "inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-2 rounded-lg border border-stone-300 px-4 text-[0.875rem] font-medium text-ink-900 hover:border-brand-500 focus-within:ring-2 focus-within:ring-brand-600",
            busy && "pointer-events-none opacity-60",
          )}
        >
          {busy ? (
            <>Uploading…</>
          ) : (
            <>
              <Upload className="h-4 w-4" aria-hidden />
              {props.existing.length > 0 ? "Replace" : "Choose file"}
            </>
          )}
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept={ACCEPT}
            disabled={busy}
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
        </label>
      </div>

      {props.existing.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {props.existing.map((document) => (
            <li key={document.id} className="flex items-center gap-2 text-[0.8125rem]">
              <FileText className="h-4 w-4 shrink-0 text-stone-500" aria-hidden />
              <a
                href={`/api/documents/${document.id}`}
                className="truncate font-medium text-brand-800 underline underline-offset-2 hover:text-brand-700"
              >
                {document.filename}
              </a>
              <span className="shrink-0 text-stone-500">{formatBytes(document.byteSize)}</span>
            </li>
          ))}
        </ul>
      )}

      {props.existing.length === 0 && !error && (
        <p className="mt-3 flex items-center gap-2 text-[0.8125rem] text-stone-600">
          <Paperclip className="h-4 w-4" aria-hidden />
          PDF, JPEG, PNG or WebP, up to 8 MB.
        </p>
      )}

      {error && (
        <p role="alert" className="mt-3 text-[0.8125rem] text-urgent-700">
          {error}
        </p>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
