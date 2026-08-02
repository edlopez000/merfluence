#!/usr/bin/env bash
# PreToolUse guard for the invariant that defines this app.
#
# CLAUDE.md asks Claude not to add a scope, an egress permission, or a resolver
# to manifest.yml — but CLAUDE.md is context, not enforcement. This hook is the
# enforcement: it inspects the *proposed* content of a Write/Edit to
# manifest.yml and exits 2 (block, with stderr fed back to the model) if that
# content introduces one. test/manifest.test.js catches the same thing in CI;
# this catches it a few minutes earlier, before the edit lands.
#
# Node rather than jq: node is already a hard dependency of this repo, jq is not.
set -euo pipefail

node -e '
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    // A payload we cannot parse is not evidence of a violation. Never block on
    // our own failure to read the input.
    process.exit(0);
  }

  const input = payload.tool_input || {};
  const file = String(input.file_path || "");
  if (!/(^|\/)manifest\.yml$/.test(file)) process.exit(0);

  // Write carries the whole file; Edit carries only the replacement text. Both
  // are enough — a violation has to appear in the text being introduced.
  const proposed = [input.content, input.new_string]
    .filter((v) => typeof v === "string")
    .join("\n");
  if (!proposed) process.exit(0);

  // Ignore comment lines so the explanatory block in manifest.yml (which names
  // all three forbidden keys to document their absence) is not a false hit.
  const lines = proposed.split("\n").filter((l) => !/^\s*#/.test(l));

  const banned = [
    [/^\s{0,4}scopes\s*:/m, "a `scopes:` block"],
    [/^\s{0,4}external\s*:/m, "an `external:` egress permission"],
    [/^\s{0,4}remotes\s*:/m, "a `remotes:` declaration"],
    [/^\s{0,4}function\s*:/m, "a `function:` module (a backend resolver)"],
  ];

  const body = lines.join("\n");
  const hits = banned.filter(([re]) => re.test(body)).map(([, label]) => label);
  if (hits.length === 0) process.exit(0);

  process.stderr.write(
    "Blocked: this edit adds " + hits.join(" and ") + " to manifest.yml.\n\n" +
      "Merfluence requests no scopes, no egress, and no backend — that posture " +
      "is the product, and test/manifest.test.js asserts it. Do not work around " +
      "this hook. Stop and tell the user what the task appears to need and why.\n"
  );
  process.exit(2);
});
'
