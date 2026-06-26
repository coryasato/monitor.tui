import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import {
  assembleRecords,
  clampPercent,
  type PlainRecord,
  type RawProcess,
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
