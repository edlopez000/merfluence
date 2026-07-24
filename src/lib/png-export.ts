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
 * SVG -> PNG entirely in the browser: serialize, load into an Image via a data
 * URL, paint to a canvas. No upload, no server, no attachment. Rendered at 2x
 * because a 1x flowchart pasted into a deck looks like a fax.
 */
export async function exportPng(svgEl: SVGElement, scale = 2) {
  const clone = svgEl.cloneNode(true) as SVGElement;
  const { width, height } = svgEl.getBoundingClientRect();
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));

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
