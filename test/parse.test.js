import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import mermaid11 from 'mermaid';
import mermaid10 from 'mermaid-10';
import { describeError } from '../src/lib/render.js';

/**
 * Why parse and not render.
 *
 * Rendering needs SVGElement.getBBox(), which jsdom does not implement — a
 * headless browser is the only honest way to do a pixel diff, and pixel diffs
 * on Mermaid output are noise anyway (generated ids, marker hashes, kerning).
 *
 * The failure this suite exists to catch is different: Mermaid removing or
 * changing syntax across a version bump, so that a diagram a customer wrote
 * two years ago stops parsing. parse() catches exactly that, costs
 * milliseconds, and has no false positives.
 *
 * Why both majors.
 *
 * The version dropdown lets a diagram pin major 10, so mermaid-10 ships in the
 * bundle and renders for real customers — it needs the same guarantee as 11,
 * not less. Checking only the default major would leave the pinned line, which
 * exists precisely to be the stable one, as the untested one.
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixtures = readdirSync(fixturesDir).filter((f) => f.endsWith('.mmd'));

// A few diagram grammars postdate major 10 (architecture-beta arrived in 11.1,
// kanban in 11.3), so their keyword doesn't exist in mermaid-10 and parse()
// throws "No diagram type detected". That's not a regression to catch — the type
// simply isn't part of the pinned-v10 feature set — so skip those fixtures on any
// major below their minimum rather than fail the leg. They still run on v11, so
// nothing ships untested.
const MIN_MAJOR = { 'kanban.mmd': 11, 'architecture.mmd': 11 };

// Mirrors the registry's majors. Mermaid keeps parser state on the singleton,
// so initialize each once here rather than per-test.
const majors = [
  ['11', mermaid11],
  ['10', mermaid10],
];

for (const [, mermaid] of majors) {
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false });
}

describe.each(majors)('mermaid %s corpus still parses', (major, mermaid) => {
  it('has fixtures to check', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const file of fixtures) {
    const run = Number(major) < (MIN_MAJOR[file] ?? 0) ? it.skip : it;
    run(file, async () => {
      const source = readFileSync(join(fixturesDir, file), 'utf8');
      await expect(mermaid.parse(source)).resolves.toBeTruthy();
    });
  }
});

describe.each(majors)('mermaid %s hardening', (major, mermaid) => {
  it('parses a click directive without binding it', async () => {
    // securityLevel: 'strict' keeps this inert at render time. It should still
    // parse — silently failing to parse would break existing customer diagrams.
    const source = 'flowchart TD\n  A --> B\n  click A "https://example.com"';
    await expect(mermaid.parse(source)).resolves.toBeTruthy();
  });

  it('reports a line number for a syntax error', async () => {
    // Must be genuinely unparseable. Mermaid 11's flowchart grammar is lenient
    // enough to swallow free tokens like `???!!!` as a node, so we use an
    // unterminated node bracket, which reliably throws with hash.loc.first_line.
    const bad = 'flowchart TD\n  A --> B\n  C[unterminated';

    // Assert through describeError, the same path the config panel's error
    // gutter uses. The two majors report locations in different shapes, which
    // is the whole reason that helper exists — so pin the line it extracts,
    // not merely that something threw.
    const err = await mermaid.parse(bad).then(
      () => null,
      (e) => e,
    );
    expect(err).not.toBeNull();
    expect(describeError(err).line).toBe(3);
  });
});
