import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import {
  MemoryCollectorLinuxLive,
  parseMeminfo,
} from "../src/collectors/memory-linux.ts";
import { MemoryCollector } from "../src/services/memory-collector.ts";

const KB = 1024;

const MEMINFO = `MemTotal:       16384000 kB
MemFree:         2000000 kB
MemAvailable:    8192000 kB
Buffers:          500000 kB
Cached:          4000000 kB
SwapTotal:       2097152 kB
SwapFree:        2097152 kB`;

describe("parseMeminfo", () => {
  test("computes used = (MemTotal − MemAvailable), in bytes", () => {
    const result = parseMeminfo(MEMINFO);
    expect(result).not.toBeNull();
    expect(result?.totalBytes).toBe(16384000 * KB);
    expect(result?.usedBytes).toBe((16384000 - 8192000) * KB);
    expect(result?.usedPercent).toBeCloseTo(50, 5);
  });

  test("clamps used to 0 if MemAvailable exceeds MemTotal", () => {
    const weird = `MemTotal:        1000 kB\nMemAvailable:    2000 kB`;
    expect(parseMeminfo(weird)?.usedBytes).toBe(0);
    expect(parseMeminfo(weird)?.usedPercent).toBe(0);
  });

  test("returns null when MemAvailable is missing", () => {
    expect(parseMeminfo("MemTotal: 1000 kB\nMemFree: 500 kB")).toBeNull();
  });

  test("returns null for non-positive MemTotal", () => {
    expect(parseMeminfo("MemTotal: 0 kB\nMemAvailable: 0 kB")).toBeNull();
  });
});

const itLinux = process.platform === "linux" ? test : test.skip;

describe("MemoryCollectorLinuxLive (integration, Linux only)", () => {
  itLinux(
    "emits a valid ok memory reading from real /proc/meminfo",
    async () => {
      const head = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const mem = yield* MemoryCollector;
            return yield* mem.stream.pipe(Stream.take(1), Stream.runHead);
          }),
          MemoryCollectorLinuxLive,
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
      expect(usedBytes).toBeLessThanOrEqual(totalBytes);
    },
    15_000,
  );
});
