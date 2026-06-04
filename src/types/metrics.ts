import { Brand } from "effect";

/**
 * Shared metric value types. Snapshots are immutable values — collectors produce
 * them, the store holds the latest, and UI components read them on a render tick.
 * No shared mutable state crosses the collector/UI boundary.
 */

/** A percentage in the range [0, 100]. */
export type Percent = number & Brand.Brand<"Percent">;
export const Percent = Brand.refined<Percent>(
  (n) => Number.isFinite(n) && n >= 0 && n <= 100,
  (n) => Brand.error(`Expected a percent in [0, 100], got ${n}`),
);

/** A Unix epoch timestamp in milliseconds. */
export type Timestamp = number & Brand.Brand<"Timestamp">;
export const Timestamp = Brand.refined<Timestamp>(
  (n) => Number.isInteger(n) && n >= 0,
  (n) => Brand.error(`Expected a non-negative integer epoch ms, got ${n}`),
);

/**
 * Aggregate CPU usage at a point in time. `user + system + idle` should sum to
 * ~100; we keep the components separately so the UI can break them down.
 */
export interface CpuSnapshot {
  readonly _tag: "cpu";
  readonly at: Timestamp;
  readonly user: Percent;
  readonly system: Percent;
  readonly idle: Percent;
}

/**
 * Discriminated union of all metric snapshots, keyed by `_tag`. New collectors
 * add a member here (e.g. `MemorySnapshot`, `DiskSnapshot`).
 */
export type MetricSnapshot = CpuSnapshot;

/** The `_tag` of any metric snapshot — used as the key into the MetricsStore. */
export type MetricTag = MetricSnapshot["_tag"];

/**
 * The latest known state of a metric, as held by the MetricsStore. A collector
 * that fails recoverably reports `unavailable` (with a reason) instead of an
 * error, so the UI can show "unavailable" for one metric while others keep
 * updating — the graceful-degradation contract. Both variants carry `tag` so the
 * store keying is uniform regardless of availability.
 */
export type MetricState =
  | {
      readonly _tag: "ok";
      readonly tag: MetricTag;
      readonly at: Timestamp;
      readonly snapshot: MetricSnapshot;
    }
  | {
      readonly _tag: "unavailable";
      readonly tag: MetricTag;
      readonly at: Timestamp;
      readonly reason: string;
    };
