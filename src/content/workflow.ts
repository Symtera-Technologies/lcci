/**
 * The editorial state machine: data plus one pure function.
 *
 * Deliberately free of `server-only` and of any database import, for the same
 * reason `src/membership/workflow.ts` is: the admin needs this table to decide
 * which buttons to draw, the server needs it to decide what to refuse, and the
 * test suite needs to exercise every edge without a MySQL server. One source
 * of truth for "may this happen", in the only form a client component and a
 * transaction can share.
 *
 * `canTransition` returns the guards that **failed** rather than a boolean, so
 * a disabled button and the sentence explaining it come from the same table
 * the server enforces. A boolean would make the UI re-derive the reason, and
 * the two would drift the first time a rule changed.
 *
 * ## Why `publish` leaves from two states
 *
 * There is an edge from `draft` straight to `published`, alongside the one
 * from `in_review`. That is not a hole in the review step — it is what the
 * role grants already say. `department_editor` holds `content.submit_review`
 * and not `content.publish`, so for that role the only way out of a draft is
 * review, which is the separation the workflow exists to create. `media` and
 * `reviewer` hold `content.publish`, and forcing them through a review they
 * would perform on themselves a second later would write a review record that
 * records nothing. A fake step makes the audit log less truthful, not more.
 *
 * Which of the two edges was taken is recorded on the published event, so "was
 * this reviewed by anybody" stays an answerable question.
 *
 * ## Why archiving is nearly unreachable
 *
 * `content.archive` is granted to `super_admin` and to nobody else in
 * `src/server/permissions.ts`. That is the intended default, not an oversight:
 * archiving is how a URL stops being listed while still resolving, and with
 * ~890 legacy press URLs being redirected into this space, an item vanishing
 * from a list is a decision worth concentrating. If LCCI wants reviewers to
 * archive, that is a grant to change, not code.
 */

import type { ContentStatus } from "@/db/schema";
import type { PermissionCode } from "@/server/permissions";

/* -------------------------------------------------------------------------- */
/* Guards                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The conditions a transition can fail on, as opposed to the permission it can
 * lack.
 *
 * One entry, and that is honest rather than lazy. Everything else a publish
 * might want to check — required fields present, slug well-formed, body
 * sanitised — is enforced at save, so a row that exists has already passed it
 * and re-checking here would be a second implementation of the same rule.
 * B4 adds the ones that genuinely belong to a transition: a scheduled
 * unpublish that has already passed, and a publication date in the future.
 */
export type ContentGuardCode = "department_in_scope";

export const CONTENT_GUARD_MESSAGES: Record<ContentGuardCode, string> = {
  department_in_scope:
    "This account does not cover the department that owns this item.",
};

/* -------------------------------------------------------------------------- */
/* The table                                                                  */
/* -------------------------------------------------------------------------- */

export type ContentTransitionCode =
  | "submit_review"
  | "return_to_draft"
  | "publish"
  | "unpublish"
  | "archive"
  | "restore";

export interface ContentTransition {
  readonly code: ContentTransitionCode;
  readonly from: ContentStatus;
  readonly to: ContentStatus;
  readonly permission: PermissionCode;
  readonly guards: readonly ContentGuardCode[];
  /** The button, in the words an editor would use. */
  readonly label: string;
  /** Why this edge exists, for whoever reads the table next. */
  readonly note: string;
}

/**
 * Every move an item can make.
 *
 * Keyed by `from` and `code` together, which is why `publish` and `archive`
 * each appear more than once. Each origin is a separately granted edge rather
 * than a wildcard — a wildcard is what would let an archived item be published
 * without passing back through a draft anybody looked at.
 */
export const CONTENT_TRANSITIONS: readonly ContentTransition[] = [
  {
    code: "submit_review",
    from: "draft",
    to: "in_review",
    permission: "content.submit_review",
    guards: ["department_in_scope"],
    label: "Submit for review",
    note: "The department editor's only way out of a draft. Clears any note the reviewer left, because the note described the version that has now been revised.",
  },
  {
    code: "return_to_draft",
    from: "in_review",
    to: "draft",
    permission: "content.review",
    guards: ["department_in_scope"],
    label: "Send back with a note",
    note: "The reviewer declining, with a reason the editor will read on the item. The note is required: 'send back' with no words is a round trip nobody can act on.",
  },
  {
    code: "publish",
    from: "in_review",
    to: "published",
    permission: "content.publish",
    guards: ["department_in_scope"],
    label: "Publish",
    note: "The reviewed path. Stamps the publication date on a first publish and records who approved it.",
  },
  {
    code: "publish",
    from: "draft",
    to: "published",
    permission: "content.publish",
    guards: ["department_in_scope"],
    label: "Publish",
    note: "The unreviewed path, for the roles that hold publish directly. Audited as having skipped review, so the shortcut is visible in the log rather than indistinguishable from the reviewed one.",
  },
  {
    code: "unpublish",
    from: "published",
    to: "draft",
    permission: "content.unpublish",
    guards: ["department_in_scope"],
    label: "Take off the site",
    note: "Back to draft rather than to a parked state, because the reason to unpublish is almost always that it needs correcting. The publication date is kept, so republishing does not re-date the item and reorder the newsroom.",
  },
  {
    code: "archive",
    from: "published",
    to: "archived",
    permission: "content.archive",
    guards: ["department_in_scope"],
    label: "Archive",
    note: "Out of every list and out of the sitemap, but still resolving at its URL with a banner. The distinction that keeps a redirected legacy URL from becoming a 404.",
  },
  {
    code: "archive",
    from: "draft",
    to: "archived",
    permission: "content.archive",
    guards: ["department_in_scope"],
    label: "Archive",
    note: "For a draft that is finished with but was published once, and so cannot be deleted. A draft that was never published is deleted instead — see `deleteDraftContentItem`.",
  },
  {
    code: "archive",
    from: "in_review",
    to: "archived",
    permission: "content.archive",
    guards: ["department_in_scope"],
    label: "Archive",
    note: "An abandoned submission. Without this edge it would have to be sent back to its author first, purely to be filed away.",
  },
  {
    code: "restore",
    from: "archived",
    to: "draft",
    permission: "content.archive",
    guards: ["department_in_scope"],
    label: "Restore to draft",
    note: "The inverse of archiving, and to a draft rather than to whatever it was before: bringing something back always goes past somebody who can read it first.",
  },
];

/* -------------------------------------------------------------------------- */
/* Asking the table                                                           */
/* -------------------------------------------------------------------------- */

export function findContentTransition(
  from: ContentStatus,
  code: ContentTransitionCode,
): ContentTransition | null {
  return (
    CONTENT_TRANSITIONS.find(
      (transition) => transition.from === from && transition.code === code,
    ) ?? null
  );
}

export function contentTransitionsFrom(
  from: ContentStatus,
): readonly ContentTransition[] {
  return CONTENT_TRANSITIONS.filter((transition) => transition.from === from);
}

/** What a transition needs to know about the item it would move. */
export interface ContentTransitionFacts {
  readonly status: ContentStatus;
  readonly departmentCode: string;
}

/**
 * What a transition needs to know about whoever is asking.
 *
 * `departmentScopes` empty means the whole chamber, exactly as everywhere else
 * in this codebase: access is decided by the permission, and the scope list
 * narrows it where one is granted. Reading empty as "nothing" would lock out
 * `super_admin` and `reviewer`, who hold their roles globally.
 */
export interface ContentTransitionActor {
  readonly permissions: ReadonlySet<PermissionCode>;
  readonly departmentScopes: readonly string[];
}

export interface ContentTransitionDecision {
  readonly allowed: boolean;
  /** The item is not in a state this code leaves from. */
  readonly unknown: boolean;
  readonly missingPermission: PermissionCode | null;
  readonly failedGuards: readonly ContentGuardCode[];
  /** One sentence per failed guard, ready to render. */
  readonly reasons: readonly string[];
  readonly transition: ContentTransition | null;
}

export function departmentInScope(
  scopes: readonly string[],
  departmentCode: string,
): boolean {
  return scopes.length === 0 || scopes.includes(departmentCode);
}

export function canTransitionContent(
  facts: ContentTransitionFacts,
  code: ContentTransitionCode,
  actor: ContentTransitionActor,
): ContentTransitionDecision {
  const transition = findContentTransition(facts.status, code);

  if (!transition) {
    return {
      allowed: false,
      unknown: true,
      missingPermission: null,
      failedGuards: [],
      reasons: [],
      transition: null,
    };
  }

  // The permission is reported before the guards, and nothing else is
  // evaluated, so a refusal never tells an actor something about an item they
  // are not entitled to act on.
  if (!actor.permissions.has(transition.permission)) {
    return {
      allowed: false,
      unknown: false,
      missingPermission: transition.permission,
      failedGuards: [],
      reasons: [],
      transition,
    };
  }

  const failedGuards: ContentGuardCode[] = [];
  for (const guard of transition.guards) {
    if (guard === "department_in_scope") {
      if (!departmentInScope(actor.departmentScopes, facts.departmentCode)) {
        failedGuards.push(guard);
      }
    }
  }

  return {
    allowed: failedGuards.length === 0,
    unknown: false,
    missingPermission: null,
    failedGuards,
    reasons: failedGuards.map((guard) => CONTENT_GUARD_MESSAGES[guard]),
    transition,
  };
}

/**
 * The transitions this actor could actually invoke on this item.
 *
 * What the editor screen draws. Everything else about the item's state is
 * still shown — a published item says so whether or not this account may
 * unpublish it — but a button that only ever answers "you may not" is noise.
 */
export function availableContentTransitions(
  facts: ContentTransitionFacts,
  actor: ContentTransitionActor,
): readonly ContentTransition[] {
  return contentTransitionsFrom(facts.status).filter(
    (transition) => canTransitionContent(facts, transition.code, actor).allowed,
  );
}

/** Does this transition require the reviewer to say something? */
export function requiresNote(code: ContentTransitionCode): boolean {
  return code === "return_to_draft";
}

export const CONTENT_TRANSITION_CODES: readonly ContentTransitionCode[] = [
  "submit_review",
  "return_to_draft",
  "publish",
  "unpublish",
  "archive",
  "restore",
];

export function isContentTransitionCode(
  value: unknown,
): value is ContentTransitionCode {
  return (
    typeof value === "string" &&
    (CONTENT_TRANSITION_CODES as readonly string[]).includes(value)
  );
}
