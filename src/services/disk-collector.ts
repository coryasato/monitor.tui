import { Context, type Effect, type Stream } from "effect";
import type { CollectorError } from "../types/errors.ts";
import type { DiskSnapshot, MetricState } from "../types/metrics.ts";

/**
 * Service that reads disk throughput (combined bytes per second). Platform-
 * agnostic interface; implementations ship as Layers (see `DiskCollectorMacOSLive`).
 */
export class DiskCollector extends Context.Tag("DiskCollector")<
  DiskCollector,
  {
    /** Take a single throughput reading (`iostat` samples internally). */
    readonly read: Effect.Effect<DiskSnapshot, CollectorError>;
    /** Continuous readings; errors recover to `unavailable`, never failing/ending. */
    readonly stream: Stream.Stream<MetricState>;
  }
>() {}
