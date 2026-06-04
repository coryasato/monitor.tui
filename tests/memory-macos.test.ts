import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import { computeMemory } from "../src/collectors/memory-macos.ts";
import { MemoryCollectorMacOSLive } from "../src/collectors/memory-macos.ts";
import { MemoryCollector } from "../src/services/memory-collector.ts";

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                3642.
Pages active:                            211948.
Pages inactive:                          211003.
Pages speculative:                          368.
Pages throttled:                              0.
Pages wired down:                        197961.
Pages purgeable:                            506.
Pages occupied by compressor:            375077.
Pageouts:                              31408179.`;

const PAGE_SIZE = 16384;
const TOTAL = 17179869184; // 16 GiB

describe("computeMemory", () => {
  test("computes used = (active + wired + compressed) * pageSize", () => {
    const result = computeMemory(VM_STAT, TOTAL, PAGE_SIZE);
    const expectedPages = 211948 + 197961 + 375077;
    const expectedBytes = expectedPages * PAGE_SIZE;
    expect(result).not.toBeNull();
    expect(result?.usedBytes).toBe(expectedBytes);
    expect(result?.totalBytes).toBe(TOTAL);
    expect(result?.usedPercent).toBeCloseTo((expectedBytes / TOTAL) * 100, 5);
  });

  test("usedPercent stays within [0, 100] even if used exceeds total", () => {
    const result = computeMemory(VM_STAT, 1, PAGE_SIZE); // absurdly small total
    expect(result?.usedPercent).toBe(100);
  });

  test("returns null when a required page field is missing", () => {
    const partial = "Pages active: 100.\nPages free: 5.";
    expect(computeMemory(partial, TOTAL, PAGE_SIZE)).toBeNull();
  });

  test("returns null for non-positive total or page size", () => {
    expect(computeMemory(VM_STAT, 0, PAGE_SIZE)).toBeNull();
    expect(computeMemory(VM_STAT, TOTAL, 0)).toBeNull();
  });
});

describe("MemoryCollectorMacOSLive (integration)", () => {
  test(
    "emits a valid ok memory reading from real vm_stat/sysctl",
    async () => {
      const head = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const mem = yield* MemoryCollector;
            return yield* mem.stream.pipe(Stream.take(1), Stream.runHead);
          }),
          MemoryCollectorMacOSLive,
        ),
      );
      expect(head._tag).toBe("Some");
      if (head._tag !== "Some") return;
      const state = head.value;
      expect(state._tag).toBe("ok");
      if (state._tag !== "ok" || state.snapshot._tag !== "memory") return;
      const { usedPercent, usedBytes, totalBytes } = state.snapshot;
      expect(usedPercent).toBeGreaterThan(0);
      expect(usedPercent).toBeLessThanOrEqual(100);
      expect(usedBytes).toBeGreaterThan(0);
      expect(usedBytes).toBeLessThanOrEqual(totalBytes);
    },
    15_000,
  );
});
