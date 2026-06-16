import { Duration, Effect, Layer } from "effect";
import * as v from "valibot";
import { NetworkCollector } from "../services/network-collector.ts";
import { CollectorError } from "../types/errors.ts";
import { BytesPerSec, type NetworkSnapshot, Timestamp } from "../types/metrics.ts";
import { collectorStream } from "./collector-stream.ts";
import { computeRates, type NetTotals, RawRatesSchema } from "./net-rates.ts";
import { readProcFile } from "./proc.ts";

/**
 * Linux network collector. `/proc/net/dev` reports **cumulative** byte counters
 * per interface, so — like the macOS collector — throughput comes from sampling
 * twice ~1s apart and diffing (via the shared {@link computeRates}). Loopback
 * (`lo`) is excluded. Each interface line is `name: rx_bytes rx_packets … (16
 * fields)`; the first field is received bytes and the ninth is transmitted bytes.
 */

const COLLECTOR = "network";

const PROC_NET_DEV = "/proc/net/dev";

/** Field index (after the `name:` colon) of the transmitted-bytes counter. */
const TX_BYTES_INDEX = 8;

/**
 * Pure: sum rx/tx cumulative bytes from `/proc/net/dev` output. The two header
 * lines have no `name:` colon and are skipped, as is loopback. Returns `null` if
 * no interface row parsed. Exported for unit testing.
 */
export function parseProcNetDev(raw: string): NetTotals | null {
  let rxBytes = 0;
  let txBytes = 0;
  let matched = 0;
  for (const line of raw.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue; // header rows ("Inter-|", "face |") have none
    const name = line.slice(0, colon).trim();
    if (name === "" || name === "lo") continue;
    const cols = line.slice(colon + 1).trim().split(/\s+/);
    if (cols.length <= TX_BYTES_INDEX) continue;
    const rx = Number(cols[0]);
    const tx = Number(cols[TX_BYTES_INDEX]);
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue;
    rxBytes += rx;
    txBytes += tx;
    matched += 1;
  }
  return matched === 0 ? null : { rxBytes, txBytes };
}

/** How long to wait between the two cumulative samples. */
const SAMPLE_INTERVAL = Duration.seconds(1);

const sampleTotals: Effect.Effect<NetTotals, CollectorError> = Effect.gen(
  function* () {
    const raw = yield* readProcFile(PROC_NET_DEV, COLLECTOR);
    const totals = parseProcNetDev(raw);
    if (totals === null) {
      return yield* new CollectorError({
        collector: COLLECTOR,
        reason: "could not parse any interface from /proc/net/dev",
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

/** Live Linux implementation of {@link NetworkCollector}. */
export const NetworkCollectorLinuxLive = Layer.succeed(
  NetworkCollector,
  NetworkCollector.of({ read, stream }),
);
