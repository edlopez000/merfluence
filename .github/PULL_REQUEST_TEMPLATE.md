<!--
PR titles must follow Conventional Commits — we squash-merge, so the title
becomes the commit subject on `main` and drives versioning and the changelog.
See CONTRIBUTING.md for the type table. CI checks this.
-->

## What this changes

<!-- What it does and why. Link the issue it closes: "Closes #123". -->

## The invariant

Merfluence requests **no scopes, no egress, no resolver** — only
`content.styles: unsafe-inline`. `test/manifest.test.js` enforces this.

- [ ] This PR adds no API scope, no `external` permission, and no `function` /
      resolver module.

<!--
If you cannot tick that box, stop and open an issue instead — that is a change
to the product, not an implementation detail.
-->

## Checks

- [ ] `npm test` — the unit suite, the parse corpus, and the browser E2E all green
- [ ] `npm run build` — both Vite bundles build
- [ ] `npm run lint` and `npm run format:check`
- [ ] New diagram type → **new fixture** in `test/fixtures/`
- [ ] Rendering stays client-side; diagram source still lives only in macro config
- [ ] `securityLevel: 'strict'`, `htmlLabels: false`, and DOMPurify still applied
      to every rendered SVG

<!-- Delete any line above that does not apply, rather than leaving it unticked. -->

## Anything reviewers should know

<!-- Trade-offs, things you were unsure about, follow-up work you deliberately left out. -->
