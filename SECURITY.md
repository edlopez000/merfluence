# Security Policy

Merfluence's pitch is a security claim — no API scopes, no external network
access, no backend — so a report that undermines that claim is the most valuable
thing you can send us. Thank you for looking.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report privately through GitHub Security Advisories:
[Report a vulnerability](https://github.com/edlopez000/merfluence/security/advisories/new).
That channel is private between you and the maintainers until a fix ships.

If GitHub is not workable for you, mail <support@edwardlopez.dev> asking for a
private contact channel, or open a public issue containing no detail beyond that
same request, and we will follow up.

**Please do not raise a vulnerability on the
[service desk](https://lopezedward.atlassian.net/servicedesk/customer/portal/1).**
It is the right place for support requests and the wrong place for this — use
the advisory link above, which stays private until a fix ships.

What helps most, roughly in order:

- The diagram source or macro configuration that triggers it.
- The Mermaid version selected on the diagram (`Auto`, `11`, or `10`) — the app
  ships two majors, and they do not always behave alike.
- Browser and Confluence flavour (Cloud site, company-hosted, etc.).
- What you expected versus what happened. A proof of concept is welcome but not
  required; a clear description of the mechanism is enough to start.

### What to expect

This is a volunteer-maintained open-source project, so response times are
best-effort rather than contractual:

- **Acknowledgement** within 5 business days.
- **An initial assessment** — whether we can reproduce it, and a rough severity —
  within 10 business days.
- **Disclosure** by advisory once a fix is released. We are glad to credit you,
  or to keep you anonymous; tell us which you prefer.

If you have not heard back within those windows, please ping the advisory thread
— it means something got lost, not that the report was dismissed.

## Supported versions

Only the version currently published on the Atlassian Marketplace is supported.
Fixes ship forward from `main`; there are no backport branches. Marketplace minor
updates reach installed instances without admin re-approval, so a fix typically
reaches users within about an hour of release.

## Scope

The app is a Confluence Cloud macro that runs entirely in the reader's browser.
Diagram source lives in the macro's own configuration on the Confluence page; it
is never transmitted to us, because there is nowhere for it to go — the app
declares no scopes, no egress, and no backend (see `manifest.yml`). The
[privacy policy](https://edwardlopez.dev/privacy) states the same commitment
formally.

### In scope

Anything that breaks one of those claims, including:

- **A way to get script execution out of a rendered diagram.** Macro config is
  authored by anyone who can edit a page and rendered for everyone who can read
  it, so this is the boundary that matters most. Three layers stand behind it,
  in depth rather than side by side: Mermaid's `securityLevel: 'strict'` and
  `htmlLabels: false` shape the SVG before it is sanitized, and DOMPurify over
  the emitted SVG enforces the result. A break in any _one_ of them is a valid
  report even if the others happen to contain it — including a case where the
  Mermaid settings alone would have held, because the enforcing layer is the one
  we rely on.
- **Anything that causes data to leave the page** — a network request to any
  host, a diagram's source reaching a third party, or a way to make the app
  request a permission it does not declare.
- **A path that bypasses the sanitizer**, including via the rendered-SVG cache
  stored in macro config. Treat that cache as attacker-controlled — we do.
- **Anything in `manifest.yml` that grants more than it appears to.**

### Out of scope

- Vulnerabilities in Confluence, Forge, or the Atlassian platform itself. Report
  those to [Atlassian](https://www.atlassian.com/trust/security/report-a-vulnerability).
- Findings that require a Confluence account already able to edit the page, and
  achieve nothing that editing the page would not already allow. A page editor
  can already write arbitrary page content; the interesting question is what a
  _reader_ is exposed to.
- Advisories against development-only dependencies (`vitest`, `vite`,
  `@forge/cli`). Nothing in `devDependencies` reaches a customer's browser —
  only the runtime bundle ships. This is why CI audits with `--omit=dev`.
- Denial of service achieved by authoring a pathological diagram, which mainly
  affects the author's own page.

## Supply chain

Every tagged release carries a **CycloneDX 1.6 JSON SBOM** as a GitHub Release
asset, named `merfluence-X.Y.Z.cdx.json`. It lists every production dependency
resolved at that tag — name, version, [PURL](https://github.com/package-url/purl-spec),
integrity hash, declared licence — plus the dependency graph between them, so a
scanner can answer "are we exposed to CVE-x?" without re-resolving our tree.

Its boundary is the same `--omit dev` line the audit draws, and for the same
reason: dev-only tooling never reaches a customer's browser, so listing it would
pad the inventory with components that are not, in any meaningful sense, part of
the shipped product. Regenerate it from any checkout with `npm run sbom`; it is
built from an installed tree rather than the lockfile alone, because the lockfile
records a licence for only about half its entries.

Alongside it, CI enforces on every pull request:

- `npm audit --omit=dev --audit-level=high` — no known high or critical
  advisories in the shipping tree.
- [Dependency Review](.github/workflows/dependency-review.yml) — blocks a newly
  introduced high-severity advisory, and denies copyleft licences (GPL, LGPL,
  AGPL, SSPL, BUSL) before they enter the tree the SBOM then enumerates.
- [CodeQL](.github/workflows/codeql.yml) and
  [OpenSSF Scorecard](.github/workflows/scorecard.yml).

Dependency updates arrive through Renovate with a 14-day `minimumReleaseAge`
cooldown, so a compromised release has to survive two weeks of public scrutiny
before it is proposed here. Security fixes bypass the cooldown.
