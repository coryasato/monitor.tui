import { Duration, Effect, Layer } from "effect";
import * as v from "valibot";
import { CpuCollector } from "../services/cpu-collector.ts";
import { CollectorError } from "../types/errors.ts";
import { Percent, type CpuSnapshot, Timestamp } from "../types/metrics.ts";
import { collectorStream } from "./collector-stream.ts";
import { readProcFile } from "./proc.ts";

/**
 * Linux CPU collector. Unlike macOS `top` (which precomputes a delta), `/proc/stat`
 * reports **cumulative** jiffies since boot, so — like the network collector — we
 * sample twice a short interval apart and diff. The aggregate `cpu` line is:
 *
 *   cpu  user nice system idle iowait irq softirq steal guest guest_nice
 *
 * `busy% = 1 − Δ(idle+iowait) / Δtotal`. We split the busy share into user
 * (user+nice) and system (everything else) so the gauge/sparkline get the same
 * `{ user, system, idle }` shape the macOS collector produces, summing to ~100.
 */

const COLLECTOR = "cpu";

const PROC_STAT = "/proc/stat";

/** Cumulative jiffy counters from one `cpu`/`cpuN` line of `/proc/stat`. */
export interface CpuTimes {
  readonly user: number;
  readonly nice: number;
  readonly system: number;
  readonly idle: number;
  readonly iowait: number;
  readonly irq: number;
  readonly softirq: number;
  readonly steal: number;
}

/**
 * Pure: build {@link CpuTimes} from the numeric fields following a `cpu*` label.
 * Older kernels omit the later columns (iowait onward), so those default to 0;
 * the four core counters (user/nice/system/idle) are required. Returns `null` if
 * a required field is missing or non-finite. Exported for unit testing.
 */
export function toCpuTimes(values: ReadonlyArray<number>): CpuTimes | null {
  if (values.length < 4) return null;
  if (!values.every((n) => Number.isFinite(n))) return null;
  return {
    user: values[0]!,
    nice: values[1]!,
    system: values[2]!,
    idle: values[3]!,
    iowait: values[4] ?? 0,
    irq: values[5] ?? 0,
    softirq: values[6] ?? 0,
    steal: values[7] ?? 0,
  };
}

/**
 * Pure: parse the **aggregate** `cpu` line (not the per-core `cpuN` lines) from
 * `/proc/stat` into cumulative counters. Returns `null` if the line is absent or
 * malformed. Exported for unit testing.
 */
export function parseProcStat(raw: string): CpuTimes | null {
  for (const line of raw.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== "cpu") continue; // exact "cpu" — skips "cpu0", "cpu1", …
    return toCpuTimes(cols.slice(1).map(Number));
  }
  return null;
}

const clampPercent = (n: number): number => Math.max(0, Math.min(100, n));
const idleOf = (t: CpuTimes): number => t.idle + t.iowait;
const totalOf = (t: CpuTimes): number =>
  t.user + t.nice + t.system + t.idle + t.iowait + t.irq + t.softirq + t.steal;

/** The raw shape derived from two `/proc/stat` samples, before branding. */
export interface RawCpuUsage {
  readonly user: number;
  readonly system: number;
  readonly idle: number;
}

/**
 * Pure: derive `{ user, system, idle }` percentages from two cumulative samples.
 * `idle` and `user` are computed directly from their deltas; `system` is the rest
 * of the busy time (system+irq+softirq+steal), so the three sum to exactly 100.
 * Returns `null` if no time elapsed between samples (Δtotal ≤ 0). Exported for tests.
 */
export function computeCpuUsage(
  prev: CpuTimes,
  next: CpuTimes,
): RawCpuUsage | null {
  const dTotal = totalOf(next) - totalOf(prev);
  if (!(dTotal > 0)) return null;
  const idle = clampPercent(((idleOf(next) - idleOf(prev)) / dTotal) * 100);
  const user = clampPercent(
    ((next.user + next.nice - prev.user - prev.nice) / dTotal) * 100,
  );
  const system = clampPercent(100 - idle - user);
  return { user, system, idle };
}

/** Boundary schema: derived percentages must be real percentages before branding. */
const RawCpuUsageSchema = v.object({
  user: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(100)),
  system: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(100)),
  idle: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(100)),
});

/** How long to wait between the two cumulative `/proc/stat` samples. */
const SAMPLE_INTERVAL = Duration.seconds(1);

const sampleTimes: Effect.Effect<CpuTimes, CollectorError> = Effect.gen(
  function* () {
    const raw = yield* readProcFile(PROC_STAT, COLLECTOR);
    const times = parseProcStat(raw);
    if (times === null) {
      return yield* new CollectorError({
        collector: COLLECTOR,
        reason: "no aggregate `cpu` line found in /proc/stat",
      });
    }
    return times;
  },
);

/** One reading: sample, wait, sample again, diff into percentages, validate, brand. */
const read: Effect.Effect<CpuSnapshot, CollectorError> = Effect.gen(function* () {
  const first = yield* sampleTimes;
  yield* Effect.sleep(SAMPLE_INTERVAL);
  const second = yield* sampleTimes;

  const usage = computeCpuUsage(first, second);
  if (usage === null) {
    return yield* new CollectorError({
      collector: COLLECTOR,
      reason: "no CPU time elapsed between samples",
    });
  }

  const result = v.safeParse(RawCpuUsageSchema, usage);
  if (!result.success) {
    return yield* new CollectorError({
      collector: COLLECTOR,
      reason: `cpu usage failed validation: ${v.summarize(result.issues)}`,
      cause: result.issues,
    });
  }

  const { user, system, idle } = result.output;
  return {
    _tag: "cpu",
    at: Timestamp(Date.now()),
    user: Percent(user),
    system: Percent(system),
    idle: Percent(idle),
  } satisfies CpuSnapshot;
});

/** `read` already blocks ~1s for its own delta, so add only a small gap. */
const POLL_GAP = Duration.millis(500);

const stream = collectorStream("cpu", read, POLL_GAP);

/** Live Linux implementation of {@link CpuCollector}. */
export const CpuCollectorLinuxLive = Layer.succeed(
  CpuCollector,
  CpuCollector.of({ read, stream }),
);
