import { describe, expect, it } from 'vitest';
import { extractMermaidSource } from '../src/lib/mermaid-file.js';

/**
 * This is the only place in the app that parses untrusted file BYTES: whatever a
 * `.mmd` / `.md` dropped onto the editor happens to contain. The extractor is a
 * single regex over the whole file, so the interesting cases are the malformed
 * ones — and the bar here is that every one of them has a *defined* answer, not
 * merely that none of them throws.
 *
 * Several tests below pin behaviour that is defensible rather than ideal (a
 * fence with an info string is missed; CRLF survives into the source). They are
 * assertions, not endorsements: each is commented, and changing one should be a
 * deliberate edit to this file rather than a silent drift in the regex.
 */
describe('extractMermaidSource', () => {
  it('extracts a fenced ```mermaid block from markdown', () => {
    const md = '# Title\n\nSome prose.\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\nMore prose.';
    expect(extractMermaidSource(md, 'doc.md')).toEqual({ source: 'flowchart TD\n  A --> B' });
  });

  it('is case-insensitive and tolerates trailing spaces on the fence', () => {
    const md = '```Mermaid  \nflowchart LR\n  A --> B\n```';
    expect(extractMermaidSource(md, 'x.markdown')).toEqual({ source: 'flowchart LR\n  A --> B' });
  });

  it('uses the whole file for a raw .mmd (no fence)', () => {
    const mmd = 'flowchart TD\n  A --> B\n';
    expect(extractMermaidSource(mmd, 'diagram.mmd')).toEqual({ source: 'flowchart TD\n  A --> B' });
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

describe('extractMermaidSource: line endings', () => {
  // A file authored on Windows arrives with CRLF throughout. The opening fence
  // is matched either way; the \r INSIDE the block survives into the source, and
  // only the trailing run is stripped. Pinned, not endorsed: Mermaid tolerates
  // CRLF, and CodeMirror splits on /\r\n?|\n/, so it never surfaces as a stray
  // glyph. Normalising here would be a separate, deliberate change.
  it('matches a CRLF fence and preserves interior CRLF', () => {
    const md = '```mermaid\r\nflowchart TD\r\n  A --> B\r\n```\r\n';
    expect(extractMermaidSource(md, 'windows.md')).toEqual({
      source: 'flowchart TD\r\n  A --> B',
    });
  });

  it('strips the trailing CRLF from a raw .mmd', () => {
    expect(extractMermaidSource('flowchart TD\r\n  A --> B\r\n', 'windows.mmd')).toEqual({
      source: 'flowchart TD\r\n  A --> B',
    });
  });
});

describe('extractMermaidSource: which block wins', () => {
  it('takes the first block when there are several', () => {
    const md = '```mermaid\ngraph TD\n  A-->B\n```\n```mermaid\nsequenceDiagram\n  X->>Y: hi\n```';
    expect(extractMermaidSource(md, 'x.md')).toEqual({ source: 'graph TD\n  A-->B' });
  });

  it('skips an earlier fenced block in another language', () => {
    const md = '```js\nconst a = 1;\n```\n\n```mermaid\nflowchart TD\n  A --> B\n```\n';
    expect(extractMermaidSource(md, 'x.md')).toEqual({ source: 'flowchart TD\n  A --> B' });
  });

  it('reaches into a mermaid block nested in a four-backtick wrapper', () => {
    // ````markdown ... ```` is how docs quote a fenced block verbatim. The regex
    // knows nothing about fence nesting, so it finds the inner ```mermaid and
    // stops at the first ``` after it. For a docs page that quotes an example,
    // that is the diagram the author would have pointed at anyway.
    const md = '````markdown\n```mermaid\nflowchart TD\n  A --> B\n```\n````\n';
    expect(extractMermaidSource(md, 'docs.md')).toEqual({ source: 'flowchart TD\n  A --> B' });
  });

  it('matches a ```mermaid marker that appears inside another block', () => {
    // The marker is quoted prose here, not a real block. Pinned as the price of
    // a regex that ignores nesting: the worst case is the author sees a diagram
    // they did not mean to import, in an editor where they can undo it.
    const md = '```text\nwrite it as ```mermaid\nflowchart TD\n```\n';
    expect(extractMermaidSource(md, 'x.md')).toEqual({ source: 'flowchart TD' });
  });
});

describe('extractMermaidSource: fence termination', () => {
  it('extracts a block whose closing fence ends the file with no newline', () => {
    expect(extractMermaidSource('```mermaid\nflowchart TD\n  A-->B\n```', 'x.md')).toEqual({
      source: 'flowchart TD\n  A-->B',
    });
  });

  it('returns an empty source for an empty block', () => {
    // Well-defined end to end: src/config/main.tsx checks result.source.trim()
    // and shows "That file has no Mermaid content." rather than blanking the
    // editor. See the drag-drop suite in test/config-app.test.jsx.
    expect(extractMermaidSource('```mermaid\n```\n', 'x.md')).toEqual({ source: '' });
    expect(extractMermaidSource('```mermaid\n   \n\n```\n', 'x.md')).toEqual({ source: '' });
  });

  it('reports an unterminated fence in markdown as no block at all', () => {
    // CommonMark would run the block to EOF; this regex requires the closer, so
    // the file is reported as having no mermaid block. The author gets a message
    // naming the thing to fix, which beats importing a half-written diagram.
    const md = '# Title\n\n```mermaid\nflowchart TD\n  A --> B\n';
    const result = extractMermaidSource(md, 'truncated.md');
    expect(result.error).toMatch(/mermaid/i);
    expect(result.source).toBeUndefined();
  });

  it('keeps the fence marker when an unterminated fence appears in a .mmd', () => {
    // No fence match, so the .mmd fallback returns the file as-is — marker line
    // included. That reaches the preview as invalid diagram source and surfaces
    // as an ordinary parse error on line 1, not a silent wrong render.
    expect(extractMermaidSource('```mermaid\nflowchart TD\n  A-->B\n', 'truncated.mmd')).toEqual({
      source: '```mermaid\nflowchart TD\n  A-->B',
    });
  });
});

describe('extractMermaidSource: near-miss fences', () => {
  // These pin the regex's exact shape. Each is a case someone might loosen the
  // pattern to catch; the assertions make that a conscious change with a
  // failing test attached, rather than an accident.

  it('does not match a fence carrying an info string', () => {
    // ```mermaid title="Flow" is a mermaid block by CommonMark's first-word rule,
    // but the regex demands end-of-line right after the word. Known limitation:
    // the markdown file is reported as having no block.
    const md = '```mermaid title="Flow"\nflowchart TD\n  A --> B\n```\n';
    expect(extractMermaidSource(md, 'titled.md').error).toMatch(/mermaid/i);
  });

  it('does not match a language that merely starts with mermaid', () => {
    expect(extractMermaidSource('```mermaidjs\nflowchart TD\n```\n', 'x.md').error).toMatch(
      /mermaid/i,
    );
  });

  it('does not match a tilde fence', () => {
    expect(extractMermaidSource('~~~mermaid\nflowchart TD\n~~~\n', 'x.md').error).toMatch(
      /mermaid/i,
    );
  });

  it('keeps the indentation of a fence nested in a list item', () => {
    // Mermaid tolerates uniformly indented source, so the block is usable as-is.
    const md = '- Diagram:\n\n  ```mermaid\n  flowchart TD\n    A --> B\n  ```\n';
    expect(extractMermaidSource(md, 'list.md')).toEqual({
      source: '  flowchart TD\n    A --> B',
    });
  });
});

describe('extractMermaidSource: no block at all', () => {
  it('reports an error for a markdown file with no mermaid block', () => {
    const md = '# Notes\n\nJust prose, no diagram here.';
    const result = extractMermaidSource(md, 'notes.md');
    expect(result.error).toMatch(/mermaid/i);
    expect(result.source).toBeUndefined();
  });

  it('matches the markdown extension case-insensitively', () => {
    expect(extractMermaidSource('# Notes', 'NOTES.MD').error).toMatch(/mermaid/i);
    expect(extractMermaidSource('# Notes', 'NOTES.Markdown').error).toMatch(/mermaid/i);
  });

  it('does not mistake a name that merely contains .md for the extension', () => {
    expect(extractMermaidSource('flowchart TD', 'notes.md.mmd')).toEqual({
      source: 'flowchart TD',
    });
  });
});

describe('extractMermaidSource: large and pathological input', () => {
  // The tests the trailing-whitespace fix exists for. The old
  // replace(/\s+$/, '') backtracked quadratically: 200KB of spaces followed by
  // one other character took ~68s, which is an unrecoverable freeze of the
  // editor iframe on a file the author only dropped. Budgets are generous — the
  // failure mode being guarded is seconds-to-minutes, not milliseconds.
  const budget = (ms, fn) => {
    const started = Date.now();
    const result = fn();
    expect(Date.now() - started).toBeLessThan(ms);
    return result;
  };

  it('strips a huge trailing whitespace run without hanging', { timeout: 20_000 }, () => {
    // The pathological shape: a long whitespace run that does NOT reach the end.
    //
    // 200KB deliberately, not more. The regex costs ~68s at this size and grows
    // quadratically, so a regression is unmissable against the 2s budget — but a
    // synchronous regex cannot be preempted by vitest's timeout, so whatever size
    // is chosen here is also how long a regressed CI job blocks before reporting.
    // A minute is a clear signal; half an hour is a hung pipeline.
    const text = 'flowchart TD\n' + ' '.repeat(200_000) + 'A-->B';
    const result = budget(2_000, () => extractMermaidSource(text, 'padded.mmd'));
    expect(result.source.startsWith('flowchart TD\n')).toBe(true);
    expect(result.source.endsWith('A-->B')).toBe(true);
  });

  it('strips a huge trailing whitespace run that does reach the end', { timeout: 20_000 }, () => {
    const text = 'flowchart TD\n  A-->B' + ' \n'.repeat(500_000);
    const result = budget(2_000, () => extractMermaidSource(text, 'padded.mmd'));
    expect(result).toEqual({ source: 'flowchart TD\n  A-->B' });
  });

  it('finds a block at the end of a multi-megabyte file', { timeout: 20_000 }, () => {
    const text = 'prose line\n'.repeat(400_000) + '```mermaid\nflowchart TD\n  A --> B\n```\n';
    const result = budget(2_000, () => extractMermaidSource(text, 'big.md'));
    expect(result).toEqual({ source: 'flowchart TD\n  A --> B' });
  });

  it('terminates on many opening fences with no closer', { timeout: 20_000 }, () => {
    // Each repeat's opening backticks close the previous block, so the first
    // match is the first line of the second repeat: short, and found in one pass.
    const text = '```mermaid\nflowchart TD\n'.repeat(100_000);
    const result = budget(2_000, () => extractMermaidSource(text, 'evil.md'));
    expect(result).toEqual({ source: 'flowchart TD' });
  });
});

describe('extractMermaidSource: trailing whitespace class', () => {
  // Pins the trimEnd() swap: it must strip exactly what /\s+$/ stripped —
  // Unicode spaces and line separators included — and nothing more.
  it('strips exotic trailing whitespace but leaves interior whitespace alone', () => {
    const source = 'flowchart TD\n  A --> B';
    // Space, tab, CR, LF, then NBSP, LINE SEPARATOR, PARAGRAPH SEPARATOR,
    // ideographic space and the BOM. Built from code points rather than pasted:
    // invisible characters do not survive an editor round trip, and this test is
    // worthless the moment one of them is silently normalised away.
    const exotic = [0x00a0, 0x2028, 0x2029, 0x3000, 0xfeff].map((c) => String.fromCodePoint(c));
    const trailing = ' \t\r\n' + exotic.join('');
    expect(extractMermaidSource(source + trailing, 'x.mmd')).toEqual({ source });
    expect(extractMermaidSource('```mermaid\n' + source + trailing + '```', 'x.md')).toEqual({
      source,
    });
  });
});
