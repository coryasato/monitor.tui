import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import {
  DiskCollectorMacOSLive,
  parseDiskThroughput,
} from "../src/collectors/disk-macos.ts";
import { DiskCollector } from "../src/services/disk-collector.ts";

const MIB = 1024 * 1024;

// Two-disk output; the SECOND data row is the 1s interval we want.
const IOSTAT = `              disk0               disk4
    KB/t  tps  MB/s     KB/t  tps  MB/s
   16.04  110  1.73    23.73    0  0.00
   11.33   18  0.20     0.00    0  2.50`;

describe("parseDiskThroughput", () => {
  test("uses the last data row and sums MB/s across disks", () => {
    // Last row MB/s columns: 0.20 + 2.50 = 2.70 MB/s.
    const result = parseDiskThroughput(IOSTAT);
    expect(result).not.toBeNull();
    expect(result?.bytesPerSec).toBeCloseTo(2.7 * MIB, 3);
  });

  test("handles a single-disk (3-column) row", () => {
    const single = `        disk0
    KB/t  tps  MB/s
   16.0  100  1.00
   16.0   50  0.50`;
    expect(parseDiskThroughput(single)?.bytesPerSec).toBeCloseTo(0.5 * MIB, 3);
  });

  test("returns null when there is no data row", () => {
    expect(parseDiskThroughput("disk0\nKB/t tps MB/s\n")).toBeNull();
  });
});

describe("DiskCollectorMacOSLive (integration)", () => {
  test(
    "emits a valid ok disk reading from real iostat",
    async () => {
      const head = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const d = yield* DiskCollector;
            return yield* d.stream.pipe(Stream.take(1), Stream.runHead);
          }),
          DiskCollectorMacOSLive,
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
