import { describe, expect, it } from 'vitest';
import {
  CACHE_VERSION,
  fitsCache,
  buildCacheFields,
  pickCachedSvg,
  pickCachedVersion,
} from '../src/lib/cache.js';

const small = '<svg>ok</svg>';
const tooBig = '<svg>' + 'x'.repeat(46 * 1024) + '</svg>'; // over the 45KB budget
// A semver deliberately unlike anything the current bundle ships, so a test that
// reads it back can only have got it from the cache.
const RENDERED = '11.4.0';

describe('fitsCache', () => {
  it('accepts a small non-empty string', () => {
    expect(fitsCache(small)).toBe(true);
  });
  it('rejects empty, non-string, and oversized', () => {
    expect(fitsCache('')).toBe(false);
    expect(fitsCache(null)).toBe(false);
    expect(fitsCache(undefined)).toBe(false);
    expect(fitsCache(tooBig)).toBe(false);
  });
  it('measures encoded bytes, not code units', () => {
    // A multi-byte char just under the char limit can still exceed the byte
    // budget, so a string of 40k 2-byte chars (80KB) must be rejected.
    expect(fitsCache('é'.repeat(40 * 1024))).toBe(false);
  });
});

describe('buildCacheFields', () => {
  it('always stamps the version and includes only fitting variants', () => {
    expect(buildCacheFields(small, small, RENDERED)).toEqual({
      cacheV: CACHE_VERSION,
      svgLight: small,
      svgDark: small,
      renderedVersion: RENDERED,
    });
  });
  it('omits an oversized variant but keeps the other, still stamping the renderer', () => {
    const fields = buildCacheFields(small, tooBig, RENDERED);
    expect(fields).toEqual({
      cacheV: CACHE_VERSION,
      svgLight: small,
      renderedVersion: RENDERED,
    });
    expect(fields).not.toHaveProperty('svgDark');
  });
  it('stores only the cache version when nothing fits', () => {
    // Nothing cached means there is no render to attribute, so renderedVersion
    // must not linger in config describing SVG that isn't there.
    const fields = buildCacheFields(tooBig, tooBig, RENDERED);
    expect(fields).toEqual({ cacheV: CACHE_VERSION });
    expect(fields).not.toHaveProperty('renderedVersion');
  });
});

describe('pickCachedSvg', () => {
  const config = { cacheV: CACHE_VERSION, svgLight: '<svg>L</svg>', svgDark: '<svg>D</svg>' };

  it('returns the variant for the resolved theme', () => {
    expect(pickCachedSvg(config, 'light')).toBe('<svg>L</svg>');
    expect(pickCachedSvg(config, 'dark')).toBe('<svg>D</svg>');
  });
  it('misses on a different cache version', () => {
    expect(pickCachedSvg({ ...config, cacheV: CACHE_VERSION + 1 }, 'light')).toBeNull();
    expect(pickCachedSvg({ ...config, cacheV: undefined }, 'light')).toBeNull();
  });
  it('misses when the requested variant is absent', () => {
    expect(pickCachedSvg({ cacheV: CACHE_VERSION, svgLight: small }, 'dark')).toBeNull();
  });
  it('misses on empty config', () => {
    expect(pickCachedSvg(null, 'light')).toBeNull();
    expect(pickCachedSvg({}, 'light')).toBeNull();
  });
});

describe('pickCachedVersion', () => {
  it('returns the semver stored with the cached SVG', () => {
    expect(pickCachedVersion({ cacheV: CACHE_VERSION, renderedVersion: RENDERED })).toBe(RENDERED);
  });
  it('misses on a different cache version', () => {
    const config = { renderedVersion: RENDERED };
    expect(pickCachedVersion({ ...config, cacheV: CACHE_VERSION + 1 })).toBeNull();
    expect(pickCachedVersion({ ...config, cacheV: undefined })).toBeNull();
  });
  it('misses when the field is absent, empty, or not a string', () => {
    // A hand-edited config can carry a matching cacheV and no usable version;
    // the caller then falls back to the current build's semver.
    expect(pickCachedVersion({ cacheV: CACHE_VERSION })).toBeNull();
    expect(pickCachedVersion({ cacheV: CACHE_VERSION, renderedVersion: '' })).toBeNull();
    expect(pickCachedVersion({ cacheV: CACHE_VERSION, renderedVersion: 11 })).toBeNull();
  });
  it('misses on empty config', () => {
    expect(pickCachedVersion(null)).toBeNull();
    expect(pickCachedVersion({})).toBeNull();
  });
});
