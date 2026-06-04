import { Effect } from "effect";
import { CollectorError } from "../types/errors.ts";

/**
 * Run a command and return its stdout as text, as an interruptible Effect.
 *
 * Spawned via `Bun.spawn` (not `Bun.$`) so the abort signal that
 * `Effect.tryPromise` supplies on interruption can `kill()` the subprocess —
 * otherwise a fiber interrupted mid-read (e.g. Ctrl+C) would leave an orphaned
 * process. Failures become a `CollectorError` tagged with `collector`.
 */
export const spawnText = (
  command: ReadonlyArray<string>,
  collector: string,
): Effect.Effect<string, CollectorError> =>
  Effect.tryPromise({
    try: (signal) => {
      const proc = Bun.spawn([...command], { stdout: "pipe", stderr: "ignore" });
      signal.addEventListener("abort", () => proc.kill(), { once: true });
      return new Response(proc.stdout).text();
    },
    catch: (cause) =>
      new CollectorError({
        collector,
        reason: `failed to run \`${command.join(" ")}\``,
        cause,
      }),
  });
