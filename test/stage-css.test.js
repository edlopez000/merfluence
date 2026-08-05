import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The pan layer must not be promoted to a compositor layer.
 *
 * This looks like the one obvious optimization to make here — `.pan`'s
 * transform is rewritten on every frame of a pan or zoom, which is the
 * textbook case for `will-change: transform` — and it was in fact made, and
 * shipped, and it broke the product's core promise.
 *
 * Promotion means the browser rasterizes the diagram once and lets the
 * compositor scale that bitmap. Zooming then magnifies pixels rather than
 * re-rendering the vector. It is worst on exactly the diagrams that most need
 * zoom: at high zoom a large diagram's raster exceeds the GPU texture limit,
 * so the layer is rasterized at a capped scale and stays blurry permanently
 * instead of sharpening once the gesture settles. Measured in Chromium at 6x
 * on a 4000px-wide diagram: visibly soft with the hint, crisp without it.
 *
 * Re-rasterizing per frame is not the cost to avoid — it is the crispness, and
 * rendering SVG in the browser is the whole reason this app exists. Anything
 * that hands the compositor a bitmap of the diagram (`will-change: transform`,
 * `translateZ(0)`/`translate3d` hacks, `backface-visibility: hidden`) gives
 * that away, so the check covers the family rather than the one property.
 *
 * Grepped, not parsed: there is no CSSOM in this project to parse with, the
 * rules live inline in the two HTML shells, and the string is what matters.
 */

const here = dirname(fileURLToPath(import.meta.url));
const shells = {
  'src/view/index.html': readFileSync(join(here, '../src/view/index.html'), 'utf8'),
  'src/config/index.html': readFileSync(join(here, '../src/config/index.html'), 'utf8'),
};

/**
 * The `.pan { … }` rule body with comments stripped — the declarations only.
 * The comment inside that rule names the very properties being checked for
 * (that is its job), so leaving it in would fail every assertion below.
 */
function panRule(css) {
  const match = css.match(/^\s*\.pan\s*\{([\s\S]*?)\}/m);
  return match ? match[1].replace(/\/\*[\s\S]*?\*\//g, '') : null;
}

describe('the pan layer is never compositor-promoted', () => {
  for (const [name, css] of Object.entries(shells)) {
    describe(name, () => {
      // Guard the guard: a renamed class would make every assertion below pass
      // by matching nothing at all.
      it('has a .pan rule to check', () => {
        expect(panRule(css), `${name} declares .pan`).not.toBeNull();
      });

      it('does not promote it with will-change', () => {
        expect(panRule(css)).not.toMatch(/will-change/i);
      });

      it('does not promote it with a 3D-transform or backface hack', () => {
        const rule = panRule(css) ?? '';
        expect(rule).not.toMatch(/translate3d|translateZ|backface-visibility/i);
      });
    });
  }

  it('keeps the reasoning next to the rule, not only here', () => {
    // The comment is what stops the next person re-adding it; a bare absence
    // reads like an oversight and invites the same "fix".
    expect(shells['src/view/index.html']).toMatch(/NOT will-change/i);
    expect(shells['src/config/index.html']).toMatch(/NOT will-change/i);
  });
});
