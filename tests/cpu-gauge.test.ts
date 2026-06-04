import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { Option } from "effect";
import {
  type CpuGauge,
  loadColor,
  makeCpuGauge,
  renderBar,
} from "../src/ui/components/cpu-gauge.ts";
import { Percent, Timestamp, type MetricState } from "../src/types/metrics.ts";

const okState = (user: number, system: number, idle: number): MetricState => ({
  _tag: "ok",
  tag: "cpu",
  at: Timestamp(1000),
  snapshot: {
    _tag: "cpu",
    at: Timestamp(1000),
    user: Percent(user),
    system: Percent(system),
    idle: Percent(idle),
  },
});

/** Mount a fresh gauge in a headless renderer, run the body, then tear down. */
const withGauge = async (
  body: (ctx: {
    gauge: CpuGauge;
    renderOnce: () => Promise<unknown>;
    frame: () => string;
  }) => Promise<void>,
): Promise<void> => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 60,
    height: 12,
  });
  try {
    const gauge = makeCpuGauge(renderer);
    renderer.root.add(gauge.root);
    await body({ gauge, renderOnce, frame: captureCharFrame });
  } finally {
    renderer.destroy();
  }
};

describe("CpuGauge rendering", () => {
  test("shows a waiting message for the None state", async () => {
    await withGauge(async ({ gauge, renderOnce, frame }) => {
      gauge.update(Option.none());
      await renderOnce();
      expect(frame()).toContain("waiting for first reading");
    });
  });

  test("renders user / sys / idle percentages for an ok state", async () => {
    await withGauge(async ({ gauge, renderOnce, frame }) => {
      gauge.update(Option.some(okState(10, 20, 70)));
      await renderOnce();
      const text = frame();
      expect(text).toContain("user 10.0%");
      expect(text).toContain("sys 20.0%");
      expect(text).toContain("idle 70.0%");
    });
  });

  test("renders the reason for an unavailable state", async () => {
    await withGauge(async ({ gauge, renderOnce, frame }) => {
      const state: MetricState = {
        _tag: "unavailable",
        tag: "cpu",
        at: Timestamp(2000),
        reason: "top failed",
      };
      gauge.update(Option.some(state));
      await renderOnce();
      expect(frame()).toContain("unavailable (top failed)");
    });
  });

  test("bar fill grows with CPU load", async () => {
    await withGauge(async ({ gauge, renderOnce, frame }) => {
      gauge.update(Option.some(okState(0, 0, 100)));
      await renderOnce();
      const idleBlocks = (frame().match(/█/g) ?? []).length;

      gauge.update(Option.some(okState(60, 30, 10)));
      await renderOnce();
      const busyBlocks = (frame().match(/█/g) ?? []).length;

      expect(idleBlocks).toBe(0);
      expect(busyBlocks).toBeGreaterThan(idleBlocks);
    });
  });

  test("showDebug surfaces a render-error line without removing the gauge", async () => {
    await withGauge(async ({ gauge, renderOnce, frame }) => {
      gauge.update(Option.some(okState(10, 20, 70)));
      gauge.showDebug("render error: boom");
      await renderOnce();
      const text = frame();
      expect(text).toContain("render error: boom");
      expect(text).toContain("user 10.0%"); // gauge still visible
    });
  });
});

describe("CpuGauge pure helpers", () => {
  test("renderBar is empty at 0% and full at 100%", () => {
    expect(renderBar(0)).toBe("░".repeat(30));
    expect(renderBar(100)).toBe("█".repeat(30));
  });

  test("renderBar fills proportionally and clamps out-of-range input", () => {
    expect((renderBar(50).match(/█/g) ?? []).length).toBe(15);
    expect(renderBar(-10)).toBe(renderBar(0));
    expect(renderBar(150)).toBe(renderBar(100));
  });

  test("loadColor crosses green → amber → red at 60 and 85", () => {
    expect(loadColor(59)).toBe("#50FA7B");
    expect(loadColor(60)).toBe("#FFB86C");
    expect(loadColor(84)).toBe("#FFB86C");
    expect(loadColor(85)).toBe("#FF5555");
  });
});
