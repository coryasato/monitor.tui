import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import {
  assembleRecords,
  clampPercent,
  memPercentOf,
  type PlainFocus,
  type PlainRecord,
  type RawProcess,
  toFocusSnapshot,
  toSnapshot,
} from "../src/collectors/process-common.ts";

const raw = (
  pid: number,
  cpuCumulative: number,
  overrides: Partial<RawProcess> = {},
): RawProcess => ({
  pid,
  cpuCumulative,
  memBytes: 1000,
  status: "running",
  name: `proc-${pid}`,
  ...overrides,
});

describe("clampPercent", () => {
  test("clamps into [0, 100]", () => {
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(150)).toBe(100);
    expect(clampPercent(42)).toBe(42);
  });
});

describe("assembleRecords", () => {
  // A simple cumulative-diff cpu fn: (next - prev), undefined prev → 0.
  const diffCpu = (prev: number | undefined, next: number): number =>
    prev === undefined ? 0 : next - prev;

  test("diffs each process's cumulative counter against the prev sample", () => {
    const prev = new Map([
      [1, 100],
      [2, 50],
    ]);
    const next = [raw(1, 130), raw(2, 60)];
    const records = assembleRecords(prev, next, diffCpu);
    expect(records.map((r) => r.cpuPercent)).toEqual([30, 10]);
  });

  test("a process absent from the prev sample (newly spawned) reports 0%", () => {
    const prev = new Map([[1, 100]]);
    const next = [raw(1, 120), raw(999, 5000)];
    const records = assembleRecords(prev, next, diffCpu);
    expect(records[1]!.cpuPercent).toBe(0);
  });

  test("carries name/mem/status straight through", () => {
    const next = [raw(7, 0, { name: "/usr/bin/bun", memBytes: 4096, status: "sleeping" })];
    const [r] = assembleRecords(new Map(), next, diffCpu);
    expect(r).toMatchObject({ pid: 7, name: "/usr/bin/bun", memBytes: 4096, status: "sleeping" });
  });
});

describe("toSnapshot", () => {
  const plain = (overrides: Partial<PlainRecord> = {}): PlainRecord => ({
    pid: 1,
    name: "init",
    cpuPercent: 12,
    memBytes: 2048,
    status: "running",
    ...overrides,
  });

  test("validates + brands valid records into a process snapshot", () => {
    const snap = Effect.runSync(toSnapshot([plain(), plain({ pid: 2 })], "process"));
    expect(snap._tag).toBe("process");
    expect(snap.processes).toHaveLength(2);
    expect(snap.processes[0]!.pid as number).toBe(1);
    expect(snap.processes[0]!.cpuPercent as number).toBe(12);
  });

  test("fails with a CollectorError when a record is out of range", () => {
    const exit = Effect.runSyncExit(toSnapshot([plain({ cpuPercent: 150 })], "process"));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = exit.cause;
      expect(JSON.stringify(err)).toContain("CollectorError");
    }
  });

  test("rejects a non-positive pid", () => {
    const exit = Effect.runSyncExit(toSnapshot([plain({ pid: 0 })], "process"));
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("memPercentOf", () => {
  test("is a finite percentage in [0, 100] for a real byte count", () => {
    const p = memPercentOf(1024 * 1024); // 1 MiB of whatever this box has
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(100);
    expect(Number.isFinite(p)).toBe(true);
  });

  test("clamps an absurd byte count to 100", () => {
    expect(memPercentOf(Number.MAX_SAFE_INTEGER)).toBe(100);
  });
});

describe("toFocusSnapshot", () => {
  const plain = (overrides: Partial<PlainFocus> = {}): PlainFocus => ({
    pid: 1234,
    name: "/usr/bin/bun",
    cpuPercent: 12.5,
    memBytes: 2048,
    memPercent: 1.5,
    threadCount: 8,
    openFds: 42,
    status: "running",
    ...overrides,
  });

  test("validates + brands a valid record into a process-focus snapshot", () => {
    const snap = Effect.runSync(toFocusSnapshot(plain(), "process-focus"));
    expect(snap._tag).toBe("process-focus");
    expect(snap.pid as number).toBe(1234);
    expect(snap.cpuPercent as number).toBe(12.5);
    expect(snap.threadCount).toBe(8);
    expect(snap.openFds).toBe(42);
    expect(snap.status).toBe("running");
  });

  test("allows a null FD count (unavailable, never lsof)", () => {
    const snap = Effect.runSync(toFocusSnapshot(plain({ openFds: null }), "process-focus"));
    expect(snap.openFds).toBeNull();
  });

  test("fails with a CollectorError when cpuPercent is out of range", () => {
    const exit = Effect.runSyncExit(
      toFocusSnapshot(plain({ cpuPercent: 150 }), "process-focus"),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("CollectorError");
    }
  });

  test("rejects a fractional thread count", () => {
    const exit = Effect.runSyncExit(
      toFocusSnapshot(plain({ threadCount: 1.5 }), "process-focus"),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
