"use client";

import { isValidElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Mermaid } from "./Mermaid";

/** Safe Markdown renderer: raw HTML is not rendered, `javascript:` URLs are stripped by react-markdown. */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown prose prose-zinc max-w-none dark:prose-invert prose-headings:scroll-mt-20 prose-a:text-accent">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre({ children: kids }) {
            const props = isValidElement(kids) ? (kids.props as { className?: string }) : null;
            if (props?.className?.includes("language-mermaid")) return <>{kids}</>;
            return <pre>{kids}</pre>;
          },
          code({ className, children: kids, ...rest }) {
            if (/language-mermaid/.test(className ?? "")) return <Mermaid chart={String(kids).trim()} />;
            return (
              <code className={className} {...rest}>
                {kids}
              </code>
            );
          },
          a({ href, children: kids }) {
            return (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {kids}
              </a>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
