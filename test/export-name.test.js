import { describe, expect, it } from 'vitest';
import { ensureAccessibleName } from '../src/lib/a11y-name.js';
import { exportBaseName, exportFilename } from '../src/lib/export-name.js';

/**
 * Export filenames. Every export used to be called `diagram`, which is how a
 * Downloads folder fills with `diagram (3).png`.
 *
 * The SVGs here are built by running the real `ensureAccessibleName` over the
 * markup Mermaid emits, rather than by hand-writing the attributes the name
 * derivation reads. That is the point: the type half of the name depends on
 * which branch of that transform ran, so a change there that moved the label to
 * a different attribute has to fail here rather than silently degrade every
 * filename to "diagram".
 */

/** A fixed instant, so the stamp is assertable. Deliberately single-digit in
 *  month, day, hour, minute and second — that is the padding case. */
const NOW = new Date(2026, 7, 8, 14, 3, 5);
const STAMP = '20260808-140305';

/** Local, not UTC: the same Date read through the local getters the code uses. */
const stampOf = (d) =>
  [d.getFullYear(), d.getMonth() + 1, d.getDate()]
    .map((n, i) => String(n).padStart(i ? 2 : 4, '0'))
    .join('') +
  '-' +
  [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join('');

/** As Mermaid emits it, then named the way the reader names it before painting. */
function rendered({ type = 'flowchart-v2', accTitle } = {}) {
  const attrs = [
    'xmlns="http://www.w3.org/2000/svg"',
    'role="graphics-document document"',
    `aria-roledescription="${type}"`,
  ];
  let kids = '';
  if (accTitle) {
    attrs.push('aria-labelledby="chart-title-mmd-abc-0"');
    kids = `<title id="chart-title-mmd-abc-0">${accTitle}</title>`;
  }
  const named = ensureAccessibleName(`<svg ${attrs.join(' ')}>${kids}</svg>`);
  const doc = new DOMParser().parseFromString(`<div>${named}</div>`, 'text/html');
  return doc.querySelector('svg');
}

/** The descriptive half, with the timestamp trimmed off. */
const nameOf = (source, svg) => exportBaseName(source, svg, NOW).replace(`-${STAMP}`, '');

describe('title from the source', () => {
  it('prefers frontmatter over accTitle, and accTitle over a title directive', () => {
    const all = [
      '---',
      'title: Deploy pipeline',
      '---',
      'flowchart TD',
      '  accTitle: Release flow',
      '  title Quarterly spend',
    ].join('\n');
    expect(nameOf(all, rendered())).toBe('deploy-pipeline');

    const noFront = 'flowchart TD\n  accTitle: Release flow\n  title Quarterly spend';
    expect(nameOf(noFront, rendered())).toBe('release-flow');

    expect(nameOf('pie\n  title Quarterly spend\n  "A" : 1', rendered({ type: 'pie' }))).toBe(
      'quarterly-spend',
    );
  });

  it('accepts both the key and the directive spelling, quoted or bare', () => {
    expect(nameOf('---\ntitle: "Deploy pipeline"\n---\nflowchart TD', rendered())).toBe(
      'deploy-pipeline',
    );
    expect(nameOf("---\ntitle: 'Deploy pipeline'\n---\nflowchart TD", rendered())).toBe(
      'deploy-pipeline',
    );
    expect(nameOf('gantt\n  title Q3 roadmap', rendered({ type: 'gantt' }))).toBe('q3-roadmap');
  });

  // A frontmatter block that carries config but no title must not let some other
  // key answer for it, and must not hide a title directive in the body either.
  it('does not read a body directive as a frontmatter title, or vice versa', () => {
    const configOnly = ['---', 'config:', '  theme: forest', '---', 'pie', '  title Spend'].join(
      '\n',
    );
    expect(nameOf(configOnly, rendered({ type: 'pie' }))).toBe('spend');
  });

  it('ignores a word that merely starts with "title"', () => {
    expect(nameOf('flowchart TD\n  A[titles are hard] --> B', rendered())).toBe('flowchart');
  });

  it('slugifies punctuation, accents and case, and drops a title it cannot romanise', () => {
    expect(nameOf('---\ntitle: Café / Bar — v2!\n---\nflowchart TD', rendered())).toBe(
      'cafe-bar-v2',
    );
    // No Latin letters at all: nothing useful survives, so the type answers and
    // the timestamp still keeps the download unique.
    expect(nameOf('---\ntitle: 図表\n---\nflowchart TD', rendered())).toBe('flowchart');
  });

  it('caps a long title on a word boundary', () => {
    const long = 'The quick brown fox jumps over the lazy dog and keeps on running';
    const name = nameOf(`---\ntitle: ${long}\n---\nflowchart TD`, rendered());
    expect(name.length).toBeLessThanOrEqual(48);
    expect(name).toBe('the-quick-brown-fox-jumps-over-the-lazy-dog-and');
    // Cut between words, not mid-word.
    expect(long.toLowerCase().split(' ')).toContain(name.split('-').at(-1));
  });

  it('cuts a single over-long word hard, having no boundary to cut on', () => {
    const word = 'a'.repeat(80);
    expect(nameOf(`---\ntitle: ${word}\n---\nflowchart TD`, rendered())).toBe('a'.repeat(48));
  });
});

describe('type fallback, when the author named nothing', () => {
  it('reads the label the a11y transform synthesised', () => {
    expect(nameOf('flowchart TD\n A-->B', rendered())).toBe('flowchart');
    expect(nameOf('sequenceDiagram\n A->>B: hi', rendered({ type: 'sequence' }))).toBe('sequence');
    expect(nameOf('erDiagram\n A ||--o{ B : has', rendered({ type: 'er' }))).toBe(
      'entity-relationship',
    );
  });

  // The other branch of the transform: an authored accTitle names the graphic,
  // so the type moves to aria-roledescription. It is still the fallback for the
  // *filename* only when the accTitle slugs to nothing.
  it('reads the roledescription when the author supplied an accTitle', () => {
    const svg = rendered({ type: 'flowchart-v2', accTitle: '図表' });
    expect(nameOf('flowchart TD\n  accTitle: 図表', svg)).toBe('flowchart');
  });

  it('keeps the second word when it is part of the name, not a category', () => {
    expect(nameOf('pie\n "A" : 1', rendered({ type: 'pie' }))).toBe('pie-chart');
    expect(nameOf('gitGraph\n commit', rendered({ type: 'gitGraph' }))).toBe('git-graph');
    expect(nameOf('mindmap\n root', rendered({ type: 'mindmap' }))).toBe('mind-map');
  });

  it('falls back to "diagram" with no title, no type and no svg at all', () => {
    expect(nameOf('flowchart TD\n A-->B', null)).toBe('diagram');
    // An SVG that never went through the naming transform has neither attribute.
    const bare = new DOMParser()
      .parseFromString('<div><svg xmlns="http://www.w3.org/2000/svg"/></div>', 'text/html')
      .querySelector('svg');
    expect(nameOf('flowchart TD\n A-->B', bare)).toBe('diagram');
    // A type of "Diagram" is the generic label, which strips to nothing useful.
    expect(nameOf('', rendered({ type: 'not a real id!!' }))).toBe('diagram');
  });
});

describe('timestamp', () => {
  it('is local wall-clock time, zero padded to the second', () => {
    expect(exportBaseName('flowchart TD', rendered(), NOW)).toBe(`flowchart-${STAMP}`);
    expect(STAMP).toBe(stampOf(NOW));
  });

  it('changes with every second, so two exports never collide', () => {
    const a = exportBaseName('flowchart TD', rendered(), new Date(2026, 7, 8, 14, 3, 5));
    const b = exportBaseName('flowchart TD', rendered(), new Date(2026, 7, 8, 14, 3, 6));
    expect(a).not.toBe(b);
  });

  it('defaults to now when no clock is passed', () => {
    const before = new Date();
    const name = exportBaseName('flowchart TD', rendered());
    // Anything in the window the call spanned; a second boundary can fall in it.
    const window = [stampOf(before), stampOf(new Date())];
    expect(window).toContain(name.replace('flowchart-', ''));
  });
});

describe('exportFilename', () => {
  it('gives PNG and SVG the same base, so the pair sorts together', () => {
    const svg = rendered();
    const source = '---\ntitle: Deploy pipeline\n---\nflowchart TD';
    expect(exportFilename(source, svg, 'png', NOW)).toBe(`deploy-pipeline-${STAMP}.png`);
    expect(exportFilename(source, svg, 'svg', NOW)).toBe(`deploy-pipeline-${STAMP}.svg`);
  });
});
