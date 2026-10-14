# Known issues

A running record of what is broken, unverified, or deliberately deferred. Kept
honest on purpose: several of the bugs below were invisible to the test suite and
only appeared when the code ran against real data, so the "why it was missed"
column is as useful as the fix itself.

Last updated: 2026-10-14 (after the out-of-order sequence fix, M7).

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

### 20. Corrupt-manifest recovery loses the sequence position

When the chunker's manifest is unreadable it now starts numbering above the
existing chunk files rather than overwriting them — but its in-memory sealed
list is empty afterwards, so the sequence position falls back to the persisted
value, which may sit behind chunks still on disk.

Those chunks stop being advertised (`chunkFirst` jumps above them), so a reader
never assembles them with new events. Nothing is corrupted or lost on the
bridge, but a phone holding them cached will not see them again either.

**Status:** open. Rebuilding the sealed list by scanning the chunk files would
fix it properly; larger than the fix that introduced the compromise.

### 21. The event-size ceiling is now enforced rather than documented

`MAX_EVENT_BYTES` was described as asserted by the chunk writer but never
checked; it is now checked before any state moves, so a rejection leaves the
chunk untouched and is logged rather than silent.

**Residual risk:** JSON escaping expands bounded strings, so a pathological
payload of control characters could in principle reach the ceiling. Measured
against 47 real chunks the largest event is 12.9 KB against a 20 KB bound, so it
is unreachable for real content — but it is a new runtime failure mode where a
documented bound previously was.

**What a rejection costs, corrected.** This note originally stopped at the
bridge, and that was the mistake. The reader treated any discontinuity as
terminal, so a dropped event did not lose one event — it withheld every later
event for the life of that session, and since a chunk is immutable no amount of
polling brought them back. "Logged rather than silent" on the bridge was an
outage on the phone. The reader no longer behaves that way (see *Fixed* below),
which is what makes this a bounded loss rather than the thing it was.

### 22. The phone package has no test runner

`packages/phone` is a standalone package with its own lockfile and no test
script. Its five fixes from the review are covered by typecheck and build only.
The one with logic shared with the bridge — the liveness heartbeat contract — is
covered from the bridge side.

**Status:** accepted gap. Adding vitest there means touching its lockfile, which
was judged a worse trade than the gap.

**Worse than it looked.** "Covered by typecheck" was not true either: the root
`npm run typecheck` runs `--workspaces`, and `packages/phone` is not a workspace,
so the phone was being skipped silently — the only thing checking it was
`vite build`, which does not typecheck at all. The root script now runs both of
the phone's passes (`vue-tsc` and its node-side `tsc`). Whether the phone asked
to be covered by typecheck was moot while nothing was running it.

### 23. The writer's ordering is pinned by pattern, not end to end

`packages/bridge/test/queue.test.ts` asserts the invariant through a real
`ChunkWriter`, but it drives the queue the way `Bridge` does rather than driving
`Bridge` itself. The interleaving that caused the tear reached `#confirmDelivery`
through prompt injection, which needs a live control pipe, a `ccr` registration
and a relay — enough scaffolding that the test would be mostly scaffolding.

**Consequence:** the queue is tested; its *use* is not. A future producer that
wrote without going through `runtime.queue` would not fail a test — it would fail
on someone's phone. That the reader is now robust to exactly this is the reason
this is a gap rather than a bug.

**Status:** open, accepted. Worth revisiting if a producer is ever added outside
`#tickSession`, `#recordInjection` and `#recordAttention`, which are the three
that hold the queue today.

### 4. ~~Inbound prompts are never consumed~~ — RESOLVED

`#pollInbound` verifies prompts and records the outcome, but does not move them
to `in/.done/`. Injection needs the `ccr` wrapper (M6), and consuming a prompt we
cannot deliver would lose it silently.

**Consequence:** `in/` accumulates. A `seenPrompts` set prevents re-reporting,
so this is untidy rather than harmful — until M6 lands.

**Resolved:** `#pollInbound` now delivers and calls `markConsumed`, which moves
the file to `in/.done/`. A `seenPrompts` set remains as a safety net. The
inbound fetch also recovers from a failed push rather than wedging — see the
note under issue 3.

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

### 8. ~~The permission-dialog gate is inference-only~~ — RESOLVED by hooks, with one accepted gap

**Resolved** by the hooks integration (M7). The bridge runs a loopback receiver;
a forwarder script, installed into Claude Code settings, posts each hook event to
it. The safety-critical signal is **`PreToolUse` with no matching completion**,
because `PreToolUse` runs *before* the permission check — so a dialog-blocked call
is "in flight" from the moment the dialog opens.

`Notification`/`permission_prompt` is used as well, but **cannot be the primary
signal**: it fires several seconds after the dialog appears. Relying on it alone
would leave a window in which a prompt could be typed into a dialog.

The transcript rule still applies for sessions without hooks, so nothing is
weakened where hooks are absent.

**Accepted residual risk:** if hooks stop silently *while a session is idle*,
they remain trusted for that session and a dialog appearing afterwards would be
missed. Detecting it by timeout was rejected deliberately — an idle session with
no hook events for an hour is the normal, healthy case, and a timeout would
refuse exactly the sessions this milestone exists to unblock. Hook state is also
in memory only, so a bridge restart falls back to the transcript until the
session's next turn.

<details><summary>Original report</summary>

Injecting while a permission dialog is open would **answer the dialog** rather
than type the prompt — potentially auto-approving a tool. Detecting that from
the tail alone is guesswork; the reliable detector is a `PreToolUse`/
`PostToolUse` hook pair (M7).

**Status:** superseded by the hooks receiver above.

</details>

---

## Open — surfaced by the phone build

### 9. ~~The tree listing grows without bound~~ — RESOLVED

The phone discovered files with `git/trees/relay-out?recursive=1`, whose payload
grew with total history and cost two API requests per poll.

**Resolved** by removing tree listing entirely. Discovery is now two small files —
`out/index.json` for the session list and `out/sessions/<id>/head.json` for an
open session — and chunks are fetched by number from a `chunkFirst..chunkLast`
range. A range is O(1) however much history exists, which is exactly what a
listing could not be. Retention (rolling ~10 MB per session, oldest chunk
deleted) bounds the relay itself. See `docs/RELAY-DESIGN.md`.

### 19. ~~An orphaned bridge can survive its parent~~ — RESOLVED

**Resolved** by replacing the pid lock with a **heartbeat**. The holder refreshes
a timestamp; a newcomer refuses while that timestamp is fresh, which detects a
live writer regardless of which process started it. A pid cannot: an orphaned
bridge outlives the parent whose pid the old lock recorded, so a stale lock was
taken over while the orphan was still writing.

Verified: a lock 60 seconds old is taken over with a note naming the previous
holder; a fresh one is refused with how long ago it was last seen.

<details><summary>Original report</summary>

Observed for real: two bridges ran at once against one state directory, one
holding stale code. They interleaved writes to the same chunk files, so some
chunks carried valid checksums and most did not — a pattern that looks like
corruption in the data rather than two processes fighting over it.

The cause is that stopping an `npm run` wrapper does not reliably stop the node
process it spawned, and the lock file records the pid of the process doing the
work, so a surviving parent is invisible to it.

**What helped:** the lock catches the common case, and killing by command-line
pattern found both. **What would help more:** a heartbeat lock, where the holder
rewrites a timestamp periodically and a newcomer refuses while it is fresh, which
detects a live writer regardless of which pid started it.

**Status:** open. Practical mitigation is to run one bridge and check for strays
before starting another.

</details>

### 17. The reader's cache is smaller than the retention window

The phone caches fetched chunks in `localStorage`, bounded at ~3 MB, while a
session retains ~10 MB. A large session therefore cannot be held whole, and
because assembly runs contiguously from `chunkFirst`, losing the *oldest* cached
chunk blocks the timeline until it is refetched.

**Status:** pre-existing, but it matters more now that chunks are the only thing
cached. IndexedDB is the real fix.

### 18. The sentinel's CRC is weak and was silently changed once

`crc32` covers `"<firstSeq>:<lines>"`, which the reader can derive from the chunk
itself — so it detects truncation, not corruption. It is also a protocol detail
shared by two languages, and it **was changed in M8 without the reader being
updated**, so every chunk would have failed validation.

The stronger check in practice is `sentinel.lines === events.length`.

**Status:** formats verified matching. Worth a shared fixture if either side
changes again.

### 15. Publishing on turn boundaries means no live streaming

A deliberate trade, chosen knowingly: reaching 10 s freshness over git push
requires ~8,600 pushes a day, which both abuses the provider and blows the free
storage tier. Streaming prose now arrives in batches at turn boundaries.

**Accepted, not a defect.** Recorded so it is not later mistaken for one.

### 16. Session data can be pruned while the phone is asleep

Retention deletes chunks the phone may be holding an index into. A phone that
slept through heavy activity can find `chunkFirst` has advanced past what it had.
The UI must present this as "history not retained" rather than as a gap, and the
reader must not treat a pruned chunk as an error.

**Status:** handled in the contract, being implemented in the phone.

### 10. A skewed phone clock makes prompts fail silently

The bridge refuses prompts older than 10 minutes or more than 60 s in the future.
A phone whose clock is off writes a file that is then rejected, and the UI shows
"no acknowledgement seen" — with nothing anywhere identifying the cause.

**Status:** not implemented. Options: a clock-skew check against the server's
`Date` header, or surfacing rejections more loudly.

### 11. ~~`controllable` does not mean injection is enabled~~ — RESOLVED

The composer is enabled by `state.controllable`, but `CCR_ALLOW_INJECTION` also
has to be on for a prompt to actually run. With it off, prompts are accepted into
`in/` and never executed, and the UI honestly reports them as unacknowledged
rather than explaining why.

**Resolved** by publishing the policy in `head.json` as well as `index.json`.
`index.json` alone was not enough, and the reason is structural rather than an
oversight: the index is only read while *browsing*, and a session opened directly
— a deep link, a reload — polls the head and nothing else. Its copy of the flag
was therefore not stale but **absent**, and absent read as "off", so the composer
told the user prompts were disabled on a PC that had them on. The head is the one
file always polled for an open session, so the flag belongs there; the index
stays as the fallback for a reader too old to look for it in the head.

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
| **Every prompt sent from the phone tore the session's stream** | Two producers allocate sequence numbers on independent schedules. Every suite drove one producer at a time, so the interleaving only existed when the real bridge ran both. |
| **The reader turned one hole into a whole-session outage** | No fixture could produce a discontinuity that was survivable, so the rule "withhold everything after a break" was only ever tested against breaks it was supposed to reject. |

### The tear, and why it took the whole session with it

Two defects, one visible and one not.

A prompt typed into a session is acknowledged by writing an `injection` event,
and that ran *inside* the loop appending a transcript line's events. A `user`
line yields two events — a `user_prompt` and a `turn_start` — numbered 7 and 8
before either is written, and confirming the delivery between them took 9 and
wrote it first. The chunk read `… 7, 9, 8 …`. Every prompt sent from the phone
did this and none typed at the PC, because only an injected prompt has a delivery
to confirm.

Underneath it sat the second defect. The reader required a gapless ascending
sequence and withheld everything after the first break, so a mis-ordered pair did
not cost an ordering — it hid the rest of the session, permanently, because a
chunk is immutable and the same bytes produce the same verdict on every poll. The
reply to that very prompt was sitting in the chunk, unshowable.

Both are fixed, and the split is the point. The **writer** now keeps the ordering
promise: one serialised queue per session, taking a sequence number and writing
the event as a single step, with the delivery confirmation moved out of the
append loop. The **reader** no longer depends on that promise: events are ordered
by their own sequence numbers, so reordering is repaired rather than reported, and
only genuine absence is. Either fix alone would have hidden the bug rather than
fixed it — the writer's would leave every chunk already published broken, and the
reader's would leave the record wrong. Only the reader's is retroactive, because
nothing re-writes a sealed chunk.


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
