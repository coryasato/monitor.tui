import { Duration, Effect, Layer } from "effect";
import * as v from "valibot";
import { CpuCoresCollector } from "../services/cpu-cores-collector.ts";
import { CollectorError } from "../types/errors.ts";
import { Percent, type PerCoreCpuSnapshot, Timestamp } from "../types/metrics.ts";
import { collectorStream } from "./collector-stream.ts";
import { type CpuTimes, toCpuTimes } from "./cpu-linux.ts";
import { readProcFile } from "./proc.ts";

/**
 * Linux per-core CPU collector. The same `/proc/stat` that backs the aggregate
 * CPU collector also carries one `cpuN` line per logical core, so per-core usage
 * needs no privileged call here (unlike macOS, which goes through a Mach FFI).
 * We diff two cumulative samples and report each core's busy percentage.
 */

const COLLECTOR = "cpu-cores";

const PROC_STAT = "/proc/stat";

/**
 * Pure: parse the per-core `cpuN` lines from `/proc/stat`, in core order (cpu0,
 * cpu1, …). The aggregate `cpu` line is skipped. Returns `null` if no per-core
 * line parsed. Exported for unit testing.
 */
export function parseProcStatCores(raw: string): CpuTimes[] | null {
  const cores: Array<{ index: number; times: CpuTimes }> = [];
  for (const line of raw.split("\n")) {
    const cols = line.trim().split(/\s+/);
    const label = cols[0];
    if (label === undefined) continue;
    const m = /^cpu(\d+)$/.exec(label); // "cpu0".."cpuN"; skips bare "cpu"
    if (m === null) continue;
    const times = toCpuTimes(cols.slice(1).map(Number));
    if (times === null) continue;
    cores.push({ index: Number(m[1]), times });
  }
  if (cores.length === 0) return null;
  return cores.sort((a, b) => a.index - b.index).map((c) => c.times);
}

const clampPercent = (n: number): number => Math.max(0, Math.min(100, n));
const idleOf = (t: CpuTimes): number => t.idle + t.iowait;
const totalOf = (t: CpuTimes): number =>
  t.user + t.nice + t.system + t.idle + t.iowait + t.irq + t.softirq + t.steal;

/**
 * Pure: per-core busy percentage from two cumulative samples,
 * `busy% = 1 − Δ(idle+iowait) / Δtotal`. A core with no elapsed time reports 0%.
 * Returns `null` if the samples disagree on core count. Exported for unit testing.
 */
export function coresUsage(
  prev: ReadonlyArray<CpuTimes>,
  next: ReadonlyArray<CpuTimes>,
): number[] | null {
  if (prev.length === 0 || prev.length !== next.length) return null;
  return prev.map((p, c) => {
    const n = next[c]!;
    const dTotal = totalOf(n) - totalOf(p);
    if (!(dTotal > 0)) return 0;
    const busy = 100 - ((idleOf(n) - idleOf(p)) / dTotal) * 100;
    return clampPercent(busy);
  });
}

/** Boundary schema: per-core busy values must be real percentages before branding. */
const BusyPercentsSchema = v.pipe(
  v.array(v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(100))),
  v.minLength(1),
);

/** How long to wait between the two cumulative `/proc/stat` samples. */
const SAMPLE_INTERVAL = Duration.millis(250);

const sampleCores: Effect.Effect<CpuTimes[], CollectorError> = Effect.gen(
  function* () {
    const raw = yield* readProcFile(PROC_STAT, COLLECTOR);
    const cores = parseProcStatCores(raw);
    if (cores === null) {
      return yield* new CollectorError({
        collector: COLLECTOR,
        reason: "no per-core `cpuN` lines found in /proc/stat",
      });
    }
    return cores;
  },
);

/** One reading: sample, wait, sample again, diff into per-core busy %, brand. */
const read: Effect.Effect<PerCoreCpuSnapshot, CollectorError> = Effect.gen(
  function* () {
    const first = yield* sampleCores;
    yield* Effect.sleep(SAMPLE_INTERVAL);
    const second = yield* sampleCores;

    const percents = coresUsage(first, second);
    if (percents === null) {
      return yield* new CollectorError({
        collector: COLLECTOR,
        reason: `core count changed between samples (${first.length} → ${second.length})`,
      });
    }

    const result = v.safeParse(BusyPercentsSchema, percents);
    if (!result.success) {
      return yield* new CollectorError({
        collector: COLLECTOR,
        reason: `per-core CPU failed validation: ${v.summarize(result.issues)}`,
        cause: result.issues,
      });
    }

    return {
      _tag: "cpu-cores",
      at: Timestamp(Date.now()),
      cores: result.output.map((p) => Percent(p)),
    } satisfies PerCoreCpuSnapshot;
  },
);

/** `read` already blocks ~250ms for its own delta, so add only a small gap. */
const POLL_GAP = Duration.millis(500);

const stream = collectorStream("cpu-cores", read, POLL_GAP);

/** Live Linux implementation of {@link CpuCoresCollector}. */
export const CpuCoresCollectorLinuxLive = Layer.succeed(
  CpuCoresCollector,
  CpuCoresCollector.of({ read, stream }),
);
