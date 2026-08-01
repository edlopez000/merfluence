import { describe, expect, it } from 'vitest';
import { ensureAccessibleName } from '../src/lib/a11y-name.js';

/**
 * The text-alternative transform (WCAG 2.1 SC 1.1.1), unit-tested against the
 * two SVG shapes Mermaid actually produces: one where the author wrote
 * accTitle/accDescr, and one where they didn't.
 *
 * This runs in jsdom rather than the browser project because the transform is
 * pure string-to-string DOM surgery — no layout, no getBBox, no Mermaid. The
 * end-to-end proof that Mermaid really emits these shapes lives in
 * test/browser/render.integration.test.js, which drives the real renderer.
 */

const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" id="mmd-abc-0"';

/** Assertions work on the parsed result, so nothing can pass on string luck. */
function transformed(markup) {
  const out = ensureAccessibleName(markup);
  const doc = new DOMParser().parseFromString(`<div>${out}</div>`, 'text/html');
  return { out, svg: doc.querySelector('svg'), doc };
}

/** Resolve the accessible name the way assistive tech does. */
function accessibleName(svg) {
  const label = svg.getAttribute('aria-label');
  if (label) return label;
  const id = svg.getAttribute('aria-labelledby');
  if (!id) return null;
  const target = svg.querySelector(`#${CSS.escape(id)}`);
  return target ? target.textContent : null;
}

/** As Mermaid emits it when the source carries accTitle / accDescr. */
function mermaidSvg({ type = 'flowchart-v2', accTitle, accDescr } = {}) {
  const attrs = [`role="graphics-document document"`, `aria-roledescription="${type}"`];
  const kids = [];
  if (accDescr) {
    attrs.push('aria-describedby="chart-desc-mmd-abc-0"');
    kids.push(`<desc id="chart-desc-mmd-abc-0">${accDescr}</desc>`);
  }
  if (accTitle) {
    attrs.push('aria-labelledby="chart-title-mmd-abc-0"');
    kids.push(`<title id="chart-title-mmd-abc-0">${accTitle}</title>`);
  }
  return `${SVG_OPEN} ${attrs.join(' ')}><g><text>Start</text></g>${kids.join('')}</svg>`;
}

describe('an undescribed diagram is named after its type', () => {
  it('names it with an aria-label, not an injected <title>', () => {
    const { svg } = transformed(mermaidSvg());

    expect(accessibleName(svg)).toBe('Flowchart diagram');
    // Deliberately not a <title>: on the root that paints as a tooltip over the
    // whole canvas — under a cursor whose job is to drag and pan — and Chromium
    // reports it as the accessible description too, so the name is announced
    // twice. The marker is what tells a later pass this name is ours.
    expect(svg.querySelector('title')).toBeNull();
    expect(svg.getAttribute('data-mf-named')).toBe('type');
  });

  it("keeps Mermaid's role so the node text stays browsable", () => {
    const { svg } = transformed(mermaidSvg());

    // Deliberately NOT role="img": that would make the graphic atomic and hide
    // every node label behind the two words we synthesised.
    expect(svg.getAttribute('role')).toBe('graphics-document document');
    expect(svg.querySelector('text').textContent).toBe('Start');
  });

  it('drops the roledescription that would repeat the name', () => {
    const { svg } = transformed(mermaidSvg());

    // "Flowchart diagram, flowchart diagram" is noise, not information.
    expect(svg.hasAttribute('aria-roledescription')).toBe(false);
  });

  it.each([
    ['flowchart-v2', 'Flowchart diagram'],
    ['flowchart-elk', 'Flowchart diagram'],
    ['sequence', 'Sequence diagram'],
    ['classDiagram-v2', 'Class diagram'],
    ['stateDiagram-v2', 'State diagram'],
    ['er', 'Entity relationship diagram'],
    ['pie', 'Pie chart'],
    ['gantt', 'Gantt chart'],
    ['xychart-beta', 'XY chart'],
    ['mindmap', 'Mind map'],
    ['gitGraph', 'Git graph'],
    ['kanban', 'Kanban board'],
  ])('reads %s as "%s"', (type, expected) => {
    const { svg } = transformed(mermaidSvg({ type }));
    expect(accessibleName(svg)).toBe(expected);
  });

  it('humanises a type it has never seen', () => {
    // Mermaid keeps adding diagram types and we ship two majors, so an
    // unrecognised id has to degrade to something useful rather than to
    // "Diagram". A hyphenated/camelCase id is the shape they all take.
    const { svg } = transformed(mermaidSvg({ type: 'quantumFoam-beta' }));
    expect(accessibleName(svg)).toBe('Quantum foam diagram');
  });

  it('does not append "diagram" to a type that already says it', () => {
    const { svg } = transformed(mermaidSvg({ type: 'treemap' }));
    expect(accessibleName(svg)).toBe('Treemap diagram');

    const radar = transformed(mermaidSvg({ type: 'someRadarChart' }));
    expect(accessibleName(radar.svg)).toBe('Some radar chart');
  });

  it.each([
    ['a missing roledescription', `${SVG_OPEN}><g /></svg>`],
    ['an empty one', `${SVG_OPEN} aria-roledescription=""><g /></svg>`],
    ['one full of punctuation', `${SVG_OPEN} aria-roledescription="!!!"><g /></svg>`],
    [
      'one longer than any real type id',
      `${SVG_OPEN} aria-roledescription="${'a'.repeat(60)}"><g /></svg>`,
    ],
  ])('falls back to a generic name given %s', (_why, markup) => {
    const { svg } = transformed(markup);
    expect(accessibleName(svg)).toBe('Diagram');
  });
});

describe("a described diagram keeps the author's text", () => {
  it('becomes an atomic image named by accTitle', () => {
    const { svg } = transformed(mermaidSvg({ accTitle: 'Deploy pipeline' }));

    // The author's prose IS the alternative, so reading the node labels on top
    // of it would be noise — role="img" is right here and only here.
    expect(svg.getAttribute('role')).toBe('img');
    expect(accessibleName(svg)).toBe('Deploy pipeline');
    // Mermaid's own wiring is left alone rather than rebuilt.
    expect(svg.getAttribute('aria-labelledby')).toBe('chart-title-mmd-abc-0');
    // The type still rides along, where it adds to the name instead of
    // repeating it: "Deploy pipeline, Flowchart diagram".
    expect(svg.getAttribute('aria-roledescription')).toBe('Flowchart diagram');
  });

  it('keeps accDescr wired as the description', () => {
    const { svg } = transformed(
      mermaidSvg({ accTitle: 'Deploy pipeline', accDescr: 'PR to production.' }),
    );

    expect(svg.getAttribute('aria-describedby')).toBe('chart-desc-mmd-abc-0');
    expect(svg.querySelector('desc').textContent).toBe('PR to production.');
  });

  it('names an accDescr that arrived without an accTitle', () => {
    // A description with nothing naming it. Supply the type so the description
    // has something to hang off, rather than leaving an unnamed image.
    const { svg } = transformed(mermaidSvg({ accDescr: 'PR to production.' }));

    expect(svg.getAttribute('role')).toBe('img');
    expect(accessibleName(svg)).toBe('Flowchart diagram');
    expect(svg.getAttribute('aria-describedby')).toBe('chart-desc-mmd-abc-0');
  });

  it('leaves an aria-label the author wrote alone', () => {
    const { svg } = transformed(
      `${SVG_OPEN} aria-roledescription="pie" aria-label="Adoptions by month"><g /></svg>`,
    );

    expect(accessibleName(svg)).toBe('Adoptions by month');
    // Unmarked, so it reads as the author's — and an author's name earns the
    // atomic role just as an accTitle does.
    expect(svg.getAttribute('role')).toBe('img');
  });

  it('ignores a dangling reference and names the diagram itself', () => {
    // aria-labelledby pointing at nothing is not a name. Repair it rather than
    // trusting it.
    const { svg } = transformed(
      `${SVG_OPEN} aria-roledescription="sequence" aria-labelledby="gone"><g /></svg>`,
    );

    expect(accessibleName(svg)).toBe('Sequence diagram');
    expect(svg.getAttribute('role')).toBe('graphics-document document');
  });

  it('ignores a <title> tooltip buried in the tree', () => {
    // A `click ... "tooltip"` directive puts <title> on a node, not on the
    // root. Only a direct child of the root can be the diagram's own name.
    const { svg } = transformed(
      `${SVG_OPEN} aria-roledescription="flowchart-v2" aria-labelledby="tip">` +
        '<g><title id="tip">Node tooltip</title></g></svg>',
    );

    expect(accessibleName(svg)).toBe('Flowchart diagram');
  });
});

describe('the transform is safe to re-run and safe on hostile input', () => {
  // Not a theoretical property: every cache hit re-runs this over SVG that
  // renderDiagram already ran it over at save time, so the second pass is the
  // common one. Getting it wrong would read our own synthesised name back as an
  // author's and quietly promote the graphic to role="img", hiding the node
  // labels it was meant to keep reachable.
  it('is idempotent on an undescribed diagram', () => {
    const once = ensureAccessibleName(mermaidSvg());
    const twice = ensureAccessibleName(once);

    expect(twice).toBe(once);
    const { svg } = transformed(twice);
    expect(accessibleName(svg)).toBe('Flowchart diagram');
    expect(svg.getAttribute('role')).toBe('graphics-document document');
  });

  it('is idempotent on a described diagram', () => {
    const once = ensureAccessibleName(mermaidSvg({ accTitle: 'Deploy pipeline' }));
    expect(ensureAccessibleName(once)).toBe(once);
  });

  it('is idempotent on an accDescr-only diagram', () => {
    const once = ensureAccessibleName(mermaidSvg({ accDescr: 'PR to production.' }));
    expect(ensureAccessibleName(once)).toBe(once);
  });

  it('cannot be made to inject markup through the diagram type', () => {
    // On the cache path aria-roledescription comes from macro config, which
    // anyone who can edit the page can author. It reaches the name only as
    // textContent — and the character guard rejects this long before that.
    const { svg, out } = transformed(
      `${SVG_OPEN} aria-roledescription="&lt;img src=x onerror=alert(1)&gt;"><g /></svg>`,
    );

    expect(out).not.toContain('<img');
    expect(svg.querySelector('img')).toBeNull();
    expect(accessibleName(svg)).toBe('Diagram');
  });

  it.each([
    ['markup with no <svg> root', '<div>not a diagram</div>'],
    ['an empty string', ''],
  ])('returns %s unchanged', (_why, markup) => {
    expect(ensureAccessibleName(markup)).toBe(markup);
  });

  it.each([
    [null, ''],
    [undefined, ''],
  ])('turns %s into an empty string', (input, expected) => {
    expect(ensureAccessibleName(input)).toBe(expected);
  });

  it('names an SVG that arrived without an id', () => {
    // Nothing guarantees a root id — a hand-edited cached SVG may have lost it.
    const { svg } = transformed(
      '<svg xmlns="http://www.w3.org/2000/svg" aria-roledescription="pie"><g /></svg>',
    );

    expect(accessibleName(svg)).toBe('Pie chart');
  });

  it('preserves the diagram it is labelling', () => {
    // Positive control: the round-trip through innerHTML must not quietly drop
    // camelCase SVG attributes or mangle the geometry.
    const { svg } = transformed(
      `${SVG_OPEN} viewBox="0 0 100 50" preserveAspectRatio="xMidYMid meet" ` +
        'aria-roledescription="flowchart-v2" style="max-width: 100px">' +
        '<style>#mmd-abc-0 { font-family: sans-serif }</style>' +
        '<g transform="translate(1,2)"><text textLength="5">A &amp; B</text></g></svg>',
    );

    expect(svg.getAttribute('viewBox')).toBe('0 0 100 50');
    expect(svg.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
    expect(svg.getAttribute('style')).toContain('max-width');
    expect(svg.querySelector('style').textContent).toContain('font-family');
    expect(svg.querySelector('g').getAttribute('transform')).toBe('translate(1,2)');
    expect(svg.querySelector('text').getAttribute('textLength')).toBe('5');
    expect(svg.querySelector('text').textContent).toBe('A & B');
  });
});
