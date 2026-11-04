/**
 * Splitting a hero headline around the phrase that renders in brand green.
 *
 * The alternative was three columns — lead, highlight, tail — which removes
 * all matching but makes the editor responsible for the spaces between them.
 * A missing space is invisible in a form field and glaring at 60px on the
 * homepage, so the trade here is deliberate: one headline field, one optional
 * phrase, and a renderer that cannot break when they disagree.
 *
 * Kept out of the component so it can be tested without rendering anything,
 * and out of the repository because it is a presentation concern that the
 * stored row has no opinion about.
 */

export interface HeadlineParts {
  readonly before: string;
  /** Empty when there is nothing to highlight. */
  readonly highlight: string;
  readonly after: string;
}

/**
 * Split `headline` around the first occurrence of `highlight`.
 *
 * Returns the whole headline as `before` when there is no highlight to apply,
 * which covers every way this can legitimately fail: no phrase set, a phrase
 * an editor has since edited out of the headline, or a phrase that is only the
 * whitespace left behind by one. The caller then renders a plain headline —
 * correct copy without the green, rather than a missing or duplicated word.
 *
 * **First occurrence, and case-sensitive.** A headline containing its phrase
 * twice highlights the first; matching both would need the renderer to decide
 * which repetition an editor meant, and it cannot know. Case-sensitive because
 * "20,000 Businesses" and "20,000 businesses" are different copy, and quietly
 * greening the wrong casing hides the typo rather than showing it.
 */
export function splitHeadline(headline: string, highlight?: string | null): HeadlineParts {
  const phrase = highlight?.trim() ?? "";
  if (phrase === "") return { before: headline, highlight: "", after: "" };

  const at = headline.indexOf(phrase);
  if (at === -1) return { before: headline, highlight: "", after: "" };

  return {
    before: headline.slice(0, at),
    highlight: phrase,
    after: headline.slice(at + phrase.length),
  };
}
