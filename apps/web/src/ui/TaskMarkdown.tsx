import type { JSX } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const markdownComponents: Components = {
  img: ({ src, alt }) => {
    const label = `[image: ${alt ?? ''}]`;
    if (!src) return <span>{label}</span>;
    return (
      <a href={src} target="_blank" rel="noopener noreferrer nofollow">
        {label}
      </a>
    );
  },
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
};

export function TaskMarkdown({ content }: { content: string }): JSX.Element {
  return (
    <div className="markdown-body details">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
