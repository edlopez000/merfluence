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
 *
 * v3: caches now carry renderedVersion, the exact Mermaid semver that produced
 * the stored SVG. v1/v2 caches have no such record, so their version label had
 * to fall back to the semver in the *current* bundle — which drifts away from
 * the render as the app upgrades, and quietly misreports the version on the
 * fast path. Discarding them means every diagram that still shows a number is
 * showing the right one.
 */
export const CACHE_VERSION = 3;

// Per-string budget. The SVG is persisted verbatim into the page document, so
// the cost that matters is raw UTF-8 bytes, not the gzipped transfer size.
// Each theme is gated independently: if one variant is too large the other can
// still cache, and the oversized theme simply renders on view as it did before
// caching existed.
//
// This number is not derived from any Confluence limit, and deliberately so —
// it exists to stop one pathological diagram bloating a page. It turns out to
// bound the per-page aggregate as well, because a diagram big enough to matter
// is a diagram that fails this gate and stores no SVG at all. The measured
// ceilings (editor ~5.23 MB, REST API exactly 20,000,000 bytes) and why no
// per-page check exists are in docs/STORAGE-BUDGET.md.
const MAX_SVG_BYTES = 45 * 1024;

/**
 * Cache fields merged into a save. Either SVG variant is omitted when it doesn't
 * fit the byte budget; cacheV is always present. renderedVersion rides along
 * only when something was actually cached (see buildCacheFields).
 */
type CacheFields = {
  cacheV: number;
  svgLight?: string;
  svgDark?: string;
  renderedVersion?: string;
};

// SVG can contain multi-byte characters (labels, arrows), so measure encoded
// bytes rather than string length.
const encoder = new TextEncoder();
const byteLength = (str: string) => encoder.encode(str).length;

/** True if this SVG is a non-empty string within the per-string byte budget. */
export function fitsCache(svg: unknown) {
  if (typeof svg !== 'string' || svg.length === 0) return false;
  // UTF-8 never encodes a string to fewer bytes than it has UTF-16 code units,
  // so a string already longer than the budget is over it — reject without
  // materializing a multi-megabyte byte array just to measure it.
  if (svg.length > MAX_SVG_BYTES) return false;
  return byteLength(svg) <= MAX_SVG_BYTES;
}

/**
 * Build the cache fields to merge into a save. Either variant that is too large
 * is simply omitted, so a hit is all-or-nothing per theme. cacheV is always
 * written so a save from a newer app version stamps its version onto the config.
 *
 * renderedVersion is the semver that rendered these SVGs, kept so the reader can
 * label a cache hit with the version that actually drew it rather than the one
 * in whatever bundle happens to be serving the page. Both variants render under
 * the same version preference, so one field covers the pair. It is written only
 * when at least one SVG survived: with nothing cached there is no render to
 * describe, and an unused key would just sit in config going stale.
 */
export function buildCacheFields(
  svgLight: string,
  svgDark: string,
  renderedVersion: string,
): CacheFields {
  const fields: CacheFields = { cacheV: CACHE_VERSION };
  if (fitsCache(svgLight)) fields.svgLight = svgLight;
  if (fitsCache(svgDark)) fields.svgDark = svgDark;
  if (fields.svgLight || fields.svgDark) fields.renderedVersion = renderedVersion;
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

/**
 * The Mermaid semver that rendered the cached SVG, or null if this config has
 * none to offer — a stale cacheV, or a hand-edited config missing the field.
 * Callers fall back to the current build's version, which is the pre-v3
 * behaviour and the best guess available when the cache doesn't say.
 */
export function pickCachedVersion(
  config: { cacheV?: number; renderedVersion?: unknown } | null | undefined,
) {
  if (!config || config.cacheV !== CACHE_VERSION) return null;
  const version = config.renderedVersion;
  return typeof version === 'string' && version.length > 0 ? version : null;
}
