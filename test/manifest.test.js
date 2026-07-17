import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * The manifest IS the product.
 *
 * Zero scopes, zero egress, no backend — that claim is what the app is sold on,
 * and it lives in exactly one file that a single careless line can undo.
 *
 * `forge lint` is not that gate, for two independent reasons. It authenticates
 * against Atlassian before it will run, so it cannot run in a PR job without
 * putting a deploy token in reach of every pull request, forks included. And
 * it would not catch this anyway: a manifest carrying
 * `scopes: [read:confluence-content.all]` plus `external.fetch.client` to an
 * arbitrary host lints at 0 errors, because that manifest is perfectly legal
 * Forge — legality is what the linter checks, and requesting scopes is legal.
 * It is *our* policy that they are forbidden, so the check has to be ours.
 * (forge lint still runs before the staging deploy, where it catches real
 * schema errors like a dangling resource key. Different job, different job.)
 *
 * Parsed, not grepped: the comment block in manifest.yml documents the
 * invariant using the very strings a grep would look for ("scopes: absent"),
 * so a text search would match the prose promising the opposite of a breach.
 */

const manifestPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'manifest.yml');
const manifest = parse(readFileSync(manifestPath, 'utf8'));

describe('manifest declares no scopes, no egress, no backend', () => {
  it('requests no scopes', () => {
    expect(manifest.permissions?.scopes).toBeUndefined();
  });

  it('requests no external permissions', () => {
    // permissions.external is how fetch (client or backend) gets authorised.
    expect(manifest.permissions?.external).toBeUndefined();
  });

  it('declares no remotes', () => {
    // Current Forge routes egress through a top-level `remotes:` block that
    // permissions.external then references. Absent scopes but present remotes
    // would still be a hole, so check the vector rather than only the grant.
    expect(manifest.remotes).toBeUndefined();
  });

  it('ships macro modules only', () => {
    // One assertion covering every backend surface at once: function
    // (resolver), webtrigger, trigger, scheduledTrigger, consumer. A new
    // module key failing here is the point — it should need a deliberate
    // decision, not a silent merge.
    expect(Object.keys(manifest.modules)).toEqual(['macro']);
  });

  it('grants inline styles and nothing else', () => {
    // Mermaid writes style="" onto the SVG it generates, so styles are load
    // bearing. Scripts and unsafe-eval never are. Assert the whole permissions
    // shape, so an added sibling key has to fail rather than slip in beside it.
    expect(manifest.permissions).toEqual({
      content: {
        styles: ['unsafe-inline'],
      },
    });
  });
});
