"use client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/*
 * Renders lesson and reading Markdown (headings, bold/italic, lists, GitHub-style
 * tables, task lists, strikethrough, code, quotes, links).
 *
 * Safety: lesson text is imported data, so raw HTML is NOT rendered (react-markdown
 * escapes it as text), and link URLs are sanitised by react-markdown's default
 * transform (javascript: and similar are dropped). Never add rehype-raw here.
 */
/*
 * AI-written lessons often break GitHub tables: all rows end up on one line ("| a | b | | c | d |"),
 * or the |---| separator row is missing, so nothing renders as a table. This puts each row on its own
 * line and adds the separator when it is missing. Text that is already a valid table is left alone.
 */
const isSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").length;
export function fixTables(text: string): string {
  const lines = (text || "").split("\n");
  const out: string[] = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence || !/^\s*\|.*\|\s*$/.test(line)) { out.push(line); continue; }
    // several rows glued onto one line: "| a | b | | c | d |"
    let rows = [line];
    if (/\|\s+\|/.test(line)) {
      const split = line.trim().split(/\|\s+\|/).map((r, k, all) => (k > 0 ? "|" : "") + r + (k < all.length - 1 ? "|" : ""));
      if (split.length > 1 && new Set(split.map(cells)).size === 1) rows = split;
    }
    // collect the following table lines too
    let j = i + 1;
    while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j]) && !/^\s*(```|~~~)/.test(lines[j])) { rows.push(lines[j]); j++; }
    i = j - 1;
    if (rows.length > 1 && !isSep(rows[1])) rows.splice(1, 0, "|" + Array(cells(rows[0])).fill(" --- ").join("|") + "|");
    if (out.length && out[out.length - 1].trim() !== "") out.push("");
    out.push(...rows);
  }
  return out.join("\n");
}

export default function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer nofollow" />,
          // Wide tables scroll sideways inside their own box instead of breaking the page on phones.
          table: ({ node, ...props }) => <div className="md-table"><table {...props} /></div>,
          img: ({ node, alt, ...props }) => <img {...props} alt={alt || ""} loading="lazy" referrerPolicy="no-referrer" />,
        }}
      >
        {fixTables(text || "")}
      </ReactMarkdown>
    </div>
  );
}
