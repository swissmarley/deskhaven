import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TaskMarkdown } from '../src/ui/TaskMarkdown.js';

describe('TaskMarkdown', () => {
  it('renders headings and does not execute raw HTML', () => {
    const html = renderToStaticMarkup(
      createElement(TaskMarkdown, { content: '## Summary\n\n**bold** and `code`' }),
    );
    expect(html).toMatch(/<h2[^>]*>Summary<\/h2>/);
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
  });

  it('shows script tags as text, not as HTML elements', () => {
    const payload = '<script>alert("xss")</script>';
    const html = renderToStaticMarkup(createElement(TaskMarkdown, { content: payload }));
    expect(html.toLowerCase()).not.toContain('<script');
    expect(html).toContain('alert');
  });

  it('renders images as external links, not img elements', () => {
    const html = renderToStaticMarkup(
      createElement(TaskMarkdown, {
        content: '![tracker](https://evil.example/pixel.png)',
      }),
    );
    expect(html.toLowerCase()).not.toContain('<img');
    expect(html).toContain('href="https://evil.example/pixel.png"');
    expect(html).toContain('[image: tracker]');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('forces safe rel and target on markdown links', () => {
    const html = renderToStaticMarkup(
      createElement(TaskMarkdown, { content: '[docs](https://example.com/docs)' }),
    );
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });
});
