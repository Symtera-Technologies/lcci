"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * The rich-text control.
 *
 * **The server sanitiser is the guarantee; this is only convenience.** Nothing
 * here is a security boundary — whatever this produces, and whatever somebody
 * pastes into it or types into the HTML view, goes through
 * `src/content/sanitise.ts` on the way to the column. That is what makes a
 * hand-rolled control acceptable: it cannot be the thing that gets XSS wrong,
 * because it is not the thing that decides what is stored.
 *
 * **Why not an editor library.** ProseMirror or TipTap is a few hundred
 * kilobytes and a framework of its own, for a toolbar with eight buttons over
 * a tag allowlist of twenty. This project ships to shared cPanel off a build
 * that already strains the plan's memory, and every dependency here is one
 * that has to be justified against that.
 *
 * **`document.execCommand` is deprecated and still correct here.** Every
 * browser implements it, none has announced removal, and the alternative is
 * hand-writing selection and range manipulation — which is the part that
 * actually breaks. Its one real problem is that it emits whatever each browser
 * prefers: `<b>` or `<strong>`, `<i>` or `<em>`, a `<div>` or a `<p>` per
 * line. The sanitiser maps all six, so the difference never reaches the
 * database.
 *
 * **The value is written to a hidden input, not held in React state.** A
 * controlled `contenteditable` re-renders on every keystroke and fights the
 * browser's own cursor; writing `.value` on a ref does neither. The cost is
 * that this component has no idea what is in it, which is fine — the form
 * submits the input and the server decides.
 */

const BLOCKS = [
  { command: "p", label: "Paragraph" },
  { command: "h2", label: "Heading" },
  { command: "h3", label: "Sub-heading" },
  { command: "blockquote", label: "Quotation" },
] as const;

export function RichTextField({
  name,
  label,
  hint,
  error,
  defaultValue,
}: {
  name: string;
  label: string;
  hint?: string;
  error?: string;
  defaultValue?: string | null;
}) {
  const id = useId();
  const surface = useRef<HTMLDivElement | null>(null);
  const hidden = useRef<HTMLInputElement | null>(null);
  const savedRange = useRef<Range | null>(null);
  /**
   * The HTML view's starting text, or null while the editor is showing.
   *
   * It holds the text rather than a boolean because the textarea has to be
   * seeded with what the surface currently contains — and reading that from
   * the ref during render is exactly what React warns about, since a ref is
   * not a render input and a re-render would not see a change to it. Captured
   * at the moment of the toggle instead, which is an event handler.
   */
  const [htmlView, setHtmlView] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");

  useEffect(() => {
    const node = surface.current;
    if (!node) return;
    node.innerHTML = defaultValue ?? "";
    try {
      // So Enter makes a paragraph rather than a `<div>` or a `<br>`. Not
      // supported everywhere, hence the mapping in the sanitiser; harmless
      // where it is ignored.
      document.execCommand("defaultParagraphSeparator", false, "p");
    } catch {
      // A browser that refuses the call still edits perfectly well.
    }
    // `defaultValue` is read once, on purpose: re-applying it would discard
    // whatever the editor had typed every time the form re-rendered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function sync(): void {
    if (hidden.current && surface.current) {
      hidden.current.value = surface.current.innerHTML;
    }
  }

  function run(command: string, value?: string): void {
    surface.current?.focus();
    try {
      document.execCommand(command, false, value);
    } catch {
      // Nothing to do: the surface is still editable and the editor can type.
    }
    sync();
  }

  function rememberSelection(): void {
    const selection = window.getSelection();
    savedRange.current =
      selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
  }

  function applyLink(): void {
    const url = linkUrl.trim();
    setLinkOpen(false);
    setLinkUrl("");
    if (url === "") return;

    // Only what the sanitiser will keep. Telling the editor now beats saving
    // and finding the link has quietly become plain text.
    if (!/^(https?:\/\/|\/)/i.test(url)) {
      window.alert("Links must start with https:// or with / for a page on this site.");
      return;
    }

    const selection = window.getSelection();
    if (savedRange.current && selection) {
      selection.removeAllRanges();
      selection.addRange(savedRange.current);
    }
    run("createLink", url);
  }

  /**
   * Paste, with the word processor's decoration taken off first.
   *
   * A paste from Word brings `<span style="font-family:Calibri">` around every
   * sentence and `class="MsoNormal"` on every paragraph. The sanitiser removes
   * all of it on save — but until then the editor is looking at 11pt Calibri
   * in a box that will not publish 11pt Calibri, which is a confusing place to
   * work. So the same removal happens here, on the way in.
   *
   * It is a convenience pass, not a security one, and it is deliberately only
   * the attributes: dropping tags here would make the surface disagree with
   * what the server keeps.
   */
  function onPaste(event: React.ClipboardEvent<HTMLDivElement>): void {
    const html = event.clipboardData.getData("text/html");
    if (!html) return;

    event.preventDefault();

    const holder = document.createElement("div");
    holder.innerHTML = html;
    for (const element of holder.querySelectorAll<HTMLElement>("*")) {
      for (const attribute of [...element.attributes]) {
        if (element.tagName === "A" && attribute.name === "href") continue;
        if (["COLSPAN", "ROWSPAN", "SCOPE"].includes(attribute.name.toUpperCase())) continue;
        element.removeAttribute(attribute.name);
      }
    }

    document.execCommand("insertHTML", false, holder.innerHTML);
    sync();
  }

  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span id={`${id}-label`} className="text-sm font-medium text-ink-900">
          {label}
        </span>
        <button
          type="button"
          onClick={() => {
            if (htmlView !== null) {
              setHtmlView(null);
              return;
            }
            // The surface is the newer of the two, so it is written to the
            // hidden input before the HTML view is seeded from it.
            sync();
            setHtmlView(surface.current?.innerHTML ?? "");
          }}
          className="text-[0.8125rem] text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600"
        >
          {htmlView !== null ? "Back to the editor" : "Edit the HTML"}
        </button>
      </div>

      <input ref={hidden} type="hidden" name={name} defaultValue={defaultValue ?? ""} />

      {htmlView !== null ? (
        <textarea
          aria-labelledby={`${id}-label`}
          aria-describedby={describedBy || undefined}
          defaultValue={htmlView}
          rows={14}
          spellCheck={false}
          onChange={(event) => {
            if (hidden.current) hidden.current.value = event.target.value;
            if (surface.current) surface.current.innerHTML = event.target.value;
          }}
          className={cn(
            "mt-2 w-full rounded-lg border bg-white px-3.5 py-3 font-mono text-[0.8125rem] leading-relaxed text-ink-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600",
            error ? "border-urgent-600" : "border-stone-300 focus:border-brand-500",
          )}
        />
      ) : (
        <>
          {/*
            `role="group"` and not `role="toolbar"`. A toolbar promises arrow-key
            navigation between its controls and takes them out of the tab order
            — and a toolbar that makes the promise without implementing it is
            worse for a keyboard user than no role at all, because their arrow
            keys do nothing and Tab no longer reaches the buttons either. Eleven
            individually tabbable buttons is the honest version.
          */}
          <div
            role="group"
            aria-label={`${label} formatting`}
            className="mt-2 flex flex-wrap items-center gap-1 rounded-t-lg border border-b-0 border-stone-300 bg-stone-50 px-2 py-1.5"
          >
            <ToolButton onClick={() => run("bold")} label="Bold">
              <span className="font-bold">B</span>
            </ToolButton>
            <ToolButton onClick={() => run("italic")} label="Italic">
              <span className="italic">I</span>
            </ToolButton>

            <Divider />

            <label className="sr-only" htmlFor={`${id}-block`}>
              Paragraph style
            </label>
            <select
              id={`${id}-block`}
              defaultValue=""
              onChange={(event) => {
                const value = event.target.value;
                event.currentTarget.value = "";
                if (value) run("formatBlock", value);
              }}
              className="h-8 rounded border border-stone-300 bg-white px-2 text-[0.8125rem] text-ink-800"
            >
              <option value="" disabled>
                Style…
              </option>
              {BLOCKS.map((block) => (
                <option key={block.command} value={block.command}>
                  {block.label}
                </option>
              ))}
            </select>

            <Divider />

            <ToolButton onClick={() => run("insertUnorderedList")} label="Bulleted list">
              ••
            </ToolButton>
            <ToolButton onClick={() => run("insertOrderedList")} label="Numbered list">
              1.
            </ToolButton>

            <Divider />

            <ToolButton
              onClick={() => {
                rememberSelection();
                setLinkOpen(true);
              }}
              label="Add a link"
            >
              Link
            </ToolButton>
            <ToolButton onClick={() => run("unlink")} label="Remove the link">
              Unlink
            </ToolButton>
            <ToolButton onClick={() => run("removeFormat")} label="Clear formatting">
              Clear
            </ToolButton>
          </div>

          {linkOpen && (
            <div className="flex flex-wrap items-end gap-2 border-x border-stone-300 bg-stone-50 px-2 pb-2">
              <label className="flex flex-col gap-1">
                <span className="text-[0.75rem] font-medium text-ink-700">Address</span>
                <input
                  type="text"
                  value={linkUrl}
                  autoFocus
                  onChange={(event) => setLinkUrl(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      applyLink();
                    }
                    if (event.key === "Escape") setLinkOpen(false);
                  }}
                  placeholder="https://… or /news/circulars"
                  className="h-9 w-72 rounded border border-stone-300 bg-white px-2 text-[0.8125rem] text-ink-900"
                />
              </label>
              <button
                type="button"
                onClick={applyLink}
                className="h-9 rounded border border-ink-300 bg-white px-3 text-[0.8125rem] font-medium text-ink-800 hover:border-ink-500"
              >
                Add
              </button>
            </div>
          )}

          <div
            id={`${id}-surface`}
            ref={surface}
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            aria-labelledby={`${id}-label`}
            aria-describedby={describedBy || undefined}
            aria-invalid={error ? true : undefined}
            onInput={sync}
            onBlur={sync}
            onPaste={onPaste}
            className={cn(
              "prose-editor min-h-48 w-full rounded-b-lg border bg-white px-3.5 py-3 text-[0.9375rem] leading-relaxed text-ink-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-inset",
              error ? "border-urgent-600" : "border-stone-300 focus:border-brand-500",
            )}
          />
        </>
      )}

      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1.5 text-[0.8125rem] leading-snug text-stone-600">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="mt-1.5 text-[0.8125rem] leading-snug text-urgent-700">
          {error}
        </p>
      )}
    </div>
  );
}

function ToolButton({
  onClick,
  label,
  children,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      // `h-8 w-8` and not a touch-sized target: this is a staff-only desktop
      // screen, and a 44px grid of eleven buttons would push the writing
      // surface below the fold on the laptops the secretariat actually uses.
      className="flex h-8 min-w-8 items-center justify-center rounded border border-transparent px-1.5 text-[0.8125rem] text-ink-800 hover:border-stone-300 hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span aria-hidden className="mx-1 h-5 w-px bg-stone-300" />;
}
