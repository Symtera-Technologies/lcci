import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Every colour class names a token that exists.
 *
 * Tailwind emits nothing for an undefined token. `text-urgent-900` against a
 * palette whose urgent family stops at 800 is not an error, not a warning and
 * not a visible fallback — the element simply inherits whatever colour its
 * parent had, which on a white panel is usually readable. So the failure mode
 * is a status pill that renders in body-text grey, on a screen that typechecks,
 * lints and passes every other test.
 *
 * This has already happened once in this project. The palette comment in
 * `globals.css` records it: eight classes were in use against steps that did
 * not exist, and the fix was to add the steps. The comment did not prevent the
 * next occurrence — two more undefined tokens went in while the comment
 * explaining the trap was open on screen — which is the argument for a test
 * rather than a note.
 *
 * **Only the families this project invents are checked.** `globals.css`
 * declares its tokens in `@theme`, which *merges* with Tailwind's default
 * theme, so a step we do not declare for a family Tailwind ships — `stone-400`,
 * say — still resolves to Tailwind's own value and is perfectly fine. A step we
 * do not declare for a family only we have heard of resolves to nothing. That
 * distinction is the whole rule.
 */

const SRC_DIR = path.join(process.cwd(), "src");
const TOKENS_FILE = path.join(SRC_DIR, "app", "globals.css");

/**
 * The colour families Tailwind ships, as of the version in `package.json`.
 *
 * Listed so the check can tell "a step of ours that is missing" from "a step of
 * Tailwind's that we never needed to override". A family added here by mistake
 * would make the test blind to that family, so the list is deliberately the
 * upstream palette and nothing else — never a place to silence a failure.
 */
const TAILWIND_FAMILIES = new Set([
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
  "slate",
  "gray",
  "zinc",
  "neutral",
  "stone",
]);

const DEFINITION = /--color-([a-z]+)-(\d+)\s*:/g;

interface Palette {
  /** Every `family-step` the stylesheet defines. */
  tokens: Set<string>;
  /** The families this project invents, which it must therefore define fully. */
  ours: Set<string>;
}

async function readPalette(): Promise<Palette> {
  const css = await readFile(TOKENS_FILE, "utf8");
  const tokens = new Set<string>();
  const ours = new Set<string>();

  for (const match of css.matchAll(DEFINITION)) {
    const [, family, step] = match;
    tokens.add(`${family}-${step}`);
    if (!TAILWIND_FAMILIES.has(family)) ours.add(family);
  }

  return { tokens, ours };
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".css"]);

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(full)));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(full);
    }
  }

  return files;
}

interface Usage {
  token: string;
  file: string;
  line: number;
}

/**
 * Find references to a palette family, whatever utility they belong to.
 *
 * Matching `family-step` rather than `text-family-step` is deliberate. The list
 * of Tailwind utilities that take a colour is long and grows — `text`, `bg`,
 * `border`, `border-t`, `ring`, `ring-offset`, `outline`, `decoration`,
 * `divide`, `from`, `via`, `to`, `accent`, `caret`, `fill`, `stroke`,
 * `placeholder`, `shadow`, `inset-shadow` — and the one left out of the list is
 * the one whose broken token ships. The family names are distinctive enough
 * that a false positive is a loud failure somebody reads, which is the right
 * way round for a test like this.
 */
function findUsages(source: string, file: string, families: Set<string>): Usage[] {
  const pattern = new RegExp(`\\b(${[...families].join("|")})-(\\d+)\\b`, "g");
  const found: Usage[] = [];

  source.split("\n").forEach((text, index) => {
    // The definitions themselves are not usages. Skipping the line rather than
    // the file, because the stylesheet legitimately uses its own classes too.
    if (text.includes("--color-")) return;

    for (const match of text.matchAll(pattern)) {
      found.push({ token: match[0], file, line: index + 1 });
    }
  });

  return found;
}

describe("the colour palette", () => {
  it("defines several families of its own", async () => {
    const { ours } = await readPalette();

    // A guard on the guard: if the stylesheet is ever restructured so the
    // definitions stop matching, `ours` goes empty and the test below passes
    // by examining nothing at all.
    expect(ours.size).toBeGreaterThanOrEqual(4);
    expect([...ours].sort()).toContain("urgent");
  });

  it("has a step for every class that names one", async () => {
    const { tokens, ours } = await readPalette();
    const files = await sourceFiles(SRC_DIR);

    expect(files.length).toBeGreaterThan(20);

    const broken: Usage[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const usage of findUsages(source, file, ours)) {
        if (!tokens.has(usage.token)) broken.push(usage);
      }
    }

    // The message carries the file and line, because the failure is otherwise
    // "a token is missing" with nothing to say which of two hundred components
    // is rendering grey.
    const report = broken
      .map(
        (usage) =>
          `${path.relative(process.cwd(), usage.file)}:${usage.line} uses ${usage.token}`,
      )
      .sort();

    expect(report).toEqual([]);
  });
});
