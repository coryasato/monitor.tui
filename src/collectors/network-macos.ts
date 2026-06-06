import { Duration, Effect, Layer } from "effect";
import * as v from "valibot";
import { NetworkCollector } from "../services/network-collector.ts";
import { CollectorError } from "../types/errors.ts";
import {
  BytesPerSec,
  type NetworkSnapshot,
  Timestamp,
} from "../types/metrics.ts";
import { collectorStream } from "./collector-stream.ts";
import { spawnText } from "./spawn.ts";

/**
 * macOS network collector. `netstat -ib` reports **cumulative** byte counters per
 * interface, so throughput is computed by sampling twice ~1s apart and dividing
 * the delta by the elapsed time. Loopback (`lo*`) is excluded.
 */

const COLLECTOR = "network";

/** Cumulative byte counters summed across counted interfaces. */
export interface NetTotals {
  readonly rxBytes: number;
  readonly txBytes: number;
}

/**
 * Pure: sum rx/tx cumulative bytes from `netstat -ib` output. Only the per-
 * interface `<Link#N>` rows are counted (address rows duplicate the same totals),
 * and loopback is skipped. Returns `null` if no interface row parsed.
 *
 * Some Link rows carry a MAC Address and some don't, so the byte columns are not
 * at fixed indices — but the trailing seven counters always are: the row ends
 * `… Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll`, so Ibytes is `len-5` and
 * Obytes is `len-2`.
 */
export function parseNetTotals(raw: string): NetTotals | null {
  let rxBytes = 0;
  let txBytes = 0;
  let matched = 0;
  for (const line of raw.split("\n")) {
    const cols = line.trim().split(/\s+/);
    const name = cols[0];
    if (name === undefined || name.startsWith("lo")) continue;
    if (cols[2]?.startsWith("<Link#") !== true) continue;
    if (cols.length < 9) continue;
    const rx = Number(cols[cols.length - 5]);
    const tx = Number(cols[cols.length - 2]);
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue;
    rxBytes += rx;
    txBytes += tx;
    matched += 1;
  }
  return matched === 0 ? null : { rxBytes, txBytes };
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
const RawRatesSchema = v.object({
  rxBytesPerSec: v.pipe(v.number(), v.finite(), v.minValue(0)),
  txBytesPerSec: v.pipe(v.number(), v.finite(), v.minValue(0)),
});

/** How long to wait between the two cumulative samples. */
const SAMPLE_INTERVAL = Duration.seconds(1);

const sampleTotals: Effect.Effect<NetTotals, CollectorError> = Effect.gen(
  function* () {
    const raw = yield* spawnText(["netstat", "-ib"], COLLECTOR);
    const totals = parseNetTotals(raw);
    if (totals === null) {
      return yield* new CollectorError({
        collector: COLLECTOR,
        reason: "could not parse any interface from `netstat -ib`",
      });
    }
    return totals;
  },
);

/** One reading: sample, wait, sample again, diff into per-second rates, brand. */
const read: Effect.Effect<NetworkSnapshot, CollectorError> = Effect.gen(
  function* () {
    const startedAt = Date.now();
    const first = yield* sampleTotals;
    yield* Effect.sleep(SAMPLE_INTERVAL);
    const second = yield* sampleTotals;
    const elapsedMs = Date.now() - startedAt;

    const rates = computeRates(first, second, elapsedMs);
    if (rates === null) {
      return yield* new CollectorError({
        collector: COLLECTOR,
        reason: "non-positive sample interval",
      });
    }

    const result = v.safeParse(RawRatesSchema, rates);
    if (!result.success) {
      return yield* new CollectorError({
        collector: COLLECTOR,
        reason: `network rates failed validation: ${v.summarize(result.issues)}`,
        cause: result.issues,
      });
    }

    return {
      _tag: "network",
      at: Timestamp(Date.now()),
      rxBytesPerSec: BytesPerSec(result.output.rxBytesPerSec),
      txBytesPerSec: BytesPerSec(result.output.txBytesPerSec),
    } satisfies NetworkSnapshot;
  },
);

/** `read` already blocks ~1s for its own delta, so add only a small gap. */
const POLL_GAP = Duration.millis(500);

const stream = collectorStream("network", read, POLL_GAP);

/** Live macOS implementation of {@link NetworkCollector}. */
export const NetworkCollectorMacOSLive = Layer.succeed(
  NetworkCollector,
  NetworkCollector.of({ read, stream }),
);
