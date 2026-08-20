import { describe, expect, it } from 'vitest';
import { placeMenu } from '../src/lib/menu-placement.js';

/**
 * The real geometry this is solving for: the toolbar is inset 4px from the top
 * of the macro and about 32px tall, and the export menu is roughly 120px of
 * four items. The numbers below are that shape at three iframe heights.
 */
const ANCHOR_TOP = 6;
const ANCHOR_HEIGHT = 28;
const MENU_HEIGHT = 120;

const place = (viewportHeight, over = {}) =>
  placeMenu({
    anchorTop: ANCHOR_TOP,
    anchorHeight: ANCHOR_HEIGHT,
    menuHeight: MENU_HEIGHT,
    viewportHeight,
    ...over,
  });

/** The menu's top and bottom in viewport coordinates, given a placement. */
const box = (placement, viewportHeight, menuHeight = MENU_HEIGHT) => {
  const top = ANCHOR_TOP + placement.top;
  return { top, bottom: top + menuHeight, viewportHeight: viewportHeight + placement.reserve };
};

describe('placeMenu', () => {
  it('hangs the menu below the trigger when the iframe has room, changing nothing', () => {
    const placement = place(600);
    // Exactly the stylesheet's own `top: calc(100% + 4px)`, so a tall diagram
    // gets the placement it always had.
    expect(placement).toEqual({ top: ANCHOR_HEIGHT + 4, reserve: 0 });
  });

  it('stays below the trigger right down to the last pixel that fits', () => {
    // Anchor bottom (34) + gap (4) + menu (120) + margin (4) = 162.
    expect(place(162)).toEqual({ top: ANCHOR_HEIGHT + 4, reserve: 0 });
  });

  it('slides the menu up to sit inside a short iframe, rather than past its edge', () => {
    const viewportHeight = 150;
    const placement = place(viewportHeight);
    expect(placement.reserve).toBe(0);
    // Raised, but still hanging off the trigger rather than jumping above it.
    expect(placement.top).toBeLessThan(ANCHOR_HEIGHT + 4);
    const { top, bottom } = box(placement, viewportHeight);
    expect(bottom).toBe(viewportHeight - 4);
    expect(top).toBeGreaterThanOrEqual(4);
  });

  it('never raises the menu past the top edge, which would clip the other end', () => {
    // 128 is the tightest viewport the menu still fits in: 4 + 120 + 4.
    const placement = place(128);
    expect(placement.reserve).toBe(0);
    const { top, bottom } = box(placement, 128);
    expect(top).toBe(4);
    expect(bottom).toBe(124);
  });

  it('reserves the shortfall when the iframe is shorter than the menu itself', () => {
    const viewportHeight = 100;
    const placement = place(viewportHeight);
    // No offset can contain a 120px menu in a 100px iframe, so it goes back
    // under the trigger and asks for room instead.
    expect(placement.top).toBe(ANCHOR_HEIGHT + 4);
    expect(placement.reserve).toBeGreaterThan(0);
    const { bottom, viewportHeight: grown } = box(placement, viewportHeight);
    expect(bottom).toBe(grown - 4);
  });

  it('reserves exactly enough that a re-measure then places it without reserving again', () => {
    // The fixed point that keeps the reservation from oscillating: whatever the
    // first pass asks for, the second pass in the grown iframe must be content.
    const first = place(100);
    const second = place(100 + first.reserve);
    expect(second.reserve).toBe(0);
  });

  it('handles a menu taller than the whole macro, the pathological case', () => {
    const placement = place(40, { menuHeight: 400 });
    expect(placement.top).toBe(ANCHOR_HEIGHT + 4);
    const { bottom, viewportHeight: grown } = box(placement, 40, 400);
    expect(bottom).toBe(grown - 4);
  });
});
