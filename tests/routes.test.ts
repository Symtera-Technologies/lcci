import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  PROTECTED_PREFIXES,
  ROUTE_POLICY,
  isProtected,
  requiresPolicy,
  routePolicy,
} from "@/server/auth/policy";

/**
 * The route inventory.
 *
 * This is the first test in the project, written before the routes it guards,
 * and it is the only mechanical guarantee that nothing under `/admin` or
 * `/membership/apply` is reachable without a check. Everything else in the
 * authorisation design — the data-access layer, the actor parameter, the
 * permission union — makes the *right* check easy to write. None of it makes a
 * *missing* check noticeable.
 *
 * So: walk the filesystem for every route Next will serve, and assert that
 * every protected one is named in `ROUTE_POLICY`. Adding an unprotected admin
 * route then stops being something a reviewer has to spot and becomes
 * something the suite refuses.
 *
 * It reads the filesystem rather than importing Next's internals deliberately:
 * the filesystem *is* the router, and an inventory derived from the same thing
 * Next derives its routes from cannot disagree with it.
 */

const APP_DIR = path.join(process.cwd(), "src", "app");

const PAGE_FILES = new Set(["page.tsx", "page.ts", "page.jsx", "page.js"]);
const ROUTE_FILES = new Set(["route.ts", "route.js"]);

export interface DiscoveredRoute {
  /** The URL path Next will serve. */
  urlPath: string;
  /** The file, relative to src/app, for a readable failure message. */
  file: string;
  kind: "page" | "route";
}

/**
 * Translate a directory path under `src/app` into the URL it serves.
 *
 * Returns null for segments Next excludes from routing entirely.
 */
function segmentsToUrl(segments: string[]): string | null {
  const kept: string[] = [];

  for (const segment of segments) {
    // A folder whose name starts with an underscore is private: Next does not
    // route it at all.
    if (segment.startsWith("_")) return null;

    // `(group)` is a route group — organisational, contributes no URL segment.
    if (segment.startsWith("(") && segment.endsWith(")")) continue;

    // `@slot` is a parallel route; its pages render at the parent's URL.
    if (segment.startsWith("@")) continue;

    kept.push(segment);
  }

  return `/${kept.join("/")}`.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1");
}

async function discoverRoutes(): Promise<DiscoveredRoute[]> {
  const found: DiscoveredRoute[] = [];

  async function walk(dir: string, segments: string[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), [...segments, entry.name]);
        continue;
      }

      const isPage = PAGE_FILES.has(entry.name);
      const isRoute = ROUTE_FILES.has(entry.name);
      if (!isPage && !isRoute) continue;

      const urlPath = segmentsToUrl(segments);
      if (urlPath === null) continue;

      found.push({
        urlPath,
        file: path.posix.join(...segments, entry.name),
        kind: isPage ? "page" : "route",
      });
    }
  }

  await walk(APP_DIR, []);
  return found.sort((a, b) => a.urlPath.localeCompare(b.urlPath));
}

describe("route inventory", () => {
  it("finds the routes that already exist", async () => {
    // A sanity check on the walker itself. If this ever returns nothing, every
    // other assertion below passes vacuously and the guarantee is gone.
    const routes = await discoverRoutes();
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.map((r) => r.urlPath)).toContain("/");
  });

  it("names every protected route and every API route in ROUTE_POLICY", async () => {
    const routes = await discoverRoutes();
    const unlisted: string[] = [];

    for (const route of routes) {
      if (!requiresPolicy(route.urlPath)) continue;
      const { policy } = routePolicy(route.urlPath);
      if (!policy) unlisted.push(`${route.urlPath}  (src/app/${route.file})`);
    }

    expect(
      unlisted,
      "These routes need a declared policy and have no entry in " +
        "src/server/auth/policy.ts. Add one — and remember the table is not " +
        "the check itself: the route must also call requireStaff/requireMember.\n" +
        unlisted.join("\n"),
    ).toEqual([]);
  });

  it("marks a policy entry as planned exactly while its route is missing", async () => {
    const routes = await discoverRoutes();
    const existing = new Set(routes.map((r) => r.urlPath));

    const wrong: string[] = [];
    for (const [pattern, policy] of Object.entries(ROUTE_POLICY)) {
      const routeExists = existing.has(pattern);

      if (!routeExists && !policy.planned) {
        wrong.push(
          `${pattern} has a policy but no route file, and is not marked planned. ` +
            "Either the path is mistyped or the route was deleted.",
        );
      }
      if (routeExists && policy.planned) {
        wrong.push(
          `${pattern} exists now — remove "planned: true" from its policy entry.`,
        );
      }
    }

    // This is what stops `planned` from rotting into a permanent exemption: a
    // flag that only has to be removed when the route lands is a flag someone
    // will be told to remove.
    expect(wrong, wrong.join("\n")).toEqual([]);
  });

  it("gives every policy entry an audience and a permission list", () => {
    for (const [pattern, policy] of Object.entries(ROUTE_POLICY)) {
      expect(["staff", "member", "either"], pattern).toContain(policy.audience);
      expect(Array.isArray(policy.permissions), pattern).toBe(true);
    }
  });

  it("requires a note on any entry that opts out of authentication", () => {
    // `public: true` under a protected prefix, or on an API route, is the one
    // kind of entry where the reason has to be written down — otherwise the
    // next reader cannot tell a deliberate exemption from a mistake.
    for (const [pattern, policy] of Object.entries(ROUTE_POLICY)) {
      if (!policy.public) continue;
      expect(policy.note?.length ?? 0, `${pattern} is public with no note`).toBeGreaterThan(
        20,
      );
    }
  });
});

describe("the guard each protected page calls", () => {
  /**
   * `ROUTE_POLICY` says a page is protected. It does not say the page's guard
   * answers properly when it refuses.
   *
   * Both guards come in two forms. `requireMember` and `requireStaff` throw,
   * which is right inside an action or a route handler, where the wrapper
   * turns the throw into a value. In a page nothing catches it, so the refusal
   * renders as a 500 reading "A server error occurred. Reload to try again."
   * Every page under `/membership` called the throwing form, so both of its
   * refusals — a session that had expired, and an officer who followed a
   * member's link — were that 500. Reloading fixes neither, and `proxy.ts` hid
   * the common case by redirecting anyone with no cookie at all before a page
   * ran at all.
   *
   * `requireMemberPage` and `requireStaffPage` are the forms that answer:
   * `redirect()` where there is something useful to do, `forbidden()` where
   * there is not. This test reads the source rather than driving a request,
   * which is the weaker claim — it shows the right function is called, not
   * what it does — but it is the claim that was false, and it still holds for
   * a page added next month by someone who copied the wrong import.
   */
  const THROWING_GUARDS = [
    "requireMember",
    "requireStaff",
    "requireActor",
    "requirePermission",
  ];

  it("uses the page form, which answers, and not the throwing form", async () => {
    const routes = await discoverRoutes();
    const offenders: string[] = [];

    for (const route of routes) {
      if (route.kind !== "page") continue;
      if (!isProtected(route.urlPath)) continue;
      if (routePolicy(route.urlPath).policy?.public === true) continue;

      const source = await readFile(path.join(APP_DIR, route.file), "utf8");

      // The open bracket is the whole trick, and it is here instead of a word
      // boundary because a regex is the wrong tool for a name that is a prefix
      // of the name it must not match: `requireStaffPage(` does not contain
      // `requireStaff(`, and every call site has the bracket.
      const throwing = THROWING_GUARDS.find((name) =>
        source.includes(`${name}(`),
      );

      if (throwing !== undefined) {
        offenders.push(`${route.file} calls ${throwing}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("isProtected", () => {
  it("covers each declared prefix and its children", () => {
    for (const prefix of PROTECTED_PREFIXES) {
      expect(isProtected(prefix)).toBe(true);
      expect(isProtected(`${prefix}/anything`)).toBe(true);
      expect(isProtected(`${prefix}/deeply/nested/thing`)).toBe(true);
    }
  });

  it("leaves the public site alone", () => {
    for (const path of ["/", "/v2", "/news", "/about", "/membership"]) {
      expect(isProtected(path), path).toBe(false);
    }
  });

  it("is not fooled by a prefix that is only a string prefix", () => {
    // `/administration` must not be treated as living under `/admin`, and
    // `/membership` must not be treated as living under `/membership/apply`.
    expect(isProtected("/administration")).toBe(false);
    expect(isProtected("/adminx")).toBe(false);
    expect(isProtected("/membership")).toBe(false);
    expect(isProtected("/membership/benefits")).toBe(false);
  });

  it("normalises a trailing slash and doubled separators", () => {
    // Without this, `/admin//users` and `/admin/users/` would slip past a
    // prefix check that `/admin/users` fails — which is the whole attack.
    expect(isProtected("/admin/")).toBe(true);
    expect(isProtected("/admin//users")).toBe(true);
    expect(isProtected("/admin/users/")).toBe(true);
    expect(isProtected("//admin")).toBe(true);
  });
});

describe("routePolicy", () => {
  it("resolves a concrete path against a dynamic pattern", () => {
    const { policy } = routePolicy("/api/cron/email-outbox");
    expect(policy).not.toBeNull();
    expect(policy?.public).toBe(true);
  });

  it("does not match a dynamic pattern with the wrong depth", () => {
    expect(routePolicy("/api/cron").policy).toBeNull();
    expect(routePolicy("/api/cron/a/b").policy).toBeNull();
  });

  it("reports an unlisted protected path as protected with no policy", () => {
    // Deny by default. A caller that finds `protectedPath: true` and
    // `policy: null` must refuse, not wave it through.
    const decision = routePolicy("/admin/not-in-the-table");
    expect(decision.protectedPath).toBe(true);
    expect(decision.policy).toBeNull();
  });
});

/**
 * The half-authenticated surface.
 *
 * A staff session whose second factor is outstanding is refused everywhere
 * except the routes carrying `allowBeforeMfa`, so that set *is* the surface a
 * stolen password reaches before producing a code. It must stay at two: the
 * sign-in page, which renders the code form, and the enrolment page, which an
 * account an administrator has required two-factor on must reach before it has
 * anything to present.
 *
 * Asserted as an exact set rather than a maximum, because the realistic
 * failure is somebody adding the flag to a third route to make a redirect loop
 * go away — which silently widens that surface and would otherwise pass every
 * other test in this file.
 */
describe("the routes reachable before the second factor", () => {
  it("is exactly the sign-in page and two-factor enrolment", () => {
    const exempt = Object.entries(ROUTE_POLICY)
      .filter(([, policy]) => policy.allowBeforeMfa)
      .map(([path]) => path)
      .sort();

    expect(exempt).toEqual(["/admin/setup-2fa", "/admin/sign-in"]);
  });

  it("grants the exemption to no route outside /admin", () => {
    for (const [path, policy] of Object.entries(ROUTE_POLICY)) {
      if (policy.allowBeforeMfa) expect(path.startsWith("/admin/")).toBe(true);
    }
  });

  /**
   * The account screens must never be in that set. They are where a
   * requirement is imposed and lifted, so reaching them with a password alone
   * would make the requirement self-service for anyone holding one.
   */
  it("never exempts the staff account screens", () => {
    for (const path of ["/admin/users", "/admin/users/new", "/admin/users/[id]"]) {
      expect(ROUTE_POLICY[path]?.allowBeforeMfa).toBeUndefined();
      expect(ROUTE_POLICY[path]?.permissions).toContain("user.manage");
    }
  });
});

/**
 * The same surface, one layer down.
 *
 * `ROUTE_POLICY` governs pages. A server action is separately addressable and
 * carries its own `allowBeforeMfa`, so a stolen password reaches the union of
 * the two sets, not just the routes — and the action set has no inventory of
 * its own because actions are not files Next enumerates.
 *
 * So enumerate them here. Two actions hold the flag, each the counterpart of
 * an exempt route: presenting a code or a recovery code, and pairing an app
 * for an account that has none.
 *
 * `enrolAction` is the one worth staring at. The flag admits any staff session
 * that owes a second factor, including one whose account *is* paired — which
 * would let a password alone pair a new authenticator over the real holder's.
 * The handler narrows it, and this test asserts the narrowing is still there,
 * because deleting it leaves a file that compiles, passes every other test and
 * hands over the second factor.
 */
describe("the actions reachable before the second factor", () => {
  async function actionFiles(): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
          found.set(full.split(path.sep).join("/"), await readFile(full, "utf8"));
        }
      }
    }
    await walk(path.join(process.cwd(), "src", "app"));
    return found;
  }

  it("is exactly the sign-in and enrolment actions", async () => {
    const carrying = [...(await actionFiles())]
      .filter(([, source]) => /^\s*allowBeforeMfa:\s*true,?$/m.test(source))
      .map(([file]) => file.slice(file.indexOf("src/app")))
      .sort();

    expect(carrying).toEqual([
      "src/app/(admin)/admin/setup-2fa/actions.ts",
      "src/app/(admin)/admin/sign-in/actions.ts",
    ]);
  });

  it("keeps the enrolment action's own refusal of a session owing a code", async () => {
    const source = (await actionFiles()).get(
      path
        .join(process.cwd(), "src/app/(admin)/admin/setup-2fa/actions.ts")
        .split(path.sep).join("/"),
    );

    expect(source).toBeDefined();
    expect(source).toMatch(
      /session\.session\.mfaSatisfiedAt === null\s*&&\s*session\.user\.twoFactorEnabled/,
    );
  });
});
