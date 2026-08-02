---
paths:
  - 'test/**'
  - 'vitest.config.js'
---

# Test suite

`vitest run` runs two projects, and both must stay green:

- `npm run test:unit` — jsdom. Includes `test/parse.test.js`, which feeds every
  fixture in `test/fixtures/*.mmd` through `mermaid.parse()` on **both** pinned
  majors, and `test/manifest.test.js`, which asserts the zero-scope invariant.
- `npm run test:browser` — real Chromium via Playwright. Exercises the full
  render pipeline and drives XSS payloads end-to-end. Add `:headed` to that
  script name to watch it run when a failure needs eyes on it.

`npm run test:coverage` enforces the v8 thresholds configured in
`vitest.config.js`; CI runs it, so a new module with no test can fail the build
even when every existing test passes.

## Conventions

- **New diagram type → new fixture.** Add the `.mmd` to `test/fixtures/` in the
  same change; the parse corpus picks it up automatically.
- A new sanitizer or egress rule needs a payload in `test/sanitize.test.js` or
  `test/browser/xss.e2e.test.js` that fails without the fix. Asserting the
  strip happened is not the same as asserting the attack is dead.
- The Forge host is never mocked directly. Tests mock the wrapper module
  instead — `vi.mock('../src/lib/host.js', …)` — so `@forge/bridge` stays behind
  `src/lib/host.ts`. Keep new bridge calls inside that wrapper.
- Test specifiers keep the `.js` extension even though the sources are `.ts`
  (`'../src/lib/render.js'` resolves to `render.ts`). Match that, or the mock
  silently applies to nothing.
- Needs Node ≥22.12 (see `engines.node`); older Node fails on the rolldown
  native binding rather than on anything in the tests.
