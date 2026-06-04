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
 * CPU gauge: a bordered panel with a usage line and a colored bar. It is a
 * passive view — `update` is called from the app's render-tick loop with the
 * latest state pulled from the MetricsStore; the component never reads the store
 * or holds a fiber itself.
 */

const BAR_WIDTH = 30;

const clampPercent = (n: number): number => Math.max(0, Math.min(100, n));
const fmt = (n: number): string => n.toFixed(1);

/** A `█`/`░` bar representing `percent` of `BAR_WIDTH` cells. Exported for tests. */
export function renderBar(percent: number): string {
  const filled = Math.round((clampPercent(percent) / 100) * BAR_WIDTH);
  return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}

/** Green → amber → red as load rises. Exported for tests. */
export function loadColor(percent: number): string {
  if (percent >= 85) return "#FF5555";
  if (percent >= 60) return "#FFB86C";
  return "#50FA7B";
}

export interface CpuGauge {
  /** Root renderable to mount under `renderer.root`. */
  readonly root: Renderable;
  /** Apply the latest store state to the view (called each render tick). */
  readonly update: (state: Option.Option<MetricState>) => void;
  /** Show a non-fatal render error without disturbing the gauge. */
  readonly showDebug: (message: string) => void;
}

export function makeCpuGauge(renderer: CliRenderer): CpuGauge {
  const title = new TextRenderable(renderer, {
    id: "cpu-title",
    content: "CPU",
    fg: "#8BE9FD",
    attributes: TextAttributes.BOLD,
  });
  const value = new TextRenderable(renderer, {
    id: "cpu-value",
    content: "waiting for first reading…",
    fg: "#888888",
  });
  const bar = new TextRenderable(renderer, {
    id: "cpu-bar",
    content: renderBar(0),
    fg: "#50FA7B",
  });
  const debug = new TextRenderable(renderer, {
    id: "cpu-debug",
    content: "",
    fg: "#FF5555",
  });

  const root = new BoxRenderable(renderer, {
    id: "cpu-gauge",
    borderStyle: "rounded",
    padding: 1,
    flexDirection: "column",
  });
  root.add(title);
  root.add(value);
  root.add(bar);
  root.add(debug);

  const update = (state: Option.Option<MetricState>): void =>
    Option.match(state, {
      onNone: () => {
        value.content = "waiting for first reading…";
        value.fg = "#888888";
        bar.content = renderBar(0);
        bar.fg = "#50FA7B";
      },
      onSome: (s) => {
        if (s._tag === "unavailable" || s.snapshot._tag !== "cpu") {
          value.content =
            s._tag === "unavailable" ? `unavailable (${s.reason})` : "unavailable";
          value.fg = "#FF5555";
          bar.content = renderBar(0);
          bar.fg = "#6272A4";
          return;
        }
        const snap = s.snapshot;
        const used = clampPercent(snap.user + snap.system);
        value.content = `user ${fmt(snap.user)}%   sys ${fmt(snap.system)}%   idle ${fmt(snap.idle)}%`;
        value.fg = "#F8F8F2";
        bar.content = `${renderBar(used)} ${fmt(used)}%`;
        bar.fg = loadColor(used);
      },
    });

  const showDebug = (message: string): void => {
    debug.content = message;
  };

  return { root, update, showDebug };
}
