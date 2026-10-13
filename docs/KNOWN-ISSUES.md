# Known issues

A running record of what is broken, unverified, or deliberately deferred. Kept
honest on purpose: several of the bugs below were invisible to the test suite and
only appeared when the code ran against real data, so the "why it was missed"
column is as useful as the fix itself.

Last updated: 2026-10-13 (after M3).

---

## Open — needs fixing

### 1. The phone cannot read its own rate limit

Gitee returns `X-RateLimit-Limit` / `X-RateLimit-Remaining` on **anonymous**
requests only. Authenticated requests — which is every request the phone
makes — omit them entirely, and `GET /api/v5/rate_limit` returns 404.

**Consequence:** the planned "poll and back off from the remaining-quota header"
cannot be implemented. The poller must use a fixed interval and back off
**reactively** on HTTP 429.

**Status:** design corrected, not yet implemented (the poller arrives with M4).

### 2. A `304 Not Modified` still consumes quota

Confirmed by watching `X-RateLimit-Remaining` decrement across a conditional
request. Gitee differs from GitHub here, where 304s are free.

**Consequence:** ETags save bandwidth but not request budget, so conditional
polling buys nothing. Poll the branch ref and compare the commit SHA instead.

### 3. Contents API maximum file size — mostly moot, still unproven at the cap

The bridge publishes chunks of at most 256 KB. Git transfer has no such limit, so
**publishing is safe** regardless. The question was whether the phone could *read*
a chunk back through the Contents API, where a per-file ceiling may apply
(GitHub's is 1 MB); base64 inflates by ~33%.

**Verified against the real repository** — a chunk read back byte-exact:

```
blob sha 503f4006a953 (identical to the tree listing)
size 16,849 → decoded 16,849   base64 round-trip exact
21 events, correct kinds
```

In practice chunks are ~17 KB, not 256 KB, because sessions produce far fewer
events than the cap allows. So the ceiling is unlikely ever to be reached.

**Status:** read path proven at realistic sizes; the 256 KB cap itself remains
untested. Revisit only if a session ever produces a chunk near it.

### 4. Inbound prompts are never consumed

`#pollInbound` verifies prompts and records the outcome, but does not move them
to `in/.done/`. Injection needs the `ccr` wrapper (M6), and consuming a prompt we
cannot deliver would lose it silently.

**Consequence:** `in/` accumulates. A `seenPrompts` set prevents re-reporting,
so this is untidy rather than harmful — until M6 lands.

### 5. ~~One commit per publish, with no compaction~~ — RESOLVED

Every publish created a commit: thousands a day at a 10s cadence.

Periodic squashing was the obvious answer, but squashing rewrites the branch,
which would destroy an un-fetched inbound prompt. The two concerns are in
genuine conflict on a single branch.

**Resolved** by splitting them: `relay-out` (the bridge amends a single commit
and force-pushes — history stays at exactly one commit forever) and `relay-in`
(append-only, fast-forward only). Chunk files are still never modified or
renumbered, so a reader's cached blob SHAs stay valid across a force-push; only
the commit that carries them is rewritten.

The branches also get separate clones, so a force-push on one cannot disturb the
working tree holding un-consumed prompts on the other.

### 6. `relayDirty` only tracks chunk appends

Only appended events set the flag. A change to `state.json` or `index.json`
alone — a session going idle, a cost update — will not trigger a publish until
the next event arrives.

**Status:** minor; revisit if the phone shows stale status.

### 7. Prompt injection is not implemented

Sessions are all read-only: `applyRegistry(entry, false)` hard-codes
`controllable: false`. This is M6, and it depends on M5 (`ccr`).

### 8. The permission-dialog gate is inference-only

Injecting while a permission dialog is open would **answer the dialog** rather
than type the prompt — potentially auto-approving a tool. Detecting that from
the tail alone is guesswork; the reliable detector is a `PreToolUse`/
`PostToolUse` hook pair (M7).

**Status:** not implemented. Injection must not ship before this.

---

## Open — surfaced by the phone build

### 9. The tree listing grows without bound — biggest scaling risk

Change detection polls the branch ref, then fetches `git/trees/relay-out?recursive=1`.
Because publishing amends and force-pushes whenever events arrive, the head SHA
moves often — so a "1 request per poll" steady state is really 1 ref request
*plus* 1 tree request per poll, and **the tree payload grows with every session's
entire history**, since every sealed chunk is a blob entry forever.

The phone cannot prune; this needs chunk retention/archival on the PC side.

**Status:** not implemented. This is the item most likely to bite first.

### 10. A skewed phone clock makes prompts fail silently

The bridge refuses prompts older than 10 minutes or more than 60 s in the future.
A phone whose clock is off writes a file that is then rejected, and the UI shows
"no acknowledgement seen" — with nothing anywhere identifying the cause.

**Status:** not implemented. Options: a clock-skew check against the server's
`Date` header, or surfacing rejections more loudly.

### 11. `controllable` does not mean injection is enabled

The composer is enabled by `state.controllable`, but `CCR_ALLOW_INJECTION` also
has to be on for a prompt to actually run. With it off, prompts are accepted into
`in/` and never executed, and the UI honestly reports them as unacknowledged
rather than explaining why.

**Status:** the bridge should publish its injection policy in `index.json` so the
phone can say so plainly.

### 12. Acknowledgement only resolves while the session is open

`injection` events are only loaded with the session's timeline, so an
acknowledgement arriving while the user is on the list view is not seen until
they next open that session.

**Status:** minor. Would need a lightweight per-session ack check.

### 13. The blob cache is capped at ~3 MB (~12 chunks)

Scrolling back through a long session refetches chunks, at one request plus
preflight each. IndexedDB would remove the cap.

**Status:** acceptable for now; revisit if sessions get long.

### 14. The phone has never run against real Gitee

Everything was verified against a purpose-built fake (see below), which is a
strong test of the app but says nothing about Gitee's own behaviour. Specifically
unverified: whether `git/trees` honours `page`/`per_page` (the client pages up to
6×1000 and warns on `truncated`), the exact PUT response shape, and whether
throttling arrives as 403 or 429 (both are handled identically). Also verified
only in a desktop browser — real iOS/Android standalone behaviour is handled
defensively but untested on a device.

---

## Postponed deliberately

- **Push notifications.** None. The page is checked on demand, by choice.
- **Remote session creation.** Sessions start on the PC only.
- **Retention/pruning.** No expiry yet; the relay grows without bound.
- **Subagent transcript content.** Only metadata is published, by choice.

---

## Fixed — and why the tests missed them

Each of these passed the unit suite and failed in reality.

| Bug | Why it was invisible |
|---|---|
| Bridge committed into the **project repo** instead of the relay | `git rev-parse` searches parent directories, so a clone inside another repo reports that repo. Tests used temp dirs outside any repository. |
| Windows `EPERM` renaming over an open file | Intermittent — a virus scanner or indexer holding the just-written temp file. Passed on some runs, failed on others. |
| Temp filenames collided within one millisecond | Needed rapid sealing to hit; a slower run never collided. |
| A **failed push reported as `clean`** | The first attempt committed, the push failed, and the retry saw nothing new staged and returned "nothing to do" — so the caller cleared its dirty flag and the data never left the machine. Silent data loss. |
| **Shallow clone could not push** to an empty repository | `--depth 1` was an unexamined optimisation. It worked against the first remote only because that remote already had the base objects. |
| Stale remote never corrected | Changing `CCR_REPO_URL` left the clone fetching from the old repo while pushing to the new one — which appears to work. |
| Titles stamped `1970-01-01` | `ai-title` entries carry **no timestamp at all**, so there was nothing to stamp them with. Fixed by deferring the event until a timestamped line arrives. |
| `[Request interrupted by user]` published as a user prompt | A real transcript entry, but harness-generated. Synthetic fixtures did not contain it. |
| Projected 1,669 duplicate `title` events | `ai-title` re-fires ~45 times per session. Only real data shows the volume. |
| Subagents discovered once, never again | Only a session spawning a *later* agent exposes it. |
| Agents rendered as a flat list | Nesting is `parentAgentId` in the meta file, not the directory layout or `spawnDepth`. |

### Verification mistakes worth remembering

- **Grepping raw text for a bug proves nothing.** A search for
  `Request interrupted` "found" three occurrences that were actually an assistant
  message quoting the bug and two edit patches adding the filter. Check the
  *field*, not the substring.
- **A test can assert the opposite of the goal.** One assertion required the
  relay *not* to contain the chunk it had just been asked to publish.

---

## Environment constraints

- **`HTTP_PROXY`/`HTTPS_PROXY` are set and `gitee.com` is not in `NO_PROXY`.**
  Any HTTP client honouring them routes Gitee overseas, defeating the reason for
  choosing it. The bridge strips them for git operations and must continue to.
- **Node 24 has no matching `node-gyp` toolchain** (no MSVC, no Windows SDK).
  `node-pty` ships `prebuilds/win32-x64/` and works; anything requiring a source
  build will not.
- **`ANTHROPIC_AUTH_TOKEN` sits in plaintext in `~/.claude/settings.json`.**
  Out of scope here, but worth moving to an environment variable.
