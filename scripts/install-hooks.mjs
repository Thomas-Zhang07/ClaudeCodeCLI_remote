#!/usr/bin/env node
/**
 * Install the Claude Code hooks that feed the bridge's hook receiver (M7).
 *
 * The bridge can only refuse to type into a session while a permission dialog is
 * open if it is told when one is. Hooks are that telling. This script writes
 * them, and nothing else:
 *
 *   node scripts/install-hooks.mjs                # prints what it would write
 *   node scripts/install-hooks.mjs --write        # applies it, after backing up
 *
 * **It changes nothing without `--write`.** That is not politeness: the target
 * is a live settings file which running sessions read, and the other target is
 * the `.env` holding real credentials.
 *
 * Two properties the written hooks must keep:
 *
 *  - **They are observers, never gates.** Each one is a short-lived `node`
 *    process that POSTs to loopback and exits 0. Exit 2 on `PreToolUse` *blocks
 *    the tool call*, so a broken observer must not be able to stop work on the
 *    machine — see `packages/bridge/hooks/post-hook.mjs`.
 *  - **They are idempotent.** Entries are recognised by the forwarder's filename
 *    and replaced in place, so running this twice leaves one entry per event,
 *    not two. Hooks from other tools in the same settings file are untouched.
 *
 * Nothing secret goes into the settings file. `CCR_HOOK_TOKEN` is written to the
 * checkout's `.env` (gitignored), never to `.claude/settings.json` — which for a
 * project-scoped install is a file people commit.
 */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Identifies our entries, so a second run replaces rather than duplicates. */
export const MARKER = 'post-hook.mjs';

/**
 * Default receiver port.
 *
 * Must match `DEFAULT_HOOK_PORT` in `packages/bridge/src/config.ts`; a test in
 * the bridge asserts the two have not drifted. Nothing written into the settings
 * file depends on it — the forwarder reads the port from `.env`, where this is
 * recorded — so the two sides cannot disagree about it later either.
 */
export const DEFAULT_HOOK_PORT = 27182;

/**
 * Seconds. Claude Code honours `timeout` for command hooks, and a *timed-out*
 * hook does not block the tool call — so even a pathological forwarder cannot
 * hold up a tool. The forwarder itself gives up after 1.2s regardless.
 */
export const HOOK_TIMEOUT_SECONDS = 5;

/**
 * The events the bridge's guard needs.
 *
 * Deliberately not "all events": each one is a process spawn, and these are the
 * ones that answer a question the guard actually asks.
 *
 *  - tool events → is a call in flight (and therefore a dialog blocking it)
 *  - `Notification` → a permission dialog is on screen now
 *  - `Stop` → the turn ended, so nothing is blocking anything
 *  - `SubagentStop`/`SessionStart`/`SessionEnd` → context for the above, and
 *    `SessionEnd` is what stops a session killed mid-tool from looking busy
 *    forever.
 *
 * No `matcher` is written for any of them: an omitted matcher matches
 * everything, which is what we want, and it avoids depending on regex behaviour
 * per event.
 */
export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Stop',
  'SubagentStop',
  'SessionStart',
  'SessionEnd',
];

/** Where this checkout is: `<root>/scripts/install-hooks.mjs` → `<root>`. */
const CHECKOUT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function defaultForwarderPath() {
  return join(CHECKOUT_ROOT, 'packages', 'bridge', 'hooks', 'post-hook.mjs');
}

// ---------------------------------------------------------------------------
// Pure planning — no I/O, so it can be tested directly
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The shell command a hook runs.
 *
 * Forward slashes on every platform: the string is passed to a shell (`sh -c`
 * on macOS/Linux, Git Bash on Windows), where a backslash is an escape
 * character. Quoted because a checkout path may contain a space.
 */
export function hookCommand(forwarderPath, envPath = null) {
  const parts = [`node "${forwarderPath.replace(/\\/g, '/')}"`];
  // Only when the environment file is somewhere other than the checkout's own,
  // which is where the forwarder looks by default.
  if (envPath) parts.push(`--env "${envPath.replace(/\\/g, '/')}"`);
  return parts.join(' ');
}

function isOurs(entry) {
  return isPlainObject(entry) && typeof entry.command === 'string' && entry.command.includes(MARKER);
}

/**
 * Add our hook to every event, replacing any entry of ours already there.
 *
 * Existing entries are preserved — including other hooks on the same event, and
 * any matcher group they live in — and a group left empty by removing ours is
 * dropped rather than left behind.
 *
 * @returns `{ settings, replaced }`; `replaced` is the count of our own entries
 *   removed, which is what makes a second run a no-op rather than a duplicate.
 */
export function mergeHookSettings(existing, command, events = HOOK_EVENTS) {
  if (existing !== undefined && existing !== null && !isPlainObject(existing)) {
    throw new Error('settings.json is not a JSON object; refusing to rewrite it');
  }

  const settings = { ...(existing ?? {}) };
  const existingHooks = settings['hooks'];
  if (existingHooks !== undefined && existingHooks !== null && !isPlainObject(existingHooks)) {
    throw new Error('settings.json has a "hooks" key that is not an object; refusing to rewrite it');
  }

  const hooks = { ...(existingHooks ?? {}) };
  let replaced = 0;

  for (const event of events) {
    const groups = hooks[event];
    if (groups !== undefined && groups !== null && !Array.isArray(groups)) {
      throw new Error(`settings.json has a "hooks.${event}" that is not an array; refusing to rewrite it`);
    }

    const kept = [];
    for (const group of groups ?? []) {
      // A group we do not recognise is left exactly as it was: only entries
      // carrying our marker are ours to remove.
      if (!isPlainObject(group) || !Array.isArray(group['hooks'])) {
        kept.push(group);
        continue;
      }
      const others = group['hooks'].filter((entry) => {
        if (!isOurs(entry)) return true;
        replaced++;
        return false;
      });
      if (others.length > 0) kept.push({ ...group, hooks: others });
    }

    kept.push({ hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS }] });
    hooks[event] = kept;
  }

  settings['hooks'] = hooks;
  return { settings, replaced };
}

/** The value of a `KEY=value` line, or null when it is absent or empty. */
export function readEnvValue(text, key) {
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  for (const line of text.split(/\r?\n/)) {
    if (!pattern.test(line)) continue;
    const value = line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
    if (value.length > 0) return value;
  }
  return null;
}

/**
 * Add keys to a `.env` without disturbing what is already in it.
 *
 * A key that is present and non-empty is left alone, and its value is returned
 * in `values` — regenerating the token would lock out a bridge that is already
 * running, and overwriting a port someone chose deliberately would move the
 * receiver out from under hooks that are already installed.
 *
 * @returns `{ text, added, values }` — `added` names the keys actually written.
 */
export function upsertEnv(text, desired) {
  const lines = text.split(/\r?\n/);
  // A file ending in a newline splits to a final empty element; drop it so
  // appended keys land on their own line instead of after a blank one.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const added = [];
  const values = {};

  for (const [key, value] of Object.entries(desired)) {
    const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
    const index = lines.findIndex((line) => pattern.test(line));

    if (index === -1) {
      lines.push(`${key}=${value}`);
      added.push(key);
      values[key] = value;
      continue;
    }

    const current = readEnvValue(lines[index], key);
    if (current === null) {
      lines[index] = `${key}=${value}`;
      added.push(key);
      values[key] = value;
    } else {
      values[key] = current;
    }
  }

  return { text: lines.length > 0 ? `${lines.join('\n')}\n` : '', added, values };
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

const USAGE = `Install the Claude Code hooks that feed the bridge's hook receiver.

Usage:
  node scripts/install-hooks.mjs [options]

Options:
  --write                Apply the change. Without it, nothing is written.
  --scope project|user   Where to install. Default: project.
  --project <dir>        The project for project scope. Default: the working directory.
  --settings <path>      An explicit settings.json; overrides --scope and --project.
  --env <path>           Where CCR_HOOK_PORT / CCR_HOOK_TOKEN live.
                         Default: the checkout's .env.
  --port <n>             Receiver port to record. Default: ${DEFAULT_HOOK_PORT}.
  --forwarder <path>     The hook script to point at.
  -h, --help             This text.

Defaults to project scope on purpose: user-level settings affect every session
on the machine, and changing that without being asked is not this script's call.
`;

export function parseArgs(argv, cwd = process.cwd()) {
  const options = {
    write: false,
    scope: 'project',
    project: cwd,
    settingsPath: null,
    envPath: join(CHECKOUT_ROOT, '.env'),
    port: DEFAULT_HOOK_PORT,
    forwarderPath: defaultForwarderPath(),
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };

    switch (arg) {
      case '--write':
        options.write = true;
        break;
      case '--scope': {
        const scope = next();
        if (scope !== 'project' && scope !== 'user') {
          throw new Error(`--scope must be "project" or "user", not "${scope}"`);
        }
        options.scope = scope;
        break;
      }
      case '--project':
        options.project = resolve(next());
        break;
      case '--settings':
        options.settingsPath = resolve(next());
        break;
      case '--env':
        options.envPath = resolve(next());
        break;
      case '--port': {
        const port = Number.parseInt(next(), 10);
        if (!Number.isFinite(port) || port <= 0 || port > 65_535) {
          throw new Error('--port must be a port number');
        }
        options.port = port;
        break;
      }
      case '--forwarder':
        options.forwarderPath = resolve(next());
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  if (options.settingsPath === null) {
    options.settingsPath =
      options.scope === 'user'
        ? join(homedir(), '.claude', 'settings.json')
        : join(options.project, '.claude', 'settings.json');
  }

  return options;
}

async function readTextOrNull(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Copy a file aside and return where, or null when it did not exist. */
async function backup(path) {
  if (!existsSync(path)) return null;
  const target = `${path}.bak-${stamp()}`;
  await copyFile(path, target);
  return target;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  // Checked before anything is planned: an install pointing at a forwarder that
  // does not exist would fail silently, one hook process at a time, forever.
  if (!existsSync(options.forwarderPath)) {
    process.stderr.write(
      `install-hooks: no forwarder at ${options.forwarderPath}\n` +
        '  Pass --forwarder <path> if this checkout lives somewhere unusual.\n',
    );
    return 1;
  }

  const existingSettingsText = await readTextOrNull(options.settingsPath);
  let parsedSettings = {};
  if (existingSettingsText !== null && existingSettingsText.trim().length > 0) {
    try {
      parsedSettings = JSON.parse(existingSettingsText);
    } catch (error) {
      // Never guess at a file we could not read: a half-understood settings file
      // is a machine that does not start.
      process.stderr.write(`install-hooks: ${options.settingsPath} is not valid JSON (${error.message})\n`);
      return 1;
    }
  }

  // The command embeds --env only when it is not the default, so the common case
  // stays a constant string and a second run is byte-identical.
  const defaultEnvPath = join(CHECKOUT_ROOT, '.env');
  const envIsDefault = resolve(options.envPath) === resolve(defaultEnvPath);
  const command = hookCommand(options.forwarderPath, envIsDefault ? null : options.envPath);

  const { settings, replaced } = mergeHookSettings(parsedSettings, command);
  const settingsText = `${JSON.stringify(settings, null, 2)}\n`;

  const existingEnvText = (await readTextOrNull(options.envPath)) ?? '';
  const existingToken = readEnvValue(existingEnvText, 'CCR_HOOK_TOKEN');
  const env = upsertEnv(existingEnvText, {
    CCR_HOOK_PORT: String(options.port),
    CCR_HOOK_TOKEN: existingToken ?? randomBytes(32).toString('hex'),
  });

  const settingsChanged = settingsText !== existingSettingsText;
  const envChanged = env.text !== existingEnvText;
  const where =
    options.scope === 'user' ? 'user scope — every session' : `project scope — sessions in ${options.project}`;

  const out = [];
  out.push(`ccr hook installer — ${options.write ? 'writing' : 'dry run, nothing written'}`);
  out.push('');
  out.push(`  settings   ${options.settingsPath}`);
  out.push(`             ${where}`);
  out.push(`  env        ${options.envPath}`);
  out.push(`  forwarder  ${options.forwarderPath}`);
  out.push(`  receiver   http://127.0.0.1:${env.values['CCR_HOOK_PORT']}/hook`);
  out.push(`  token      ${existingToken ? 'kept from .env' : 'generated, written to .env'}`);
  out.push('');
  out.push(`${HOOK_EVENTS.length} events, one command each:`);
  out.push(`  ${command}`);
  out.push('');
  out.push(`--- ${options.settingsPath} ---`);
  out.push(settingsText.trimEnd());
  out.push('');
  out.push(`--- ${options.envPath} ---`);
  out.push(env.added.length > 0 ? env.added.map((key) => `${key}=…`).join('\n') : '(already configured)');
  out.push('');
  process.stdout.write(`${out.join('\n')}\n`);

  if (!settingsChanged && !envChanged) {
    process.stdout.write('Nothing to change: this is already installed.\n');
    return 0;
  }

  if (!options.write) {
    process.stdout.write(
      'Nothing was written. Re-run with --write to apply.\n' +
        `  ${replaced > 0 ? `Replaces ${replaced} existing entr${replaced === 1 ? 'y' : 'ies'} of ours.\n  ` : ''}` +
        `Hooks are observers: each one exits immediately and cannot block a tool call.\n` +
        `The token goes to .env (gitignored), never into the settings file.\n`,
    );
    return 0;
  }

  const settingsBackup = settingsChanged ? await backup(options.settingsPath) : null;
  if (settingsChanged) {
    await mkdir(dirname(options.settingsPath), { recursive: true });
    await writeFile(options.settingsPath, settingsText);
  }

  const envBackup = envChanged ? await backup(options.envPath) : null;
  if (envChanged) {
    await writeFile(options.envPath, env.text);
  }

  process.stdout.write(`Wrote ${options.settingsPath}\n`);
  if (settingsBackup) process.stdout.write(`  backup: ${settingsBackup}\n`);
  if (envChanged) process.stdout.write(`Wrote ${options.envPath}\n`);
  if (envBackup) process.stdout.write(`  backup: ${envBackup}\n`);
  process.stdout.write(
    '\nNext:\n' +
      '  1. Start the bridge (npm run bridge). It logs "[hooks] listening on ...".\n' +
      '  2. A session already running normally picks the hooks up within a few\n' +
      '     seconds; restart it if they do not appear in /hooks.\n' +
      "  3. Until hooks arrive, the guard falls back to the transcript rule —\n" +
      '     nothing is less safe without them, only less certain.\n',
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`install-hooks: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
