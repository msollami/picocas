// markdown.ts — a compact Markdown → HTML renderer for notebook text cells.
//
// Covers the common Markdown constructs plus LaTeX math via KaTeX:
//   headings (#..###### , the space after # is optional), bold/italic/
//   strikethrough, inline `code` and fenced ``` blocks, links, images, ordered
//   and unordered lists, blockquotes, horizontal rules, GitHub-style tables,
//   inline math $…$, and display math $$…$$.
//
// Non-math text is HTML-escaped and links/images are restricted to safe URL
// schemes, so the result is safe to inject via {@html}. Math is handed to KaTeX
// as raw LaTeX (extracted before escaping). Sentinels are control characters
// that never occur in the source, so they cannot collide with real content.

import katex from 'katex';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function tex(expr: string, display: boolean): string {
  try {
    return katex.renderToString(expr, { throwOnError: false, displayMode: display });
  } catch {
    return escapeHtml((display ? '$$' : '$') + expr + (display ? '$$' : '$'));
  }
}

const safeUrl = (u: string) => /^(https?:|mailto:|\/|#|\.|data:image\/)/i.test(u);

// Inline formatting on RAW text.
function inline(raw: string): string {
  // 0. protect escaped dollars (\$) so they don't open a math span
  let s = raw.replace(/\\\$/g, '\x02');

  // 1. protect inline code FIRST (before math), so a `$` inside `code` can't be
  //    treated as a math delimiter. Store raw content; escape it at restore.
  const code: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_m, c) => {
    code.push(c);
    return `\x00${code.length - 1}\x00`;
  });

  // 2. inline math $…$ (KaTeX needs the unescaped LaTeX)
  const math: string[] = [];
  s = s.replace(/\$([^$\n]+)\$/g, (_m, e) => {
    math.push(tex(e, false));
    return `\x01${math.length - 1}\x01`;
  });

  // 3. escape everything else (code/math are placeholders, untouched)
  s = escapeHtml(s);

  // 4. images ![alt](url) before links
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, url) =>
    safeUrl(url) ? `<img src="${url}" alt="${alt}">` : escapeHtml(alt));

  // 5. links [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, url) =>
    safeUrl(url) ? `<a href="${url}" target="_blank" rel="noopener">${text}</a>` : text);

  // 6. emphasis
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_])_([^_\s][^_]*)_/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // 7. restore code (escaping its raw content now) then math
  s = s.replace(/\x00(\d+)\x00/g, (_m, i) => `<code>${escapeHtml(code[Number(i)])}</code>`);
  s = s.replace(/\x01(\d+)\x01/g, (_m, i) => math[Number(i)]);
  s = s.replace(/\x02/g, '$');   // restore escaped dollars as literal $
  return s;
}

function isTableSep(line: string): boolean {
  // e.g. | --- | :--: | ---: |
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');
}

function splitRow(line: string): string[] {
  let l = line.trim();
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|')) l = l.slice(0, -1);
  return l.split('|').map(c => c.trim());
}

export function renderMarkdown(src: string): string {
  const lines = (src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  let para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block ```
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      flushPara();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    // display math $$ … $$ (single- or multi-line)
    if (/^\s*\$\$/.test(line)) {
      flushPara();
      let rest = line.replace(/^\s*\$\$/, '');
      const close = rest.indexOf('$$');
      let expr: string;
      if (close >= 0) { expr = rest.slice(0, close); i++; }
      else {
        const parts = [rest]; i++;
        while (i < lines.length && !lines[i].includes('$$')) parts.push(lines[i++]);
        if (i < lines.length) { parts.push(lines[i].slice(0, lines[i].indexOf('$$'))); i++; }
        expr = parts.join('\n');
      }
      out.push(`<div class="md-math-display">${tex(expr.trim(), true)}</div>`);
      continue;
    }

    // blank line ends a paragraph
    if (/^\s*$/.test(line)) { flushPara(); i++; continue; }

    // heading — the space after the #'s is optional ("#1" and "# Title" both work)
    const h = line.match(/^(#{1,6})\s*(.*)$/);
    if (h && h[2].trim() !== '') {
      flushPara();
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2].trim())}</h${level}>`);
      i++; continue;
    }

    // horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara(); out.push('<hr>'); i++; continue;
    }

    // table: a row with pipes followed by a separator row
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara();
      const header = splitRow(line);
      i += 2; // header + separator
      const rowsHtml: string[] = [];
      while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) {
        const cells = splitRow(lines[i]);
        rowsHtml.push('<tr>' + cells.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>');
        i++;
      }
      const head = '<tr>' + header.map(c => `<th>${inline(c)}</th>`).join('') + '</tr>';
      out.push(`<table><thead>${head}</thead><tbody>${rowsHtml.join('')}</tbody></table>`);
      continue;
    }

    // blockquote
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]))
        quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${inline(quote.join('\n')).replace(/\n/g, '<br>')}</blockquote>`);
      continue;
    }

    // lists (consecutive items)
    const ulItem = line.match(/^\s*[-*+]\s+(.*)$/);
    const olItem = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ulItem || olItem) {
      flushPara();
      const ordered = !!olItem;
      const re = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(re);
        if (!m) break;
        items.push(`<li>${inline(m[1])}</li>`);
        i++;
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();
  return out.join('\n');
}
