/**
 * @fileoverview Lossless fallback for strings that cannot occupy single-line Markdown slots.
 * @module mcp-server/tools/literal-markdown
 */
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';

/** True when a result's keys or string values need JSON to retain controls or edge whitespace. */
export function requiresJson(value: unknown): boolean {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      if (current.trim() !== current) return true;
      for (let at = 0; at < current.length; at++) {
        const code = current.charCodeAt(at);
        if (code < 32 || code === 127) return true;
      }
    } else if (Array.isArray(current)) {
      for (const child of current) pending.push(child);
    } else if (current !== null && typeof current === 'object') {
      for (const [key, child] of Object.entries(current)) pending.push(key, child);
    }
  }
  return false;
}

/** Compact JSON has no literal CR/LF, so even embedded fence runs cannot close this fence. */
export function renderJson(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

/** Render a raw enrichment string independently; never write encoded text to handler output. */
export function renderLiteral(value: unknown): string {
  return requiresJson(value) ? renderJson(value) : escapeMarkdownInline(String(value));
}

/** Preserve the framework notice blockquote when safe, using an independent JSON fence otherwise. */
export function renderNotice(value: unknown): string {
  return requiresJson(value) ? renderJson(value) : `> ${escapeMarkdownInline(String(value))}`;
}
