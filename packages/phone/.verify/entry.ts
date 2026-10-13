/* Throwaway verification harness — deleted after it runs. */
import assert from 'node:assert/strict';

import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';

import MarkdownText from '../src/components/MarkdownText.vue';
import { parseBlocks, parseInline, safeLinkHref } from '../src/lib/markdown';
import type { Block, Inline } from '../src/lib/markdown';

let checks = 0;
function ok(label: string, condition: boolean): void {
  checks += 1;
  assert.ok(condition, label);
}

function flatInline(nodes: Inline[]): string {
  return nodes
    .map((node) => ('value' in node ? node.value : flatInline(node.children)))
    .join('');
}

function flatBlocks(blocks: Block[]): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case 'text':
        case 'heading':
          return flatInline(block.inline);
        case 'code':
          return block.value;
        case 'quote':
          return flatBlocks(block.blocks);
        case 'list':
          return block.items.map((item) => flatBlocks(item.blocks)).join('\n');
        case 'rule':
          return '';
      }
    })
    .join('\n');
}

function types(blocks: Block[]): string[] {
  return blocks.map((block) => block.type);
}

/* ------------------------------------------------------------- inline */

{
  const bold = parseInline('**bold**');
  ok('bold', bold.length === 1 && bold[0]!.type === 'strong' && flatInline(bold) === 'bold');

  const underscoreBold = parseInline('__bold__');
  ok('__ bold', underscoreBold[0]!.type === 'strong');

  const em = parseInline('*em*');
  ok('em', em.length === 1 && em[0]!.type === 'em' && flatInline(em) === 'em');

  const underscoreEm = parseInline('_em_');
  ok('_ em', underscoreEm[0]!.type === 'em');

  const nested = parseInline('**bold with *em* inside**');
  ok(
    'nested',
    nested[0]!.type === 'strong' &&
      flatInline(nested) === 'bold with em inside' &&
      JSON.stringify(nested).includes('"em"'),
  );

  // Inline code wins over everything.
  const codeFirst = parseInline('`**not bold**`');
  ok(
    'code wins',
    codeFirst.length === 1 && codeFirst[0]!.type === 'code' && codeFirst[0]!.value === '**not bold**',
  );

  // Emphasis must not match across a code span.
  const across = parseInline('**a `x** y` b');
  ok(
    'no match across a code span',
    flatInline(across) === '**a x** y b' && across.every((node) => node.type !== 'strong'),
  );

  const straddling = parseInline('**a `b` c**');
  ok(
    'strong around a code span',
    straddling[0]!.type === 'strong' &&
      (straddling[0] as { children: Inline[] }).children.some((n) => n.type === 'code'),
  );

  // Ambiguity is left exactly as written.
  for (const literal of [
    '2 * 3 * 4',
    'snake_case_name',
    'a * b',
    'unclosed **bold',
    '**a `b** c`',
    'a** b **c',
    '5 - 3 + 1',
    '# not a heading here',
  ]) {
    ok(`literal: ${literal}`, flatInline(parseInline(literal)) === literal);
  }

  // Nothing is lost or reordered by an unrecognised construct.
  for (const source of ['***x***', '*a * and *b*', 'x_y_z', '@@ a **b', '`a` **b` c']) {
    const nodes = parseInline(source);
    const kept = flatInline(nodes).replace(/[*_`]/g, '');
    ok(`lossless: ${source}`, kept === source.replace(/[*_`]/g, ''));
  }
}

/* ------------------------------------------------------------- links */

{
  ok('https', safeLinkHref('https://example.com') === 'https://example.com/');
  ok('http', safeLinkHref('http://example.com/x?y=1') !== null);
  ok('mailto', safeLinkHref('mailto:someone@example.com') !== null);
  ok('javascript rejected', safeLinkHref('javascript:alert(1)') === null);
  ok('mixed-case javascript rejected', safeLinkHref('JaVaScRiPt:alert(1)') === null);
  ok('newline-smuggled javascript rejected', safeLinkHref('java\nscript:alert(1)') === null);
  ok('tab-smuggled javascript rejected', safeLinkHref('java\tscript:alert(1)') === null);
  ok('data rejected', safeLinkHref('data:text/html,<script>alert(1)</script>') === null);
  ok('vbscript rejected', safeLinkHref('vbscript:msgbox(1)') === null);
  ok('relative rejected', safeLinkHref('/etc/passwd') === null);
  ok('empty rejected', safeLinkHref('') === null);

  const link = parseInline('[docs](https://example.com/a)');
  ok('link node', link.length === 1 && link[0]!.type === 'link' && flatInline(link) === 'docs');

  const bad = parseInline('[click](javascript:alert(1))');
  ok(
    'javascript link stays plain text',
    flatInline(bad) === '[click](javascript:alert(1))' && bad.every((n) => n.type !== 'link'),
  );

  const image = parseInline('![alt](https://example.com/i.png)');
  ok('image stays plain text', image.every((n) => n.type !== 'link'));
}

/* ------------------------------------------------------------ blocks */

{
  const headings = parseBlocks('# One\n\n## Two\n\n### Three\n\n#### Four\n\n###### Six');
  ok('heading levels', JSON.stringify(headings.map((b) => (b.type === 'heading' ? b.level : null))) === '[1,2,3,4,6]');
  ok('heading text', flatBlocks(headings).split('\n')[0] === 'One');

  ok('rules', types(parseBlocks('a\n\n---\n\n***\n\n- - -\n\nb')).join(',') === 'text,rule,rule,rule,text');
  ok('two dashes is not a rule', !types(parseBlocks('--')).includes('rule'));

  const bullets = parseBlocks('- one\n- two\n- three');
  ok(
    'bullet list',
    bullets.length === 1 && bullets[0]!.type === 'list' && bullets[0]!.items.length === 3,
  );

  const ordered = parseBlocks('1. one\n2. two\n3. three');
  ok(
    'ordered list',
    ordered[0]!.type === 'list' &&
      (ordered[0] as { ordered: boolean; start: number }).ordered &&
      (ordered[0] as { items: unknown[] }).items.length === 3,
  );
  ok(
    'ordered start',
    (parseBlocks('3. c\n4. d')[0] as { start: number }).start === 3,
  );

  const nested = parseBlocks('- a\n  - a1\n  - a2\n- b');
  const outer = nested[0] as { items: { blocks: Block[] }[] };
  ok('nested list', nested.length === 1 && outer.items.length === 2);
  const inner = outer.items[0]!.blocks.find((b) => b.type === 'list');
  ok('nested depth', inner !== undefined && (inner as { items: unknown[] }).items.length === 2);

  const loose = parseBlocks('- a\n\n- b');
  ok('blank lines between items keep one list', loose.length === 1 && (loose[0] as { items: unknown[] }).items.length === 2);

  const quote = parseBlocks('> quoted\n> more');
  ok('quote', quote.length === 1 && quote[0]!.type === 'quote' && flatBlocks(quote) === 'quoted\nmore');

  const quoteList = parseBlocks('> - a\n> - b');
  ok('list in quote', (quoteList[0] as { blocks: Block[] }).blocks[0]!.type === 'list');

  const fences = parseBlocks('```ts\nconst a = 1;\n```');
  ok(
    'fence kept',
    fences.length === 1 &&
      fences[0]!.type === 'code' &&
      (fences[0] as { lang: string }).lang === 'ts' &&
      (fences[0] as { value: string }).value === 'const a = 1;',
  );

  ok('markup inside a fence is literal', flatBlocks(parseBlocks('```\n# **not** a heading\n```')) === '# **not** a heading');
  ok('unterminated fence still shows', flatBlocks(parseBlocks('```\nstreaming')) === 'streaming');

  const mixed = parseBlocks('# Title\n\nSome **bold** prose.\n\n- a\n- b\n\n> quote\n\n```\nx\n```\n\n---');
  ok(
    'mixed document',
    types(mixed).join(',') === 'heading,text,list,quote,code,rule',
  );
}

/* ------------------------------------------------------ hostile input */

const HOSTILE = [
  '**<script>alert(1)</script>**',
  '',
  '# <img src=x onerror=alert(1)>',
  '',
  '[click](javascript:alert(1)) and [newline](java\nscript:alert(1))',
  '',
  '- <svg onload=alert(1)>',
  '- <iframe src="javascript:alert(1)"></iframe>',
  '',
  '> <style>*{}</style>',
  '',
  '1. </script><script>alert(2)</script>',
  '',
  '[good](https://example.com/ok)',
  '',
  '`</code><script>alert(3)</script>`',
].join('\n');

const html = await renderToString(createSSRApp(MarkdownText, { text: HOSTILE }));

ok('no script element', !/<script[\s>]/i.test(html));
ok('no img element', !/<img[\s>]/i.test(html));
ok('no svg element', !/<svg[\s>]/i.test(html));
ok('no iframe element', !/<iframe[\s>]/i.test(html));
ok('no style element', !/<style[\s>]/i.test(html));
ok('no inline event handler', !/\son[a-z]+\s*=/i.test(html));
ok('angle brackets are escaped', html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));

// Every href that reaches the output must be one of the allowed schemes.
const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? '');
ok('exactly one link rendered', hrefs.length === 1);
for (const href of hrefs) {
  ok(`href scheme: ${href}`, /^(https:|http:|mailto:)/.test(href));
}
ok('link target/rel', html.includes('target="_blank"') && html.includes('rel="noopener noreferrer"'));
ok(
  'rejected url is visible as text',
  html.includes('javascript:alert(1)') && !/href="[^"]*javascript:/i.test(html),
);
ok(
  'attribute injection cannot escape href',
  !/href="[^"]*"[^>]*\son/i.test(html) && html.includes('[click](javascript:alert(1))'),
);

// The parser can only ever hand the component node types it renders.
{
  const allowedInline = new Set(['text', 'code', 'strong', 'em', 'link']);
  const allowedBlock = new Set(['text', 'code', 'heading', 'quote', 'rule', 'list']);
  const walk = (blocks: Block[]): void => {
    for (const block of blocks) {
      ok(`block type: ${block.type}`, allowedBlock.has(block.type));
      if (block.type === 'text' || block.type === 'heading') walkInline(block.inline);
      if (block.type === 'quote') walk(block.blocks);
      if (block.type === 'list') for (const item of block.items) walk(item.blocks);
    }
  };
  const walkInline = (nodes: Inline[]): void => {
    for (const node of nodes) {
      ok(`inline type: ${node.type}`, allowedInline.has(node.type));
      if (node.type === 'text' || node.type === 'code') ok('value is a string', typeof node.value === 'string');
      else walkInline(node.children);
    }
  };
  walk(parseBlocks(HOSTILE));
}

/* ------------------------------------------ structure renders as expected */

const markup = await renderToString(
  createSSRApp(MarkdownText, { text: '# Head\n\n- a\n  - a1\n\n1. b\n\n> q\n\n---\n\n[l](https://x.test)' }),
);
ok('renders h1', markup.includes('<h1 class="heading"'));
ok('renders ul/li', markup.includes('<ul class="list"') && markup.includes('<li'));
ok('renders ol', markup.includes('<ol class="list"'));
ok('renders blockquote/hr', markup.includes('<blockquote') && markup.includes('<hr'));
ok('renders anchor', /<a class="link" href="https:\/\/x\.test\/"/.test(markup));
ok('bold renders as element', (await renderToString(createSSRApp(MarkdownText, { text: '**b**' }))).includes('<strong>b</strong>'));
ok('em renders as element', (await renderToString(createSSRApp(MarkdownText, { text: '*i*' }))).includes('<em>i</em>'));

console.log(`all ${checks} checks passed`);
console.log('--- sample output ---');
console.log(html);
