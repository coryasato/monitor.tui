import { Effect } from "effect";
import { CollectorError } from "../types/errors.ts";

/**
 * Read a procfs file (e.g. `/proc/stat`) and return its contents as text, as an
 * Effect. The Linux analog of {@link spawnText}: collectors read kernel-exported
 * virtual files directly rather than shelling out to a tool.
 *
 * No subprocess is spawned, so there is nothing to kill on interruption — these
 * reads are instantaneous. The interruptible points in the stateful collectors
 * are the `Effect.sleep`s *between* samples, which cancel cleanly on Ctrl+C.
 * A failed read (file missing / not Linux) becomes a `CollectorError`.
 */
export const readProcFile = (
  path: string,
  collector: string,
): Effect.Effect<string, CollectorError> =>
  Effect.tryPromise({
    try: () => Bun.file(path).text(),
    catch: (cause) =>
      new CollectorError({
        collector,
        reason: `failed to read \`${path}\``,
        cause,
      }),
  });
