import { beforeEach, describe, expect, it } from 'vitest';
import { act } from '@testing-library/react';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import { Stage } from '../src/components/Stage.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  // jsdom implements neither; Stage binds both at mount. Inert stubs suffice —
  // nothing here drives an observation.
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

/**
 * Pins Stage against React 19's dangerouslySetInnerHTML behavior: react-dom no
 * longer compares the previous and next HTML strings, so only the identity of
 * the { __html } object decides whether `innerHTML =` re-runs. If Stage passes
 * a fresh object literal, every re-render (each drag pointermove, each editor
 * keystroke) silently destroys and re-parses the whole SVG subtree. This test
 * fails in that regressed state: the injected <svg> node would be replaced.
 */
describe('Stage SVG identity across re-renders', () => {
  it('keeps the same injected SVG DOM node when the svg prop is unchanged', () => {
    const SVG = '<svg data-diagram="1"><rect width="10" height="10"></rect></svg>';
    let bump;

    function Harness() {
      const [, setTick] = useState(0);
      bump = () => setTick((n) => n + 1);
      return <Stage svg={SVG} useMaxWidth={true} height={null} />;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<Harness />);
    });

    const before = container.querySelector('svg');
    expect(before).not.toBeNull();

    // Re-render the parent with an identical svg prop, as a pan/zoom state
    // change or an editor keystroke does in the real apps.
    act(() => {
      bump();
    });
    act(() => {
      bump();
    });

    const after = container.querySelector('svg');
    // Same node instance, not just equal markup: replacement is the regression.
    expect(after).toBe(before);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('replaces the SVG DOM node when the svg prop actually changes', () => {
    let setSvg;

    function Harness() {
      const [svg, set] = useState('<svg data-diagram="a"></svg>');
      setSvg = set;
      return <Stage svg={svg} useMaxWidth={true} height={null} />;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<Harness />);
    });

    const before = container.querySelector('svg');
    act(() => {
      setSvg('<svg data-diagram="b"></svg>');
    });

    const after = container.querySelector('svg');
    expect(after).not.toBe(before);
    expect(after?.getAttribute('data-diagram')).toBe('b');

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
