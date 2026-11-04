/**
 * Render one interior page to a standalone HTML file, for looking at.
 *
 *   npm run preview -- about-history
 *   npx http-server preview   # or any static server; file:// will not do,
 *                             # because the stylesheet is a separate request
 *
 * ## Why this exists
 *
 * These pages read their prose from MySQL and are statically prerendered, so
 * seeing one normally means a database, a dev server and a build. That is the
 * right loop for checking behaviour and a poor one for checking *design*,
 * which is the only way a layout can actually be reviewed — and it is
 * unavailable outright on a machine where the database is down.
 *
 * So this renders the real components with the real stylesheet and a body
 * string supplied here, and writes the result to `preview/`, which is
 * gitignored. It proves nothing about the data path; it is for eyes.
 *
 * **It is not a test and must never become one.** It writes files, it asserts
 * nothing, and a file under `tests/` that does both is how a suite starts
 * lying about what it checks. What this page's markup must *guarantee* is
 * covered by `tests/editorial-render.test.ts`.
 *
 * The body below is the row as the seed migration writes it. When a page is
 * re-seeded this will drift, and that is acceptable: the preview is for
 * judging a layout against representative content, and `verify:migration`
 * is what holds the real page to the real text.
 */

import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { InteriorPage } from "@/components/site/interior-page";
import { EditorialBody } from "@/components/site/editorial-body";
import { SectionIndex } from "@/components/site/section-index";
import { navEntry } from "@/components/site/nav-data";
import { CHAMBER } from "@/content/chamber";

/** `/about/history`, as `migrations/0026_seed_about_content.sql` stores it. */
const ABOUT_HISTORY_BODY =
  "<h2>Vision &amp; Mission</h2><h3><strong>Our Vision</strong></h3>\n\n" +
  "<p>To be the best Chamber in SAARC Countries through growth in business volumes, turnovers, exports and contribution in tax revenues.</p>\n\n" +
  "<h3><strong>Our Mission</strong></h3>\n\n" +
  "<p>To be the finest organization to serve the business community and to conduct its practices in best possible professional manner.</p>\n\n" +
  "<p>To be a bridge between the Business Community and Regulatory Bodiesfor in policy advocacy.</p>\n\n" +
  "<p>To seek long term relations with members reflecting fairness, honesty and transparency.</p>\n\n" +
  "<p>To build good repute of the Organization and maintaining high professional and ethical standards.</p>\n\n" +
  "<p>To conduct Business with integrity and strive to be a top Chamber in the Region.</p>\n\n" +
  "<h3><strong>Our Values</strong></h3>\n\n" +
  "<p> </p>\n\n" +
  "<p><strong>Respect</strong> – Treating all well and work with courtesy and respect, the way you want to be treated.</p>\n\n" +
  "<p><strong>Empathy</strong> – Listening and understanding the feelings and ideas of others.</p>\n\n" +
  "<p><strong>Shared Responsibility</strong> – taking ownership and working as a team through collaboration among all stakeholders.</p>\n\n" +
  "<p><strong>Consistency </strong>– being consistent in mastering and maintaining standards in services and overall the image of the institution.</p>\n\n" +
  "<p><strong>Innovation</strong> – constant creativity in Research, Development and services for value addition and exceeding expectations of members, stakeholders and employees</p>";

const PAGES: Record<string, () => ReactElement> = {
  "about-history": () => {
    const entry = navEntry("/about/history");
    return (
      <InteriorPage
        trail={entry.trail}
        title={entry.title}
        {...(entry.description ? { standfirst: entry.description } : {})}
        header="feature"
        meta={[`Established ${CHAMBER.foundedYear}`, CHAMBER.address.locality]}
        footer={
          <>
            <h2 className="font-display text-xl font-semibold tracking-tight text-ink-950">
              More about the chamber
            </h2>
            <div className="mt-5">
              <SectionIndex section="/about" exclude="/about/history" />
            </div>
          </>
        }
      >
        <EditorialBody html={ABOUT_HISTORY_BODY} />
      </InteriorPage>
    );
  },
};

function shell(markup: string, title: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Preview — ${title}</title>
<link rel="stylesheet" href="./preview.css">
<style>
  /* The app loads these through next/font, which does not run here. Named
     rather than loaded, so the preview is one request and works offline; the
     shapes differ from the built page but every size and weight is the real
     one. */
  :root {
    --font-newsreader: Georgia, "Times New Roman", serif;
    --font-inter: "Segoe UI", system-ui, sans-serif;
  }
  body { font-family: var(--font-inter); }
</style>
</head><body class="bg-white text-ink-800 antialiased">${markup}</body></html>`;
}

async function main(): Promise<number> {
  const name = process.argv[2] ?? "about-history";
  const page = PAGES[name];
  if (!page) {
    console.error(`No preview for ${name}. Known: ${Object.keys(PAGES).join(", ")}`);
    return 1;
  }

  const html = shell(renderToStaticMarkup(page()), name);
  const out = join(process.cwd(), "preview");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${name}.html`), html, "utf8");

  // The real stylesheet, compiled against the classes this page actually uses.
  // Tailwind normally scans the source tree; here the markup is already
  // rendered, so the candidates come off it directly and the output is only
  // what this one page needs.
  const { compile } = (await import("@tailwindcss/node")) as {
    compile: (
      css: string,
      options: { base: string; onDependency: (path: string) => void },
    ) => Promise<{ build: (candidates: string[]) => string }>;
  };

  const source = readFileSync(join(process.cwd(), "src", "app", "globals.css"), "utf8");
  const compiler = await compile(source, {
    base: join(process.cwd(), "src", "app"),
    onDependency: () => {},
  });

  const candidates = new Set<string>();
  for (const match of html.matchAll(/class="([^"]*)"/g)) {
    for (const token of (match[1] ?? "").split(/\s+/)) if (token) candidates.add(token);
  }
  writeFileSync(join(out, "preview.css"), compiler.build([...candidates]), "utf8");

  console.log(`preview/${name}.html  (${candidates.size} classes)`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
