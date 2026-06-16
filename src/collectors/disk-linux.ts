import { Duration, Effect, Layer } from "effect";
import * as v from "valibot";
import { DiskCollector } from "../services/disk-collector.ts";
import { CollectorError } from "../types/errors.ts";
import { BytesPerSec, type DiskSnapshot, Timestamp } from "../types/metrics.ts";
import { collectorStream } from "./collector-stream.ts";
import { readProcFile } from "./proc.ts";

/**
 * Linux disk collector. `/proc/diskstats` reports **cumulative** sector counters
 * per device, so throughput comes from diffing two samples ~1s apart. Each line is
 * `major minor name reads merged sectorsRead readMs writes wMerged sectorsWritten …`;
 * bytes = sectors × 512. We sum read+write across whole disks (combined throughput,
 * matching `DiskSnapshot`), excluding partitions so the same I/O isn't counted twice.
 */

const COLLECTOR = "disk";

const PROC_DISKSTATS = "/proc/diskstats";

/** Bytes per 512-byte sector, the fixed unit `/proc/diskstats` reports. */
const SECTOR = 512;

/** Column indices (0-based, whole line) of the cumulative sector counters. */
const NAME_INDEX = 2;
const SECTORS_READ_INDEX = 5;
const SECTORS_WRITTEN_INDEX = 9;

/**
 * Whole physical/virtual disks only. Partitions (`sda1`, `nvme0n1p1`, …) repeat
 * their parent disk's I/O and would double-count; pseudo devices (`loop*`, `ram*`,
 * `dm-*`) are excluded too.
 */
const WHOLE_DISK =
  /^(sd[a-z]+|vd[a-z]+|hd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;

/** Cumulative sector counters summed across counted disks. */
export interface DiskTotals {
  readonly sectorsRead: number;
  readonly sectorsWritten: number;
}

/**
 * Pure: sum cumulative read+write sectors from `/proc/diskstats`, counting only
 * whole disks (see {@link WHOLE_DISK}). Returns `null` if no disk row parsed.
 * Exported for unit testing.
 */
export function parseDiskStats(raw: string): DiskTotals | null {
  let sectorsRead = 0;
  let sectorsWritten = 0;
  let matched = 0;
  for (const line of raw.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length <= SECTORS_WRITTEN_INDEX) continue;
    const name = cols[NAME_INDEX]!;
    if (!WHOLE_DISK.test(name)) continue;
    const read = Number(cols[SECTORS_READ_INDEX]);
    const written = Number(cols[SECTORS_WRITTEN_INDEX]);
    if (!Number.isFinite(read) || !Number.isFinite(written)) continue;
    sectorsRead += read;
    sectorsWritten += written;
    matched += 1;
  }
  return matched === 0 ? null : { sectorsRead, sectorsWritten };
}

/**
 * Pure: combined read+write throughput (bytes/sec) between two cumulative samples.
 * Counter resets clamp to 0. Returns `null` for a non-positive interval. Exported
 * for unit testing.
 */
export function computeDiskThroughput(
  prev: DiskTotals,
  next: DiskTotals,
  elapsedMs: number,
): { bytesPerSec: number } | null {
  if (!(elapsedMs > 0)) return null;
  const prevSectors = prev.sectorsRead + prev.sectorsWritten;
  const nextSectors = next.sectorsRead + next.sectorsWritten;
  const sectors = Math.max(0, nextSectors - prevSectors);
  return { bytesPerSec: (sectors * SECTOR) / (elapsedMs / 1000) };
}

/** Boundary schema for the computed throughput; failure → `CollectorError`. */
const RawDiskSchema = v.object({
  bytesPerSec: v.pipe(v.number(), v.finite(), v.minValue(0)),
});

/** How long to wait between the two cumulative samples. */
const SAMPLE_INTERVAL = Duration.seconds(1);

const sampleTotals: Effect.Effect<DiskTotals, CollectorError> = Effect.gen(
  function* () {
    const raw = yield* readProcFile(PROC_DISKSTATS, COLLECTOR);
    const totals = parseDiskStats(raw);
    if (totals === null) {
      return yield* new CollectorError({
        collector: COLLECTOR,
        reason: "could not parse any disk from /proc/diskstats",
      });
    }
    return totals;
  },
);

/** One reading: sample, wait, sample again, diff into bytes/sec, validate, brand. */
const read: Effect.Effect<DiskSnapshot, CollectorError> = Effect.gen(function* () {
  const startedAt = Date.now();
  const first = yield* sampleTotals;
  yield* Effect.sleep(SAMPLE_INTERVAL);
  const second = yield* sampleTotals;
  const elapsedMs = Date.now() - startedAt;

  const parsed = computeDiskThroughput(first, second, elapsedMs);
  if (parsed === null) {
    return yield* new CollectorError({
      collector: COLLECTOR,
      reason: "non-positive sample interval",
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
});

/** `read` already blocks ~1s for its own delta, so add only a small gap. */
const POLL_GAP = Duration.millis(500);

const stream = collectorStream("disk", read, POLL_GAP);

/** Live Linux implementation of {@link DiskCollector}. */
export const DiskCollectorLinuxLive = Layer.succeed(
  DiskCollector,
  DiskCollector.of({ read, stream }),
);
