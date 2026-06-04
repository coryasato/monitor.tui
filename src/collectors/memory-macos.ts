import { Duration, Effect, Layer } from "effect";
import * as v from "valibot";
import { MemoryCollector } from "../services/memory-collector.ts";
import { CollectorError } from "../types/errors.ts";
import { Bytes, type MemorySnapshot, Percent, Timestamp } from "../types/metrics.ts";
import { collectorStream } from "./collector-stream.ts";
import { spawnText } from "./spawn.ts";

/**
 * macOS memory collector. Reads page counts from `vm_stat` and totals from
 * `sysctl`. "Used" follows Activity Monitor's definition:
 * `(active + wired + compressed) * pageSize`.
 */

const COLLECTOR = "memory";

const pageField = (name: string): RegExp =>
  new RegExp(`${name}:\\s*(\\d+)\\.`);

const ACTIVE = pageField("Pages active");
const WIRED = pageField("Pages wired down");
const COMPRESSED = pageField("Pages occupied by compressor");

const matchInt = (raw: string, re: RegExp): number | null => {
  const m = re.exec(raw);
  return m ? Number(m[1]) : null;
};

/** The raw memory shape parsed from `vm_stat` + `sysctl`, before branding. */
export interface RawMemory {
  readonly usedBytes: number;
  readonly totalBytes: number;
  readonly usedPercent: number;
}

/**
 * Pure: compute used/total/percent from `vm_stat` stdout plus the total RAM and
 * page size (from `sysctl`). Returns `null` if a required page field is missing
 * or the totals are non-positive. Exported for unit testing.
 */
export function computeMemory(
  vmStat: string,
  totalBytes: number,
  pageSize: number,
): RawMemory | null {
  if (!(totalBytes > 0) || !(pageSize > 0)) return null;
  const active = matchInt(vmStat, ACTIVE);
  const wired = matchInt(vmStat, WIRED);
  const compressed = matchInt(vmStat, COMPRESSED);
  if (active === null || wired === null || compressed === null) return null;

  const usedBytes = (active + wired + compressed) * pageSize;
  const usedPercent = Math.min(100, (usedBytes / totalBytes) * 100);
  return { usedBytes, totalBytes, usedPercent };
}

/** Parse the two integers printed by `sysctl -n hw.memsize hw.pagesize`. */
function parseSysctl(raw: string): { totalBytes: number; pageSize: number } | null {
  const [total, page] = raw.trim().split(/\s+/).map(Number);
  if (total === undefined || page === undefined) return null;
  if (!Number.isFinite(total) || !Number.isFinite(page)) return null;
  return { totalBytes: total, pageSize: page };
}

/** Boundary schema for the computed memory shape; failure → `CollectorError`. */
const RawMemorySchema = v.object({
  usedBytes: v.pipe(v.number(), v.finite(), v.minValue(0)),
  totalBytes: v.pipe(v.number(), v.finite(), v.minValue(1)),
  usedPercent: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(100)),
});

/** One memory reading: run `vm_stat` + `sysctl`, compute, validate, then brand. */
const read: Effect.Effect<MemorySnapshot, CollectorError> = Effect.gen(
  function* () {
    const [vmStat, sysctl] = yield* Effect.all(
      [
        spawnText(["vm_stat"], COLLECTOR),
        spawnText(["sysctl", "-n", "hw.memsize", "hw.pagesize"], COLLECTOR),
      ],
      { concurrency: 2 },
    );

    const sys = parseSysctl(sysctl);
    if (sys === null) {
      return yield* new CollectorError({
        collector: COLLECTOR,
        reason: "could not parse `sysctl` memsize/pagesize",
      });
    }

    const computed = computeMemory(vmStat, sys.totalBytes, sys.pageSize);
    if (computed === null) {
      return yield* new CollectorError({
        collector: COLLECTOR,
        reason: "could not parse required fields from `vm_stat`",
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

/** `vm_stat` is cheap and instantaneous, so we can poll a bit faster than CPU. */
const POLL_GAP = Duration.seconds(1);

const stream = collectorStream("memory", read, POLL_GAP);

/** Live macOS implementation of {@link MemoryCollector}. */
export const MemoryCollectorMacOSLive = Layer.succeed(
  MemoryCollector,
  MemoryCollector.of({ read, stream }),
);
