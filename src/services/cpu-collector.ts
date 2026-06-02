import { Context, type Effect } from "effect";
import type { CollectorError } from "../types/errors.ts";
import type { CpuSnapshot } from "../types/metrics.ts";

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
  }
>() {}
