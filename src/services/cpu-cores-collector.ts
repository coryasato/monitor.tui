import { Context, type Effect, type Stream } from "effect";
import type { CollectorError } from "../types/errors.ts";
import type { MetricState, PerCoreCpuSnapshot } from "../types/metrics.ts";

/**
 * Service that reads per-core CPU usage. This is the *interface* — platform
 * implementations are provided as Layers (see `CpuCoresCollectorMacOSLive`,
 * which uses a Bun FFI Mach call). Consumers depend only on this Tag, so a Linux
 * implementation (reading `/proc/stat`) could be swapped in with no call-site change.
 */
export class CpuCoresCollector extends Context.Tag("CpuCoresCollector")<
  CpuCoresCollector,
  {
    /** Take a single per-core reading. Recoverable failures surface as `CollectorError`. */
    readonly read: Effect.Effect<PerCoreCpuSnapshot, CollectorError>;
    /**
     * Continuous readings on the collector's own polling interval. Errors are
     * recovered into `unavailable` states, so the stream never fails and never
     * terminates — consumers just keep receiving the latest state.
     */
    readonly stream: Stream.Stream<MetricState>;
  }
>() {}
