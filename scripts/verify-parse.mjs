/**
 * Run the parser over real transcripts and report what it produces.
 *
 * Synthetic fixtures prove the parsing rules; only real session data proves the
 * schema assumptions behind them. This is the check to re-run whenever the CLI
 * is updated, since a new entry shape shows up here first.
 *
 * Prints aggregate statistics only — never transcript content.
 *
 *   node scripts/verify-parse.mjs [limit]
 */

import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

import {
  LineFramer,
  MAX_EVENT_BYTES,
  parseTranscriptEntry,
  serializedSize,
} from '@ccr/shared';

const PROJECTS = join(homedir(), '.claude', 'projects');
const limit = Number.parseInt(process.argv[2] ?? '0', 10);

const counts = new Map();
const agentCounts = new Map();
const stateKeys = new Map();
const skipped = new Map();

let files = 0;
let bytes = 0;
let lines = 0;
let events = 0;
let maxEvent = 0;
let oversize = 0;
let droppedLines = 0;

async function collect(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collect(full)));
    // Only main transcripts; subagent files live in a session subdirectory.
    else if (entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

const all = (await collect(PROJECTS)).filter((f) => !f.includes('subagents'));
const targets = limit > 0 ? all.slice(0, limit) : all;

for (const file of targets) {
  files++;
  // A sessionId is normally the filename stem; the value only has to be
  // consistent for this aggregate check.
  const sessionId = file.split(/[\\/]/).pop().replace(/\.jsonl$/, '');
  const framer = new LineFramer();

  const stream = createReadStream(file, { highWaterMark: 1 << 16 });
  for await (const chunk of stream) {
    bytes += chunk.length;
    for (const line of framer.push(chunk)) {
      lines++;
      const result = parseTranscriptEntry(line, { sessionId, agentId: null });

      if (result.skipped) {
        bump(skipped, result.skipped);
        continue;
      }
      for (const event of result.events) {
        events++;
        bump(counts, event.kind);
        const size = serializedSize(event);
        if (size > maxEvent) maxEvent = size;
        if (size > MAX_EVENT_BYTES) oversize++;
      }
      for (const key of Object.keys(result.state)) bump(stateKeys, key);
      for (const signal of result.agents) bump(agentCounts, signal.kind);
    }
  }
  droppedLines += framer.stats.droppedLines;
}

const mb = (n) => (n / 1024 / 1024).toFixed(1);
const table = (map) =>
  [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `  ${String(k).padEnd(22)} ${v.toLocaleString()}`)
    .join('\n');

console.log(`files              ${files}  (${mb(bytes)} MB)`);
console.log(`lines framed       ${lines.toLocaleString()}`);
console.log(`events emitted     ${events.toLocaleString()}`);
console.log(`dropped lines      ${droppedLines}`);
console.log(`largest event      ${maxEvent.toLocaleString()} bytes`);
console.log(`over MAX_EVENT     ${oversize}${oversize > 0 ? '   <-- FAIL' : '   (ok)'}`);

console.log('\nevents by kind');
console.log(table(counts) || '  (none)');

console.log('\nagent signals');
console.log(table(agentCounts) || '  (none)');

console.log('\nstate fields touched');
console.log(table(stateKeys) || '  (none)');

if (skipped.size > 0) {
  console.log('\nskipped');
  console.log(table(skipped));
}

process.exit(oversize > 0 ? 1 : 0);
