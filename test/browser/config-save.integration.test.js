import { describe, expect, it } from 'vitest';
import { renderDiagram } from '../../src/lib/render.js';
import { buildCacheFields, fitsCache, CACHE_VERSION } from '../../src/lib/cache.js';

/**
 * The config editor's save flow, driven through a real browser render.
 *
 * config/main.tsx's save() renders the diagram to SVG for light AND dark, then
 * hands both to buildCacheFields to assemble the reader's cache. The unit test
 * (test/config-app.test.jsx) already drives that orchestration in jsdom, but it
 * MOCKS renderDiagram — so it proves the two renders happen in order, yet cannot
 * prove that two genuinely sequential Mermaid renders come out in DIFFERENT
 * themes. That is precisely the regression CACHE_VERSION = 2 exists to guard: v1
 * ran the renders in parallel, both initialize() calls raced, and the same theme
 * won both SVGs. Only a real render can show they diverge, so that check lives
 * here in the Chromium project rather than in jsdom.
 *
 * This file reproduces save()'s exact sequence (renderDiagram light -> await ->
 * renderDiagram dark -> await -> buildCacheFields), matching the zero-mock
 * convention of render.integration.test.js. The view.submit({ config }) wrapping
 * itself is covered separately by test/host.test.js; here we assert the fields
 * object save() assembles, built from real SVG.
 */

const SOURCE = 'flowchart TD\n  A[Start] --> B{Choice}\n  B -->|yes| C[Do it]\n  B -->|no| D[Skip]';

// Render both themes the way save() does: fully await light before starting
// dark, so Mermaid's global initialize() is never mid-flight for two themes at
// once. Returns the two SVG strings.
async function renderBothThemes(source = SOURCE) {
  const light = await renderDiagram({ source, theme: 'light' });
  const dark = await renderDiagram({ source, theme: 'dark' });
  return { lightSvg: light.svg, darkSvg: dark.svg };
}

describe('save-time sequential light/dark render', () => {
  it('produces genuinely theme-distinct SVGs (the CACHE_VERSION=2 guard)', async () => {
    const { lightSvg, darkSvg } = await renderBothThemes();

    // Both are real, non-trivial SVG documents.
    expect(lightSvg).toMatch(/^<svg[\s>]/);
    expect(darkSvg).toMatch(/^<svg[\s>]/);
    expect(lightSvg.length).toBeGreaterThan(200);
    expect(darkSvg.length).toBeGreaterThan(200);

    // The whole point: sequential renders diverge by theme. A parallel race (the
    // v1 bug) would have made these identical because the last initialize() won
    // both. Mermaid bakes the theme into inline styles/colours, so the strings
    // differ.
    expect(lightSvg).not.toBe(darkSvg);
  });

  it('assembles both variants into the cache with the current cacheV', async () => {
    const { lightSvg, darkSvg } = await renderBothThemes();

    const fields = buildCacheFields(lightSvg, darkSvg);
    expect(fields.cacheV).toBe(CACHE_VERSION);
    // Real diagrams this small comfortably fit the byte budget, so both cache.
    expect(fields.svgLight).toBe(lightSvg);
    expect(fields.svgDark).toBe(darkSvg);
  });
});

describe('size-gated cache assembly', () => {
  // A real rendered SVG is well under the ~45KB per-string budget.
  it('keeps a real (small) SVG', async () => {
    const light = await renderDiagram({ source: SOURCE, theme: 'light' });
    expect(fitsCache(light.svg)).toBe(true);
  });

  // The gate is a raw byte-length check, so an oversized string is honest input.
  const OVERSIZED = `<svg>${'x'.repeat(46 * 1024)}</svg>`;

  it('drops an oversized variant', () => {
    expect(fitsCache(OVERSIZED)).toBe(false);
  });

  it('drops only the oversized side while always stamping cacheV', async () => {
    const light = await renderDiagram({ source: SOURCE, theme: 'light' });

    // Light fits, dark is oversized -> only svgLight survives.
    const fields = buildCacheFields(light.svg, OVERSIZED);
    expect(fields.cacheV).toBe(CACHE_VERSION);
    expect(fields.svgLight).toBe(light.svg);
    expect(fields).not.toHaveProperty('svgDark');

    // Both oversized -> neither survives, but cacheV is still written so a save
    // from this app version stamps its version onto the config.
    const none = buildCacheFields(OVERSIZED, OVERSIZED);
    expect(none).toEqual({ cacheV: CACHE_VERSION });
  });
});

describe('submit payload shape', () => {
  // Assemble the config fields exactly as save() does (main.tsx:266-289), from
  // real SVG. save() spreads: { source, mermaidVersion, theme, useMaxWidth,
  // ...(height ? { height } : {}), ...buildCacheFields(light, dark) }.
  function assembleConfig({ lightSvg, darkSvg, height }) {
    const sizing = height ? { height } : {};
    return {
      source: SOURCE,
      mermaidVersion: 'auto',
      theme: 'auto',
      useMaxWidth: true,
      ...sizing,
      ...buildCacheFields(lightSvg, darkSvg),
    };
  }

  it('carries source, settings, cacheV and both cached SVGs; omits height when unset', async () => {
    const { lightSvg, darkSvg } = await renderBothThemes();

    const config = assembleConfig({ lightSvg, darkSvg });
    expect(config).toMatchObject({
      source: SOURCE,
      mermaidVersion: 'auto',
      theme: 'auto',
      useMaxWidth: true,
      cacheV: CACHE_VERSION,
    });
    expect(config.svgLight).toBe(lightSvg);
    expect(config.svgDark).toBe(darkSvg);
    // A natural-size diagram carries no height key (main.tsx:288).
    expect(config).not.toHaveProperty('height');
  });

  it('includes height when a size preset is chosen', async () => {
    const { lightSvg, darkSvg } = await renderBothThemes();

    const config = assembleConfig({ lightSvg, darkSvg, height: 560 });
    expect(config.height).toBe(560);
  });
});
