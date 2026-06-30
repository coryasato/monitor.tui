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

/** A non-negative quantity of bytes. */
export type Bytes = number & Brand.Brand<"Bytes">;
export const Bytes = Brand.refined<Bytes>(
  (n) => Number.isFinite(n) && n >= 0,
  (n) => Brand.error(`Expected a non-negative byte count, got ${n}`),
);

/** A process identifier — a positive integer pid. */
export type ProcessId = number & Brand.Brand<"ProcessId">;
export const ProcessId = Brand.refined<ProcessId>(
  (n) => Number.isInteger(n) && n > 0,
  (n) => Brand.error(`Expected a positive integer pid, got ${n}`),
);

/** A non-negative throughput in bytes per second (distinct from a {@link Bytes} count). */
export type BytesPerSec = number & Brand.Brand<"BytesPerSec">;
export const BytesPerSec = Brand.refined<BytesPerSec>(
  (n) => Number.isFinite(n) && n >= 0,
  (n) => Brand.error(`Expected a non-negative byte rate, got ${n}`),
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
 * Per-core CPU usage at a point in time: one busy percentage per logical core,
 * in core order. Computed by diffing two cumulative tick samples from the Mach
 * `host_processor_info` call (see the macOS FFI collector).
 */
export interface PerCoreCpuSnapshot {
  readonly _tag: "cpu-cores";
  readonly at: Timestamp;
  readonly cores: ReadonlyArray<Percent>;
}

/**
 * Physical memory usage at a point in time. `usedBytes` follows Activity
 * Monitor's "Memory Used" (active + wired + compressed); `usedPercent` is
 * `usedBytes / totalBytes`.
 */
export interface MemorySnapshot {
  readonly _tag: "memory";
  readonly at: Timestamp;
  readonly usedPercent: Percent;
  readonly usedBytes: Bytes;
  readonly totalBytes: Bytes;
}

/**
 * Network throughput at a point in time, summed across non-loopback interfaces.
 * Rates are computed by diffing two cumulative `netstat` samples over the elapsed
 * interval.
 */
export interface NetworkSnapshot {
  readonly _tag: "network";
  readonly at: Timestamp;
  readonly rxBytesPerSec: BytesPerSec;
  readonly txBytesPerSec: BytesPerSec;
}

/**
 * Disk throughput at a point in time, summed across disks (combined read+write,
 * since `iostat` reports a single MB/s per disk).
 */
export interface DiskSnapshot {
  readonly _tag: "disk";
  readonly at: Timestamp;
  readonly bytesPerSec: BytesPerSec;
}

/**
 * Coarse process lifecycle state, normalized across platforms (macOS
 * `pbi_status`, Linux `/proc/<pid>/stat` state char) into one closed union.
 */
export type ProcessStatus =
  | "running"
  | "sleeping"
  | "idle"
  | "stopped"
  | "zombie"
  | "unknown";

/**
 * One process at a point in time. `name` is the full (untruncated) command path
 * so downstream search (Feature 3) can match on it; the table truncates for
 * display. `cpuPercent` is **instantaneous** (a two-sample diff) and normalized
 * to share of total machine CPU, so it stays in [0, 100] like the other gauges.
 */
export interface ProcessRecord {
  readonly pid: ProcessId;
  readonly name: string;
  readonly cpuPercent: Percent;
  readonly memBytes: Bytes;
  readonly status: ProcessStatus;
}

/**
 * The full process table at a point in time — one snapshot carries every row.
 * Replaces the previous snapshot wholesale on each sample (the store is
 * latest-only), so the UI re-windows/re-sorts from a single immutable value.
 */
export interface ProcessListSnapshot {
  readonly _tag: "process";
  readonly at: Timestamp;
  readonly processes: ReadonlyArray<ProcessRecord>;
}

/**
 * A single pinned process at a point in time — the data behind the focus view
 * (Feature 2). Sourced from the same libproc/`/proc` collector as
 * {@link ProcessListSnapshot} but scoped to one PID, so `cpuPercent` is the same
 * **instantaneous** two-sample diff normalized to share-of-machine. `memPercent`
 * is `memBytes` as a share of total system memory, so the focus memory sparkline
 * is comparable with the MEM gauge. `openFds` is `null` when the FD count is
 * unavailable (never sourced from a per-tick `lsof`). Because only one process is
 * ever pinned, this is stored under the single stable `"process-focus"` tag —
 * each sample overwrites the last.
 */
export interface ProcessFocusSnapshot {
  readonly _tag: "process-focus";
  readonly at: Timestamp;
  readonly pid: ProcessId;
  readonly name: string;
  readonly cpuPercent: Percent;
  readonly memBytes: Bytes;
  readonly memPercent: Percent;
  readonly threadCount: number;
  readonly openFds: number | null;
  readonly status: ProcessStatus;
}

/**
 * Discriminated union of all metric snapshots, keyed by `_tag`. New collectors
 * add a member here.
 */
export type MetricSnapshot =
  | CpuSnapshot
  | PerCoreCpuSnapshot
  | MemorySnapshot
  | NetworkSnapshot
  | DiskSnapshot
  | ProcessListSnapshot
  | ProcessFocusSnapshot;

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
