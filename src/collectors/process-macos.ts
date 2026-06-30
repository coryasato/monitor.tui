import { cc } from "bun:ffi";
import { Duration, Effect, Layer, type Stream } from "effect";
import { ProcessCollector } from "../services/process-collector.ts";
import { CollectorError } from "../types/errors.ts";
import type {
  MetricState,
  ProcessFocusSnapshot,
  ProcessId,
  ProcessListSnapshot,
  ProcessStatus,
} from "../types/metrics.ts";
import { collectorStream } from "./collector-stream.ts";
import {
  assembleRecords,
  clampPercent,
  memPercentOf,
  type RawProcess,
  toFocusSnapshot,
  toSnapshot,
} from "./process-common.ts";
import source from "./proc-macos.c" with { type: "file" };

/**
 * macOS process collector. macOS has no `/proc`, so per-process data comes from
 * libproc via a Bun FFI helper (`proc-macos.c`) — no subprocess, sub-second, full
 * untruncated command names. Like the other stateful collectors, **instantaneous**
 * CPU% comes from diffing two samples of each process's cumulative CPU time over
 * the elapsed wall interval (not the lifetime average `ps`/`top` report), then
 * normalizing by core count so a fully-busy machine reads ~100%.
 */

const COLLECTOR = "process";

/** Numeric fields per process emitted by `read_processes` (keep in sync with the C). */
const NFIELDS = 7;
/** Field offsets within each NFIELDS-wide record. */
const F_PID = 0;
const F_CPU_NS = 2;
const F_RSS = 3;
const F_THREADS = 4;
const F_STATUS = 5;
const F_NAME_LEN = 6;

/** Upper bound on processes read in one call; sizes the numeric output buffer. */
const MAX_PROCS = 8192;
/** Byte capacity for the concatenated name buffer (paths can be long). */
const NAMES_CAP = 4_000_000;

/** Gap between the two cumulative CPU-time samples used for the instantaneous %. */
const SAMPLE_INTERVAL = Duration.millis(500);
/** `read` already blocks ~500ms for its own delta, so add only a small gap. */
const POLL_GAP = Duration.millis(750);

/** macOS `pbi_status` codes → the normalized {@link ProcessStatus} union. */
const macStatus = (code: number): ProcessStatus => {
  switch (code) {
    case 1:
      return "idle"; // SIDL
    case 2:
      return "running"; // SRUN
    case 3:
      return "sleeping"; // SSLEEP
    case 4:
      return "stopped"; // SSTOP
    case 5:
      return "zombie"; // SZOMB
    default:
      return "unknown";
  }
};

/**
 * Compile `proc-macos.c` once with Bun's `cc` and bind `read_processes`, plus the
 * reusable output buffers. Lazy + memoized (not at module load) for the same
 * reason as the per-core collector: this file is statically imported on every
 * platform for layer selection, but the libproc symbols only link on macOS, so a
 * compile/link failure should surface as a recoverable `CollectorError` here
 * rather than crashing the import on Linux.
 */
interface Bound {
  readonly read: (
    out: BigUint64Array,
    maxProcs: number,
    names: Uint8Array,
    namesCap: number,
    namesUsed: Int32Array,
  ) => number;
  readonly numBuf: BigUint64Array;
  readonly nameBuf: Uint8Array;
  readonly usedBuf: Int32Array;
}
let bound: Bound | null = null;
const load = (): Bound => {
  if (bound === null) {
    const { symbols } = cc({
      source,
      symbols: {
        read_processes: {
          args: ["ptr", "int", "ptr", "int", "ptr"],
          returns: "int",
        },
      },
    });
    bound = {
      read: symbols.read_processes,
      numBuf: new BigUint64Array(MAX_PROCS * NFIELDS),
      nameBuf: new Uint8Array(NAMES_CAP),
      usedBuf: new Int32Array(1),
    };
  }
  return bound;
};

const decoder = new TextDecoder();

/** One sample: the decoded process list plus a monotonic timestamp (ns) for the diff. */
interface Sample {
  readonly procs: RawProcess[];
  readonly atNs: number;
}

/**
 * Read one snapshot from libproc and decode the flat FFI buffers into structured
 * processes. Returns `null` if PID enumeration failed (count < 0). `atNs` is taken
 * right after the read so the two-sample elapsed time matches the CPU counters.
 */
const sampleProcesses = (): Sample | null => {
  const b = load();
  const count = b.read(b.numBuf, MAX_PROCS, b.nameBuf, NAMES_CAP, b.usedBuf);
  const atNs = Number(Bun.nanoseconds());
  if (count < 0) return null;

  const procs: RawProcess[] = [];
  let nameOff = 0;
  for (let i = 0; i < count; i++) {
    const base = i * NFIELDS;
    const nameLen = Number(b.numBuf[base + F_NAME_LEN]!);
    const name =
      nameLen > 0
        ? decoder.decode(b.nameBuf.subarray(nameOff, nameOff + nameLen))
        : "";
    nameOff += nameLen;
    procs.push({
      pid: Number(b.numBuf[base + F_PID]!),
      cpuCumulative: Number(b.numBuf[base + F_CPU_NS]!),
      memBytes: Number(b.numBuf[base + F_RSS]!),
      status: macStatus(Number(b.numBuf[base + F_STATUS]!)),
      name,
    });
  }
  return { procs, atNs };
};

const sample: Effect.Effect<Sample, CollectorError> = Effect.try({
  try: () => {
    const s = sampleProcesses();
    if (s === null) throw new Error("proc_listpids returned no PIDs");
    return s;
  },
  catch: (cause) =>
    new CollectorError({
      collector: COLLECTOR,
      reason: "libproc read_processes failed",
      cause,
    }),
});

/** Logical core count, used to normalize CPU% to share-of-machine. */
const CORE_COUNT = Math.max(1, navigator.hardwareConcurrency);

/** One reading: sample, wait, sample again, diff cumulative CPU into instantaneous %. */
const read: Effect.Effect<ProcessListSnapshot, CollectorError> = Effect.gen(
  function* () {
    const first = yield* sample;
    yield* Effect.sleep(SAMPLE_INTERVAL);
    const second = yield* sample;

    // CPU% = Δcpu_ns / (Δwall_ns × cores) × 100 → share of total machine CPU.
    const denom = (second.atNs - first.atNs) * CORE_COUNT;
    const cpuPercentOf = (prev: number | undefined, next: number): number =>
      prev === undefined || denom <= 0
        ? 0
        : clampPercent(((next - prev) / denom) * 100);

    const prevCpu = new Map(first.procs.map((p) => [p.pid, p.cpuCumulative]));
    const records = assembleRecords(prevCpu, second.procs, cpuPercentOf);
    return yield* toSnapshot(records, COLLECTOR);
  },
);

const stream = collectorStream("process", read, POLL_GAP);

// --- Focus view (single pinned process, Feature 2) -------------------------
//
// The focus reader reuses the **same** `read_processes` FFI module as the table,
// filtered to the pinned PID, rather than a second per-PID libproc reader. A
// dedicated second libproc `cc` module (a `read_process_focus` doing
// `proc_pidinfo` for one PID) proved unusable here: once `read_processes` had run
// in the process, that second module's `proc_pidinfo` permanently returned -1 for
// even a live PID (a Bun/TinyCC interaction between two libproc modules). Two
// callers of the *one* `read_processes` module are fine. Threads come from field
// 4 of the existing record (already emitted by the C). FD count is **not**
// available this way, so on macOS `openFds` is `null` (the plan's sanctioned MVP
// fallback — never a per-tick `lsof`).
// TODO(macos-fds): surface a real FD count without a second libproc module —
// e.g. extend `read_processes` to emit per-PID FD counts via PROC_PIDLISTFDS only
// for the pinned PID, or revisit once Bun's multi-module FFI is fixed.

const FOCUS_COLLECTOR = "process-focus";

/** The pinned process's raw counters extracted from one `read_processes` sample. */
interface FocusSample {
  readonly cpuCumulative: number;
  readonly memBytes: number;
  readonly threads: number;
  readonly status: ProcessStatus;
  readonly name: string;
  readonly atNs: number;
}

/**
 * Scan one `read_processes` snapshot for `pid` and extract its focus fields.
 * Returns `null` if the snapshot failed or the PID is absent (exited) — the
 * caller turns that into a recoverable error so the focus stream reports
 * `unavailable`, which (with the exit check on the list) signals exit. The scan
 * walks the concatenated name buffer in lockstep up to the matched record.
 */
const sampleFocus = (pid: number): FocusSample | null => {
  const b = load();
  const count = b.read(b.numBuf, MAX_PROCS, b.nameBuf, NAMES_CAP, b.usedBuf);
  const atNs = Number(Bun.nanoseconds());
  if (count < 0) return null;

  let nameOff = 0;
  for (let i = 0; i < count; i++) {
    const base = i * NFIELDS;
    const nameLen = Number(b.numBuf[base + F_NAME_LEN]!);
    if (Number(b.numBuf[base + F_PID]!) === pid) {
      const name =
        nameLen > 0
          ? decoder.decode(b.nameBuf.subarray(nameOff, nameOff + nameLen))
          : "";
      return {
        cpuCumulative: Number(b.numBuf[base + F_CPU_NS]!),
        memBytes: Number(b.numBuf[base + F_RSS]!),
        threads: Number(b.numBuf[base + F_THREADS]!),
        status: macStatus(Number(b.numBuf[base + F_STATUS]!)),
        name,
        atNs,
      };
    }
    nameOff += nameLen;
  }
  return null; // pid not in the table → exited / unreadable
};

const sampleFocusEffect = (
  pid: number,
): Effect.Effect<FocusSample, CollectorError> =>
  Effect.try({
    try: () => {
      const s = sampleFocus(pid);
      if (s === null) throw new Error(`process ${pid} not found`);
      return s;
    },
    catch: (cause) =>
      new CollectorError({
        collector: FOCUS_COLLECTOR,
        reason: `process ${pid} unavailable`,
        cause,
      }),
  });

/** One focus reading for `pid`: sample, wait, sample again, diff CPU into instantaneous %. */
const readFocus = (
  pid: number,
): Effect.Effect<ProcessFocusSnapshot, CollectorError> =>
  Effect.gen(function* () {
    const first = yield* sampleFocusEffect(pid);
    yield* Effect.sleep(SAMPLE_INTERVAL);
    const second = yield* sampleFocusEffect(pid);

    // Same instantaneous formula as the list collector, scoped to one PID.
    const denom = (second.atNs - first.atNs) * CORE_COUNT;
    const cpuPercent =
      denom <= 0
        ? 0
        : clampPercent(
            ((second.cpuCumulative - first.cpuCumulative) / denom) * 100,
          );

    return yield* toFocusSnapshot(
      {
        pid,
        name: second.name,
        cpuPercent,
        memBytes: second.memBytes,
        memPercent: memPercentOf(second.memBytes),
        threadCount: second.threads,
        openFds: null, // see TODO(macos-fds) above
        status: second.status,
      },
      FOCUS_COLLECTOR,
    );
  });

const focusStream = (pid: ProcessId): Stream.Stream<MetricState> =>
  collectorStream(FOCUS_COLLECTOR, readFocus(pid as number), POLL_GAP);

/** Live macOS implementation of {@link ProcessCollector}. */
export const ProcessCollectorMacOSLive = Layer.succeed(
  ProcessCollector,
  ProcessCollector.of({ read, stream, focusStream }),
);
