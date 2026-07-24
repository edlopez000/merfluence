// Ambient declarations for the type-check pass (npm run typecheck).
//
// These two identifiers are compile-time constants substituted by Vite's
// `define` (see the `mermaidVersions` object in vite.view.config.js, re-injected
// into both vitest projects via vitest.config.js). They are real string literals
// at build time but do not exist in source, so tsc — like eslint, which declares
// them as readonly globals in eslint.config.js — must be told they exist.
declare const __MERMAID_11_VERSION__: string;
declare const __MERMAID_10_VERSION__: string;
