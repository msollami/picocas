// markdown.ts — render text-cell source to sanitized HTML.
//
// Pipeline:
//   1. Extract math spans ($$…$$ display, $…$ inline) into placeholders so the
//      Markdown parser can't mangle `_`, `*`, `\` inside them.
//   2. Run marked (GFM) on the protected source.
//   3. Sanitize the resulting HTML with DOMPurify (content may be pasted).
//   4. Re-insert KaTeX-rendered math after sanitization (KaTeX emits many
//      styled spans that we treat as trusted and don't want stripped/escaped).

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';

marked.setOptions({
  gfm: true,
  breaks: true, // single newline -> <br>, which reads best for notebook prose
});

interface MathSpan { placeholder: string; html: string; }

// Placeholder token: plain alphanumerics so neither marked nor DOMPurify
// rewrite or escape it. The index keeps them unique and ordered.
function placeholderFor(i: number): string {
  return `xKaTeXmathPlaceHolder${i}x`;
}

function renderMath(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex.trim(), { throwOnError: false, displayMode });
  } catch {
    // Fall back to the raw source wrapped so it's still visible.
    return `<code>${escapeHtml(displayMode ? `$$${tex}$$` : `$${tex}$`)}</code>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Pull math spans out of `src`, replacing each with a placeholder token.
function extractMath(src: string, spans: MathSpan[]): string {
  let out = src;

  // Display math first ($$…$$) so the inline pass doesn't see its delimiters.
  out = out.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex) => {
    const placeholder = placeholderFor(spans.length);
    spans.push({ placeholder, html: renderMath(tex, true) });
    return placeholder;
  });

  // Inline math ($…$): stay on one line, allow escaped \$ inside.
  out = out.replace(/\$((?:\\\$|[^$\n])+?)\$/g, (_m, tex) => {
    const placeholder = placeholderFor(spans.length);
    spans.push({ placeholder, html: renderMath(tex, false) });
    return placeholder;
  });

  return out;
}

/**
 * Render text-cell Markdown source to sanitized HTML with inline/display math.
 * Returns an empty string for blank input so callers can show a placeholder.
 */
export function renderMarkdown(source: string): string {
  if (!source || source.trim() === '') return '';

  const spans: MathSpan[] = [];
  const protectedSrc = extractMath(source, spans);

  const rawHtml = marked.parse(protectedSrc, { async: false }) as string;

  let clean = DOMPurify.sanitize(rawHtml, {
    ADD_ATTR: ['target'],
  });

  // Re-insert KaTeX HTML after sanitization.
  for (const { placeholder, html } of spans) {
    clean = clean.split(placeholder).join(html);
  }

  return clean;
}
