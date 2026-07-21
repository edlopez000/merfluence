import DOMPurify from 'dompurify';
import { loadMermaid, resolveMajor } from './mermaid-registry.js';

/**
 * Two hardening layers, both load-bearing.
 *
 * Macro config is authored by anyone who can edit the page and rendered for
 * everyone who can read it. Mermaid's `click` directive can bind handlers, and
 * htmlLabels wraps label text in <foreignObject>, which is a hole you can drive
 * arbitrary HTML through.
 *
 *   securityLevel: 'strict'  -> click directives inert, HTML in labels escaped
 *   htmlLabels: false        -> no <foreignObject>, so labels are plain <text>
 *
 * Then DOMPurify with the SVG profile catches whatever the first two missed.
 * With htmlLabels off there is no legitimate <foreignObject>, so the profile
 * stripping it costs us nothing.
 */
function baseConfig({ theme, useMaxWidth }) {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    theme: theme === 'dark' ? 'dark' : 'default',
    fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    flowchart: { htmlLabels: false, useMaxWidth },
    sequence: { useMaxWidth },
    class: { htmlLabels: false, useMaxWidth },
    state: { useMaxWidth },
    er: { useMaxWidth },
    journey: { useMaxWidth },
    gantt: { useMaxWidth },
    pie: { useMaxWidth },
    // The rest of the template types. Every section below exposes useMaxWidth in
    // Mermaid 11, so the "Keep full width" toggle reaches them too. Keys absent in
    // major 10 (kanban/architecture/block) are simply ignored there.
    mindmap: { useMaxWidth },
    timeline: { useMaxWidth },
    gitGraph: { useMaxWidth },
    quadrantChart: { useMaxWidth },
    xyChart: { useMaxWidth },
    sankey: { useMaxWidth },
    c4: { useMaxWidth },
    block: { useMaxWidth },
    kanban: { useMaxWidth },
    architecture: { useMaxWidth },
  };
}

const SANITIZE = {
  USE_PROFILES: { svg: true, svgFilters: true },
  ADD_ATTR: ['transform-origin'],
};

/**
 * The single sanitize policy, exported so every path that injects SVG into a
 * reader's DOM runs the same one. Fresh renders sanitize here; the view also
 * runs cached SVG through this before injecting it, because that cache lives in
 * macro config — an untrusted-input boundary — and may have been hand-edited to
 * bypass the sanitize that ran at save time.
 */
export function sanitizeSvg(svg) {
  return DOMPurify.sanitize(svg ?? '', SANITIZE);
}

let seq = 0;
const nextId = () => `mmd-${Date.now().toString(36)}-${seq++}`;

/**
 * Mermaid's parse errors carry a line number in different shapes depending on
 * whether the grammar is jison-based (`hash.loc.first_line`) or one of the
 * newer langium parsers (line embedded in the message). Dig out whatever we
 * can and fall back to the raw message.
 */
export function describeError(err) {
  const message = String(err?.message ?? err ?? 'Unknown error').trim();

  const jisonLine = err?.hash?.loc?.first_line;
  if (Number.isInteger(jisonLine)) {
    return { line: jisonLine, message };
  }

  const match = message.match(/line[:\s]+(\d+)/i);
  if (match) {
    return { line: Number(match[1]), message };
  }

  return { line: null, message };
}

/** Throws on invalid syntax. Cheap enough to run on every keystroke. */
export async function validate(source, versionPref = 'auto') {
  const mermaid = await loadMermaid(versionPref);
  mermaid.initialize(baseConfig({ theme: 'default', useMaxWidth: true }));
  await mermaid.parse(source);
}

/**
 * @returns {Promise<{ svg: string, major: string }>} sanitized SVG markup
 */
export async function renderDiagram({
  source,
  versionPref = 'auto',
  theme = 'light',
  useMaxWidth = true,
}) {
  const trimmed = (source ?? '').trim();
  if (!trimmed) throw new Error('Diagram is empty');

  const mermaid = await loadMermaid(versionPref);
  mermaid.initialize(baseConfig({ theme, useMaxWidth }));

  // parse() first so a syntax error never leaves an orphan <div id="dmmd-...">
  // pinned to the document, which is a real Mermaid failure mode.
  await mermaid.parse(trimmed);

  const { svg } = await mermaid.render(nextId(), trimmed);
  return { svg: sanitizeSvg(svg), major: resolveMajor(versionPref) };
}

/** Intrinsic pixel size of a rendered SVG, for sizing the iframe. */
export function measureSvg(container) {
  const svg = container?.querySelector('svg');
  if (!svg) return null;
  const box = svg.getBoundingClientRect();
  return { width: Math.ceil(box.width), height: Math.ceil(box.height) };
}
