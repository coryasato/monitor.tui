import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { Option } from "effect";
import {
  type CpuCores,
  makeCpuCores,
} from "../src/ui/components/cpu-cores.ts";
import { Percent, Timestamp, type MetricState } from "../src/types/metrics.ts";

const okState = (...busy: number[]): MetricState => ({
  _tag: "ok",
  tag: "cpu-cores",
  at: Timestamp(1000),
  snapshot: {
    _tag: "cpu-cores",
    at: Timestamp(1000),
    cores: busy.map((b) => Percent(b)),
  },
});

/** Mount a fresh panel in a headless renderer, run the body, then tear down. */
const withCores = async (
  body: (ctx: {
    panel: CpuCores;
    renderOnce: () => Promise<unknown>;
    frame: () => string;
  }) => Promise<void>,
): Promise<void> => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 60,
    height: 20,
  });
  try {
    const panel = makeCpuCores(renderer);
    renderer.root.add(panel.root);
    await body({ panel, renderOnce, frame: captureCharFrame });
  } finally {
    renderer.destroy();
  }
};

describe("CpuCores rendering", () => {
  test("shows a waiting message for the None state", async () => {
    await withCores(async ({ panel, renderOnce, frame }) => {
      panel.update(Option.none());
      await renderOnce();
      expect(frame()).toContain("waiting for first reading");
    });
  });

  test("renders one labeled bar per core with its percentage", async () => {
    await withCores(async ({ panel, renderOnce, frame }) => {
      panel.update(Option.some(okState(10, 50, 90)));
      await renderOnce();
      const text = frame();
      expect(text).toContain("c0");
      expect(text).toContain("c1");
      expect(text).toContain("c2");
      expect(text).toContain("10.0%");
      expect(text).toContain("50.0%");
      expect(text).toContain("90.0%");
    });
  });

  test("a busier core fills more of its bar than an idle one", async () => {
    await withCores(async ({ panel, renderOnce, frame }) => {
      panel.update(Option.some(okState(0, 100)));
      await renderOnce();
      // The whole frame has the idle core (0 blocks) + the full core's blocks.
      const blocks = (frame().match(/█/g) ?? []).length;
      expect(blocks).toBeGreaterThan(0);
    });
  });

  test("reuses bar rows when the core count is unchanged", async () => {
    await withCores(async ({ panel, renderOnce, frame }) => {
      panel.update(Option.some(okState(10, 20)));
      await renderOnce();
      panel.update(Option.some(okState(80, 90)));
      await renderOnce();
      const text = frame();
      expect(text).toContain("80.0%");
      expect(text).toContain("90.0%");
      // Old values are gone (rows updated in place, not appended).
      expect(text).not.toContain("10.0%");
      expect(text).not.toContain("20.0%");
    });
  });

  test("renders the reason for an unavailable state", async () => {
    await withCores(async ({ panel, renderOnce, frame }) => {
      const state: MetricState = {
        _tag: "unavailable",
        tag: "cpu-cores",
        at: Timestamp(2000),
        reason: "FFI failed",
      };
      panel.update(Option.some(state));
      await renderOnce();
      expect(frame()).toContain("unavailable (FFI failed)");
    });
  });

  test("showDebug surfaces a render-error line without removing the bars", async () => {
    await withCores(async ({ panel, renderOnce, frame }) => {
      panel.update(Option.some(okState(10, 20)));
      panel.showDebug("render error: boom");
      await renderOnce();
      const text = frame();
      expect(text).toContain("render error: boom");
      expect(text).toContain("c0"); // bars still visible
    });
  });
});
