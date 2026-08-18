import { describe, expect, it, vi } from 'vitest';

/**
 * The safety net behind the CJK wrap pass (issue #157).
 *
 * renderDiagram rewrites the source before handing it to Mermaid. That rewrite
 * must never be able to turn a diagram that renders into an error banner — the
 * author cannot see the transformed string, so a failure there would be
 * unattributable. If the rewritten source throws, the original is rendered
 * instead and any genuine syntax error surfaces from that.
 *
 * Proving it needs a rewrite that fails, which the real pass is designed never
 * to produce, so the pass is stubbed. It lives in its own file because vi.mock
 * is file-scoped and render.integration.test.js needs the real one.
 */
vi.mock('../../src/lib/cjk-wrap.js', () => ({
  wrapCjkLabels: (source) => (source.includes('%% break-me') ? 'this is not a diagram' : source),
}));

const { renderDiagram } = await import('../../src/lib/render.js');

const RENDER_TIMEOUT = 20_000;
const GOOD = 'sequenceDiagram\n    %% break-me\n    Alice->>John: Hello\n';

describe('renderDiagram falls back when the wrap pass produces something unrenderable', () => {
  it(
    'renders the author’s own source instead of failing',
    async () => {
      const { svg } = await renderDiagram({ source: GOOD });
      expect(svg).toContain('<svg');
      // The fallback rendered the real diagram, not the stub's replacement.
      expect(svg).toContain('Hello');
    },
    RENDER_TIMEOUT,
  );

  it(
    'still reports a real syntax error, rather than hiding it behind the fallback',
    async () => {
      await expect(
        renderDiagram({
          source: 'sequenceDiagram\n    %% break-me\n    loop forever\n    Alice->>John: Hi\n',
        }),
      ).rejects.toThrow();
    },
    RENDER_TIMEOUT,
  );
});
