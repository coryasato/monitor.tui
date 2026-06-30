import { totalmem } from "node:os";
import { Effect } from "effect";
import * as v from "valibot";
import { CollectorError } from "../types/errors.ts";
import {
  Bytes,
  Percent,
  ProcessId,
  type ProcessFocusSnapshot,
  type ProcessListSnapshot,
  type ProcessRecord,
  type ProcessStatus,
  Timestamp,
} from "../types/metrics.ts";

/**
 * Platform-agnostic process-collector helpers. The two platforms differ only in
 * how they *acquire* a sample (libproc FFI on macOS, `/proc` on Linux) and in the
 * units of their cumulative CPU counter (nanoseconds vs jiffies). Everything after
 * that — diffing two samples into per-process percentages, validating at the
 * boundary, and branding into a {@link ProcessListSnapshot} — is shared and pure,
 * so it is unit-testable without touching the kernel.
 */

/** Clamp a number into the percentage range, matching the other collectors. */
export const clampPercent = (n: number): number => Math.max(0, Math.min(100, n));

/**
 * One process from the *second* (current) sample, with its cumulative CPU counter
 * still in raw platform units. `cpuCumulative` is diffed against the first sample
 * to derive an instantaneous percentage; the rest is carried through as-is.
 */
export interface RawProcess {
  readonly pid: number;
  readonly cpuCumulative: number;
  readonly memBytes: number;
  readonly status: ProcessStatus;
  readonly name: string;
}

/** A finished record before validation/branding — plain numbers, not branded. */
export interface PlainRecord {
  readonly pid: number;
  readonly name: string;
  readonly cpuPercent: number;
  readonly memBytes: number;
  readonly status: ProcessStatus;
}

/**
 * Pure: turn two samples into per-process records. `prevCpu` maps pid → the first
 * sample's cumulative CPU counter; `next` is the second sample. `cpuPercentOf`
 * converts a (prev, next) cumulative pair into an instantaneous percentage — the
 * one piece that is platform-specific (ns/wall/cores on macOS, jiffies/total on
 * Linux), injected so the diff/assembly stays shared. A process absent from the
 * first sample (newly spawned, or pid reuse) gets `undefined` prev → 0%.
 */
export const assembleRecords = (
  prevCpu: ReadonlyMap<number, number>,
  next: ReadonlyArray<RawProcess>,
  cpuPercentOf: (prevCum: number | undefined, nextCum: number) => number,
): PlainRecord[] =>
  next.map((p) => ({
    pid: p.pid,
    name: p.name,
    memBytes: p.memBytes,
    status: p.status,
    cpuPercent: cpuPercentOf(prevCpu.get(p.pid), p.cpuCumulative),
  }));

/** Boundary schema: every assembled record must be sane before branding. */
const ProcessRecordSchema = v.object({
  pid: v.pipe(v.number(), v.integer(), v.minValue(1)),
  name: v.string(),
  cpuPercent: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(100)),
  memBytes: v.pipe(v.number(), v.finite(), v.minValue(0)),
  status: v.picklist([
    "running",
    "sleeping",
    "idle",
    "stopped",
    "zombie",
    "unknown",
  ] satisfies ReadonlyArray<ProcessStatus>),
});
const ProcessRecordsSchema = v.array(ProcessRecordSchema);

const brand = (r: v.InferOutput<typeof ProcessRecordSchema>): ProcessRecord => ({
  pid: ProcessId(r.pid),
  name: r.name,
  cpuPercent: Percent(r.cpuPercent),
  memBytes: Bytes(r.memBytes),
  status: r.status,
});

/**
 * Validate assembled records at the boundary and brand them into an immutable
 * {@link ProcessListSnapshot}. A validation failure is a recoverable
 * {@link CollectorError} (the table shows "unavailable" while other metrics run).
 */
export const toSnapshot = (
  records: ReadonlyArray<PlainRecord>,
  collector: string,
): Effect.Effect<ProcessListSnapshot, CollectorError> =>
  Effect.gen(function* () {
    const result = v.safeParse(ProcessRecordsSchema, records);
    if (!result.success) {
      return yield* new CollectorError({
        collector,
        reason: `process records failed validation: ${v.summarize(result.issues)}`,
        cause: result.issues,
      });
    }
    return {
      _tag: "process",
      at: Timestamp(Date.now()),
      processes: result.output.map(brand),
    } satisfies ProcessListSnapshot;
  });

// --- Focus view (single pinned process, Feature 2) -------------------------

/**
 * A finished single-process focus record before validation/branding — plain
 * numbers and a nullable FD count. `cpuPercent`/`memPercent` are already resolved
 * to percentages by the platform collector (the only platform-specific step);
 * everything below — validation, branding, the system-memory share — is shared.
 */
export interface PlainFocus {
  readonly pid: number;
  readonly name: string;
  readonly cpuPercent: number;
  readonly memBytes: number;
  readonly memPercent: number;
  readonly threadCount: number;
  readonly openFds: number | null;
  readonly status: ProcessStatus;
}

/** Total physical memory, sampled once — the denominator for the focus mem %. */
const TOTAL_MEM = totalmem();

/** `memBytes` as a share of total system memory, clamped to [0, 100]. */
export const memPercentOf = (memBytes: number): number =>
  TOTAL_MEM > 0 ? clampPercent((memBytes / TOTAL_MEM) * 100) : 0;

/** Boundary schema for a single focus record. */
const ProcessFocusSchema = v.object({
  pid: v.pipe(v.number(), v.integer(), v.minValue(1)),
  name: v.string(),
  cpuPercent: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(100)),
  memBytes: v.pipe(v.number(), v.finite(), v.minValue(0)),
  memPercent: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(100)),
  threadCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
  openFds: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
  status: v.picklist([
    "running",
    "sleeping",
    "idle",
    "stopped",
    "zombie",
    "unknown",
  ] satisfies ReadonlyArray<ProcessStatus>),
});

/**
 * Validate one assembled focus record at the boundary and brand it into an
 * immutable {@link ProcessFocusSnapshot}. A validation failure is a recoverable
 * {@link CollectorError} (the focus panel shows "unavailable" for that sample).
 */
export const toFocusSnapshot = (
  record: PlainFocus,
  collector: string,
): Effect.Effect<ProcessFocusSnapshot, CollectorError> =>
  Effect.gen(function* () {
    const result = v.safeParse(ProcessFocusSchema, record);
    if (!result.success) {
      return yield* new CollectorError({
        collector,
        reason: `focus record failed validation: ${v.summarize(result.issues)}`,
        cause: result.issues,
      });
    }
    const r = result.output;
    return {
      _tag: "process-focus",
      at: Timestamp(Date.now()),
      pid: ProcessId(r.pid),
      name: r.name,
      cpuPercent: Percent(r.cpuPercent),
      memBytes: Bytes(r.memBytes),
      memPercent: Percent(r.memPercent),
      threadCount: r.threadCount,
      openFds: r.openFds,
      status: r.status,
    } satisfies ProcessFocusSnapshot;
  });
