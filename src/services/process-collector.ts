import { Context, type Effect, type Stream } from "effect";
import type { CollectorError } from "../types/errors.ts";
import type {
  MetricState,
  ProcessId,
  ProcessListSnapshot,
} from "../types/metrics.ts";

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
    /**
     * A PID-scoped stream for the focus view (Feature 2): each sample is a
     * {@link MetricState} carrying a `process-focus` snapshot for `pid` alone
     * (instantaneous CPU% + threads + FD count). Like {@link stream} it never
     * fails — but a sample becomes `unavailable` once the process is gone, which
     * is how exit is detected. The caller forks this into a scope opened on pin
     * and closed on unpin, so no focus collection runs while nothing is pinned.
     */
    readonly focusStream: (pid: ProcessId) => Stream.Stream<MetricState>;
  }
>() {}
