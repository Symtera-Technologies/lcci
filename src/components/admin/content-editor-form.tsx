"use client";

import { useActionState } from "react";
import Link from "next/link";
import { IDLE, type ActionState } from "@/lib/action-state";
import { ContentField, type MediaOption } from "@/components/admin/content-fields";
import type { FieldSpec } from "@/content/fields";
import type { ContentKind, ContentStatus } from "@/db/schema";

type Action = (prev: ActionState, formData: FormData) => Promise<ActionState>;

export interface EditorChrome {
  readonly kind: ContentKind;
  readonly singular: string;
  readonly plural: string;
  readonly hasTopics: boolean;
}

/**
 * The content editor.
 *
 * **One form, split in two.** The fields that *are* the item come first; the
 * ones that decide where it sits and how it is found come after, under their
 * own heading. The split is not decoration — it is the difference between
 * writing a press release and filing one, and putting the SEO description
 * above the body is how an editor learns to scroll past the part of the screen
 * that matters.
 *
 * **Uncontrolled inputs throughout.** Fifty fields re-rendering on every
 * keystroke is a form that feels broken on the laptops the secretariat uses,
 * and there is nothing here that needs to know a value as it is typed. The
 * server has the only copy that counts.
 *
 * **No autosave, deliberately.** The applicant's wizard has it because a
 * sixty-field form filled in over several sittings on a phone cannot be
 * retyped. This is a staff screen with a Save button two centimetres away, and
 * autosave on published content would mean half-written corrections going live
 * as they are typed. The form does warn before a navigation that would lose
 * work.
 */
export function ContentEditorForm({
  chrome,
  fields,
  parentFields,
  values,
  errors: initialErrors,
  departments,
  media,
  topics,
  selectedTopics,
  item,
  action,
}: {
  chrome: EditorChrome;
  fields: readonly FieldSpec[];
  parentFields: readonly FieldSpec[];
  values: Record<string, string | boolean>;
  errors?: Record<string, string>;
  departments: readonly { code: string; nameEn: string }[];
  media: readonly MediaOption[];
  topics: readonly { slug: string; label: string }[];
  selectedTopics: readonly string[];
  item: { id: number; version: number; status: ContentStatus } | null;
  action: Action;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const errors = state.fieldErrors ?? initialErrors ?? {};

  return (
    <form action={formAction} className="mt-8">
      <input type="hidden" name="content_type" value={chrome.kind} />
      {item && (
        <>
          <input type="hidden" name="id" value={item.id} />
          {/*
            The version the form was rendered from. The server refuses the save
            if the row has moved on, which is the whole of the concurrency
            story: two editors with the same release open is the ordinary case
            in a secretariat, and last-write-wins discards somebody's work
            without telling either of them.
          */}
          <input type="hidden" name="version" value={item.version} />
        </>
      )}

      {/*
        One live region for the whole form. `role="status"` rather than
        `role="alert"`: a save result is not an interruption, and an assertive
        region would cut across whatever the editor is reading.
      */}
      <p role="status" aria-live="polite" className="sr-only">
        {pending ? "Saving" : (state.message ?? "")}
      </p>

      {state.status === "error" && state.message && (
        <p className="mb-6 rounded-lg border border-urgent-600/50 bg-urgent-50 px-4 py-3 text-[0.9375rem] text-urgent-800">
          {state.message}
        </p>
      )}

      {state.status === "ok" && state.message && (
        <p className="mb-6 rounded-lg border border-success-700/40 bg-success-50 px-4 py-3 text-[0.9375rem] text-success-900">
          {state.message} The public pages have been rebuilt.
        </p>
      )}

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section aria-labelledby="the-item" className="min-w-0">
          <h2 id="the-item" className="text-[1.0625rem] font-semibold text-ink-950">
            The {chrome.singular.toLowerCase()}
          </h2>

          <div className="mt-4 space-y-5">
            {fields.map((field) => (
              <ContentField
                key={field.name}
                field={field}
                value={values[field.name]}
                error={errors[field.name]}
                departments={departments}
                media={media}
              />
            ))}
          </div>
        </section>

        <aside aria-labelledby="filing" className="min-w-0">
          <h2 id="filing" className="text-[1.0625rem] font-semibold text-ink-950">
            Filing
          </h2>

          <div className="mt-4 space-y-5">
            {parentFields.map((field) => (
              <ContentField
                key={field.name}
                field={field}
                value={values[field.name]}
                error={errors[field.name]}
                departments={departments}
                media={media}
              />
            ))}

            {chrome.hasTopics && (
              <fieldset>
                <legend className="text-sm font-medium text-ink-900">Topics</legend>
                <p className="mt-1 text-[0.8125rem] leading-snug text-stone-600">
                  How a reader finds related items. Pick every one that applies.
                </p>
                {errors.topics && (
                  <p className="mt-1 text-[0.8125rem] text-urgent-700">{errors.topics}</p>
                )}
                <div className="mt-2 space-y-1.5">
                  {topics.map((topic) => (
                    <label key={topic.slug} className="flex items-start gap-2.5">
                      <input
                        type="checkbox"
                        name="topics"
                        value={topic.slug}
                        defaultChecked={selectedTopics.includes(topic.slug)}
                        className="mt-0.5 size-4.5 rounded border-stone-400 text-brand-800 focus-visible:ring-2 focus-visible:ring-brand-600"
                      />
                      <span className="text-[0.875rem] text-ink-800">{topic.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
          </div>
        </aside>
      </div>

      <div className="mt-10 flex flex-wrap items-center gap-4 border-t border-stone-200 pt-6">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-brand-800 px-5 py-2.5 text-[0.9375rem] font-medium text-white hover:bg-brand-900 disabled:opacity-60"
        >
          {pending ? "Saving…" : item ? "Save" : `Create ${chrome.singular.toLowerCase()}`}
        </button>

        <Link
          href={`/admin/content/${chrome.kind}`}
          className="text-[0.9375rem] text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600"
        >
          Back to {chrome.plural.toLowerCase()}
        </Link>

        {!item && (
          <p className="text-[0.875rem] text-ink-600">
            It will be created as a draft. Nothing is public until it is published.
          </p>
        )}
      </div>
    </form>
  );
}
