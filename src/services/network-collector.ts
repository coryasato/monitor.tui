import { Context, type Effect, type Stream } from "effect";
import type { CollectorError } from "../types/errors.ts";
import type { MetricState, NetworkSnapshot } from "../types/metrics.ts";

/**
 * Service that reads network throughput (rx/tx bytes per second). Like the other
 * collectors, this is the platform-agnostic interface; implementations ship as
 * Layers (see `NetworkCollectorMacOSLive`).
 */
export class NetworkCollector extends Context.Tag("NetworkCollector")<
  NetworkCollector,
  {
    /** Take a single throughput reading (samples twice internally). */
    readonly read: Effect.Effect<NetworkSnapshot, CollectorError>;
    /** Continuous readings; errors recover to `unavailable`, never failing/ending. */
    readonly stream: Stream.Stream<MetricState>;
  }
>() {}
