import { Duration, Effect, Layer } from "effect";
import * as v from "valibot";
import { DiskCollector } from "../services/disk-collector.ts";
import { CollectorError } from "../types/errors.ts";
import { BytesPerSec, type DiskSnapshot, Timestamp } from "../types/metrics.ts";
import { collectorStream } from "./collector-stream.ts";
import { spawnText } from "./spawn.ts";

/**
 * macOS disk collector. `iostat -d -c 2 -w 1` prints two reports; the first is a
 * since-boot average and the second is the 1s interval, so we use the **last**
 * data row. Each disk contributes three columns (KB/t, tps, MB/s); we sum the
 * MB/s columns for combined throughput across all disks.
 */

const COLLECTOR = "disk";

const MIB = 1024 * 1024;

/**
 * Pure: total disk throughput (bytes/sec) from `iostat -d -c 2 -w 1` output.
 * Data rows are all-numeric and have a multiple-of-three column count; the MB/s
 * value is every third column (index 2, 5, …). Uses the last data row. Returns
 * `null` if no data row is present.
 */
export function parseDiskThroughput(raw: string): { bytesPerSec: number } | null {
  let last: number[] | null = null;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const nums = trimmed.split(/\s+/).map(Number);
    if (nums.length === 0 || nums.length % 3 !== 0) continue;
    if (!nums.every((n) => Number.isFinite(n))) continue;
    last = nums;
  }
  if (last === null) return null;
  let mbPerSec = 0;
  for (let i = 2; i < last.length; i += 3) mbPerSec += last[i]!;
  return { bytesPerSec: mbPerSec * MIB };
}

/** Boundary schema for the parsed throughput; failure → `CollectorError`. */
const RawDiskSchema = v.object({
  bytesPerSec: v.pipe(v.number(), v.finite(), v.minValue(0)),
});

/** One reading: run `iostat`, take the interval row, validate, brand. */
const read: Effect.Effect<DiskSnapshot, CollectorError> = Effect.gen(
  function* () {
    const raw = yield* spawnText(
      ["iostat", "-d", "-c", "2", "-w", "1"],
      COLLECTOR,
    );

    const parsed = parseDiskThroughput(raw);
    if (parsed === null) {
      return yield* new CollectorError({
        collector: COLLECTOR,
        reason: "could not parse any data row from `iostat`",
      });
    }

    const result = v.safeParse(RawDiskSchema, parsed);
    if (!result.success) {
      return yield* new CollectorError({
        collector: COLLECTOR,
        reason: `disk throughput failed validation: ${v.summarize(result.issues)}`,
        cause: result.issues,
      });
    }

    return {
      _tag: "disk",
      at: Timestamp(Date.now()),
      bytesPerSec: BytesPerSec(result.output.bytesPerSec),
    } satisfies DiskSnapshot;
  },
);

/** `read` already blocks ~1s for its own interval, so add only a small gap. */
const POLL_GAP = Duration.millis(500);

const stream = collectorStream("disk", read, POLL_GAP);

/** Live macOS implementation of {@link DiskCollector}. */
export const DiskCollectorMacOSLive = Layer.succeed(
  DiskCollector,
  DiskCollector.of({ read, stream }),
);
