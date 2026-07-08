import {
  BoxRenderable,
  type CliRenderer,
  type Renderable,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import { Option } from "effect";
import type { MetricState } from "../../types/metrics.ts";
import { type AlertThresholds, alertColor, resolveAlert } from "../alerts.ts";
import { renderBar } from "./cpu-gauge.ts";

/**
 * Memory gauge: used %, a colored bar, and used/total in GiB. A passive view —
 * `update` is pushed the latest store state from the render-tick loop, mirroring
 * `CpuGauge`. Reuses `renderBar` (and the shared `resolveAlert`/`alertColor`) so
 * the two gauges stay consistent.
 */

const GIB = 1024 ** 3;
const toGiB = (bytes: number): string => (bytes / GIB).toFixed(1);

export interface MemoryGauge {
  readonly root: Renderable;
  readonly update: (state: Option.Option<MetricState>) => void;
}

export function makeMemoryGauge(
  renderer: CliRenderer,
  thresholds: AlertThresholds,
): MemoryGauge {
  const title = new TextRenderable(renderer, {
    id: "mem-title",
    content: "MEM",
    fg: "#8BE9FD",
    attributes: TextAttributes.BOLD,
  });
  const value = new TextRenderable(renderer, {
    id: "mem-value",
    content: "waiting for first reading…",
    fg: "#888888",
  });
  const bar = new TextRenderable(renderer, {
    id: "mem-bar",
    content: renderBar(0),
    fg: "#50FA7B",
  });

  const root = new BoxRenderable(renderer, {
    id: "mem-gauge",
    borderStyle: "rounded",
    padding: 1,
    flexDirection: "column",
  });
  root.add(title);
  root.add(value);
  root.add(bar);

  const update = (state: Option.Option<MetricState>): void =>
    Option.match(state, {
      onNone: () => {
        value.content = "waiting for first reading…";
        value.fg = "#888888";
        bar.content = renderBar(0);
        bar.fg = "#50FA7B";
      },
      onSome: (s) => {
        if (s._tag === "unavailable" || s.snapshot._tag !== "memory") {
          value.content =
            s._tag === "unavailable"
              ? `unavailable (${s.reason})`
              : "unavailable";
          value.fg = "#FF5555";
          bar.content = renderBar(0);
          bar.fg = "#6272A4";
          return;
        }
        const { usedPercent, usedBytes, totalBytes } = s.snapshot;
        value.content = `used ${usedPercent.toFixed(1)}%   ${toGiB(usedBytes)} / ${toGiB(totalBytes)} GiB`;
        value.fg = "#F8F8F2";
        bar.content = `${renderBar(usedPercent)} ${usedPercent.toFixed(1)}%`;
        bar.fg = alertColor(resolveAlert(usedPercent, thresholds));
      },
    });

  return { root, update };
}
