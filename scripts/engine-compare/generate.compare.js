import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { renderDiagram, sanitizeSvg } from '../../src/lib/render.js';
import { ensureAccessibleName } from '../../src/lib/a11y-name.js';
import { renderWithPele } from '../../src/lib/pele-engine.js';

/**
 * Renders every parse-corpus fixture with Mermaid (the shipping pipeline, via
 * renderDiagram) and with Pele, both themes, and writes the sanitized SVG —
 * exactly what a reader's DOM would receive — side by side, plus an index.html
 * and a stats.json. commands.writeFile resolves paths against the project root.
 */
const OUT = 'docs/engine-compare';

const raw = import.meta.glob('../../test/fixtures/*.mmd', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const fixtures = Object.entries(raw).map(([path, src]) => [
  path.split('/').pop().replace('.mmd', ''),
  src,
]);

async function timed(fn) {
  const t = performance.now();
  try {
    const svg = await fn();
    return { svg, ms: +(performance.now() - t).toFixed(1) };
  } catch (err) {
    return { error: String(err?.message ?? err), ms: +(performance.now() - t).toFixed(1) };
  }
}

const bytes = (s) => new TextEncoder().encode(s ?? '').length;

it('renders the corpus through both engines', { timeout: 300_000 }, async () => {
  const stats = [];
  // Warm both engines first so the first fixture doesn't carry module load time.
  await timed(() => renderDiagram({ source: 'flowchart LR\n A-->B', theme: 'light' }));
  await timed(() => renderWithPele('flowchart LR\n A-->B', 'light'));

  for (const [name, source] of fixtures) {
    const row = { name };
    for (const theme of ['light', 'dark']) {
      const mermaid = await timed(async () => (await renderDiagram({ source, theme })).svg);
      const pele = await timed(async () =>
        sanitizeSvg(ensureAccessibleName(await renderWithPele(source.trim(), theme))),
      );
      for (const [engine, r] of [
        ['mermaid', mermaid],
        ['pele', pele],
      ]) {
        const file = `${OUT}/${engine}/${name}.${theme}.svg`;
        await commands.writeFile(file, r.svg ?? `<!-- render failed: ${r.error} -->`);
        if (theme === 'light')
          row[engine] = { ms: r.ms, bytes: bytes(r.svg), error: r.error ?? null };
      }
    }
    stats.push(row);
  }

  await commands.writeFile(`${OUT}/stats.json`, JSON.stringify(stats, null, 2) + '\n');
  await commands.writeFile(`${OUT}/index.html`, indexHtml(stats));
});

function indexHtml(stats) {
  const cell = (engine, name, theme, r) =>
    r.error
      ? `<td class="err">${engine} failed: ${r.error.replace(/</g, '&lt;')}</td>`
      : `<td class="${theme}"><img src="${engine}/${name}.${theme}.svg" alt="${engine} ${name}"></td>`;
  const rows = stats
    .map(
      (s) => `
  <tr><th colspan="2">${s.name}
    <small>mermaid ${s.mermaid.ms} ms · ${(s.mermaid.bytes / 1024).toFixed(1)} KB —
    pele ${s.pele.ms} ms · ${(s.pele.bytes / 1024).toFixed(1)} KB</small></th></tr>
  <tr>${cell('mermaid', s.name, 'light', s.mermaid)}${cell('pele', s.name, 'light', s.pele)}</tr>
  <tr>${cell('mermaid', s.name, 'dark', s.mermaid)}${cell('pele', s.name, 'dark', s.pele)}</tr>`,
    )
    .join('');
  return `<!doctype html>
<meta charset="utf-8">
<title>Mermaid vs Pele</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 16px; background: #fff; color: #172b4d; }
  table { border-collapse: collapse; width: 100%; table-layout: fixed; }
  th { text-align: left; padding: 16px 4px 4px; border-bottom: 1px solid #ccc; }
  th small { font-weight: normal; color: #626f86; margin-left: 8px; }
  td { padding: 8px; vertical-align: top; }
  td.dark { background: #1d2125; }
  td.err { color: #ae2e24; }
  img { max-width: 100%; max-height: 520px; }
  thead th { position: sticky; top: 0; background: #fff; }
</style>
<h1>Mermaid vs Pele — sanitized SVG for every fixture</h1>
<p>Left: Mermaid (shipping pipeline). Right: Pele. Rows alternate light / dark. Timings are single warm renders in headless Chromium.</p>
<table><thead><tr><th>Mermaid</th><th>Pele</th></tr></thead><tbody>${rows}</tbody></table>
`;
}
