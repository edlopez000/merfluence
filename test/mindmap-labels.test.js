import { describe, expect, it } from 'vitest';
import { centerMindmapLabels } from '../src/lib/mindmap-labels.js';

/**
 * The mindmap label repair, unit-tested against the two mindmap SVG shapes our
 * two pinned Mermaid majors actually produce — major 11's unified renderer,
 * which needs the fix, and major 10's, which must come through untouched.
 *
 * jsdom rather than the browser project, because the transform is pure
 * string-to-string DOM surgery: no layout, no getBBox, no Mermaid. The proof
 * that it lands the text inside the node on a real render lives in
 * test/browser/render.integration.test.js, which measures the geometry.
 */

const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" id="mmd-abc-0">';

/** A major-11 mindmap node: label group carries `label`, text is start-anchored. */
function v11Node({ shape = 'circle', x = '0', y = '-9.5', label = 'mindmap' } = {}) {
  return (
    `<g class="node mindmap-node section-root" id="node_0">` +
    (shape === 'circle' ? '<circle class="basic label-container" r="43.7"/>' : '<rect/>') +
    `<g class="label" transform="translate(${x}, ${y})">` +
    `<rect/><g><rect class="background"/>` +
    `<text y="-10.1"><tspan class="text-outer-tspan row" x="0" y="-0.1em" dy="1.1em">${label}</tspan></text>` +
    `</g></g></g>`
  );
}

/** A major-10 mindmap node: unclassed label group, already anchored and offset. */
function v10Node() {
  return (
    `<g class="mindmap-node section-0" transform="translate(288, 199)">` +
    `<g><path class="node-bkg node-no-border" d="M0 32.8"/></g>` +
    `<g dy="1em" text-anchor="middle" transform="translate(35.8, 5)">` +
    `<g><rect class="background"/><text y="-10.1"><tspan x="0">Origins</tspan></text></g>` +
    `</g></g>`
  );
}

const wrap = (body) => `${SVG_OPEN}<g class="nodes">${body}</g></svg>`;

/** Assertions work on the parsed result, so nothing can pass on string luck. */
function transformed(markup) {
  const out = centerMindmapLabels(markup);
  const doc = new DOMParser().parseFromString(`<div>${out}</div>`, 'text/html');
  return { out, doc };
}

describe('a Mermaid 11 mindmap gets its labels centred', () => {
  it('anchors the text at middle and zeroes the label translate', () => {
    const { doc } = transformed(wrap(v11Node()));
    const label = doc.querySelector('g.mindmap-node > g.label');

    // Both halves are the fix. Anchoring alone leaves the shapes that already
    // self-centre shifted left by half their width; zeroing alone leaves the
    // start-anchored text running off the right edge of every other shape.
    expect(label.querySelector('text').getAttribute('text-anchor')).toBe('middle');
    expect(label.getAttribute('transform')).toBe('translate(0, -9.5)');
  });

  it('keeps the vertical offset, which was never wrong', () => {
    const { doc } = transformed(wrap(v11Node({ x: '-93.9296875', y: '-18.049999237060547' })));

    expect(doc.querySelector('g.label').getAttribute('transform')).toBe(
      'translate(0, -18.049999237060547)',
    );
  });

  it('fixes every node, whatever its shape', () => {
    const markup = wrap(
      v11Node({ shape: 'circle', label: 'root' }) +
        v11Node({ shape: 'rect', x: '-45.4', label: 'plain node' }),
    );
    const { doc } = transformed(markup);

    const labels = [...doc.querySelectorAll('g.mindmap-node > g.label')];
    expect(labels).toHaveLength(2);
    for (const label of labels) {
      expect(label.getAttribute('transform')).toMatch(/^translate\(0,/);
      expect(label.querySelector('text').getAttribute('text-anchor')).toBe('middle');
    }
  });

  it('anchors a label group that carries no transform at all', () => {
    const markup = wrap(
      `<g class="node mindmap-node"><rect/><g class="label"><text>Origins</text></g></g>`,
    );
    const { doc } = transformed(markup);
    const label = doc.querySelector('g.label');

    // Nothing to zero: the group already sits on the node origin, so anchoring
    // is the whole fix. Inventing a transform here would be a second guess.
    expect(label.querySelector('text').getAttribute('text-anchor')).toBe('middle');
    expect(label.hasAttribute('transform')).toBe(false);
  });

  it('is idempotent, because the cache path re-runs it over its own output', () => {
    const once = centerMindmapLabels(wrap(v11Node()));

    expect(centerMindmapLabels(once)).toBe(once);
  });
});

describe('everything else is left alone', () => {
  it('does not touch a Mermaid 10 mindmap, whose labels are already centred', () => {
    const markup = wrap(v10Node());

    // Major 10 offsets its label to +width/2 from a corner-anchored node group.
    // Zeroing that would shove the text to the node's left edge — which is why
    // the selector keys on the `label` class only major 11 emits.
    expect(centerMindmapLabels(markup)).toBe(markup);
  });

  it('returns a non-mindmap diagram byte-identical, without a DOM round trip', () => {
    const markup = `${SVG_OPEN}<g class="node default"><g class="label" transform="translate(0, -9.5)"><text>Start</text></g></g></svg>`;

    expect(centerMindmapLabels(markup)).toBe(markup);
  });

  it('survives empty and missing input', () => {
    expect(centerMindmapLabels('')).toBe('');
    expect(centerMindmapLabels(null)).toBe('');
    expect(centerMindmapLabels(undefined)).toBe('');
  });
});
