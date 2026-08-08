/**
 * In-browser diagram download helpers, extracted from the reader view so they
 * can be exercised directly by the Chromium test suite. Nothing here uploads or
 * touches the network — a Blob becomes an object URL and an anchor click, which
 * is the whole export story (see the zero-egress invariant in CLAUDE.md).
 */

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Canvas ceilings, as a dimension and as a total pixel count.
 *
 * The dimension is the lowest cap among current desktop engines (Safari 16384;
 * Chrome 65535, Firefox 32767). The area cap is not an engine limit at all — it
 * is memory: a backing store is 4 bytes per pixel, so 32MP is ~128MB, which is
 * already a lot to ask of a Confluence tab for a download. Past either limit the
 * canvas comes back blank rather than throwing, so this is a guess we have to
 * make *before* painting.
 *
 * The scale is computed against these and then rounded up to whole pixels, so a
 * clamped canvas can exceed the area by one row and one column. That is what the
 * order of magnitude of headroom to the real engine ceiling (268MP) is for;
 * flooring instead would crop the diagram by a hairline in the common case,
 * which is the one worth protecting.
 */
const MAX_CANVAS_DIM = 16384;
const MAX_CANVAS_AREA = 32e6;

/**
 * The diagram's own size in pixels, independent of how it happens to be laid out
 * right now.
 *
 * The viewBox is the diagram's intrinsic box — the same source Stage reads for
 * --diagram-width and displayScale, so all three agree on "how wide is this
 * diagram". Everything else about the on-screen SVG is display state: the used
 * CSS size is whatever the column, the Size preset and the max-width rules made
 * of it, and getBoundingClientRect additionally multiplies in the pan layer's
 * zoom transform. Exporting from either is what tied PNG quality to the macro's
 * width instead of the diagram's content — a Large preset on a tall diagram
 * shrinks it to 800px, and the export came out at 0.59x the diagram's own pixels.
 *
 * The computed-size fallback is for an SVG with no viewBox — nothing Mermaid
 * emits, but this is also reachable with hand-authored markup, and the old
 * behaviour beats refusing to export. Rect behind that, for an SVG measured
 * outside the render tree where computed sizes read as auto.
 */
function naturalSize(svgEl: SVGElement) {
  const box = (svgEl as SVGSVGElement).viewBox?.baseVal;
  if (box && box.width > 0 && box.height > 0) {
    return { width: box.width, height: box.height };
  }
  const style = getComputedStyle(svgEl);
  const rect = svgEl.getBoundingClientRect();
  return {
    width: Number.parseFloat(style.width) || rect.width,
    height: Number.parseFloat(style.height) || rect.height,
  };
}

/**
 * The largest scale up to `wanted` that keeps the canvas inside both ceilings.
 *
 * Pure, so the arithmetic is unit-testable without a canvas. May return less
 * than 1 for a diagram too large to raster even 1:1 — a downscaled PNG is a
 * worse export but it is still an export, where the alternative is the silent
 * blank one the ceilings produce.
 */
export function exportScaleFor(
  { width, height }: { width: number; height: number },
  wanted: number,
) {
  if (!(width > 0) || !(height > 0)) return wanted;
  return Math.min(
    wanted,
    MAX_CANVAS_DIM / width,
    MAX_CANVAS_DIM / height,
    Math.sqrt(MAX_CANVAS_AREA / (width * height)),
  );
}

/**
 * SVG -> PNG entirely in the browser: serialize, load into an Image via a data
 * URL, paint to a canvas. No upload, no server, no attachment.
 *
 * `scale` is a multiple of the diagram's *natural* size (see naturalSize), not
 * of whatever size it is displayed at, so the same diagram exports identically
 * from any column width, zoom level or Size preset. 2x because a 1x flowchart
 * pasted into a deck looks like a fax.
 */
export async function exportPng(svgEl: SVGElement, scale = 2) {
  const clone = svgEl.cloneNode(true) as SVGElement;
  const { width, height } = naturalSize(svgEl);
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  // Mermaid writes an inline max-width at the diagram's own width when
  // useMaxWidth is on. It equals the width just set and so never binds, but the
  // clone is about to be rendered as a standalone image document — leaving a
  // second, competing size input in there is a thing to reason about for no
  // benefit. The attributes are the only size the raster reads.
  clone.style.removeProperty('max-width');
  scale = exportScaleFor({ width, height }, scale);

  const markup = new XMLSerializer().serializeToString(clone);
  const encoded = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;

  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('Could not rasterize the diagram'));
    image.src = encoded;
  });

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not rasterize the diagram');
  ctx.scale(scale, scale);
  ctx.drawImage(image, 0, 0);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not rasterize the diagram');
  download(blob, 'diagram.png');
}
