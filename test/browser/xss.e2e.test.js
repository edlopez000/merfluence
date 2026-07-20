import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderDiagram, sanitizeSvg } from '../../src/lib/render.js';

/**
 * The test the safety claim was missing: a genuinely malicious diagram, driven
 * through the whole pipeline in a real browser, must not execute anything.
 *
 * sanitize.test.js proves the DOMPurify layer in isolation on hand-written
 * markup. This proves the three layers TOGETHER — securityLevel:'strict' +
 * htmlLabels:false + DOMPurify — against SVG Mermaid actually produced from
 * attacker-controlled source, injected into a live document exactly as the
 * reader view injects it. A regression in any single layer that the other two
 * happened to be covering shows up here as a fired tripwire.
 *
 * The tripwire is a global window.__pwn(): every payload tries to call it (via
 * script text, an event handler, or a javascript: URL). If any of them ever
 * runs, __pwned flips and the case fails — so these tests assert on *behaviour*
 * (did code run?), not merely on the shape of the sanitized string.
 */

beforeEach(() => {
  window.__pwned = false;
  window.__pwn = () => {
    window.__pwned = true;
  };
});

let mounted = [];
afterEach(() => {
  for (const host of mounted) host.remove();
  mounted = [];
  delete window.__pwned;
  delete window.__pwn;
});

/**
 * Inject like the reader view does, then actively try to trigger anything that
 * survived: fire the events inline handlers hook, and click every link so a
 * javascript: href would navigate. Returns the host for structural assertions.
 */
function injectAndProvoke(svg) {
  const host = document.createElement('div');
  host.innerHTML = svg;
  document.body.appendChild(host);
  mounted.push(host);

  // 'error' is intentionally omitted: the browser special-cases it as an
  // uncaught-error signal (noisy in the log), and the elements an onerror would
  // ride in on are stripped before injection anyway, so it adds no coverage.
  for (const el of host.querySelectorAll('*')) {
    for (const type of ['load', 'click', 'mouseover']) {
      el.dispatchEvent(new Event(type, { bubbles: true }));
    }
  }
  return host;
}

/** No script node, no on* handler, no javascript: URL survived anywhere. */
function assertInert(host) {
  expect(host.querySelector('script')).toBeNull();

  for (const el of host.querySelectorAll('*')) {
    for (const attr of el.attributes) {
      expect(
        attr.name.toLowerCase().startsWith('on'),
        `unexpected event handler ${attr.name}`,
      ).toBe(false);
      expect(
        /javascript:/i.test(attr.value),
        `unexpected javascript: URL in ${attr.name}`,
      ).toBe(false);
    }
  }
}

// Payloads that parse as valid Mermaid but carry an attack in attacker-authored
// positions: node labels, edge labels, and click/link directives. Each aims at
// a different layer, and all funnel through renderDiagram.
const MALICIOUS_SOURCES = {
  'script in a node label': `flowchart TD
  A["<script>window.__pwn()</script>"] --> B["ok"]`,

  'img onerror in a node label': `flowchart TD
  A["<img src=x onerror='window.__pwn()'>"] --> B`,

  'foreignObject html in a node label': `flowchart TD
  A["<foreignObject><body onload='window.__pwn()'>x</body></foreignObject>"] --> B`,

  'javascript: click directive': `flowchart TD
  A --> B
  click A "javascript:window.__pwn()"`,

  'click callback binding': `flowchart TD
  A --> B
  click A call __pwn()`,

  'script in a sequence note': `sequenceDiagram
  participant A
  Note over A: <img src=x onerror=window.__pwn()>`,
};

describe('malicious diagram source stays inert end-to-end', () => {
  for (const [name, source] of Object.entries(MALICIOUS_SOURCES)) {
    it(name, async () => {
      // A payload that fails to parse is trivially safe but tests nothing about
      // the render/sanitize path, so require these to actually render.
      const { svg } = await renderDiagram({ source });
      const host = injectAndProvoke(svg);

      // Give any queued microtask/handler a turn to misbehave before asserting.
      await Promise.resolve();

      expect(window.__pwned, 'a payload executed').toBe(false);
      assertInert(host);
    });
  }
});

describe('tampered cached SVG stays inert end-to-end', () => {
  // The reader view re-sanitizes SVG pulled from macro config before injecting
  // it, because that config is an untrusted boundary someone may have hand-edited
  // to bypass the sanitize that ran at save time. These strings are what Mermaid
  // would never emit but a tamperer might paste.
  const TAMPERED = {
    'raw script element': `<svg xmlns="http://www.w3.org/2000/svg"><script>window.__pwn()</script><rect width="10" height="10"/></svg>`,
    'onload on the root svg': `<svg xmlns="http://www.w3.org/2000/svg" onload="window.__pwn()"><rect width="10" height="10"/></svg>`,
    'javascript: xlink:href': `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="javascript:window.__pwn()"><text>go</text></a></svg>`,
    'img onerror smuggled via foreignObject': `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><img src=x onerror="window.__pwn()"></foreignObject></svg>`,
  };

  for (const [name, markup] of Object.entries(TAMPERED)) {
    it(name, async () => {
      const host = injectAndProvoke(sanitizeSvg(markup));
      await Promise.resolve();

      expect(window.__pwned, 'a tampered payload executed').toBe(false);
      assertInert(host);
      // foreignObject is stripped wholesale (htmlLabels is off, so nothing
      // legitimate lives in one).
      expect(host.querySelector('foreignObject')).toBeNull();
    });
  }
});
