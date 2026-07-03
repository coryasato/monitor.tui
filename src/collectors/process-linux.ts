import { readdir } from "node:fs/promises";
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
  aggregateSubtree,
  assembleRecords,
  clampPercent,
  memPercentOf,
  type RawProcess,
  type SubtreeProc,
  toFocusSnapshot,
  toSnapshot,
} from "./process-common.ts";

/**
 * Linux process collector. Reads `/proc` directly (no privileged call, unlike
 * macOS's libproc FFI). **Instantaneous** CPU% is the canonical procfs method:
 * diff each process's `utime + stime` (jiffies) across two samples against the
 * delta of total CPU jiffies from `/proc/stat` — already normalized to
 * share-of-machine, the same two-sample shape as the net/disk collectors. The
 * pure parsers are exported for unit testing; the file IO is the only impure part.
 */

const COLLECTOR = "process";

/** Linux RSS is reported in pages; the kernel page size is 4 KiB on all common arches. */
const PAGE_SIZE = 4096;

/** Gap between the two cumulative jiffie samples used for the instantaneous %. */
const SAMPLE_INTERVAL = Duration.millis(500);
const POLL_GAP = Duration.millis(750);

/** Parsed fields we need from one `/proc/<pid>/stat` line. */
export interface ProcPidStat {
  readonly pid: number;
  readonly comm: string;
  readonly state: string;
  readonly ppid: number;
  readonly cpuJiffies: number; // utime + stime
  readonly rssPages: number;
  readonly threads: number;
}

/**
 * Pure: parse `/proc/<pid>/stat`. The `comm` field is wrapped in parens and may
 * itself contain spaces or parens, so we split on the **last** `)` and index the
 * fixed-position fields after it. Returns `null` if the line is malformed.
 * Field numbers (1-indexed, from proc(5)): 14 utime, 15 stime, 20 num_threads,
 * 22 starttime, 24 rss — i.e. post-`comm` 0-indexed: state 0, ppid 1, utime 11,
 * stime 12, num_threads 17, rss 21. Exported for unit testing.
 */
export function parseProcPidStat(raw: string): ProcPidStat | null {
  const open = raw.indexOf("(");
  const close = raw.lastIndexOf(")");
  if (open < 0 || close < 0 || close < open) return null;
  const pid = Number(raw.slice(0, open).trim());
  const comm = raw.slice(open + 1, close);
  const rest = raw.slice(close + 1).trim().split(/\s+/);
  const state = rest[0];
  const ppid = Number(rest[1]);
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  const threads = Number(rest[17]);
  const rssPages = Number(rest[21]);
  if (
    !Number.isFinite(pid) ||
    state === undefined ||
    !Number.isFinite(utime) ||
    !Number.isFinite(stime)
  ) {
    return null;
  }
  return {
    pid,
    comm,
    state,
    ppid: Number.isFinite(ppid) ? ppid : 0,
    cpuJiffies: utime + stime,
    rssPages: Number.isFinite(rssPages) ? rssPages : 0,
    threads: Number.isFinite(threads) ? threads : 0,
  };
}

/**
 * Pure: sum the aggregate `cpu` line of `/proc/stat` into total jiffies across all
 * cores (the denominator for instantaneous per-process CPU%). Returns `null` if
 * the first line isn't the aggregate `cpu` line. Exported for unit testing.
 */
export function parseTotalJiffies(procStat: string): number | null {
  const line = procStat.split("\n", 1)[0];
  if (line === undefined) return null;
  const cols = line.trim().split(/\s+/);
  if (cols[0] !== "cpu") return null;
  const nums = cols.slice(1).map(Number);
  if (nums.length === 0 || nums.some((n) => !Number.isFinite(n))) return null;
  return nums.reduce((a, b) => a + b, 0);
}

/** Linux `/proc/<pid>/stat` state char → the normalized {@link ProcessStatus} union. */
export const linuxStatus = (state: string): ProcessStatus => {
  switch (state[0]) {
    case "R":
      return "running";
    case "S":
    case "D": // uninterruptible sleep — still "sleeping" for our coarse union
      return "sleeping";
    case "I":
      return "idle";
    case "T":
    case "t":
      return "stopped";
    case "Z":
      return "zombie";
    default:
      return "unknown";
  }
}

/** Read `/proc/<pid>/cmdline` (NUL-separated argv) as a full command string, or `null`. */
const readCmdline = async (pid: number): Promise<string | null> => {
  try {
    const raw = await Bun.file(`/proc/${pid}/cmdline`).text();
    if (raw.length === 0) return null; // kernel threads have an empty cmdline
    return raw.replace(/\0+$/, "").split("\0").join(" ");
  } catch {
    return null;
  }
};

/** Read + parse one process; `null` if it vanished or its stat is unreadable. */
const readOne = async (pid: number): Promise<RawProcess | null> => {
  let stat: ProcPidStat | null;
  try {
    stat = parseProcPidStat(await Bun.file(`/proc/${pid}/stat`).text());
  } catch {
    return null; // process exited between readdir and read
  }
  if (stat === null) return null;
  // Prefer the full cmdline; fall back to the truncated comm (kernel threads).
  const cmdline = await readCmdline(pid);
  return {
    pid: stat.pid,
    cpuCumulative: stat.cpuJiffies,
    memBytes: stat.rssPages * PAGE_SIZE,
    status: linuxStatus(stat.state),
    name: cmdline ?? stat.comm,
  };
};

/** One sample: every readable process plus the total-jiffies denominator. */
interface Sample {
  readonly procs: RawProcess[];
  readonly totalJiffies: number;
}

const sample: Effect.Effect<Sample, CollectorError> = Effect.tryPromise({
  try: async () => {
    const totalJiffies = parseTotalJiffies(await Bun.file("/proc/stat").text());
    if (totalJiffies === null) throw new Error("could not parse /proc/stat cpu line");
    const entries = await readdir("/proc");
    const pids = entries.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    const results = await Promise.all(pids.map(readOne));
    const procs = results.filter((p): p is RawProcess => p !== null);
    return { procs, totalJiffies };
  },
  catch: (cause) =>
    new CollectorError({
      collector: COLLECTOR,
      reason: "failed to read /proc process table",
      cause,
    }),
});

/** One reading: sample, wait, sample again, diff cumulative jiffies into instantaneous %. */
const read: Effect.Effect<ProcessListSnapshot, CollectorError> = Effect.gen(
  function* () {
    const first = yield* sample;
    yield* Effect.sleep(SAMPLE_INTERVAL);
    const second = yield* sample;

    // CPU% = Δproc_jiffies / Δtotal_jiffies × 100 → already share-of-machine
    // (total jiffies sums all cores).
    const totalDelta = second.totalJiffies - first.totalJiffies;
    const cpuPercentOf = (prev: number | undefined, next: number): number =>
      prev === undefined || totalDelta <= 0
        ? 0
        : clampPercent(((next - prev) / totalDelta) * 100);

    const prevCpu = new Map(first.procs.map((p) => [p.pid, p.cpuCumulative]));
    const records = assembleRecords(prevCpu, second.procs, cpuPercentOf);
    return yield* toSnapshot(records, COLLECTOR);
  },
);

const stream = collectorStream("process", read, POLL_GAP);

// --- Focus view (single pinned process, Feature 2) -------------------------

const FOCUS_COLLECTOR = "process-focus";

/** Count entries in `/proc/<pid>/fd` (the open file descriptors), or `null` if unreadable. */
const countFds = async (pid: number): Promise<number | null> => {
  try {
    return (await readdir(`/proc/${pid}/fd`)).length;
  } catch {
    return null; // typically EACCES for a process owned by another user
  }
};

/** One focus sample: the pinned process's stat plus the total-jiffies denominator and FD count. */
interface FocusSample {
  readonly stat: ProcPidStat;
  readonly totalJiffies: number;
  readonly openFds: number | null;
  readonly name: string;
}

/**
 * Read one `/proc` sample for a single PID. Returns `null` if the process is gone
 * or its stat is unreadable — the caller turns that into a recoverable error so
 * the focus stream reports `unavailable`, which signals exit.
 */
const sampleFocus = (
  pid: number,
): Effect.Effect<FocusSample, CollectorError> =>
  Effect.tryPromise({
    try: async (): Promise<FocusSample> => {
      const stat = parseProcPidStat(await Bun.file(`/proc/${pid}/stat`).text());
      if (stat === null) throw new Error(`bad /proc/${pid}/stat`);
      const totalJiffies = parseTotalJiffies(
        await Bun.file("/proc/stat").text(),
      );
      if (totalJiffies === null) throw new Error("could not parse /proc/stat");
      const cmdline = await readCmdline(pid);
      const openFds = await countFds(pid);
      return { stat, totalJiffies, openFds, name: cmdline ?? stat.comm };
    },
    catch: (cause) =>
      new CollectorError({
        collector: FOCUS_COLLECTOR,
        reason: `process ${pid} unavailable`,
        cause,
      }),
  });

/** One focus reading for `pid`: sample, wait, sample again, diff jiffies into instantaneous %. */
const readFocus = (
  pid: number,
): Effect.Effect<ProcessFocusSnapshot, CollectorError> =>
  Effect.gen(function* () {
    const first = yield* sampleFocus(pid);
    yield* Effect.sleep(SAMPLE_INTERVAL);
    const second = yield* sampleFocus(pid);

    // Same instantaneous formula as the list collector, scoped to one PID.
    const totalDelta = second.totalJiffies - first.totalJiffies;
    const cpuPercent =
      totalDelta <= 0
        ? 0
        : clampPercent(
            ((second.stat.cpuJiffies - first.stat.cpuJiffies) / totalDelta) *
              100,
          );
    const memBytes = second.stat.rssPages * PAGE_SIZE;

    return yield* toFocusSnapshot(
      {
        pid,
        name: second.name,
        cpuPercent,
        memBytes,
        memPercent: memPercentOf(memBytes),
        threadCount: second.stat.threads,
        openFds: second.openFds,
        status: linuxStatus(second.stat.state),
        descendantCount: null, // single attached PID, not a subtree
      },
      FOCUS_COLLECTOR,
    );
  });

const focusStream = (pid: ProcessId): Stream.Stream<MetricState> =>
  collectorStream(FOCUS_COLLECTOR, readFocus(pid as number), POLL_GAP);

// --- Subtree focus (launched command, Feature 4) ---------------------------
//
// A launched command's resource view sums the child + all descendants. We scan
// the full `/proc` table (with ppid + threads from each stat line) and walk the
// tree with the shared pure `aggregateSubtree` helper.

/** One full `/proc` sample carrying the ppid/thread fields the subtree walk needs. */
interface SubtreeSample {
  readonly procs: SubtreeProc[];
  readonly totalJiffies: number;
}

/** Read + parse one process into a {@link SubtreeProc}; `null` if it vanished mid-scan. */
const readOneSubtree = async (pid: number): Promise<SubtreeProc | null> => {
  let stat: ProcPidStat | null;
  try {
    stat = parseProcPidStat(await Bun.file(`/proc/${pid}/stat`).text());
  } catch {
    return null;
  }
  if (stat === null) return null;
  const cmdline = await readCmdline(pid);
  return {
    pid: stat.pid,
    ppid: stat.ppid,
    cpuCumulative: stat.cpuJiffies,
    memBytes: stat.rssPages * PAGE_SIZE,
    threads: stat.threads,
    status: linuxStatus(stat.state),
    name: cmdline ?? stat.comm,
  };
};

const sampleSubtree: Effect.Effect<SubtreeSample, CollectorError> =
  Effect.tryPromise({
    try: async (): Promise<SubtreeSample> => {
      const totalJiffies = parseTotalJiffies(
        await Bun.file("/proc/stat").text(),
      );
      if (totalJiffies === null) {
        throw new Error("could not parse /proc/stat cpu line");
      }
      const entries = await readdir("/proc");
      const pids = entries.map(Number).filter((n) => Number.isInteger(n) && n > 0);
      const results = await Promise.all(pids.map(readOneSubtree));
      const procs = results.filter((p): p is SubtreeProc => p !== null);
      return { procs, totalJiffies };
    },
    catch: (cause) =>
      new CollectorError({
        collector: FOCUS_COLLECTOR,
        reason: "failed to read /proc process table",
        cause,
      }),
  });

/** One subtree reading for `rootPid`: sample, wait, sample again, sum + diff the subtree. */
const readSubtree = (
  rootPid: number,
): Effect.Effect<ProcessFocusSnapshot, CollectorError> =>
  Effect.gen(function* () {
    const first = yield* sampleSubtree;
    yield* Effect.sleep(SAMPLE_INTERVAL);
    const second = yield* sampleSubtree;

    const totalDelta = second.totalJiffies - first.totalJiffies;
    const prevCpu = new Map(first.procs.map((p) => [p.pid, p.cpuCumulative]));
    const agg = aggregateSubtree(prevCpu, second.procs, rootPid);
    const cpuPercent =
      totalDelta <= 0 ? 0 : clampPercent((agg.cpuDelta / totalDelta) * 100);

    return yield* toFocusSnapshot(
      {
        pid: rootPid,
        name: agg.rootName,
        cpuPercent,
        memBytes: agg.memBytes,
        memPercent: memPercentOf(agg.memBytes),
        threadCount: agg.threads,
        openFds: null, // subtree FD aggregation is out of scope for the MVP
        status: agg.rootStatus,
        descendantCount: agg.descendantCount,
      },
      FOCUS_COLLECTOR,
    );
  });

const subtreeFocusStream = (pid: ProcessId): Stream.Stream<MetricState> =>
  collectorStream(FOCUS_COLLECTOR, readSubtree(pid as number), POLL_GAP);

/** Live Linux implementation of {@link ProcessCollector}. */
export const ProcessCollectorLinuxLive = Layer.succeed(
  ProcessCollector,
  ProcessCollector.of({ read, stream, focusStream, subtreeFocusStream }),
);
