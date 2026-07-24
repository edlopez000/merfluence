import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderDiagram } from '../../src/lib/render.js';
import { download, exportPng } from '../../src/lib/png-export.js';

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
