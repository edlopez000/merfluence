import { StreamLanguage } from '@codemirror/language';

const DIAGRAM_TYPES =
  /^(flowchart|graph|sequenceDiagram|classDiagram(-v2)?|stateDiagram(-v2)?|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|xychart-beta|sankey-beta|block-beta|packet-beta|architecture-beta|kanban|requirementDiagram|C4Context|C4Container)\b/;

const KEYWORDS =
  /^(subgraph|end|participant|actor|note|over|loop|alt|else|opt|par|and|critical|break|rect|activate|deactivate|autonumber|direction|classDef|class|click|style|linkStyle|section|title|dateFormat|axisFormat|state|namespace)\b/;

const ARROWS = /^(<-->|-->>|->>|<<-|--x|--o|-\.->|-\.-|==>|===|-->|---|->|--)/;

// Hoisted alongside the three above for the same reason: token() runs once per
// token per line on every re-tokenization, and a regex literal in the body
// allocates a fresh RegExp on each evaluation.
const DIRECTIVE = /^%%\{.*?\}%%/;
const COMMENT = /^%%.*/;
const STRING = /^"(?:[^"\\]|\\.)*"/;
const NODE_LABEL = /^\[[^\]]*\]|^\(\([^)]*\)\)|^\([^)]*\)|^\{[^}]*\}/;
const NUMBER = /^\d+(\.\d+)?/;
const IDENTIFIER = /^[A-Za-z_][\w-]*/;

export const mermaid = StreamLanguage.define({
  name: 'mermaid',
  startState: () => ({}),
  token(stream) {
    if (stream.eatSpace()) return null;

    if (stream.match(DIRECTIVE)) return 'meta';
    if (stream.match(COMMENT)) return 'comment';
    if (stream.match(STRING)) return 'string';

    if (stream.sol() && stream.match(DIAGRAM_TYPES)) return 'keyword';
    if (stream.match(KEYWORDS)) return 'keyword';
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
