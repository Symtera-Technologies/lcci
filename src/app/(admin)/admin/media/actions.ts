"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { fail, ok, withAction } from "@/server/action";
import type { ActorContext } from "@/server/actor";
import { ContentInvalidError } from "@/content/admin";
import { registerMediaAsset, updateMediaAsset } from "@/content/media";

/**
 * The media library's actions.
 *
 * Both of them write alt text, which is the only field here that is load
 * bearing: `media_assets.alt_en` is NOT NULL and the sanitiser's allowlist has
 * no `<img>`, so every photograph on the public site is described because it
 * came through a row these two actions created.
 *
 * Validation lives in `src/content/media.ts` rather than in these schemas, for
 * the same reason the content actions delegate theirs: the rules — a path
 * under the served tree, alt text that does not open by saying "image" —
 * belong with the writes, where an import script reaches them too.
 */

const REGISTER = z.object({
  src: z.string(),
  alt_en: z.string(),
  alt_ur: z.string().optional(),
  width: z.coerce.number().int(),
  height: z.coerce.number().int(),
  caption: z.string().optional(),
  department_code: z.string().optional(),
});

const UPDATE = z.object({
  id: z.coerce.number().int().positive(),
  alt_en: z.string(),
  alt_ur: z.string().optional(),
  width: z.coerce.number().int(),
  height: z.coerce.number().int(),
  caption: z.string().optional(),
  department_code: z.string().optional(),
});

/** The field names the UI uses, so an error lands on the control it came from. */
const FIELD_NAMES: Record<string, string> = {
  altEn: "alt_en",
  altUr: "alt_ur",
  src: "src",
  width: "width",
  height: "height",
};

function asFormErrors(error: ContentInvalidError): Record<string, string> {
  const mapped: Record<string, string> = {};
  for (const [key, message] of Object.entries(error.fieldErrors)) {
    mapped[FIELD_NAMES[key] ?? key] = message;
  }
  return mapped;
}

export const registerImage = withAction(
  {
    name: "media.register",
    audience: "staff",
    permission: "content.media.manage",
    schema: REGISTER,
    rateLimit: { name: "contentSave", subject: "actor" },
  },
  async ({ input, actor }) => {
    let id: number;
    try {
      id = await registerMediaAsset(actor as ActorContext, {
        src: input.src,
        altEn: input.alt_en,
        altUr: input.alt_ur ?? null,
        width: input.width,
        height: input.height,
        caption: input.caption ?? null,
        departmentCode: input.department_code ?? null,
      });
    } catch (error) {
      if (error instanceof ContentInvalidError) return fail(error.message, asFormErrors(error));
      throw error;
    }

    redirect(`/admin/media/${id}?created=1`);
  },
);

export const describeImage = withAction(
  {
    name: "media.describe",
    audience: "staff",
    permission: "content.media.manage",
    schema: UPDATE,
    rateLimit: { name: "contentSave", subject: "actor" },
  },
  async ({ input, actor }) => {
    try {
      await updateMediaAsset(actor as ActorContext, input.id, {
        altEn: input.alt_en,
        altUr: input.alt_ur ?? null,
        width: input.width,
        height: input.height,
        caption: input.caption ?? null,
        departmentCode: input.department_code ?? null,
      });
    } catch (error) {
      if (error instanceof ContentInvalidError) return fail(error.message, asFormErrors(error));
      throw error;
    }

    // Alt text is rendered into every page using the image, so the pages have
    // to be rebuilt for a correction to reach a reader — the same reason a
    // content save revalidates.
    revalidatePath("/", "layout");
    return ok("Saved.");
  },
);
