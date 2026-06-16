import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import {
  coresUsage,
  CpuCoresCollectorLinuxLive,
  parseProcStatCores,
} from "../src/collectors/cpu-cores-linux.ts";
import type { CpuTimes } from "../src/collectors/cpu-linux.ts";
import { CpuCoresCollector } from "../src/services/cpu-cores-collector.ts";

// Per-core lines deliberately out of order to exercise index sorting.
const PROC_STAT = `cpu  10000 200 3000 80000 500 0 100 0
cpu1 5000 100 1500 40000 250 0 50 0
cpu0 5000 100 1500 40000 250 0 50 0
intr 123456 0 0`;

const core = (over: Partial<CpuTimes> = {}): CpuTimes => ({
  user: 100,
  nice: 0,
  system: 50,
  idle: 800,
  iowait: 0,
  irq: 0,
  softirq: 0,
  steal: 0,
  ...over,
});

describe("parseProcStatCores", () => {
  test("parses per-core lines in core order, skipping the aggregate", () => {
    const cores = parseProcStatCores(PROC_STAT);
    expect(cores).not.toBeNull();
    expect(cores).toHaveLength(2);
    // cpu0 then cpu1 despite the file listing cpu1 first.
    expect(cores![0]!.user).toBe(5000);
    expect(cores![1]!.user).toBe(5000);
  });

  test("returns null when there are no per-core lines", () => {
    expect(parseProcStatCores("cpu 1 2 3 4\nintr 0\n")).toBeNull();
  });
});

describe("coresUsage", () => {
  test("computes per-core busy percentage from two samples", () => {
    const prev = [core(), core()];
    // core0: Δtotal=200, Δidle=50 → busy 75%. core1: idle only → busy 0%.
    const next = [core({ user: 200, system: 100, idle: 850 }), core({ idle: 900 })];
    expect(coresUsage(prev, next)).toEqual([75, 0]);
  });

  test("reports 0% for a core with no elapsed time", () => {
    const prev = [core()];
    expect(coresUsage(prev, [core()])).toEqual([0]);
  });

  test("returns null when core count changes between samples", () => {
    expect(coresUsage([core()], [core(), core()])).toBeNull();
    expect(coresUsage([], [])).toBeNull();
  });
});

const itLinux = process.platform === "linux" ? test : test.skip;

describe("CpuCoresCollectorLinuxLive (integration, Linux only)", () => {
  itLinux(
    "emits a valid ok per-core reading from real /proc/stat",
    async () => {
      const head = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const cores = yield* CpuCoresCollector;
            return yield* cores.stream.pipe(Stream.take(1), Stream.runHead);
          }),
          CpuCoresCollectorLinuxLive,
        ),
      );
      expect(head._tag).toBe("Some");
      if (head._tag !== "Some") return;
      const state = head.value;
      expect(state._tag).toBe("ok");
      if (state._tag !== "ok" || state.snapshot._tag !== "cpu-cores") return;
      expect(state.snapshot.cores.length).toBeGreaterThan(0);
      for (const p of state.snapshot.cores) {
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(100);
      }
    },
    15_000,
  );
});
