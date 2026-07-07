import type { Bytes, Percent, ProcessId } from "./metrics.ts";

/**
 * A one-shot snapshot of a process at the moment it exited — the data behind
 * the exit report modal. Captured once (from the last observed focus sample
 * plus, for a launched child, its precise subprocess exit event) and held
 * in a `Ref<Option<ProcessExitRecord>>`; unlike {@link MetricSnapshot} it never
 * flows through the `MetricsStore` and is never re-sampled.
 *
 * `origin` decides how much we can honestly report:
 * - `"launched"` — a command spawned as our own child. We hold the real
 *   `child.exited` result and its captured stderr, so this is a full report.
 * - `"attached"` — an existing PID pinned from the table. macOS can't `wait()`
 *   on a non-child or read its stderr, so exit is only detected best-effort (it
 *   vanished from the process list) — a degraded notice with resources only.
 *
 * `finalCpuPercent`/`finalMemBytes` are the last *observed* sample before exit
 * for either origin — `null` when the process exited before a first sample
 * arrived (e.g. `sh -c 'exit 0'` can finish inside one poll interval).
 */
export interface ProcessExitRecordBase {
  readonly pid: ProcessId;
  readonly name: string;
  readonly finalCpuPercent: Percent | null;
  readonly finalMemBytes: Bytes | null;
}

export interface LaunchedExitRecord extends ProcessExitRecordBase {
  readonly origin: "launched";
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
  readonly stderrTail: ReadonlyArray<string>;
}

export interface AttachedExitRecord extends ProcessExitRecordBase {
  readonly origin: "attached";
  readonly exitCode: null;
  readonly exitSignal: null;
  readonly stderrTail: null;
}

/** Discriminated on `origin` so the modal renders the right tier. */
export type ProcessExitRecord = LaunchedExitRecord | AttachedExitRecord;
