import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderDiagram } from '../../src/lib/render.js';
import { download, exportPng, exportSvg } from '../../src/lib/png-export.js';
import { exportFilename } from '../../src/lib/export-name.js';

/**
 * The reader view's in-browser export path. exportPng serializes the live SVG,
 * loads it into an Image via a data URL, and paints it to a canvas — a pipeline
 * that only exists in a real browser (jsdom has no canvas rasterization), so it
 * was previously uncovered. Both helpers were extracted from src/view/main.tsx
 * into src/lib/png-export.ts so they can be driven here directly, matching the
 * zero-mock style of render.integration.test.js. Nothing leaves the browser: we
 * assert a real PNG Blob is produced and that download() only wires up an anchor
 * click — no network, no upload.
 *
 * The anchor click and object-URL lifecycle are spied so a headless run never
 * actually triggers a file download; the Blob and URL calls are what we assert.
 */

let mounted = [];
function mountSvg(svg) {
  const host = document.createElement('div');
  host.innerHTML = svg;
  document.body.appendChild(host);
  mounted.push(host);
  return host.querySelector('svg');
}

// Capture what download() hands to the anchor without letting the browser act
// on it. createObjectURL is spied to record the Blob and hand back a stable
// stub URL; the anchor's click is neutered.
let createSpy;
let revokeSpy;
let clickSpy;

beforeEach(() => {
  createSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stub');
  revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

afterEach(() => {
  for (const host of mounted) host.remove();
  mounted = [];
  vi.restoreAllMocks();
});

describe('exportPng', () => {
  it('rasterizes a real rendered SVG to a PNG blob', async () => {
    const { svg } = await renderDiagram({ source: 'flowchart TD\n  A --> B', theme: 'light' });
    const el = mountSvg(svg);
    expect(el).not.toBeNull();

    await exportPng(el);

    // The whole SVG -> Image -> canvas.toBlob path ran: download() received a
    // PNG blob (captured via createObjectURL) and clicked the anchor once.
    expect(createSpy).toHaveBeenCalledTimes(1);
    const blob = createSpy.mock.calls[0][0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBeGreaterThan(0);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeSpy).toHaveBeenCalledWith('blob:stub');
  });
});

describe('exportSvg', () => {
  it('downloads the diagram at its own size, not as a percentage', async () => {
    const source = 'flowchart LR\n  A --> B --> C';
    const { svg } = await renderDiagram({ source, theme: 'light' });
    const el = mountSvg(svg);
    // The premise: what Mermaid hands us is unusable as a standalone file.
    expect(el.getAttribute('width')).toBe('100%');

    exportSvg(el, 'diagram.svg');

    const blob = createSpy.mock.calls[0][0];
    expect(blob.type).toBe('image/svg+xml');
    const markup = await blob.text();
    const exported = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement;
    const { width, height } = el.viewBox.baseVal;
    expect(exported.getAttribute('width')).toBe(String(width));
    expect(exported.getAttribute('height')).toBe(String(height));
    // Mermaid's inline clamp would be a second, competing size input in a
    // document where nothing overrides it any more. (Only the root's own style
    // — Mermaid's embedded stylesheet has an unrelated max-width on tooltips.)
    expect(exported.style.maxWidth).toBe('');
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('leaves the SVG on the page untouched', async () => {
    const { svg } = await renderDiagram({ source: 'flowchart TD\n  A --> B', theme: 'light' });
    const el = mountSvg(svg);
    const before = el.outerHTML;

    exportSvg(el);

    // It exports a clone: stamping the live SVG would fight the stage's width
    // rules and freeze the diagram at whatever size it was when exported.
    expect(el.outerHTML).toBe(before);
  });
});

describe('exportPng is zoom-independent', () => {
  // The reader's SVG lives inside the Stage's pan layer, which carries
  // `translate(pan) scale(zoom)`. Measuring the on-screen rect would multiply
  // the interactive zoom into the canvas: a 400% view quadruples each PNG axis
  // (16x the backing store), and past the browser's canvas ceiling the export
  // silently comes out blank. The export must be the diagram's own size.
  async function exportedSize(zoom) {
    const { svg } = await renderDiagram({ source: 'flowchart TD\n  A --> B', theme: 'light' });
    const host = document.createElement('div');
    host.innerHTML = svg;
    // The same transform shape Stage puts on .pan.
    host.style.transform = `scale(${zoom})`;
    host.style.transformOrigin = '0 0';
    document.body.appendChild(host);
    mounted.push(host);

    await exportPng(host.querySelector('svg'));
    const blob = createSpy.mock.calls.at(-1)[0];
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  }

  it('exports the same pixel size at 400% zoom as at 100%', async () => {
    const at100 = await exportedSize(1);
    const at400 = await exportedSize(4);
    expect(at100.width).toBeGreaterThan(0);
    expect(at100.height).toBeGreaterThan(0);
    expect(at400).toEqual(at100);
  });
});

/**
 * What the exported PNG is a multiple of. It has to be the diagram's own size:
 * the reported bug was a tall diagram on the Large preset exporting at 1179x1600
 * against a natural 1983x2693 — 0.59x its own pixels, and soft text — because the
 * export measured the *laid-out* size, which the Size preset had shrunk to 800px
 * tall. Same code gave a diagram that happened to be laid out at natural size a
 * clean 2x, so the defect was invisible until the two were compared.
 */
describe('exportPng is layout-independent', () => {
  async function exportedSize(el) {
    await exportPng(el);
    const blob = createSpy.mock.calls.at(-1)[0];
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  }

  it('exports the same pixels however the browser laid the diagram out', async () => {
    const { svg } = await renderDiagram({ source: 'flowchart TD\n  A --> B', theme: 'light' });

    // Natural: nothing constraining it.
    const natural = mountSvg(svg);
    const box = natural.viewBox.baseVal;

    // Squeezed into a narrow column, the way a wide diagram is in the macro.
    const narrow = mountSvg(svg);
    narrow.parentElement.style.width = '60px';
    narrow.style.width = '100%';
    narrow.style.height = 'auto';

    // The shape the Size presets impose: height pinned, width from the ratio.
    // This is the case from the bug report, and the one that used to lose.
    const preset = mountSvg(svg);
    preset.style.height = '40px';
    preset.style.width = 'auto';
    preset.style.maxWidth = 'none';

    // The premise: these really are three different laid-out sizes.
    const laidOut = [natural, narrow, preset].map((el) => el.getBoundingClientRect().width);
    expect(new Set(laidOut.map(Math.round)).size).toBe(3);

    const sizes = [];
    for (const el of [natural, narrow, preset]) sizes.push(await exportedSize(el));

    // ...and yet one export. 2x the viewBox, from all three.
    const expected = { width: Math.ceil(box.width * 2), height: Math.ceil(box.height * 2) };
    for (const size of sizes) expect(size).toEqual(expected);
  });

  it('falls back to the laid-out size for markup with no viewBox', async () => {
    // Nothing Mermaid emits, but hand-authored SVG reaches this, and the old
    // measurement is a better answer there than refusing to export.
    const el = mountSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60">' +
        '<rect x="0" y="0" width="120" height="60" fill="#0c66e4"/></svg>',
    );

    expect(await exportedSize(el)).toEqual({ width: 240, height: 120 });
  });

  it('stays inside the canvas ceiling on a diagram too big to double', async () => {
    // 20000x20000 doubled is 1.6 gigapixels; a canvas that size comes back blank
    // rather than throwing, so the scale has to be clamped before painting.
    const el = mountSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20000 20000">' +
        '<rect x="0" y="0" width="20000" height="20000" fill="#0c66e4"/></svg>',
    );

    const size = await exportedSize(el);
    expect(size.width).toBeLessThanOrEqual(16384);
    expect(size.height).toBeLessThanOrEqual(16384);
    // The area budget, plus the row and column that rounding each axis up to a
    // whole pixel can add — the exact bound, not a fudge factor.
    expect(size.width * size.height).toBeLessThanOrEqual(32e6 + size.width + size.height);
    // Clamped, not skipped: it is still a real raster of the diagram.
    expect(size.width).toBeGreaterThan(0);
    expect(createSpy.mock.calls.at(-1)[0].size).toBeGreaterThan(0);
  });
});

/**
 * The transparent / with-background choice in the reader's Export menu.
 *
 * Mermaid paints no backdrop, so the canvas gives us transparency for free —
 * right for compositing onto a coloured slide, wrong for pasting anywhere the
 * backdrop might be dark, where a dark-themed diagram's light text disappears
 * into it. The only way to assert which one came out is to read the PNG back
 * and look at its pixels, which is why this lives in the Chromium project.
 */
describe('exportPng background', () => {
  /** The exported PNG's corner pixels, decoded back out of the blob. */
  async function exportedCorners(el, options) {
    await exportPng(el, options);
    const blob = createSpy.mock.calls.at(-1)[0];
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const at = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
    const corners = { first: at(0, 0), last: at(bitmap.width - 1, bitmap.height - 1) };
    bitmap.close();
    return corners;
  }

  // A viewBox whose doubled size lands on a half pixel, so canvas.width is
  // rounded up and the fill has to cover more than the diagram's own box.
  const ODD_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120.25 60.25">' +
    '<rect x="40" y="20" width="20" height="20" fill="#0c66e4"/></svg>';

  it('paints the requested colour behind the diagram, to every edge', async () => {
    const corners = await exportedCorners(mountSvg(ODD_SVG), { background: '#ff0000' });

    expect(corners.first).toEqual([255, 0, 0, 255]);
    // The far corner is the one that regresses if the fill is applied under the
    // scale transform: canvas.width is ceil(width * scale), so filling the
    // diagram's own box stops a sub-pixel short and leaves a transparent seam
    // down the right and bottom edges — invisible until the PNG lands on a dark
    // backdrop, which is the case this option exists for.
    expect(corners.last).toEqual([255, 0, 0, 255]);
  });

  it('leaves the background transparent when none is asked for', async () => {
    const byDefault = await exportedCorners(mountSvg(ODD_SVG));
    const explicit = await exportedCorners(mountSvg(ODD_SVG), { background: null });

    // Alpha zero, which is what the reader gets from "PNG (transparent)".
    expect(byDefault.first[3]).toBe(0);
    expect(byDefault.last[3]).toBe(0);
    expect(explicit.first[3]).toBe(0);
  });

  it('still honours scale through the options object', async () => {
    // scale had been a positional argument with no caller passing it; the
    // options object is what carries both knobs now, so prove it still lands.
    const el = mountSvg(ODD_SVG);
    await exportPng(el, { scale: 1 });
    const bitmap = await createImageBitmap(createSpy.mock.calls.at(-1)[0]);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();

    expect(size).toEqual({ width: Math.ceil(120.25), height: Math.ceil(60.25) });
  });
});

describe('download', () => {
  it('turns a blob into an anchor click and revokes the object URL', () => {
    const blob = new Blob(['<svg></svg>'], { type: 'image/svg+xml' });
    download(blob, 'diagram.svg');

    expect(createSpy).toHaveBeenCalledWith(blob);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    // The URL is created then released in the same call — no leak.
    expect(revokeSpy).toHaveBeenCalledWith('blob:stub');
  });

  it('names the downloaded file', () => {
    // Spy on anchor creation to inspect the element download() configures.
    const created = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag, ...rest) => {
      const el = realCreate(tag, ...rest);
      if (tag === 'a') created.push(el);
      return el;
    });

    download(new Blob(['x']), 'my-diagram.png');

    expect(created).toHaveLength(1);
    expect(created[0].download).toBe('my-diagram.png');
    expect(created[0].href).toContain('blob:stub');
  });
});

/**
 * The name derivation is unit-tested in test/export-name.test.js against SVG
 * shapes we construct. This is the end-to-end half: real Mermaid, really
 * rendered, really rasterized, so the assumption the fallback rests on — that
 * Mermaid stamps the diagram type onto the root where a11y-name.js can move it
 * to a place export-name.js reads — is checked against the renderer rather than
 * against a fixture that agrees with us by construction.
 */
describe('derived export filenames', () => {
  /** The `download` attribute of the anchor the export configures. */
  async function nameFromExport(source) {
    const created = [];
    const realCreate = document.createElement.bind(document);
    // Restored before returning, so a test that exports twice does not stack a
    // spy on top of a spy — realCreate would then be the previous mock and the
    // second call would recurse until the stack gave out.
    const spy = vi.spyOn(document, 'createElement').mockImplementation((tag, ...rest) => {
      const el = realCreate(tag, ...rest);
      if (tag === 'a') created.push(el);
      return el;
    });

    try {
      const { svg } = await renderDiagram({ source, theme: 'light' });
      const el = mountSvg(svg);
      await exportPng(el, { filename: exportFilename(source, el, 'png') });
    } finally {
      spy.mockRestore();
    }

    expect(created).toHaveLength(1);
    return created[0].download;
  }

  it('names the PNG after the diagram title', async () => {
    const name = await nameFromExport('---\ntitle: Deploy pipeline\n---\nflowchart TD\n  A --> B');
    expect(name).toMatch(/^deploy-pipeline-\d{8}-\d{6}\.png$/);
  });

  it('falls back to the type Mermaid itself reports', async () => {
    expect(await nameFromExport('flowchart TD\n  A --> B')).toMatch(/^flowchart-\d{8}-\d{6}\.png$/);
    expect(await nameFromExport('sequenceDiagram\n  A->>B: hi')).toMatch(
      /^sequence-\d{8}-\d{6}\.png$/,
    );
  });
});
