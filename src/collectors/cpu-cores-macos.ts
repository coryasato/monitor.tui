import { cc } from "bun:ffi";
import { Duration, Effect, Layer } from "effect";
import * as v from "valibot";
import { CpuCoresCollector } from "../services/cpu-cores-collector.ts";
import { CollectorError } from "../types/errors.ts";
import { Percent, type PerCoreCpuSnapshot, Timestamp } from "../types/metrics.ts";
import source from "./cpu-cores.c" with { type: "file" };
import { collectorStream } from "./collector-stream.ts";

/**
 * macOS per-core CPU collector. macOS exposes no per-core CPU% to unprivileged
 * CLI tools, so we call the Mach kernel directly via Bun FFI: a tiny C helper
 * (`cpu-cores.c`) wraps `host_processor_info(PROCESSOR_CPU_LOAD_INFO)`, which
 * returns **cumulative** tick counters per logical core. Like the network
 * collector, throughput-style values come from diffing two samples taken a short
 * interval apart.
 */

const COLLECTOR = "cpu-cores";

/** Four cumulative tick counters per core, in the kernel's CPU_STATE order. */
const CPU_STATE_MAX = 4;

/** Upper bound on cores we'll read in one call; sizes the FFI output buffer. */
const MAX_CORES = 256;

/** How long to wait between the two cumulative tick samples. */
const SAMPLE_INTERVAL = Duration.millis(250);

/** `read` already blocks ~250ms for its own delta, so add only a small gap. */
const POLL_GAP = Duration.millis(500);

/**
 * Compile `cpu-cores.c` once with Bun's `cc` (TinyCC) and bind `read_core_ticks`.
 * Mach symbols resolve from libSystem, which is linked automatically. Done at
 * module load so a compile failure surfaces immediately (and only on macOS).
 */
const { read_core_ticks } = cc({
  source,
  symbols: {
    read_core_ticks: { args: ["ptr", "int"], returns: "int" },
  },
}).symbols;

/** Cumulative tick counters for one logical core. */
export interface CoreTicks {
  readonly user: number;
  readonly system: number;
  readonly idle: number;
  readonly nice: number;
}

/**
 * Read one snapshot of per-core cumulative ticks from the kernel. Returns the
 * cores in order, or `null` if the Mach call failed or reported no cores.
 */
const sampleTicks = (): ReadonlyArray<CoreTicks> | null => {
  const buf = new BigUint64Array(MAX_CORES * CPU_STATE_MAX);
  const count = read_core_ticks(buf, MAX_CORES);
  if (count <= 0) return null;
  const n = Math.min(count, MAX_CORES);
  const cores: CoreTicks[] = [];
  for (let c = 0; c < n; c++) {
    const base = c * CPU_STATE_MAX;
    cores.push({
      user: Number(buf[base]!),
      system: Number(buf[base + 1]!),
      idle: Number(buf[base + 2]!),
      nice: Number(buf[base + 3]!),
    });
  }
  return cores;
};

/** The kernel's tick counters are unsigned 32-bit (`natural_t`) and can wrap. */
const UINT32_RANGE = 2 ** 32;

/** A single counter's delta, correcting for 32-bit wraparound between samples. */
const tickDelta = (prev: number, next: number): number => {
  let delta = next - prev;
  if (delta < 0) delta += UINT32_RANGE; // counter wrapped past 2^32
  return delta < 0 ? 0 : delta; // genuine reset (not a single wrap) → 0
};

/**
 * Pure: turn two cumulative tick samples into a per-core busy percentage,
 * `busy% = (Δuser + Δsystem + Δnice) / (Δuser + Δsystem + Δnice + Δidle) * 100`.
 * A core with no elapsed ticks (zero total delta) reports 0%. Returns `null` if
 * the samples disagree on core count (a core appeared/vanished between reads).
 * Exported for unit testing.
 */
export function ticksToPercents(
  prev: ReadonlyArray<CoreTicks>,
  next: ReadonlyArray<CoreTicks>,
): number[] | null {
  if (prev.length === 0 || prev.length !== next.length) return null;
  return prev.map((p, c) => {
    const n = next[c]!;
    const work = tickDelta(p.user, n.user) + tickDelta(p.system, n.system) +
      tickDelta(p.nice, n.nice);
    const total = work + tickDelta(p.idle, n.idle);
    if (total <= 0) return 0;
    const busy = (work / total) * 100;
    return Math.max(0, Math.min(100, busy));
  });
}

/** Boundary schema: per-core busy values must be real percentages before branding. */
const BusyPercentsSchema = v.pipe(
  v.array(v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(100))),
  v.minLength(1),
);

/** One reading: sample ticks, wait, sample again, diff into per-core busy %, brand. */
const read: Effect.Effect<PerCoreCpuSnapshot, CollectorError> = Effect.gen(
  function* () {
    const first = yield* Effect.try({
      try: sampleTicks,
      catch: (cause) =>
        new CollectorError({
          collector: COLLECTOR,
          reason: "host_processor_info FFI call threw",
          cause,
        }),
    });
    yield* Effect.sleep(SAMPLE_INTERVAL);
    const second = yield* Effect.try({
      try: sampleTicks,
      catch: (cause) =>
        new CollectorError({
          collector: COLLECTOR,
          reason: "host_processor_info FFI call threw",
          cause,
        }),
    });

    if (first === null || second === null) {
      return yield* new CollectorError({
        collector: COLLECTOR,
        reason: "host_processor_info returned no per-core data",
      });
    }

    const percents = ticksToPercents(first, second);
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

/**
 * Continuous per-core CPU stream built from {@link read}: successes become `ok`
 * states, recoverable errors become `unavailable` states, and polling continues
 * either way. The ok/unavailable mapping + cadence live in {@link collectorStream}.
 */
const stream = collectorStream("cpu-cores", read, POLL_GAP);

/** Live macOS implementation of {@link CpuCoresCollector}. */
export const CpuCoresCollectorMacOSLive = Layer.succeed(
  CpuCoresCollector,
  CpuCoresCollector.of({ read, stream }),
);
