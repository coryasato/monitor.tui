import {
  BoxRenderable,
  type CliRenderer,
  type Renderable,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import { Option } from "effect";
import type { MetricState } from "../../types/metrics.ts";

/**
 * CPU history sparkline: a scrolling row of block glyphs showing recent `used`
 * (= user + system) load. The ring buffer lives here in the component — the
 * MetricsStore stays "latest only" and pull-based. `push` is called only when a
 * new sample arrives (see the redraw-on-change logic in `main.ts`).
 */

/** Eight levels from low to high; index 0 = lowest. */
export const SPARK_GLYPHS = "▁▂▃▄▅▆▇█";

const clampPercent = (n: number): number => Math.max(0, Math.min(100, n));

/** Map a 0–100 value to a single sparkline glyph. */
export const sparkGlyph = (value: number): string => {
  const i = Math.round((clampPercent(value) / 100) * (SPARK_GLYPHS.length - 1));
  return SPARK_GLYPHS[i]!;
};

/** Render a history buffer; `null` entries (no data / unavailable) become gaps. */
export const renderSparkline = (
  values: ReadonlyArray<number | null>,
): string => values.map((v) => (v === null ? " " : sparkGlyph(v))).join("");

/** Append `x`, keeping at most `cap` most-recent entries. */
export const appendCapped = <A>(
  xs: ReadonlyArray<A>,
  x: A,
  cap: number,
): A[] => {
  const next = [...xs, x];
  return next.length > cap ? next.slice(next.length - cap) : next;
};

/** `used` load for a state, or `null` for none / unavailable (rendered as a gap). */
const usedOf = (state: Option.Option<MetricState>): number | null =>
  Option.match(state, {
    onNone: () => null,
    onSome: (s) =>
      s._tag === "ok" && s.snapshot._tag === "cpu"
        ? clampPercent(s.snapshot.user + s.snapshot.system)
        : null,
  });

export interface CpuSparkline {
  readonly root: Renderable;
  /** Append the latest state to the history and re-render the row. */
  readonly push: (state: Option.Option<MetricState>) => void;
}

const DEFAULT_CAPACITY = 40;

export function makeCpuSparkline(
  renderer: CliRenderer,
  capacity: number = DEFAULT_CAPACITY,
): CpuSparkline {
  let history: Array<number | null> = [];

  const title = new TextRenderable(renderer, {
    id: "spark-title",
    content: "History · used %",
    fg: "#8BE9FD",
    attributes: TextAttributes.BOLD,
  });
  const line = new TextRenderable(renderer, {
    id: "spark-line",
    content: "",
    fg: "#50FA7B",
  });

  const root = new BoxRenderable(renderer, {
    id: "cpu-sparkline",
    borderStyle: "rounded",
    padding: 1,
    flexDirection: "column",
  });
  root.add(title);
  root.add(line);

  const push = (state: Option.Option<MetricState>): void => {
    history = appendCapped(history, usedOf(state), capacity);
    line.content = renderSparkline(history);
  };

  return { root, push };
}
