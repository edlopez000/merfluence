import { describe, expect, it, vi } from 'vitest';

// Stand in lightweight fakes for the two mermaid packages: this suite is about
// the registry's resolution and memoization, not about loading ~2MB of real
// renderer twice. Each fake carries an id so we can prove the right major
// resolved.
vi.mock('mermaid', () => ({ default: { __id: 'mermaid-11' } }));
vi.mock('mermaid-10', () => ({ default: { __id: 'mermaid-10' } }));

import {
  DEFAULT_MAJOR,
  VERSION_OPTIONS,
  resolveMajor,
  resolvedVersion,
  loadMermaid,
} from '../src/lib/mermaid-registry.js';

describe('resolveMajor', () => {
  it('maps auto to the default major', () => {
    expect(resolveMajor('auto')).toBe(DEFAULT_MAJOR);
  });

  it('honours a known pinned major', () => {
    expect(resolveMajor('11')).toBe('11');
    expect(resolveMajor('10')).toBe('10');
  });

  it('falls back to the default for unknown or missing prefs', () => {
    // A stale config could carry a major that no longer ships. Rendering under
    // the default beats throwing at a reader.
    expect(resolveMajor('9')).toBe(DEFAULT_MAJOR);
    expect(resolveMajor('garbage')).toBe(DEFAULT_MAJOR);
    expect(resolveMajor(undefined)).toBe(DEFAULT_MAJOR);
    expect(resolveMajor(null)).toBe(DEFAULT_MAJOR);
  });
});

describe('resolvedVersion', () => {
  it('returns a concrete semver per major, distinct across majors', () => {
    // The exact string is baked from the installed packages via the build-time
    // define, so assert shape and distinctness rather than a hardcoded number
    // that a Renovate bump would break.
    const v11 = resolvedVersion('11');
    const v10 = resolvedVersion('10');
    expect(v11).toMatch(/^\d+\.\d+\.\d+/);
    expect(v10).toMatch(/^\d+\.\d+\.\d+/);
    expect(v11).not.toBe(v10);
    expect(resolvedVersion('auto')).toBe(v11);
  });
});

describe('VERSION_OPTIONS', () => {
  it('offers auto plus both pinned majors, in order', () => {
    expect(VERSION_OPTIONS.map((o) => o.value)).toEqual(['auto', '11', '10']);
    // Labels surface the resolved version so the dropdown is self-documenting.
    expect(VERSION_OPTIONS[0].label).toContain(resolvedVersion('auto'));
  });
});

describe('loadMermaid lazy loading', () => {
  it('resolves the fake for the selected major', async () => {
    await expect(loadMermaid('11')).resolves.toMatchObject({ __id: 'mermaid-11' });
    await expect(loadMermaid('10')).resolves.toMatchObject({ __id: 'mermaid-10' });
    await expect(loadMermaid('auto')).resolves.toMatchObject({ __id: 'mermaid-11' });
  });

  it('returns a stable singleton across repeat and aliased loads', async () => {
    // The registry memoizes the loader promise in a Map so a major isn't loaded
    // twice. That cache is not observable through the outer promise (loadMermaid
    // is async, so each call is a fresh wrapper) — what IS observable, and what
    // callers rely on, is that every load of a major yields the same module
    // object, and that `auto` and `11` are the same major.
    const [a, b, viaAuto] = await Promise.all([
      loadMermaid('11'),
      loadMermaid('11'),
      loadMermaid('auto'),
    ]);
    expect(a).toBe(b);
    expect(a).toBe(viaAuto);
  });

  it('keeps the two majors as separate modules', async () => {
    // Per-major dynamic import: pinning 10 resolves a different renderer than 11.
    const [m11, m10] = await Promise.all([loadMermaid('11'), loadMermaid('10')]);
    expect(m11).not.toBe(m10);
    expect(m11.__id).toBe('mermaid-11');
    expect(m10.__id).toBe('mermaid-10');
  });
});
