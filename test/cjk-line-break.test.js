import { afterEach, describe, expect, it } from 'vitest';
import { breakCjkText, hasEastAsian, textWidthEm } from '../src/lib/cjk-line-break.js';

/**
 * The unit that has to be right for issue #157: Mermaid's own wrapper walks code
 * points and hyphenates, which is wrong for Japanese in three separate ways.
 * These tests pin the three: grapheme clusters stay whole, identifiers and
 * figures stay whole, and the break lands where JIS X 4051 allows it.
 */

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const graphemes = (s) => [...segmenter.segment(s)].map((g) => g.segment);

describe('hasEastAsian', () => {
  it('is true for kana, kanji, hangul and fullwidth punctuation', () => {
    for (const s of ['あ', '品質', '한글', '（v1）']) expect(hasEastAsian(s), s).toBe(true);
  });
  it('is false for the Latin text every existing fixture is written in', () => {
    for (const s of ['Alice->>John: Hello', 'Make tea: 5: Me', '85.5% of 1,500', ''])
      expect(hasEastAsian(s), s).toBe(false);
  });
});

describe('textWidthEm', () => {
  it('charges a full em for a wide character and half for a narrow one', () => {
    expect(textWidthEm('品質')).toBe(2);
    expect(textWidthEm('CI')).toBe(1);
  });
  it('charges more than an ideograph for an emoji, whatever its cluster length', () => {
    expect(textWidthEm('🇯🇵')).toBe(1.2);
    expect(textWidthEm('👨‍👩‍👧‍👦')).toBe(1.2);
  });
});

describe('breakCjkText', () => {
  it('fills greedily up to the budget', () => {
    // Ten ideographs, budget four em.
    expect(breakCjkText('一二三四五六七八九十', { budgetEm: 4 })).toEqual([
      '一二三四',
      '五六七八',
      '九十',
    ]);
  });

  it('returns a single line when the text already fits', () => {
    expect(breakCjkText('品質', { budgetEm: 10 })).toEqual(['品質']);
  });

  it('returns empty input unchanged rather than an empty row', () => {
    expect(breakCjkText('', { budgetEm: 10 })).toEqual(['']);
  });

  it('never splits a grapheme cluster', () => {
    const payload = 'リリース通知🇯🇵を担当者👨‍👩‍👧‍👦へ送信し、承認👍🏽を得て𠮟責と葛󠄀城を更新する。';
    for (const budget of [2, 3, 5, 8, 11.4]) {
      const lines = breakCjkText(payload, { budgetEm: budget });
      expect(lines.join(''), `budget ${budget} is lossless`).toBe(payload);
      // Re-segmenting each line must give back a prefix of the whole segmentation:
      // any cluster cut in half would appear as two different clusters here.
      expect(lines.flatMap(graphemes), `budget ${budget} keeps clusters`).toEqual(
        graphemes(payload),
      );
    }
  });

  it('never splits a Latin identifier, a decimal, a thousands group or a version', () => {
    const label =
      'SonarQubeでカバレッジ85.5%以上、負債1,500分未満、v11.13.0以降、build-2026-08-09-1142';
    const lines = breakCjkText(label, { budgetEm: 6 });
    expect(lines.join('')).toBe(label);
    for (const token of ['SonarQube', '85.5%', '1,500', 'v11.13.0', 'build-2026-08-09-1142']) {
      expect(
        lines.some((line) => line.includes(token)),
        `${token} survives on one line`,
      ).toBe(true);
    }
  });

  it('keeps a full stop off the start of a line (行頭禁則)', () => {
    // Greedy alone would break as 一二三 / 。四, opening a line with the stop.
    const lines = breakCjkText('一二三。四五六', { budgetEm: 3 });
    for (const line of lines) expect(line.startsWith('。')).toBe(false);
    expect(lines.join('')).toBe('一二三。四五六');
  });

  it('keeps an opening bracket off the end of a line (行末禁則)', () => {
    const lines = breakCjkText('一二三（四五六）', { budgetEm: 3 });
    for (const line of lines) expect(line.endsWith('（')).toBe(false);
    expect(lines.join('')).toBe('一二三（四五六）');
  });

  it('accepts an unfixable boundary rather than emptying a line or bouncing', () => {
    // A run of forbidden characters has no legal break; the guard has to give up
    // and take the greedy boundary, not loop.
    const lines = breakCjkText('。。。。。。', { budgetEm: 2 });
    expect(lines.join('')).toBe('。。。。。。');
    for (const line of lines) expect(line.length).toBeGreaterThan(0);
  });

  it('caps the row count, letting the last row run over instead of adding a fourth', () => {
    const label = '一二三四五六七八九十百千万億兆';
    const capped = breakCjkText(label, { budgetEm: 3, maxLines: 3 });
    expect(capped).toHaveLength(3);
    expect(capped.join('')).toBe(label);
    expect(capped[2].length).toBeGreaterThan(3);
  });

  it('does not open a line with the space the break already accounted for', () => {
    const lines = breakCjkText('品質 ゲート 監査', { budgetEm: 3 });
    for (const line of lines) expect(line).toBe(line.trim());
  });

  describe('without Intl.Segmenter', () => {
    const original = Intl.Segmenter;
    afterEach(() => {
      Intl.Segmenter = original;
    });

    it('degrades to a no-op rather than throwing', () => {
      Intl.Segmenter = undefined;
      expect(breakCjkText('一二三四五六', { budgetEm: 2 })).toEqual(['一二三四五六']);
      expect(textWidthEm('一二三')).toBe(0);
    });
  });
});
