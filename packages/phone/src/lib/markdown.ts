/**
 * A deliberately small renderer.
 *
 * All this needs to do is keep assistant prose readable on a phone: headings,
 * emphasis, lists, quotes, rules, links, fenced code and inline code. A real
 * markdown library is a large dependency to ship over a patchy mobile
 * connection for that, and the output here is rendered as Vue text nodes (never
 * `v-html`), so nothing in a transcript can inject markup.
 *
 * The parsed shape *is* the security boundary. Every construct becomes a plain
 * data node — `text`, `strong`, `em`, `link`, … — that the component turns into
 * elements, and untrusted characters only ever end up in text nodes. The one
 * exception is a link's `href`, which `safeLinkHref` screens before it is
 * allowed into the tree.
 *
 * Predictable beats complete. Anything ambiguous is left as literal text, and
 * no path through this file drops or reorders characters: unrecognised input
 * reads exactly as it arrived.
 */

export interface InlineText {
  type: 'text';
  value: string;
}

export interface InlineCode {
  type: 'code';
  value: string;
}

export interface InlineStrong {
  type: 'strong';
  children: Inline[];
}

export interface InlineEm {
  type: 'em';
  children: Inline[];
}

export interface InlineLink {
  type: 'link';
  href: string;
  children: Inline[];
}

export type Inline = InlineText | InlineCode | InlineStrong | InlineEm | InlineLink;

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

export interface HeadingBlock {
  type: 'heading';
  id: number;
  level: number;
  inline: Inline[];
}

/** A quote's body is parsed as blocks, so quotes nest and can hold lists/code. */
export interface QuoteBlock {
  type: 'quote';
  id: number;
  blocks: Block[];
}

export interface RuleBlock {
  type: 'rule';
  id: number;
}

/** A list item's body is parsed as blocks, which is what gives nesting for free. */
export interface ListItem {
  id: number;
  blocks: Block[];
}

export interface ListBlock {
  type: 'list';
  id: number;
  ordered: boolean;
  start: number;
  items: ListItem[];
}

export type Block = TextBlock | CodeBlock | HeadingBlock | QuoteBlock | RuleBlock | ListBlock;

const FENCE_OPEN = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^[ \t]{0,3}(#{1,6})(?:[ \t]+(.*))?$/;
/** Three or more of the same marker, nothing else on the line. */
const RULE = /^[ \t]{0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const QUOTE = /^[ \t]{0,3}>[ \t]?(.*)$/;
const BULLET = /^([ \t]*)([-*+])([ \t]+)(.*)$/;
const ORDERED_ITEM = /^([ \t]*)(\d{1,9})([.)])([ \t]+)(.*)$/;

/** Ids are unique across a whole message so Vue keys stay stable when nesting. */
interface State {
  nextId: number;
}

function takeId(state: State): number {
  return state.nextId++;
}

function closeFenceLine(marker: string): RegExp {
  const char = marker[0] === '`' ? '`' : '~';
  return new RegExp(`^\\s*${char}{${marker.length},}\\s*$`);
}

function indentWidth(lead: string): number {
  let width = 0;
  for (const char of lead) width += char === '\t' ? 2 : 1;
  return width;
}

/** Drop up to `columns` columns of leading whitespace (a tab counts as two). */
function stripIndent(line: string, columns: number): string {
  let width = 0;
  let index = 0;
  while (index < line.length && width < columns) {
    const char = line[index];
    if (char === ' ') width += 1;
    else if (char === '\t') width += 2;
    else break;
    index += 1;
  }
  return line.slice(index);
}

function stripClosingHashes(text: string): string {
  return text
    .trim()
    .replace(/[ \t]+#+$/, '')
    .trim();
}

/* ------------------------------------------------------------------ inline */

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * The single place untrusted transcript text reaches an attribute.
 *
 * A `href` cannot be rendered as text, so it is the one value that has to be
 * inspected. The URL is parsed and its scheme allow-listed: `javascript:`,
 * `data:` and anything else return `null`, and the caller then renders the
 * whole construct as literal text instead of a link. Control characters are
 * rejected *before* parsing because the URL parser strips tabs and newlines,
 * which would otherwise let `java\nscript:…` slip past a prefix check.
 */
export function safeLinkHref(raw: string): string | null {
  const value = raw.trim();
  if (value === '' || /[\u0000- \u007f]/.test(value)) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // Relative, or not a URL at all — no scheme to inspect, so refuse it.
    return null;
  }

  return SAFE_PROTOCOLS.has(parsed.protocol) ? parsed.href : null;
}

function isSpace(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char);
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[0-9A-Za-z]/.test(char);
}

function matchLink(text: string, start: number): { node: InlineLink; end: number } | null {
  // `![alt](src)` is an image; leave it alone rather than rendering a stray `!`.
  if (text[start - 1] === '!') return null;

  const labelEnd = text.indexOf(']', start + 1);
  if (labelEnd === -1) return null;

  const label = text.slice(start + 1, labelEnd);
  if (label === '' || label.includes('\n')) return null;
  if (text[labelEnd + 1] !== '(') return null;

  const targetEnd = text.indexOf(')', labelEnd + 2);
  if (targetEnd === -1) return null;

  const raw = text.slice(labelEnd + 2, targetEnd);
  // Whitespace, parentheses or angle brackets in the target make the match
  // ambiguous; those are left as plain text.
  if (raw === '' || /[\s()<>]/.test(raw)) return null;

  const href = safeLinkHref(raw);
  if (href === null) return null;

  return { node: { type: 'link', href, children: parseEmphasis(label) }, end: targetEnd + 1 };
}

/**
 * Emphasis at one `*`/`_` run, or `null` to leave the character literal.
 *
 * The rules are the ones that matter on a phone and nothing more: delimiters
 * sit on one line, no space may hug them, `_` must not split a word (`snake_case`
 * is a word), and a lone `*` must not be part of a longer run, which keeps
 * `***x***` — genuinely ambiguous — as plain text.
 */
function matchEmphasis(
  text: string,
  start: number,
): { node: InlineStrong | InlineEm; end: number } | null {
  const char = text[start] ?? '';
  let run = 0;
  while (text[start + run] === char) run += 1;

  if (char === '_' && isWordChar(text[start - 1])) return null;

  const strong = run >= 2;
  const delimiter = strong ? char.repeat(2) : char;
  const inner = start + delimiter.length;

  // An opening delimiter must be followed by something other than space.
  if (isSpace(text[inner])) return null;

  for (let search = inner; search < text.length; ) {
    const found = text.indexOf(delimiter, search);
    if (found === -1) return null;
    search = found + 1;

    const before = text[found - 1];
    const after = text[found + delimiter.length];
    const content = text.slice(inner, found);

    if (content.includes('\n')) return null;
    // No space, and no delimiter run bleeding into the content.
    if (isSpace(content[content.length - 1])) continue;
    if (content[0] === char || content[content.length - 1] === char) continue;
    if (char === '_' && isWordChar(after)) continue;
    if (!strong && (before === char || after === char)) continue;

    const children = parseEmphasis(content);
    return {
      node: strong ? { type: 'strong', children } : { type: 'em', children },
      end: found + delimiter.length,
    };
  }

  return null;
}

function parseEmphasis(text: string): Inline[] {
  const parts: Inline[] = [];
  let literal = '';
  let index = 0;

  const flush = (): void => {
    if (literal !== '') {
      parts.push({ type: 'text', value: literal });
      literal = '';
    }
  };

  while (index < text.length) {
    const char = text[index] ?? '';
    if (char === '[') {
      const link = matchLink(text, index);
      if (link) {
        flush();
        parts.push(link.node);
        index = link.end;
        continue;
      }
    } else if (char === '*' || char === '_') {
      const emphasis = matchEmphasis(text, index);
      if (emphasis) {
        flush();
        parts.push(emphasis.node);
        index = emphasis.end;
        continue;
      }
    }

    literal += char;
    index += 1;
  }

  flush();
  return parts;
}

/**
 * Split a run of prose into plain, `code`, emphasis and link spans.
 *
 * Code is resolved first, over the whole string, and emphasis then runs only on
 * the non-code runs. That is what makes inline code win over everything: a
 * delimiter can never pair up across a code span, and `**` inside backticks
 * stays literal, because no emphasis pass ever sees those characters.
 */
export function parseInline(text: string): Inline[] {
  const parts: Inline[] = [];
  const pattern = /`([^`\n]+)`/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) parts.push(...parseEmphasis(text.slice(last, match.index)));
    parts.push({ type: 'code', value: match[1] ?? '' });
    last = match.index + match[0].length;
  }

  if (last < text.length) parts.push(...parseEmphasis(text.slice(last)));
  if (parts.length === 0) parts.push({ type: 'text', value: text });
  return parts;
}

/* ------------------------------------------------------------------- blocks */

interface ListMarker {
  indent: number;
  ordered: boolean;
  start: number;
  content: string;
  /** Columns the marker and its trailing gap occupy, for de-indenting continuations. */
  width: number;
}

function matchListItem(line: string): ListMarker | null {
  const bullet = BULLET.exec(line);
  if (bullet) {
    const lead = bullet[1] ?? '';
    const marker = bullet[2] ?? '-';
    const gap = bullet[3] ?? ' ';
    return {
      indent: indentWidth(lead),
      ordered: false,
      start: 1,
      content: bullet[4] ?? '',
      width: indentWidth(lead) + marker.length + gap.length,
    };
  }

  const numbered = ORDERED_ITEM.exec(line);
  if (numbered) {
    const lead = numbered[1] ?? '';
    const digits = numbered[2] ?? '1';
    const dot = numbered[3] ?? '.';
    const gap = numbered[4] ?? ' ';
    return {
      indent: indentWidth(lead),
      ordered: true,
      start: Number.parseInt(digits, 10) || 1,
      content: numbered[5] ?? '',
      width: indentWidth(lead) + digits.length + dot.length + gap.length,
    };
  }

  return null;
}

/**
 * Collect one list, starting at the item on line `start`.
 *
 * An item's own lines are gathered, de-indented past its marker and handed back
 * to `parseLines`. Nesting is then just the recursion: a deeper `- ` line
 * arrives at the next level already at indent 0.
 */
function parseList(
  lines: string[],
  start: number,
  first: ListMarker,
  state: State,
): { block: ListBlock; next: number } {
  const items: ListItem[] = [];
  let index = start;

  while (index < lines.length) {
    const marker = matchListItem(lines[index] ?? '');
    if (!marker || marker.indent !== first.indent || marker.ordered !== first.ordered) break;

    const content: string[] = [marker.content];
    index += 1;

    while (index < lines.length) {
      const line = lines[index] ?? '';

      if (line.trim() === '') {
        // A blank line ends the item — unless another item at the same level
        // follows, which just means the producer separated its items.
        let ahead = index;
        while (ahead < lines.length && (lines[ahead] ?? '').trim() === '') ahead += 1;
        const next = matchListItem(lines[ahead] ?? '');
        if (next && next.indent === first.indent && next.ordered === first.ordered) index = ahead;
        break;
      }

      const nested = matchListItem(line);
      // A sibling item, or a shallower one belonging to an outer list, ends this
      // item; anything deeper belongs to it.
      if (nested && nested.indent <= first.indent) break;
      // Prose at this indent ends the list rather than gluing itself to an item.
      if (!nested && indentWidth(line) <= first.indent) break;

      content.push(stripIndent(line, marker.width));
      index += 1;
    }

    items.push({ id: takeId(state), blocks: parseLines(content, state) });
  }

  return {
    block: { type: 'list', id: takeId(state), ordered: first.ordered, start: first.start, items },
    next: index,
  };
}

function parseLines(lines: string[], state: State): Block[] {
  const blocks: Block[] = [];
  let buffer: string[] = [];

  const flushText = (): void => {
    if (buffer.length === 0) return;
    // Trailing blank lines are separators, not content.
    while (buffer.length > 0 && (buffer[buffer.length - 1] ?? '').trim() === '') buffer.pop();
    if (buffer.length === 0) return;
    const joined = buffer.join('\n');
    buffer = [];
    blocks.push({ type: 'text', id: takeId(state), inline: parseInline(joined) });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    const open = FENCE_OPEN.exec(line);
    if (open) {
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

      // An unterminated fence means the producer is still streaming; show what
      // we have rather than hiding it.
      blocks.push({ type: 'code', id: takeId(state), lang, value: code.join('\n') });
      continue;
    }

    // Before lists: `- - -` is a rule, not an item.
    if (RULE.test(line)) {
      flushText();
      blocks.push({ type: 'rule', id: takeId(state) });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushText();
      const marks = heading[1] ?? '#';
      blocks.push({
        type: 'heading',
        id: takeId(state),
        level: marks.length,
        inline: parseInline(stripClosingHashes(heading[2] ?? '')),
      });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      flushText();
      const inner: string[] = [];
      while (i < lines.length) {
        const nested = QUOTE.exec(lines[i] ?? '');
        if (!nested) break;
        inner.push(nested[1] ?? '');
        i++;
      }
      i--; // the loop's own increment steps past the last quoted line
      blocks.push({ type: 'quote', id: takeId(state), blocks: parseLines(inner, state) });
      continue;
    }

    const marker = matchListItem(line);
    if (marker) {
      flushText();
      const list = parseList(lines, i, marker, state);
      blocks.push(list.block);
      i = list.next - 1;
      continue;
    }

    buffer.push(line);
  }

  flushText();
  return blocks;
}

export function parseBlocks(text: string): Block[] {
  return parseLines(text.split('\n'), { nextId: 0 });
}

/** One-line summary for collapsed cards. */
export function firstLine(text: string, max = 120): string {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '') ?? '';
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
