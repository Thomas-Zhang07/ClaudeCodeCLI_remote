/**
 * A deliberately small renderer.
 *
 * All this needs to do is keep assistant prose readable on a phone: preserve
 * newlines, show fenced code legibly, and distinguish inline code. A real
 * markdown library is a large dependency to ship over a patchy mobile
 * connection for that, and the output here is rendered as Vue text nodes (never
 * `v-html`), so nothing in a transcript can inject markup.
 */

export interface InlineText {
  type: 'text';
  value: string;
}

export interface InlineCode {
  type: 'code';
  value: string;
}

export type Inline = InlineText | InlineCode;

export interface TextBlock {
  type: 'text';
  id: number;
  inline: Inline[];
}

export interface CodeBlock {
  type: 'code';
  id: number;
  lang: string;
  value: string;
}

export type Block = TextBlock | CodeBlock;

const FENCE_OPEN = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;

function closeFenceLine(marker: string): RegExp {
  const char = marker[0] === '`' ? '`' : '~';
  return new RegExp(`^\\s*${char}{${marker.length},}\\s*$`);
}

/** Split a run of prose into plain and `code` spans. */
export function parseInline(text: string): Inline[] {
  const parts: Inline[] = [];
  const pattern = /`([^`\n]+)`/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) parts.push({ type: 'text', value: text.slice(last, match.index) });
    parts.push({ type: 'code', value: match[1] ?? '' });
    last = match.index + match[0].length;
  }

  if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });
  if (parts.length === 0) parts.push({ type: 'text', value: text });
  return parts;
}

export function parseBlocks(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let id = 0;
  let buffer: string[] = [];

  const flushText = (): void => {
    if (buffer.length === 0) return;
    // Trailing blank lines are separators, not content.
    while (buffer.length > 0 && (buffer[buffer.length - 1] ?? '').trim() === '') buffer.pop();
    if (buffer.length === 0) return;
    const joined = buffer.join('\n');
    buffer = [];
    blocks.push({ type: 'text', id: id++, inline: parseInline(joined) });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const open = FENCE_OPEN.exec(line);
    if (!open) {
      buffer.push(line);
      continue;
    }

    flushText();

    const marker = open[1] ?? '```';
    const lang = (open[2] ?? '').trim();
    const closer = closeFenceLine(marker);
    const code: string[] = [];
    i++;

    for (; i < lines.length; i++) {
      const candidate = lines[i] ?? '';
      if (closer.test(candidate)) break;
      code.push(candidate);
    }

    // An unterminated fence means the producer is still streaming; show what we
    // have rather than hiding it.
    blocks.push({ type: 'code', id: id++, lang, value: code.join('\n') });
  }

  flushText();
  return blocks;
}

/** One-line summary for collapsed cards. */
export function firstLine(text: string, max = 120): string {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '') ?? '';
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
