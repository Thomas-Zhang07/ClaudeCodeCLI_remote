/**
 * One writer at a time, per session.
 *
 * A sequence number is allocated by whoever produced the event — a transcript
 * line hands one out for every event it yields, and a bridge-originated event
 * takes the next when it is recorded — and the event is then written to a chunk.
 * Those two steps must not be interleaved. A batch numbered `7, 8` and appended
 * one event at a time can have a `9` written between them by a caller arriving
 * during the first `await`, and the chunk then reads `7, 9, 8`.
 *
 * That is not cosmetic. The record is append-only and its chunks are immutable,
 * so a reader meeting `7, 9` has to decide what the `8` that follows means, and
 * no answer is right: the events are all present, but the order they were
 * promised in is broken. (The reader restores the order rather than trusting it
 * — see `assembleStream` — because chunks already published cannot be repaired.
 * That is a safety net, not a licence: an ordered log is the writer's promise,
 * and this is where it is kept.)
 */
export class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();

  /**
   * Run `task` once everything already queued has finished.
   *
   * A task that throws does not poison the queue. The chain continues either
   * way, because one failed append must not stop a session's stream forever —
   * the failure is reported to the caller that queued it, and to nobody else.
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(task, task);
    this.#tail = result.then(noop, noop);
    return result;
  }
}

function noop(): void {
  // Deliberately empty: the queue tracks only completion, never outcome.
}
