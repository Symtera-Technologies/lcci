import { describe, expect, it } from "vitest";
import type { ContentStatus } from "@/db/schema";
import type { PermissionCode } from "@/server/permissions";
import { permissionsForRole, type RoleCode } from "@/server/permissions";
import {
  CONTENT_TRANSITIONS,
  availableContentTransitions,
  canTransitionContent,
  contentTransitionsFrom,
  findContentTransition,
  isContentTransitionCode,
  requiresNote,
  type ContentTransitionCode,
} from "@/content/workflow";

/**
 * The editorial state machine, exercised as the pure table it is.
 *
 * No database, because there is nothing here that needs one — which is the
 * reason the table was kept free of `server-only` in the first place. Every
 * refusal the server can make about *whether* a move may happen is decided by
 * these functions, so this file is where the refusals are pinned.
 */

const ALL_STATUSES: readonly ContentStatus[] = [
  "draft",
  "in_review",
  "published",
  "archived",
];

function actorWith(
  permissions: readonly PermissionCode[],
  departmentScopes: readonly string[] = [],
) {
  return { permissions: new Set(permissions), departmentScopes };
}

/** The grants as the seeded roles actually hold them, not as invented here. */
function roleActor(role: RoleCode, scopes: readonly string[] = []) {
  return actorWith(permissionsForRole(role), scopes);
}

describe("the transition table", () => {
  it("never has two edges with the same from and code", () => {
    const keys = CONTENT_TRANSITIONS.map((t) => `${t.from}:${t.code}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("only moves between real statuses, and never to where it started", () => {
    for (const transition of CONTENT_TRANSITIONS) {
      expect(ALL_STATUSES).toContain(transition.from);
      expect(ALL_STATUSES).toContain(transition.to);
      expect(transition.to).not.toBe(transition.from);
    }
  });

  it("requires a permission on every edge", () => {
    for (const transition of CONTENT_TRANSITIONS) {
      expect(transition.permission).toBeTruthy();
    }
  });

  /**
   * Archiving is how something leaves the lists, and restoring is how it comes
   * back. If one were reachable without the other, an item could be filed away
   * by somebody who could not retrieve it.
   */
  it("pairs archive with restore under the same permission", () => {
    const archives = CONTENT_TRANSITIONS.filter((t) => t.code === "archive");
    const restores = CONTENT_TRANSITIONS.filter((t) => t.code === "restore");

    expect(archives.length).toBeGreaterThan(0);
    expect(restores.length).toBeGreaterThan(0);
    for (const transition of [...archives, ...restores]) {
      expect(transition.permission).toBe("content.archive");
    }
  });

  it("leaves no status a dead end", () => {
    for (const status of ALL_STATUSES) {
      expect(contentTransitionsFrom(status).length).toBeGreaterThan(0);
    }
  });

  it("can reach every status from draft", () => {
    const reached = new Set<ContentStatus>(["draft"]);
    for (let pass = 0; pass < ALL_STATUSES.length; pass += 1) {
      for (const transition of CONTENT_TRANSITIONS) {
        if (reached.has(transition.from)) reached.add(transition.to);
      }
    }
    for (const status of ALL_STATUSES) expect(reached).toContain(status);
  });
});

describe("who may move what", () => {
  const draft = { status: "draft" as const, departmentCode: "info" };
  const inReview = { status: "in_review" as const, departmentCode: "info" };
  const published = { status: "published" as const, departmentCode: "info" };

  it("lets a department editor submit a draft and nothing more", () => {
    const editor = roleActor("department_editor", ["info"]);

    expect(canTransitionContent(draft, "submit_review", editor).allowed).toBe(true);
    expect(canTransitionContent(draft, "publish", editor).missingPermission).toBe(
      "content.publish",
    );
    expect(canTransitionContent(draft, "archive", editor).missingPermission).toBe(
      "content.archive",
    );
  });

  /**
   * The separation the workflow exists to create, stated as its own test: the
   * role that writes the chamber's content cannot put it on the site. If this
   * ever passes with `allowed: true`, review has become optional for the one
   * role it was built for.
   */
  it("never lets a department editor publish, from any status", () => {
    const editor = roleActor("department_editor", ["info"]);

    for (const status of ALL_STATUSES) {
      const decision = canTransitionContent(
        { status, departmentCode: "info" },
        "publish",
        editor,
      );
      expect(decision.allowed).toBe(false);
    }
  });

  it("lets a reviewer publish a submission or send it back", () => {
    const reviewer = roleActor("reviewer");

    expect(canTransitionContent(inReview, "publish", reviewer).allowed).toBe(true);
    expect(canTransitionContent(inReview, "return_to_draft", reviewer).allowed).toBe(true);
    expect(canTransitionContent(published, "unpublish", reviewer).allowed).toBe(true);
  });

  /**
   * `media` holds `content.publish` and not `content.review`, which is what
   * makes the draft-to-published edge meaningful rather than a loophole: the
   * role can put its own work up, and cannot sit in judgement on anybody
   * else's submission.
   */
  it("lets the media role publish its own draft but not adjudicate a submission", () => {
    const media = roleActor("media");

    expect(canTransitionContent(draft, "publish", media).allowed).toBe(true);
    expect(canTransitionContent(inReview, "publish", media).allowed).toBe(true);
    expect(canTransitionContent(inReview, "return_to_draft", media).missingPermission).toBe(
      "content.review",
    );
  });

  it("reports a move the item cannot make as unknown rather than forbidden", () => {
    const admin = roleActor("super_admin");
    const decision = canTransitionContent(published, "submit_review", admin);

    expect(decision.unknown).toBe(true);
    expect(decision.allowed).toBe(false);
    expect(decision.transition).toBeNull();
    // Not a permission problem: a super administrator holds everything, and
    // saying "forbidden" here would send somebody looking for a grant to add.
    expect(decision.missingPermission).toBeNull();
  });
});

describe("department scope", () => {
  const otherDepartment = { status: "draft" as const, departmentCode: "research" };

  it("refuses an editor scoped to another department", () => {
    const editor = roleActor("department_editor", ["info"]);
    const decision = canTransitionContent(otherDepartment, "submit_review", editor);

    expect(decision.allowed).toBe(false);
    expect(decision.failedGuards).toEqual(["department_in_scope"]);
    expect(decision.reasons[0]).toMatch(/does not cover the department/i);
  });

  /**
   * Empty scopes mean the whole chamber, as everywhere else in this codebase.
   * Reading empty as "nothing" would lock out `super_admin` and `reviewer`,
   * who hold their roles globally — and it would do it silently, because the
   * buttons would simply stop being drawn.
   */
  it("treats an empty scope list as the whole chamber", () => {
    const reviewer = roleActor("reviewer");
    expect(
      canTransitionContent(
        { status: "in_review", departmentCode: "research" },
        "publish",
        reviewer,
      ).allowed,
    ).toBe(true);
  });

  it("checks the permission before the scope", () => {
    // Scoped elsewhere *and* without the grant: the answer names the grant,
    // so a refusal never reveals which department owns an item the actor
    // has no business knowing about.
    const editor = roleActor("department_editor", ["info"]);
    const decision = canTransitionContent(otherDepartment, "publish", editor);

    expect(decision.missingPermission).toBe("content.publish");
    expect(decision.failedGuards).toEqual([]);
  });
});

describe("what the editor screen draws", () => {
  it("offers a department editor exactly one move on its own draft", () => {
    const choices = availableContentTransitions(
      { status: "draft", departmentCode: "info" },
      roleActor("department_editor", ["info"]),
    );

    expect(choices.map((c) => c.code)).toEqual(["submit_review"]);
  });

  it("offers nothing on another department's item", () => {
    const choices = availableContentTransitions(
      { status: "draft", departmentCode: "research" },
      roleActor("department_editor", ["info"]),
    );

    expect(choices).toEqual([]);
  });

  it("offers a reviewer both the yes and the no on a submission", () => {
    const codes = availableContentTransitions(
      { status: "in_review", departmentCode: "info" },
      roleActor("reviewer"),
    ).map((c) => c.code);

    expect(codes).toContain("publish");
    expect(codes).toContain("return_to_draft");
  });

  it("never offers a move the table would refuse", () => {
    for (const status of ALL_STATUSES) {
      for (const role of ["department_editor", "reviewer", "media", "super_admin"] as const) {
        const actor = roleActor(role, role === "department_editor" ? ["info"] : []);
        const facts = { status, departmentCode: "info" };

        for (const choice of availableContentTransitions(facts, actor)) {
          expect(canTransitionContent(facts, choice.code, actor).allowed).toBe(true);
        }
      }
    }
  });
});

describe("the note", () => {
  it("is required only when sending something back", () => {
    expect(requiresNote("return_to_draft")).toBe(true);

    for (const code of [
      "submit_review",
      "publish",
      "unpublish",
      "archive",
      "restore",
    ] as ContentTransitionCode[]) {
      expect(requiresNote(code)).toBe(false);
    }
  });
});

describe("the code guard", () => {
  it("accepts every code in the table and nothing else", () => {
    for (const transition of CONTENT_TRANSITIONS) {
      expect(isContentTransitionCode(transition.code)).toBe(true);
    }

    for (const value of ["", "delete", "PUBLISH", null, undefined, 3, {}]) {
      expect(isContentTransitionCode(value)).toBe(false);
    }
  });

  it("finds an edge only for the status it leaves from", () => {
    expect(findContentTransition("draft", "submit_review")).not.toBeNull();
    expect(findContentTransition("published", "submit_review")).toBeNull();
  });
});
