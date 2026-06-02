import { Effect, Layer } from "effect";
import * as v from "valibot";
import { CpuCollector } from "../services/cpu-collector.ts";
import { CollectorError } from "../types/errors.ts";
import { Percent, Timestamp, type CpuSnapshot } from "../types/metrics.ts";

/**
 * macOS CPU collector. macOS has no `/proc`, so we shell out to `top` and parse
 * its "CPU usage" line. `top -l 2 -n 0` takes two samples; the first is a
 * cumulative-since-boot figure (meaningless as an instant), so we always use the
 * **last** sample, which is a true short-interval delta.
 */

const COLLECTOR = "cpu";

/** Matches e.g. `CPU usage: 15.35% user, 20.53% sys, 64.10% idle` (idle may be 1-dp). */
const CPU_USAGE_LINE =
  /CPU usage:\s*([\d.]+)%\s*user,\s*([\d.]+)%\s*sys,\s*([\d.]+)%\s*idle/g;

/** The raw shape parsed out of `top` output, before branding/validation. */
export interface RawCpuUsage {
  readonly user: number;
  readonly system: number;
  readonly idle: number;
}

/**
 * Pure parser over `top -l 2 -n 0` stdout. Returns the **last** CPU usage sample,
 * or `null` if no usage line is present. Kept pure and exported for unit testing.
 */
export function parseCpuUsage(raw: string): RawCpuUsage | null {
  CPU_USAGE_LINE.lastIndex = 0;
  let last: RegExpExecArray | null = null;
  for (
    let m = CPU_USAGE_LINE.exec(raw);
    m !== null;
    m = CPU_USAGE_LINE.exec(raw)
  ) {
    last = m;
  }
  if (last === null) return null;
  return {
    user: Number(last[1]),
    system: Number(last[2]),
    idle: Number(last[3]),
  };
}

/**
 * Boundary schema: `top` output is untrusted, so we validate the parsed numbers
 * are real percentages before branding them. A failure here is a `CollectorError`,
 * not a crash.
 */
const RawCpuUsageSchema = v.object({
  user: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(100)),
  system: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(100)),
  idle: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(100)),
});

/** One CPU reading: run `top`, parse, validate at the boundary, then brand. */
const read: Effect.Effect<CpuSnapshot, CollectorError> = Effect.gen(function* () {
  const raw = yield* Effect.tryPromise({
    try: () => Bun.$`top -l 2 -n 0`.text(),
    catch: (cause) =>
      new CollectorError({
        collector: COLLECTOR,
        reason: "failed to run `top`",
        cause,
      }),
  });

  const parsed = parseCpuUsage(raw);
  if (parsed === null) {
    return yield* new CollectorError({
      collector: COLLECTOR,
      reason: "no `CPU usage` line found in top output",
    });
  }

  const result = v.safeParse(RawCpuUsageSchema, parsed);
  if (!result.success) {
    return yield* new CollectorError({
      collector: COLLECTOR,
      reason: `top output failed validation: ${v.summarize(result.issues)}`,
      cause: result.issues,
    });
  }

  const { user, system, idle } = result.output;
  return {
    _tag: "cpu",
    at: Timestamp(Date.now()),
    user: Percent(user),
    system: Percent(system),
    idle: Percent(idle),
  } satisfies CpuSnapshot;
});

/** Live macOS implementation of {@link CpuCollector}. */
export const CpuCollectorMacOSLive = Layer.succeed(CpuCollector, { read });
