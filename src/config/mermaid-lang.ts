import { HighlightStyle, StreamLanguage } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

/**
 * Every diagram header mermaid 11.16.1 detects, plus the spellings mermaid 10
 * still requires. Read off the detector regexes in
 * node_modules/mermaid/dist/mermaid.core.mjs rather than from documentation,
 * because the two disagree.
 *
 * Two things this has to get right that are easy to miss:
 *   - v11 made `-beta` OPTIONAL for xychart/sankey/packet/block/treemap and
 *     lets `requirement` stand in for `requirementDiagram`. Matching only the
 *     `-beta` spelling left a user typing the modern bare form with no
 *     highlighted header at all, which reads as broken.
 *   - v10 is stricter and still demands `-beta`. Highlighting is
 *     version-agnostic — the version dropdown only decides what renders — so
 *     this is the union of both majors, never one or the other.
 *
 * Recognising a header is cheap (one alternation); it is the per-dialect
 * keyword tables below that cost real bytes. So every type is listed here even
 * though only the dialects people actually use get a table.
 */
const DIAGRAM_TYPES =
  /^(flowchart(-elk)?|graph|swimlane-beta|sequenceDiagram|classDiagram(-v2)?|stateDiagram(-v2)?|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|kanban|quadrantChart|xychart(-beta)?|sankey(-beta)?|block(-beta)?|packet(-beta)?|treemap(-beta)?|architecture(-beta)?|ishikawa(-beta)?|requirement(Diagram)?|radar-beta|venn-beta|treeView-beta|wardley-beta|cynefin-beta|railroad(-(ebnf|abnf|peg))?-beta|eventmodeling|info|C4(Context|Container|Component|Dynamic|Deployment))\b/;

/**
 * Header text -> the keyword table to use for the rest of the document. First
 * matching prefix wins, so order matters only where one is a prefix of
 * another. Anything unlisted falls through to COMMON alone.
 *
 * swimlane-beta maps to flowchart on evidence, not on a guess: it is parsed by
 * the same chunk as flowchart/graph (dist/chunks/mermaid.core/chunk-JQJVKLGR),
 * so it shares that grammar's vocabulary.
 */
const DIAGRAM_KEYS: [string, string][] = [
  ['flowchart', 'flowchart'],
  ['graph', 'flowchart'],
  ['swimlane', 'flowchart'],
  ['sequenceDiagram', 'sequence'],
  ['classDiagram', 'class'],
  ['stateDiagram', 'state'],
  ['erDiagram', 'er'],
  ['gantt', 'gantt'],
  ['pie', 'pie'],
  ['gitGraph', 'gitGraph'],
  ['quadrantChart', 'quadrant'],
  ['xychart', 'xychart'],
  ['requirement', 'requirement'],
  ['block', 'block'],
  ['architecture', 'architecture'],
  ['C4', 'c4'],
];

/**
 * Keywords every dialect shares. accTitle/accDescr are in every Mermaid grammar
 * and went unhighlighted until now, which is worth fixing in an app that
 * derives an accessible name from the source (src/lib/a11y-name.ts).
 */
const COMMON =
  /^(accTitle|accDescr|classDef|class|linkStyle|style|direction|click|href|section|title|end|note)\b/;

/**
 * Per-dialect keywords, extracted from the compiled jison lexer tables in
 * node_modules/mermaid/dist/chunks/mermaid.core/ and the serialized Langium
 * grammar in @mermaid-js/parser. The grammars themselves are not shipped.
 *
 * THE POINT OF THE SPLIT: these lists are full of ordinary English — `contains`,
 * `to`, `one`, `many`, `line`, `text`, `left`, `space`. Merged into one flat
 * regex they would fire everywhere, so `contains` in erDiagram's
 * `ORDER ||--|{ LINE-ITEM : contains` (test/fixtures/er.mmd) would be painted a
 * keyword when it is a relationship label. Scoping each list to the diagram
 * that declares it is the only way to add them without making highlighting
 * worse than none.
 *
 * Dialects absent from this table (sankey, packet, radar, treemap, info, venn,
 * railroad, wardley, cynefin, ishikawa, treeView) get a highlighted header and
 * COMMON. eventmodeling and swimlane-beta keyword sets could not be determined
 * from the shipped bundles at all, so they are not guessed at.
 */
const KEYWORDS_BY_DIAGRAM: Record<string, RegExp> = {
  flowchart: /^(subgraph|interpolate|default)\b/,
  sequence:
    /^(participant|actor|over|loop|alt|else|opt|par_over|par|and|critical|option|break|rect|activate|deactivate|autonumber|box|create|destroy|links|link|properties|details|off|as)\b/,
  class: /^(namespace|callback|cssClass|link)\b/,
  state: /^(hide empty description|left of|right of|state|scale|default)\b/,
  er: /^(one|many|to)\b/,
  gantt:
    /^(dateFormat|axisFormat|tickInterval|excludes|includes|todayMarker|inclusiveEndDates|topAxis|weekday|weekend|call)\b/,
  pie: /^showData\b/,
  gitGraph:
    /^(commit|branch|merge|checkout|switch|cherry-pick|tag|order|parent|type|id|msg|NORMAL|REVERSE|HIGHLIGHT)\b/,
  quadrant: /^(quadrant-[1-4]|x-axis|y-axis)\b/,
  xychart: /^(x-axis|y-axis|bar|line|vertical|horizontal)\b/,
  requirement:
    /^((functional|interface|performance|physical)Requirement|designConstraint|requirement|element|satisfies|traces|verifies|refines|contains|copies|derives|docref|verifyMethod|risk|text|type|id|low|medium|high|analysis|inspection|test|demonstration)\b/,
  block: /^(columns|block|space|down|up|left|right|interpolate|default)\b/,
  architecture: /^(group|service|junction|in|align|row|column)\b/,
  // C4's ~45 macros as a pattern rather than an alternation — it covers
  // System_Ext, SystemDb, SystemDb_Ext, ContainerQueue, Rel_U, Rel_Back, Node_L
  // and the rest for a fraction of the bytes, which is what buys room for the
  // requirement table above within the size budget.
  c4: /^(Person|System|Container|Component|Node|Boundary|BiRel|RelIndex|Rel|Deployment_Node|Enterprise_Boundary|Update(ElementStyle|RelStyle|LayoutConfig))(Db|Queue)?(_\w+)?\b/,
};

const ARROWS = /^(<-->|-->>|->>|<<-|--x|--o|-\.->|-\.-|==>|===|-->|---|->|--)/;

// A document-leading `---` opens YAML front matter (mermaid 11), after which
// the diagram header is no longer on line 1. Only ever checked while nothing
// but trivia has been seen, because `---` is also a flowchart link: `A --- B`.
const FRONT_MATTER_FENCE = /^---\s*$/;

// Hoisted alongside the three above for the same reason: token() runs once per
// token per line on every re-tokenization, and a regex literal in the body
// allocates a fresh RegExp on each evaluation.
const DIRECTIVE = /^%%\{.*?\}%%/;
const COMMENT = /^%%.*/;
const STRING = /^"(?:[^"\\]|\\.)*"/;
const NODE_LABEL = /^\[[^\]]*\]|^\(\([^)]*\)\)|^\([^)]*\)|^\{[^}]*\}/;
const NUMBER = /^\d+(\.\d+)?/;
const IDENTIFIER = /^[A-Za-z_][\w-]*/;

type State = {
  /** Keyword table in force, or null while the header has not been found. */
  diagram: string | null;
  /** Inside a `---` YAML front-matter block. */
  frontMatter: boolean;
  /** Nothing but whitespace, comments and directives seen so far. */
  atStart: boolean;
  /** Whether this line has produced a token yet — see atLineStart below. */
  lineHasContent: boolean;
};

export const mermaid = StreamLanguage.define<State>({
  name: 'mermaid',
  startState: () => ({
    diagram: null,
    frontMatter: false,
    atStart: true,
    lineHasContent: false,
  }),
  // No copyState: StreamParser's default is a shallow object copy, which is
  // exactly right for four primitive fields. Noted because its absence looks
  // like an oversight rather than a decision.
  token(stream, state) {
    if (stream.sol()) state.lineHasContent = false;
    if (stream.eatSpace()) return null;
    // Mermaid's own detectors are anchored /^\s*/, so an indented header is
    // still a header. stream.sol() alone can't tell us that — the eatSpace
    // above has already moved off column 0 — hence tracking it on the state.
    const atLineStart = !state.lineHasContent;
    state.lineHasContent = true;

    if (state.frontMatter) {
      if (atLineStart && stream.match(FRONT_MATTER_FENCE)) state.frontMatter = false;
      else stream.skipToEnd();
      return 'meta';
    }
    if (state.atStart && atLineStart && stream.match(FRONT_MATTER_FENCE)) {
      state.frontMatter = true;
      state.atStart = false;
      return 'meta';
    }

    // Directives before comments: both open with %%, and COMMENT would eat a
    // whole `%%{init: ...}%%` line if it went first.
    if (stream.match(DIRECTIVE)) return 'meta';
    if (stream.match(COMMENT)) return 'comment';
    if (stream.match(STRING)) return 'string';

    state.atStart = false;

    // Gated on diagram === null, so the header is matched once. That is what
    // stops a later line beginning `graph` from reading as a second header.
    if (state.diagram === null && atLineStart) {
      const header = stream.match(DIAGRAM_TYPES) as RegExpMatchArray | null;
      if (header) {
        state.diagram = DIAGRAM_KEYS.find(([prefix]) => header[0].startsWith(prefix))?.[1] ?? '';
        return 'keyword';
      }
    }

    if (stream.match(COMMON)) return 'keyword';
    // An unrecognised header leaves diagram null and this undefined, so the
    // editor degrades to COMMON-only rather than losing highlighting outright
    // — which is what a diagram type from a newer Mermaid should do.
    const dialect = state.diagram === null ? undefined : KEYWORDS_BY_DIAGRAM[state.diagram];
    if (dialect && stream.match(dialect)) return 'keyword';

    if (stream.match(ARROWS)) return 'operator';

    // Node labels: [text] (text) {text} ((text))
    if (stream.match(NODE_LABEL)) return 'string';

    if (stream.match(NUMBER)) return 'number';
    if (stream.match(IDENTIFIER)) return 'variableName';

    stream.next();
    return null;
  },
  languageData: {
    commentTokens: { line: '%%' },
    indentOnInput: /^\s*end$/,
  },
});

/**
 * Token colours for the seven tags token() above can emit — and only those
 * seven, which is what test/mermaid-lang.test.js pins.
 *
 * The values are CSS custom properties rather than literals so that light and
 * dark both resolve from Atlassian's --ds-* tokens, defined in
 * src/config/index.html. This replaced CodeMirror's defaultHighlightStyle
 * (generic, light-only) plus oneDarkHighlightStyle (One Dark's palette, which
 * looked nothing like the rest of the editor in dark mode).
 *
 * Why custom properties and not two HighlightStyles swapped in a compartment:
 * a stylesheet can key off a class, and the editor already knows whether it is
 * dark. CodeMirror's own dark-theme class is a StyleModule-generated name that
 * static CSS cannot target, and the host's data-color-mode is the wrong signal
 * — the editor's dark flag follows the diagram-theme select, which can be dark
 * on a light page.
 */
export const mermaidHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--mf-tok-keyword)', fontWeight: '600' },
  { tag: t.comment, color: 'var(--mf-tok-comment)', fontStyle: 'italic' },
  { tag: t.string, color: 'var(--mf-tok-string)' },
  { tag: t.operator, color: 'var(--mf-tok-operator)' },
  { tag: t.meta, color: 'var(--mf-tok-meta)' },
  { tag: t.number, color: 'var(--mf-tok-number)' },
  { tag: t.variableName, color: 'var(--mf-tok-variable)' },
]);
