import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { Components } from "react-markdown";
import { preprocessRichText } from "../latexToMarkdown";

type Props = {
  content: string;
  variant?: "user" | "ai";
};

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  code: ({ className, children, ...props }) => {
    const isBlock = Boolean(className) || String(children).includes("\n");
    if (!isBlock) {
      return (
        <code className="inline-code" {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  table: ({ children }) => (
    <div className="md-table-wrap">
      <table>{children}</table>
    </div>
  ),
};

export function RichText({ content, variant = "ai" }: Props) {
  const source = preprocessRichText(content);

  return (
    <div className={`bubble-md bubble-md-${variant}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: true }]]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: "ignore" }]]}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

export { preprocessRichText } from "../latexToMarkdown";
