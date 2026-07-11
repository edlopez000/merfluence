import { StreamLanguage } from '@codemirror/language';

const DIAGRAM_TYPES =
  /^(flowchart|graph|sequenceDiagram|classDiagram(-v2)?|stateDiagram(-v2)?|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|xychart-beta|sankey-beta|block-beta|packet-beta|architecture-beta|kanban|requirementDiagram|C4Context|C4Container)\b/;

const KEYWORDS =
  /^(subgraph|end|participant|actor|note|over|loop|alt|else|opt|par|and|critical|break|rect|activate|deactivate|autonumber|direction|classDef|class|click|style|linkStyle|section|title|dateFormat|axisFormat|state|namespace)\b/;

const ARROWS = /^(<-->|-->>|->>|<<-|--x|--o|-\.->|-\.-|==>|===|-->|---|->|--)/;

export const mermaid = StreamLanguage.define({
  name: 'mermaid',
  startState: () => ({}),
  token(stream) {
    if (stream.eatSpace()) return null;

    if (stream.match(/^%%\{.*?\}%%/)) return 'meta'; // directive
    if (stream.match(/^%%.*/)) return 'comment';
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return 'string';

    if (stream.sol() && stream.match(DIAGRAM_TYPES)) return 'keyword';
    if (stream.match(KEYWORDS)) return 'keyword';
    if (stream.match(ARROWS)) return 'operator';

    // Node labels: [text] (text) {text} ((text))
    if (stream.match(/^\[[^\]]*\]|^\(\([^)]*\)\)|^\([^)]*\)|^\{[^}]*\}/)) return 'string';

    if (stream.match(/^\d+(\.\d+)?/)) return 'number';
    if (stream.match(/^[A-Za-z_][\w-]*/)) return 'variableName';

    stream.next();
    return null;
  },
  languageData: {
    commentTokens: { line: '%%' },
    indentOnInput: /^\s*end$/,
  },
});
