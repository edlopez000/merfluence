/**
 * Extract Mermaid source from the text of a dropped file.
 *
 * A GitLab/GitHub-flavored Markdown file wraps the diagram in a fenced block:
 *
 *     ```mermaid
 *     flowchart TD
 *       A --> B
 *     ```
 *
 * A `.mmd` file is just the raw diagram with no fence. So we look for a fenced
 * `mermaid` block first (regardless of extension, taking the first one) and fall
 * back to the whole file. The exception is a Markdown file with no such block —
 * we report that rather than dumping prose into the editor as if it were a
 * diagram.
 *
 */
export function extractMermaidSource(
  text: string,
  filename = '',
): { source: string } | { error: string } {
  const fence = String(text ?? '').match(/```[ \t]*mermaid[ \t]*\r?\n([\s\S]*?)```/i);
  // trimEnd(), not replace(/\s+$/, ''): the regex form backtracks quadratically on a
  // long whitespace run that does NOT reach the end of the string — 200KB of spaces
  // followed by one other character took ~68s here, freezing the editor iframe on a
  // file the author merely dropped. trimEnd() strips the identical character set
  // (JS \s and the spec's WhiteSpace + LineTerminator are the same set) in linear time.
  if (fence) return { source: fence[1].trimEnd() };
  if (/\.(md|markdown)$/i.test(filename)) {
    return { error: 'No ```mermaid code block found in that markdown file.' };
  }
  return { source: String(text ?? '').trimEnd() };
}
