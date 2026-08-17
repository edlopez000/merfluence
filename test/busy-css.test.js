import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The busy-indicator primitives are duplicated across the two HTML shells,
 * which share no stylesheet — the same arrangement, and the same hazard, as the
 * Stage rules guarded by stage-css.test.js. A spinner added to one shell and
 * forgotten in the other is invisible until someone opens that view.
 *
 * The second thing checked here is subtler and is the reason this file exists
 * rather than a comment: `.reveal` carries its anti-flash delay as an
 * `animation-delay` with a `backwards` fill over a resting opacity of 1. Write
 * it the other way — `opacity: 0` plus `forwards` — and the indicator is
 * visible only while the animation runs, so anything that stops the animation
 * hides it permanently. The obvious next edit is exactly that: a reduced-motion
 * block that says `animation: none`, which is how this repo disables every
 * other animation. That edit would silently remove the whole feature for
 * reduced-motion users, and nothing else in the suite would notice.
 *
 * Grepped, not parsed, for the same reason as stage-css.test.js: the rules live
 * inline in the shells and there is no CSSOM here to parse them with. The
 * behavior these strings produce is asserted for real, in Chromium, in
 * test/browser/busy-reveal.integration.test.js.
 */

const here = dirname(fileURLToPath(import.meta.url));
const shells = {
  'src/view/index.html': readFileSync(join(here, '../src/view/index.html'), 'utf8'),
  'src/config/index.html': readFileSync(join(here, '../src/config/index.html'), 'utf8'),
};

/** A rule body with comments stripped — the declarations only. */
function rule(css, selector) {
  const match = css.match(new RegExp(`^\\s*${selector}\\s*\\{([\\s\\S]*?)\\}`, 'm'));
  return match ? match[1].replace(/\/\*[\s\S]*?\*\//g, '') : null;
}

/** The `@media (prefers-reduced-motion: reduce)` block, comments stripped. */
function reducedMotion(css) {
  const match = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n {6}\}/);
  return match ? match[1].replace(/\/\*[\s\S]*?\*\//g, '') : null;
}

describe('busy indicators are declared in both shells', () => {
  for (const [name, css] of Object.entries(shells)) {
    describe(name, () => {
      it('declares the spinner and its keyframes', () => {
        expect(rule(css, '\\.spinner'), `${name} declares .spinner`).not.toBeNull();
        expect(css).toMatch(/@keyframes spin\b/);
      });

      // The spinner has to keep turning while the main thread is busy
      // rendering, which is the entire wait it covers. Only compositor-driven
      // properties do that.
      it('animates the spinner on the compositor', () => {
        expect(rule(css, '\\.spinner')).toMatch(/animation:\s*spin/);
        expect(css).toMatch(/@keyframes spin\s*\{\s*to\s*\{\s*transform:\s*rotate/);
      });

      it('declares the delayed reveal and its keyframes', () => {
        expect(rule(css, '\\.reveal'), `${name} declares .reveal`).not.toBeNull();
        expect(css).toMatch(/@keyframes mf-reveal\b/);
      });

      // The fail-safe, in string form: visible at rest, delay carried by the
      // fill, so a stopped animation degrades to "shows immediately".
      it('rests visible and delays with a backwards fill', () => {
        const reveal = rule(css, '\\.reveal');
        expect(reveal).toMatch(/opacity:\s*1/);
        expect(reveal).toMatch(/backwards/);
        expect(reveal).not.toMatch(/opacity:\s*0/);
        expect(reveal).not.toMatch(/forwards/);
      });

      it('keeps the shared reveal delay short enough for a bare placeholder', () => {
        // Used bare by the whole-surface placeholders, which are the only thing
        // on screen while they show. Long delays belong to overlays.
        const delay = /animation:\s*mf-reveal[^;]*?(\d+)ms\s+backwards/.exec(
          rule(css, '\\.reveal'),
        );
        expect(delay, `${name} states a delay on .reveal`).not.toBeNull();
        expect(Number(delay[1])).toBeLessThanOrEqual(200);
      });

      it('never disables the reveal animation outright for reduced motion', () => {
        const block = reducedMotion(css);
        expect(block, `${name} has a reduced-motion block`).not.toBeNull();
        // .spinner may stop dead — its text carries the meaning. .reveal may
        // not: killing it takes the delay with it, and would take the
        // indicator itself with any future zero-opacity resting value.
        expect(block).toMatch(/\.reveal\s*\{[^}]*animation-duration/);
        expect(block).not.toMatch(/\.reveal\s*\{[^}]*animation:\s*none/);
      });
    });
  }
});

// The editor's chip is the one indicator that overlays content which is still
// on screen and still usable, so it waits far longer than the placeholders
// before saying anything. Keeping the two apart is the whole fix for "it feels
// slower": a threshold inside the measured 86-175ms render band made the chip
// appear on some renders and not others.
describe('the preview chip waits longer than the shared placeholders', () => {
  const css = shells['src/config/index.html'];

  it('overrides the delay on .preview-busy.reveal', () => {
    const override = rule(css, '\\.preview-busy\\.reveal');
    expect(override, 'src/config/index.html declares .preview-busy.reveal').not.toBeNull();
    expect(override).toMatch(/animation-delay:\s*\d+ms/);
  });

  it('sets it clear of the measured render band', () => {
    const chip = Number(
      /animation-delay:\s*(\d+)ms/.exec(rule(css, '\\.preview-busy\\.reveal'))[1],
    );
    const shared = Number(/mf-reveal[^;]*?(\d+)ms\s+backwards/.exec(rule(css, '\\.reveal'))[1]);

    expect(chip).toBeGreaterThan(shared);
    // 175ms was the slowest routine render measured in Chromium; below that the
    // chip narrates work nobody noticed.
    expect(chip).toBeGreaterThan(175);
  });
});
