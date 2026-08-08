import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import viewHtml from '../../src/view/index.html?raw';

/**
 * Why the export's "Exporting…" chip is a `.status` element rather than markup
 * of its own.
 *
 * The toolbar is hidden at rest and revealed on hover (`.root:hover .toolbar`),
 * so a PNG export — which takes long enough to be worth reporting — otherwise
 * runs with nothing on screen the moment the pointer moves off the macro. The
 * chip reuses `.status` precisely so the existing `.toolbar:has(.status)` rule
 * pins the toolbar open for the duration. That is a CSS fact, invisible to the
 * jsdom suite that covers the React side (test/view-app.test.jsx), so it is
 * asserted here against the stylesheet that actually ships.
 */

const styleCss = viewHtml.match(/<style>([\s\S]*?)<\/style>/)[1];

let styleEl = null;
let mounted = null;

beforeAll(() => {
  styleEl = document.createElement('style');
  styleEl.textContent = styleCss;
  document.head.append(styleEl);
});

afterAll(() => {
  styleEl?.remove();
  styleEl = null;
});

afterEach(() => {
  mounted?.remove();
  mounted = null;
});

/** The reader's toolbar, with or without the export in flight. Never hovered. */
function mount({ busy }) {
  mounted = document.createElement('div');
  mounted.className = 'root';
  mounted.innerHTML =
    '<div class="toolbar" role="toolbar"><button type="button">Export</button>' +
    (busy
      ? '<span class="status busy" role="status"><span class="spinner"></span>Exporting…</span>'
      : '') +
    '</div>';
  document.body.append(mounted);
  return {
    toolbar: mounted.querySelector('.toolbar'),
    spinner: mounted.querySelector('.spinner'),
  };
}

// The toolbar's reveal is a 120ms opacity transition; let it settle before
// reading, so a mid-transition value is never mistaken for the resting one.
const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

describe('the export progress chip', () => {
  it('holds the toolbar open while it is mounted, with no pointer on the macro', async () => {
    const idle = mount({ busy: false });
    await settle();
    // The premise: at rest, un-hovered, the toolbar really is invisible.
    expect(getComputedStyle(idle.toolbar).opacity).toBe('0');
    mounted.remove();

    const exporting = mount({ busy: true });
    await settle();
    expect(getComputedStyle(exporting.toolbar).opacity).toBe('1');
  });

  it('reads as neutral rather than as the failure it shares a class with', async () => {
    const { toolbar } = mount({ busy: true });
    const chip = toolbar.querySelector('.status');
    const failureChip = document.createElement('span');
    failureChip.className = 'status';
    toolbar.append(failureChip);
    await settle();

    // Same slot, same position, different colour: the danger tokens are what
    // .status alone gets, and .busy has to override all three.
    const busyStyle = getComputedStyle(chip);
    const failStyle = getComputedStyle(failureChip);
    expect(busyStyle.backgroundColor).not.toBe(failStyle.backgroundColor);
    expect(busyStyle.color).not.toBe(failStyle.color);
    expect(busyStyle.borderTopColor).not.toBe(failStyle.borderTopColor);
  });

  it('animates the spinner on the compositor, so it survives a busy main thread', async () => {
    const { spinner } = mount({ busy: true });
    await settle();

    const [animation] = spinner.getAnimations();
    expect(animation).toBeDefined();
    expect(animation.playState).toBe('running');
    // A transform animation is the compositor-eligible kind. Animating a
    // property that forces layout or paint would stall on exactly the frames
    // this spinner exists to cover.
    const props = new Set(animation.effect.getKeyframes().flatMap((f) => Object.keys(f)));
    expect(props).toContain('transform');
  });
});
