/**
 * Markdown to plain text, for places that show or speak an agent's words
 * without rendering them: the call screen's lanes and everything Pew is told.
 * A `**bold**` shown raw reads as noise, and spoken it is worse.
 *
 * Conservative: removes the marks, keeps every word. Underscores inside a
 * word (`snake_case`) and asterisks in arithmetic (`2 * 3`) are left alone.
 */
export function plainText(markdown: string): string {
  return (
    markdown
      // Fences: keep the code, drop the ``` lines (and a language tag).
      .replace(/^\s*(```|~~~)[^\n]*$/gm, "")
      // Images, then links: their words, not their URLs.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, "$1")
      // Reference-style link definitions.
      .replace(/^\s*\[[^\]]+\]:\s+\S+.*$/gm, "")
      // Inline code.
      .replace(/`{1,3}([^`\n]+)`{1,3}/g, "$1")
      // Headings, blockquotes, list bullets, task boxes, rules.
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s*>\s?/gm, "")
      .replace(/^(\s*)[-*+]\s+\[[ xX]\]\s+/gm, "$1")
      .replace(/^(\s*)[-*+]\s+/gm, "$1")
      .replace(/^\s*([-*_])(\s*\1){2,}\s*$/gm, "")
      // Bold and italic: ** __ * _ around words (not inside one, not maths).
      .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, "$2")
      .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2")
      .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2")
      .replace(/~~(?=\S)([^\n]*?\S)~~/g, "$1")
      // Table rows: cells as a list; separator rows go.
      .replace(/^[ \t]*\|?([ \t]*:?-{2,}:?[ \t]*\|)+[ \t]*(:?-{2,}:?)?[ \t]*$/gm, "")
      .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, row: string) => row.split("|").map((cell) => cell.trim()).filter(Boolean).join(" · "))
      // Bare HTML tags.
      .replace(/<\/?[a-z][a-z0-9-]*(\s[^<>]*)?\/?>/gi, "")
      // Escapes.
      .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1")
  );
}
