import { describe, expect, it } from 'vitest';
import { MAX_SOURCE_CHARS, renderDiagram, validate } from '../src/lib/render.js';

/**
 * The pathological-input canary.
 *
 * There is no scope-free way to bound how much text a page editor pastes into a
 * diagram, so the app must fail *gracefully* on a megabyte of source rather than
 * hang or crash the render. enforceSourceLimit() rejects before Mermaid is even
 * loaded — so this suite lives in the jsdom project (no getBBox needed) and, by
 * asserting the reject rather than a timeout, proves the "graceful handling"
 * acceptance criterion of issue #67.
 *
 * The MAX_SOURCE_CHARS assertion pins the number: it doubles as Mermaid's
 * explicit maxTextSize in baseConfig, and a silent drift there would either
 * reopen the hang (raised) or start rejecting real diagrams (lowered).
 */
describe('source-length cap', () => {
  it('pins the cap at Mermaid’s default (50K)', () => {
    expect(MAX_SOURCE_CHARS).toBe(50000);
  });

  it('renderDiagram rejects oversized source with a clear message', async () => {
    const source = 'a'.repeat(MAX_SOURCE_CHARS + 1);
    await expect(renderDiagram({ source })).rejects.toThrow(/too large|limit/i);
  });

  it('validate rejects oversized source with a clear message', async () => {
    const source = 'a'.repeat(MAX_SOURCE_CHARS + 1);
    await expect(validate(source)).rejects.toThrow(/too large|limit/i);
  });

  it('reports the offending length and the limit in the message', async () => {
    const source = 'a'.repeat(MAX_SOURCE_CHARS + 25);
    await expect(renderDiagram({ source })).rejects.toThrow(
      `${MAX_SOURCE_CHARS + 25} characters; limit is ${MAX_SOURCE_CHARS}`,
    );
  });

  it('does not reject source exactly at the limit for being too large', async () => {
    // A limit-length but syntactically bogus source must fail on *parse*, not on
    // the cap — proving the boundary is `> limit`, not `>= limit`. (It never
    // renders; we only assert the error isn't the size error.)
    const source = 'a'.repeat(MAX_SOURCE_CHARS);
    await expect(renderDiagram({ source })).rejects.not.toThrow(/too large/i);
  });
});
