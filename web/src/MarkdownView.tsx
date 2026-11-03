/**
 * The little markdown a card's detail — and the digest — can hold, as React
 * elements: paragraphs, headings, bullet and numbered lists, bold, italics,
 * inline code and `http(s)` links. Parsed by `markdown.ts`, never injected.
 */
import type { Block, Inline } from "./markdown.js";
import { parseMarkdown } from "./markdown.js";

/** The parsed markdown, as elements. */
export function Markdown({ source }: { source: string }) {
  return (
    <>
      {parseMarkdown(source).map((block, index) => (
        <MarkdownBlock key={index} block={block} />
      ))}
    </>
  );
}

function MarkdownBlock({ block }: { block: Block }) {
  switch (block.kind) {
    case "paragraph":
      return (
        <p className="md__p">
          <Spans spans={block.spans} />
        </p>
      );
    case "heading": {
      const Tag = `h${block.level + 2}` as "h3" | "h4" | "h5";
      return (
        <Tag className="md__h">
          <Spans spans={block.spans} />
        </Tag>
      );
    }
    case "bullets":
      return (
        <ul className="md__ul">
          {block.items.map((item, index) => (
            <li key={index}>
              <Spans spans={item} />
            </li>
          ))}
        </ul>
      );
    case "numbers":
      return (
        <ol className="md__ol">
          {block.items.map((item, index) => (
            <li key={index}>
              <Spans spans={item} />
            </li>
          ))}
        </ol>
      );
  }
}

function Spans({ spans }: { spans: readonly Inline[] }) {
  return (
    <>
      {spans.map((span, index) => {
        switch (span.kind) {
          case "strong":
            return <strong key={index}>{span.text}</strong>;
          case "em":
            return <em key={index}>{span.text}</em>;
          case "code":
            return (
              <code key={index} className="md__code">
                {span.text}
              </code>
            );
          case "link":
            return (
              <a key={index} href={span.href} target="_blank" rel="noreferrer noopener">
                {span.text}
              </a>
            );
          case "text":
            return <span key={index}>{span.text}</span>;
        }
      })}
    </>
  );
}
