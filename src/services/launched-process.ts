import { Effect, type Scope } from "effect";
import { CollectorError } from "../types/errors.ts";
import { ProcessId } from "../types/metrics.ts";

/**
 * A command launched *under* the monitor (`monitor -- <command…>`). Attaching to
 * an existing PID can only observe "it vanished from `ps`"; on macOS you cannot
 * `wait()` on a non-child or read its stderr. Spawning the command as our own
 * child unlocks the real exit code/signal (via `child.exited`) and its stderr —
 * the data behind Feature 4's live view and Feature 5's crash report.
 *
 * The child is spawned **detached** (its own process group via `setsid`) so we
 * can signal the whole subtree at once — wrapper commands (`bun run …`, `sh -c …`)
 * do their real work in grandchildren. On monitor quit the acquireRelease
 * finalizer kills that group by default (`killOnExit`); `--no-kill-on-exit`
 * leaves it running (its stderr pipe then closes, which the child sees as EPIPE).
 * stdout is discarded for the MVP; stderr is captured into a bounded line ring.
 */

/** Collector label for launch failures (a recoverable `CollectorError`, surfaced as a toast). */
const LAUNCH = "launch";

/**
 * A bounded ring buffer of the most recent stderr lines. Chunks arrive as decoded
 * text and may split a line across chunk boundaries, so a partial line is carried
 * until its newline arrives. Retains at most `capacity` complete lines (oldest
 * dropped). Pure and synchronous — exported for unit testing.
 */
export class LineRing {
  private readonly lines: string[] = [];
  private partial = "";

  constructor(private readonly capacity: number) {}

  /** Feed a decoded text chunk, splitting on `\n` and capping the retained lines. */
  push(chunk: string): void {
    let text = this.partial + chunk;
    let nl = text.indexOf("\n");
    while (nl >= 0) {
      this.append(text.slice(0, nl));
      text = text.slice(nl + 1);
      nl = text.indexOf("\n");
    }
    this.partial = text;
  }

  /** Flush a trailing partial line (no final newline), e.g. at stream EOF. */
  flush(): void {
    if (this.partial.length > 0) {
      this.append(this.partial);
      this.partial = "";
    }
  }

  private append(line: string): void {
    // Strip a trailing CR so CRLF output reads cleanly.
    this.lines.push(line.endsWith("\r") ? line.slice(0, -1) : line);
    if (this.lines.length > this.capacity) this.lines.shift();
  }

  /** Snapshot of the retained lines, oldest→newest, including any pending partial line. */
  snapshot(): ReadonlyArray<string> {
    return this.partial.length > 0 ? [...this.lines, this.partial] : [...this.lines];
  }
}

/** The real exit outcome of a launched child, read from Bun's subprocess handle. */
export interface ExitInfo {
  readonly exitCode: number | null;
  readonly signalCode: string | null;
}

/** The live handle a launched command exposes to the app (focus wiring, exit, stderr). */
export interface LaunchedHandle {
  /** The child's PID — auto-pinned in the focus view. */
  readonly pid: ProcessId;
  /** The launched command joined for display (e.g. the focus header). */
  readonly command: string;
  /** Resolves once when the child exits, with the real code/signal. Never fails. */
  readonly awaitExit: Effect.Effect<ExitInfo>;
  /** The current captured stderr tail (oldest→newest). Feeds Feature 5's report. */
  readonly stderrTail: () => ReadonlyArray<string>;
}

export interface LaunchOptions {
  readonly stderrLines: number;
  readonly killOnExit: boolean;
}

/**
 * Spawn `command` as a monitored child, as a scope-bound resource. The returned
 * effect requires a {@link Scope.Scope}: the child's process group is killed (when
 * `killOnExit`) and the stderr pump interrupted when that scope closes — i.e. on a
 * clean monitor quit. A spawn failure is a recoverable {@link CollectorError} (the
 * caller toasts it and keeps running), not a crash.
 */
export const launchProcess = (
  command: ReadonlyArray<string>,
  options: LaunchOptions,
): Effect.Effect<LaunchedHandle, CollectorError, Scope.Scope> =>
  Effect.gen(function* () {
    const ring = new LineRing(options.stderrLines);

    const proc = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          Bun.spawn([...command], {
            stdin: "ignore",
            stdout: "ignore", // discarded for the MVP
            stderr: "pipe", // captured into the ring buffer
            // Own process group (setsid) so we can group-kill the whole subtree.
            detached: true,
          }),
        catch: (cause) =>
          new CollectorError({
            collector: LAUNCH,
            reason: `failed to launch \`${command.join(" ")}\``,
            cause,
          }),
      }),
      (child) =>
        Effect.sync(() => {
          if (!options.killOnExit) return;
          // Negative pid → the whole process group (child spawned detached, so it
          // leads its own group). Falls back to the direct child if the group is
          // already gone. ESRCH (already exited) is expected and ignored.
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            try {
              child.kill();
            } catch {
              /* already gone */
            }
          }
        }),
    );

    const pid = ProcessId(proc.pid);

    // Pump stderr into the ring on a scope-bound fiber. Ends at EOF (the child's
    // stderr closes on exit); interrupted early on a clean quit. Either way the
    // finalizer flushes the last partial line and releases the reader.
    const decoder = new TextDecoder();
    const pump = Effect.suspend(() => {
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      const loop = Effect.gen(function* () {
        while (true) {
          const chunk = yield* Effect.promise(() => reader.read());
          if (chunk.done) break;
          if (chunk.value) ring.push(decoder.decode(chunk.value, { stream: true }));
        }
      });
      return loop.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            ring.flush();
            reader.cancel().catch(() => {});
          }),
        ),
      );
    });
    yield* Effect.forkScoped(pump);

    const awaitExit: Effect.Effect<ExitInfo> = Effect.map(
      Effect.promise(() => proc.exited),
      () => ({ exitCode: proc.exitCode, signalCode: proc.signalCode }),
    );

    return {
      pid,
      command: command.join(" "),
      awaitExit,
      stderrTail: () => ring.snapshot(),
    };
  });
