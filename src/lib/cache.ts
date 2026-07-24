/**
 * Cached-SVG shape stored in macro config.
 *
 * Rendering is the expensive part, and it is deterministic given
 * (source, mermaidVersion, theme, useMaxWidth). So the editor renders the
 * diagram to SVG once at save time — for both light and dark — and stores the
 * result in the page's own macro config. A reader whose config carries a cache
 * hit paints the diagram without loading Mermaid at all, which is the whole
 * point: on a busy page most diagrams never download the renderer.
 *
 * cacheV lets us invalidate every stored cache at once. If the render pipeline
 * changes in a way that makes previously-stored SVG wrong (a sanitize policy
 * change, a font change), bump this constant and every old cache is ignored,
 * falling back to a fresh render-on-view.
 *
 * Note the config is submitted wrapped as { config: fields } (see host.js);
 * these svg fields ride along inside that fields object.
 *
 * v2: caches written by v1 stored a dark-themed SVG in svgLight, because the
 * two theme renders ran in parallel against Mermaid's global singleton and the
 * dark initialize() won the race. Bumping the version discards those.
 */
export const CACHE_VERSION = 2;

// Per-string budget. The SVG is persisted verbatim into the page document, so
// the cost that matters is raw UTF-8 bytes, not the gzipped transfer size.
// Each theme is gated independently: if one variant is too large the other can
// still cache, and the oversized theme simply renders on view as it did before
// caching existed.
const MAX_SVG_BYTES = 45 * 1024;

/**
 * Cache fields merged into a save. Either SVG variant is omitted when it doesn't
 * fit the byte budget; cacheV is always present.
 */
type CacheFields = { cacheV: number; svgLight?: string; svgDark?: string };

// SVG can contain multi-byte characters (labels, arrows), so measure encoded
// bytes rather than string length.
const byteLength = (str: string) => new TextEncoder().encode(str).length;

/** True if this SVG is a non-empty string within the per-string byte budget. */
export function fitsCache(svg: unknown) {
  return typeof svg === 'string' && svg.length > 0 && byteLength(svg) <= MAX_SVG_BYTES;
}

/**
 * Build the cache fields to merge into a save. Either variant that is too large
 * is simply omitted, so a hit is all-or-nothing per theme. cacheV is always
 * written so a save from a newer app version stamps its version onto the config.
 */
export function buildCacheFields(svgLight: string, svgDark: string): CacheFields {
  const fields: CacheFields = { cacheV: CACHE_VERSION };
  if (fitsCache(svgLight)) fields.svgLight = svgLight;
  if (fitsCache(svgDark)) fields.svgDark = svgDark;
  return fields;
}

/**
 * Return the cached SVG for the resolved theme, or null on a miss. A cache
 * written by a different CACHE_VERSION is treated as absent.
 */
export function pickCachedSvg(
  config: { cacheV?: number; svgLight?: unknown; svgDark?: unknown } | null | undefined,
  theme: string,
) {
  if (!config || config.cacheV !== CACHE_VERSION) return null;
  const svg = theme === 'dark' ? config.svgDark : config.svgLight;
  return typeof svg === 'string' && svg.length > 0 ? svg : null;
}
