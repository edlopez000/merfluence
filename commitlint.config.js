// Conventional Commits enforcement for local commits (via the husky commit-msg
// hook) and directly with `npx commitlint`. The same vocabulary gates PR titles
// in CI (.github/workflows/pr-title-lint.yml) — squash-merge makes the PR title
// the commit subject that release-please reads to compute the next version and
// changelog entry, so the two enforcement points must agree. ESM `export
// default` because package.json declares "type": "module".
export default {
  extends: ['@commitlint/config-conventional'],
};
