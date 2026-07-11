import { describe, expect, it } from 'vitest';
import { CACHE_VERSION, fitsCache, buildCacheFields, pickCachedSvg } from '../src/lib/cache.js';

const small = '<svg>ok</svg>';
const tooBig = '<svg>' + 'x'.repeat(46 * 1024) + '</svg>'; // over the 45KB budget

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
    expect(buildCacheFields(small, small)).toEqual({
      cacheV: CACHE_VERSION,
      svgLight: small,
      svgDark: small,
    });
  });
  it('omits an oversized variant but keeps the other', () => {
    const fields = buildCacheFields(small, tooBig);
    expect(fields).toEqual({ cacheV: CACHE_VERSION, svgLight: small });
    expect(fields).not.toHaveProperty('svgDark');
  });
  it('stores only the version when nothing fits', () => {
    expect(buildCacheFields(tooBig, tooBig)).toEqual({ cacheV: CACHE_VERSION });
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
