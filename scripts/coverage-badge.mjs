#!/usr/bin/env node
//
// Turn a v8/istanbul coverage-summary.json into a shields.io *endpoint* JSON —
// the little { schemaVersion, label, message, color } blob the README's coverage
// badge reads.
//
// Why this exists (self-hosted coverage badge — no coverage SaaS):
// the project's whole posture is zero-egress and minimal third-party surface, so
// the coverage number is NOT uploaded to Codecov/Coveralls. Instead the
// coverage-badge job in .github/workflows/ci.yml runs this over the report the
// `corpus` job already produced and publishes the output to the gh-pages branch,
// where shields reads it via a raw.githubusercontent URL. No new secret, no new
// third-party action — only the built-in GITHUB_TOKEN pushes the branch.
//
// The badge reports total LINE coverage (total.lines.pct): it's the figure most
// readers mean by "coverage", and it moves with the vitest line floor (70) that
// CI already enforces. Color follows the conventional shields ramp.
//
// Usage:
//   node scripts/coverage-badge.mjs <path-to-coverage-summary.json>
// Prints the endpoint JSON to stdout. On any read/parse failure it prints nothing
// and exits non-zero, so CI fails loudly rather than publishing a bogus badge.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Conventional shields color ramp, keyed on the rounded percentage. */
function colorFor(pct) {
  if (pct >= 90) return 'brightgreen';
  if (pct >= 80) return 'green';
  if (pct >= 70) return 'yellowgreen';
  if (pct >= 60) return 'yellow';
  if (pct >= 50) return 'orange';
  return 'red';
}

/** Build the shields endpoint object from a parsed coverage-summary.json. */
export function coverageBadge(summary) {
  const pct = summary?.total?.lines?.pct;
  if (typeof pct !== 'number' || Number.isNaN(pct)) {
    throw new Error('coverage-summary.json has no numeric total.lines.pct');
  }
  const rounded = Math.round(pct);
  return {
    schemaVersion: 1,
    label: 'coverage',
    message: `${rounded}%`,
    color: colorFor(rounded),
  };
}

// Run as a CLI only when invoked directly (kept importable for a unit test).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: node scripts/coverage-badge.mjs <coverage-summary.json>');
    process.exit(1);
  }
  const summary = JSON.parse(readFileSync(path, 'utf8'));
  process.stdout.write(JSON.stringify(coverageBadge(summary)));
}
