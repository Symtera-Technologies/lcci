"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, withAction } from "@/server/action";
import { formatDate } from "@/lib/format";
import { extendCalendar, setCalendarDay } from "@/membership/calendar";

/**
 * The two things the calendar screen can do.
 *
 * Both are marked `irreversible`, which is a judgement worth stating. Neither
 * destroys a row — a day can be set back, and an extend only ever adds — but
 * both move deadlines that have already been quoted to applicants, and the
 * recompute that follows writes an audit event per file it touches. A request
 * that arrived cross-site must not be able to reprice the chamber's promises
 * even if it managed to present a session cookie, so the `SameSite=Strict`
 * sentinel check applies here exactly as it does to an approval.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date, checked for shape *and* for existence.
 *
 * `2026-02-30` passes a regex and is not a day, so the round trip through
 * `Date` is the cheap existence test: a date that does not exist does not come
 * back as itself.
 *
 * One function rather than two chained `refine`s, which is not a tidying. Zod
 * runs every refinement on the same value — a failed one does not stop the
 * next — so the second was handed whatever the first had just rejected, and
 * `new Date("T00:00:00Z").toISOString()` throws `RangeError` rather than
 * returning something false. The empty optional "notified on" field was enough
 * to turn a correct submission into "Something went wrong on our side".
 */
const civilDate = z.string().trim().refine((value) => {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}, "Enter a real date, as YYYY-MM-DD.");

const dayInput = z.object({
  date: civilDate,
  // A select rather than a checkbox: an unchecked box submits nothing, so a
  // form that failed to render its own control would read as "closed" and
  // silently stop a working day.
  working: z.enum(["working", "closed"]),
  label: z.string().trim().max(120).optional(),
  confidence: z.enum(["confirmed", "provisional"]),
  source: z.string().trim().max(160).optional(),
  notifiedOn: z.union([civilDate, z.literal("")]).optional(),
});

export const setCalendarDayAction = withAction(
  {
    name: "calendar.set_day",
    audience: "staff",
    permission: "calendar.manage",
    schema: dayInput,
    irreversible: true,
  },
  async ({ input, actor }) => {
    if (!actor) return fail("Sign in again to continue.");

    const result = await setCalendarDay(actor, {
      date: input.date,
      isWorkingDay: input.working === "working",
      label: input.label?.trim() || null,
      confidence: input.confidence,
      source: input.source?.trim() || null,
      notifiedOn: input.notifiedOn?.trim() || null,
    });

    revalidatePath("/admin/calendar");
    revalidatePath("/admin/reports/sla");

    // Through `formatDate`, like every other date on the screen. The live
    // region is read straight after the table that spells the same day out as
    // "5 November 2026", and an ISO string there reads as the machine talking
    // rather than as confirmation of what was just entered.
    const day = formatDate(input.date);
    const what =
      input.working === "working"
        ? `${day} is now a working day.`
        : `${day} is now closed.`;

    /**
     * The count is in the message because it is the consequence.
     *
     * Somebody entering a holiday is entitled to know that it just moved
     * fourteen applicants' promised dates — including, often, that it moved
     * none, which is the reassurance they were actually looking for.
     */
    if (!result.changed) {
      return ok(`${what} No promised date depends on it.`);
    }

    return ok(
      result.clocksFlagged === 0
        ? `${what} No application is running across it.`
        : `${what} ${result.clocksFlagged} promised ${
            result.clocksFlagged === 1 ? "date is" : "dates are"
          } being recomputed.`,
    );
  },
);

export const extendCalendarAction = withAction(
  {
    name: "calendar.extend",
    audience: "staff",
    permission: "calendar.manage",
    schema: z.object({
      throughYear: z.coerce.number().int().min(2026).max(2099),
    }),
    irreversible: true,
  },
  async ({ input, actor }) => {
    if (!actor) return fail("Sign in again to continue.");

    const result = await extendCalendar(actor, input.throughYear);
    revalidatePath("/admin/calendar");

    const through = formatDate(result.through);

    if (result.added === 0) {
      return ok(`The calendar already reaches ${through}.`);
    }

    return ok(
      `${result.added} days added. The calendar now reaches ${through}. ` +
        `They are Monday to Friday and marked provisional — enter the holidays as they are notified.`,
    );
  },
);
