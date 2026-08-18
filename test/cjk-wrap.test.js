import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { wrapCjkLabels } from '../src/lib/cjk-wrap.js';

/**
 * The source pass for issue #157. Two properties matter more than any single
 * rewrite: it must never touch a diagram it has no business touching (the
 * regression surface is every diagram anyone has ever saved), and it must never
 * change how many lines the source has, because describeError maps Mermaid's
 * error line numbers onto what the author typed.
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => readFileSync(join(fixturesDir, `${name}.mmd`), 'utf8');

const lineCount = (s) => s.split('\n').length;

describe('diagrams the pass must leave alone', () => {
  // The pre-existing corpus is Latin throughout; -cjk fixtures were added for
  // this feature and are the only ones expected to change.
  const untouched = readdirSync(fixturesDir)
    .filter((f) => f.endsWith('.mmd') && !f.includes('-cjk'))
    .sort();

  it('found the corpus', () => {
    expect(untouched.length).toBeGreaterThan(15);
  });

  it.each(untouched)('returns %s byte-identical', (file) => {
    const source = readFileSync(join(fixturesDir, file), 'utf8');
    expect(wrapCjkLabels(source)).toBe(source);
  });

  it('leaves a diagram type it does not handle alone, CJK and all', () => {
    const flow = 'flowchart TD\n  A[品質ゲートで、カバレッジ85.5%以上を満たすこと] --> B[承認]\n';
    expect(wrapCjkLabels(flow)).toBe(flow);
  });

  it('leaves empty and whitespace-only source alone', () => {
    expect(wrapCjkLabels('')).toBe('');
    expect(wrapCjkLabels('   \n  ')).toBe('   \n  ');
  });
});

describe('sequenceDiagram', () => {
  const over = (text) =>
    `sequenceDiagram\n    participant A as 品質\n    participant B as CI\n    Note over A,B: ${text}\n`;
  const noteOf = (source) => /Note over A,B: (.*)$/m.exec(source)[1];

  it('breaks a long over-note that spans two distinct actors', () => {
    const out = wrapCjkLabels(
      over('SonarQubeの品質ゲートで、カバレッジ85.5%以上、重大な指摘0件を満たすこと。'),
    );
    expect(noteOf(out)).toContain('<br>');
    expect(noteOf(out).split('<br>').join('')).toBe(
      'SonarQubeの品質ゲートで、カバレッジ85.5%以上、重大な指摘0件を満たすこと。',
    );
  });

  it('leaves the actor list and the colon exactly as written', () => {
    const out = wrapCjkLabels(over('一二三四五六七八九十一二三四五六七八九十'));
    expect(out).toContain('    Note over A,B: 一');
  });

  it.each([
    ['Note over A', 'Note over A: '],
    ['Note right of A', 'Note right of A: '],
    ['Note left of A', 'Note left of A: '],
  ])('leaves %s alone — Mermaid already sizes that box from its text', (_label, prefix) => {
    const source = `sequenceDiagram\n    participant A as 品質\n    ${prefix}一二三四五六七八九十一二三四五六七八九十\n`;
    expect(wrapCjkLabels(source)).toBe(source);
  });

  it('breaks a loop title, which the renderer force-wraps and hyphenates', () => {
    const source =
      'sequenceDiagram\n    A->>B: x\n    loop 失敗した検査を、成功するまで最大3回まで繰り返し実行する。\n        A->>B: y\n    end\n';
    const out = wrapCjkLabels(source);
    expect(/^ {4}loop /m.test(out)).toBe(true);
    expect(out).toContain('<br>');
  });

  it('leaves arrow labels alone — actor margins already grow to fit them', () => {
    const source =
      'sequenceDiagram\n    A->>B: 静的解析ジョブを一二三四五六七八九十一二三四五六七八九十再実行\n';
    expect(wrapCjkLabels(source)).toBe(source);
  });
});

describe('journey', () => {
  it('breaks the task label and leaves the score and actors untouched', () => {
    const source =
      'journey\n    title 私の一日\n    section 出社\n      お茶を淹れてから机の資料を片付ける: 5: 私, 猫\n';
    const out = wrapCjkLabels(source);
    expect(out).toMatch(/: 5: 私, 猫$/m);
    expect(out).toContain('<br>');
  });

  it('handles a task with a score but no actors', () => {
    const source = 'journey\n    section 出社\n      お茶を淹れてから机の資料を片付ける: 5\n';
    const out = wrapCjkLabels(source);
    expect(out).toContain('<br>');
    expect(out).toMatch(/: 5$/m);
  });

  it('caps a very long label at three rows so nothing is drawn below the tile', () => {
    const label = '一'.repeat(60);
    const out = wrapCjkLabels(`journey\n    section s\n      ${label}: 5: 私\n`);
    const written = /^ {6}(.*): 5: 私$/m.exec(out)[1];
    expect(written.split('<br>')).toHaveLength(3);
    expect(written.split('<br>').join('')).toBe(label);
  });

  it('leaves title and section headings alone', () => {
    const source =
      'journey\n    title 一二三四五六七八九十一二三四五六七八九十\n    section 一二三四五六七八九十一二三四五六七八九十\n';
    expect(wrapCjkLabels(source)).toBe(source);
  });
});

describe('timeline', () => {
  it('breaks the period and every event on the statement', () => {
    const source =
      'timeline\n    2002年度 : 設計と要件定義をひととおり完了した : 監査対応を開始する運用へ完全に移行した\n';
    const out = wrapCjkLabels(source);
    const [, period, first, second] = /^ {4}(.*?) : (.*?) : (.*)$/m.exec(out);
    expect(period).toBe('2002年度');
    expect(first).toContain('<br>');
    expect(second).toContain('<br>');
    expect(first.split('<br>').join('')).toBe('設計と要件定義をひととおり完了した');
  });

  it('leaves the title alone even though it is long and East Asian', () => {
    const source =
      'timeline\n    title 社内プラットフォームの歴史をふりかえる長い題名\n    2002 : ev\n';
    expect(wrapCjkLabels(source)).toBe(source);
  });
});

describe('skip rules', () => {
  const long = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十';
  const seq = (text) =>
    `sequenceDiagram\n    participant A as 品質\n    participant B as CI\n    Note over A,B: ${text}\n`;

  it('leaves a label the author already broke', () => {
    const source = seq(`${long}<br/>${long}`);
    expect(wrapCjkLabels(source)).toBe(source);
  });

  it.each(['wrap:', 'nowrap:', ':wrap:', ':nowrap:'])(
    'leaves a label prefixed with %s — the author chose a wrap mode',
    (prefix) => {
      const source = seq(`${prefix}${long}`);
      expect(wrapCjkLabels(source)).toBe(source);
    },
  );

  it('leaves a label that already fits its budget', () => {
    const source = seq('品質ゲート');
    expect(wrapCjkLabels(source)).toBe(source);
  });
});

describe('invariants that hold for every rewrite', () => {
  const rewritten = ['sequence-cjk', 'journey-cjk', 'timeline-cjk'].map((name) => [
    name,
    fixture(name),
  ]);

  it.each(rewritten)('%s actually changes (the fixtures exercise the pass)', (_name, source) => {
    expect(wrapCjkLabels(source)).not.toBe(source);
  });

  it.each(rewritten)(
    '%s keeps its line count, so error line numbers still map',
    (_name, source) => {
      expect(lineCount(wrapCjkLabels(source))).toBe(lineCount(source));
    },
  );

  it.each(rewritten)('%s loses no text but the injected breaks', (_name, source) => {
    expect(wrapCjkLabels(source).split('<br>').join('')).toBe(source);
  });

  it.each(rewritten)('%s never emits a leading or trailing break on a label', (_name, source) => {
    // A trailing <br> leaves timeline's wrapper holding a tspan of literal markup;
    // a leading one draws an empty row.
    for (const line of wrapCjkLabels(source).split('\n')) {
      expect(line, line).not.toMatch(/<br>\s*$/);
      expect(line, line).not.toMatch(/:\s*<br>/);
    }
  });

  it('preserves CRLF line endings', () => {
    const crlf = fixture('journey-cjk').replace(/\n/g, '\r\n');
    const out = wrapCjkLabels(crlf);
    expect(out).toContain('<br>');
    expect(out.split('\n').every((l, i, a) => i === a.length - 1 || l.endsWith('\r'))).toBe(true);
  });

  it('leaves YAML frontmatter untouched and still finds the diagram type after it', () => {
    const source = `---\nconfig:\n  journey:\n    width: 150\n---\njourney\n    section 出社\n      お茶を淹れてから机の資料を片付ける: 5: 私\n`;
    const out = wrapCjkLabels(source);
    expect(out.startsWith('---\nconfig:\n  journey:\n    width: 150\n---\n')).toBe(true);
    expect(out).toContain('<br>');
  });
});

describe('sources with no statement to dispatch on', () => {
  it('returns a comment-only source unchanged', () => {
    const source = '%% 品質ゲートについての覚え書き\n%%{init: {"theme":"dark"}}%%\n\n';
    expect(wrapCjkLabels(source)).toBe(source);
  });
});
