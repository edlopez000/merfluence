import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderWithPele, validateWithPele } from '../src/lib/pele-engine.js';
import { describeError, renderDiagram, sanitizeSvg, validate } from '../src/lib/render.js';
import { VERSION_OPTIONS, isPele, resolvedVersion } from '../src/lib/mermaid-registry.js';

/**
 * The opt-in Pele renderer (mermaidVersion: 'pele'). Unlike Mermaid, Pele
 * lays out without getBBox — it falls back to built-in font metrics where there
 * is no canvas — so the whole corpus can render here in jsdom, not just parse.
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixtures = readdirSync(fixturesDir).filter((f) => f.endsWith('.mmd'));

describe('pele renders the fixture corpus', () => {
  for (const file of fixtures) {
    it(file, async () => {
      const source = readFileSync(join(fixturesDir, file), 'utf8').trim();
      await expect(validateWithPele(source)).resolves.toBeUndefined();
      const svg = sanitizeSvg(await renderWithPele(source, 'light'));
      expect(svg).toMatch(/^<svg\b/);
      expect(svg).not.toMatch(/foreignObject|<script|\son\w+=/i);
    });
  }
});

describe('pele theming', () => {
  it('bakes the requested palette onto the SVG root', async () => {
    const light = await renderWithPele('flowchart LR\n A-->B', 'light');
    const dark = await renderWithPele('flowchart LR\n A-->B', 'dark');
    expect(light).toMatch(/^<svg[^>]* style="--pele-bg:#ffffff;/);
    expect(dark).toMatch(/^<svg[^>]* style="--pele-bg:#22272b;/);
  });
});

describe('pele hostile input', () => {
  it('builds no links or images, and escapes label markup', async () => {
    const svg = sanitizeSvg(
      await renderWithPele(
        'flowchart LR\n A["<img src=x onerror=alert(1)>"]-->B\n click A "https://evil.example"',
        'light',
      ),
    );
    expect(svg).not.toMatch(/evil\.example|<img|onerror=/i);
  });
});

describe('pele errors', () => {
  it('reports the 1-based line through describeError', async () => {
    const err = await validateWithPele('flowchart LR\n A-->B\n B-->>>C').catch((e) => e);
    expect(describeError(err).line).toBe(3);
  });

  it('rejects text with no diagram type', async () => {
    await expect(validateWithPele('not a diagram')).rejects.toThrow(/No diagram type/);
  });
});

describe('per-diagram opt-in', () => {
  it('is offered in the version dropdown and labelled as Pele', () => {
    expect(VERSION_OPTIONS.map((o) => o.value)).toContain('pele');
    expect(resolvedVersion('pele')).toMatch(/^Pele \d+\.\d+\.\d+$/);
    expect(isPele('pele')).toBe(true);
    expect(isPele('auto')).toBe(false);
  });

  it('routes renderDiagram through Pele, still sanitized', async () => {
    const { svg, major } = await renderDiagram({
      source: 'flowchart LR\n A["<img src=x onerror=alert(1)>"]-->B',
      versionPref: 'pele',
      theme: 'dark',
    });
    expect(major).toBe('pele');
    expect(svg).toMatch(/class="pele pele-flowchart"/);
    expect(svg).toMatch(/--pele-bg:#22272b/);
    expect(svg).not.toMatch(/<img|onerror=/i);
  });

  it('routes validate through Pele', async () => {
    await expect(validate('flowchart LR\n A-->B', 'pele')).resolves.toBeUndefined();
    await expect(validate('flowchart LR\n A-->>>B', 'pele')).rejects.toThrow(/Parse error/);
  });
});
