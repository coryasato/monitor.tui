import { readdir } from "node:fs/promises";
import { Duration, Effect, Layer } from "effect";
import { ProcessCollector } from "../services/process-collector.ts";
import { CollectorError } from "../types/errors.ts";
import type { ProcessListSnapshot, ProcessStatus } from "../types/metrics.ts";
import { collectorStream } from "./collector-stream.ts";
import {
  assembleRecords,
  clampPercent,
  type RawProcess,
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

/** Live Linux implementation of {@link ProcessCollector}. */
export const ProcessCollectorLinuxLive = Layer.succeed(
  ProcessCollector,
  ProcessCollector.of({ read, stream }),
);
