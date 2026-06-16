import { Duration, Effect, Layer } from "effect";
import * as v from "valibot";
import { MemoryCollector } from "../services/memory-collector.ts";
import { CollectorError } from "../types/errors.ts";
import { Bytes, type MemorySnapshot, Percent, Timestamp } from "../types/metrics.ts";
import { collectorStream } from "./collector-stream.ts";
import { readProcFile } from "./proc.ts";

/**
 * Linux memory collector. `/proc/meminfo` is instantaneous (no diff needed):
 * `used = MemTotal − MemAvailable`. `MemAvailable` is the kernel's own estimate
 * of memory available for new work (accounting for reclaimable cache), which is
 * the closest analog to macOS Activity Monitor's "Memory Used". Values are in kB.
 */

const COLLECTOR = "memory";

const PROC_MEMINFO = "/proc/meminfo";

const KB = 1024;

const meminfoField = (name: string): RegExp =>
  new RegExp(`^${name}:\\s*(\\d+)\\s*kB`, "m");

const MEM_TOTAL = meminfoField("MemTotal");
const MEM_AVAILABLE = meminfoField("MemAvailable");

const matchKb = (raw: string, re: RegExp): number | null => {
  const m = re.exec(raw);
  return m ? Number(m[1]) : null;
};

/** The raw memory shape derived from `/proc/meminfo`, before branding. */
export interface RawMemory {
  readonly usedBytes: number;
  readonly totalBytes: number;
  readonly usedPercent: number;
}

/**
 * Pure: compute used/total/percent from `/proc/meminfo` text. Requires both
 * `MemTotal` and `MemAvailable`; returns `null` if either is missing or `MemTotal`
 * is non-positive. Exported for unit testing.
 */
export function parseMeminfo(raw: string): RawMemory | null {
  const totalKb = matchKb(raw, MEM_TOTAL);
  const availableKb = matchKb(raw, MEM_AVAILABLE);
  if (totalKb === null || availableKb === null) return null;
  if (!(totalKb > 0)) return null;

  const totalBytes = totalKb * KB;
  const usedBytes = Math.max(0, (totalKb - availableKb) * KB);
  const usedPercent = Math.min(100, (usedBytes / totalBytes) * 100);
  return { usedBytes, totalBytes, usedPercent };
}

/** Boundary schema for the computed memory shape; failure → `CollectorError`. */
const RawMemorySchema = v.object({
  usedBytes: v.pipe(v.number(), v.finite(), v.minValue(0)),
  totalBytes: v.pipe(v.number(), v.finite(), v.minValue(1)),
  usedPercent: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(100)),
});

/** One memory reading: read `/proc/meminfo`, compute, validate, then brand. */
const read: Effect.Effect<MemorySnapshot, CollectorError> = Effect.gen(
  function* () {
    const raw = yield* readProcFile(PROC_MEMINFO, COLLECTOR);

    const computed = parseMeminfo(raw);
    if (computed === null) {
      return yield* new CollectorError({
        collector: COLLECTOR,
        reason: "could not parse MemTotal/MemAvailable from /proc/meminfo",
      });
    }

    const result = v.safeParse(RawMemorySchema, computed);
    if (!result.success) {
      return yield* new CollectorError({
        collector: COLLECTOR,
        reason: `memory output failed validation: ${v.summarize(result.issues)}`,
        cause: result.issues,
      });
    }

    const { usedBytes, totalBytes, usedPercent } = result.output;
    return {
      _tag: "memory",
      at: Timestamp(Date.now()),
      usedPercent: Percent(usedPercent),
      usedBytes: Bytes(usedBytes),
      totalBytes: Bytes(totalBytes),
    } satisfies MemorySnapshot;
  },
);

/** `/proc/meminfo` is cheap and instantaneous, so we can poll once a second. */
const POLL_GAP = Duration.seconds(1);

const stream = collectorStream("memory", read, POLL_GAP);

/** Live Linux implementation of {@link MemoryCollector}. */
export const MemoryCollectorLinuxLive = Layer.succeed(
  MemoryCollector,
  MemoryCollector.of({ read, stream }),
);
