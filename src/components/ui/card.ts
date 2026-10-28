/**
 * The chamber's card treatment, shared by every card grid on the homepage.
 *
 * A green hairline at rest rather than only on hover, so a grid reads as the
 * chamber's own before anyone touches it, and a small tilt towards the reader
 * on hover.
 *
 * Kept here rather than repeated per section because four grids use it: if the
 * outline weight or the tilt angle changes, it has to change in one place or
 * the page stops looking like one system.
 */

/**
 * Belongs on the grid, never on the card.
 *
 * Perspective is resolved against the element that declares it, so set
 * per-card every card gets its own vanishing point, every tilt looks identical
 * and the row reads flat. On the list, the cards share one viewpoint and the
 * ones at the edges lean away from it.
 */
export const CARD_GRID = "perspective-[1200px]";

/**
 * The card surface and its hover state.
 *
 * The movement is `motion-safe:` gated rather than merely shortened: anyone who
 * has asked their system for reduced motion gets the colour and shadow change
 * and nothing that moves. Tailwind also compiles `hover:` behind
 * `@media (hover: hover)`, so none of this can stick on a touch device after a
 * tap.
 */
export const CARD_BASE =
  "rounded-xl border border-brand-300 bg-white shadow-card " +
  "transform-gpu transition-all duration-300 ease-out " +
  "hover:border-brand-500 hover:shadow-raised " +
  "motion-safe:hover:-translate-y-1.5 motion-safe:hover:scale-[1.02] " +
  "motion-safe:hover:rotate-x-6";

/**
 * For a card that is itself the link, so the card takes focus (service tiles,
 * committees).
 */
export const CARD_FOCUS_SELF =
  "focus-visible:border-brand-500 " +
  "motion-safe:focus-visible:-translate-y-1.5 motion-safe:focus-visible:scale-[1.02] " +
  "motion-safe:focus-visible:rotate-x-6";

/**
 * For a card that only *wraps* a link, so focus lands on a descendant and the
 * card itself is never focusable (news, events).
 *
 * Without this the whole treatment would be mouse-only for those two grids.
 */
export const CARD_FOCUS_WITHIN =
  "focus-within:border-brand-500 " +
  "motion-safe:focus-within:-translate-y-1.5 motion-safe:focus-within:scale-[1.02] " +
  "motion-safe:focus-within:rotate-x-6";
