import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import {
  type CoreTicks,
  CpuCoresCollectorMacOSLive,
  ticksToPercents,
} from "../src/collectors/cpu-cores-macos.ts";
import { CpuCoresCollector } from "../src/services/cpu-cores-collector.ts";

const core = (
  user: number,
  system: number,
  idle: number,
  nice = 0,
): CoreTicks => ({ user, system, idle, nice });

describe("ticksToPercents", () => {
  test("computes busy% from the work/idle split of the delta", () => {
    // core 0: Δwork = 30 (user 20 + sys 10), Δidle = 70 → 30% busy.
    // core 1: Δwork = 90, Δidle = 10 → 90% busy.
    const prev = [core(100, 50, 1000), core(0, 0, 0)];
    const next = [core(120, 60, 1070), core(80, 10, 10)];
    expect(ticksToPercents(prev, next)).toEqual([30, 90]);
  });

  test("counts nice ticks as work", () => {
    // Δuser 0, Δsys 0, Δnice 50, Δidle 50 → 50% busy.
    const prev = [core(0, 0, 0, 0)];
    const next = [core(0, 0, 50, 50)];
    expect(ticksToPercents(prev, next)).toEqual([50]);
  });

  test("a core with no elapsed ticks reports 0%", () => {
    const same = [core(10, 20, 30, 5)];
    expect(ticksToPercents(same, same)).toEqual([0]);
  });

  test("corrects a 32-bit counter wraparound (negative raw delta)", () => {
    // idle wraps: prev near 2^32, next small. True Δidle = 200, Δwork = 0 → 0%.
    const prev = [core(0, 0, 2 ** 32 - 100)];
    const next = [core(0, 0, 100)];
    expect(ticksToPercents(prev, next)).toEqual([0]);

    // user wraps while idle advances: Δuser = 200 work, Δidle = 200 → 50%.
    const prev2 = [core(2 ** 32 - 100, 0, 1000)];
    const next2 = [core(100, 0, 1200)];
    expect(ticksToPercents(prev2, next2)).toEqual([50]);
  });

  test("clamps results to [0, 100]", () => {
    const result = ticksToPercents([core(0, 0, 0)], [core(50, 50, 0)]);
    expect(result).not.toBeNull();
    for (const p of result ?? []) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(100);
    }
  });

  test("returns null on empty or mismatched core counts", () => {
    expect(ticksToPercents([], [])).toBeNull();
    expect(ticksToPercents([core(1, 1, 1)], [])).toBeNull();
    expect(
      ticksToPercents([core(1, 1, 1)], [core(1, 1, 1), core(1, 1, 1)]),
    ).toBeNull();
  });
});

describe("CpuCoresCollectorMacOSLive (integration)", () => {
  test(
    "emits a valid ok reading with one percent per logical core",
    async () => {
      const expectedCores = navigator.hardwareConcurrency;
      const head = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const cpuCores = yield* CpuCoresCollector;
            return yield* cpuCores.stream.pipe(Stream.take(1), Stream.runHead);
          }),
          CpuCoresCollectorMacOSLive,
        ),
      );
      expect(head._tag).toBe("Some");
      if (head._tag !== "Some") return;
      const state = head.value;
      expect(state._tag).toBe("ok");
      if (state._tag !== "ok" || state.snapshot._tag !== "cpu-cores") return;
      expect(state.snapshot.cores).toHaveLength(expectedCores);
      for (const p of state.snapshot.cores) {
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(100);
      }
    },
    15_000,
  );
});
