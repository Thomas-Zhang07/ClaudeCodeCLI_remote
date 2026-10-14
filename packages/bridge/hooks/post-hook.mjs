#!/usr/bin/env node
/**
 * Forward one Claude Code hook event to the bridge, and get out of the way.
 *
 * Claude Code runs a command hook with the event's JSON on stdin. This reads it,
 * strips the bulk, and POSTs it to the bridge's receiver on loopback. It is an
 * **observer**: it never writes to stdout, so it can never influence a decision
 * Claude Code is making, and it always exits 0.
 *
 * The exit code is not a detail. `PreToolUse` treats **exit 2** as "block this
 * tool call", so a forwarder that failed loudly would turn a stopped bridge into
 * a machine that cannot run tools. Every path here ends in `process.exit(0)`,
 * including a dead receiver, a malformed payload, and the watchdog below.
 *
 * Written to be driveable by hand:
 *
 *   echo '{"session_id":"x","hook_event_name":"Stop"}' | node post-hook.mjs
 *
 * Configuration comes from the checkout's `.env`, the same file the bridge
 * reads, so the two cannot disagree about the port or the token:
 *
 *   CCR_HOOK_PORT    default 27182, must match DEFAULT_HOOK_PORT in src/config.ts
 *   CCR_HOOK_TOKEN   required by the receiver when it is set
 *
 * `--port`, `--token` and `--env` override it, which is what the installer uses
 * when it is pointed somewhere other than the default.
 */

import { request } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Must match `HOOK_PATH` in src/hooks.ts. */
const HOOK_PATH = '/hook';
/** Must match `DEFAULT_HOOK_PORT` in src/config.ts, and is asserted by a test. */
const DEFAULT_PORT = 27182;

/** Total time this process may live, whatever happens. */
const WATCHDOG_MS = 1_200;
/** How long to wait on the receiver itself — it answers from memory in microseconds. */
const REQUEST_TIMEOUT_MS = 700;
/** Room for a large-but-sane payload; the receiver rejects anything larger. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const argv = process.argv.slice(2);

function option(name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : (argv[index + 1] ?? null);
}

/** `<checkout>/packages/bridge/hooks/post-hook.mjs` → `<checkout>`. */
const CHECKOUT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Load the same `.env` the bridge loads.
 *
 * The platform's own loader rather than a hand-rolled parser: Node already has
 * one, and `bootstrapConfig` uses it for exactly this file.
 */
function loadEnv(path) {
  try {
    process.loadEnvFile(path);
  } catch {
    // Missing or malformed is normal — the defaults below still work.
  }
}

function settings() {
  const envPath = option('--env') ?? join(CHECKOUT_ROOT, '.env');
  loadEnv(resolve(envPath));

  const port = Number.parseInt(option('--port') ?? process.env.CCR_HOOK_PORT ?? '', 10);
  return {
    port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT,
    token: option('--token') ?? process.env.CCR_HOOK_TOKEN ?? null,
  };
}

/**
 * Read stdin, or null when there is nothing on it.
 *
 * A terminal here means somebody ran this by hand to see what it does; blocking
 * on a read that will never come would look like a hang.
 */
async function readStdin() {
  if (process.stdin.isTTY) return null;

  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    // Everything past the cap is dropped rather than buffered: the only fields
    // we need are small, and a runaway payload must not become a memory spike.
    if (size > MAX_BODY_BYTES) break;
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Drop the fields that are large and that the bridge does not read.
 *
 * `tool_input` carries whole file contents for a `Write`, and `tool_response`
 * carries whatever the tool printed. Neither is needed to know *that* a tool is
 * running — which is the entire question being answered here.
 */
function slim(raw) {
  const payload = JSON.parse(raw);
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;

  delete payload.tool_input;
  delete payload.tool_response;
  return JSON.stringify(payload);
}

/** POST the payload, resolving either way — the outcome changes nothing here. */
function send(port, token, body) {
  return new Promise((resolveSend) => {
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
    if (token) headers['x-ccr-token'] = token;

    const req = request(
      { host: '127.0.0.1', port, path: HOOK_PATH, method: 'POST', headers, timeout: REQUEST_TIMEOUT_MS },
      (res) => {
        res.resume();
        res.on('end', () => resolveSend());
      },
    );

    req.on('error', () => resolveSend());
    req.on('timeout', () => {
      req.destroy();
      resolveSend();
    });
    req.end(body);
  });
}

// Whatever happens below, the hook is over at this point. A large payload read
// or a receiver that accepted the connection and went silent must not hold a
// tool call open any longer than this.
const watchdog = setTimeout(() => process.exit(0), WATCHDOG_MS);

try {
  const raw = await readStdin();
  if (raw && raw.trim().length > 0) {
    const body = slim(raw);
    if (body !== null) {
      const { port, token } = settings();
      await send(port, token, body);
    }
  }
} catch {
  // A hook event that cannot be forwarded is one the bridge will not know about.
  // The guard treats that as "hooks said nothing" and falls back to the
  // transcript, which is the safe direction — so this is not worth a message.
}

clearTimeout(watchdog);
process.exit(0);
