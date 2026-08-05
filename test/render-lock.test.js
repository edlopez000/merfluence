import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The mermaid singleton discipline in render.js: every initialize→parse→render
 * critical section runs under one lock, and initialize() is skipped when the
 * major was last initialized with the same effective config.
 *
 * Why it matters: each Mermaid major is one stateful module — initialize()
 * writes site config that the following parse/render read back. Interleaved
 * callers (the editor's debounced preview against save()) could render under
 * the other caller's theme, the bug class behind the CACHE_VERSION v1→v2 bump.
 * The real-render proof lives in test/browser/render.integration.test.js; here
 * the registry is mocked so the ordering itself can be asserted in jsdom.
 */

const fake = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn(async () => {}),
  render: vi.fn(async () => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' })),
}));

vi.mock('../src/lib/mermaid-registry.js', () => ({
  loadMermaid: vi.fn(async () => fake),
  resolveMajor: vi.fn((pref) => (pref === '10' ? '10' : '11')),
}));

let renderDiagram;
let validate;

beforeEach(async () => {
  fake.initialize.mockReset();
  fake.parse.mockReset().mockImplementation(async () => {});
  fake.render
    .mockReset()
    .mockImplementation(async () => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }));
  // The lock and the initialize memo are module state; re-import so every test
  // starts from a cold module rather than inheriting the last test's memo key.
  vi.resetModules();
  ({ renderDiagram, validate } = await import('../src/lib/render.js'));
});

const SOURCE = 'flowchart TD\n  A --> B';

describe('initialize memoization', () => {
  it('initializes once across repeated same-config renders', async () => {
    await renderDiagram({ source: SOURCE, theme: 'light' });
    await renderDiagram({ source: SOURCE, theme: 'light' });
    await renderDiagram({ source: SOURCE, theme: 'light' });
    expect(fake.initialize).toHaveBeenCalledTimes(1);
  });

  it('re-initializes when the theme changes, then memoizes again', async () => {
    await renderDiagram({ source: SOURCE, theme: 'light' });
    await renderDiagram({ source: SOURCE, theme: 'dark' });
    await renderDiagram({ source: SOURCE, theme: 'dark' });
    expect(fake.initialize).toHaveBeenCalledTimes(2);
  });

  it('re-initializes when useMaxWidth changes', async () => {
    await renderDiagram({ source: SOURCE, theme: 'light', useMaxWidth: true });
    await renderDiagram({ source: SOURCE, theme: 'light', useMaxWidth: false });
    expect(fake.initialize).toHaveBeenCalledTimes(2);
  });

  it("treats validate's default theme and a light render as the same config", async () => {
    // baseConfig maps anything but 'dark' to the 'default' theme, so a light
    // render after a validate must not thrash the memo.
    await validate(SOURCE);
    await renderDiagram({ source: SOURCE, theme: 'light', useMaxWidth: true });
    expect(fake.initialize).toHaveBeenCalledTimes(1);
  });
});

describe('screening parse per major', () => {
  it('pre-parses on major 10, where suppressErrorRendering is not honored', async () => {
    await renderDiagram({ source: SOURCE, versionPref: '10' });
    expect(fake.parse).toHaveBeenCalledTimes(1);
    expect(fake.render).toHaveBeenCalledTimes(1);
  });

  it('skips the redundant pre-parse on major 11 (render parses internally)', async () => {
    await renderDiagram({ source: SOURCE });
    expect(fake.parse).not.toHaveBeenCalled();
    expect(fake.render).toHaveBeenCalledTimes(1);
  });
});

describe('the render lock', () => {
  it('holds a second render out of the critical section until the first finishes', async () => {
    // First caller parks inside render(); the second must not even initialize
    // until the first has resolved.
    let releaseRender;
    fake.render.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRender = () => resolve({ svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' });
        }),
    );

    const first = renderDiagram({ source: SOURCE, theme: 'dark' });
    await vi.waitFor(() => expect(fake.render).toHaveBeenCalledTimes(1));

    const second = renderDiagram({ source: SOURCE, theme: 'light' });
    // Give the second caller every chance to run if the lock were broken.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.initialize).toHaveBeenCalledTimes(1);
    expect(fake.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'dark' }));
    expect(fake.render).toHaveBeenCalledTimes(1);

    releaseRender();
    await first;
    await second;

    // Now the second ran, with its own config, in order.
    expect(fake.initialize).toHaveBeenCalledTimes(2);
    expect(fake.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'default' }));
    expect(fake.render).toHaveBeenCalledTimes(2);
  });

  it('keeps serving after a render inside the lock rejects', async () => {
    fake.render.mockImplementationOnce(async () => {
      throw new Error('bad syntax');
    });
    await expect(renderDiagram({ source: SOURCE })).rejects.toThrow('bad syntax');

    // The failure must not wedge the chain: the next render still goes through.
    const { svg } = await renderDiagram({ source: SOURCE });
    expect(svg).toContain('<svg');
  });
});
