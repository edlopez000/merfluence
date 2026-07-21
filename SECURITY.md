# Security Policy

Merfluence's pitch is a security claim — no API scopes, no external network
access, no backend — so a report that undermines that claim is the most valuable
thing you can send us. Thank you for looking.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report privately through GitHub Security Advisories:
[Report a vulnerability](https://github.com/edlopez000/merfluence/security/advisories/new).
That channel is private between you and the maintainers until a fix ships.

If GitHub is not workable for you, open a public issue containing no detail
beyond a request for a private contact channel, and we will follow up.

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
declares no scopes, no egress, and no backend (see `manifest.yml`).

### In scope

Anything that breaks one of those claims, including:

- **A way to get script execution out of a rendered diagram.** Macro config is
  authored by anyone who can edit a page and rendered for everyone who can read
  it, so this is the boundary that matters most. Three independent layers stand
  behind it — Mermaid's `securityLevel: 'strict'`, `htmlLabels: false`, and
  DOMPurify over the emitted SVG — and a break in any _one_ of them is a valid
  report even if the other two happen to contain it.
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
