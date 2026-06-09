import {
  BoxRenderable,
  type CliRenderer,
  type Renderable,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import { Option } from "effect";
import type { MetricState } from "../../types/metrics.ts";
import { formatRate } from "../format.ts";

/**
 * Disk readout: combined I/O throughput as text (no bar — throughput has no
 * natural 0–100 ceiling). A passive view; `update` is pushed the latest store
 * state from the render tick.
 */

export interface DiskReadout {
  readonly root: Renderable;
  readonly update: (state: Option.Option<MetricState>) => void;
}

export function makeDiskReadout(renderer: CliRenderer): DiskReadout {
  const title = new TextRenderable(renderer, {
    id: "disk-title",
    content: "DISK",
    fg: "#8BE9FD",
    attributes: TextAttributes.BOLD,
  });
  const value = new TextRenderable(renderer, {
    id: "disk-value",
    content: "waiting for first reading…",
    fg: "#888888",
  });

  const root = new BoxRenderable(renderer, {
    id: "disk-readout",
    borderStyle: "rounded",
    padding: 1,
    flexDirection: "column",
  });
  root.add(title);
  root.add(value);

  const update = (state: Option.Option<MetricState>): void =>
    Option.match(state, {
      onNone: () => {
        value.content = "waiting for first reading…";
        value.fg = "#888888";
      },
      onSome: (s) => {
        if (s._tag === "unavailable" || s.snapshot._tag !== "disk") {
          value.content =
            s._tag === "unavailable"
              ? `unavailable (${s.reason})`
              : "unavailable";
          value.fg = "#FF5555";
          return;
        }
        value.content = `I/O ${formatRate(s.snapshot.bytesPerSec)}`;
        value.fg = "#F8F8F2";
      },
    });

  return { root, update };
}
