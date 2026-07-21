#!/usr/bin/env node
//
// Post-deploy verification: assert the Forge installation for an environment is
// actually running the code we just deployed.
//
// `forge deploy` exiting 0 means "the bundle uploaded", not "the installed
// version advanced and the macro can render". The gap this closes is a deploy
// that lands a new app version the installation never adopts (it goes
// out-of-date) — invisible today until a human opens Confluence.
//
// Signal: `forge install list --json` reports, per installation, a `status`
// field ("Up-to-date" when the installation is on the latest deployed version).
// That is a better gate than diffing `appVersion`, because Forge's appVersion is
// a coarse *major* number and this app only ever ships non-major deploys (the
// zero-scope invariant means no major bumps), so appVersion often does not move
// even on a real deploy. We therefore gate on status and log the appVersion
// transition as informational context.
//
// Modes:
//   node scripts/verify-deploy.mjs <env> --snapshot
//       Record the installation's appVersion(s) before deploy into
//       $GITHUB_ENV as PRE_DEPLOY_VERSION. Non-fatal on any error.
//   node scripts/verify-deploy.mjs <env> --verify
//       After deploy, poll until every installation on <env> reports
//       status "Up-to-date". Blocking: non-zero exit fails the CI job.
//
// Edge cases (keep "blocking" honest without false failures):
//   - installation present + up-to-date .......... pass (exit 0)
//   - installation present + not up-to-date ...... fail after poll (exit 1)
//   - no installation exists for <env> ........... ::warning:: + exit 0
//       (a deployed-but-uninstalled environment is a legitimate state we
//        cannot verify a version advance for — surface it, don't block)
//
// Auth/context comes from the same FORGE_EMAIL / FORGE_API_TOKEN env and the
// repo's manifest.yml that the surrounding deploy job already provides. No new
// scope, egress, or resolver — this only reads installation metadata.

import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';

// ~10 x 12s ≈ 2 min to absorb rollout propagation. Overridable via env so a
// maintainer can tune the wait (or a test can run it fast) without editing here.
const POLL_ATTEMPTS = Number(process.env.VERIFY_POLL_ATTEMPTS) || 10;
const POLL_INTERVAL_MS = Number(process.env.VERIFY_POLL_INTERVAL_MS) || 12_000;

const [, , envArg, modeArg] = process.argv;

if (!envArg || !['--snapshot', '--verify'].includes(modeArg)) {
  console.error('usage: verify-deploy.mjs <environment> --snapshot|--verify');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Append a line to a $GITHUB_* file (GITHUB_ENV / GITHUB_STEP_SUMMARY) when the
// runner provides it; a no-op locally so the script is runnable off-CI.
function appendToGithubFile(envVar, line) {
  const path = process.env[envVar];
  if (path) appendFileSync(path, line + '\n');
}

// Run `forge install list --json` and return the parsed array, filtered to the
// target environment. Rejects if the CLI fails or emits unparseable output.
function listInstallations(environment) {
  return new Promise((resolve, reject) => {
    // npx --no-install mirrors the deploy steps: use the pinned devDependency
    // CLI, and fail loudly rather than silently fetch one from the network.
    execFile(
      'npx',
      ['--no-install', 'forge', 'install', 'list', '--json'],
      { maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`forge install list failed: ${stderr || err.message}`));
          return;
        }
        // JSON is on stdout; npm/CLI notices go to stderr. Slice from the first
        // bracket to tolerate any leading noise that leaks onto stdout.
        const start = stdout.indexOf('[');
        if (start === -1) {
          reject(new Error(`no JSON array in forge output: ${stdout.slice(0, 200)}`));
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(stdout.slice(start));
        } catch (e) {
          reject(new Error(`could not parse forge output: ${e.message}`));
          return;
        }
        resolve(parsed.filter((i) => i.environment === environment));
      },
    );
  });
}

const isUpToDate = (inst) => /up-to-date/i.test(inst.status || '');
const describe = (insts) => insts.map((i) => `${i.site}@${i.appVersion} (${i.status})`).join(', ');

async function snapshot(environment) {
  let insts = [];
  try {
    insts = await listInstallations(environment);
  } catch (e) {
    // Non-fatal: --verify does the real gating. Record nothing and move on.
    console.warn(`snapshot: could not read installations: ${e.message}`);
  }
  const versions = insts.map((i) => i.appVersion).join(',');
  appendToGithubFile('GITHUB_ENV', `PRE_DEPLOY_VERSION=${versions}`);
  console.log(
    insts.length
      ? `Pre-deploy ${environment}: ${describe(insts)}`
      : `Pre-deploy ${environment}: no installations`,
  );
}

async function verify(environment) {
  const before = process.env.PRE_DEPLOY_VERSION ?? '(unknown)';

  for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt++) {
    let insts;
    try {
      insts = await listInstallations(environment);
    } catch (e) {
      // Treat a transient CLI/API error as "not yet"; keep polling.
      console.warn(`attempt ${attempt}/${POLL_ATTEMPTS}: ${e.message}`);
      if (attempt < POLL_ATTEMPTS) await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (insts.length === 0) {
      // Nothing installed on this environment — cannot verify a version
      // advance, so surface it loudly but do not fail the pipeline.
      const msg = `No ${environment} installation found; skipping version verification.`;
      console.log(`::warning::${msg}`);
      appendToGithubFile('GITHUB_STEP_SUMMARY', `⚠️ ${environment}: ${msg}`);
      return 0;
    }

    if (insts.every(isUpToDate)) {
      const line = `✅ ${environment} up-to-date — appVersion ${before} → ${describe(insts)}`;
      console.log(line);
      appendToGithubFile('GITHUB_STEP_SUMMARY', line);
      return 0;
    }

    console.log(`attempt ${attempt}/${POLL_ATTEMPTS}: not yet up-to-date — ${describe(insts)}`);
    if (attempt < POLL_ATTEMPTS) await sleep(POLL_INTERVAL_MS);
  }

  const msg = `${environment} installation did not reach "Up-to-date" within the poll window; the deploy uploaded but the installation never advanced.`;
  console.log(`::error::${msg}`);
  appendToGithubFile('GITHUB_STEP_SUMMARY', `❌ ${msg}`);
  return 1;
}

const exitCode = modeArg === '--snapshot' ? await snapshot(envArg) : await verify(envArg);
process.exit(exitCode ?? 0);
