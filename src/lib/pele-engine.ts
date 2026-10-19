/**
 * Pele renderer adapter — an EXPERIMENTAL alternative to Mermaid.
 *
 * Pele (github.com/obsidianmd/pele) is an independent re-implementation of the
 * Mermaid grammar with its own layout and visual style: synchronous, no runtime
 * dependencies, and a few KB of SVG per diagram where Mermaid emits a 10-20KB
 * theme stylesheet with every render. It is selected at *build* time
 * (MERFLUENCE_ENGINE=pele, see vite.view.config.js), never per diagram, so the
 * macro config schema is untouched and a stock build still ships Mermaid only.
 *
 * Everything that reaches the DOM still goes through render.ts's sanitizeSvg —
 * the DOMPurify SVG profile plus the egress hook. Pele's own escaping and URL
 * filtering are a first layer, not a replacement for ours. The two
 * Mermaid-specific layers (securityLevel:'strict', htmlLabels:false) have no
 * Pele equivalent to set: Pele never emits <foreignObject> or event handlers,
 * and `links: false` / `images: false` below are its closest analogue — they
 * drop `click`/`href` links and image nodes before any markup exists.
 */

// render.ts only ever reaches this module through a dynamic import, so this
// static import is not a load-time cycle.
import { MAX_SOURCE_CHARS } from './render.js';

/**
 * Pele colours come from CSS custom properties, so in principle one SVG serves
 * both themes. But a diagram can force its own theme (config.theme) regardless
 * of the host's mode, and the cache stores a light and a dark variant, so the
 * palette is baked onto the SVG root per render — same contract as Mermaid's
 * theme: 'dark'. Values are the Atlassian Design System token colours, so a
 * diagram matches the page around it.
 */
const PALETTES: Record<'light' | 'dark', Record<string, string>> = {
  light: {
    '--pele-bg': '#ffffff',
    '--pele-fg': '#172b4d',
    '--pele-muted': '#626f86',
    '--pele-line': '#44546f',
    '--pele-surface': '#f7f8f9',
    '--pele-surface-alt': '#f1f2f4',
    '--pele-border': '#8590a2',
    '--pele-accent': '#0c66e4',
  },
  dark: {
    '--pele-bg': '#22272b',
    '--pele-fg': '#b6c2cf',
    '--pele-muted': '#8c9bab',
    '--pele-line': '#9fadbc',
    '--pele-surface': '#2c333a',
    '--pele-surface-alt': '#38414a',
    '--pele-border': '#738496',
    '--pele-accent': '#579dff',
  },
};

// Matches Mermaid's fontFamily in render.ts so the comparison is about layout,
// not typeface. Pele measures with a canvas in the browser using this family.
const FONT_FAMILY =
  'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

// The lazy entry registers every diagram type as its own dynamic import, so a
// flowchart page fetches the core plus the flowchart module and nothing else.
// Cached as a promise so concurrent callers share one fetch.
let peleModule: Promise<typeof import('pele/lazy')> | null = null;
export function loadPele() {
  peleModule ??= import('pele/lazy');
  return peleModule;
}

function options() {
  return {
    fontFamily: FONT_FAMILY,
    // Pele defaults allow http(s) links and images. Both turn into a network
    // request or a navigation on a reader's page, so both go — the egress hook
    // would strip external ones anyway; this means they are never built at all.
    links: false,
    images: false,
    limit: MAX_SOURCE_CHARS,
    // Stage owns sizing (see src/view/index.html); a fixed-geometry SVG keeps the
    // viewBox the single source of truth it reads, as with Mermaid.
    responsive: false,
  };
}

function applyPalette(svg: string, theme: string) {
  const palette = PALETTES[theme === 'dark' ? 'dark' : 'light'];
  const vars = Object.entries(palette)
    .map(([k, v]) => `${k}:${v}`)
    .join(';');
  // Prepend to the root's own style attribute. Pele's root style reads these
  // through var(--pele-x, fallback), and a declaration on the same element wins
  // over anything inherited from the page.
  return svg.replace(/^<svg\b([^>]*?) style="/, `<svg$1 style="${vars};`);
}

export async function renderWithPele(source: string, theme: string) {
  const pele = await loadPele();
  const { svg } = await pele.renderAsync(source, options());
  return applyPalette(svg, theme);
}

/** Throws a PeleError (with a 1-based `line`) on invalid syntax. */
export async function validateWithPele(source: string) {
  const pele = await loadPele();
  const type = pele.detectType(source);
  if (!(await pele.load(type))) {
    throw new Error('No diagram type detected');
  }
  pele.parse(source, { limit: MAX_SOURCE_CHARS });
}
