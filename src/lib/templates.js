/**
 * A working skeleton beats an empty box. Most people inserting this macro have
 * never written Mermaid; they have a shape in their head and no syntax.
 */
export const TEMPLATES = [
  {
    id: 'flowchart',
    label: 'Flowchart',
    source: `flowchart TD
  A[Request] --> B{Authorized?}
  B -- Yes --> C[Handle]
  B -- No --> D[Reject]
  C --> E[Respond]
  D --> E`,
  },
  {
    id: 'sequence',
    label: 'Sequence diagram',
    source: `sequenceDiagram
  participant Client
  participant API
  participant DB
  Client->>API: POST /orders
  API->>DB: INSERT
  DB-->>API: order_id
  API-->>Client: 201 Created`,
  },
  {
    id: 'state',
    label: 'State diagram',
    source: `stateDiagram-v2
  [*] --> Draft
  Draft --> InReview
  InReview --> Approved
  InReview --> Draft
  Approved --> [*]`,
  },
  {
    id: 'er',
    label: 'Entity relationship',
    source: `erDiagram
  WORK_ORDER ||--o{ QUOTE : has
  QUOTE ||--o{ INVOICE : becomes
  WORK_ORDER {
    int id PK
    int facility_id FK
    string status
  }`,
  },
  {
    id: 'gantt',
    label: 'Gantt chart',
    source: `gantt
  title Release plan
  dateFormat YYYY-MM-DD
  section Build
    Schema migration :a1, 2026-01-06, 5d
    API endpoints    :after a1, 8d
  section Ship
    Staging soak     :2026-01-22, 3d`,
  },
  {
    id: 'class',
    label: 'Class diagram',
    source: `classDiagram
  class Facility {
    +int id
    +string name
    +listWorkOrders()
  }
  class WorkOrder {
    +int id
    +string status
  }
  Facility "1" --> "*" WorkOrder`,
  },
];

export const DEFAULT_SOURCE = TEMPLATES[0].source;
