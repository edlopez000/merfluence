#!/usr/bin/env node
//
// Fingerprint the PRODUCTION dependency closure of a package-lock.json — the set
// of packages `npm ci --omit=dev` would install, which is exactly what gets
// bundled and shipped to customer browsers.
//
// Why this exists (deploy-gating security surface — change deliberately):
// the `changes` job in .github/workflows/ci.yml decides whether a
// push to main ships. Listing package.json / package-lock.json as whole-file
// path globs over-triggers: a devDependencies/scripts-only edit produces a
// byte-identical Forge bundle yet still burns a production approval on a no-op.
//
// Keying on package.json's `dependencies` object instead would UNDER-trigger and
// fail OPEN: runtime deps use caret ranges (mermaid: "^11.4.1", …), so Renovate's
// in-range bumps — the whole point of this "Mermaid update" pipeline — land
// lockfile-only, leaving package.json untouched. A real Mermaid 11.4.x → 11.5.0
// ship would then silently skip deploy.
//
// The lockfile is the authority on what actually installs. Lockfile v3 marks
// every `packages` entry with a `dev` flag; the entries WITHOUT it (dev !== true)
// are the production closure. Fingerprinting that closure lets the CI gate deploy
// iff the shipped bytes could change — whether the change arrived via package.json
// or lockfile-only — and skip pure dev/tooling churn. See test/prod-deps-
// fingerprint.test.js for the behaviour this guarantees.
//
// Usage:
//   node scripts/prod-deps-fingerprint.mjs <path-to-package-lock.json>
// Prints a stable hex fingerprint to stdout. On any read/parse failure it prints
// nothing and exits non-zero, so the caller treats "can't determine" as a reason
// to deploy (fail-closed), never to skip.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/**
 * Stable SHA-256 over the production (non-dev) dependency closure of a parsed
 * package-lock.json (lockfileVersion 2/3, which carries the `packages` map).
 *
 * An entry ships unless it is dev-only (`dev === true`). `devOptional`/`optional`
 * entries are kept — reachable via a production path in at least one resolution,
 * so include them conservatively (fail toward shipping). resolved+integrity join
 * the version so a same-version re-point (registry move, integrity change) still
 * moves the fingerprint.
 */
export function fingerprint(lockJson) {
  const packages = lockJson?.packages ?? {};
  const lines = [];
  for (const [path, entry] of Object.entries(packages)) {
    // The root project ("") is not an installed package; its version tracks the
    // app's own release, which is irrelevant to what npm pulls into the bundle.
    if (path === '' || entry?.dev === true) continue;
    lines.push(
      `${path}@${entry?.version ?? ''}|${entry?.resolved ?? ''}|${entry?.integrity ?? ''}`,
    );
  }
  lines.sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

// CLI: only when invoked directly, not when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const lockPath = process.argv[2];
  if (!lockPath) {
    console.error('usage: prod-deps-fingerprint.mjs <path-to-package-lock.json>');
    process.exit(2);
  }
  try {
    process.stdout.write(fingerprint(JSON.parse(readFileSync(lockPath, 'utf8'))));
  } catch (err) {
    console.error(`prod-deps-fingerprint: ${err.message}`);
    process.exit(1);
  }
}
