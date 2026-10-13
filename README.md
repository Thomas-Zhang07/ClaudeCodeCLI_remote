# ClaudeCodeCLI_remote

Monitor and drive a running **Claude Code CLI** session from your phone — live chat, file edits,
the subagent tree, cost stats, and the ability to send prompts back — **without hosting a server**.

The transport is a git repository used as a mailbox. The PC writes events to it; the phone reads
them over the Gitee API and writes prompts back the same way. There is no relay, no database, and
nothing to keep running in the cloud.

> **Status: work in progress.** The design is settled and verified against real session data; the
> implementation is being built milestone by milestone. See [Roadmap](#roadmap).

---

## Why

The built-in Remote Control covers some of this, but it routes through Anthropic's infrastructure.
This project exists to keep the whole path under your own control, on a transport that works from
a mainland-China mobile network — hence Gitee rather than GitHub.

---

## Architecture

```
PC                                                                     Gitee (private repo)
┌────────────────────────────────────────────────────────┐        ┌─────────────────────────┐
│  ccr ── node-pty ──▶ claude  (TUI preserved;           │        │  relay-out (rewritten)  │
│                     stdin owned ⇒ prompts injectable)  │ push ▶ │  out/index.json         │
│                                                        │        │  out/sessions/<id>/     │
│  bridge                                                │        │    head.json  (chunk    │
│    registry ─ sessions/<pid>.json  (liveness, status)  │ ◀ poll │                range)  │
│    tail     ─ streaming, byte offset, per-file         │        │    events-NNNN.jsonl    │
│    state    ─ last-wins types → head.json              │        │    subagents.json       │
│    events   ─ chat text + edits + subagent metadata    │        ├─────────────────────────┤
│    sync     ─ chunk writer, amended push, backoff      │        │  relay-in (append-only) │
│    inbound  ─ fetch → verify HMAC → inject or reject   │        │  in/<id>/<ts>.json      │
│    retention─ rolling ~10MB per session, oldest deleted│        └─────────────────────────┘
│                                                        │                   ▲   │
└────────────────────────────────────────────────────────┘       Contents API  │   │ PUT
                                                                  (CORS ✓)     │   ▼
└────────────────────────────────────────────────────────┘        ┌─────────────────────────┐
                                                                  │  Phone PWA              │
   plain `claude` sessions: registry-known, read-only             │  Vite + TypeScript      │
                                                                  └─────────────────────────┘
```

**Two directions, both over the same repo:**

| Direction | Mechanism |
|---|---|
| PC → phone | Bridge appends events to chunk files and pushes. Phone polls the branch ref and fetches only new chunks. |
| Phone → PC | Phone writes a signed prompt JSON via the Contents API. Bridge fetches it and injects it into the target session's terminal. |

---

## How it works

### Reading a session

Claude Code writes a JSONL transcript per session at
`~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`, with subagent transcripts alongside at
`<sessionId>/subagents/agent-<agentId>.jsonl`. A separate registry at `~/.claude/sessions/<pid>.json`
records which sessions are live and what they are waiting on.

The bridge tails these files from a persisted byte offset, normalizes each line into a small event,
and appends it to the relay repo. Transcripts are large — individual files reach tens of megabytes —
so nothing is ever loaded whole.

### What gets sent

Only what the phone actually needs:

- **Chat text** — user prompts and assistant replies
- **File edits** — real unified diffs taken from the transcript's `structuredPatch`
- **Subagent metadata** — type, description, parent, timing, status

Deliberately **not** sent: thinking blocks, non-edit tool calls and results, and the
`prompt_snapshot` attachments that embed the entire system prompt and tool definitions (these are
~44% of transcript bytes).

### Writing back

`ccr` launches Claude Code inside a ConPTY and passes bytes through in both directions, so the
terminal looks and behaves exactly like a normal `claude` session — but the bridge owns stdin and
can therefore type on your behalf. Prompts from the phone are injected as a **bracketed paste**
followed by a separate Enter; writing raw text with a newline would be collapsed by the TUI into a
`[Pasted text #N]` placeholder instead of being submitted.

Sessions started with plain `claude` are tailed read-only. The bridge cannot inject into them.

---

## Layout

```
packages/
  shared/    types + the pure transcript parser (no I/O, unit-tested)
  bridge/    file watching, normalization, Gitee sync, ccr/ConPTY, injection
  phone/     Vite + TypeScript PWA
scripts/     helper scripts (page publishing, optional hook install)
```

---

## Getting started

### Prerequisites

- **Node.js 22 LTS** (see the note below — the version matters)
- A **private Gitee repository** to use as the relay, plus a personal access token scoped to it
- Windows 10 1809+ if you want the `ccr` wrapper (ConPTY requirement); it is not needed for
  read-only monitoring

> **About the Node version:** `ccr` depends on `node-pty`, a native module. Node 22 LTS has the most
> reliable prebuilt-binary coverage. On a machine without a C++ toolchain (no Visual Studio Build
> Tools), a version without a matching prebuild cannot fall back to compiling, and `ccr` will not
> install. If that happens, `@lydell/node-pty` is a drop-in that never invokes node-gyp.

### Install

```bash
git clone https://github.com/Thomas-Zhang07/ClaudeCodeCLI_remote.git
cd ClaudeCodeCLI_remote
npm install
npm install --prefix packages/phone   # the phone page has its own dependencies
```

### Configure

Copy `.env.example` to `.env` and fill it in. The bridge reads:

| Variable | Purpose |
|---|---|
| `CCR_REPO_URL` | Git URL of the private relay repo |
| `CCR_REPO_TOKEN` | Gitee token used for pushing |
| `CCR_OUT_BRANCH` | Branch the bridge publishes to (default `relay-out`) |
| `CCR_IN_BRANCH` | Branch the phone writes prompts to (default `relay-in`) |
| `CCR_SECRET` | Shared secret for signing injected prompts |
| `CCR_STATE_DIR` | Where tail offsets and chunk state are persisted |

**Why two branches.** Outbound data is rewritten — each publish amends a single
commit and force-pushes, so the repository does not accumulate a commit every few
seconds. Inbound data is append-only and never rewritten. If they shared a
branch, compacting the outbound side would destroy a prompt the phone had written
but the bridge had not yet fetched, and it would vanish with no error. Keeping
them apart is what makes compaction safe rather than merely unlikely to hurt.

`.env` is gitignored. Never commit the token.

### Run

```bash
npm run build

# monitor only — tails every session, read-only
npm run bridge

# or launch a controllable session in the current directory.
# Every argument after `ccr` is passed straight through to Claude Code, so
# anything you would normally type works here unchanged.
npm run ccr

# phone UI
npm run phone:dev      # local dev server
npm run phone:build    # produces packages/phone/dist for deployment
```

### The phone page

A Vue 3 PWA. It talks to the Gitee API directly from the browser, so it needs an
**https origin** — Web Crypto, which signs prompts, is only available in a secure
context. Deploy `packages/phone/dist` anywhere that serves https; Netlify
publishes it from this repository with no configuration.

The page holds no data of its own. You enter the repository owner, name, token
and signing secret once, and they are kept in the browser's `localStorage`.

---

## Security

**The relay token is effectively PC-admin.** A prompt written to the relay repo is injected into an
agent that can run shell commands. Treat the token, the repo, and the phone it lives on as
equivalent to shell access on the bridge machine.

Mitigations in place:

- Prompts are **HMAC-signed** with a shared secret; unsigned, stale, or replayed prompts are rejected
- The token should be scoped to the single relay repo, and rotated if the phone is lost
- Injected prompts are echoed back into the event stream, so the phone shows what actually ran
- A redaction pass scrubs API keys and credentials before anything leaves the machine
- Transcript content goes only to the private relay repo, never to this one

---

## Roadmap

- [x] Design + verification against real session data
- [ ] **M0** Prerequisites, scaffold, configuration
- [ ] **M1** Transcript parser (`packages/shared`) with fixtures
- [ ] **M2** Bridge — local tailing, normalization, chunk writing
- [ ] **M3** Gitee sync — push, poll, rate-limit backoff, inbound reader
- [x] **M4** Phone PWA — session list, chat, diffs, subagent tree
- [x] **M5** `ccr` — ConPTY passthrough wrapper
- [ ] **M6** Prompt injection with the permission-dialog guard
- [ ] **M7** Optional hooks for lower-latency attention state
- [ ] **M8** Retention, compaction, quota display

## License

Not yet chosen.
