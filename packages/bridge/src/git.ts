/**
 * Git plumbing for the relay repository.
 *
 * Two hazards drive most of what is here:
 *
 *  - **The environment proxy.** On this machine `HTTP_PROXY`/`HTTPS_PROXY` point
 *    at a local proxy client and `NO_PROXY` does not list `gitee.com`. Git honours
 *    those variables, so every relay operation would be routed overseas —
 *    defeating the entire reason Gitee was chosen over GitHub. The child
 *    environment strips them.
 *  - **Non-fast-forward races.** The phone commits to the same branch through
 *    the API while the bridge is pushing. Every publish therefore fetches and
 *    fast-forwards first, and retries with jitter when it loses the race.
 */

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  cwd: string;
  /**
   * Talk to the remote without a proxy. Always true for the relay repo: the
   * whole point of using Gitee is the direct domestic path.
   */
  bypassProxy?: boolean;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const PROXY_VARS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
];

/**
 * Build the environment for a git child process.
 *
 * When bypassing, proxy variables are removed rather than set to empty: an empty
 * `HTTPS_PROXY` still counts as configured for some clients, whereas an absent
 * one does not.
 */
export function gitEnv(options: { bypassProxy?: boolean; base?: NodeJS.ProcessEnv } = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(options.base ?? process.env) };

  if (options.bypassProxy) {
    for (const key of PROXY_VARS) delete env[key];
    // Belt and braces, in case something re-reads a system-level setting.
    env['NO_PROXY'] = '*';
    env['no_proxy'] = '*';
  }

  // Never let git block on an interactive credential prompt; the bridge has no
  // terminal to answer one.
  env['GIT_TERMINAL_PROMPT'] = '0';
  env['GCM_INTERACTIVE'] = 'never';

  return env;
}

/** Run git and capture its output. Never throws on a non-zero exit. */
export function git(args: readonly string[], options: GitOptions): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd: options.cwd,
      env: options.env ?? gitEnv({ bypassProxy: options.bypassProxy ?? true }),
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));

    const timer =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            child.kill();
          }, options.timeoutMs);

    child.on('error', reject);
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Run git and throw when it fails, with the command's stderr in the message. */
export async function gitOrThrow(
  args: readonly string[],
  options: GitOptions,
): Promise<GitResult> {
  const result = await git(args, options);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.code}): ${result.stderr.trim()}`);
  }
  return result;
}

/**
 * Build an authenticated URL.
 *
 * The token is embedded rather than stored in the clone's config so it does not
 * persist on disk. It is briefly visible in the process table, which is an
 * acceptable trade for a single-user machine but worth knowing.
 */
export function authenticatedUrl(repoUrl: string, token: string | null): string {
  if (!token) return repoUrl;
  try {
    const url = new URL(repoUrl);
    url.username = 'oauth2';
    url.password = token;
    return url.toString();
  } catch {
    return repoUrl;
  }
}

/**
 * Prepare a local clone of the relay repository.
 *
 * A missing or unusable clone is rebuilt rather than patched up: it holds only
 * derived data, and a half-broken working tree is worse than a fresh one.
 */
export async function ensureClone(options: {
  repoUrl: string;
  token: string | null;
  dir: string;
  branch: string;
}): Promise<void> {
  const { dir, branch, repoUrl, token } = options;
  await mkdir(dir, { recursive: true });

  // `rev-parse` alone is not enough: git searches parent directories, so a
  // clone placed inside another repository reports success and reports *that*
  // repository's git dir. The bridge would then skip init and commit into the
  // enclosing project instead of the relay. Ask for the repo root and require
  // it to be this directory.
  const top = await git(['rev-parse', '--show-toplevel'], { cwd: dir });
  if (top.code === 0 && samePath(top.stdout.trim(), dir)) {
    const remote = await git(['remote', 'get-url', 'origin'], { cwd: dir });
    const existing = remote.stdout.trim();

    if (remote.code === 0 && existing.length > 0) {
      // An existing clone whose remote points somewhere else must be corrected,
      // not trusted. Fetching from a stale remote while pushing to the
      // configured one appears to work and produces very confusing failures
      // later — a fast-forward against the wrong history, or a push that
      // silently omits everything the other remote had.
      if (existing !== options.repoUrl) {
        await gitOrThrow(['remote', 'set-url', 'origin', options.repoUrl], { cwd: dir });
      }

      // Upgrading from an earlier version that cloned shallowly. Such a clone
      // cannot push to a repository missing the base objects, so deepen it now
      // rather than discovering that at push time.
      await unshallowIfNeeded(dir, { repoUrl, token, branch });

      return;
    }
  }

  await gitOrThrow(['init', '--initial-branch', branch], { cwd: dir });
  await gitOrThrow(['remote', 'add', 'origin', options.repoUrl], { cwd: dir });

  // Give the clone its own identity rather than depending on the machine's
  // global git config, which may not exist on a fresh install or a CI runner.
  await git(['config', 'user.name', 'ccr-bridge'], { cwd: dir });
  await git(['config', 'user.email', 'ccr-bridge@localhost'], { cwd: dir });

  // Fetch the branch if it exists; an empty relay repo is a normal first run.
  //
  // Deliberately a full fetch, not `--depth 1`. A shallow clone cannot push to
  // a repository that lacks the base objects, which fails the moment the relay
  // is emptied or recreated. The relay holds only normalized events, so there is
  // nothing worth optimising away.
  const fetched = await git(fetchArgs({ repoUrl, token, branch }), {
    cwd: dir,
    bypassProxy: true,
    timeoutMs: 120_000,
  });

  if (fetched.code === 0) {
    await git(['checkout', '-B', branch, 'FETCH_HEAD'], { cwd: dir });
  }
}

/**
 * A `git fetch` that authenticates.
 *
 * The credential goes in the URL **argument**, never in the clone's config:
 * `origin` stays the plain URL, so the token is not left on disk for anything
 * that can read the working copy to find later. The cost is that the token is
 * briefly visible in the process table, which on a single-user machine is the
 * better trade — and it is the same trade `authenticatedUrl` already documents.
 *
 * This matters because fetching from `origin` fetches from a *config* URL, and
 * a config URL has no credential in it. It works on a machine whose credential
 * manager happens to hold a cached token and fails on a fresh one — the worst
 * shape a bug can have, because the machine that works is the one that never
 * tests it.
 *
 * The destination refspec is explicit because fetching by URL does not update
 * `refs/remotes/origin/<branch>`: git only does that for a named remote. It is
 * forced (`+`) to match the default refspec git would have used, which the
 * outbound branch needs — every publish amends and force-pushes it, so its
 * tracked ref is routinely not a fast-forward.
 */
export function fetchArgs(options: {
  repoUrl: string;
  token: string | null;
  branch: string;
}): [command: string, repository: string, refspec: string] {
  return [
    'fetch',
    authenticatedUrl(options.repoUrl, options.token),
    `+${options.branch}:refs/remotes/origin/${options.branch}`,
  ];
}

/**
 * Deepen a shallow clone.
 *
 * A shallow repository cannot be pushed to a remote that lacks the omitted
 * objects — git aborts the push rather than corrupting the history. Recovering
 * in place is cheaper than discarding the clone.
 *
 * Takes the credentials for the same reason `fetchArgs` does: this is a fetch,
 * and a fetch from `origin` carries no credential.
 */
export async function unshallowIfNeeded(
  dir: string,
  remote: { repoUrl: string; token: string | null; branch: string },
): Promise<boolean> {
  const shallow = await git(['rev-parse', '--is-shallow-repository'], { cwd: dir });
  if (shallow.code !== 0 || shallow.stdout.trim() !== 'true') return false;

  const [, repository, refspec] = fetchArgs(remote);
  const deepened = await git(['fetch', '--unshallow', repository, refspec], {
    cwd: dir,
    bypassProxy: true,
    timeoutMs: 300_000,
  });
  return deepened.code === 0;
}

/** Compare two paths for identity, tolerating Windows separators and case. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => resolve(p).replace(/[/\\]+$/, '').replace(/\\/g, '/');
  const left = norm(a);
  const right = norm(b);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
