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
