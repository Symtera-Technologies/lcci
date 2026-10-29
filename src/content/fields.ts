import { z } from "zod";
import type { ContentKind } from "@/db/schema";

/**
 * What each content type is made of, declared once.
 *
 * Twelve types, around fifty fields between them. Hand-writing twelve editors
 * would mean twelve zod schemas, twelve forms and twelve save handlers that
 * drift apart the first time somebody adds a column to one of them — and the
 * drift is silent, because a field missing from a form is a field that simply
 * stops being editable.
 *
 * So the shape is data and the editor is one screen. The cost is a small
 * amount of machinery; the thing that keeps it from becoming a framework is
 * that it describes *this* schema and nothing else. There is no plugin point,
 * no runtime registration, and no way for a field to exist that is not written
 * here in TypeScript — which matters for more than tidiness, because the save
 * handler builds its `INSERT` column list from `name` and from nothing else.
 * A column name can therefore never arrive from a request.
 *
 * `title_en` is not in any field list: it is on the parent row, and
 * `titleLabel` says what it is called for each type, because for a committee
 * it is the name, for a service tile the label, and for a testimonial an admin
 * label that no visitor sees.
 */

export type FieldKind =
  | "text"
  | "slug"
  | "textarea"
  | "richtext"
  | "url"
  | "integer"
  | "decimal"
  | "date"
  | "datetime"
  | "select"
  | "checkbox"
  | "media"
  | "department";

export interface FieldOption {
  readonly value: string;
  readonly label: string;
}

export interface FieldSpec {
  /** The satellite column. Also the form control's name. */
  readonly name: string;
  readonly label: string;
  readonly kind: FieldKind;
  readonly required?: boolean;
  /** Characters, for the text kinds; matches the column's VARCHAR width. */
  readonly max?: number;
  readonly min?: number;
  readonly options?: readonly FieldOption[];
  /** Shown under the control. Written for the person filling it in. */
  readonly help?: string;
}

export interface ContentForm {
  readonly kind: ContentKind;
  readonly plural: string;
  readonly singular: string;
  /** The satellite table. Narrowed to the real union at the call site. */
  readonly table: string;
  /** What `content_items.title_en` is called on this type's screen. */
  readonly titleLabel: string;
  readonly titleHelp?: string;
  /** Whether this type carries topic tags. */
  readonly hasTopics: boolean;
  /**
   * Whether the type has a public URL, and so SEO fields worth filling in.
   *
   * A key figure is a number in a band on the homepage; giving it a meta
   * description would be inviting somebody to write one that no page will ever
   * use.
   */
  readonly hasSeo: boolean;
  /**
   * Whether the publication date is editorially meaningful rather than
   * mechanical.
   *
   * It governs visibility on every type — that is the live predicate — but on
   * a press release it is also the date printed on the page, and on a
   * committee it is only the day somebody added the row. The editor says so
   * rather than presenting both the same way.
   */
  readonly datedPublicly: boolean;
  /**
   * Whether a public read of this type orders by `sort_order`.
   *
   * It is on every row because the column is on the parent, but it only
   * governs the eight types whose getters order by it. Offering the control
   * on a press release would invite an editor to set it and then wonder why
   * the newsroom ignored them.
   */
  readonly hasSortOrder: boolean;
  readonly fields: readonly FieldSpec[];
}

const BODY_FIELDS: readonly FieldSpec[] = [
  {
    name: "body_en",
    label: "Body",
    kind: "richtext",
    help: "Headings, lists, links and tables. Anything else is removed when you save.",
  },
  {
    name: "body_ur",
    label: "Body (Urdu)",
    kind: "richtext",
    help: "Optional. Stored now so the Urdu site is a translation task rather than a rebuild.",
  },
];

export const CONTENT_FORMS: Record<ContentKind, ContentForm> = {
  press_release: {
    kind: "press_release",
    plural: "Press releases",
    singular: "Press release",
    table: "content_press_releases",
    titleLabel: "Headline",
    hasTopics: true,
    hasSeo: true,
    datedPublicly: true,
    hasSortOrder: false,
    fields: [
      {
        name: "summary",
        label: "Summary",
        kind: "textarea",
        required: true,
        max: 700,
        help: "One or two sentences. This is what shows on the homepage and in the newsroom list.",
      },
      ...BODY_FIELDS,
      {
        name: "hero_image_id",
        label: "Photograph",
        kind: "media",
        help: "Optional. Its alt text travels with the image, so it does not need writing again here.",
      },
      {
        name: "spokesperson",
        label: "Quoted",
        kind: "text",
        max: 200,
        help: "Name and office of whoever is quoted, as it should read: \"Abdul Aleem Khan, Federal Minister for Communications\".",
      },
    ],
  },

  event: {
    kind: "event",
    plural: "Events",
    singular: "Event",
    table: "content_events",
    titleLabel: "Title",
    hasTopics: false,
    hasSeo: true,
    datedPublicly: true,
    hasSortOrder: false,
    fields: [
      {
        name: "event_type",
        label: "Kind",
        kind: "select",
        required: true,
        options: [
          { value: "seminar", label: "Seminar" },
          { value: "training", label: "Training" },
          { value: "agm", label: "Annual General Meeting" },
          { value: "delegation", label: "Delegation" },
          { value: "exhibition", label: "Exhibition" },
        ],
      },
      { name: "starts_at", label: "Starts", kind: "datetime", required: true },
      {
        name: "ends_at",
        label: "Ends",
        kind: "datetime",
        help: "Leave empty for a single session. A multi-day event shows as a range.",
      },
      { name: "venue", label: "Venue", kind: "text", required: true, max: 300 },
      ...BODY_FIELDS,
      {
        name: "fee",
        label: "Fee",
        kind: "text",
        max: 160,
        help: "As it should read — \"Free for members\", \"PKR 185,000\". Online booking is a later change and will take an amount.",
      },
      { name: "capacity", label: "Places", kind: "integer", min: 0 },
      {
        name: "registration_open",
        label: "Booking is open",
        kind: "checkbox",
        help: "Unticked hides the booking button. The event still shows.",
      },
      { name: "registration_deadline", label: "Booking closes", kind: "datetime" },
    ],
  },

  policy_position: {
    kind: "policy_position",
    plural: "Policy positions",
    singular: "Policy position",
    table: "content_policy_positions",
    titleLabel: "Title",
    hasTopics: true,
    hasSeo: true,
    datedPublicly: true,
    hasSortOrder: true,
    fields: [
      {
        name: "issue",
        label: "The issue",
        kind: "textarea",
        required: true,
        max: 500,
        help: "What the problem is, in the members' terms.",
      },
      {
        name: "chamber_ask",
        label: "What the chamber is asking for",
        kind: "textarea",
        required: true,
        max: 900,
        help: "The specific ask. A position without one is a complaint.",
      },
      ...BODY_FIELDS,
      {
        name: "position_status",
        label: "Where it stands",
        kind: "select",
        required: true,
        options: [
          { value: "raised", label: "Raised" },
          { value: "under_review", label: "Under review" },
          { value: "accepted", label: "Accepted" },
          { value: "resolved", label: "Resolved" },
        ],
        help: "Where the ask has got to with government. Separate from whether this page is published.",
      },
    ],
  },

  notice: {
    kind: "notice",
    plural: "Notices",
    singular: "Notice",
    table: "content_notices",
    titleLabel: "Name",
    titleHelp: "For this list only. Visitors see the message, not this.",
    hasTopics: false,
    hasSeo: false,
    datedPublicly: false,
    hasSortOrder: true,
    fields: [
      {
        name: "message_en",
        label: "Message",
        kind: "textarea",
        required: true,
        max: 600,
        help: "One sentence. It runs across the top of every page.",
      },
      { name: "message_ur", label: "Message (Urdu)", kind: "textarea", max: 900 },
      {
        name: "href",
        label: "Link",
        kind: "url",
        max: 400,
        help: "Optional. Adds a \"Read more\" link to the strip.",
      },
      {
        name: "level",
        label: "Level",
        kind: "select",
        required: true,
        options: [
          { value: "info", label: "Information" },
          { value: "urgent", label: "Urgent" },
        ],
        help: "Urgent outranks information: only one notice shows at a time.",
      },
      { name: "starts_at", label: "Shows from", kind: "datetime", required: true },
      {
        name: "ends_at",
        label: "Stops showing",
        kind: "datetime",
        required: true,
        help: "Required, and not negotiable. The old site left notices up for months because nothing made anybody set this.",
      },
    ],
  },

  key_figure: {
    kind: "key_figure",
    plural: "Key figures",
    singular: "Key figure",
    table: "content_key_figures",
    titleLabel: "Label",
    hasTopics: false,
    hasSeo: false,
    datedPublicly: false,
    hasSortOrder: true,
    fields: [
      {
        name: "figure_value",
        label: "Number",
        kind: "integer",
        required: true,
        help: "Digits only. The counter animates up to it.",
      },
      {
        name: "suffix",
        label: "Suffix",
        kind: "text",
        max: 8,
        help: "Shown after the number: \"+\", \"k+\".",
      },
      {
        name: "verified_at",
        label: "Verified on",
        kind: "date",
        required: true,
        help: "Printed under the band as \"Figures verified …\". It is the claim that keeps these honest, so change it only when you have checked the number.",
      },
    ],
  },

  economic_indicator: {
    kind: "economic_indicator",
    plural: "Economic indicators",
    singular: "Economic indicator",
    table: "content_economic_indicators",
    titleLabel: "Label",
    hasTopics: false,
    hasSeo: false,
    datedPublicly: false,
    hasSortOrder: true,
    fields: [
      {
        name: "display_value",
        label: "Value",
        kind: "text",
        required: true,
        max: 60,
        help: "With its unit, as the source quotes it: \"$9.4bn\", \"11.0%\".",
      },
      {
        name: "change_pct",
        label: "Change",
        kind: "decimal",
        help: "Percentage points, signed. Leave empty if there is nothing to compare with.",
      },
      {
        name: "good_when",
        label: "Good news when it",
        kind: "select",
        required: true,
        options: [
          { value: "up", label: "Goes up" },
          { value: "down", label: "Goes down" },
          { value: "neutral", label: "Neither" },
        ],
        help: "Decides the colour. Inflation falling and exports rising are both green.",
      },
      { name: "source", label: "Source", kind: "text", required: true, max: 200 },
      {
        name: "measured_at",
        label: "Figure is current to",
        kind: "date",
        required: true,
        help: "The date the source published it — not today. It shows on the ticker as \"checked …\".",
      },
    ],
  },

  service_tile: {
    kind: "service_tile",
    plural: "Service tiles",
    singular: "Service tile",
    table: "content_service_tiles",
    titleLabel: "Label",
    hasTopics: false,
    hasSeo: false,
    datedPublicly: false,
    hasSortOrder: true,
    fields: [
      { name: "description", label: "Description", kind: "textarea", required: true, max: 600 },
      {
        name: "href",
        label: "Link",
        kind: "text",
        required: true,
        max: 300,
        help: "A path on this site, such as /membership/renew.",
      },
      {
        name: "icon",
        label: "Icon",
        kind: "select",
        required: true,
        options: [
          { value: "renew", label: "Renew" },
          { value: "certificate", label: "Certificate" },
          { value: "attestation", label: "Attestation" },
          { value: "circular", label: "Circular" },
          { value: "directory", label: "Directory" },
        ],
        help: "One of five drawn icons. There is no sixth without a code change, which is deliberate: a name that is not on this list would render nothing at all.",
      },
    ],
  },

  committee: {
    kind: "committee",
    plural: "Committees",
    singular: "Committee",
    table: "content_committees",
    titleLabel: "Name",
    hasTopics: false,
    hasSeo: true,
    datedPublicly: false,
    hasSortOrder: true,
    fields: [
      { name: "mandate", label: "Mandate", kind: "textarea", required: true, max: 700 },
      { name: "member_count", label: "Members", kind: "integer", required: true, min: 0 },
    ],
  },

  partner: {
    kind: "partner",
    plural: "Partners",
    singular: "Partner",
    table: "content_partners",
    titleLabel: "Name",
    hasTopics: false,
    hasSeo: false,
    datedPublicly: false,
    hasSortOrder: true,
    fields: [
      {
        name: "tier",
        label: "Tier",
        kind: "select",
        required: true,
        options: [
          { value: "strategic", label: "Strategic" },
          { value: "gold", label: "Gold" },
          { value: "silver", label: "Silver" },
        ],
      },
      {
        name: "logo_id",
        label: "Logo",
        kind: "media",
        help: "Optional. Without one the name is typeset, which is better than a broken image.",
      },
    ],
  },

  testimonial: {
    kind: "testimonial",
    plural: "Testimonials",
    singular: "Testimonial",
    table: "content_testimonials",
    titleLabel: "Admin label",
    titleHelp: "For this list only — the name and firm is usually enough to find it.",
    hasTopics: false,
    hasSeo: false,
    datedPublicly: false,
    hasSortOrder: true,
    fields: [
      { name: "quote", label: "Quote", kind: "textarea", required: true, max: 900 },
      { name: "author_name", label: "Name", kind: "text", required: true, max: 200 },
      { name: "author_role", label: "Role", kind: "text", required: true, max: 200 },
      { name: "company", label: "Firm", kind: "text", required: true, max: 250 },
    ],
  },

  video: {
    kind: "video",
    plural: "Videos",
    singular: "Video",
    table: "content_videos",
    titleLabel: "Title",
    hasTopics: false,
    hasSeo: false,
    datedPublicly: true,
    hasSortOrder: false,
    fields: [
      {
        name: "youtube_id",
        label: "YouTube id",
        kind: "text",
        required: true,
        max: 24,
        help: "The id alone, not the whole address: the part after watch?v=.",
      },
      {
        name: "orientation",
        label: "Shape",
        kind: "select",
        required: true,
        options: [
          { value: "landscape", label: "Landscape" },
          { value: "portrait", label: "Portrait (a Short)" },
        ],
        help: "Shorts are framed differently. Setting this wrong shows a cropped subject inside blurred bars.",
      },
      {
        name: "poster_id",
        label: "Poster",
        kind: "media",
        required: true,
        help: "Required, and served from this site. Nothing is requested from Google until a visitor presses play.",
      },
      {
        name: "description",
        label: "Standfirst",
        kind: "textarea",
        max: 900,
        help: "Only the feature film carries one — whichever video has a standfirst is given the large frame.",
      },
    ],
  },

  gallery_album: {
    kind: "gallery_album",
    plural: "Photo albums",
    singular: "Photo album",
    table: "content_gallery_albums",
    titleLabel: "Title",
    hasTopics: false,
    hasSeo: false,
    datedPublicly: false,
    hasSortOrder: false,
    fields: [
      { name: "description", label: "Standfirst", kind: "textarea", required: true, max: 900 },
      {
        name: "occurred_at",
        label: "Photographed on",
        kind: "datetime",
        required: true,
        help: "When the photographs were taken, which is not when you publish them.",
      },
    ],
  },
};

export const CONTENT_KINDS = Object.keys(CONTENT_FORMS) as ContentKind[];

export function isContentKind(value: string): value is ContentKind {
  return Object.prototype.hasOwnProperty.call(CONTENT_FORMS, value);
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A URL slug: lowercase, digits, single hyphens, no leading or trailing one.
 *
 * Checked rather than silently rewritten, because the slug is the public
 * address. An editor who types `Budget Proposal 2027` and gets
 * `budget-proposal-2027` back without being told has had a URL chosen for
 * them; worse, somebody correcting a typo in a slug that is already published
 * breaks every link to it. `slugify` exists to *suggest* one from the title,
 * and the editor confirms it.
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const SLUG = z
  .string()
  .trim()
  .min(1, "Required.")
  .max(160)
  .refine(
    (value) => SLUG_PATTERN.test(value),
    "Lowercase letters, numbers and single hyphens only.",
  );

/** A suggested slug from a title. Only ever a suggestion. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    // Strip combining marks, so "Ålesund" becomes "alesund" rather than losing
    // the letter entirely to the non-alphanumeric pass below.
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160)
    .replace(/-+$/g, "");
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A civil date, checked for shape *and* existence.
 *
 * `2026-02-30` passes a regex and is not a day. One `refine` rather than two
 * chained ones, because zod runs every refinement on the same value — a failed
 * one does not stop the next — so a second would be handed what the first had
 * just rejected.
 */
const civilDate = z
  .string()
  .trim()
  .refine((value) => {
    if (!ISO_DATE.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Enter a real date, as YYYY-MM-DD.");

/**
 * A local instant from `<input type="datetime-local">`, read as Pakistani time.
 *
 * The control submits `2026-11-06T10:00` with no zone, and the person typing
 * it means ten in the morning in Lahore. Parsing it as UTC would store every
 * event five hours early and print the wrong time on the site — so the offset
 * is applied here rather than left to the server's locale, which on a shared
 * host is whatever the host decided.
 *
 * `+05:00` is a constant because Pakistan has not observed daylight saving
 * since 2009. If that changes this becomes a lookup, and the fact that it is
 * written here in one place is what makes that a one-line change.
 */
const PAKISTAN_OFFSET = "+05:00";

const localInstant = z
  .string()
  .trim()
  .refine((value) => !Number.isNaN(instantFromLocal(value)?.getTime() ?? NaN), {
    message: "Enter a date and time.",
  });

export function instantFromLocal(value: string): Date | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  // `datetime-local` omits seconds when they are zero.
  const normalised = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(trimmed)
    ? `${trimmed}:00`
    : trimmed;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(normalised)) return null;
  const parsed = new Date(`${normalised}${PAKISTAN_OFFSET}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** The value for a `datetime-local` control, in Pakistani time. */
export function localFromInstant(value: Date | null): string {
  if (!value) return "";
  const shifted = new Date(value.getTime() + 5 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 16);
}

function fieldSchema(field: FieldSpec): z.ZodType {
  switch (field.kind) {
    case "text":
    case "url": {
      const base = z.string().trim().max(field.max ?? 300);
      return field.required ? base.min(1, "Required.") : base.optional();
    }
    case "textarea": {
      const base = z.string().trim().max(field.max ?? 1000);
      return field.required ? base.min(1, "Required.") : base.optional();
    }
    case "slug":
      return SLUG;
    case "department":
      // Validated against the departments this actor may file under, which is
      // an authorisation question and therefore a query, not a static list.
      return z.string().trim().min(1, "Required.").max(40);
    case "richtext":
      // No maximum: the column is MEDIUMTEXT, and the sanitiser decides what
      // survives. A character limit here would count markup rather than words.
      return z.string().optional();
    case "integer":
      return numeric(
        field,
        z.coerce.number().int().min(field.min ?? -2_147_483_648).max(2_147_483_647),
      );
    case "decimal":
      return numeric(field, z.coerce.number().min(-9999.99).max(9999.99));
    case "date":
      return field.required ? civilDate : z.union([civilDate, z.literal("")]).optional();
    case "datetime":
      return field.required ? localInstant : z.union([localInstant, z.literal("")]).optional();
    case "select": {
      const values = (field.options ?? []).map((option) => option.value);
      if (values.length === 0) throw new Error(`select field ${field.name} has no options`);
      const base = z.enum(values as [string, ...string[]]);
      return field.required ? base : z.union([base, z.literal("")]).optional();
    }
    case "checkbox":
      // An unticked box submits nothing at all, so absence is false rather
      // than a validation failure.
      return z
        .union([z.literal("on"), z.literal("true"), z.literal("")])
        .optional()
        .transform((value) => value === "on" || value === "true");
    case "media":
      return numeric(field, z.coerce.number().int().positive());
  }
}

/**
 * A number field, with the empty string treated as absence.
 *
 * `z.coerce.number()` turns `""` into **0**, which is the kind of coercion
 * that passes every test written against filled-in forms. An event left
 * without a capacity would be stored as nought places rather than as
 * unlimited, and a required count left blank would save as zero instead of
 * reporting "Required." So the empty string is mapped to `undefined` before
 * coercion runs, and required-ness is then checked on the absence rather than
 * on a zero that was never typed.
 */
function numeric(field: FieldSpec, base: z.ZodType<number>): z.ZodType {
  const prepared = z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    base.optional(),
  );
  return field.required ? prepared.refine((value) => value !== undefined, "Required.") : prepared;
}

/** The zod object for one type's satellite fields. */
export function satelliteSchema(kind: ContentKind): z.ZodObject<Record<string, z.ZodType>> {
  const shape: Record<string, z.ZodType> = {};
  for (const field of CONTENT_FORMS[kind].fields) {
    shape[field.name] = fieldSchema(field);
  }
  return z.object(shape);
}

/* -------------------------------------------------------------------------- */
/* The parent row                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The controls that come from `content_items` rather than from a satellite.
 *
 * These are the same on every screen, which is the whole reason the parent
 * table exists — so they are described here once and the twelve field lists
 * above say nothing about them.
 *
 * Which of them appear does vary: `sort_order` only where a public read orders
 * by it, and the SEO group only where the type has a page of its own to put a
 * title and description on.
 */
export function parentFields(kind: ContentKind): readonly FieldSpec[] {
  const form = CONTENT_FORMS[kind];

  const fields: FieldSpec[] = [
    {
      name: "title_en",
      label: form.titleLabel,
      kind: "text",
      required: true,
      max: 300,
      help: form.titleHelp,
    },
    {
      name: "title_ur",
      label: `${form.titleLabel} (Urdu)`,
      kind: "text",
      max: 400,
    },
    {
      name: "slug",
      label: "Address",
      kind: "slug",
      required: true,
      max: 160,
      help: form.hasSeo
        ? "The last part of the public web address. Changing it after publication breaks every link to this page."
        : "An identifier. Not shown to visitors, but it has to be unique.",
    },
    {
      name: "department_code",
      label: "Owning department",
      kind: "department",
      required: true,
      help: "Who is answerable for this. It also decides which editors can open it.",
    },
  ];

  if (form.hasSortOrder) {
    fields.push({
      name: "sort_order",
      label: "Position",
      kind: "integer",
      min: 0,
      help: "Lower comes first. Leave at 100 and they fall in the order they were added.",
    });
  }

  fields.push(
    {
      name: "review_by",
      label: "Check again by",
      kind: "date",
      help: "When this should next be looked at. The stale-content report is built from this date, so an empty one means nobody will be reminded.",
    },
    {
      name: "scheduled_unpublish_at",
      label: "Take down on",
      kind: "datetime",
      help: "Optional. It stops appearing on its own, with no cron job involved — the public reads simply stop matching it.",
    },
  );

  if (form.hasSeo) {
    fields.push(
      {
        name: "seo_title",
        label: "Search-result title",
        kind: "text",
        max: 300,
        help: `Optional. Falls back to the ${form.titleLabel.toLowerCase()}.`,
      },
      {
        name: "seo_description",
        label: "Search-result description",
        kind: "textarea",
        max: 500,
        help: "Around 150 characters. Google rewrites longer ones.",
      },
      {
        name: "og_image_id",
        label: "Sharing image",
        kind: "media",
        help: "Shown when the page is shared on WhatsApp or LinkedIn. Landscape works best.",
      },
    );
  }

  return fields;
}

/**
 * Every editable field of one content type, parent and satellite together.
 *
 * One flat object because the editor is one form and a flat `FormData` is what
 * a form submits. The two groups never collide: no satellite column is named
 * `slug`, `title_en` or any of the rest, and
 * `tests/content-fields.test.ts` asserts it stays that way.
 */
export function contentFormSchema(kind: ContentKind): z.ZodObject<Record<string, z.ZodType>> {
  const shape: Record<string, z.ZodType> = {
    // Not a field anybody types: topic tags arrive as repeated checkbox values,
    // so a single selection reaches the action as a string rather than a list.
    topics: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .transform((value) =>
        value === undefined ? [] : Array.isArray(value) ? value : [value],
      ),
  };

  for (const field of [...parentFields(kind), ...CONTENT_FORMS[kind].fields]) {
    shape[field.name] = fieldSchema(field);
  }

  return z.object(shape);
}

/** Every field of a type, in the order the editor renders them. */
export function allFields(kind: ContentKind): readonly FieldSpec[] {
  return [...parentFields(kind), ...CONTENT_FORMS[kind].fields];
}

/** Lookup for the write path, which must never take a column name from input. */
export function fieldByName(kind: ContentKind, name: string): FieldSpec | undefined {
  return allFields(kind).find((field) => field.name === name);
}
