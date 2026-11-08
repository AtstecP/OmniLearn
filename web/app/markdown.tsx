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
        {text || ""}
      </ReactMarkdown>
    </div>
  );
}
