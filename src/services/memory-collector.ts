import { Context, type Effect, type Stream } from "effect";
import type { CollectorError } from "../types/errors.ts";
import type { MemorySnapshot, MetricState } from "../types/metrics.ts";

/**
 * Service that reads physical memory usage. Like {@link CpuCollector}, this is the
 * platform-agnostic interface; implementations ship as Layers (see
 * `MemoryCollectorMacOSLive`).
 */
export class MemoryCollector extends Context.Tag("MemoryCollector")<
  MemoryCollector,
  {
    /** Take a single memory reading. Recoverable failures surface as `CollectorError`. */
    readonly read: Effect.Effect<MemorySnapshot, CollectorError>;
    /** Continuous readings; errors recover to `unavailable`, never failing/ending. */
    readonly stream: Stream.Stream<MetricState>;
  }
>() {}
