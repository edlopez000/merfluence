/**
 * A working skeleton beats an empty box. Most people inserting this macro have
 * never written Mermaid; they have a shape in their head and no syntax. These are
 * the canonical examples from the Mermaid documentation, so the starter matches
 * what a reader finds when they go looking for the syntax.
 */
export const TEMPLATES = [
  {
    id: 'flowchart',
    label: 'Flowchart',
    source: `flowchart TD
    A[Start] --> B{Is it?}
    B -- Yes --> C[OK]
    C --> D[Rethink]
    D --> B
    B -- No ----> E[End]`,
  },
  {
    id: 'sequence',
    label: 'Sequence diagram',
    source: `sequenceDiagram
    Alice->>John: Hello John, how are you?
    John-->>Alice: Great!
    Alice-)John: See you later!`,
  },
  {
    id: 'state',
    label: 'State diagram',
    source: `stateDiagram-v2
    [*] --> Still
    Still --> [*]

    Still --> Moving
    Moving --> Still
    Moving --> Crash
    Crash --> [*]`,
  },
  {
    id: 'er',
    label: 'Entity relationship',
    source: `erDiagram
    CUSTOMER ||--o{ ORDER : places
    ORDER ||--|{ LINE-ITEM : contains
    CUSTOMER }|..|{ DELIVERY-ADDRESS : uses`,
  },
  {
    id: 'gantt',
    label: 'Gantt chart',
    source: `gantt
    title A Gantt Diagram
    dateFormat YYYY-MM-DD
    section Section
        A task          :a1, 2014-01-01, 30d
        Another task    :after a1, 20d
    section Another
        Task in Another :2014-01-12, 12d
        another task    :24d`,
  },
  {
    id: 'class',
    label: 'Class diagram',
    source: `classDiagram
    note "From Duck till Zebra"
    Animal <|-- Duck
    note for Duck "can fly, can swim, can dive, can help in debugging"
    Animal <|-- Fish
    Animal <|-- Zebra
    Animal : +int age
    Animal : +String gender
    Animal: +isMammal()
    Animal: +mate()
    class Duck{
        +String beakColor
        +swim()
        +quack()
    }
    class Fish{
        -int sizeInFeet
        -canEat()
    }
    class Zebra{
        +bool is_wild
        +run()
    }`,
  },
  {
    id: 'mindmap',
    label: 'Mindmap',
    source: `mindmap
  root((mindmap))
    Origins
      Long history
      Popularisation
        British popular psychology author Tony Buzan
    Research
      On effectiveness and features
      On Automatic creation
        Uses
            Creative techniques
            Strategic planning
            Argument mapping
    Tools
      Pen and paper
      Mermaid`,
  },
  {
    id: 'timeline',
    label: 'Timeline',
    source: `timeline
    title History of Social Media Platform
    2002 : LinkedIn
    2004 : Facebook
         : Google
    2005 : YouTube
    2006 : Twitter`,
  },
  {
    id: 'pie',
    label: 'Pie chart',
    source: `pie title Pets adopted by volunteers
    "Dogs" : 386
    "Cats" : 85
    "Rats" : 15`,
  },
  {
    id: 'journey',
    label: 'User journey',
    source: `journey
    title My working day
    section Go to work
      Make tea: 5: Me
      Go upstairs: 3: Me
      Do work: 1: Me, Cat
    section Go home
      Go downstairs: 5: Me
      Sit down: 5: Me`,
  },
  {
    id: 'gitgraph',
    label: 'Git graph',
    source: `gitGraph
   commit
   commit
   branch develop
   checkout develop
   commit
   commit
   checkout main
   merge develop
   commit
   commit`,
  },
  {
    id: 'quadrant',
    label: 'Quadrant chart',
    source: `quadrantChart
    title Reach and engagement of campaigns
    x-axis Low Reach --> High Reach
    y-axis Low Engagement --> High Engagement
    quadrant-1 We should expand
    quadrant-2 Need to promote
    quadrant-3 Re-evaluate
    quadrant-4 May be improved
    Campaign A: [0.3, 0.6]
    Campaign B: [0.45, 0.23]
    Campaign C: [0.57, 0.69]
    Campaign D: [0.78, 0.34]
    Campaign E: [0.40, 0.34]
    Campaign F: [0.35, 0.78]`,
  },
  {
    id: 'xychart',
    label: 'XY chart',
    source: `xychart-beta
    title "Sales Revenue"
    x-axis [jan, feb, mar, apr, may, jun, jul, aug, sep, oct, nov, dec]
    y-axis "Revenue (in $)" 4000 --> 11000
    bar [5000, 6000, 7500, 8200, 9500, 10500, 11000, 10200, 9200, 8500, 7000, 6000]
    line [5000, 6000, 7500, 8200, 9500, 10500, 11000, 10200, 9200, 8500, 7000, 6000]`,
  },
  {
    id: 'sankey',
    label: 'Sankey diagram',
    source: `sankey-beta

Agricultural 'waste',Bio-conversion,124.729
Bio-conversion,Liquid,0.597
Bio-conversion,Losses,26.862
Bio-conversion,Solid,280.322
Bio-conversion,Gas,81.144`,
  },
  {
    id: 'c4',
    label: 'C4 context',
    source: `C4Context
    title System Context diagram for Internet Banking System
    Person(customerA, "Banking Customer A", "A customer of the bank.")
    System(SystemAA, "Internet Banking System", "Allows customers to view their accounts.")
    System_Ext(SystemE, "Mainframe Banking System", "Stores core banking information.")
    Rel(customerA, SystemAA, "Uses")
    Rel(SystemAA, SystemE, "Uses")`,
  },
  {
    id: 'block',
    label: 'Block diagram',
    source: `block-beta
  columns 3
  a["A label"] b:2
  block:group1:2
    columns 2
    c d e f
  end
  g`,
  },
  {
    id: 'kanban',
    label: 'Kanban board',
    source: `kanban
  Todo
    [Create Documentation]
    docs[Create Blog about the new diagram]
  [In progress]
    id6[Create renderer]
  [Ready for deploy]
    id8[Design grammar]
  [Done]
    id5[Define getData]`,
  },
  {
    id: 'architecture',
    label: 'Architecture',
    source: `architecture-beta
    group api(cloud)[API]

    service db(database)[Database] in api
    service disk1(disk)[Storage] in api
    service disk2(disk)[Storage] in api
    service server(server)[Server] in api

    db:L -- R:server
    disk1:T -- B:server
    disk2:T -- B:db`,
  },
];

export const DEFAULT_SOURCE = TEMPLATES[0].source;
