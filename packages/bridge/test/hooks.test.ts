import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import {
  applyHookEvent,
  emptyHookState,
  hookFacts,
  hooksCurrent,
  isPermissionPrompt,
  parseHookPayload,
  startHookServer,
  type HookPayload,
  type HookSessionState,
} from '../src/hooks.js';
import {
  DEFAULT_HOOK_PORT,
  HOOK_EVENTS,
  hookCommand,
  mergeHookSettings,
  readEnvValue,
  upsertEnv,
} from '../../../scripts/install-hooks.mjs';

/** A payload as Claude Code sends it: base fields plus whatever the event adds. */
function payload(overrides: Partial<Record<string, unknown>> = {}): unknown {
  return {
    session_id: 'session-1',
    transcript_path: 'C:/Users/x/.claude/projects/p/session-1.jsonl',
    cwd: 'C:/work',
    hook_event_name: 'Stop',
    ...overrides,
  };
}

function parsed(overrides: Partial<Record<string, unknown>> = {}): HookPayload {
  const value = parseHookPayload(payload(overrides));
  if (!value) throw new Error('fixture did not parse');
  return value;
}

/** Fold a sequence of events in, as the bridge does. */
function fold(
  events: readonly HookPayload[],
  start: HookSessionState = emptyHookState(),
  stepMs = 1_000,
): HookSessionState {
  let state = start;
  let now = 1_700_000_000_000;
  for (const event of events) {
    now += stepMs;
    state = applyHookEvent(state, event, now).state;
  }
  return state;
}

describe('parseHookPayload', () => {
  it('reads the fields every event carries', () => {
    const event = parsed();
    expect(event.sessionId).toBe('session-1');
    expect(event.eventName).toBe('Stop');
    expect(event.cwd).toBe('C:/work');
    expect(event.transcriptPath).toContain('session-1.jsonl');
    expect(event.agentId).toBeNull();
  });

  it('reads the event-specific fields', () => {
    const event = parsed({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_use_id: 'toolu_1',
      permission_mode: 'default',
      tool_input: { command: 'ls' },
    });
    expect(event.toolName).toBe('Bash');
    expect(event.toolUseId).toBe('toolu_1');
    expect(event.permissionMode).toBe('default');
    // Not kept: the guard needs the signal, not the tool's arguments.
    expect(Object.keys(event)).not.toContain('toolInput');
  });

  it('reads agent_id, which marks an event as coming from inside a subagent', () => {
    expect(parsed({ agent_id: 'agent-9', agent_type: 'Explore' }).agentId).toBe('agent-9');
  });

  it.each([
    ['no session id', { session_id: undefined }],
    ['no event name', { hook_event_name: undefined }],
    ['an empty session id', { session_id: '' }],
  ])('rejects a payload with %s', (_label, overrides) => {
    // Without both, the event cannot be attributed to a session, and a rule
    // applied to the wrong session is worse than no rule.
    expect(parseHookPayload(payload(overrides))).toBeNull();
  });

  it.each([['null', null], ['an array', []], ['a string', 'nope'], ['a number', 3]])(
    'rejects %s',
    (_label, value) => {
      expect(parseHookPayload(value)).toBeNull();
    },
  );
});

describe('isPermissionPrompt', () => {
  it('recognises the notification type', () => {
    expect(parsePayload({ hook_event_name: 'Notification', notification_type: 'permission_prompt' })).toBe(
      true,
    );
  });

  it('falls back to the message when the type is missing', () => {
    // The type is sometimes omitted upstream, and a dialog we do not recognise
    // is one we would type into.
    expect(
      parsePayload({
        hook_event_name: 'Notification',
        message: 'Claude needs your permission to use Bash',
      }),
    ).toBe(true);
  });

  it('does not read a permission dialog into an unrelated notification', () => {
    expect(
      parsePayload({
        hook_event_name: 'Notification',
        notification_type: 'idle_prompt',
        message: 'Claude is waiting for your input',
      }),
    ).toBe(false);
  });

  it('only ever applies to Notification events', () => {
    expect(
      parsePayload({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        message: 'permission to run bash',
      }),
    ).toBe(false);
  });
});

function parsePayload(overrides: Partial<Record<string, unknown>>): boolean {
  return isPermissionPrompt(parsed(overrides));
}

describe('applyHookEvent', () => {
  it('marks hooks live on the first event, whatever it is', () => {
    const { state } = applyHookEvent(undefined, parsed({ hook_event_name: 'SomethingNew' }), 1234);
    expect(state.hooksLive).toBe(true);
    expect(state.lastEventAt).toBe(1234);
    expect(state.events).toBe(1);
  });

  it('does not mutate the state it was given', () => {
    const before = fold([parsed({ hook_event_name: 'PreToolUse', tool_use_id: 't1' })]);
    const snapshot = structuredClone(before);
    applyHookEvent(before, parsed({ hook_event_name: 'Stop' }), 9999);
    expect(before).toEqual(snapshot);
  });

  describe('tool calls in flight', () => {
    it('counts a tool as in flight between PreToolUse and PostToolUse', () => {
      const started = fold([parsed({ hook_event_name: 'PreToolUse', tool_use_id: 't1' })]);
      expect(hookFacts(started).toolInFlight).toBe(true);

      const finished = applyHookEvent(
        started,
        parsed({ hook_event_name: 'PostToolUse', tool_use_id: 't1' }),
        2,
      ).state;
      expect(hookFacts(finished).toolInFlight).toBe(false);
    });

    it('clears a failed tool call too', () => {
      const started = fold([parsed({ hook_event_name: 'PreToolUse', tool_use_id: 't1' })]);
      const failed = applyHookEvent(
        started,
        parsed({ hook_event_name: 'PostToolUseFailure', tool_use_id: 't1', error: 'exit 1' }),
        2,
      ).state;
      expect(hookFacts(failed).toolInFlight).toBe(false);
    });

    it('keeps a different call in flight when one finishes', () => {
      const both = fold([
        parsed({ hook_event_name: 'PreToolUse', tool_use_id: 't1' }),
        parsed({ hook_event_name: 'PreToolUse', tool_use_id: 't2' }),
      ]);
      const oneDone = applyHookEvent(
        both,
        parsed({ hook_event_name: 'PostToolUse', tool_use_id: 't2' }),
        2,
      ).state;
      expect(oneDone.tools).toEqual(['t1']);
    });

    it('pairs a call that arrived without an id', () => {
      // Not every event carries a tool_use_id; those still have to balance, or
      // the guard would refuse for the rest of the session.
      const started = fold([parsed({ hook_event_name: 'PreToolUse' })]);
      expect(hookFacts(started).toolInFlight).toBe(true);

      const finished = applyHookEvent(started, parsed({ hook_event_name: 'PostToolUse' }), 2).state;
      expect(hookFacts(finished).toolInFlight).toBe(false);
    });

    it('does not let an unrelated completion clear a call', () => {
      const started = fold([parsed({ hook_event_name: 'PreToolUse', tool_use_id: 't1' })]);
      const other = applyHookEvent(
        started,
        parsed({ hook_event_name: 'PostToolUse', tool_use_id: 't9' }),
        2,
      ).state;
      expect(hookFacts(other).toolInFlight).toBe(true);
    });

    it('clears everything when the turn ends', () => {
      // A denied permission dialog fires PreToolUse and neither completion
      // event, so the turn ending is the only thing that can clear it.
      const started = fold([
        parsed({ hook_event_name: 'PreToolUse', tool_use_id: 't1' }),
        parsed({ hook_event_name: 'PreToolUse', tool_use_id: 't2' }),
      ]);
      const stopped = applyHookEvent(started, parsed({ hook_event_name: 'Stop' }), 2).state;
      expect(hookFacts(stopped).toolInFlight).toBe(false);
    });

    it('clears everything when the session ends', () => {
      // A session killed mid-tool never posts a completion for it.
      const started = fold([parsed({ hook_event_name: 'PreToolUse', tool_use_id: 't1' })]);
      const ended = applyHookEvent(
        started,
        parsed({ hook_event_name: 'SessionEnd', reason: 'exit' }),
        2,
      ).state;
      expect(hookFacts(ended).toolInFlight).toBe(false);
    });
  });

  describe('permission dialogs', () => {
    it('opens on a permission notification', () => {
      const state = fold([
        parsed({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow?' }),
      ]);
      expect(hookFacts(state).dialogOpen).toBe(true);
    });

    it('closes on the next main-thread event', () => {
      // A dialog cannot outlive the tool call it is blocking, and that call
      // moves the moment the dialog is answered.
      const open = fold([
        parsed({
          hook_event_name: 'Notification',
          notification_type: 'permission_prompt',
          message: 'Allow?',
        }),
      ]);
      const answered = applyHookEvent(
        open,
        parsed({ hook_event_name: 'PostToolUse', tool_use_id: 't1' }),
        2,
      ).state;
      expect(hookFacts(answered).dialogOpen).toBe(false);
    });

    it('closes when the turn ends, even unanswered', () => {
      const open = fold([
        parsed({
          hook_event_name: 'Notification',
          notification_type: 'permission_prompt',
          message: 'Allow?',
        }),
      ]);
      const stopped = applyHookEvent(open, parsed({ hook_event_name: 'Stop' }), 2).state;
      expect(hookFacts(stopped).dialogOpen).toBe(false);
    });

    it('is not closed by a subagent finishing something of its own', () => {
      // A subagent's progress says nothing about a dialog the main thread is
      // sitting behind, so it must not clear it.
      const open = fold([
        parsed({
          hook_event_name: 'Notification',
          notification_type: 'permission_prompt',
          message: 'Allow?',
        }),
      ]);
      const subagent = applyHookEvent(
        open,
        parsed({ hook_event_name: 'PostToolUse', tool_use_id: 't1', agent_id: 'agent-9' }),
        2,
      ).state;
      expect(hookFacts(subagent).dialogOpen).toBe(true);
    });

    it('is closed by the subagent that opened it', () => {
      const open = fold([
        parsed({
          hook_event_name: 'Notification',
          notification_type: 'permission_prompt',
          message: 'Allow?',
          agent_id: 'agent-9',
        }),
      ]);
      const progressed = applyHookEvent(
        open,
        parsed({ hook_event_name: 'PostToolUse', tool_use_id: 't1', agent_id: 'agent-9' }),
        2,
      ).state;
      expect(hookFacts(progressed).dialogOpen).toBe(false);
    });

    it('does not treat an ordinary notification as a dialog', () => {
      const state = fold([
        parsed({
          hook_event_name: 'Notification',
          notification_type: 'auth_success',
          message: 'Logged in',
        }),
      ]);
      expect(hookFacts(state).dialogOpen).toBe(false);
    });
  });

  describe('attention', () => {
    const permissionNote = parsed({
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Bash',
    });

    it('surfaces a permission dialog as waiting, which is the moment the phone is for', () => {
      const { attention } = applyHookEvent(undefined, permissionNote, 1);
      expect(attention).toEqual({
        text: 'Claude needs your permission to use Bash',
        level: 'waiting',
      });
    });

    it('surfaces any other notification as information', () => {
      const { attention } = applyHookEvent(
        undefined,
        parsed({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Waiting for you' }),
        1,
      );
      expect(attention?.level).toBe('info');
    });

    it('collapses a notification repeated within the minute', () => {
      // Claude Code re-fires its idle notification; publishing each one would
      // bury the timeline.
      const first = applyHookEvent(undefined, permissionNote, 1_000);
      const again = applyHookEvent(first.state, permissionNote, 30_000);
      expect(again.attention).toBeNull();
    });

    it('publishes the same text again once enough time has passed', () => {
      const first = applyHookEvent(undefined, permissionNote, 1_000);
      const later = applyHookEvent(first.state, permissionNote, 120_000);
      expect(later.attention).not.toBeNull();
    });

    it('emits nothing for a notification with no message to show', () => {
      const { attention } = applyHookEvent(
        undefined,
        parsed({ hook_event_name: 'Notification', notification_type: 'auth_success' }),
        1,
      );
      expect(attention).toBeNull();
    });

    it('emits nothing for events that are not notifications', () => {
      for (const name of ['PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'SessionStart']) {
        expect(applyHookEvent(undefined, parsed({ hook_event_name: name }), 1).attention).toBeNull();
      }
    });

    it('flattens and bounds a long message, which is destined for a phone line', () => {
      const { attention } = applyHookEvent(
        undefined,
        parsed({
          hook_event_name: 'Notification',
          notification_type: 'permission_prompt',
          message: `Allow?\n${'x'.repeat(5_000)}`,
        }),
        1,
      );
      expect(attention?.text).not.toContain('\n');
      expect(Buffer.byteLength(attention!.text, 'utf8')).toBeLessThanOrEqual(1_000);
    });
  });

  it('keeps a subagent\'s tool call in flight without touching the main thread', () => {
    // It is still a call in flight — a permission dialog could appear for it —
    // and `Stop` clears it like any other.
    const state = fold([parsed({ hook_event_name: 'PreToolUse', tool_use_id: 't1', agent_id: 'a1' })]);
    expect(hookFacts(state).toolInFlight).toBe(true);
    expect(hookFacts(state).hooksLive).toBe(true);
  });
});

describe('hookFacts', () => {
  it('reports nothing for a session no hook has ever mentioned', () => {
    // "We have not heard from hooks" must never read as "nothing is blocking".
    expect(hookFacts(undefined)).toEqual({ hooksLive: false, dialogOpen: false, toolInFlight: false });
  });
});

describe('hooksCurrent', () => {
  const live: HookSessionState = { ...emptyHookState(), hooksLive: true, lastEventAt: 10_000 };

  it('is false before any hook event has arrived', () => {
    expect(hooksCurrent(undefined, 0, 60_000)).toBe(false);
  });

  it('is true while the transcript has not run ahead', () => {
    expect(hooksCurrent(live, 9_000, 60_000)).toBe(true);
    // Exactly at the grace period, which is jitter rather than disagreement.
    expect(hooksCurrent(live, 70_000, 60_000)).toBe(true);
  });

  it('is false once the transcript has moved on without a hook event', () => {
    // The only way to tell "hooks stopped working" from "the session is idle"
    // is that the transcript kept moving while the hook stream did not.
    expect(hooksCurrent(live, 70_001, 60_000)).toBe(false);
  });

  it('is true when no transcript timestamp is known yet', () => {
    expect(hooksCurrent(live, 0, 60_000)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The receiver
// ---------------------------------------------------------------------------

interface Reply {
  status: number;
  body: string;
}

/** POST a body the way the forwarder does. */
function post(port: number, body: string, token: string | null, path = '/hook'): Promise<Reply> {
  return new Promise((resolvePost, rejectPost) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    };
    if (token) headers['x-ccr-token'] = token;

    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        text += chunk;
      });
      res.on('end', () => resolvePost({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', rejectPost);
    req.end(body);
  });
}

/** GET, for the method check. */
function get(port: number, path: string): Promise<number> {
  return new Promise((resolveGet, rejectGet) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolveGet(res.statusCode ?? 0));
    });
    req.on('error', rejectGet);
    req.end();
  });
}

describe('startHookServer', () => {
  /**
   * A receiver on an ephemeral port, so tests cannot collide with each other or
   * with a bridge that happens to be running.
   */
  async function withServer(
    token: string | null,
    body: (port: number, received: HookPayload[]) => Promise<void>,
  ): Promise<void> {
    const received: HookPayload[] = [];
    const server = await startHookServer({ port: 0, token, onEvent: (event) => received.push(event) });
    try {
      await body(server.port, received);
    } finally {
      await server.close();
    }
  }

  it('accepts a hook payload and hands it to the bridge', async () => {
    await withServer('secret', async (port, received) => {
      const reply = await post(port, JSON.stringify(payload({ hook_event_name: 'Stop' })), 'secret');
      expect(reply.status).toBe(202);
      expect(received).toHaveLength(1);
      expect(received[0]?.eventName).toBe('Stop');
    });
  });

  it('refuses a request with a missing or wrong token once one is set', async () => {
    await withServer('secret', async (port, received) => {
      expect((await post(port, JSON.stringify(payload()), null)).status).toBe(403);
      expect((await post(port, JSON.stringify(payload()), 'wrong')).status).toBe(403);
      // Nothing was recorded: a forged event must not be able to move the guard.
      expect(received).toHaveLength(0);
    });
  });

  it('accepts anything when no token is configured', async () => {
    await withServer(null, async (port, received) => {
      expect((await post(port, JSON.stringify(payload()), null)).status).toBe(202);
      expect(received).toHaveLength(1);
    });
  });

  it('rejects a body that is not a hook event', async () => {
    await withServer(null, async (port, received) => {
      expect((await post(port, '{"hello":true}', null)).status).toBe(400);
      expect((await post(port, 'not json', null)).status).toBe(400);
      expect(received).toHaveLength(0);
    });
  });

  it('refuses an oversized body instead of buffering it', async () => {
    // A `Write` payload carries the whole file. The forwarder strips it, but
    // anything else on the machine could post one here.
    await withServer(null, async (port, received) => {
      const huge = `{"session_id":"${'x'.repeat(5 * 1024 * 1024)}","hook_event_name":"Stop"}`;
      expect((await post(port, huge, null)).status).toBe(413);
      expect(received).toHaveLength(0);
    });
  });

  it('answers the wrong method and the wrong path rather than pretending', async () => {
    await withServer(null, async (port) => {
      expect(await get(port, '/hook')).toBe(405);
      expect((await post(port, JSON.stringify(payload()), null, '/elsewhere')).status).toBe(404);
    });
  });

  it('stops accepting once closed, and stops reporting itself as running', async () => {
    const server = await startHookServer({ port: 0, token: null, onEvent: () => {} });
    expect(server.running).toBe(true);
    await server.close();
    expect(server.running).toBe(false);
  });

  it('reports the port it actually bound', async () => {
    const server = await startHookServer({ port: 0, token: null, onEvent: () => {} });
    expect(server.port).toBeGreaterThan(0);
    await server.close();
  });

  it('refuses a request from outside this machine', async () => {
    // Loopback only. The socket is bound to 127.0.0.1 so a remote connection
    // cannot reach it at all; this is the second line of that defence.
    await withServer(null, async (port) => {
      // The check itself, exercised directly: a non-loopback peer address.
      const { isLoopbackAddress } = await import('../src/hooks.js');
      expect(isLoopbackAddress('127.0.0.1')).toBe(true);
      expect(isLoopbackAddress('::1')).toBe(true);
      expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
      expect(isLoopbackAddress('192.168.1.20')).toBe(false);
      expect(isLoopbackAddress('10.0.0.1')).toBe(false);
      expect(isLoopbackAddress(undefined)).toBe(false);
      expect(port).toBeGreaterThan(0);
    });
  });

  it('fails to start on a taken port, rather than taking the bridge down with it', async () => {
    // The bridge logs this and carries on with the transcript rule; the listen
    // error must reach it as a rejection, not an unhandled event.
    const blocker = createServer(() => {});
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    await expect(startHookServer({ port, token: null, onEvent: () => {} })).rejects.toThrow();
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });
});

// ---------------------------------------------------------------------------
// The forwarder — the other half of the integration
// ---------------------------------------------------------------------------

/**
 * The whole path, as Claude Code drives it: a command hook with the event on
 * stdin, a real forwarder process, and a real receiver on loopback.
 *
 * The exit code is asserted every time. `PreToolUse` treats exit 2 as "block
 * this tool call", so a forwarder that failed loudly would turn a stopped bridge
 * into a machine that cannot run tools.
 */
describe('hooks/post-hook.mjs', () => {
  const forwarder = fileURLToPath(new URL('../hooks/post-hook.mjs', import.meta.url));

  function run(args: string[], stdin: string): Promise<{ code: number | null; stdout: string }> {
    return new Promise((resolveRun) => {
      const child = spawn(process.execPath, [forwarder, ...args], { stdio: ['pipe', 'pipe', 'ignore'] });
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.on('exit', (code) => resolveRun({ code, stdout }));
      child.stdin.end(stdin);
    });
  }

  /** `--env` at a path that does not exist, so only the arguments are in play. */
  const noEnv = ['--env', fileURLToPath(new URL('./no-such-file.env', import.meta.url))];

  it('delivers a hook event to the receiver and exits 0', async () => {
    const received: HookPayload[] = [];
    const server = await startHookServer({ port: 0, token: 'tok', onEvent: (e) => received.push(e) });
    try {
      const result = await run(
        [...noEnv, '--port', String(server.port), '--token', 'tok'],
        JSON.stringify(payload({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1' })),
      );

      expect(result.code).toBe(0);
      expect(received).toHaveLength(1);
      expect(received[0]?.eventName).toBe('PreToolUse');
      expect(received[0]?.toolUseId).toBe('t1');
    } finally {
      await server.close();
    }
  });

  it('writes nothing to stdout, because a hook that talks is a hook that decides', async () => {
    const server = await startHookServer({ port: 0, token: null, onEvent: () => {} });
    try {
      const result = await run([...noEnv, '--port', String(server.port)], JSON.stringify(payload()));
      expect(result.stdout).toBe('');
    } finally {
      await server.close();
    }
  });

  it('strips tool_input and tool_response, so a Write does not post a whole file', async () => {
    const received: HookPayload[] = [];
    const server = await startHookServer({ port: 0, token: null, onEvent: (e) => received.push(e) });
    try {
      await run(
        [...noEnv, '--port', String(server.port)],
        JSON.stringify(
          payload({
            hook_event_name: 'PreToolUse',
            tool_name: 'Write',
            tool_use_id: 't1',
            tool_input: { file_path: 'a.ts', content: 'x'.repeat(500_000) },
          }),
        ),
      );

      expect(received).toHaveLength(1);
      expect(received[0]?.toolName).toBe('Write');
    } finally {
      await server.close();
    }
  });

  it('exits 0 when no receiver is listening', async () => {
    // A bridge that is not running must not stop tools from running.
    const result = await run(
      [...noEnv, '--port', '9', '--token', 'tok'],
      JSON.stringify(payload()),
    );
    expect(result.code).toBe(0);
  });

  it('exits 0 for a payload it cannot parse, and for no payload at all', async () => {
    expect((await run(noEnv, 'not json')).code).toBe(0);
    expect((await run(noEnv, '')).code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The installer's planning logic
// ---------------------------------------------------------------------------

describe('installer', () => {
  it('defaults to the port the bridge actually listens on', () => {
    // The two defaults live in different files; this is what stops them drifting.
    expect(DEFAULT_HOOK_PORT).toBe(loadConfig({}).hookPort);
  });

  describe('hookCommand', () => {
    it('quotes the path and uses forward slashes, which is what a shell wants', () => {
      // The command is passed to sh -c, Git Bash, or PowerShell depending on the
      // platform; a backslash is an escape character in the first two.
      expect(hookCommand('E:\\a b\\hooks\\post-hook.mjs')).toBe('node "E:/a b/hooks/post-hook.mjs"');
    });

    it('points at the environment file only when it is somewhere unusual', () => {
      expect(hookCommand('/x/post-hook.mjs', '/tmp/.env')).toBe(
        'node "/x/post-hook.mjs" --env "/tmp/.env"',
      );
    });
  });

  describe('mergeHookSettings', () => {
    it('adds one entry per event, and no matcher', () => {
      const { settings } = mergeHookSettings({}, 'node "x/post-hook.mjs"');
      const hooks = settings.hooks as Record<string, { hooks: unknown[] }[]>;

      expect(Object.keys(hooks).sort()).toEqual([...HOOK_EVENTS].sort());
      for (const event of HOOK_EVENTS) {
        expect(hooks[event]).toHaveLength(1);
        expect(hooks[event]?.[0]?.hooks).toEqual([
          { type: 'command', command: 'node "x/post-hook.mjs"', timeout: 5 },
        ]);
        // An omitted matcher matches everything; a `*` would be an invalid regex
        // on some events and is not worth depending on.
        expect(hooks[event]?.[0]).not.toHaveProperty('matcher');
      }
    });

    it('is idempotent: running it twice writes the same file', () => {
      const once = mergeHookSettings({}, 'node "x/post-hook.mjs"').settings;
      const twice = mergeHookSettings(once, 'node "x/post-hook.mjs"').settings;
      expect(twice).toEqual(once);
    });

    it('reports what it replaced, so a re-run can say so', () => {
      const once = mergeHookSettings({}, 'node "x/post-hook.mjs"').settings;
      expect(mergeHookSettings(once, 'node "x/post-hook.mjs"').replaced).toBe(HOOK_EVENTS.length);
    });

    it('leaves hooks belonging to anything else exactly as they were', () => {
      const before = {
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo theirs' }] },
          ],
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo other event' }] }],
        },
        model: 'sonnet',
        permissions: { allow: ['Bash(ls:*)'] },
      };

      const after = mergeHookSettings(before, 'node "x/post-hook.mjs"').settings;
      const hooks = after.hooks as Record<string, { matcher?: string; hooks: { command: string }[] }[]>;

      expect(hooks['PreToolUse']).toHaveLength(2);
      expect(hooks['PreToolUse']?.[0]).toEqual(before.hooks.PreToolUse[0]);
      // An event we do not install is not touched at all.
      expect(hooks['UserPromptSubmit']).toEqual(before.hooks.UserPromptSubmit);
      expect(after['model']).toBe('sonnet');
      expect(after['permissions']).toEqual({ allow: ['Bash(ls:*)'] });
    });

    it('does not mutate the settings it was given', () => {
      const before = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo theirs' }] }] } };
      const snapshot = structuredClone(before);
      mergeHookSettings(before, 'node "x/post-hook.mjs"');
      expect(before).toEqual(snapshot);
    });

    it('drops a matcher group it emptied, rather than leaving an empty one', () => {
      const ours = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "x/post-hook.mjs"' }] };
      const after = mergeHookSettings({ hooks: { Stop: [ours] } }, 'node "x/post-hook.mjs"').settings;
      const groups = (after.hooks as Record<string, unknown[]>)['Stop'] ?? [];
      expect(groups).toHaveLength(1);
      expect(groups[0]).not.toEqual(ours);
    });

    it.each([
      ['the file is not an object', () => mergeHookSettings([], 'x')],
      ['hooks is not an object', () => mergeHookSettings({ hooks: 'soon' }, 'x')],
      ['an event entry is not an array', () => mergeHookSettings({ hooks: { Stop: {} } }, 'x')],
    ])('refuses to rewrite a file it does not understand when %s', (_label, run) => {
      // A half-understood settings file is a machine that does not start.
      expect(run).toThrow();
    });
  });

  describe('readEnvValue', () => {
    it('reads a plain value', () => {
      expect(readEnvValue('CCR_HOOK_PORT=27182\n', 'CCR_HOOK_PORT')).toBe('27182');
    });

    it('reads through a quoted value and an export prefix', () => {
      expect(readEnvValue('export CCR_HOOK_TOKEN="abc"\n', 'CCR_HOOK_TOKEN')).toBe('abc');
    });

    it('treats an empty assignment as unset', () => {
      expect(readEnvValue('CCR_HOOK_TOKEN=\n', 'CCR_HOOK_TOKEN')).toBeNull();
    });

    it('returns null for a key that is absent', () => {
      expect(readEnvValue('OTHER=1\n', 'CCR_HOOK_TOKEN')).toBeNull();
    });

    it('does not match a key that merely starts the same way', () => {
      expect(readEnvValue('CCR_HOOK_TOKEN_OLD=stale\n', 'CCR_HOOK_TOKEN')).toBeNull();
    });
  });

  describe('upsertEnv', () => {
    it('appends missing keys', () => {
      const result = upsertEnv('CCR_SECRET=abc\n', { CCR_HOOK_PORT: '27182' });
      expect(result.text).toBe('CCR_SECRET=abc\nCCR_HOOK_PORT=27182\n');
      expect(result.added).toEqual(['CCR_HOOK_PORT']);
    });

    it('keeps an existing value rather than replacing it', () => {
      // Regenerating the token would lock out a bridge that is already running.
      const result = upsertEnv('CCR_HOOK_TOKEN=keepme\n', { CCR_HOOK_TOKEN: 'newvalue' });
      expect(result.text).toBe('CCR_HOOK_TOKEN=keepme\n');
      expect(result.added).toEqual([]);
      expect(result.values['CCR_HOOK_TOKEN']).toBe('keepme');
    });

    it('fills in a key that is present but empty', () => {
      const result = upsertEnv('CCR_HOOK_TOKEN=\n', { CCR_HOOK_TOKEN: 'newvalue' });
      expect(result.text).toBe('CCR_HOOK_TOKEN=newvalue\n');
      expect(result.added).toEqual(['CCR_HOOK_TOKEN']);
    });

    it('appends to a file with no trailing newline', () => {
      expect(upsertEnv('A=1', { B: '2' }).text).toBe('A=1\nB=2\n');
    });

    it('is idempotent', () => {
      const once = upsertEnv('A=1\n', { CCR_HOOK_PORT: '27182', CCR_HOOK_TOKEN: 't' }).text;
      const twice = upsertEnv(once, { CCR_HOOK_PORT: '9999', CCR_HOOK_TOKEN: 'other' }).text;
      expect(twice).toBe(once);
    });

    it('leaves comments and blank lines alone', () => {
      const before = '# a comment\n\nA=1\n';
      const after = upsertEnv(before, { B: '2' }).text;
      expect(after).toBe('# a comment\n\nA=1\nB=2\n');
    });
  });
});
