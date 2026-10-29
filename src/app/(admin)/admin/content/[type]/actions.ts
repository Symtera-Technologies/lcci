"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { fail, ok, withAction } from "@/server/action";
import { formDataToObject } from "@/server/action";
import type { ActorContext } from "@/server/actor";
import {
  ContentInvalidError,
  createContentItem,
  deleteDraftContentItem,
  updateContentItem,
} from "@/content/admin";
import { transitionContentItem } from "@/content/transitions";
import { isContentTransitionCode } from "@/content/workflow";
import { isContentKind } from "@/content/fields";
import type { ContentKind } from "@/db/schema";

/**
 * The content editor's actions.
 *
 * **The wrapper's schema only validates the routing.** `withAction` takes one
 * static schema, and the shape of a content form depends on which of twelve
 * types is being saved — so the schema here checks the three fields that
 * decide *where* the write goes, and the field values are validated by
 * `contentFormSchema(kind)` inside `createContentItem` and
 * `updateContentItem`. That is the right place for them: those functions are
 * also reachable from a future import script and a CLI, and validation that
 * lives in the action is validation those callers skip.
 *
 * **Field errors come back as a value, not an exception.** `ContentInvalidError`
 * carries a message per field, which is the whole point of catching it here:
 * a sixty-field form that answers "could not save" makes the editor hunt.
 */

const ROUTING = z.object({
  content_type: z.string().refine(isContentKind, "Unknown content type."),
  /** Absent when creating. */
  id: z.coerce.number().int().positive().optional(),
  /** The version the form was rendered from. Absent when creating. */
  version: z.coerce.number().int().positive().optional(),
});

export const saveContent = withAction(
  {
    name: "content.save",
    audience: "staff",
    // `content.edit`, not `content.create`: this one action serves both, and
    // the narrower grant is checked inside whichever of the two write
    // functions actually runs. A department editor holds both.
    permission: "content.edit",
    schema: ROUTING,
    rateLimit: { name: "contentSave", subject: "actor" },
  },
  async ({ input, actor, formData }) => {
    const kind = input.content_type as ContentKind;
    const values = formDataToObject(formData);

    try {
      if (input.id === undefined) {
        const saved = await createContentItem(actor as ActorContext, kind, values);
        revalidate();
        // Straight to the editor for the row that now exists, so the next save
        // is an update rather than a second create. Returning ok() instead
        // would leave a form that creates a duplicate every time it is saved.
        redirect(`/admin/content/${kind}/${saved.id}?created=1`);
      }

      if (input.version === undefined) {
        return fail("This form is out of date. Reload the page and try again.");
      }

      await updateContentItem(actor as ActorContext, kind, input.id, input.version, values);
      revalidate();
      return ok("Saved.");
    } catch (error) {
      if (error instanceof ContentInvalidError) {
        return fail(error.message, error.fieldErrors);
      }
      throw error;
    }
  },
);

export const deleteContent = withAction(
  {
    name: "content.delete",
    audience: "staff",
    permission: "content.edit",
    schema: ROUTING,
    // Deletion cannot be undone, so the `SameSite=Strict` sentinel is required
    // on top of the Origin check. It only ever applies to a draft that was
    // never published — see `deleteDraftContentItem`.
    irreversible: true,
    rateLimit: { name: "contentSave", subject: "actor" },
  },
  async ({ input, actor }) => {
    const kind = input.content_type as ContentKind;
    if (input.id === undefined) return fail("Nothing to delete.");

    try {
      await deleteDraftContentItem(actor as ActorContext, kind, input.id);
    } catch (error) {
      if (error instanceof ContentInvalidError) {
        return fail(error.message, error.fieldErrors);
      }
      throw error;
    }

    revalidate();
    redirect(`/admin/content/${kind}?deleted=1`);
  },
);

/**
 * Move an item between statuses.
 *
 * **The declared permission is the floor, not the rule.** `withAction` takes
 * one static permission and the real one depends on which move is asked for —
 * `content.submit_review` to send a draft on, `content.publish` to publish it,
 * `content.archive` to file it away. So the wrapper checks the permission every
 * content role holds, and `transitionContentItem` checks the one this
 * particular move needs, against the status it reads inside the transaction.
 * Deciding here would mean deciding from a status the form carried, which is
 * whatever it was when the page was rendered.
 *
 * **Irreversible, all six of them.** Publishing puts text on a public website,
 * and taking it down again does not unsend it to whoever was reading. That is
 * enough to want the `SameSite=Strict` sentinel on the request, so a
 * cross-site POST cannot publish an embargoed press release early.
 */

const TRANSITION = ROUTING.extend({
  code: z.string().refine(isContentTransitionCode, "Unknown action."),
  /** Only read for `return_to_draft`; see `cleanNote`. */
  note: z.string().max(4000).optional(),
});

export const transitionContent = withAction(
  {
    name: "content.transition",
    audience: "staff",
    permission: "content.read_draft",
    schema: TRANSITION,
    irreversible: true,
    rateLimit: { name: "contentSave", subject: "actor" },
  },
  async ({ input, actor }) => {
    const kind = input.content_type as ContentKind;

    if (input.id === undefined || input.version === undefined) {
      return fail("This form is out of date. Reload the page and try again.");
    }

    try {
      const moved = await transitionContentItem(
        actor as ActorContext,
        kind,
        input.id,
        input.version,
        input.code,
        input.note,
      );
      revalidate();
      return ok(CONFIRMATION[moved.status]);
    } catch (error) {
      if (error instanceof ContentInvalidError) {
        return fail(error.message, error.fieldErrors);
      }
      throw error;
    }
  },
);

/**
 * What the editor is told, in terms of what a visitor can now see.
 *
 * Keyed on where the item landed rather than on the move, because that is the
 * question being answered: "is this on the site?". "Published." on its own
 * invites the reasonable assumption that the page has changed, which it has
 * not until the scheduled instant passes and the cache is rebuilt.
 */
const CONFIRMATION: Record<string, string> = {
  draft: "Back to draft. It is not on the public site.",
  in_review: "Submitted for review. It is not on the public site.",
  published: "Published. It is live on the public site.",
  archived: "Archived. It is off every list, and its own page still resolves.",
};

/**
 * Rebuild the public pages this change could have affected.
 *
 * Broad on purpose. The public site is statically generated — there is no
 * `revalidate` on any page and no dynamic API in the read path, so a page is
 * built once and served from disk until something invalidates it. The
 * homepage alone renders ten of the twelve content types, so a map from type
 * to path would be more code than `"/"` with the layout flag and would be
 * wrong the first time a band moves.
 *
 * Without this an editor publishes a correction and the site keeps showing the
 * old text until the next deploy, which reads as the CMS not working. The
 * scheduled half of the problem — an item that becomes live at a future
 * instant with nobody pressing anything — is B4's, and needs the cron tick
 * this cannot substitute for.
 */
function revalidate(): void {
  revalidatePath("/", "layout");
}
