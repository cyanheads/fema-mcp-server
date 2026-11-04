/**
 * @fileoverview Semantic text and JSON readers for tool Markdown assertions.
 * @module tests/helpers/rendered-markdown
 */
import MarkdownIt from 'markdown-it';

/** GFM tables plus CommonMark HTML handling, with inline syntax resolved. */
export const markdown = new MarkdownIt({ html: true });

/** Text a parser exposes, omitting markup tokens rather than counting HTML source as text. */
export function renderedText(text: string): string[] {
  return markdown
    .parse(text, {})
    .filter((token) => token.type === 'inline')
    .map((token) =>
      (token.children ?? [])
        .map((child) =>
          child.type === 'text' || child.type === 'code_inline'
            ? child.content
            : child.type === 'softbreak' || child.type === 'hardbreak'
              ? '\n'
              : '',
        )
        .join(''),
    );
}

/** Decode the complete JSON fallback, rejecting a partial fence or mixed-layout response. */
export function jsonFallback(text: string): unknown {
  const tokens = markdown.parse(text, {});
  if (tokens.length !== 1 || tokens[0]?.type !== 'fence' || tokens[0].info !== 'json')
    throw new Error('Expected one complete JSON fence');
  return JSON.parse(tokens[0].content);
}
