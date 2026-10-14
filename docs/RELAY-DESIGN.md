# Relay data organisation

How the relay repository is laid out, and why. This replaced an earlier design
that discovered files by listing the whole git tree, which grew without bound and
cost two API requests per poll.

## Why the first design failed

The phone found its data with `GET /git/trees/relay-out?recursive=1`. Three
problems compounded:

1. **The listing grew with total history.** Every sealed chunk is a blob entry
   forever, so the polled payload grew forever.
2. **Polling the branch ref first bought nothing.** Publishing amended and
   force-pushed, so the head SHA moved whenever anything changed.
3. **The repository grew anyway.** This was the non-obvious one: amending makes
   the previous commit *unreachable*, not *deleted*. Those objects sit on the
   server until a `gc` prunes them, and the default prune window is two weeks.
   At a 10s publish cadence each push left roughly 15 KB of loose objects, so
   ~8,600 pushes a day produced ~130 MB a day of garbage — fatal against a
   ~500 MB free tier, no matter how tidy the reachable history looked.

The lesson: **push frequency, not repository layout, was the binding constraint.**

## Publish policy

Publishing happens on **turn boundaries and attention signals only** — when a
turn ends, when a session blocks waiting for input, and when a prompt is
injected. There is no periodic timer.

Worst case is roughly 1,400 pushes a day and ~3 MB of churn, which a `gc` can
comfortably keep ahead of. The signals that matter — *Claude needs you*, *that
turn finished* — arrive immediately; streaming prose arrives in batches.

This deliberately gives up watching text appear token by token. That is not
achievable over git push: reaching 10s freshness requires ~8,600 pushes a day,
which is both abusive to the provider and fatal to the storage quota.

## Layout

```
out/index.json                       STABLE — the session list
out/sessions/<id>/head.json          HOT but tiny (~200 B) — status, cost, chunk range
out/sessions/<id>/events-NNNN.jsonl  immutable chunks, rolling retention
out/sessions/<id>/subagents.json     metadata-only subagent forest
```

**`head.json` carries a chunk-series generation.** Chunk numbers are immutable
*within a series*, but the series itself can be rebuilt — clearing the output
directory, or a session cold-starting — and then `events-0001.jsonl` holds
different events under the same name. A reader caching by path alone served the
old bytes and reported a stream gap in data that was verified contiguous. The
generation is an opaque token minted when the writer creates a session's output
directory and persisted with its bookkeeping, so it survives a restart and
changes on a rebuild and nothing else. The reader includes it in its cache key
and drops the previous generation's entries, which are dead weight. The field is
optional on the wire, and **absent means "assume it matches"** — that keeps an
older bridge readable at the cost of the protection the token exists to give.

**Two files rather than one** because they change at different rates and are read
at different times. The session list is loaded once when browsing; `head.json` is
polled only while a session is actually open.

That split also removes a coupling the single index had: with one global file,
any session advancing invalidated the ETag, so a phone watching session B
re-downloaded an index covering every session whenever session A emitted
anything.

**Chunks are immutable and numbered sequentially.** That is what lets the reader
work without a file listing: it needs only `chunkFirst..chunkLast` to know what
exists, and fetches whatever numbers it lacks. A range is O(1) regardless of how
much history there is — which is precisely what the tree listing could not do.

## Retention

Rolling, by total bytes per session (default 10 MB). When a session exceeds the
cap, the **oldest chunk files are deleted** and `chunkFirst` advances.

Deliberately *not* an `archive.jsonl` that older events are folded into. A file
trimmed from the front is rewritten on every compaction, which breaks the
immutability everything else depends on: the phone caches each chunk it fetches
permanently, and a rewritten file can never be cached. Deleting the oldest chunk
keeps every surviving file immutable and cacheable.

The cost is real and accepted: history older than the window is simply gone. The
reader distinguishes that from a genuine gap — "history before sequence N is not
retained" rather than "stream gap", because a gap means something is broken.

## Reader protocol

| View | Polls | Cadence |
|---|---|---|
| Session list | `out/index.json` | 60s — it rarely changes |
| Session open | `sessions/<id>/head.json` | ~15s while the session is active, 60s otherwise |

Polling stops entirely while the page is hidden and resumes on the next
`visibilitychange`, because a backgrounded phone is frozen anyway and every
request costs quota.

Polling faster than the publish cadence buys nothing: publishing happens on turn
boundaries, so most polls would return `304` — which Gitee charges for.

Chunks are fetched by number for whatever is missing in the retained range.
Two hazards are handled explicitly:

- **404 on a just-pushed chunk.** Gitee's Contents API lags the git ref by a few
  seconds, so a chunk named in `head.json` may briefly 404. Treated as
  in-flight — retry shortly — not as a missing file.
- **A burst after the phone wakes.** Background tabs are frozen, so a phone that
  slept through a long run finds many missing chunks at once. They are fetched
  gradually; requesting them all immediately is what trips a `429`.

A sequence discontinuity is only reported as a hole once the whole retained
range has been read. While chunks it has not fetched are outstanding, the reader
says "catching up": a gap it has not yet had the chance to disprove is not the
same finding as one it has, and "torn" is a claim about the record that a reader
which is merely behind has no standing to make.

## Constraints this design works within

- **Gitee charges quota for `304 Not Modified`**, unlike GitHub, so conditional
  requests save bandwidth but never requests.
- **No rate-limit headers are returned on authenticated requests**, and
  `/api/v5/rate_limit` is a 404. The client cannot see its own quota and must
  back off reactively on `429`/`403`. Any specific "requests per day" figure
  quoted for Gitee should be treated as unverified — only the anonymous limit of
  60 has been observed.
- The Contents API returns file contents base64-encoded, inflating by ~33%.
