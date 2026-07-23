import { describe, expect, it } from 'vitest';
import { fingerprint } from '../scripts/prod-deps-fingerprint.mjs';

// Build a minimal lockfile-v3-shaped object: a root entry plus a couple of
// production packages and one dev-only package. `dev: true` is npm's own marker
// for "installed only for devDependencies", which is exactly what must NOT move
// the fingerprint.
function lock(overrides = {}) {
  return {
    lockfileVersion: 3,
    packages: {
      '': { name: 'merfluence', version: '1.0.0' },
      'node_modules/mermaid': { version: '11.4.1', resolved: 'r/mermaid', integrity: 'sha512-m' },
      'node_modules/dompurify': {
        version: '3.2.3',
        resolved: 'r/dompurify',
        integrity: 'sha512-d',
      },
      'node_modules/eslint': { version: '9.39.5', dev: true },
      ...overrides,
    },
  };
}

describe('prod-deps-fingerprint', () => {
  it('ignores the root project entry (its version is the app release, not a shipped dep)', () => {
    const a = lock();
    const b = lock({ '': { name: 'merfluence', version: '2.0.0' } });
    expect(fingerprint(b)).toBe(fingerprint(a));
  });

  it('is unchanged when a dev-only dependency is added — the tooling-churn case', () => {
    const base = fingerprint(lock());
    const withDevDep = fingerprint(
      lock({ 'node_modules/size-limit': { version: '12.1.0', dev: true } }),
    );
    expect(withDevDep).toBe(base);
  });

  it('is unchanged when a dev-only dependency changes version', () => {
    const base = fingerprint(lock());
    const bumped = fingerprint(lock({ 'node_modules/eslint': { version: '9.40.0', dev: true } }));
    expect(bumped).toBe(base);
  });

  it('changes when a production dep version moves (the in-range Mermaid bump case)', () => {
    const base = fingerprint(lock());
    const bumped = fingerprint(
      lock({
        'node_modules/mermaid': { version: '11.5.0', resolved: 'r/mermaid', integrity: 'sha512-m' },
      }),
    );
    expect(bumped).not.toBe(base);
  });

  it('changes when a production dep is re-pointed at the same version (resolved/integrity move)', () => {
    const base = fingerprint(lock());
    const moved = fingerprint(
      lock({
        'node_modules/mermaid': {
          version: '11.4.1',
          resolved: 'r/mermaid-mirror',
          integrity: 'sha512-DIFFERENT',
        },
      }),
    );
    expect(moved).not.toBe(base);
  });

  it('changes when a production dep is added or removed', () => {
    const base = fingerprint(lock());
    const added = fingerprint(lock({ 'node_modules/marked': { version: '9.0.0' } }));
    expect(added).not.toBe(base);

    const withoutDompurify = lock();
    delete withoutDompurify.packages['node_modules/dompurify'];
    expect(fingerprint(withoutDompurify)).not.toBe(base);
  });

  it('is stable regardless of package key insertion order', () => {
    const forward = lock();
    const reversed = {
      lockfileVersion: 3,
      packages: Object.fromEntries(Object.entries(forward.packages).reverse()),
    };
    expect(fingerprint(reversed)).toBe(fingerprint(forward));
  });

  it('treats a missing packages map as an empty (deterministic) closure', () => {
    expect(fingerprint({})).toBe(fingerprint({ packages: {} }));
  });
});
