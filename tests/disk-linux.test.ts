import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import {
  computeDiskThroughput,
  DiskCollectorLinuxLive,
  type DiskTotals,
  parseDiskStats,
} from "../src/collectors/disk-linux.ts";
import { DiskCollector } from "../src/services/disk-collector.ts";

const SECTOR = 512;

// `major minor name reads merged sectorsRead readMs writes wMerged sectorsWritten …`
// Partitions (sda1) and pseudo devices (loop0, dm-0) must be ignored so I/O isn't
// double-counted; whole disks (sda, nvme0n1) are summed.
const DISKSTATS = `   7       0 loop0 0 0 0 0 0 0 0 0 0 0 0
   8       0 sda 1000 0 5000 200 800 0 3000 150 0 0 0
   8       1 sda1 900 0 4500 180 700 0 2700 130 0 0 0
 259       0 nvme0n1 2000 0 10000 300 1500 0 8000 250 0 0 0
 259       1 nvme0n1p1 1800 0 9000 280 1400 0 7500 230 0 0 0
 253       0 dm-0 500 0 2500 100 400 0 1500 80 0 0 0`;

describe("parseDiskStats", () => {
  test("sums whole disks only, excluding partitions and pseudo devices", () => {
    // sda: read 5000 + nvme0n1 10000 = 15000; written 3000 + 8000 = 11000.
    expect(parseDiskStats(DISKSTATS)).toEqual({
      sectorsRead: 15000,
      sectorsWritten: 11000,
    });
  });

  test("returns null when no whole-disk row is present", () => {
    const onlyPseudo = `   7  0 loop0 0 0 0 0 0 0 0 0 0 0 0`;
    expect(parseDiskStats(onlyPseudo)).toBeNull();
  });
});

describe("computeDiskThroughput", () => {
  const prev: DiskTotals = { sectorsRead: 1000, sectorsWritten: 500 };

  test("combines read+write deltas into bytes/sec over the interval", () => {
    const next: DiskTotals = { sectorsRead: 2000, sectorsWritten: 1500 };
    // Δsectors = 1000 + 1000 = 2000 over 1s → 2000 × 512 bytes/sec.
    expect(computeDiskThroughput(prev, next, 1000)).toEqual({
      bytesPerSec: 2000 * SECTOR,
    });
    // Half-second interval doubles the rate.
    expect(computeDiskThroughput(prev, next, 500)).toEqual({
      bytesPerSec: 4000 * SECTOR,
    });
  });

  test("clamps counter resets (negative deltas) to 0", () => {
    const reset: DiskTotals = { sectorsRead: 0, sectorsWritten: 0 };
    expect(computeDiskThroughput(prev, reset, 1000)).toEqual({ bytesPerSec: 0 });
  });

  test("returns null for a non-positive interval", () => {
    expect(computeDiskThroughput(prev, prev, 0)).toBeNull();
  });
});

const itLinux = process.platform === "linux" ? test : test.skip;

describe("DiskCollectorLinuxLive (integration, Linux only)", () => {
  itLinux(
    "emits a valid ok disk reading from real /proc/diskstats",
    async () => {
      const head = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const d = yield* DiskCollector;
            return yield* d.stream.pipe(Stream.take(1), Stream.runHead);
          }),
          DiskCollectorLinuxLive,
        ),
      );
      expect(head._tag).toBe("Some");
      if (head._tag !== "Some") return;
      const state = head.value;
      expect(state._tag).toBe("ok");
      if (state._tag !== "ok" || state.snapshot._tag !== "disk") return;
      expect(state.snapshot.bytesPerSec).toBeGreaterThanOrEqual(0);
    },
    15_000,
  );
});
