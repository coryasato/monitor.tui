import { Context, type Effect, type Stream } from "effect";
import type { CollectorError } from "../types/errors.ts";
import type { MetricState, ProcessListSnapshot } from "../types/metrics.ts";

/**
 * Service that reads the system process table. This is the *interface* — platform
 * implementations are provided as Layers (`ProcessCollectorMacOSLive`, which uses
 * a libproc Bun FFI call; `ProcessCollectorLinuxLive`, which reads `/proc`).
 * Consumers depend only on this Tag, so the platform is chosen in exactly one
 * place (see `CollectorsLive`).
 */
export class ProcessCollector extends Context.Tag("ProcessCollector")<
  ProcessCollector,
  {
    /** Take a single process-table reading. Recoverable failures surface as `CollectorError`. */
    readonly read: Effect.Effect<ProcessListSnapshot, CollectorError>;
    /**
     * Continuous readings on the collector's own polling interval. Errors are
     * recovered into `unavailable` states, so the stream never fails and never
     * terminates — consumers just keep receiving the latest state.
     */
    readonly stream: Stream.Stream<MetricState>;
  }
>() {}
