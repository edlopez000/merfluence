import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import viewHtml from '../../src/view/index.html?raw';
import { placeMenu } from '../../src/lib/menu-placement.js';

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

/**
 * The export menu grew from "PNG"/"SVG" to a five-item cross-product of format
 * and backdrop, roughly tripling its widest label, and then collapsed back to
 * three actions plus a "Transparent background" toggle — which is now the widest
 * label in it. `.export-menu` is absolutely positioned at `right: 0`, so it grows
 * leftward — which is fine until the macro is in a narrow column and the popup
 * runs off the left edge of the page. That is a pure CSS outcome, invisible to
 * the jsdom suite in test/view-app.test.jsx, so the real labels are measured here
 * against the stylesheet that ships.
 */
describe('the export menu at its real label widths', () => {
  /** The open menu, anchored right, inside a root of the given width. */
  function mountMenu(rootWidth) {
    mounted = document.createElement('div');
    mounted.className = 'root';
    mounted.style.width = rootWidth;
    mounted.style.position = 'relative';
    mounted.innerHTML =
      '<div class="toolbar" role="toolbar">' +
      '<div class="export"><button type="button">Export ▾</button>' +
      '<div class="export-menu" role="menu">' +
      // Kept in step with src/view/main.tsx by hand. The width assertions below
      // are only worth anything against the labels that actually ship, and the
      // toggle carries the longest of them.
      '<button type="button" role="menuitem">Copy image</button>' +
      '<button type="button" role="menuitem">PNG</button>' +
      '<button type="button" role="menuitem">SVG</button>' +
      '<button type="button" role="menuitemcheckbox" aria-checked="false" class="option">' +
      '<span class="check" aria-hidden="true"></span>Transparent background</button>' +
      '</div></div></div>';
    document.body.append(mounted);
    return mounted.querySelector('.export-menu');
  }

  it('stays inside the macro even in a narrow column', async () => {
    // Narrower than a Confluence sidebar column, so this is the pessimistic case.
    const menu = mountMenu('220px');
    await settle();

    const menuBox = menu.getBoundingClientRect();
    const rootBox = mounted.getBoundingClientRect();
    expect(menuBox.width).toBeGreaterThan(0);
    expect(Math.round(menuBox.left)).toBeGreaterThanOrEqual(Math.round(rootBox.left));
    expect(Math.round(menuBox.right)).toBeLessThanOrEqual(Math.round(rootBox.right));
  });

  it('gives every item one line, so no label wraps', async () => {
    const menu = mountMenu('600px');
    await settle();

    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    // "SVG" cannot wrap, so it is the reference height for one line of text.
    const oneLine = items.at(-1).getBoundingClientRect().height;
    for (const item of items) {
      // A wrapped "Copy image" would be a line-box taller than that.
      expect(item.getBoundingClientRect().height).toBe(oneLine);
      // ...and the menu sizes to its widest child, so the label must also fit
      // without being clipped — equal heights alone would not rule that out.
      expect(item.scrollWidth).toBeLessThanOrEqual(item.clientWidth);
    }
  });

  // The toggle is measured apart from the loop above: it carries the separator's
  // padding and border, so its box is legitimately taller than one line of text.
  // Its *label* still has to fit on one line, which is what the widest string in
  // the menu is at risk of failing.
  it('fits the toggle label on one line too, tick and all', async () => {
    const menu = mountMenu('600px');
    await settle();

    const option = menu.querySelector('[role="menuitemcheckbox"]');
    const svg = [...menu.querySelectorAll('[role="menuitem"]')].at(-1);
    expect(option.scrollWidth).toBeLessThanOrEqual(option.clientWidth);
    // One line of text plus the separator's own padding, and nothing more.
    const textHeight = svg.getBoundingClientRect().height;
    expect(option.getBoundingClientRect().height).toBeLessThan(textHeight * 2);
  });

  /**
   * The vertical counterpart to the three width assertions above, and the reason
   * placeMenu exists: the macro's iframe is only as tall as its diagram, and it —
   * not any rule of ours — is what clips this popup. A short flowchart shipped a
   * menu with three of its four items outside the frame, unpainted.
   *
   * The viewport here is the test runner's, which is nothing like a macro's, so
   * the iframe height is supplied rather than measured. Everything else is real:
   * the menu's height is what the shipped stylesheet gives its shipped labels,
   * which is the number the arithmetic in test/menu-placement.test.js has to
   * assume and this test confirms.
   */
  it('is placed inside a macro iframe too short to hang it below the toolbar', async () => {
    const menu = mountMenu('600px');
    await settle();

    const anchor = menu.parentElement; // .export
    const menuHeight = menu.offsetHeight;
    // If this is ever false the fixture has drifted from the shipped menu and
    // the placement below is being asserted against nothing.
    expect(menuHeight).toBeGreaterThan(80);

    // A macro whose iframe has room for the menu, but not below the toolbar.
    const tight = menuHeight + 24;
    const raised = placeMenu({
      anchorTop: 6,
      anchorHeight: anchor.offsetHeight,
      menuHeight,
      viewportHeight: tight,
    });
    expect(raised.reserve).toBe(0);
    menu.style.top = `${raised.top}px`;
    await settle();
    // Measured against the anchor, since the real anchor is at viewport y=6 and
    // this fixture is wherever the test page put it.
    const offset = 6 - anchor.getBoundingClientRect().top;
    const bottom = menu.getBoundingClientRect().bottom + offset;
    expect(bottom).toBeLessThanOrEqual(tight);
    expect(menu.getBoundingClientRect().top + offset).toBeGreaterThanOrEqual(0);

    // And a macro shorter than the menu itself, where no offset can help.
    const short = Math.round(menuHeight / 2);
    const reserved = placeMenu({
      anchorTop: 6,
      anchorHeight: anchor.offsetHeight,
      menuHeight,
      viewportHeight: short,
    });
    expect(reserved.reserve).toBeGreaterThan(0);
    // The reservation has to be enough on its own — a second pass that asked for
    // more would mean the iframe grew, shrank and grew again.
    const after = placeMenu({
      anchorTop: 6,
      anchorHeight: anchor.offsetHeight,
      menuHeight,
      viewportHeight: short + reserved.reserve,
    });
    expect(after.reserve).toBe(0);
  });
});
