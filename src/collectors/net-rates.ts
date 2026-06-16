import * as v from "valibot";

/**
 * Shared network-rate math, platform-agnostic. Both the macOS collector
 * (`netstat -ib`) and the Linux collector (`/proc/net/dev`) parse their own
 * source into {@link NetTotals} cumulative counters, then diff two samples with
 * {@link computeRates} to get per-second throughput. The parsing differs per
 * platform; the rate math does not, so it lives here once.
 */

/** Cumulative byte counters summed across counted (non-loopback) interfaces. */
export interface NetTotals {
  readonly rxBytes: number;
  readonly txBytes: number;
}

/** Per-second rates between two cumulative samples; counter resets clamp to 0. */
export function computeRates(
  prev: NetTotals,
  next: NetTotals,
  elapsedMs: number,
): { rxBytesPerSec: number; txBytesPerSec: number } | null {
  if (!(elapsedMs > 0)) return null;
  const seconds = elapsedMs / 1000;
  return {
    rxBytesPerSec: Math.max(0, next.rxBytes - prev.rxBytes) / seconds,
    txBytesPerSec: Math.max(0, next.txBytes - prev.txBytes) / seconds,
  };
}

/** Boundary schema for the computed rates; failure → `CollectorError`. */
export const RawRatesSchema = v.object({
  rxBytesPerSec: v.pipe(v.number(), v.finite(), v.minValue(0)),
  txBytesPerSec: v.pipe(v.number(), v.finite(), v.minValue(0)),
});
