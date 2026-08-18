/**
 * In-browser diagram export helpers, extracted from the reader view so they can
 * be exercised directly by the Chromium test suite. Nothing here uploads or
 * touches the network — a Blob becomes either an object URL and an anchor click
 * or a clipboard item, and that is the whole export story (see the zero-egress
 * invariant in CLAUDE.md).
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
 * A detached copy of the diagram carrying its natural size as real attributes —
 * the form both exports need, because each turns the SVG into a standalone
 * document where the stage's CSS no longer applies.
 *
 * Mermaid emits `width="100%"` and keeps the real width only in an inline
 * max-width, which is fine on the stage (see the --diagram-width rules in
 * src/view/index.html) and useless anywhere else: a percentage has nothing to
 * resolve against, so consumers fall back to their own default box. Stamping the
 * viewBox's own numbers is what makes an exported file open at the size the
 * diagram actually is. The inline max-width then equals the width just set and
 * so never binds, but a second, competing size input is a thing to reason about
 * for no benefit — the attributes are the only size an export should carry.
 */
function sizedClone(svgEl: SVGElement) {
  const clone = svgEl.cloneNode(true) as SVGElement;
  const { width, height } = naturalSize(svgEl);
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.style.removeProperty('max-width');
  return { clone, width, height };
}

/**
 * The diagram as a standalone .svg download — the vector counterpart to
 * exportPng, and the one export that stays resolution-independent.
 *
 * Serializes a sizedClone rather than the live SVG: the live one carries
 * Mermaid's percentage width, which several editors import as a default-sized
 * box instead of the diagram's own dimensions.
 */
export function exportSvg(svgEl: SVGElement, filename = 'diagram.svg') {
  const { clone } = sizedClone(svgEl);
  const markup = new XMLSerializer().serializeToString(clone);
  download(new Blob([markup], { type: 'image/svg+xml' }), filename);
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
 *
 * `background` is a CSS colour to paint behind the diagram, or null for the
 * transparent export. Mermaid paints no backdrop of its own, so transparent is
 * what the canvas gives us for free — right for compositing onto a coloured
 * slide, wrong for pasting anywhere the backdrop might be dark, where a
 * dark-themed diagram's light text disappears. The reader picks per export; the
 * colour itself is resolved by the caller (see surfaceColor in host.ts) so this
 * module stays out of the theming business.
 *
 * The blob is returned rather than consumed so both destinations can share this
 * one rasterizer: exportPng hands it to download(), copyPngToClipboard hands it
 * to the clipboard. Splitting it out is also what lets the clipboard path pass
 * the *unresolved* promise on — see the comment there.
 */
export async function renderPngBlob(
  svgEl: SVGElement,
  { scale = 2, background = null }: { scale?: number; background?: string | null } = {},
) {
  const { clone, width, height } = sizedClone(svgEl);
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
  // Fill in device pixels, before the scale transform. The canvas dimensions are
  // rounded *up* from width * scale, so filling the diagram's own box under the
  // transform would stop a sub-pixel short and leave a transparent seam down the
  // right and bottom edges — invisible until the PNG lands on a dark backdrop,
  // which is the case this option exists for.
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.scale(scale, scale);
  ctx.drawImage(image, 0, 0);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not rasterize the diagram');
  return blob;
}

/**
 * The rendered diagram as a PNG in the reader's Downloads folder.
 *
 * `filename` is the caller's call — deriving it needs the diagram source, which
 * this module has no business knowing about (see export-name.ts). The default
 * is what every export was called before there was a choice.
 */
export async function exportPng(
  svgEl: SVGElement,
  {
    scale = 2,
    background = null,
    filename = 'diagram.png',
  }: { scale?: number; background?: string | null; filename?: string } = {},
) {
  download(await renderPngBlob(svgEl, { scale, background }), filename);
}

/**
 * The rendered diagram as a PNG on the system clipboard — the same raster as
 * exportPng, minus the round trip through Downloads and back into whatever the
 * reader is pasting into.
 *
 * Deliberately **not** `async`, and the raster promise is handed over
 * unresolved. `clipboard.write()` has to run inside the click's transient user
 * activation, and any `await` before it spends that window: Safari rejects such
 * a write outright. `ClipboardItem` accepting a `Promise<Blob>` is the sanctioned
 * way to do slow work behind a clipboard write — the item is constructed
 * synchronously in the handler, and the rasterize resolves into it afterwards.
 * So this function must stay synchronous up to the write; if it ever grows an
 * `await` above that line, the feature breaks only on real Safari, which no test
 * here runs. (test/browser/export.e2e.test.js asserts the write is already
 * issued before the caller awaits anything, which is that guarantee.)
 *
 * No filename: a clipboard image has no name.
 *
 * A host that blocks the clipboard — a missing permissions policy on the iframe,
 * an engine without ClipboardItem — throws or rejects here, and the caller turns
 * that into the visible "clipboard is blocked" message. There is no silent
 * fallback to a download: a click that quietly does a different thing than the
 * one it is labelled with is worse than one that says it could not.
 */
export function copyPngToClipboard(
  svgEl: SVGElement,
  { scale = 2, background = null }: { scale?: number; background?: string | null } = {},
) {
  const item = new ClipboardItem({ 'image/png': renderPngBlob(svgEl, { scale, background }) });
  return navigator.clipboard.write([item]);
}
