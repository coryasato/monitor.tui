import { Context, type Effect, type Stream } from "effect";
import type { CollectorError } from "../types/errors.ts";
import type { CpuSnapshot, MetricState } from "../types/metrics.ts";

/**
 * Service that reads aggregate CPU usage. This is the *interface* — platform
 * implementations are provided as Layers (see `CpuCollectorMacOSLive`). Consumers
 * depend only on this Tag, so swapping in a Linux Layer later changes no call site.
 */
export class CpuCollector extends Context.Tag("CpuCollector")<
  CpuCollector,
  {
    /** Take a single CPU reading. Recoverable failures surface as `CollectorError`. */
    readonly read: Effect.Effect<CpuSnapshot, CollectorError>;
    /**
     * Continuous readings on the collector's own polling interval. Errors are
     * recovered into `unavailable` states, so the stream never fails and never
     * terminates — consumers just keep receiving the latest state.
     */
    readonly stream: Stream.Stream<MetricState>;
  }
>() {}
