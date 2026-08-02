---
paths:
  - 'manifest.yml'
---

# Editing manifest.yml

The `permissions` block is the product, not configuration. Absent `scopes`,
absent `external`, absent `function` is what "renders in your browser, never
sent anywhere" means on the listing. Adding any of them is a product change, not
an implementation detail — **stop and tell the user** instead.

`test/manifest.test.js` asserts all of it: no `permissions.scopes`, no
`permissions.external`, no `remotes`, `modules` containing only `macro`, and
`permissions` deep-equal to just `content.styles: ['unsafe-inline']`. A
`PreToolUse` hook (`.claude/hooks/guard-manifest.sh`) blocks the edit before it
is written.

Other things that stay true here:

- The macro `key` is `mermaid-diagram` forever — it is baked into the ADF of
  every diagram already inserted on a page, so renaming it orphans them.
- Run `forge lint` after **any** manifest edit; it is the only thing that
  validates the descriptor's syntax and module shape.
- If permissions ever change (they shouldn't), the app must be **redeployed and
  then reinstalled** — a redeploy alone does not re-prompt for consent.
