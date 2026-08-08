import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { highlightTree, tags as t } from '@lezer/highlight';

import { mermaid, mermaidHighlightStyle } from '../src/config/mermaid-lang.js';

/**
 * What this suite is for.
 *
 * The editor's highlighting is a stream tokenizer plus a colour table, and
 * nothing else in the build checks either. A regex that stops matching, a token
 * type that loses its colour, or a diagram type Mermaid gained but the
 * tokenizer never learned are all silent: the editor keeps working, the text
 * just goes flat. None of it would fail a render test, because highlighting
 * never touches the render path.
 *
 * Why it drives EditorState rather than calling token() directly. The thing
 * users see is the end of a chain — token() returns a legacy CodeMirror 5 name,
 * StreamLanguage maps that to a @lezer/highlight tag, and mermaidHighlightStyle
 * maps the tag to a class. Poking token() would test the first link and let the
 * other two break unnoticed, which is exactly how a colour goes missing.
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixtures = readdirSync(fixturesDir).filter((f) => f.endsWith('.mmd'));

/**
 * Highlight `src` and return one entry per styled range. Ranges the highlighter
 * gives no class to — whitespace, punctuation, anything token() returned null
 * for — are absent rather than present-and-empty; that is highlightTree's
 * contract, and `styled.length` below leans on it.
 */
function highlight(src) {
  const state = EditorState.create({ doc: src, extensions: [mermaid] });
  // Force a full parse. syntaxTree() alone returns only as much as the parser
  // happened to have finished, which for a multi-line fixture is not the lot.
  const tree = ensureSyntaxTree(state, src.length, 5000);
  expect(tree, 'parser produced no tree').not.toBeNull();

  const styled = [];
  highlightTree(tree, mermaidHighlightStyle, (from, to, classes) => {
    styled.push({ text: src.slice(from, to), classes });
  });
  return styled;
}

/** The class mermaidHighlightStyle gives `tag`, e.g. for comparing two ranges. */
const classFor = (tag) => mermaidHighlightStyle.style([tag]);

/** The styled range starting at `text`, or undefined. */
const find = (styled, text) => styled.find((s) => s.text === text);

describe('mermaid language: fixture sweep', () => {
  // Ties highlighting into the project's "new diagram type -> new fixture"
  // rule. Adding a fixture for a type the tokenizer's DIAGRAM_TYPES regex does
  // not list now fails here, which is the only place that would notice.
  it.each(fixtures)('%s is highlighted, starting with its diagram header', (name) => {
    const src = readFileSync(join(fixturesDir, name), 'utf8');
    const styled = highlight(src);

    expect(styled.length).toBeGreaterThan(0);

    // Every fixture opens with its diagram header on line 1, and the tokenizer
    // only accepts a header at the start of a line — so the first styled range
    // in the file is that header, and it has to read as a keyword.
    const first = styled[0];
    expect(first.text).toBe(src.split(/[\s\n]/)[0]);
    expect(first.classes).toBe(classFor(t.keyword));
  });
});

describe('mermaid language: token classification', () => {
  it('styles a %% comment as a comment', () => {
    const styled = highlight('flowchart TD\n%% just a note\nA --> B');
    expect(find(styled, '%% just a note')?.classes).toBe(classFor(t.comment));
  });

  it('styles a %%{...}%% directive as meta, not as a comment', () => {
    // DIRECTIVE is matched before COMMENT in token(). If that order is ever
    // flipped, COMMENT's /^%%.*/ swallows the whole directive line and this is
    // what catches it — the text would still be styled, just as the wrong thing.
    const styled = highlight("%%{init: {'theme':'dark'}}%%\nflowchart TD\nA --> B");
    const directive = find(styled, "%%{init: {'theme':'dark'}}%%");
    expect(directive?.classes).toBe(classFor(t.meta));
    expect(directive?.classes).not.toBe(classFor(t.comment));
  });

  it('styles arrows as operators and bare node ids as variable names', () => {
    const styled = highlight('flowchart TD\nA --> B');
    expect(find(styled, '-->')?.classes).toBe(classFor(t.operator));
    expect(find(styled, 'A')?.classes).toBe(classFor(t.variableName));
    expect(find(styled, 'B')?.classes).toBe(classFor(t.variableName));
  });

  it('styles a bracketed node label as a string', () => {
    const styled = highlight('flowchart TD\nA["a quoted label"]');
    // NODE_LABEL matches the brackets and everything between them in one go, so
    // the label arrives as a single range rather than as quote-delimited parts.
    expect(find(styled, '["a quoted label"]')?.classes).toBe(classFor(t.string));
  });

  it('styles numbers as numbers', () => {
    const styled = highlight('pie title Pets\n  "Dogs" : 386');
    expect(find(styled, '386')?.classes).toBe(classFor(t.number));
  });

  it('styles a keyword that appears mid-line, not only at the start of one', () => {
    // DIAGRAM_TYPES is sol()-gated but KEYWORDS is not, and conflating the two
    // would quietly stop highlighting every keyword that follows indentation.
    const styled = highlight('flowchart TD\n  subgraph one\n  end');
    expect(find(styled, 'subgraph')?.classes).toBe(classFor(t.keyword));
    expect(find(styled, 'end')?.classes).toBe(classFor(t.keyword));
  });

  it('does not treat a diagram type as a keyword mid-line', () => {
    // `graph` as a node id is ordinary text. This is the sol() gate's whole job.
    const styled = highlight('flowchart TD\n  A --> graph');
    expect(find(styled, 'graph')?.classes).toBe(classFor(t.variableName));
  });
});

describe('mermaid language: keywords are scoped to their dialect', () => {
  // The reason the tokenizer is stateful at all. Mermaid's dialects are
  // separate languages whose reserved words are ordinary English, so a single
  // flat keyword list cannot be widened without firing in the wrong diagram.
  // Flatten KEYWORDS_BY_DIAGRAM into one union and this block is what fails.
  it('treats `contains` as a keyword in requirementDiagram and a label in erDiagram', () => {
    const asRequirement = highlight('requirementDiagram\n  test_entity - contains -> other');
    expect(find(asRequirement, 'contains')?.classes).toBe(classFor(t.keyword));

    // The exact line from test/fixtures/er.mmd, where `contains` names a
    // relationship and must stay ordinary text.
    const asEr = highlight('erDiagram\n    ORDER ||--|{ LINE-ITEM : contains');
    expect(find(asEr, 'contains')?.classes).toBe(classFor(t.variableName));
  });

  it('treats gitGraph verbs as keywords only inside a gitGraph', () => {
    const asGit = highlight('gitGraph\n  commit\n  branch develop\n  checkout develop');
    for (const word of ['commit', 'branch', 'checkout']) {
      expect(find(asGit, word)?.classes).toBe(classFor(t.keyword));
    }
    // The same words are perfectly good flowchart node ids.
    const asFlow = highlight('flowchart TD\n  commit --> branch');
    expect(find(asFlow, 'commit')?.classes).toBe(classFor(t.variableName));
    expect(find(asFlow, 'branch')?.classes).toBe(classFor(t.variableName));
  });

  it('scopes er, block and xychart words that collide with English', () => {
    expect(find(highlight('erDiagram\n  A ||--|| B : to'), 'to')?.classes).toBe(
      classFor(t.keyword),
    );
    expect(find(highlight('flowchart TD\n  A --> to'), 'to')?.classes).toBe(
      classFor(t.variableName),
    );
    expect(find(highlight('block-beta\n  columns 3'), 'columns')?.classes).toBe(
      classFor(t.keyword),
    );
    expect(find(highlight('flowchart TD\n  A --> columns'), 'columns')?.classes).toBe(
      classFor(t.variableName),
    );
    // `line` is an xychart plot type and a word people put in flowcharts.
    expect(find(highlight('xychart-beta\n  line [1, 2]'), 'line')?.classes).toBe(
      classFor(t.keyword),
    );
    expect(find(highlight('flowchart TD\n  A --> line'), 'line')?.classes).toBe(
      classFor(t.variableName),
    );
  });

  it('highlights C4 macros, including the _Ext and Db/Queue variants', () => {
    const styled = highlight(
      'C4Context\n  Person(a, "A")\n  System_Ext(b, "B")\n  ContainerDb(c, "C")\n  Rel_Back(a, b)',
    );
    for (const macro of ['Person', 'System_Ext', 'ContainerDb', 'Rel_Back']) {
      expect(find(styled, macro)?.classes).toBe(classFor(t.keyword));
    }
  });

  it('applies COMMON keywords in every dialect', () => {
    // accTitle/accDescr are universal across Mermaid grammars and were
    // unhighlighted before this change.
    for (const src of ['flowchart TD\n  accTitle: x', 'gitGraph\n  accTitle: x']) {
      expect(find(highlight(src), 'accTitle')?.classes).toBe(classFor(t.keyword));
    }
  });

  it('falls back to COMMON when the header is not recognised', () => {
    // A diagram type from a Mermaid newer than the one we ship: highlighting
    // should degrade, not disappear.
    const styled = highlight('nonesuchDiagram\n  title Something\n  A --> B');
    expect(find(styled, 'title')?.classes).toBe(classFor(t.keyword));
    expect(find(styled, '-->')?.classes).toBe(classFor(t.operator));
  });
});

describe('mermaid language: headers', () => {
  // v11 made -beta optional on several types and lets `requirement` stand in
  // for `requirementDiagram`. Matching only the -beta spelling meant the modern
  // bare form got no header highlighting at all.
  it.each([
    'xychart',
    'sankey',
    'packet',
    'block',
    'requirement',
    'treemap',
    'architecture',
    'C4Component',
    'C4Deployment',
    'flowchart-elk',
    'info',
    'radar-beta',
    'venn-beta',
    'swimlane-beta',
    'kanban',
  ])('recognises `%s` as a diagram header', (header) => {
    const styled = highlight(`${header}\n  A\n`);
    expect(styled[0]?.text).toBe(header);
    expect(styled[0]?.classes).toBe(classFor(t.keyword));
  });

  it('still recognises the -beta spellings mermaid 10 requires', () => {
    for (const header of ['xychart-beta', 'sankey-beta', 'block-beta', 'requirementDiagram']) {
      const styled = highlight(`${header}\n  A\n`);
      expect(styled[0]?.text).toBe(header);
      expect(styled[0]?.classes).toBe(classFor(t.keyword));
    }
  });

  it('matches an indented header, as Mermaid’s own /^\\s*/ detectors do', () => {
    const styled = highlight('   flowchart TD\n   A --> B');
    expect(find(styled, 'flowchart')?.classes).toBe(classFor(t.keyword));
  });

  it('does not read a second header mid-document', () => {
    // `graph` after the header is a node id, not a new diagram.
    const styled = highlight('flowchart TD\n  A --> B\ngraph');
    const graph = styled.filter((s) => s.text === 'graph');
    expect(graph).toHaveLength(1);
    expect(graph[0].classes).toBe(classFor(t.variableName));
  });
});

describe('mermaid language: front matter', () => {
  it('styles a leading --- block as meta and still finds the header after it', () => {
    const styled = highlight('---\ntitle: My diagram\n---\nflowchart TD\n  A --> B');
    expect(styled[0].text).toBe('---');
    expect(styled[0].classes).toBe(classFor(t.meta));
    // The header is no longer on line 1, which the stateless tokenizer had no
    // way to cope with.
    expect(find(styled, 'flowchart')?.classes).toBe(classFor(t.keyword));
    expect(find(styled, '-->')?.classes).toBe(classFor(t.operator));
  });

  it('treats an inline --- as an undirected link', () => {
    const styled = highlight('flowchart TD\n  A --- B');
    expect(find(styled, '---')?.classes).toBe(classFor(t.operator));
  });

  it('does not let a standalone --- line mid-document open front matter', () => {
    // The atStart guard, and the failure mode it prevents: without it any line
    // that is just `---` flips the tokenizer into front matter and greys out
    // everything after it to the end of the document.
    const styled = highlight('flowchart TD\n  A --> B\n---\n  C --> D');
    expect(find(styled, 'C')?.classes).toBe(classFor(t.variableName));
    expect(find(styled, 'D')?.classes).toBe(classFor(t.variableName));
    // Nothing after the header should have been swallowed as metadata.
    expect(styled.filter((s) => s.classes === classFor(t.meta))).toHaveLength(0);
  });
});

describe('mermaid language: highlight style completeness', () => {
  // Every legacy token name token() can return, paired with the tag
  // StreamLanguage maps it to. If a token type is added to mermaid-lang.ts
  // without a matching entry in mermaidHighlightStyle, its text renders with no
  // colour at all — previously defaultHighlightStyle would have caught it, so
  // this test is what replaced that safety net.
  const EMITTED = [
    ['meta', t.meta],
    ['comment', t.comment],
    ['string', t.string],
    ['keyword', t.keyword],
    ['operator', t.operator],
    ['number', t.number],
    ['variableName', t.variableName],
  ];

  it.each(EMITTED)('gives %s a class', (_name, tag) => {
    const cls = classFor(tag);
    expect(cls).toBeTruthy();
  });

  it('gives each token type its own class, so the types stay distinguishable', () => {
    const classes = EMITTED.map(([, tag]) => classFor(tag));
    expect(new Set(classes).size).toBe(EMITTED.length);
  });

  it('colours every class from a --mf-tok-* custom property', () => {
    // The point of the whole exercise: colours resolve from Atlassian's --ds-*
    // tokens via the custom properties in src/config/index.html, so light and
    // dark both follow Confluence. A literal hex here would be a regression to
    // the hardcoded palette this replaced.
    const rules = mermaidHighlightStyle.module?.getRules() ?? '';
    for (const [name] of EMITTED) {
      const prop = name === 'variableName' ? 'variable' : name.toLowerCase();
      expect(rules).toContain(`var(--mf-tok-${prop})`);
    }
  });
});
