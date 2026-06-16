import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import {
  computeCpuUsage,
  CpuCollectorLinuxLive,
  type CpuTimes,
  parseProcStat,
  toCpuTimes,
} from "../src/collectors/cpu-linux.ts";
import { CpuCollector } from "../src/services/cpu-collector.ts";

// Real-world shape: the aggregate `cpu` line (two spaces) plus per-core lines and
// the other counters. Fields: user nice system idle iowait irq softirq steal …
const PROC_STAT = `cpu  10000 200 3000 80000 500 0 100 0 0 0
cpu0 5000 100 1500 40000 250 0 50 0 0 0
cpu1 5000 100 1500 40000 250 0 50 0 0 0
intr 123456 0 0
ctxt 9876543
btime 1700000000
processes 12345`;

describe("parseProcStat", () => {
  test("parses the aggregate cpu line, not the per-core lines", () => {
    expect(parseProcStat(PROC_STAT)).toEqual({
      user: 10000,
      nice: 200,
      system: 3000,
      idle: 80000,
      iowait: 500,
      irq: 0,
      softirq: 100,
      steal: 0,
    });
  });

  test("returns null when no aggregate cpu line is present", () => {
    expect(parseProcStat("intr 1\nctxt 2\n")).toBeNull();
  });
});

describe("toCpuTimes", () => {
  test("defaults missing trailing columns (older kernels) to 0", () => {
    expect(toCpuTimes([1, 2, 3, 4])).toEqual({
      user: 1,
      nice: 2,
      system: 3,
      idle: 4,
      iowait: 0,
      irq: 0,
      softirq: 0,
      steal: 0,
    });
  });

  test("returns null with fewer than four fields", () => {
    expect(toCpuTimes([1, 2, 3])).toBeNull();
  });

  test("returns null on a non-finite field", () => {
    expect(toCpuTimes([1, 2, 3, Number.NaN])).toBeNull();
  });
});

describe("computeCpuUsage", () => {
  const prev: CpuTimes = {
    user: 100,
    nice: 0,
    system: 50,
    idle: 800,
    iowait: 0,
    irq: 0,
    softirq: 0,
    steal: 0,
  };

  test("derives user/system/idle percentages that sum to 100", () => {
    // Δuser=100, Δsystem=50, Δidle=50 → total 200. user 50%, idle 25%, system 25%.
    const next: CpuTimes = { ...prev, user: 200, system: 100, idle: 850 };
    const usage = computeCpuUsage(prev, next);
    expect(usage).toEqual({ user: 50, system: 25, idle: 25 });
    expect(usage!.user + usage!.system + usage!.idle).toBe(100);
  });

  test("folds nice into user and iowait into idle", () => {
    // Δnice=50 (→user), Δiowait=50 (→idle), Δidle=0, Δsystem=0; total 100.
    const next: CpuTimes = { ...prev, nice: 50, iowait: 50 };
    expect(computeCpuUsage(prev, next)).toEqual({
      user: 50,
      system: 0,
      idle: 50,
    });
  });

  test("returns null when no time elapsed between samples", () => {
    expect(computeCpuUsage(prev, prev)).toBeNull();
  });
});

const itLinux = process.platform === "linux" ? test : test.skip;

describe("CpuCollectorLinuxLive (integration, Linux only)", () => {
  itLinux(
    "emits a valid ok cpu reading from real /proc/stat",
    async () => {
      const head = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const cpu = yield* CpuCollector;
            return yield* cpu.stream.pipe(Stream.take(1), Stream.runHead);
          }),
          CpuCollectorLinuxLive,
        ),
      );
      expect(head._tag).toBe("Some");
      if (head._tag !== "Some") return;
      const state = head.value;
      expect(state._tag).toBe("ok");
      if (state._tag !== "ok" || state.snapshot._tag !== "cpu") return;
      const { user, system, idle } = state.snapshot;
      expect(user + system + idle).toBeCloseTo(100, 5);
    },
    15_000,
  );
});
