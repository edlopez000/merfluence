/**
 * Vertical placement for the reader toolbar's Export menu.
 *
 * The menu is an absolutely positioned popup anchored under the "Export ▾"
 * trigger, and the toolbar sits at the top of a macro whose iframe is only as
 * tall as the diagram inside it. Nothing in our CSS clips the popup — the *host
 * iframe's own edge* does, and a browser simply does not paint what falls past
 * it. So on a short diagram the menu opened, dropped below the trigger, and the
 * bottom three of its four items were invisible and unreachable.
 *
 * Two moves fix that, in order of preference:
 *
 * 1. Slide the menu up until it sits inside the iframe, overlaying the top of
 *    the diagram. Free — the popup already has its own surface, border and
 *    shadow, so it reads as floating over the diagram — and it shifts nothing on
 *    the page.
 * 2. Only when the iframe is shorter than the menu itself, so no offset can
 *    contain it: report how many pixels of extra document height are needed. The
 *    caller reserves that below the macro, the auto-sizing host grows the
 *    iframe, and the menu fits. This costs a reflow of the page below, which is
 *    why it is the fallback and not the mechanism.
 *
 * The arithmetic lives here rather than in the component because it is the part
 * that fails silently when wrong — a menu placed 30px too low looks fine in a
 * tall test viewport and is invisible in a real macro — so it carries a unit
 * test at sizes no browser test can conveniently reproduce.
 */

/** Distance between the trigger and the menu below it. Matches the CSS default
 *  (`top: calc(100% + 4px)`), so a menu that fits below lands exactly where the
 *  stylesheet alone would have put it. */
const GAP = 4;

/** Breathing room kept between the menu and the iframe's edges, matching the
 *  toolbar's own 4px inset from the top. */
const MARGIN = 4;

export type MenuPlacement = {
  /** `top` for the menu, in px **relative to its positioned parent** (the
   *  `.export` wrapper) — i.e. straight into the style property it overrides. */
  top: number;
  /** Extra document height the macro must reserve for the menu to be visible,
   *  or 0 when sliding it up was enough. */
  reserve: number;
};

export type MenuGeometry = {
  /** The trigger wrapper's top, in viewport coordinates. */
  anchorTop: number;
  /** The trigger wrapper's height. */
  anchorHeight: number;
  /** The menu's own laid-out height. */
  menuHeight: number;
  /** The iframe's visible height (`documentElement.clientHeight`). */
  viewportHeight: number;
};

/**
 * Where to put the menu, and how much room the macro still has to make for it.
 */
export function placeMenu({
  anchorTop,
  anchorHeight,
  menuHeight,
  viewportHeight,
}: MenuGeometry): MenuPlacement {
  // The default: hanging below the trigger, which is where the CSS puts it.
  const below = anchorTop + anchorHeight + GAP;

  // Case 1 — it fits below. Return the CSS's own offset rather than a computed
  // equivalent, so the common case is pixel-for-pixel what it always was.
  if (below + menuHeight <= viewportHeight - MARGIN) {
    return { top: anchorHeight + GAP, reserve: 0 };
  }

  // Case 2 — it doesn't fit below, but it fits in the viewport. Pin its bottom
  // to the iframe's bottom edge and let it overlay the diagram.
  const raised = viewportHeight - MARGIN - menuHeight;
  if (raised >= MARGIN) {
    return { top: raised - anchorTop, reserve: 0 };
  }

  // Case 3 — the iframe is shorter than the menu, so no offset contains it.
  // Leave it under the trigger (raising it would only clip the top instead of
  // the bottom, and hide the item nearest the button the user just pressed) and
  // ask for the shortfall. Once the host grows the iframe, the window resize
  // that follows re-runs this and case 1 or 2 takes over.
  return {
    top: anchorHeight + GAP,
    reserve: below + menuHeight + MARGIN - viewportHeight,
  };
}
