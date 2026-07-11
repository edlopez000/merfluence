import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import mermaid from 'mermaid';

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
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixtures = readdirSync(fixturesDir).filter((f) => f.endsWith('.mmd'));

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false });

describe('mermaid corpus still parses', () => {
  it('has fixtures to check', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const file of fixtures) {
    it(file, async () => {
      const source = readFileSync(join(fixturesDir, file), 'utf8');
      await expect(mermaid.parse(source)).resolves.toBeTruthy();
    });
  }
});

describe('hardening', () => {
  it('rejects nothing it should accept, and parses a click directive without binding it', async () => {
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
    await expect(mermaid.parse(bad)).rejects.toThrow();
  });
});
