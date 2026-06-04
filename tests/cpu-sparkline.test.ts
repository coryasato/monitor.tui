import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { Option } from "effect";
import {
  appendCapped,
  type CpuSparkline,
  makeCpuSparkline,
  renderSparkline,
  SPARK_GLYPHS,
  sparkGlyph,
} from "../src/ui/components/cpu-sparkline.ts";
import { Percent, Timestamp, type MetricState } from "../src/types/metrics.ts";

const ok = (used: number): MetricState => ({
  _tag: "ok",
  tag: "cpu",
  at: Timestamp(1000),
  snapshot: {
    _tag: "cpu",
    at: Timestamp(1000),
    user: Percent(used),
    system: Percent(0),
    idle: Percent(100 - used),
  },
});

const LOW = SPARK_GLYPHS[0]!; // ▁
const HIGH = SPARK_GLYPHS[SPARK_GLYPHS.length - 1]!; // █

describe("sparkline pure helpers", () => {
  test("sparkGlyph spans the glyph range and clamps", () => {
    expect(sparkGlyph(0)).toBe(LOW);
    expect(sparkGlyph(100)).toBe(HIGH);
    expect(sparkGlyph(-50)).toBe(sparkGlyph(0));
    expect(sparkGlyph(150)).toBe(sparkGlyph(100));
  });

  test("sparkGlyph rises monotonically with load", () => {
    const a = SPARK_GLYPHS.indexOf(sparkGlyph(10));
    const b = SPARK_GLYPHS.indexOf(sparkGlyph(50));
    const c = SPARK_GLYPHS.indexOf(sparkGlyph(90));
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  test("renderSparkline renders nulls as gaps and keeps length", () => {
    const out = renderSparkline([0, null, 100]);
    expect([...out].length).toBe(3);
    expect(out[1]).toBe(" ");
    expect(out[0]).toBe(LOW);
    expect(out[2]).toBe(HIGH);
  });

  test("appendCapped keeps the most recent N in order", () => {
    let buf: number[] = [];
    for (const n of [1, 2, 3, 4, 5]) buf = appendCapped(buf, n, 3);
    expect(buf).toEqual([3, 4, 5]);
  });
});

/** Mount a sparkline in a headless renderer, run the body, then tear down. */
const withSparkline = async (
  body: (ctx: {
    spark: CpuSparkline;
    renderOnce: () => Promise<unknown>;
    frame: () => string;
  }) => Promise<void>,
): Promise<void> => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 60,
    height: 8,
  });
  try {
    const spark = makeCpuSparkline(renderer, 10);
    renderer.root.add(spark.root);
    await body({ spark, renderOnce, frame: captureCharFrame });
  } finally {
    renderer.destroy();
  }
};

describe("CpuSparkline rendering", () => {
  test("renders pushed samples as glyphs and scrolls within capacity", async () => {
    await withSparkline(async ({ spark, renderOnce, frame }) => {
      for (const used of [10, 50, 90]) spark.push(Option.some(ok(used)));
      await renderOnce();
      const text = frame();
      expect(text).toContain(sparkGlyph(10));
      expect(text).toContain(sparkGlyph(50));
      expect(text).toContain(sparkGlyph(90));
    });
  });

  test("renders a gap for unavailable / no-data states", async () => {
    await withSparkline(async ({ spark, renderOnce, frame }) => {
      spark.push(Option.none());
      spark.push(
        Option.some({
          _tag: "unavailable",
          tag: "cpu",
          at: Timestamp(2000),
          reason: "top failed",
        }),
      );
      await renderOnce();
      // No glyphs should have been drawn for these two gap samples.
      const glyphs = [...frame()].filter((c) => SPARK_GLYPHS.includes(c));
      expect(glyphs.length).toBe(0);
    });
  });
});
