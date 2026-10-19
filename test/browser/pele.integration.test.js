import { describe, expect, it } from 'vitest';
import { renderDiagram } from '../../src/lib/render.js';

/**
 * The per-diagram Pele opt-in, rendered in a real Chromium. jsdom has no
 * canvas, so test/pele-engine.test.js only reaches Pele's built-in font
 * metrics; here Pele measures with a real canvas, the path readers get.
 */
const rawFixtures = import.meta.glob('../fixtures/*.mmd', {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('pele renders the fixture corpus in a real browser', () => {
  for (const [path, source] of Object.entries(rawFixtures)) {
    it(path.split('/').pop(), async () => {
      const { svg } = await renderDiagram({ source, versionPref: 'pele' });
      const host = document.createElement('div');
      host.innerHTML = svg;
      document.body.append(host);
      try {
        const el = host.querySelector('svg');
        expect(el?.classList.contains('pele')).toBe(true);
        // Laid out at a real, non-zero size from its viewBox.
        const box = el.getBoundingClientRect();
        expect(box.width).toBeGreaterThan(0);
        expect(box.height).toBeGreaterThan(0);
        // ensureAccessibleName ran: the graphic has a name.
        expect(el.getAttribute('aria-label') || el.querySelector('title')).toBeTruthy();
      } finally {
        host.remove();
      }
    });
  }
});
