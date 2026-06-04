import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { Option } from "effect";
import {
  type MemoryGauge,
  makeMemoryGauge,
} from "../src/ui/components/memory-gauge.ts";
import {
  Bytes,
  type MetricState,
  Percent,
  Timestamp,
} from "../src/types/metrics.ts";

const GIB = 1024 ** 3;

const memOk = (
  usedPercent: number,
  usedGiB: number,
  totalGiB: number,
): MetricState => ({
  _tag: "ok",
  tag: "memory",
  at: Timestamp(1000),
  snapshot: {
    _tag: "memory",
    at: Timestamp(1000),
    usedPercent: Percent(usedPercent),
    usedBytes: Bytes(usedGiB * GIB),
    totalBytes: Bytes(totalGiB * GIB),
  },
});

const withGauge = async (
  body: (ctx: {
    gauge: MemoryGauge;
    renderOnce: () => Promise<unknown>;
    frame: () => string;
  }) => Promise<void>,
): Promise<void> => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 60,
    height: 10,
  });
  try {
    const gauge = makeMemoryGauge(renderer);
    renderer.root.add(gauge.root);
    await body({ gauge, renderOnce, frame: captureCharFrame });
  } finally {
    renderer.destroy();
  }
};

describe("MemoryGauge rendering", () => {
  test("renders used percent and used/total GiB", async () => {
    await withGauge(async ({ gauge, renderOnce, frame }) => {
      gauge.update(Option.some(memOk(75, 12, 16)));
      await renderOnce();
      const text = frame();
      expect(text).toContain("used 75.0%");
      expect(text).toContain("12.0 / 16.0 GiB");
    });
  });

  test("renders the reason for an unavailable state", async () => {
    await withGauge(async ({ gauge, renderOnce, frame }) => {
      gauge.update(
        Option.some({
          _tag: "unavailable",
          tag: "memory",
          at: Timestamp(2000),
          reason: "vm_stat failed",
        }),
      );
      await renderOnce();
      expect(frame()).toContain("unavailable (vm_stat failed)");
    });
  });
});
