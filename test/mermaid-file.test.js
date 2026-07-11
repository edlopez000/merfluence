import { describe, expect, it } from 'vitest';
import { extractMermaidSource } from '../src/lib/mermaid-file.js';

describe('extractMermaidSource', () => {
  it('extracts a fenced ```mermaid block from markdown', () => {
    const md = '# Title\n\nSome prose.\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\nMore prose.';
    expect(extractMermaidSource(md, 'doc.md')).toEqual({ source: 'flowchart TD\n  A --> B' });
  });

  it('takes the first block when there are several', () => {
    const md = '```mermaid\ngraph TD\n  A-->B\n```\n```mermaid\nsequenceDiagram\n  X->>Y: hi\n```';
    expect(extractMermaidSource(md, 'x.md')).toEqual({ source: 'graph TD\n  A-->B' });
  });

  it('is case-insensitive and tolerates trailing spaces on the fence', () => {
    const md = '```Mermaid  \nflowchart LR\n  A --> B\n```';
    expect(extractMermaidSource(md, 'x.markdown')).toEqual({ source: 'flowchart LR\n  A --> B' });
  });

  it('uses the whole file for a raw .mmd (no fence)', () => {
    const mmd = 'flowchart TD\n  A --> B\n';
    expect(extractMermaidSource(mmd, 'diagram.mmd')).toEqual({ source: 'flowchart TD\n  A --> B' });
  });

  it('reports an error for a markdown file with no mermaid block', () => {
    const md = '# Notes\n\nJust prose, no diagram here.';
    const result = extractMermaidSource(md, 'notes.md');
    expect(result.error).toMatch(/mermaid/i);
    expect(result.source).toBeUndefined();
  });

  it('falls back to raw content for an unknown extension', () => {
    expect(extractMermaidSource('flowchart TD\n A-->B', 'paste.txt')).toEqual({
      source: 'flowchart TD\n A-->B',
    });
  });

  it('handles empty / nullish input', () => {
    expect(extractMermaidSource('', 'x.mmd')).toEqual({ source: '' });
    expect(extractMermaidSource(null, 'x.mmd')).toEqual({ source: '' });
  });
});
